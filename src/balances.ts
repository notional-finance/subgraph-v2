import { Address, ethereum, log, store, BigInt } from "@graphprotocol/graph-ts";
import { Account, Asset, Balance, Transfer } from "../generated/schema";
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
import { updateMarket } from "./common/market";

function getBalance(account: Account, asset: Asset, event: ethereum.Event): Balance {
  let id = account.id + ":" + asset.id;
  let entity = Balance.load(id);

  if (entity == null) {
    entity = new Balance(id);
    entity.asset = asset.id;
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
  asset: Asset,
  transfer: Transfer,
  event: ethereum.Event
): void {
  let balance = getBalance(account, asset, event);

  if (systemAccount == ZeroAddress) {
    return;
  } else if (systemAccount == nToken) {
    updateNToken(asset, account, balance, event);
  } else if (systemAccount == Vault) {
    updateVaultState(asset, account, balance);
  } else if (systemAccount == FeeReserve || systemAccount == SettlementReserve) {
    updateReserves(account, balance, transfer);
  } else {
    updateAccount(asset, account, balance);
  }
}

function updateERC20ProxyTotalSupply(asset: Asset): void {
  if (asset.assetInterface != "ERC20") return;
  let erc20 = ERC20.bind(asset.tokenAddress as Address);
  let totalSupply = erc20.try_totalSupply();
  if (totalSupply.reverted) {
    log.error("Unable to fetch total supply for {}", [asset.tokenAddress.toHexString()]);
  } else {
    asset.totalSupply = totalSupply.value;
  }

  asset.save();
}

function updateVaultAssetTotalSupply(
  asset: Asset,
  transfer: Transfer,
  event: ethereum.Event
): void {
  if (asset.assetType == VaultCash) {
    if (transfer.transferType == Mint) {
      asset.totalSupply = (asset.totalSupply as BigInt).plus(transfer.value);
    } else if (transfer.transferType == Burn) {
      asset.totalSupply = (asset.totalSupply as BigInt).minus(transfer.value);
    }

    // Updates the vault prime cash balance which equals the vault cash total supply.
    let vault = getAccount((asset.vaultAddress as Address).toHexString(), event);
    let currencyId = asset.currencyId;
    let notional = getNotional();
    let primeCashAsset = getAsset(notional.pCashAddress(currencyId).toHexString());
    let vaultPrimeCashBalance = getBalance(vault, primeCashAsset, event);

    vaultPrimeCashBalance.balance = asset.totalSupply as BigInt;
    _saveBalance(vaultPrimeCashBalance);
  }

  let notional = getNotional();
  let vaultState = notional.getVaultState(
    asset.vaultAddress as Address,
    BigInt.fromI32(asset.maturity)
  );

  if (asset.assetType == VaultShare) {
    asset.totalSupply = vaultState.totalVaultShares;
  } else if (asset.assetType == VaultDebt) {
    if (asset.maturity == PRIME_CASH_VAULT_MATURITY) {
      let pDebtAddress = notional.pDebtAddress(asset.currencyId);
      let pDebt = ERC4626.bind(pDebtAddress);
      asset.totalSupply = pDebt.convertToShares(vaultState.totalDebtUnderlying);
    } else {
      asset.totalSupply = vaultState.totalDebtUnderlying;
    }
  }
}

function updatefCashTotalDebtOutstanding(asset: Asset): void {
  let notional = getNotional();
  let totalDebt = notional.getTotalfCashDebtOutstanding(
    asset.currencyId,
    BigInt.fromI32(asset.maturity)
  );
  // Total debt is returned as a negative number.
  asset.totalSupply = totalDebt.neg();
  asset.save();
}

function updateNTokenIncentives(asset: Asset, event: ethereum.Event): void {
  let incentives = getIncentives(asset.currencyId, event);
  let notional = getNotional();
  incentives.accumulatedNOTEPerNToken = notional
    .getNTokenAccount(asset.tokenAddress as Address)
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

export function updateBalance(asset: Asset, transfer: Transfer, event: ethereum.Event): void {
  // Update the total supply figures on the assets first.
  if (asset.assetType == PrimeCash || asset.assetType == PrimeDebt || asset.assetType == nToken) {
    updateERC20ProxyTotalSupply(asset);
  } else if (asset.assetType == fCash) {
    updatefCashTotalDebtOutstanding(asset);
  } else if (
    asset.assetType == VaultShare ||
    asset.assetType == VaultDebt ||
    asset.assetType == VaultCash
  ) {
    updateVaultAssetTotalSupply(asset, transfer, event);
  }

  if (asset.assetType == nToken) {
    updateNTokenIncentives(asset, event);
  }

  let fromAccount = getAccount(transfer.from, event);
  _updateBalance(fromAccount, transfer.fromSystemAccount, asset, transfer, event);

  if (transfer.from != transfer.to) {
    let toAccount = getAccount(transfer.to, event);
    _updateBalance(toAccount, transfer.toSystemAccount, asset, transfer, event);
  }
}

// Includes markets
function updateNToken(
  asset: Asset,
  nTokenAccount: Account,
  balance: Balance,
  event: ethereum.Event
): void {
  let notional = getNotional();
  let nTokenAddress = Address.fromHexString(nTokenAccount.id) as Address;

  if (asset.assetType == fCash) {
    balance.balance = notional.balanceOf(nTokenAddress, BigInt.fromString(asset.id));
    updateMarket(asset.currencyId, asset.maturity, event);
  } else if (asset.assetType == PrimeCash) {
    let acct = notional.getNTokenAccount(nTokenAddress);
    balance.balance = acct.getCashBalance();
  }
  _saveBalance(balance);
}

function updateVaultState(asset: Asset, vault: Account, balance: Balance): void {
  let notional = getNotional();
  let vaultAddress = Address.fromHexString(vault.id) as Address;
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let totalDebtUnderlying: BigInt;

  if (asset.currencyId == vaultConfig.borrowCurrencyId) {
    totalDebtUnderlying = notional.getVaultState(vaultAddress, BigInt.fromI32(asset.maturity))
      .totalDebtUnderlying;
  } else {
    totalDebtUnderlying = notional.getSecondaryBorrow(
      vaultAddress,
      asset.currencyId,
      BigInt.fromI32(asset.maturity)
    );
  }

  if (asset.assetType == PrimeDebt) {
    let pDebtAddress = notional.pDebtAddress(asset.currencyId);
    let pDebt = ERC4626.bind(pDebtAddress);
    balance.balance = pDebt.convertToShares(totalDebtUnderlying);
  } else if (asset.assetType == fCash) {
    balance.balance == totalDebtUnderlying;
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

function updateAccount(asset: Asset, account: Account, balance: Balance): void {
  // updates vault account balances directly
  let notional = getNotional();
  let accountAddress = Address.fromHexString(account.id) as Address;

  // updates account balances directly
  if (asset.assetInterface == "ERC1155") {
    // Use the ERC1155 balance of selector which gets the balance directly for fCash
    // and vault assets
    balance.balance = notional.balanceOf(accountAddress, BigInt.fromString(asset.id));
  } else {
    let erc20 = ERC20.bind(asset.tokenAddress as Address);
    balance.balance = erc20.balanceOf(accountAddress);
  }

  _saveBalance(balance);
}
