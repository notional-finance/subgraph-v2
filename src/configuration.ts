import { Address, BigInt, ByteArray, Bytes } from "@graphprotocol/graph-ts";
import {
  IncentivesMigrated,
  ListCurrency,
  MarketsInitialized,
  PrimeCashCurveChanged,
  PrimeCashHoldingsOracleUpdated,
  PrimeProxyDeployed,
  RebalancingCooldownUpdated,
  RebalancingTargetsUpdated,
  ReserveBufferUpdated,
  UpdateAuthorizedCallbackContract,
  UpdateCashGroup,
  UpdateDepositParameters,
  UpdateETHRate,
  UpdateGlobalTransferOperator,
  UpdateIncentiveEmissionRate,
  UpdateInitializationParameters,
  UpdateInterestRateCurve,
  UpdateMaxUnderlyingSupply,
  UpdateSecondaryIncentiveRewarder,
  UpdateTokenCollateralParameters,
  VaultBorrowCapacityChange,
  VaultDeleverageStatus,
  VaultPauseStatus,
  VaultUpdated,
  VaultUpdateSecondaryBorrowCapacity,
} from "../generated/Configuration/Notional";
import { PrimeCashHoldingsOracle } from "../generated/Configuration/PrimeCashHoldingsOracle";
import {
  CurrencyConfiguration,
  InterestRateCurve,
  VaultConfiguration,
  WhitelistedContract,
} from "../generated/schema";
import {
  AuthorizedCallbackContract,
  BASIS_POINT,
  GlobalTransferOperator,
  ZERO_ADDRESS,
} from "./common/constants";
import { getAsset, getIncentives, getNotional } from "./common/entities";
import { setActiveMarkets } from "./common/market";

function getCurrencyConfiguration(currencyId: i32): CurrencyConfiguration {
  let id = currencyId.toString();
  let entity = CurrencyConfiguration.load(id);
  if (entity == null) {
    entity = new CurrencyConfiguration(id);
  }

  return entity as CurrencyConfiguration;
}

function getVaultConfiguration(vaultAddress: Address): VaultConfiguration {
  let id = vaultAddress.toHexString();
  let entity = VaultConfiguration.load(id);
  if (entity == null) {
    entity = new VaultConfiguration(id);
  }

  return entity as VaultConfiguration;
}

function getWhitelistedContract(address: Address): WhitelistedContract {
  let id = address.toHexString();
  let entity = WhitelistedContract.load(id);
  if (entity == null) {
    entity = new WhitelistedContract(id);
    entity.capability = new Array<string>();
  }

  return entity as WhitelistedContract;
}

function getInterestRateCurve(
  currencyId: i32,
  marketIndex: i32,
  isCurrent: boolean
): InterestRateCurve {
  let id =
    currencyId.toString() + ":" + marketIndex.toString() + ":" + (isCurrent ? "current" : "next");
  let entity = InterestRateCurve.load(id);
  if (entity == null) {
    entity = new InterestRateCurve(id);
  }

  return entity as InterestRateCurve;
}

export function handleUpdateETHRate(event: UpdateETHRate): void {
  // NOTE: during list currency this gets emitted before ListCurrency so most of the
  // fields in configuration have to be left nullable.
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  let notional = getNotional();
  let ethRate = notional.getCurrencyAndRates(event.params.currencyId).getEthRate();
  configuration.collateralHaircut = ethRate.haircut.toI32();
  configuration.debtBuffer = ethRate.buffer.toI32();
  configuration.liquidationDiscount = ethRate.liquidationDiscount.toI32();

  configuration.save();
}

export function handleListCurrency(event: ListCurrency): void {
  let configuration = getCurrencyConfiguration(event.params.newCurrencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  let notional = getNotional();
  let underlyingToken = notional.getCurrency(event.params.newCurrencyId);
  let underlyingId = underlyingToken.getUnderlyingToken().tokenAddress.toHexString();

  // Set the underlying id directly here to avoid race conditions
  configuration.underlying = underlyingId;
  configuration.pCash = notional.pCashAddress(event.params.newCurrencyId).toHexString();
  let pDebtAddress = notional.pDebtAddress(event.params.newCurrencyId);
  if (pDebtAddress != ZERO_ADDRESS) {
    configuration.pDebt = pDebtAddress.toHexString();
    configuration.primeDebtAllowed = true;
  }

  let factors = notional.getPrimeFactors(event.params.newCurrencyId, event.block.timestamp);
  let maxSupply = factors.getMaxUnderlyingSupply();
  if (maxSupply > BigInt.zero()) configuration.maxUnderlyingSupply = maxSupply;

  configuration.primeCashRateOracleTimeWindowSeconds = factors
    .getFactors()
    .rateOracleTimeWindow.toI32();
  configuration.primeCashHoldingsOracle = notional.getPrimeCashHoldingsOracle(
    event.params.newCurrencyId
  );

  let curve = getInterestRateCurve(event.params.newCurrencyId, 0, true);
  let _curve = notional.getPrimeInterestRateCurve(event.params.newCurrencyId);
  curve.kinkUtilization1 = _curve.kinkUtilization1.toI32();
  curve.kinkUtilization2 = _curve.kinkUtilization2.toI32();
  curve.kinkRate1 = _curve.kinkRate1.toI32();
  curve.kinkRate2 = _curve.kinkRate2.toI32();
  curve.maxRate = _curve.maxRate.toI32();
  curve.minFeeRate = _curve.minFeeRate.toI32();
  curve.maxFeeRate = _curve.maxFeeRate.toI32();
  curve.feeRatePercent = _curve.feeRatePercent.toI32();
  curve.save();

  configuration.primeCashCurve = curve.id;

  configuration.save();
}

export function handleUpdatePrimeCashOracle(event: PrimeCashHoldingsOracleUpdated): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.primeCashHoldingsOracle = event.params.oracle;
  let oracle = PrimeCashHoldingsOracle.bind(event.params.oracle);
  configuration.primeCashHoldings = oracle.holdings().map<Bytes>((h) => h as Bytes);

  configuration.save();
}

export function handleUpdateMaxUnderlyingSupply(event: UpdateMaxUnderlyingSupply): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.maxUnderlyingSupply = event.params.maxUnderlyingSupply;
  configuration.save();
}

export function handleDeployPrimeProxy(event: PrimeProxyDeployed): void {
  if (!event.params.isCashProxy) {
    // Only check debt proxies here to set the proper currency configuration
    let configuration = getCurrencyConfiguration(event.params.currencyId);
    configuration.lastUpdateBlockNumber = event.block.number.toI32();
    configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
    configuration.lastUpdateTransactionHash = event.transaction.hash;

    configuration.pDebt = event.params.proxy.toHexString();
    configuration.primeDebtAllowed = true;
    configuration.save();
  }
}

export function handleUpdateCashGroup(event: UpdateCashGroup): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let cashGroup = notional.getCashGroup(event.params.currencyId);

  configuration.fCashRateOracleTimeWindowSeconds = cashGroup.rateOracleTimeWindow5Min * 5 * 60;
  configuration.fCashReserveFeeSharePercent = cashGroup.reserveFeeShare;
  configuration.fCashDebtBufferBasisPoints = cashGroup.debtBuffer5BPS * 5 * BASIS_POINT;
  configuration.fCashHaircutBasisPoints = cashGroup.fCashHaircut5BPS * 5 * BASIS_POINT;
  configuration.fCashLiquidationDebtBufferBasisPoints =
    cashGroup.liquidationDebtBuffer5BPS * 5 * BASIS_POINT;
  configuration.fCashLiquidationHaircutBasisPoints =
    cashGroup.liquidationfCashHaircut5BPS * 5 * BASIS_POINT;

  configuration.save();
}

export function handleUpdateDepositParameters(event: UpdateDepositParameters): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let depositParams = notional.getDepositParameters(event.params.currencyId);

  configuration.depositShares = depositParams.getDepositShares().map<i32>((d) => d.toI32());
  configuration.leverageThresholds = depositParams
    .getLeverageThresholds()
    .map<i32>((l) => l.toI32());

  configuration.save();
}

export function handleUpdateInitializationParameters(event: UpdateInitializationParameters): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let initParams = notional.getInitializationParameters(event.params.currencyId);

  configuration.deprecated_anchorRates = initParams
    .getAnnualizedAnchorRates()
    .map<i32>((d) => d.toI32());
  configuration.proportions = initParams.getProportions().map<i32>((l) => l.toI32());

  configuration.save();
}

export function handleUpdateTokenCollateralParameters(
  event: UpdateTokenCollateralParameters
): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let nTokenAddress = notional.nTokenAddress(event.params.currencyId);
  let _parameters = notional.getNTokenAccount(nTokenAddress).getNTokenParameters();
  let parameters = ByteArray.fromHexString(_parameters.toHexString());

  // LIQUIDATION_HAIRCUT_PERCENTAGE = 0;
  // CASH_WITHHOLDING_BUFFER = 1;
  // RESIDUAL_PURCHASE_TIME_BUFFER = 2;
  // PV_HAIRCUT_PERCENTAGE = 3;
  // RESIDUAL_PURCHASE_INCENTIVE = 4;
  configuration.liquidationHaircutPercentage = parameters[0];
  configuration.cashWithholdingBufferBasisPoints = (parameters[1] as i32) * 10 * BASIS_POINT;
  configuration.residualPurchaseTimeBufferSeconds = (parameters[2] as i32) * 60;
  configuration.pvHaircutPercentage = parameters[3];
  configuration.residualPurchaseIncentiveBasisPoints = (parameters[4] as i32) * 10 * BASIS_POINT;

  configuration.save();
}

export function handleRebalancingTargetsUpdated(event: RebalancingTargetsUpdated): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.rebalancingTargets = event.params.targets.map<i32>((t) => t.target);
  configuration.save();
}

export function handleRebalancingCooldownUpdated(event: RebalancingCooldownUpdated): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.rebalancingCooldown = event.params.cooldownTimeInSeconds.toI32();
  configuration.save();
}

export function handleUpdatePrimeCashCurve(event: PrimeCashCurveChanged): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  let notional = getNotional();
  let curve = getInterestRateCurve(event.params.currencyId, 0, true);

  let _curve = notional.getPrimeInterestRateCurve(event.params.currencyId);
  curve.kinkUtilization1 = _curve.kinkUtilization1.toI32();
  curve.kinkUtilization2 = _curve.kinkUtilization2.toI32();
  curve.kinkRate1 = _curve.kinkRate1.toI32();
  curve.kinkRate2 = _curve.kinkRate2.toI32();
  curve.maxRate = _curve.maxRate.toI32();
  curve.minFeeRate = _curve.minFeeRate.toI32();
  curve.maxFeeRate = _curve.maxFeeRate.toI32();
  curve.feeRatePercent = _curve.feeRatePercent.toI32();
  curve.save();

  configuration.primeCashCurve = curve.id;
  configuration.save();
}

export function handleUpdateInterestRateCurve(event: UpdateInterestRateCurve): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let fCashCurves = notional.getInterestRateCurve(event.params.currencyId);

  let next = fCashCurves.getNextInterestRateCurve();
  let fCashNextCurves = new Array<string>();
  for (let i = 0; i < fCashNextCurves.length; i++) {
    let curve = getInterestRateCurve(event.params.currencyId, i + 1, false);
    curve.kinkUtilization1 = next[i].kinkUtilization1.toI32();
    curve.kinkUtilization2 = next[i].kinkUtilization2.toI32();
    curve.kinkRate1 = next[i].kinkRate1.toI32();
    curve.kinkRate2 = next[i].kinkRate2.toI32();
    curve.maxRate = next[i].maxRate.toI32();
    curve.minFeeRate = next[i].minFeeRate.toI32();
    curve.maxFeeRate = next[i].maxFeeRate.toI32();
    curve.feeRatePercent = next[i].feeRatePercent.toI32();
    curve.save();

    fCashNextCurves.push(curve.id);
  }

  configuration.fCashNextCurves = fCashNextCurves;
  configuration.save();
}

export function handleMarketsInitialized(event: MarketsInitialized): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let fCashCurves = notional.getInterestRateCurve(event.params.currencyId);

  let active = fCashCurves.getActiveInterestRateCurve();
  let fCashActiveCurves = new Array<string>();
  for (let i = 0; i < fCashActiveCurves.length; i++) {
    let curve = getInterestRateCurve(event.params.currencyId, i + 1, true);
    curve.kinkUtilization1 = active[i].kinkUtilization1.toI32();
    curve.kinkUtilization2 = active[i].kinkUtilization2.toI32();
    curve.kinkRate1 = active[i].kinkRate1.toI32();
    curve.kinkRate2 = active[i].kinkRate2.toI32();
    curve.maxRate = active[i].maxRate.toI32();
    curve.minFeeRate = active[i].minFeeRate.toI32();
    curve.maxFeeRate = active[i].maxFeeRate.toI32();
    curve.feeRatePercent = active[i].feeRatePercent.toI32();
    curve.save();

    fCashActiveCurves.push(curve.id);
  }

  configuration.fCashActiveCurves = fCashActiveCurves;
  configuration.save();

  // Updates and sets the currently active markets
  setActiveMarkets(event.params.currencyId, event);
}

export function handleUpdateIncentiveEmissionRate(event: UpdateIncentiveEmissionRate): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.incentiveEmissionRate = event.params.newEmissionRate;
  configuration.save();
}

export function handleIncentivesMigrated(event: IncentivesMigrated): void {
  let currencyId = event.params.currencyId as i32;
  let incentives = getIncentives(currencyId, event);
  incentives.migrationEmissionRate = event.params.migrationEmissionRate;
  incentives.migrationTime = event.params.migrationTime;
  incentives.finalIntegralTotalSupply = event.params.finalIntegralTotalSupply;
  incentives.save();
}

export function handleUpdateSecondaryIncentiveRewarder(
  event: UpdateSecondaryIncentiveRewarder
): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.secondaryIncentiveRewarder = event.params.rewarder;
  configuration.save();
}

export function handleReserveBufferUpdate(event: ReserveBufferUpdated): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number.toI32();
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.treasuryReserveBuffer = event.params.bufferAmount;
  configuration.save();
}

export function handleUpdateGlobalTransferOperator(event: UpdateGlobalTransferOperator): void {
  let operator = getWhitelistedContract(event.params.operator);
  operator.lastUpdateBlockNumber = event.block.number.toI32();
  operator.lastUpdateTimestamp = event.block.timestamp.toI32();
  operator.lastUpdateTransactionHash = event.transaction.hash;
  let capability = operator.capability;

  if (event.params.approved) {
    if (!capability.includes(GlobalTransferOperator)) capability.push(GlobalTransferOperator);
  } else {
    capability = capability.filter((c) => c != GlobalTransferOperator);
  }

  operator.capability = capability;
  operator.save();
}

export function handleUpdateAuthorizedCallbackContract(
  event: UpdateAuthorizedCallbackContract
): void {
  let operator = getWhitelistedContract(event.params.operator);
  operator.lastUpdateBlockNumber = event.block.number.toI32();
  operator.lastUpdateTimestamp = event.block.timestamp.toI32();
  operator.lastUpdateTransactionHash = event.transaction.hash;
  let capability = operator.capability;

  if (event.params.approved) {
    if (!capability.includes(AuthorizedCallbackContract))
      capability.push(AuthorizedCallbackContract);
  } else {
    capability = capability.filter((c) => c != AuthorizedCallbackContract);
  }

  operator.capability = capability;
  operator.save();
}

/*** VAULTS ***/

function checkFlag(flags: ByteArray, position: u8): boolean {
  if (position < 8) {
    let mask = 2 ** position;
    return (flags[0] & mask) == mask;
  } else if (position < 16) {
    let mask = 2 ** position;
    return (flags[1] & mask) == mask;
  }

  return false;
}

function getZeroArray(): Array<BigInt> {
  let arr = new Array<BigInt>(2);
  arr[0] = BigInt.fromI32(0);
  arr[1] = BigInt.fromI32(0);
  return arr;
}

function getSecondaryBorrowCurrencyIndex(vault: VaultConfiguration, currencyId: string): usize {
  if (vault.secondaryBorrowCurrencies == null) {
    return -1;
  } else if (
    vault.secondaryBorrowCurrencies!.length <= 2 &&
    vault.secondaryBorrowCurrencies![0] == currencyId
  ) {
    return 0;
  } else if (
    vault.secondaryBorrowCurrencies!.length <= 2 &&
    vault.secondaryBorrowCurrencies![1] == currencyId
  ) {
    return 1;
  } else {
    return -1;
  }
}

export function handleVaultUpdated(event: VaultUpdated): void {
  let vault = getVaultConfiguration(event.params.vault);
  let notional = getNotional();
  let vaultConfig = notional.getVaultConfig(event.params.vault);

  vault.vaultAddress = event.params.vault;
  vault.primaryBorrowCurrency = vaultConfig.borrowCurrencyId.toString();
  vault.minAccountBorrowSize = vaultConfig.minAccountBorrowSize;
  vault.minCollateralRatioBasisPoints = vaultConfig.minCollateralRatio.toI32();
  vault.maxDeleverageCollateralRatioBasisPoints = vaultConfig.maxDeleverageCollateralRatio.toI32();
  vault.feeRateBasisPoints = vaultConfig.feeRate.toI32();
  vault.reserveFeeSharePercent = vaultConfig.reserveFeeShare.toI32();
  vault.liquidationRatePercent = vaultConfig.liquidationRate.toI32();
  vault.maxBorrowMarketIndex = vaultConfig.maxBorrowMarketIndex.toI32();
  vault.maxRequiredAccountCollateralRatioBasisPoints = vaultConfig.maxRequiredAccountCollateralRatio.toI32();

  if (
    vaultConfig.secondaryBorrowCurrencies[0] != 0 ||
    vaultConfig.secondaryBorrowCurrencies[1] != 0
  ) {
    let secondaryBorrowCurrencies = new Array<string>(2);
    secondaryBorrowCurrencies[0] = vaultConfig.secondaryBorrowCurrencies[0].toString();
    secondaryBorrowCurrencies[1] = vaultConfig.secondaryBorrowCurrencies[1].toString();
    vault.secondaryBorrowCurrencies = secondaryBorrowCurrencies;

    vault.minAccountSecondaryBorrow = vaultConfig.minAccountSecondaryBorrow;
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
  vault.deleverageDisabled = checkFlag(flags, 8);

  vault.maxPrimaryBorrowCapacity = event.params.maxPrimaryBorrowCapacity;
  if (!isDefined(vault.totalUsedPrimaryBorrowCapacity)) {
    vault.totalUsedPrimaryBorrowCapacity = BigInt.fromI32(0);
  }

  vault.lastUpdateBlockNumber = event.block.number.toI32();
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}

export function handleVaultPauseStatus(event: VaultPauseStatus): void {
  let vault = getVaultConfiguration(event.params.vault);
  vault.enabled = event.params.enabled;
  vault.lastUpdateBlockNumber = event.block.number.toI32();
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}

export function handleVaultDeleverageStatus(event: VaultDeleverageStatus): void {
  let vault = getVaultConfiguration(event.params.vaultAddress);
  vault.deleverageDisabled = event.params.disableDeleverage;
  vault.lastUpdateBlockNumber = event.block.number.toI32();
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}

export function handleVaultUpdateSecondaryBorrowCapacity(
  event: VaultUpdateSecondaryBorrowCapacity
): void {
  let vault = getVaultConfiguration(event.params.vault);
  let index = getSecondaryBorrowCurrencyIndex(vault, event.params.currencyId.toString());

  let maxSecondaryBorrowCapacity: Array<BigInt>;
  if (vault.maxSecondaryBorrowCapacity == null) {
    maxSecondaryBorrowCapacity = getZeroArray();
  } else {
    maxSecondaryBorrowCapacity = vault.maxSecondaryBorrowCapacity!;
  }

  if (index == 0) {
    maxSecondaryBorrowCapacity[0] = event.params.maxSecondaryBorrowCapacity;
  } else if (index == 1) {
    maxSecondaryBorrowCapacity[1] = event.params.maxSecondaryBorrowCapacity;
  }

  if (vault.totalUsedSecondaryBorrowCapacity == null) {
    vault.totalUsedSecondaryBorrowCapacity = getZeroArray();
  }

  vault.maxSecondaryBorrowCapacity = maxSecondaryBorrowCapacity;
  vault.lastUpdateBlockNumber = event.block.number.toI32();
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}

export function handleVaultBorrowCapacityChange(event: VaultBorrowCapacityChange): void {
  let currencyId = event.params.currencyId.toString();
  let vault = getVaultConfiguration(event.params.vault);

  if (currencyId == vault.primaryBorrowCurrency) {
    vault.totalUsedPrimaryBorrowCapacity = event.params.totalUsedBorrowCapacity;
  } else {
    let index = getSecondaryBorrowCurrencyIndex(vault, currencyId);
    let totalUsedSecondaryBorrowCapacity: Array<BigInt>;

    if (vault.totalUsedSecondaryBorrowCapacity == null) {
      totalUsedSecondaryBorrowCapacity = getZeroArray();
    } else {
      totalUsedSecondaryBorrowCapacity = vault.totalUsedSecondaryBorrowCapacity!;
    }

    if (index == 0) {
      totalUsedSecondaryBorrowCapacity[0] = event.params.totalUsedBorrowCapacity;
    } else if (index == 1) {
      totalUsedSecondaryBorrowCapacity[1] = event.params.totalUsedBorrowCapacity;
    }
    vault.totalUsedSecondaryBorrowCapacity = totalUsedSecondaryBorrowCapacity;
  }

  vault.lastUpdateBlockNumber = event.block.number.toI32();
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}
