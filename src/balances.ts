import { Address, ethereum, log, store, BigInt, Bytes, ByteArray } from "@graphprotocol/graph-ts";
import { Account, Token, Balance, Transfer } from "../generated/schema";
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

function getBalance(account: Account, token: Token, event: ethereum.Event): Balance {
  let id = account.id + ":" + token.id;
  let entity = Balance.load(id);

  if (entity == null) {
    entity = new Balance(id);
    entity.token = token.id;
    entity.account = account.id;
    entity.firstUpdateBlockNumber = event.block.number.toI32();
    entity.firstUpdateTimestamp = event.block.timestamp.toI32();
    entity.firstUpdateTransactionHash = event.transaction.hash;
    entity.balance = BigInt.zero();
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
    updateVaultState(token, account, balance);
  } else if (systemAccount == FeeReserve || systemAccount == SettlementReserve) {
    updateReserves(account, balance, transfer);
  } else {
    updateAccount(token, account, balance);
  }
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
    } else if (transfer.transferType == Burn) {
      token.totalSupply = (token.totalSupply as BigInt).minus(transfer.value);
    }

    // Updates the vault prime cash balance which equals the vault cash total supply.
    let vault = getAccount(Address.fromBytes(token.vaultAddress as Bytes).toHexString(), event);
    let currencyId = token.currencyId;
    let notional = getNotional();
    let primeCashAsset = getAsset(notional.pCashAddress(currencyId).toHexString());
    let vaultPrimeCashBalance = getBalance(vault, primeCashAsset, event);

    vaultPrimeCashBalance.balance = token.totalSupply as BigInt;
    _saveBalance(vaultPrimeCashBalance);
  }

  let notional = getNotional();
  let vaultState = notional.getVaultState(
    Address.fromBytes(token.vaultAddress as Bytes),
    BigInt.fromI32(token.maturity)
  );

  if (token.tokenType == VaultShare) {
    token.totalSupply = vaultState.totalVaultShares;
  } else if (token.tokenType == VaultDebt) {
    if (token.maturity == PRIME_CASH_VAULT_MATURITY) {
      let pDebtAddress = notional.pDebtAddress(token.currencyId);
      let pDebt = ERC4626.bind(pDebtAddress);
      token.totalSupply = pDebt.convertToShares(vaultState.totalDebtUnderlying);
    } else {
      token.totalSupply = vaultState.totalDebtUnderlying;
    }
  }
}

function updatefCashTotalDebtOutstanding(token: Token): void {
  let notional = getNotional();
  let totalDebt = notional.getTotalfCashDebtOutstanding(
    token.currencyId,
    BigInt.fromI32(token.maturity)
  );
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

function _saveBalance(balance: Balance): void {
  // Delete zero balances from cluttering up the store.
  if (balance.balance.isZero()) {
    store.remove("Balance", balance.id);
  } else {
    balance.save();
  }
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

  if (token.tokenType == fCash) {
    balance.balance = notional.balanceOf(
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
    balance.balance = totalCash;
  }
  _saveBalance(balance);
}

function updateVaultState(token: Token, vault: Account, balance: Balance): void {
  let notional = getNotional();
  let vaultAddress = Address.fromBytes(Address.fromHexString(vault.id));
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let totalDebtUnderlying: BigInt;

  if (token.currencyId == vaultConfig.borrowCurrencyId) {
    totalDebtUnderlying = notional.getVaultState(vaultAddress, BigInt.fromI32(token.maturity))
      .totalDebtUnderlying;
  } else {
    totalDebtUnderlying = notional.getSecondaryBorrow(
      vaultAddress,
      token.currencyId,
      BigInt.fromI32(token.maturity)
    );
  }

  if (token.tokenType == PrimeDebt) {
    let pDebtAddress = notional.pDebtAddress(token.currencyId);
    let pDebt = ERC4626.bind(pDebtAddress);
    balance.balance = pDebt.convertToShares(totalDebtUnderlying);
  } else if (token.tokenType == fCash) {
    balance.balance = totalDebtUnderlying;
  }

  _saveBalance(balance);
}

// Includes fee reserve and settlement reserve
function updateReserves(reserve: Account, balance: Balance, transfer: Transfer): void {
  if (
    transfer.transferType == Mint ||
    (transfer.transferType == _Transfer && transfer.to == reserve.id)
  ) {
    balance.balance = balance.balance.plus(transfer.value);
  } else if (
    transfer.transferType == Burn ||
    (transfer.transferType == _Transfer && transfer.from == reserve.id)
  ) {
    balance.balance = balance.balance.minus(transfer.value);
  }

  // Don't do balance deletes for reserves so that we can see explicit zero balances
  balance.save();
}

function updateAccount(token: Token, account: Account, balance: Balance): void {
  // updates vault account balances directly
  let notional = getNotional();
  let accountAddress = Address.fromBytes(Address.fromHexString(account.id));

  // updates account balances directly
  if (token.tokenInterface == "ERC1155") {
    // Use the ERC1155 balance of selector which gets the balance directly for fCash
    // and vault assets
    balance.balance = notional.balanceOf(
      accountAddress,
      BigInt.fromUnsignedBytes(Bytes.fromHexString(token.id).reverse() as ByteArray)
    );
  } else {
    let erc20 = ERC20.bind(Address.fromBytes(token.tokenAddress as Bytes));
    balance.balance = erc20.balanceOf(accountAddress);
  }

  _saveBalance(balance);
}
