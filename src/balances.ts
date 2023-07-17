import { Address, ethereum, log, BigInt, Bytes, ByteArray } from "@graphprotocol/graph-ts";
import { Account, Token, Balance, Transfer, BalanceSnapshot } from "../generated/schema";
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
} from "./common/constants";
import { getAccount, getAsset, getIncentives, getNotional } from "./common/entities";
import { updatePrimeCashMarket } from "./common/market";
import { updatefCashOraclesAndMarkets } from "./exchange_rates";

export function getBalanceSnapshot(balance: Balance, event: ethereum.Event): BalanceSnapshot {
  let id = balance.id + ":" + event.block.number.toString();
  let snapshot = BalanceSnapshot.load(id);

  if (snapshot == null) {
    snapshot = new BalanceSnapshot(id);
    snapshot.balance = balance.id;
    snapshot.blockNumber = event.block.number.toI32();
    snapshot.timestamp = event.block.timestamp.toI32();
    snapshot.transaction = event.transaction.hash.toHexString();

    // These features are calculated at each update to the snapshot
    snapshot.currentBalance = BigInt.zero();
    snapshot.adjustedCostBasis = BigInt.zero();
    snapshot.currentProfitAndLossAtSnapshot = BigInt.zero();
    snapshot.totalProfitAndLossAtSnapshot = BigInt.zero();
    snapshot.totalILAndFeesAtSnapshot = BigInt.zero();
    snapshot.totalInterestAccrualAtSnapshot = BigInt.zero();
    snapshot._accumulatedBalance = BigInt.zero();
    snapshot._accumulatedCostRealized = BigInt.zero();
    snapshot._accumulatedCostAdjustedBasis = BigInt.zero();

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
    entity.firstUpdateBlockNumber = event.block.number.toI32();
    entity.firstUpdateTimestamp = event.block.timestamp.toI32();
    entity.firstUpdateTransactionHash = event.transaction.hash;
  }

  entity.lastUpdateBlockNumber = event.block.number.toI32();
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
    updateVaultState(token, account, balance, event);
  } else if (systemAccount == FeeReserve || systemAccount == SettlementReserve) {
    updateReserves(account, balance, transfer, event);
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
      token.totalSupply = pDebt.convertToShares(vaultState.totalDebtUnderlying.abs());
    } else {
      token.totalSupply = vaultState.totalDebtUnderlying;
    }
    token.save();
  }
}

function updatefCashTotalDebtOutstanding(token: Token): void {
  let notional = getNotional();
  let totalDebt = notional.getTotalfCashDebtOutstanding(token.currencyId, token.maturity as BigInt);
  // Total debt is returned as a negative number.
  token.totalSupply = totalDebt.neg();
  token.save();
}

function updateNTokenIncentives(token: Token, event: ethereum.Event): void {
  let incentives = getIncentives(token.currencyId, event);
  let notional = getNotional();
  incentives.accumulatedNOTEPerNToken = notional
    .getNTokenAccount(Address.fromBytes(token.tokenAddress as Bytes))
    .getAccumulatedNOTEPerNToken();
  incentives.save();
}

export function updateBalance(token: Token, transfer: Transfer, event: ethereum.Event): void {
  // Update the total supply figures on the assets first.
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

  if (token.tokenType == nToken) {
    updateNTokenIncentives(token, event);
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
    snapshot.currentBalance = notional.balanceOf(
      nTokenAddress,
      BigInt.fromUnsignedBytes(Bytes.fromHexString(token.id).reverse() as ByteArray)
    );

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
  event: ethereum.Event
): void {
  let notional = getNotional();
  let vaultAddress = Address.fromBytes(Address.fromHexString(vault.id));
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let totalDebtUnderlying: BigInt;
  let snapshot = getBalanceSnapshot(balance, event);

  if (token.currencyId == vaultConfig.borrowCurrencyId) {
    totalDebtUnderlying = notional.getVaultState(vaultAddress, token.maturity as BigInt)
      .totalDebtUnderlying;
  } else {
    totalDebtUnderlying = notional.getSecondaryBorrow(
      vaultAddress,
      token.currencyId,
      token.maturity as BigInt
    );
  }

  if (token.tokenType == PrimeDebt) {
    let pDebtAddress = notional.pDebtAddress(token.currencyId);
    let pDebt = ERC4626.bind(pDebtAddress);
    snapshot.currentBalance = pDebt.convertToShares(totalDebtUnderlying.abs());
  } else if (token.tokenType == fCash) {
    snapshot.currentBalance = totalDebtUnderlying;
  }

  _saveBalance(balance, snapshot);
}

// Includes fee reserve and settlement reserve
function updateReserves(
  reserve: Account,
  balance: Balance,
  transfer: Transfer,
  event: ethereum.Event
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

  // updates account balances directly
  if (token.tokenInterface == "ERC1155") {
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
