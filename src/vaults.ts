import { Address, ByteArray, ethereum, BigInt } from "@graphprotocol/graph-ts";
import { Notional, VaultPauseStatus, VaultUpdated } from "../generated/NotionalVaults/Notional";
import { IStrategyVault } from '../generated/NotionalVaults/IStrategyVault';
import { StrategyVault, StrategyVaultAccount, StrategyVaultCapacity, StrategyVaultDirectory, StrategyVaultMaturity, StrategyVaultTrade } from "../generated/schema";
import { VaultBorrowCapacityChange, VaultEnterPosition, VaultExitPostMaturity, VaultExitPreMaturity, VaultRepaySecondaryBorrow, VaultRollPosition, VaultSecondaryBorrow, VaultStateUpdate, VaultUpdateSecondaryBorrowCapacity } from "../generated/Notional/Notional";
import { updateMarkets } from "./markets";
import { updateNTokenPortfolio } from "./accounts";
import { getNToken } from "./notional";

export function getVaultDirectory(): StrategyVaultDirectory {
  let entity = StrategyVaultDirectory.load("0");
  if (entity == null) {
    entity = new StrategyVaultDirectory("0")
    entity.listedStrategyVaults = new Array<string>();
  }

  return entity as StrategyVaultDirectory
}


export function getVault(id: string): StrategyVault {
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

    let directory = getVaultDirectory()
    let listedVaults = directory.listedStrategyVaults
    listedVaults.push(id)
    directory.listedStrategyVaults = listedVaults;
    directory.save();
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

function updateVaultMarkets(vault: StrategyVault, event: ethereum.Event): void {
  let primaryBorrowCurrencyId = I32.parseInt(vault.primaryBorrowCurrency)
  let blockTime = event.block.timestamp.toI32()

  // Update markets and nToken to account for fees on enter
  updateMarkets(primaryBorrowCurrencyId, blockTime, event)
  
  // Update markets for secondary borrow currencies
  if (vault.secondaryBorrowCurrencies != null) {
    if (vault.secondaryBorrowCurrencies!.length >= 1) {
      let currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![0])
      if (currencyId != 0) updateMarkets(currencyId, blockTime, event)
    }

    if (vault.secondaryBorrowCurrencies!.length == 2) {
      let currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![1])
      if (currencyId != 0) updateMarkets(currencyId, blockTime, event)
    }
  }
}

function updateVaultAccount(vault: StrategyVault, account: Address, event: ethereum.Event): void {
  let vaultAccount = getVaultAccount(vault.id, account.toHexString())
  let notional = Notional.bind(event.address)
  let vaultAddress = Address.fromBytes(vault.vaultAddress)
  let accountResult = notional.getVaultAccount(account, vaultAddress)
  vaultAccount.maturity = accountResult.maturity.toI32()
  vaultAccount.vaultShares = accountResult.vaultShares
  vaultAccount.primaryBorrowfCash = accountResult.fCash
    
  if (vault.secondaryBorrowCurrencies != null) {
    let debtShares = notional.getVaultAccountDebtShares(account, vaultAddress)
    let secondaryBorrowDebtShares = new Array<BigInt>()

    if (vault.secondaryBorrowCurrencies!.length >= 1) {
      secondaryBorrowDebtShares.push(debtShares.value1[0])
    }

    if (vault.secondaryBorrowCurrencies!.length == 2) {
      secondaryBorrowDebtShares.push(debtShares.value1[1])
    }
    vaultAccount.secondaryBorrowDebtShares = secondaryBorrowDebtShares
  }

  vaultAccount.lastUpdateBlockNumber = event.block.number.toI32();
  vaultAccount.lastUpdateTimestamp = event.block.timestamp.toI32();
  vaultAccount.lastUpdateBlockHash = event.block.hash;
  vaultAccount.lastUpdateTransactionHash = event.transaction.hash;
  vaultAccount.save()
}

function updateVaultState(vault: StrategyVault, maturity: BigInt, event: ethereum.Event): void {
  let vaultMaturity = getVaultMaturity(vault.id, maturity.toI32())
  let notional = Notional.bind(event.address)
  let vaultAddress = Address.fromBytes(vault.vaultAddress)
  let vaultState = notional.getVaultState(vaultAddress, maturity)

  vaultMaturity.totalPrimaryfCashBorrowed = vaultState.totalfCash
  vaultMaturity.totalAssetCash = vaultState.totalAssetCash
  vaultMaturity.totalVaultShares = vaultState.totalVaultShares
  vaultMaturity.totalStrategyTokens = vaultState.totalStrategyTokens

  if (vault.secondaryBorrowCurrencies != null) {
    let totalSecondaryfCashBorrowed = new Array<BigInt>()
    let totalSecondaryDebtShares = new Array<BigInt>()

    if (vault.secondaryBorrowCurrencies!.length >= 1) {
      let currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![0])
      let borrow = notional.getSecondaryBorrow(vaultAddress, currencyId, maturity)
      totalSecondaryfCashBorrowed.push(borrow.value0)
      totalSecondaryDebtShares.push(borrow.value1)
    }

    if (vault.secondaryBorrowCurrencies!.length == 2) {
      let currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![1])
      let borrow = notional.getSecondaryBorrow(vaultAddress, currencyId, maturity)
      totalSecondaryfCashBorrowed.push(borrow.value0)
      totalSecondaryDebtShares.push(borrow.value1)
    }

    vaultMaturity.totalSecondaryfCashBorrowed = totalSecondaryfCashBorrowed
    vaultMaturity.totalSecondaryDebtShares = totalSecondaryDebtShares
  }
  
  if (!vaultMaturity.isSettled && vaultState.isSettled) {
    // NOTE: we should only ever enter this if block once
    vaultMaturity.settlementTimestamp = event.block.timestamp.toI32()
    vaultMaturity.settlementStrategyTokenValue = vaultState.settlementStrategyTokenValue
    vaultMaturity.settlementRate = vault.primaryBorrowCurrency + ":" + maturity.toString()
  }
  vaultMaturity.isSettled = vaultState.isSettled

  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32();
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32();
  vaultMaturity.lastUpdateBlockHash = event.block.hash;
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash;
  vaultMaturity.save()
}

export function handleVaultEnterPosition(event: VaultEnterPosition): void {
  let vault = getVault(event.params.vault.toHexString())
  updateVaultMarkets(vault, event)
  updateNTokenPortfolio(getNToken(vault.primaryBorrowCurrency), event, null);
  updateVaultAccount(vault, event.params.account, event)
  // TODO: trade event
}

export function handleVaultExitPreMaturity(event: VaultExitPreMaturity): void {
  let vault = getVault(event.params.vault.toHexString())
  // No nToken Fee to update
  updateVaultMarkets(vault, event)
  updateVaultAccount(vault, event.params.account, event)
  // TODO: trade event
}

export function handleVaultRollPosition(event: VaultRollPosition): void {
  let vault = getVault(event.params.vault.toHexString())
  updateVaultMarkets(vault, event)
  updateNTokenPortfolio(getNToken(vault.primaryBorrowCurrency), event, null);
  updateVaultAccount(vault, event.params.account, event)
  // TODO: trade event
}

export function handleVaultExitPostMaturity(event: VaultExitPostMaturity): void {
  let vault = getVault(event.params.vault.toHexString())
  updateVaultAccount(vault, event.params.account, event)
  // TODO: trade event
}

export function handleVaultStateUpdate(event: VaultStateUpdate): void {
  let vault = getVault(event.params.vault.toHexString())
  let maturity = event.params.maturity;
  updateVaultState(vault, maturity, event);
}

export function handleVaultSecondaryBorrow(event: VaultSecondaryBorrow): void {
  let vault = getVault(event.params.vault.toHexString())
  // TODO: need to emit maturity, secondary borrows do not trigger vault state update
  // updateVaultState(vault, maturity, event);
  updateVaultMarkets(vault, event)
  updateVaultAccount(vault, event.params.account, event);
}

export function handleVaultRepaySecondaryBorrow(event: VaultRepaySecondaryBorrow): void {
  let vault = getVault(event.params.vault.toHexString())
  // TODO: need to emit maturity, secondary borrows do not trigger vault state update
  // updateVaultState(vault, maturity, event);
  updateVaultMarkets(vault, event)
  updateVaultAccount(vault, event.params.account, event);
}