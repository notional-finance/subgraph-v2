import { Address, ByteArray, ethereum, BigInt, dataSource, log } from "@graphprotocol/graph-ts"
import {
  VaultPauseStatus,
  VaultSettledAssetsRemaining,
  VaultUpdated,
  ProtocolInsolvency,
  VaultBorrowCapacityChange,
  VaultDeleverageAccount,
  VaultExitPostMaturity,
  VaultExitPreMaturity,
  VaultFeeAccrued,
  VaultLiquidatorProfit,
  VaultMintStrategyToken,
  VaultRedeemStrategyToken,
  VaultRepaySecondaryBorrow,
  VaultSecondaryBorrow,
  VaultSecondaryBorrowSnapshot,
  VaultShortfall,
  VaultStateUpdate,
  VaultUpdateSecondaryBorrowCapacity,
  VaultEnterMaturity,
  VaultDeleverageStatus,
  VaultSettled,
} from "../generated/NotionalVaults/Notional"
import {
  Notional
} from "../generated/Notional/Notional"
import { IStrategyVault } from "../generated/NotionalVaults/IStrategyVault"
import {
  LeveragedVault,
  LeveragedVaultAccount,
  LeveragedVaultCapacity,
  LeveragedVaultDirectory,
  LeveragedVaultMaturity,
  LeveragedVaultMaturityEvent,
  LeveragedVaultTrade,
  Market,
} from "../generated/schema"
import { updateMarkets } from "./markets"
import { convertAssetToUnderlyingExternal, convertInternalToUnderlyingExternal, updateAccount, updateNTokenPortfolio } from "./accounts"
import { getCashGroup, getNToken } from "./notional"
import { RATE_PRECISION, YEAR } from "./common"

function getZeroArray(): Array<BigInt> {
  let arr = new Array<BigInt>(2)
  arr[0] = BigInt.fromI32(0)
  arr[1] = BigInt.fromI32(0)
  return arr
}

export function getVaultDirectory(): LeveragedVaultDirectory {
  let entity = LeveragedVaultDirectory.load("0")
  if (entity == null) {
    entity = new LeveragedVaultDirectory("0")
    entity.listedLeveragedVaults = new Array<string>()
  }

  return entity as LeveragedVaultDirectory
}

export function getVault(id: string): LeveragedVault {
  let entity = LeveragedVault.load(id)
  if (entity == null) {
    entity = new LeveragedVault(id)
    let vaultAddress = Address.fromString(id)
    let vaultContract = IStrategyVault.bind(vaultAddress)

    // This identifier must exist in order for the UI to function properly
    let strategy = vaultContract.strategy()
    entity.strategy = strategy

    let name = vaultContract.try_name()
    if (name.reverted) {
      entity.name = "unknown"
    } else {
      entity.name = name.value
    }

    let directory = getVaultDirectory()
    let listedVaults = directory.listedLeveragedVaults
    listedVaults.push(id)
    directory.listedLeveragedVaults = listedVaults
    directory.save()
  }
  return entity as LeveragedVault
}

function getVaultAccount(vault: string, account: Address, event: ethereum.Event): LeveragedVaultAccount {
  let id = vault + ":" + account.toHexString()
  let entity = LeveragedVaultAccount.load(id)
  if (entity == null) {
    entity = new LeveragedVaultAccount(id)
    entity.leveragedVault = vault
    entity.account = account.toHexString()
    entity.vaultShares = BigInt.fromI32(0)
    entity.primaryBorrowfCash = BigInt.fromI32(0)
  }

  // The account may not exist at this point so we update it just in case
  updateAccount(account, event)

  return entity as LeveragedVaultAccount
}

function getVaultMaturity(vault: string, maturity: i32): LeveragedVaultMaturity {
  let id = vault + ":" + maturity.toString()
  let entity = LeveragedVaultMaturity.load(id)
  if (entity == null) {
    entity = new LeveragedVaultMaturity(id)
    entity.leveragedVault = vault
    entity.maturity = maturity
  }

  return entity as LeveragedVaultMaturity
}

function getVaultCapacity(vault: string): LeveragedVaultCapacity {
  let id = vault
  let entity = LeveragedVaultCapacity.load(id)
  if (entity == null) {
    entity = new LeveragedVaultCapacity(id)
    entity.leveragedVault = vault
    entity.totalUsedPrimaryBorrowCapacity = BigInt.fromI32(0)
  }

  return entity as LeveragedVaultCapacity
}

function getVaultMaturityEvent(
  vault: string,
  maturity: i32,
  event: ethereum.Event
): LeveragedVaultMaturityEvent {
  let id =
    vault +
    ":" +
    maturity.toString() +
    ":" +
    event.transaction.hash.toHexString() +
    ":" +
    event.logIndex.toString()

  let entity = new LeveragedVaultMaturityEvent(id)
  entity.leveragedVaultMaturity = vault + ":" + maturity.toString()
  entity.blockHash = event.block.hash
  entity.blockNumber = event.block.number.toI32()
  entity.timestamp = event.block.timestamp.toI32()
  entity.transactionHash = event.transaction.hash
  entity.transactionOrigin = event.transaction.from

  return entity as LeveragedVaultMaturityEvent
}

function setVaultTrade(
  vault: string,
  accountBefore: LeveragedVaultAccount,
  accountAfter: LeveragedVaultAccount,
  vaultTradeType: string,
  event: ethereum.Event,
  netBorrowedUnderlying: BigInt,
  netDepositUnderlying: BigInt
): void {
  let id =
    vault +
    ":" +
    accountBefore.maturity.toString() +
    ":" +
    accountBefore.id +
    ":" +
    event.transaction.hash.toHexString() +
    ":" +
    event.logIndex.toString()

  let entity = new LeveragedVaultTrade(id)
  entity.blockHash = event.block.hash
  entity.blockNumber = event.block.number.toI32()
  entity.timestamp = event.block.timestamp.toI32()
  entity.transactionHash = event.transaction.hash
  entity.transactionOrigin = event.transaction.from
  entity.leveragedVaultAccount = accountBefore.id
  entity.vaultTradeType = vaultTradeType
  entity.leveragedVault = vault
  entity.account = accountAfter.account

  entity.leveragedVaultMaturityBefore = accountBefore.leveragedVaultMaturity
  entity.primaryBorrowfCashBefore = accountBefore.primaryBorrowfCash
  entity.vaultSharesBefore = accountBefore.vaultShares
  entity.secondaryDebtSharesBefore = accountBefore.secondaryBorrowDebtShares

  entity.leveragedVaultMaturityAfter = accountAfter.leveragedVaultMaturity
  entity.primaryBorrowfCashAfter = accountAfter.primaryBorrowfCash
  entity.vaultSharesAfter = accountAfter.vaultShares
  entity.secondaryDebtSharesAfter = accountBefore.secondaryBorrowDebtShares

  let secondaryDebtSharesBefore: Array<BigInt>
  let secondaryDebtSharesAfter: Array<BigInt>
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

  entity.netBorrowedUnderlying = netBorrowedUnderlying;
  entity.netDepositUnderlying = netDepositUnderlying;
  entity.netUnderlyingCash = netBorrowedUnderlying.plus(netDepositUnderlying);
    

  // This logic is required to detect a maturity change via the ids
  let maturityBefore: i32 = 0
  let maturityAfter: i32 = 0
  if (accountBefore.leveragedVaultMaturity) {
    let s = accountBefore.leveragedVaultMaturity.split(":")
    if (s.length === 2) maturityBefore = parseInt(s[1], 10) as i32
  }
  if (accountAfter.leveragedVaultMaturity) {
    let s = accountAfter.leveragedVaultMaturity.split(":")
    if (s.length === 2) maturityAfter = parseInt(s[1], 10) as i32
  }

  if (
    maturityBefore === 0 ||
    maturityAfter === 0 ||
    maturityBefore === maturityAfter
  ) {
    // Only calculate net changes when the maturity is being established or exited,
    // or staying the same. When maturities change, the units on these net change
    // amounts are not the same
    entity.netPrimaryBorrowfCashChange = accountAfter.primaryBorrowfCash
      .minus(accountBefore.primaryBorrowfCash);
    entity.netVaultSharesChange = accountAfter.vaultShares.minus(accountBefore.vaultShares);

    if (entity.secondaryDebtSharesBefore != null || entity.secondaryDebtSharesAfter != null) {
      let netSecondaryDebtSharesChange = getZeroArray()
      netSecondaryDebtSharesChange[0] = secondaryDebtSharesAfter[0].minus(
        secondaryDebtSharesBefore[0]
      )
      netSecondaryDebtSharesChange[1] = secondaryDebtSharesAfter[1].minus(
        secondaryDebtSharesBefore[1]
      )
      entity.netSecondaryDebtSharesChange = netSecondaryDebtSharesChange
    }
  }

  entity.save()
}

function checkFlag(flags: ByteArray, position: u8): boolean {
  if (position < 8) {
    let mask = 2 ** position
    return (flags[0] & mask) == mask
  } else if (position < 16) {
    let mask = 2 ** position
    return (flags[1] & mask) == mask
  }

  return false
}

function getSecondaryBorrowCurrencyIndex(vault: LeveragedVault, currencyId: string): usize {
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
  let vault = getVault(event.params.vault.toHexString())
  let notional = Notional.bind(event.address)
  let vaultConfig = notional.getVaultConfig(event.params.vault)

  vault.vaultAddress = event.params.vault
  vault.primaryBorrowCurrency = vaultConfig.borrowCurrencyId.toString()
  vault.minAccountBorrowSize = vaultConfig.minAccountBorrowSize
  vault.minCollateralRatioBasisPoints = vaultConfig.minCollateralRatio.toI32()
  vault.maxDeleverageCollateralRatioBasisPoints = vaultConfig.maxDeleverageCollateralRatio.toI32()
  vault.feeRateBasisPoints = vaultConfig.feeRate.toI32()
  vault.reserveFeeSharePercent = vaultConfig.reserveFeeShare.toI32()
  vault.liquidationRatePercent = vaultConfig.liquidationRate.toI32()
  vault.maxBorrowMarketIndex = vaultConfig.maxBorrowMarketIndex.toI32()
  vault.maxRequiredAccountCollateralRatioBasisPoints = vaultConfig.maxRequiredAccountCollateralRatio.toI32()

  if (
    vaultConfig.secondaryBorrowCurrencies[0] != 0 ||
    vaultConfig.secondaryBorrowCurrencies[1] != 0
  ) {
    let secondaryBorrowCurrencies = new Array<string>(2)
    secondaryBorrowCurrencies[0] = vaultConfig.secondaryBorrowCurrencies[0].toString()
    secondaryBorrowCurrencies[1] = vaultConfig.secondaryBorrowCurrencies[1].toString()
    vault.secondaryBorrowCurrencies = secondaryBorrowCurrencies
  } else {
    vault.secondaryBorrowCurrencies = null
  }

  let flags = ByteArray.fromI32(vaultConfig.flags)
  vault.enabled = checkFlag(flags, 0)
  vault.allowRollPosition = checkFlag(flags, 1)
  vault.onlyVaultEntry = checkFlag(flags, 2)
  vault.onlyVaultExit = checkFlag(flags, 3)
  vault.onlyVaultRoll = checkFlag(flags, 4)
  vault.onlyVaultDeleverage = checkFlag(flags, 5)
  vault.onlyVaultSettle = checkFlag(flags, 6)
  vault.allowsReentrancy = checkFlag(flags, 7)
  vault.deleverageDisabled = checkFlag(flags, 8)

  vault.lastUpdateBlockNumber = event.block.number.toI32()
  vault.lastUpdateTimestamp = event.block.timestamp.toI32()
  vault.lastUpdateBlockHash = event.block.hash
  vault.lastUpdateTransactionHash = event.transaction.hash
  vault.save()

  let borrowCapacity = getVaultCapacity(vault.id)
  borrowCapacity.maxPrimaryBorrowCapacity = event.params.maxPrimaryBorrowCapacity
  borrowCapacity.lastUpdateBlockNumber = event.block.number.toI32()
  borrowCapacity.lastUpdateTimestamp = event.block.timestamp.toI32()
  borrowCapacity.lastUpdateBlockHash = event.block.hash
  borrowCapacity.lastUpdateTransactionHash = event.transaction.hash
  borrowCapacity.save()
}

export function handleVaultPauseStatus(event: VaultPauseStatus): void {
  let vault = getVault(event.params.vault.toHexString())
  vault.enabled = event.params.enabled
  vault.lastUpdateBlockNumber = event.block.number.toI32()
  vault.lastUpdateTimestamp = event.block.timestamp.toI32()
  vault.lastUpdateBlockHash = event.block.hash
  vault.lastUpdateTransactionHash = event.transaction.hash
  vault.save()
}

export function handleVaultDeleverageStatus(event: VaultDeleverageStatus): void {
  let vault = getVault(event.params.vaultAddress.toHexString())
  vault.deleverageDisabled = event.params.disableDeleverage
  vault.lastUpdateBlockNumber = event.block.number.toI32()
  vault.lastUpdateTimestamp = event.block.timestamp.toI32()
  vault.lastUpdateBlockHash = event.block.hash
  vault.lastUpdateTransactionHash = event.transaction.hash
  vault.save()
}

export function handleVaultUpdateSecondaryBorrowCapacity(
  event: VaultUpdateSecondaryBorrowCapacity
): void {
  let borrowCapacity = getVaultCapacity(event.params.vault.toHexString())
  let vault = getVault(event.params.vault.toHexString())
  let index = getSecondaryBorrowCurrencyIndex(vault, event.params.currencyId.toString())

  let maxSecondaryBorrowCapacity: Array<BigInt>
  if (borrowCapacity.maxSecondaryBorrowCapacity == null) {
    maxSecondaryBorrowCapacity = getZeroArray()
  } else {
    maxSecondaryBorrowCapacity = borrowCapacity.maxSecondaryBorrowCapacity!
  }

  if (index == 0) {
    maxSecondaryBorrowCapacity[0] = event.params.maxSecondaryBorrowCapacity
  } else if (index == 1) {
    maxSecondaryBorrowCapacity[1] = event.params.maxSecondaryBorrowCapacity
  }

  if (borrowCapacity.totalUsedSecondaryBorrowCapacity == null) {
    borrowCapacity.totalUsedSecondaryBorrowCapacity = getZeroArray()
  }

  borrowCapacity.maxSecondaryBorrowCapacity = maxSecondaryBorrowCapacity
  borrowCapacity.lastUpdateBlockNumber = event.block.number.toI32()
  borrowCapacity.lastUpdateTimestamp = event.block.timestamp.toI32()
  borrowCapacity.lastUpdateBlockHash = event.block.hash
  borrowCapacity.lastUpdateTransactionHash = event.transaction.hash
  borrowCapacity.save()
}

export function handleVaultBorrowCapacityChange(event: VaultBorrowCapacityChange): void {
  let currencyId = event.params.currencyId.toString()
  let borrowCapacity = getVaultCapacity(event.params.vault.toHexString())
  let vault = getVault(event.params.vault.toHexString())

  if (currencyId == vault.primaryBorrowCurrency) {
    borrowCapacity.totalUsedPrimaryBorrowCapacity = event.params.totalUsedBorrowCapacity
  } else {
    let index = getSecondaryBorrowCurrencyIndex(vault, currencyId)
    let totalUsedSecondaryBorrowCapacity: Array<BigInt>

    if (borrowCapacity.totalUsedSecondaryBorrowCapacity == null) {
      totalUsedSecondaryBorrowCapacity = getZeroArray()
    } else {
      totalUsedSecondaryBorrowCapacity = borrowCapacity.totalUsedSecondaryBorrowCapacity!
    }

    if (index == 0) {
      totalUsedSecondaryBorrowCapacity[0] = event.params.totalUsedBorrowCapacity
    } else if (index == 1) {
      totalUsedSecondaryBorrowCapacity[1] = event.params.totalUsedBorrowCapacity
    }
    borrowCapacity.totalUsedSecondaryBorrowCapacity = totalUsedSecondaryBorrowCapacity
  }

  borrowCapacity.lastUpdateBlockNumber = event.block.number.toI32()
  borrowCapacity.lastUpdateTimestamp = event.block.timestamp.toI32()
  borrowCapacity.lastUpdateBlockHash = event.block.hash
  borrowCapacity.lastUpdateTransactionHash = event.transaction.hash
  borrowCapacity.save()
}

function updateVaultMarkets(vault: LeveragedVault, event: ethereum.Event): string[] {
  let primaryBorrowCurrencyId = I32.parseInt(vault.primaryBorrowCurrency)
  let blockTime = event.block.timestamp.toI32()

  // Update markets and nToken to account for fees on enter
  let marketIds = updateMarkets(primaryBorrowCurrencyId, blockTime, event)

  // Update markets for secondary borrow currencies
  if (vault.secondaryBorrowCurrencies != null) {
    let currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![0])
    if (currencyId != 0) updateMarkets(currencyId, blockTime, event)

    currencyId = I32.parseInt(vault.secondaryBorrowCurrencies![1])
    if (currencyId != 0) updateMarkets(currencyId, blockTime, event)
  }

  return marketIds
}

function updateVaultAccount(
  vault: LeveragedVault,
  account: Address,
  event: ethereum.Event
): LeveragedVaultAccount {
  let vaultAccount = getVaultAccount(vault.id, account, event)
  let notional = Notional.bind(event.address)
  let vaultAddress = Address.fromBytes(vault.vaultAddress)
  let accountResult = notional.getVaultAccount(account, vaultAddress)
  vaultAccount.maturity = accountResult.maturity.toI32()
  vaultAccount.vaultShares = accountResult.vaultShares
  vaultAccount.primaryBorrowfCash = accountResult.fCash
  vaultAccount.leveragedVaultMaturity = vault.id + ":" + accountResult.maturity.toI32().toString()

  if (vault.secondaryBorrowCurrencies != null) {
    let debtShares = notional.getVaultAccountDebtShares(account, vaultAddress)
    vaultAccount.secondaryBorrowDebtShares = debtShares.value1
  }

  vaultAccount.lastUpdateBlockNumber = event.block.number.toI32()
  vaultAccount.lastUpdateTimestamp = event.block.timestamp.toI32()
  vaultAccount.lastUpdateBlockHash = event.block.hash
  vaultAccount.lastUpdateTransactionHash = event.transaction.hash
  vaultAccount.save()

  return vaultAccount
}

function updateVaultState(vault: LeveragedVault, maturity: BigInt, event: ethereum.Event): void {
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

  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32()
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32()
  vaultMaturity.lastUpdateBlockHash = event.block.hash
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash
  vaultMaturity.save()
}

export function handleVaultEnterMaturity(event: VaultEnterMaturity): void {
  let vault = getVault(event.params.vault.toHexString())
  if (event.params.account.toHexString() == vault.id) {
    // In this case it is the vault entering the maturity, don't log it. Will be
    // handled by handleVaultMintStrategyToken.
    return
  }

  let accountBefore = getVaultAccount(vault.id, event.params.account, event)
  updateVaultMarkets(vault, event)
  updateNTokenPortfolio(getNToken(vault.primaryBorrowCurrency), event, null)
  let accountAfter = updateVaultAccount(vault, event.params.account, event)

  let tradeType: string;
  if (accountBefore.maturity === accountAfter.maturity || !accountBefore.maturity) {
    tradeType = "EnterPosition"
  } else {
    tradeType = "RollPosition"
  }


  let notional = Notional.bind(event.address)
  let netBorrowedUnderlying = convertAssetToUnderlyingExternal(
    notional,
    parseInt(vault.primaryBorrowCurrency, 10) as i32,
    event.params.cashTransferToVault
  );

  // Add Account Underlying Deposit
  setVaultTrade(
    vault.id,
    accountBefore,
    accountAfter,
    tradeType,
    event,
    netBorrowedUnderlying,
    event.params.underlyingTokensDeposited
  );
}

export function handleVaultExitPreMaturity(event: VaultExitPreMaturity): void {
  let vault = getVault(event.params.vault.toHexString())
  let notional = Notional.bind(event.address)
  let accountBefore = getVaultAccount(vault.id, event.params.account, event)
  // No nToken Fee to update
  let marketIds = updateVaultMarkets(vault, event)
  let lendMarket: Market | null = null;
  let cashGroup = getCashGroup(vault.primaryBorrowCurrency)

  for (let i = 0; i < marketIds.length; i++) {
    let maturity = parseInt(marketIds[i].split(":")[2], 10);
    if (maturity === accountBefore.maturity) {
      lendMarket = Market.load(marketIds[i]);
    }
  }

  let netBorrowedUnderlying = BigInt.fromI32(0);
  if (lendMarket && cashGroup) {
    // If the lend market and cash group are defined, calculate the underlying cost to lend using the lastImpliedRate
    let lendRate = lendMarket.lastImpliedRate - cashGroup.totalFeeBasisPoints
    if (lendRate < 0) lendRate = 0
    let timeToMaturity = (accountBefore.maturity - event.block.timestamp.toI32())

    // e ^ ((-rate * timeToMaturity) / (YEAR * RATE_PRECISION))
    let term: f64 = (lendRate as f64 * timeToMaturity as f64) / (YEAR as f64 * RATE_PRECISION as f64)
    let exp = Math.floor(Math.exp(term) * RATE_PRECISION) as i64
    let netBorrowedInternal = event.params.fCashToLend.times(BigInt.fromI64(exp)).div(BigInt.fromI32(RATE_PRECISION));
    netBorrowedUnderlying = convertInternalToUnderlyingExternal(
      notional,
      parseInt(vault.primaryBorrowCurrency, 10) as i32,
      netBorrowedInternal
    ).neg();
  }

  let accountAfter = updateVaultAccount(vault, event.params.account, event)
  let netDepositUnderlying: BigInt;
  // Prior to this block on goerli, the underlyingToReceiver was not part of the event
  if (dataSource.network() === "goerli" && event.block.number.lt(BigInt.fromI32(7454321))) {
    netDepositUnderlying = BigInt.fromI32(0)
  } else {
    netDepositUnderlying = event.params.underlyingToReceiver.neg()
  }

  setVaultTrade(
    vault.id,
    accountBefore,
    accountAfter,
    "ExitPreMaturity",
    event,
    netBorrowedUnderlying,
    netDepositUnderlying
  )
}

export function handleVaultExitPostMaturity(event: VaultExitPostMaturity): void {
  let vault = getVault(event.params.vault.toHexString())
  let accountBefore = getVaultAccount(vault.id, event.params.account, event)
  let accountAfter = updateVaultAccount(vault, event.params.account, event)

  let netDepositUnderlying: BigInt;
  // Prior to this block on goerli, the underlyingToReceiver was not part of the event
  if (dataSource.network() === "goerli" && event.block.number.lt(BigInt.fromI32(7454321))) {
    netDepositUnderlying = BigInt.fromI32(0)
  } else {
    netDepositUnderlying = event.params.underlyingToReceiver.neg()
  }

  setVaultTrade(
    vault.id,
    accountBefore,
    accountAfter,
    "ExitPostMaturity",
    event,
    BigInt.fromI32(0), // no debt repaid during post maturity exit
    netDepositUnderlying,
  );

}

export function handleVaultStateUpdate(event: VaultStateUpdate): void {
  let vault = getVault(event.params.vault.toHexString())
  let maturity = event.params.maturity
  updateVaultState(vault, maturity, event)
}

export function handleVaultSecondaryBorrow(event: VaultSecondaryBorrow): void {
  let vault = getVault(event.params.vault.toHexString())
  updateVaultState(vault, event.params.maturity, event)
  updateVaultMarkets(vault, event)
  updateVaultAccount(vault, event.params.account, event)
}

export function handleVaultRepaySecondaryBorrow(event: VaultRepaySecondaryBorrow): void {
  let vault = getVault(event.params.vault.toHexString())
  updateVaultState(vault, event.params.maturity, event)
  updateVaultMarkets(vault, event)
  updateVaultAccount(vault, event.params.account, event)
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
  let accountBefore = getVaultAccount(vault.id, event.params.account, event)
  let accountAfter = updateVaultAccount(vault, event.params.account, event)

  // fCashRepaid is in internal precision, so convert to external here
  let notional = Notional.bind(event.address)
  let netBorrowedUnderlying = convertInternalToUnderlyingExternal(
    notional,
    parseInt(vault.primaryBorrowCurrency, 10) as i32,
    event.params.fCashRepaid
  );

  setVaultTrade(
    vault.id,
    accountBefore,
    accountAfter,
    "DeleverageAccount",
    event,
    netBorrowedUnderlying,
    BigInt.fromI32(0) // no net deposit on deleverage
  )
}

export function handleUpdateLiquidator(event: VaultLiquidatorProfit): void {
  if (event.params.transferSharesToLiquidator) {
    let vault = getVault(event.params.vault.toHexString())
    let accountBefore = getVaultAccount(vault.id, event.params.liquidator, event)
    let accountAfter = updateVaultAccount(vault, event.params.liquidator, event)
    // NOTE: netBorrowedUnderlying and netDepositUnderlying don't make much sense in this
    // context so we mark them as zero. The fCashRepaid in "DeleverageAccount" represents
    // what the liquidator deposited, however, that is not available on this event.
    setVaultTrade(
      vault.id,
      accountBefore,
      accountAfter,
      "TransferFromDeleverage",
      event,
      BigInt.fromI32(0),
      BigInt.fromI32(0)
    )
  }
}

export function handleVaultFeeAccrued(event: VaultFeeAccrued): void {
  let vaultMaturity = getVaultMaturity(
    event.params.vault.toHexString(),
    event.params.maturity.toI32()
  )
  vaultMaturity.totalNTokenFeesAccrued = vaultMaturity.totalNTokenFeesAccrued.plus(
    event.params.nTokenFee
  )
  vaultMaturity.totalReserveFeesAccrued = vaultMaturity.totalReserveFeesAccrued.plus(
    event.params.reserveFee
  )
  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32()
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32()
  vaultMaturity.lastUpdateBlockHash = event.block.hash
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash
  vaultMaturity.save()
}

export function handleVaultSettledAssetsRemaining(event: VaultSettledAssetsRemaining): void {
  let vaultMaturity = getVaultMaturity(
    event.params.vault.toHexString(),
    event.params.maturity.toI32()
  )
  vaultMaturity.remainingSettledAssetCash = event.params.remainingAssetCash
  vaultMaturity.remainingSettledStrategyTokens = event.params.remainingStrategyTokens

  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32()
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32()
  vaultMaturity.lastUpdateBlockHash = event.block.hash
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash
  vaultMaturity.save()
}

export function handleVaultShortfall(event: VaultShortfall): void {
  let vaultMaturity = getVaultMaturity(
    event.params.vault.toHexString(),
    event.params.maturity.toI32()
  )
  vaultMaturity.shortfall = event.params.shortfall

  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32()
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32()
  vaultMaturity.lastUpdateBlockHash = event.block.hash
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash
  vaultMaturity.save()
}

export function handleVaultInsolvency(event: ProtocolInsolvency): void {
  let vaultMaturity = getVaultMaturity(
    event.params.vault.toHexString(),
    event.params.maturity.toI32()
  )
  vaultMaturity.insolvency = event.params.shortfall

  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32()
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32()
  vaultMaturity.lastUpdateBlockHash = event.block.hash
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash
  vaultMaturity.save()
}

export function handleVaultSecondaryBorrowSnapshot(event: VaultSecondaryBorrowSnapshot): void {
  let vault = getVault(event.params.vault.toHexString())
  let vaultMaturity = getVaultMaturity(
    event.params.vault.toHexString(),
    event.params.maturity.toI32()
  )
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

  if (
    vault.secondaryBorrowCurrencies != null &&
    vault.secondaryBorrowCurrencies![0] == currencyId
  ) {
    settlementSecondaryBorrowExchangeRate[0] = event.params.exchangeRate
    settlementSecondaryBorrowfCashSnapshot[0] = event.params.totalfCashBorrowedInPrimarySnapshot
  } else if (
    vault.secondaryBorrowCurrencies != null &&
    vault.secondaryBorrowCurrencies![1] == currencyId
  ) {
    settlementSecondaryBorrowExchangeRate[1] = event.params.exchangeRate
    settlementSecondaryBorrowfCashSnapshot[1] = event.params.totalfCashBorrowedInPrimarySnapshot
  }

  vaultMaturity.settlementSecondaryBorrowExchangeRate = settlementSecondaryBorrowExchangeRate
  vaultMaturity.settlementSecondaryBorrowfCashSnapshot = settlementSecondaryBorrowfCashSnapshot
  vaultMaturity.lastUpdateBlockNumber = event.block.number.toI32()
  vaultMaturity.lastUpdateTimestamp = event.block.timestamp.toI32()
  vaultMaturity.lastUpdateBlockHash = event.block.hash
  vaultMaturity.lastUpdateTransactionHash = event.transaction.hash
  vaultMaturity.save()
}

export function handleVaultSettled(event: VaultSettled): void {
  let vault = getVault(event.params.vault.toHexString())
  updateVaultState(vault, event.params.maturity, event)
}