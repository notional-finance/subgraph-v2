import { Address, ByteArray, ethereum, BigInt } from "@graphprotocol/graph-ts";
import { Notional, VaultPauseStatus, VaultUpdated } from "../generated/NotionalVaults/Notional";
import { IStrategyVault } from '../generated/NotionalVaults/IStrategyVault';
import { StrategyVault, StrategyVaultAccount, StrategyVaultCapacity, StrategyVaultMaturity, StrategyVaultTrade } from "../generated/schema";
import { VaultBorrowCapacityChange, VaultUpdateSecondaryBorrowCapacity } from "../generated/Notional/Notional";

function getVault(id: string): StrategyVault {
  let entity = StrategyVault.load(id);
  if (entity == null) {
    entity = new StrategyVault(id);
    let vaultContract = IStrategyVault.bind(Address.fromString(id))
    let name = vaultContract.try_name();
    if (name.reverted) {
      entity.name = 'unknown';
    } else {
      entity.name = name.value;
    }
  }
  return entity as StrategyVault
}

function getVaultAccount(vault: string, account: string): StrategyVaultAccount {
  let id = vault + ":" + account
  let entity = StrategyVaultAccount.load(id);
  if (entity == null) {
    entity = new StrategyVaultAccount(id);
    entity.strategyVault = vault
    entity.account = account
  }

  return entity as StrategyVaultAccount
}

function getVaultMaturity(vault: string, maturity: i32): StrategyVaultMaturity {
  let id = vault + ":" + maturity.toString()
  let entity = StrategyVaultMaturity.load(id);
  if (entity == null) {
    entity = new StrategyVaultMaturity(id);
    entity.strategyVault = vault
    entity.maturity = maturity
  }

  return entity as StrategyVaultMaturity
}

function getVaultCapacity(vault: string): StrategyVaultCapacity {
  let id = vault
  let entity = StrategyVaultCapacity.load(id);
  if (entity == null) {
    entity = new StrategyVaultCapacity(id);
    entity.strategyVault = vault
  }

  return entity as StrategyVaultCapacity
}

function getVaultTrade(
  vault: string,
  maturity: i32,
  account: string,
  event: ethereum.Event
): StrategyVaultTrade {
  let id = (
    vault + ':' 
    + maturity.toString() + ':'
    + account.toString() + ':'
    + event.transaction.hash.toHexString() + ':'
    + event.logIndex.toString()
  );

  let entity = new StrategyVaultTrade(id);
  entity.blockHash = event.block.hash;
  entity.blockNumber = event.block.number.toI32();
  entity.timestamp = event.block.timestamp.toI32();
  entity.transactionHash = event.transaction.hash;
  entity.transactionOrigin = event.transaction.from;
  entity.isVaultAction = vault == account
  entity.strategyVaultMaturity = vault + ":" + maturity.toString()
  if (vault != account) {
    entity.strategyVaultAccount = vault + ":" + account
  }

  return entity
}

function checkFlag(flags: ByteArray, position: u8): boolean {
  if (position < 8) {
    let mask = 2 ** position;
    return (flags[3] & mask) == mask
  }
  return false
}

function getSecondaryBorrowCurrencyIndex(vault: StrategyVault, currencyId: string): usize {
  if (vault.secondaryBorrowCurrencies == null) {
    return -1
  } else if (
    vault.secondaryBorrowCurrencies!.length <= 2 &&
    vault.secondaryBorrowCurrencies![0] == currencyId
  ) {
    return 0
  } else if (
    vault.secondaryBorrowCurrencies!.length <= 2 &&
    vault.secondaryBorrowCurrencies![1] == currencyId
  ) {
    return 1
  } else {
    return -1
  }
}

export function handleVaultUpdated(event: VaultUpdated): void {
  let vault = getVault(event.params.vault.toHexString());
  let notional = Notional.bind(event.address);
  let vaultConfig = notional.getVaultConfig(event.params.vault)

  vault.primaryBorrowCurrency = vaultConfig.borrowCurrencyId.toString();
  vault.minAccountBorrowSize = vaultConfig.minAccountBorrowSize;
  vault.minCollateralRatioBasisPoints = vaultConfig.minCollateralRatio.toI32();
  vault.maxDeleverageCollateralRatioBasisPoints = vaultConfig.maxDeleverageCollateralRatio.toI32();
  vault.feeRateBasisPoints = vaultConfig.feeRate.toI32();
  vault.reserveFeeSharePercent = vaultConfig.reserveFeeShare.toI32();
  vault.liquidationRatePercent = vaultConfig.liquidationRate.toI32();
  vault.maxBorrowMarketIndex = vaultConfig.maxBorrowMarketIndex.toI32();

  // This should properly handle the listing and de-listing of secondary borrow currencies
  if (vaultConfig.secondaryBorrowCurrencies[0] != 0 || vaultConfig.secondaryBorrowCurrencies[1] != 0) {
    let secondaryBorrowCurrencies = new Array<string>();
    if (vaultConfig.secondaryBorrowCurrencies[0] != 0) {
      secondaryBorrowCurrencies.push(vaultConfig.secondaryBorrowCurrencies[0].toString())
    }

    if (vaultConfig.secondaryBorrowCurrencies[1] != 0) {
      secondaryBorrowCurrencies.push(vaultConfig.secondaryBorrowCurrencies[1].toString())
    }
    vault.secondaryBorrowCurrencies = secondaryBorrowCurrencies
  } else {
    vault.secondaryBorrowCurrencies = null;
  }

  let flags = ByteArray.fromI32(vaultConfig.flags);
  vault.enabled = checkFlag(flags, 0);
  vault.allowRollPosition = checkFlag(flags, 1);
  vault.onlyVaultEntry = checkFlag(flags, 2);
  vault.onlyVaultExit = checkFlag(flags, 3);
  vault.onlyVaultRoll = checkFlag(flags, 4);
  vault.onlyVaultDeleverage = checkFlag(flags, 5);
  vault.onlyVaultSettle = checkFlag(flags, 6);
  vault.allowsReentrancy = checkFlag(flags, 7);

  vault.lastUpdateBlockNumber = event.block.number.toI32();
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save()

  let borrowCapacity = getVaultCapacity(vault.id)
  borrowCapacity.maxPrimaryBorrowCapacity = event.params.maxPrimaryBorrowCapacity
  borrowCapacity.lastUpdateBlockNumber = event.block.number.toI32();
  borrowCapacity.lastUpdateTimestamp = event.block.timestamp.toI32();
  borrowCapacity.lastUpdateBlockHash = event.block.hash;
  borrowCapacity.lastUpdateTransactionHash = event.transaction.hash;
  borrowCapacity.save()
}

export function handleVaultPauseStatus(event: VaultPauseStatus): void {
  let vault = getVault(event.params.vault.toHexString());
  vault.enabled = event.params.enabled
  vault.lastUpdateBlockNumber = event.block.number.toI32();
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save()
}

export function handleVaultUpdateSecondaryBorrowCapacity(event: VaultUpdateSecondaryBorrowCapacity): void {
  let borrowCapacity = getVaultCapacity(event.params.vault.toHexString())
  let vault = getVault(event.params.vault.toHexString());
  let index = getSecondaryBorrowCurrencyIndex(vault, event.params.currencyId.toString())

  let maxSecondaryBorrowCapacity: Array<BigInt>
  if (borrowCapacity.maxSecondaryBorrowCapacity == null) {
    maxSecondaryBorrowCapacity = new Array<BigInt>();
  } else {
    maxSecondaryBorrowCapacity = borrowCapacity.maxSecondaryBorrowCapacity!;
  }

  if (index == 0) {
    if (maxSecondaryBorrowCapacity.length == 0) {
      maxSecondaryBorrowCapacity.push(event.params.maxSecondaryBorrowCapacity);
    } else {
      maxSecondaryBorrowCapacity[0] = event.params.maxSecondaryBorrowCapacity;
    }
  }

  if (index == 1) {
    if (maxSecondaryBorrowCapacity.length == 1) {
      maxSecondaryBorrowCapacity.push(event.params.maxSecondaryBorrowCapacity);
    } else if (maxSecondaryBorrowCapacity.length == 2) {
      maxSecondaryBorrowCapacity[1] = event.params.maxSecondaryBorrowCapacity;
    }
  }

  borrowCapacity.maxSecondaryBorrowCapacity = maxSecondaryBorrowCapacity;
  borrowCapacity.lastUpdateBlockNumber = event.block.number.toI32();
  borrowCapacity.lastUpdateTimestamp = event.block.timestamp.toI32();
  borrowCapacity.lastUpdateBlockHash = event.block.hash;
  borrowCapacity.lastUpdateTransactionHash = event.transaction.hash;
  borrowCapacity.save()
}

export function handleVaultBorrowCapacityChange(event: VaultBorrowCapacityChange): void {
  let currencyId = event.params.currencyId.toString()
  let borrowCapacity = getVaultCapacity(event.params.vault.toHexString())
  let vault = getVault(event.params.vault.toHexString());

  if (currencyId == vault.primaryBorrowCurrency) {
    borrowCapacity.totalUsedPrimaryBorrowCapacity = event.params.totalUsedBorrowCapacity
  } else {
    let index = getSecondaryBorrowCurrencyIndex(vault, currencyId);
    let totalUsedSecondaryBorrowCapacity: Array<BigInt>
    if (borrowCapacity.totalUsedSecondaryBorrowCapacity == null) {
      totalUsedSecondaryBorrowCapacity = new Array<BigInt>();
    } else {
      totalUsedSecondaryBorrowCapacity = borrowCapacity.totalUsedSecondaryBorrowCapacity!
    }

    if (index == 0) {
      if (totalUsedSecondaryBorrowCapacity.length == 0) {
        totalUsedSecondaryBorrowCapacity.push(event.params.totalUsedBorrowCapacity);
      } else {
        totalUsedSecondaryBorrowCapacity[0] = event.params.totalUsedBorrowCapacity;
      }
    }

    if (index == 1) {
      if (totalUsedSecondaryBorrowCapacity.length == 1) {
        totalUsedSecondaryBorrowCapacity.push(event.params.totalUsedBorrowCapacity);
      } else if (totalUsedSecondaryBorrowCapacity.length == 2) {
        totalUsedSecondaryBorrowCapacity[1] = event.params.totalUsedBorrowCapacity;
      }
    }
    borrowCapacity.totalUsedSecondaryBorrowCapacity = totalUsedSecondaryBorrowCapacity;
  }

  borrowCapacity.lastUpdateBlockNumber = event.block.number.toI32();
  borrowCapacity.lastUpdateTimestamp = event.block.timestamp.toI32();
  borrowCapacity.lastUpdateBlockHash = event.block.hash;
  borrowCapacity.lastUpdateTransactionHash = event.transaction.hash;
  borrowCapacity.save()
}