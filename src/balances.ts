import { Address, ethereum, log, BigInt, Bytes, ByteArray } from "@graphprotocol/graph-ts";
import {
  Account,
  Token,
  Balance,
  Transfer,
  BalanceSnapshot,
  nTokenFeeBuffer,
} from "../generated/schema";
import { ERC20 } from "../generated/templates/ERC20Proxy/ERC20";
import { ERC4626 } from "../generated/Transactions/ERC4626";
import {
  Burn,
  fCash,
  FeeReserve,
  Mint,
  nToken,
  PrimeCash,
  PrimeDebt,
  PRIME_CASH_VAULT_MATURITY,
  SettlementReserve,
  Vault,
  VaultCash,
  VaultDebt,
  VaultShare,
  ZeroAddress,
  Transfer as _Transfer,
  INTERNAL_TOKEN_PRECISION,
  NOTE,
  Notional,
  NTOKEN_FEE_BUFFER_WINDOW,
} from "./common/constants";
import {
  getAccount,
  getAsset,
  getIncentives,
  getNotional,
  getNotionalV2,
  getUnderlying,
  hasMigratedIncentives,
  isV2,
} from "./common/entities";
import { updatePrimeCashMarket } from "./common/market";
import { updatefCashOraclesAndMarkets } from "./exchange_rates";
import { getCurrencyConfiguration } from "./configuration";

export function getNTokenFeeBuffer(currencyId: i32): nTokenFeeBuffer {
  let feeBuffer = nTokenFeeBuffer.load(currencyId.toString());
  if (feeBuffer === null) {
    feeBuffer = new nTokenFeeBuffer(currencyId.toString());
    feeBuffer.feeTransfers = new Array<string>();
    // NOTE: we have to keep a separate fee transfer amount in the case that the
    // fCashReserveFeeSharePercent changes, which would change historical values
    // when we recalculate the 30 day rolling window.
    feeBuffer.feeTransferAmount = new Array<BigInt>();
  }

  return feeBuffer;
}

function getAccountIncentiveDebt(token: Token, account: Address): BigInt {
  if (token.tokenType == "nToken") {
    let notional = getNotional();
    let b = notional.getAccount(account).getAccountBalances();
    for (let i = 0; i < b.length; i++) {
      if (b[i].currencyId == token.currencyId) return b[i].accountIncentiveDebt;
    }
  }
  return BigInt.zero();
}

export function getBalanceSnapshot(balance: Balance, event: ethereum.Event): BalanceSnapshot {
  let id = balance.id + ":" + event.block.number.toString();
  let snapshot = BalanceSnapshot.load(id);

  if (snapshot == null) {
    snapshot = new BalanceSnapshot(id);
    snapshot.balance = balance.id;
    snapshot.blockNumber = event.block.number;
    snapshot.timestamp = event.block.timestamp.toI32();
    snapshot.transaction = event.transaction.hash.toHexString();

    // These features are calculated at each update to the snapshot
    snapshot.currentBalance = BigInt.zero();
    snapshot.previousBalance = BigInt.zero();
    snapshot.adjustedCostBasis = BigInt.zero();
    snapshot.currentProfitAndLossAtSnapshot = BigInt.zero();
    snapshot.totalProfitAndLossAtSnapshot = BigInt.zero();
    snapshot.totalILAndFeesAtSnapshot = BigInt.zero();
    snapshot.totalInterestAccrualAtSnapshot = BigInt.zero();
    snapshot._accumulatedBalance = BigInt.zero();
    snapshot._accumulatedCostRealized = BigInt.zero();
    snapshot._accumulatedCostAdjustedBasis = BigInt.zero();

    let token = getAsset(balance.token);
    snapshot.currentNOTEIncentiveDebt = getAccountIncentiveDebt(
      token,
      Address.fromBytes(Address.fromHexString(balance.account))
    );
    snapshot.previousNOTEIncentiveDebt = BigInt.zero();
    snapshot.totalNOTEClaimed = BigInt.zero();
    snapshot.adjustedNOTEClaimed = BigInt.zero();

    // These features are accumulated over the lifetime of the balance, as long
    // as it is not zero.
    if (balance.get("current") !== null) {
      let prevSnapshot = BalanceSnapshot.load(balance.current);
      if (!prevSnapshot) {
        log.error("Previous snapshot not found", []);
      } else if (prevSnapshot.currentBalance.isZero()) {
        // Reset these to zero if the previous balance is zero
        snapshot.totalILAndFeesAtSnapshot = BigInt.zero();
        snapshot._accumulatedBalance = BigInt.zero();
        snapshot._accumulatedCostAdjustedBasis = BigInt.zero();
      } else {
        snapshot.totalILAndFeesAtSnapshot = prevSnapshot.totalILAndFeesAtSnapshot;
        snapshot._accumulatedBalance = prevSnapshot._accumulatedBalance;
        snapshot._accumulatedCostAdjustedBasis = prevSnapshot._accumulatedCostAdjustedBasis;
      }

      if (prevSnapshot) {
        // These values are always copied from the previous snapshot
        snapshot.totalProfitAndLossAtSnapshot = prevSnapshot.totalProfitAndLossAtSnapshot;
        snapshot._accumulatedCostRealized = prevSnapshot._accumulatedCostRealized;
        snapshot.previousBalance = prevSnapshot.currentBalance;
        snapshot.previousNOTEIncentiveDebt = prevSnapshot.currentNOTEIncentiveDebt;
        snapshot.totalNOTEClaimed = prevSnapshot.totalNOTEClaimed;
        snapshot.adjustedNOTEClaimed = prevSnapshot.adjustedNOTEClaimed;
        snapshot.adjustedCostBasis = prevSnapshot.adjustedCostBasis;
        snapshot.impliedFixedRate = prevSnapshot.impliedFixedRate;
      }
    }

    // When a new snapshot is created, it is set to the current.
    balance.current = snapshot.id;
    balance.save();
  }

  return snapshot;
}

export function getBalance(account: Account, token: Token, event: ethereum.Event): Balance {
  let id = account.id + ":" + token.id;
  let entity = Balance.load(id);

  if (entity == null) {
    entity = new Balance(id);
    entity.token = token.id;
    entity.account = account.id;
    entity.firstUpdateBlockNumber = event.block.number;
    entity.firstUpdateTimestamp = event.block.timestamp.toI32();
    entity.firstUpdateTransactionHash = event.transaction.hash;
  }

  entity.lastUpdateBlockNumber = event.block.number;
  entity.lastUpdateTimestamp = event.block.timestamp.toI32();
  entity.lastUpdateTransactionHash = event.transaction.hash;
  return entity as Balance;
}

function _updateBalance(
  account: Account,
  systemAccount: string,
  token: Token,
  transfer: Transfer,
  event: ethereum.Event
): void {
  let balance = getBalance(account, token, event);

  if (systemAccount == ZeroAddress) {
    return;
  } else if (systemAccount == nToken) {
    updateNToken(token, account, balance, event);
  } else if (systemAccount == Vault) {
    updateVaultState(token, account, balance, transfer, event);
  } else if (systemAccount == FeeReserve || systemAccount == SettlementReserve) {
    updateReserves(account, balance, transfer, event, token.currencyId);
  } else {
    updateAccount(token, account, balance, event);
  }
}

function _saveBalance(balance: Balance, snapshot: BalanceSnapshot): void {
  balance.save();
  snapshot.save();
}

function updateERC20ProxyTotalSupply(token: Token): void {
  if (token.tokenInterface != "ERC20") return;
  let erc20 = ERC20.bind(Address.fromBytes(token.tokenAddress));
  let totalSupply = erc20.try_totalSupply();
  if (totalSupply.reverted) {
    log.error("Unable to fetch total supply for {}", [token.tokenAddress.toHexString()]);
  } else {
    token.totalSupply = totalSupply.value;
  }

  token.save();
}

function updateVaultAssetTotalSupply(
  token: Token,
  transfer: Transfer,
  event: ethereum.Event
): void {
  // Do not keep any data for leveraged vaults in V2
  if (isV2()) return;

  if (token.tokenType == VaultCash) {
    if (transfer.transferType == Mint) {
      token.totalSupply = (token.totalSupply as BigInt).plus(transfer.value);
      token.save();
    } else if (transfer.transferType == Burn) {
      token.totalSupply = (token.totalSupply as BigInt).minus(transfer.value);
      token.save();
    }

    // Updates the vault prime cash balance which equals the vault cash total supply.
    let vault = getAccount(Address.fromBytes(token.vaultAddress as Bytes).toHexString(), event);
    let currencyId = token.currencyId;
    let notional = getNotional();
    let primeCashAsset = getAsset(notional.pCashAddress(currencyId).toHexString());
    let vaultPrimeCashBalance = getBalance(vault, primeCashAsset, event);
    let snapshot = getBalanceSnapshot(vaultPrimeCashBalance, event);

    snapshot.currentBalance = token.totalSupply as BigInt;
    _saveBalance(vaultPrimeCashBalance, snapshot);
  }

  let notional = getNotional();
  let vaultState = notional.getVaultState(
    Address.fromBytes(token.vaultAddress as Bytes),
    token.maturity as BigInt
  );

  if (token.tokenType == VaultShare) {
    token.totalSupply = vaultState.totalVaultShares;
    token.save();
  } else if (token.tokenType == VaultDebt) {
    if ((token.maturity as BigInt) == PRIME_CASH_VAULT_MATURITY) {
      let pDebtAddress = notional.pDebtAddress(token.currencyId);
      let pDebt = ERC4626.bind(pDebtAddress);
      let underlying = getUnderlying(token.currencyId);
      // Have to convert to external precision to do the shares conversion
      let totalDebtInExternal = vaultState.totalDebtUnderlying
        .times(underlying.precision)
        .div(INTERNAL_TOKEN_PRECISION)
        .abs();
      token.totalSupply = pDebt.convertToShares(totalDebtInExternal);
    } else {
      token.totalSupply = vaultState.totalDebtUnderlying.abs();
    }
    token.save();
  }
}

export function getTotalfCashDebt(currencyId: i32, maturity: BigInt): BigInt {
  // NOTE: this method does not exist in V2
  if (isV2()) return BigInt.zero();

  let notional = getNotional();
  // NOTE: the call signature changed from the original deployed version
  let totalDebt = notional.try_getTotalfCashDebtOutstanding1(currencyId, maturity);

  if (totalDebt.reverted) {
    return notional.getTotalfCashDebtOutstanding(currencyId, maturity as BigInt);
  } else {
    return totalDebt.value.getTotalfCashDebt();
  }
}

function updatefCashTotalDebtOutstanding(token: Token): void {
  token.totalSupply = getTotalfCashDebt(token.currencyId, token.maturity as BigInt).abs();
  token.save();
}

export function updateNTokenIncentives(currencyId: i32, event: ethereum.Event): void {
  let incentives = getIncentives(currencyId, event);
  let notional = getNotional();
  let nTokenAddress = notional.try_nTokenAddress(currencyId);

  if (!nTokenAddress.reverted && hasMigratedIncentives()) {
    incentives.accumulatedNOTEPerNToken = notional
      .getNTokenAccount(nTokenAddress.value)
      .getAccumulatedNOTEPerNToken();
    incentives.lastAccumulatedTime = notional
      .getNTokenAccount(nTokenAddress.value)
      .getLastAccumulatedTime();
    incentives.save();
  }
}

export function updateBalance(token: Token, transfer: Transfer, event: ethereum.Event): void {
  // Update the total supply figures on the assets first.
  // NOTE: V2 asset cash total supply is not updated here
  if (token.tokenType == PrimeCash || token.tokenType == PrimeDebt || token.tokenType == nToken) {
    updateERC20ProxyTotalSupply(token);
    updatePrimeCashMarket(token.currencyId, event.block, event.transaction.hash.toHexString());
  } else if (token.tokenType == fCash) {
    updatefCashTotalDebtOutstanding(token);
  } else if (
    token.tokenType == VaultShare ||
    token.tokenType == VaultDebt ||
    token.tokenType == VaultCash
  ) {
    updateVaultAssetTotalSupply(token, transfer, event);
  }

  if (transfer.tokenType == NOTE && transfer.fromSystemAccount == Notional) {
    // Update all nToken incentives when tokens are claimed
    let notional = getNotional();
    let maxCurrencyId = notional.getMaxCurrencyId();
    for (let id = 1; id <= maxCurrencyId; id++) {
      updateNTokenIncentives(id, event);
    }
  }

  let fromAccount = getAccount(transfer.from, event);
  _updateBalance(fromAccount, transfer.fromSystemAccount, token, transfer, event);

  if (transfer.from != transfer.to) {
    let toAccount = getAccount(transfer.to, event);
    _updateBalance(toAccount, transfer.toSystemAccount, token, transfer, event);
  }
}

// Includes markets
function updateNToken(
  token: Token,
  nTokenAccount: Account,
  balance: Balance,
  event: ethereum.Event
): void {
  let notional = getNotional();
  let nTokenAddress = Address.fromBytes(Address.fromHexString(nTokenAccount.id));
  let snapshot = getBalanceSnapshot(balance, event);

  if (token.tokenType == fCash) {
    // V2: balanceOf won't work here, use the legacy methods here
    if (token.isfCashDebt) {
      let portfolio = notional.getNTokenPortfolio(nTokenAddress).getNetfCashAssets();
      for (let i = 0; i < portfolio.length; i++) {
        if (portfolio[i].maturity === token.maturity) {
          snapshot.currentBalance = portfolio[i].notional;
          break;
        }
      }
    } else {
      let markets = notional.getActiveMarkets(token.currencyId);
      for (let i = 0; i < markets.length; i++) {
        if (markets[i].maturity === token.maturity) {
          snapshot.currentBalance = markets[i].totalfCash;
          break;
        }
      }
    }

    updatefCashOraclesAndMarkets(
      token.underlying as string,
      event.block,
      event.transaction.hash.toHexString()
    );
  } else if (token.tokenType == PrimeCash) {
    let acct = notional.getNTokenAccount(nTokenAddress);
    let markets = notional.getActiveMarkets(token.currencyId);

    // Total Cash is all cash in markets plus the cash balance held
    let totalCash = markets.reduce((t, m) => {
      return t.plus(m.totalPrimeCash);
    }, acct.getCashBalance());
    snapshot.currentBalance = totalCash;
  }
  _saveBalance(balance, snapshot);
}

function updateVaultState(
  token: Token,
  vault: Account,
  balance: Balance,
  transfer: Transfer,
  event: ethereum.Event
): void {
  // NOTE: vault data is not captured in V2
  if (isV2()) return;

  let prevSnapshot: BalanceSnapshot | null = null;
  if (balance.get("current") !== null) {
    prevSnapshot = BalanceSnapshot.load(balance.current);
  }

  let notional = getNotional();
  let vaultAddress = Address.fromBytes(Address.fromHexString(vault.id));
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let totalDebtUnderlying: BigInt;
  let snapshot = getBalanceSnapshot(balance, event);
  let isPrimary = token.currencyId == vaultConfig.borrowCurrencyId;

  if (token.tokenType == PrimeDebt) {
    let pDebtAddress = notional.pDebtAddress(token.currencyId);
    let pDebt = ERC4626.bind(pDebtAddress);
    if (isPrimary) {
      totalDebtUnderlying = notional.getVaultState(vaultAddress, PRIME_CASH_VAULT_MATURITY)
        .totalDebtUnderlying;
    } else {
      totalDebtUnderlying = notional.getSecondaryBorrow(
        vaultAddress,
        token.currencyId,
        PRIME_CASH_VAULT_MATURITY
      );
    }

    // Have to convert to external precision to do the shares conversion
    let underlying = getUnderlying(token.currencyId);
    let totalDebtInExternal = totalDebtUnderlying
      .times(underlying.precision)
      .div(INTERNAL_TOKEN_PRECISION)
      .abs();
    snapshot.currentBalance = pDebt.convertToShares(totalDebtInExternal);
  } else if (token.tokenType == fCash) {
    if (isPrimary) {
      totalDebtUnderlying = notional.getVaultState(vaultAddress, token.maturity as BigInt)
        .totalDebtUnderlying;
    } else {
      totalDebtUnderlying = notional.getSecondaryBorrow(
        vaultAddress,
        token.currencyId,
        token.maturity as BigInt
      );
    }

    snapshot.currentBalance = totalDebtUnderlying;
  } else if (token.tokenType == PrimeCash) {
    if (prevSnapshot == null) {
      snapshot.currentBalance = transfer.value;
    } else if (transfer.toSystemAccount == Vault) {
      snapshot.currentBalance = prevSnapshot.currentBalance.plus(transfer.value);
    } else if (transfer.fromSystemAccount == Vault) {
      snapshot.currentBalance = prevSnapshot.currentBalance.minus(transfer.value);
    }
  }

  _saveBalance(balance, snapshot);
}

function updateNTokenFeeBuffer(currencyId: i32, transfer: Transfer, event: ethereum.Event): void {
  let config = getCurrencyConfiguration(currencyId);
  if (config === null) return;
  let fCashReserveFeeSharePercent = config.fCashReserveFeeSharePercent;
  let feeBuffer = getNTokenFeeBuffer(currencyId);

  let minTransferTimestamp = event.block.timestamp.minus(NTOKEN_FEE_BUFFER_WINDOW).toI32();
  let feeTransfers = feeBuffer.feeTransfers;
  let feeTransferAmount = feeBuffer.feeTransferAmount;

  // Remove any transfers that are before the min transfer timestamp
  while (feeTransfers.length > 0) {
    let transfer = Transfer.load(feeTransfers[0]);
    if (transfer === null || transfer.timestamp < minTransferTimestamp) {
      feeTransfers.shift();
      feeTransferAmount.shift();
    }
    // Fee transfers should always be in chronological order so we can break once
    // we stop shifting transfers.
    break;
  }

  let transferAmount = transfer.valueInUnderlying
    ? (transfer.valueInUnderlying as BigInt)
        .times(BigInt.fromI32(100 - fCashReserveFeeSharePercent))
        .div(BigInt.fromI32(100))
    : BigInt.zero();
  feeTransferAmount.push(transferAmount);
  feeTransfers.push(transfer.id);

  // Recalculate the last 30 day fees on the updated arrays
  let last30DayNTokenFees = BigInt.zero();
  for (let i = 0; i < feeTransferAmount.length; i++) {
    last30DayNTokenFees = last30DayNTokenFees.plus(feeTransferAmount[i]);
  }

  feeBuffer.feeTransferAmount = feeTransferAmount;
  feeBuffer.feeTransfers = feeTransfers;
  feeBuffer.last30DayNTokenFees = last30DayNTokenFees;
  feeBuffer.lastUpdateBlockNumber = event.block.number;
  feeBuffer.lastUpdateTimestamp = event.block.timestamp.toI32();

  feeBuffer.save();
}

// Includes fee reserve and settlement reserve
function updateReserves(
  reserve: Account,
  balance: Balance,
  transfer: Transfer,
  event: ethereum.Event,
  currencyId: i32
): void {
  let prevSnapshot: BalanceSnapshot | null = null;
  if (balance.get("current") !== null) {
    prevSnapshot = BalanceSnapshot.load(balance.current);
  }

  let snapshot = getBalanceSnapshot(balance, event);

  if (
    transfer.transferType == Mint ||
    (transfer.transferType == _Transfer && transfer.to == reserve.id)
  ) {
    if (prevSnapshot == null) {
      snapshot.currentBalance = transfer.value;
    } else {
      snapshot.currentBalance = prevSnapshot.currentBalance.plus(transfer.value);
    }
  } else if (
    transfer.transferType == Burn ||
    (transfer.transferType == _Transfer && transfer.from == reserve.id)
  ) {
    if (prevSnapshot) {
      snapshot.currentBalance = prevSnapshot.currentBalance.minus(transfer.value);
    }
  }

  _saveBalance(balance, snapshot);

  if (reserve.systemAccountType == FeeReserve) {
    updateNTokenFeeBuffer(currencyId, transfer, event);
  }
}

function updateAccount(
  token: Token,
  account: Account,
  balance: Balance,
  event: ethereum.Event
): void {
  // updates vault account balances directly
  let notional = getNotional();
  let accountAddress = Address.fromBytes(Address.fromHexString(account.id));
  let snapshot = getBalanceSnapshot(balance, event);

  // Updates account balances directly
  if (isV2()) {
    // V2 has different methods for getting the various balances.
    let notionalV2 = getNotionalV2();
    if (token.tokenType === "fCash") {
      // This method will work even if the isfCashDebt flag is set because it is ignored.
      snapshot.currentBalance = notionalV2
        .signedBalanceOf(
          accountAddress,
          BigInt.fromUnsignedBytes(Bytes.fromHexString(token.id).reverse() as ByteArray)
        )
        .abs();
    } else if (token.tokenType === "AssetCash") {
      snapshot.currentBalance = notionalV2
        .getAccountBalance(token.currencyId, accountAddress)
        .getCashBalance();
    } else if (token.tokenType === "nToken") {
      snapshot.currentBalance = notionalV2
        .getAccountBalance(token.currencyId, accountAddress)
        .getNTokenBalance();
    }
  } else if (token.tokenInterface == "ERC1155") {
    // Use the ERC1155 balance of selector which gets the balance directly for fCash
    // and vault assets
    snapshot.currentBalance = notional.balanceOf(
      accountAddress,
      BigInt.fromUnsignedBytes(Bytes.fromHexString(token.id).reverse() as ByteArray)
    );
  } else {
    let erc20 = ERC20.bind(Address.fromBytes(token.tokenAddress as Bytes));
    snapshot.currentBalance = erc20.balanceOf(accountAddress);
  }

  _saveBalance(balance, snapshot);
}
