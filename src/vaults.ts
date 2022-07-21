import { Address, ByteArray, ethereum, BigInt } from "@graphprotocol/graph-ts";
import { Notional, VaultPauseStatus, VaultSettledAssetsRemaining, VaultUpdated,  ProtocolInsolvency, VaultBorrowCapacityChange, VaultDeleverageAccount, VaultEnterPosition, VaultExitPostMaturity, VaultExitPreMaturity, VaultFeeAccrued, VaultLiquidatorProfit, VaultMintStrategyToken, VaultRedeemStrategyToken, VaultRepaySecondaryBorrow, VaultRollPosition, VaultSecondaryBorrow, VaultSecondaryBorrowSnapshot, VaultShortfall, VaultStateUpdate, VaultUpdateSecondaryBorrowCapacity  } from "../generated/NotionalVaults/Notional";
import { IStrategyVault } from '../generated/NotionalVaults/IStrategyVault';
import { StrategyVault, StrategyVaultAccount, StrategyVaultCapacity, StrategyVaultDirectory, StrategyVaultMaturity, StrategyVaultMaturityEvent, StrategyVaultTrade } from "../generated/schema";
import { updateMarkets } from "./markets";
import { updateNTokenPortfolio } from "./accounts";
import { getNToken } from "./notional";

function getZeroArray(): Array<BigInt> {
  let arr = new Array<BigInt>(2)
  arr[0] = BigInt.fromI32(0)
  arr[1] = BigInt.fromI32(0)
  return arr
}

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
    entity.vaultShares = BigInt.fromI32(0)
    entity.primaryBorrowfCash = BigInt.fromI32(0)
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

function getVaultMaturityEvent(vault: string, maturity: i32, event: ethereum.Event): StrategyVaultMaturityEvent {
  let id = (
    vault + ':' 
    + maturity.toString() + ':'
    + event.transaction.hash.toHexString() + ':'
    + event.logIndex.toString()
  );

  let entity = new StrategyVaultMaturityEvent(id);
  entity.blockHash = event.block.hash;
  entity.blockNumber = event.block.number.toI32();
  entity.timestamp = event.block.timestamp.toI32();
  entity.transactionHash = event.transaction.hash;
  entity.transactionOrigin = event.transaction.from;

  return entity as StrategyVaultMaturityEvent
}

function setVaultTrade(
  vault: string,
  accountBefore: StrategyVaultAccount,
  accountAfter: StrategyVaultAccount,
  vaultTradeType: string,
  event: ethereum.Event
): void {
  let id = (
    vault + ':' 
    + accountBefore.maturity.toString() + ':'
    + accountBefore.id + ':'
    + event.transaction.hash.toHexString() + ':'
    + event.logIndex.toString()
  );

  let entity = new StrategyVaultTrade(id);
  entity.blockHash = event.block.hash;
  entity.blockNumber = event.block.number.toI32();
  entity.timestamp = event.block.timestamp.toI32();
  entity.transactionHash = event.transaction.hash;
  entity.transactionOrigin = event.transaction.from;
  entity.strategyVaultAccount = accountBefore.id
  entity.vaultTradeType = vaultTradeType;

  entity.strategyVaultMaturityBefore = accountBefore.strategyVaultMaturity
  entity.primaryBorrowfCashBefore = accountBefore.primaryBorrowfCash
  entity.vaultSharesBefore = accountBefore.vaultShares
  entity.secondaryDebtSharesBefore = accountBefore.secondaryBorrowDebtShares

  entity.strategyVaultMaturityAfter = accountAfter.strategyVaultMaturity
  entity.primaryBorrowfCashAfter = accountAfter.primaryBorrowfCash
  entity.vaultSharesAfter = accountAfter.vaultShares
  entity.secondaryDebtSharesAfter = accountBefore.secondaryBorrowDebtShares

  entity.netPrimaryBorrowfCashChange = accountAfter.primaryBorrowfCash.minus(accountBefore.primaryBorrowfCash)
  entity.netVaultSharesChange = accountAfter.vaultShares.minus(accountBefore.vaultShares)
  
  let secondaryDebtSharesBefore: Array<BigInt>;
  let secondaryDebtSharesAfter: Array<BigInt>;
  if (accountBefore.secondaryBorrowDebtShares == null) {
    secondaryDebtSharesBefore = getZeroArray()
  } else {
    secondaryDebtSharesBefore = accountBefore.secondaryBorrowDebtShares!
  }

  if (accountAfter.secondaryBorrowDebtShares == null) {
    secondaryDebtSharesAfter = getZeroArray()
  } else {
    secondaryDebtSharesAfter = accountAfter.secondaryBorrowDebtShares!
  }

  if (entity.secondaryDebtSharesBefore != null || entity.secondaryDebtSharesAfter != null) {
    let netSecondaryDebtSharesChange = getZeroArray()
    netSecondaryDebtSharesChange[0] = secondaryDebtSharesAfter[0].minus(secondaryDebtSharesBefore[0])
    netSecondaryDebtSharesChange[1] = secondaryDebtSharesAfter[1].minus(secondaryDebtSharesBefore[1])
    entity.netSecondaryDebtSharesChange = netSecondaryDebtSharesChange
  }

  entity.save()
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

  if (vaultConfig.secondaryBorrowCurrencies[0] != 0 || vaultConfig.secondaryBorrowCurrencies[1] != 0) {
    let secondaryBorrowCurrencies = new Array<string>(2);
    secondaryBorrowCurrencies[0] = vaultConfig.secondaryBorrowCurrencies[0].toString()
    secondaryBorrowCurrencies[1] = vaultConfig.secondaryBorrowCurrencies[1].toString()
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
    maxSecondaryBorrowCapacity = getZeroArray()
  } else {
    maxSecondaryBorrowCapacity = borrowCapacity.maxSecondaryBorrowCapacity!;
  }

  if (index == 0) {
    maxSecondaryBorrowCapacity[0] = event.params.maxSecondaryBorrowCapacity;
  } else if (index == 1) {
    maxSecondaryBorrowCapacity[1] = event.params.maxSecondaryBorrowCapacity;
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
      totalUsedSecondaryBorrowCapacity = getZeroArray()
    } else {
      totalUsedSecondaryBorrowCapacity = borrowCapacity.totalUsedSecondaryBorrowCapacity!
    }

    if (index == 0) {
      totalUsedSecondaryBorrowCapacity[0] = event.params.totalUsedBorrowCapacity;
    } else if (index == 1) {
      totalUsedSecondaryBorrowCapacity[1] = event.params.totalUsedBorrowCapacity;
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
    let currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![0])
    if (currencyId != 0) updateMarkets(currencyId, blockTime, event)

    currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![1])
    if (currencyId != 0) updateMarkets(currencyId, blockTime, event)
  }
}

function updateVaultAccount(vault: StrategyVault, account: Address, event: ethereum.Event): StrategyVaultAccount {
  let vaultAccount = getVaultAccount(vault.id, account.toHexString())
  let notional = Notional.bind(event.address)
  let vaultAddress = Address.fromBytes(vault.vaultAddress)
  let accountResult = notional.getVaultAccount(account, vaultAddress)
  vaultAccount.maturity = accountResult.maturity.toI32()
  vaultAccount.vaultShares = accountResult.vaultShares
  vaultAccount.primaryBorrowfCash = accountResult.fCash
    
  if (vault.secondaryBorrowCurrencies != null) {
    let debtShares = notional.getVaultAccountDebtShares(account, vaultAddress)
    vaultAccount.secondaryBorrowDebtShares = debtShares.value1
  }

  vaultAccount.lastUpdateBlockNumber = event.block.number.toI32();
  vaultAccount.lastUpdateTimestamp = event.block.timestamp.toI32();
  vaultAccount.lastUpdateBlockHash = event.block.hash;
  vaultAccount.lastUpdateTransactionHash = event.transaction.hash;
  vaultAccount.save()

  return vaultAccount
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
    let totalSecondaryfCashBorrowed = getZeroArray()
    let totalSecondaryDebtShares = getZeroArray()

    let currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![0])
    if (currencyId != 0) {
      let borrow = notional.getSecondaryBorrow(vaultAddress, currencyId, maturity)
      totalSecondaryfCashBorrowed[0] = borrow.value0
      totalSecondaryDebtShares[0] = borrow.value1
    }

    currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![1])
    if (currencyId != 0) {
      let borrow = notional.getSecondaryBorrow(vaultAddress, currencyId, maturity)
      totalSecondaryfCashBorrowed[1] = borrow.value0
      totalSecondaryDebtShares[1] = borrow.value1
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
  let accountBefore = getVaultAccount(vault.id, event.params.account.toHexString())
  updateVaultMarkets(vault, event)
  updateNTokenPortfolio(getNToken(vault.primaryBorrowCurrency), event, null);
  let accountAfter = updateVaultAccount(vault, event.params.account, event)
  setVaultTrade(vault.id, accountBefore, accountAfter, 'EnterPosition', event)
}

export function handleVaultExitPreMaturity(event: VaultExitPreMaturity): void {
  let vault = getVault(event.params.vault.toHexString())
  let accountBefore = getVaultAccount(vault.id, event.params.account.toHexString())
  // No nToken Fee to update
  updateVaultMarkets(vault, event)
  let accountAfter = updateVaultAccount(vault, event.params.account, event)
  setVaultTrade(vault.id, accountBefore, accountAfter, 'ExitPreMaturity', event)
}

export function handleVaultRollPosition(event: VaultRollPosition): void {
  let vault = getVault(event.params.vault.toHexString())
  let accountBefore = getVaultAccount(vault.id, event.params.account.toHexString())
  updateVaultMarkets(vault, event)
  updateNTokenPortfolio(getNToken(vault.primaryBorrowCurrency), event, null);
  let accountAfter = updateVaultAccount(vault, event.params.account, event)
  setVaultTrade(vault.id, accountBefore, accountAfter, 'RollPosition', event)
}

export function handleVaultExitPostMaturity(event: VaultExitPostMaturity): void {
  let vault = getVault(event.params.vault.toHexString())
  let accountBefore = getVaultAccount(vault.id, event.params.account.toHexString())
  let accountAfter = updateVaultAccount(vault, event.params.account, event)
  setVaultTrade(vault.id, accountBefore, accountAfter, 'ExitPostMaturity', event)
}

export function handleVaultStateUpdate(event: VaultStateUpdate): void {
  let vault = getVault(event.params.vault.toHexString())
  let maturity = event.params.maturity;
  updateVaultState(vault, maturity, event);
}

export function handleVaultSecondaryBorrow(event: VaultSecondaryBorrow): void {
  let vault = getVault(event.params.vault.toHexString())
  updateVaultState(vault, event.params.maturity, event);
  updateVaultMarkets(vault, event)
  updateVaultAccount(vault, event.params.account, event);
}

export function handleVaultRepaySecondaryBorrow(event: VaultRepaySecondaryBorrow): void {
  let vault = getVault(event.params.vault.toHexString())
  updateVaultState(vault, event.params.maturity, event);
  updateVaultMarkets(vault, event)
  updateVaultAccount(vault, event.params.account, event);
}

export function handleVaultRedeemStrategyToken(event: VaultRedeemStrategyToken): void {
  let vaultAddress = event.params.vault.toHexString()
  let vaultEvent = getVaultMaturityEvent(vaultAddress, event.params.maturity.toI32(), event)
  vaultEvent.netStrategyTokenChange = event.params.strategyTokensRedeemed.neg()
  vaultEvent.netAssetCashChange = event.params.assetCashReceived
  vaultEvent.save()
}

export function handleVaultMintStrategyToken(event: VaultMintStrategyToken): void {
  let vaultAddress = event.params.vault.toHexString()
  let vaultEvent = getVaultMaturityEvent(vaultAddress, event.params.maturity.toI32(), event)
  vaultEvent.netStrategyTokenChange = event.params.strategyTokensMinted
  vaultEvent.netAssetCashChange = event.params.assetCashDeposited.neg()
  vaultEvent.save()
}

export function handleDeleverageAccount(event: VaultDeleverageAccount): void {
  let vault = getVault(event.params.vault.toHexString())
  let accountBefore = getVaultAccount(vault.id, event.params.account.toHexString())
  let accountAfter = updateVaultAccount(vault, event.params.account, event)
  setVaultTrade(vault.id, accountBefore, accountAfter, 'DeleverageAccount', event)

}

export function handleUpdateLiquidator(event: VaultLiquidatorProfit): void {
  if (event.params.transferSharesToLiquidator) {
    let vault = getVault(event.params.vault.toHexString())
    let accountBefore = getVaultAccount(vault.id, event.params.liquidator.toHexString())
    let accountAfter = updateVaultAccount(vault, event.params.liquidator, event)
    setVaultTrade(vault.id, accountBefore, accountAfter, 'TransferFromDeleverage', event)
  }
}

export function handleVaultFeeAccrued(event: VaultFeeAccrued): void {
  let vaultMaturity = getVaultMaturity(event.params.vault.toHexString(), event.params.maturity.toI32())
  vaultMaturity.totalNTokenFeesAccrued = vaultMaturity.totalNTokenFeesAccrued.plus(event.params.nTokenFee)
  vaultMaturity.totalReserveFeesAccrued = vaultMaturity.totalReserveFeesAccrued.plus(event.params.reserveFee)
  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32();
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32();
  vaultMaturity.lastUpdateBlockHash = event.block.hash;
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash;
  vaultMaturity.save()
}

export function handleVaultSettledAssetsRemaining(event: VaultSettledAssetsRemaining): void {
  let vaultMaturity = getVaultMaturity(event.params.vault.toHexString(), event.params.maturity.toI32())
  vaultMaturity.remainingSettledAssetCash = event.params.remainingAssetCash;
  vaultMaturity.remainingSettledStrategyTokens = event.params.remainingStrategyTokens;

  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32();
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32();
  vaultMaturity.lastUpdateBlockHash = event.block.hash;
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash;
  vaultMaturity.save()
}

export function handleVaultShortfall(event: VaultShortfall): void {
  let vaultMaturity = getVaultMaturity(event.params.vault.toHexString(), event.params.maturity.toI32())
  vaultMaturity.shortfall = event.params.shortfall;

  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32();
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32();
  vaultMaturity.lastUpdateBlockHash = event.block.hash;
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash;
  vaultMaturity.save()
}

export function handleVaultInsolvency(event: ProtocolInsolvency): void {
  let vaultMaturity = getVaultMaturity(event.params.vault.toHexString(), event.params.maturity.toI32())
  vaultMaturity.insolvency = event.params.shortfall

  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32();
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32();
  vaultMaturity.lastUpdateBlockHash = event.block.hash;
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash;
  vaultMaturity.save()
}

export function handleVaultSecondaryBorrowSnapshot(event: VaultSecondaryBorrowSnapshot): void {
  let vault = getVault(event.params.vault.toHexString())
  let vaultMaturity = getVaultMaturity(event.params.vault.toHexString(), event.params.maturity.toI32())
  let currencyId = event.params.currencyId.toString()
  
  let settlementSecondaryBorrowfCashSnapshot: Array<BigInt>
  let settlementSecondaryBorrowExchangeRate: Array<BigInt>
  if (vaultMaturity.settlementSecondaryBorrowfCashSnapshot == null) {
    settlementSecondaryBorrowfCashSnapshot = getZeroArray()
  } else {
    settlementSecondaryBorrowfCashSnapshot = vaultMaturity.settlementSecondaryBorrowfCashSnapshot!
  }

  if (vaultMaturity.settlementSecondaryBorrowExchangeRate == null) {
    settlementSecondaryBorrowExchangeRate = getZeroArray()
  } else {
    settlementSecondaryBorrowExchangeRate = vaultMaturity.settlementSecondaryBorrowExchangeRate!
  }

  if (vault.secondaryBorrowCurrencies != null && vault.secondaryBorrowCurrencies![0] == currencyId) {
    settlementSecondaryBorrowExchangeRate[0] = event.params.exchangeRate
    settlementSecondaryBorrowfCashSnapshot[0] = event.params.totalfCashBorrowedInPrimarySnapshot
  } else if (vault.secondaryBorrowCurrencies != null && vault.secondaryBorrowCurrencies![1] == currencyId) {
    settlementSecondaryBorrowExchangeRate[1] = event.params.exchangeRate
    settlementSecondaryBorrowfCashSnapshot[1] = event.params.totalfCashBorrowedInPrimarySnapshot
  }

  vaultMaturity.settlementSecondaryBorrowExchangeRate = settlementSecondaryBorrowExchangeRate;
  vaultMaturity.settlementSecondaryBorrowfCashSnapshot = settlementSecondaryBorrowfCashSnapshot;
  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32();
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32();
  vaultMaturity.lastUpdateBlockHash = event.block.hash;
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash;
  vaultMaturity.save()
}