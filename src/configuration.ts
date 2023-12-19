import { Address, BigInt, ByteArray, Bytes } from "@graphprotocol/graph-ts";
import {
  AccountContextUpdate,
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
import { IStrategyVault } from "../generated/Configuration/IStrategyVault";
import {
  CurrencyConfiguration,
  InterestRateCurve,
  VaultConfiguration,
  WhitelistedContract,
} from "../generated/schema";
import {
  AuthorizedCallbackContract,
  BASIS_POINT,
  DetachedSecondaryIncentiveRewarder,
  GlobalTransferOperator,
  RATE_PRECISION,
  SecondaryIncentiveRewarder,
  Vault,
  ZERO_ADDRESS,
} from "./common/constants";
import {
  getAccount,
  getAsset,
  getIncentives,
  getNotional,
  getOracleRegistry,
  getUnderlying,
} from "./common/entities";
import { setActiveMarkets } from "./common/market";
import { updateVaultOracles } from "./exchange_rates";
import { updateNTokenIncentives } from "./balances";
import { readUnderlyingTokenFromNotional } from "./assets";
import { createSecondaryRewarderContext } from "./rewarder";

export function getCurrencyConfiguration(currencyId: i32): CurrencyConfiguration {
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

export function getWhitelistedContract(address: string): WhitelistedContract {
  let id = address;
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
  configuration.lastUpdateBlockNumber = event.block.number;
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
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  let underlyingToken = readUnderlyingTokenFromNotional(event.params.newCurrencyId);
  configuration.underlying = underlyingToken.toHexString();

  let notional = getNotional();
  // Set the underlying id directly here to avoid race conditions
  configuration.pCash = notional.pCashAddress(event.params.newCurrencyId).toHexString();
  let pDebtAddress = notional.pDebtAddress(event.params.newCurrencyId);
  if (pDebtAddress != ZERO_ADDRESS) {
    configuration.pDebt = pDebtAddress.toHexString();
    configuration.primeDebtAllowed = true;

    // Initializes prime cash markets
    setActiveMarkets(
      event.params.newCurrencyId,
      event.block,
      event.transaction.hash.toHexString(),
      true // skip fCash markets, this gets set on init markets
    );
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
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.primeCashHoldingsOracle = event.params.oracle;
  let oracle = PrimeCashHoldingsOracle.bind(event.params.oracle);
  configuration.primeCashHoldings = oracle.holdings().map<Bytes>((h) => h as Bytes);

  configuration.save();
}

export function handleUpdateMaxUnderlyingSupply(event: UpdateMaxUnderlyingSupply): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.maxUnderlyingSupply = event.params.maxUnderlyingSupply;
  configuration.save();
}

export function handleDeployPrimeProxy(event: PrimeProxyDeployed): void {
  if (!event.params.isCashProxy) {
    // Only check debt proxies here to set the proper currency configuration
    let configuration = getCurrencyConfiguration(event.params.currencyId);
    configuration.lastUpdateBlockNumber = event.block.number;
    configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
    configuration.lastUpdateTransactionHash = event.transaction.hash;

    configuration.pDebt = event.params.proxy.toHexString();
    configuration.primeDebtAllowed = true;
    configuration.save();
  }
}

export function handleUpdateCashGroup(event: UpdateCashGroup): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let cashGroup = notional.getCashGroup(event.params.currencyId);

  configuration.fCashRateOracleTimeWindowSeconds = cashGroup.rateOracleTimeWindow5Min * 5 * 60;
  configuration.fCashReserveFeeSharePercent = cashGroup.reserveFeeShare;
  configuration.fCashDebtBufferBasisPoints = cashGroup.debtBuffer25BPS * 25 * BASIS_POINT;
  configuration.fCashHaircutBasisPoints = cashGroup.fCashHaircut25BPS * 25 * BASIS_POINT;
  configuration.fCashLiquidationDebtBufferBasisPoints =
    cashGroup.liquidationDebtBuffer25BPS * 25 * BASIS_POINT;
  configuration.fCashLiquidationHaircutBasisPoints =
    cashGroup.liquidationfCashHaircut25BPS * 25 * BASIS_POINT;
  configuration.fCashMinOracleRate = cashGroup.minOracleRate25BPS * 25 * BASIS_POINT;
  configuration.fCashMaxOracleRate = cashGroup.maxOracleRate25BPS * 25 * BASIS_POINT;
  configuration.fCashMaxDiscountFactor =
    RATE_PRECISION.toI32() - cashGroup.maxDiscountFactor5BPS * 5 * BASIS_POINT;

  configuration.save();
}

export function handleUpdateDepositParameters(event: UpdateDepositParameters): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
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
  configuration.lastUpdateBlockNumber = event.block.number;
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
  configuration.lastUpdateBlockNumber = event.block.number;
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
  // MAX_MINT_DEVIATION_PERCENTAGE = 5;
  configuration.liquidationHaircutPercentage = parameters[0];
  configuration.cashWithholdingBufferBasisPoints = (parameters[1] as i32) * 10 * BASIS_POINT;
  configuration.residualPurchaseTimeBufferSeconds = (parameters[2] as i32) * 60;
  configuration.pvHaircutPercentage = parameters[3];
  configuration.residualPurchaseIncentiveBasisPoints = (parameters[4] as i32) * 10 * BASIS_POINT;
  if (parameters.length > 5) {
    configuration.maxMintDeviationPercentage = parameters[5] as i32;
  }

  configuration.save();
}

export function handleRebalancingTargetsUpdated(event: RebalancingTargetsUpdated): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.rebalancingTargets = event.params.targets.map<i32>((t) => t.target);
  configuration.save();
}

export function handleRebalancingCooldownUpdated(event: RebalancingCooldownUpdated): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.rebalancingCooldown = event.params.cooldownTimeInSeconds.toI32();
  configuration.save();
}

export function handleUpdatePrimeCashCurve(event: PrimeCashCurveChanged): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
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
  curve.lastUpdateBlockNumber = event.block.number;
  curve.lastUpdateTimestamp = event.block.timestamp.toI32();
  curve.lastUpdateTransactionHash = event.transaction.hash;
  curve.save();

  configuration.primeCashCurve = curve.id;
  configuration.save();
}

export function handleUpdateInterestRateCurve(event: UpdateInterestRateCurve): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let fCashCurves = notional.getInterestRateCurve(event.params.currencyId);

  let next = fCashCurves.getNextInterestRateCurve();
  let fCashNextCurves = new Array<string>();
  for (let i = 0; i < next.length; i++) {
    let curve = getInterestRateCurve(event.params.currencyId, i + 1, false);
    curve.kinkUtilization1 = next[i].kinkUtilization1.toI32();
    curve.kinkUtilization2 = next[i].kinkUtilization2.toI32();
    curve.kinkRate1 = next[i].kinkRate1.toI32();
    curve.kinkRate2 = next[i].kinkRate2.toI32();
    curve.maxRate = next[i].maxRate.toI32();
    curve.minFeeRate = next[i].minFeeRate.toI32();
    curve.maxFeeRate = next[i].maxFeeRate.toI32();
    curve.feeRatePercent = next[i].feeRatePercent.toI32();

    curve.lastUpdateBlockNumber = event.block.number;
    curve.lastUpdateTimestamp = event.block.timestamp.toI32();
    curve.lastUpdateTransactionHash = event.transaction.hash;
    curve.save();

    fCashNextCurves.push(curve.id);
  }

  configuration.fCashNextCurves = fCashNextCurves;
  configuration.save();
}

export function handleMarketsInitialized(event: MarketsInitialized): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;
  let notional = getNotional();
  let fCashCurves = notional.getInterestRateCurve(event.params.currencyId);

  let active = fCashCurves.getActiveInterestRateCurve();
  let fCashActiveCurves = new Array<string>();
  for (let i = 0; i < active.length; i++) {
    let curve = getInterestRateCurve(event.params.currencyId, i + 1, true);
    curve.kinkUtilization1 = active[i].kinkUtilization1.toI32();
    curve.kinkUtilization2 = active[i].kinkUtilization2.toI32();
    curve.kinkRate1 = active[i].kinkRate1.toI32();
    curve.kinkRate2 = active[i].kinkRate2.toI32();
    curve.maxRate = active[i].maxRate.toI32();
    curve.minFeeRate = active[i].minFeeRate.toI32();
    curve.maxFeeRate = active[i].maxFeeRate.toI32();
    curve.feeRatePercent = active[i].feeRatePercent.toI32();

    curve.lastUpdateBlockNumber = event.block.number;
    curve.lastUpdateTimestamp = event.block.timestamp.toI32();
    curve.lastUpdateTransactionHash = event.transaction.hash;
    curve.save();

    fCashActiveCurves.push(curve.id);
  }

  configuration.fCashActiveCurves = fCashActiveCurves;
  configuration.save();

  // Updates and sets the currently active markets
  setActiveMarkets(
    event.params.currencyId,
    event.block,
    event.transaction.hash.toHexString(),
    false // do not skip fCash markets
  );

  // Updates any vault oracles that have a primary borrow in this currency
  let registry = getOracleRegistry();
  for (let i = 0; i < registry.listedVaults.length; i++) {
    let vaultAddress = Address.fromBytes(registry.listedVaults[i]);
    let vaultConfig = notional.getVaultConfig(vaultAddress);
    if (vaultConfig.borrowCurrencyId == event.params.currencyId) {
      updateVaultOracles(vaultAddress, event.block);
    }
  }
}

export function handleUpdateIncentiveEmissionRate(event: UpdateIncentiveEmissionRate): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.incentiveEmissionRate = event.params.newEmissionRate;
  configuration.save();

  updateNTokenIncentives(event.params.currencyId, event);
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
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  let previousRewarder = configuration.secondaryIncentiveRewarder;
  if (event.params.rewarder == ZERO_ADDRESS) {
    configuration.secondaryIncentiveRewarder = null;
  } else {
    configuration.secondaryIncentiveRewarder = event.params.rewarder;
  }

  if (previousRewarder !== null && previousRewarder.toHexString() != ZERO_ADDRESS.toHexString()) {
    // Remove the capability
    let o = getWhitelistedContract(previousRewarder.toHexString());
    let capability = new Array<string>();
    capability.push(DetachedSecondaryIncentiveRewarder);
    o.capability = capability;
    o.lastUpdateBlockNumber = event.block.number;
    o.lastUpdateTimestamp = event.block.timestamp.toI32();
    o.lastUpdateTransactionHash = event.transaction.hash;
    o.save();
  }

  if (event.params.rewarder != ZERO_ADDRESS) {
    // Add the capability to the new rewarder
    let o = getWhitelistedContract(event.params.rewarder.toHexString());
    let capability = new Array<string>();
    capability.push(SecondaryIncentiveRewarder);
    o.capability = capability;
    o.lastUpdateBlockNumber = event.block.number;
    o.lastUpdateTimestamp = event.block.timestamp.toI32();
    o.lastUpdateTransactionHash = event.transaction.hash;
    o.currency = configuration.id;

    let op = IStrategyVault.bind(event.params.rewarder);
    let name = op.try_name();
    if (!name.reverted) {
      o.name = name.value;
    } else {
      o.name = "unknown";
    }
    o.save();

    createSecondaryRewarderContext(event.params.rewarder, event);
  }

  configuration.save();
}

export function handleReserveBufferUpdate(event: ReserveBufferUpdated): void {
  let configuration = getCurrencyConfiguration(event.params.currencyId);
  configuration.lastUpdateBlockNumber = event.block.number;
  configuration.lastUpdateTimestamp = event.block.timestamp.toI32();
  configuration.lastUpdateTransactionHash = event.transaction.hash;

  configuration.treasuryReserveBuffer = event.params.bufferAmount;
  configuration.save();
}

export function handleUpdateGlobalTransferOperator(event: UpdateGlobalTransferOperator): void {
  let operator = getWhitelistedContract(event.params.operator.toHexString());
  operator.lastUpdateBlockNumber = event.block.number;
  operator.lastUpdateTimestamp = event.block.timestamp.toI32();
  operator.lastUpdateTransactionHash = event.transaction.hash;
  let capability = operator.capability;
  operator.name = "Global Transfer Operator";

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
  let operator = getWhitelistedContract(event.params.operator.toHexString());
  operator.lastUpdateBlockNumber = event.block.number;
  operator.lastUpdateTimestamp = event.block.timestamp.toI32();
  operator.lastUpdateTransactionHash = event.transaction.hash;
  let op = IStrategyVault.bind(event.params.operator);
  let name = op.try_name();
  let capability = operator.capability;
  if (!name.reverted) {
    operator.name = name.value;
  } else {
    operator.name = "unknown";
  }

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

function getSecondaryBorrowCurrencyIndex(vault: VaultConfiguration, currencyId: i32): usize {
  if (vault.secondaryBorrowCurrencies == null) {
    return -1;
  }

  if (vault.secondaryBorrowCurrencies!.length >= 1) {
    let id = vault.secondaryBorrowCurrencies![0];
    let token = getAsset(id);
    if (token.currencyId == currencyId) return 0;
  }

  if (vault.secondaryBorrowCurrencies!.length == 2) {
    let id = vault.secondaryBorrowCurrencies![1];
    let token = getAsset(id);
    if (token.currencyId == currencyId) return 1;
  }

  return -1;
}

export function handleVaultUpdated(event: VaultUpdated): void {
  let vault = getVaultConfiguration(event.params.vault);
  let notional = getNotional();
  let vaultConfig = notional.getVaultConfig(event.params.vault);

  let vaultContract = IStrategyVault.bind(event.params.vault);
  vault.strategy = vaultContract.strategy();
  vault.name = vaultContract.name();

  vault.vaultAddress = event.params.vault;
  vault.primaryBorrowCurrency = getUnderlying(vaultConfig.borrowCurrencyId).id;
  vault.minAccountBorrowSize = vaultConfig.minAccountBorrowSize;
  vault.minCollateralRatioBasisPoints = vaultConfig.minCollateralRatio.toI32();
  vault.maxDeleverageCollateralRatioBasisPoints = vaultConfig.maxDeleverageCollateralRatio.toI32();
  vault.feeRateBasisPoints = vaultConfig.feeRate.toI32();
  vault.reserveFeeSharePercent = vaultConfig.reserveFeeShare.toI32();
  vault.liquidationRatePercent = vaultConfig.liquidationRate.toI32();
  vault.maxBorrowMarketIndex = vaultConfig.maxBorrowMarketIndex.toI32();
  vault.maxRequiredAccountCollateralRatioBasisPoints = vaultConfig.maxRequiredAccountCollateralRatio.toI32();

  if (
    vaultConfig.secondaryBorrowCurrencies[0] == 0 &&
    vaultConfig.secondaryBorrowCurrencies[1] == 0
  ) {
    vault.secondaryBorrowCurrencies = null;
  } else {
    let secondaryBorrowCurrencies = new Array<string>();
    if (vaultConfig.secondaryBorrowCurrencies[0] != 0) {
      secondaryBorrowCurrencies.push(getUnderlying(vaultConfig.secondaryBorrowCurrencies[0]).id);
    }

    if (vaultConfig.secondaryBorrowCurrencies[1] != 0) {
      secondaryBorrowCurrencies.push(getUnderlying(vaultConfig.secondaryBorrowCurrencies[1]).id);
    }

    vault.secondaryBorrowCurrencies = secondaryBorrowCurrencies;
    vault.minAccountSecondaryBorrow = vaultConfig.minAccountSecondaryBorrow;
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
  vault.discountfCash = checkFlag(flags, 9);

  vault.maxPrimaryBorrowCapacity = event.params.maxPrimaryBorrowCapacity;
  if (vault.get("totalUsedPrimaryBorrowCapacity") == null) {
    vault.totalUsedPrimaryBorrowCapacity = BigInt.fromI32(0);
  }

  vault.lastUpdateBlockNumber = event.block.number;
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();

  let account = getAccount(event.params.vault.toHexString(), event);
  account.systemAccountType = Vault;
  account.save();
}

export function handleVaultPauseStatus(event: VaultPauseStatus): void {
  let vault = getVaultConfiguration(event.params.vault);
  vault.enabled = event.params.enabled;
  vault.lastUpdateBlockNumber = event.block.number;
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}

export function handleVaultDeleverageStatus(event: VaultDeleverageStatus): void {
  let vault = getVaultConfiguration(event.params.vaultAddress);
  vault.deleverageDisabled = event.params.disableDeleverage;
  vault.lastUpdateBlockNumber = event.block.number;
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}

export function handleVaultUpdateSecondaryBorrowCapacity(
  event: VaultUpdateSecondaryBorrowCapacity
): void {
  let vault = getVaultConfiguration(event.params.vault);
  let index = getSecondaryBorrowCurrencyIndex(vault, event.params.currencyId);

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
  vault.lastUpdateBlockNumber = event.block.number;
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}

export function handleVaultBorrowCapacityChange(event: VaultBorrowCapacityChange): void {
  let currencyId = event.params.currencyId;
  let vault = getVaultConfiguration(event.params.vault);
  let primaryToken = getAsset(vault.primaryBorrowCurrency);

  if (currencyId == primaryToken.currencyId) {
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

  vault.lastUpdateBlockNumber = event.block.number;
  vault.lastUpdateTimestamp = event.block.timestamp.toI32();
  vault.lastUpdateBlockHash = event.block.hash;
  vault.lastUpdateTransactionHash = event.transaction.hash;
  vault.save();
}

export function handleAccountContextUpdate(event: AccountContextUpdate): void {
  let notional = getNotional();
  let account = getAccount(event.params.account.toHexString(), event);
  let context = notional.getAccountContext(event.params.account);

  account.allowPrimeBorrow = context.allowPrimeBorrow;
  account.nextSettleTime = context.nextSettleTime;
  account.bitmapCurrencyId = context.bitmapCurrencyId;

  let hasDebtHex = context.hasDebt.toHexString();
  if (hasDebtHex == "0x01" || hasDebtHex == "0x03") {
    account.hasPortfolioAssetDebt = true;
  } else {
    account.hasPortfolioAssetDebt = false;
  }

  if (hasDebtHex == "0x02" || hasDebtHex == "0x03") {
    account.hasCashDebt = true;
  } else {
    account.hasCashDebt = false;
  }

  account.save();
}
