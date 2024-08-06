import { Address, BigInt, ByteArray, Bytes, dataSource, ethereum, log, store } from '@graphprotocol/graph-ts';
import {
  ListCurrency,
  UpdateETHRate,
  UpdateAssetRate,
  UpdateCashGroup,
  DeployNToken,
  UpdateDepositParameters,
  UpdateInitializationParameters,
  UpdateIncentiveEmissionRate,
  UpdateTokenCollateralParameters,
  UpdateGlobalTransferOperator,
  UpdateAuthorizedCallbackContract,
  Notional,
  SetSettlementRate,
  MarketsInitialized,
  AccountContextUpdate,
  AccountSettled,
  nTokenSupplyChange,
  AddRemoveLiquidity,
  SettledCashDebt,
  nTokenResidualPurchase,
  LendBorrowTrade,
  SweepCashIntoMarkets,
  UpdateMaxCollateralBalance,
  LiquidateLocalCurrency,
  LiquidateCollateralCurrency,
  LiquidatefCashEvent,
  IncentivesMigrated,
  UpdateSecondaryIncentiveRewarder,
  ReserveBalanceUpdated,
  ExcessReserveBalanceHarvested,
  TreasuryManagerChanged,
  ReserveBufferUpdated,
  TransferBatch,
  TransferSingle,
} from '../generated/Notional/Notional';
import { ERC20 } from '../generated/Notional/ERC20';

import { updateDailyLendBorrowVolume } from './utils/intervalUpdates'

import {
  Currency,
  CashGroup,
  nToken,
  GlobalTransferOperator,
  SettlementRate,
  MarketInitialization,
  Account,
  Liquidation,
  AuthorizedCallbackContract,
  NTokenPresentValueHistoricalData,
  TvlHistoricalData,
  CurrencyTvl,
  IncentiveMigration,
  SecondaryIncentiveRewarder,
} from '../generated/schema';
import { BASIS_POINTS, decodeERC1155Id, getMarketIndex, getMarketMaturityLengthSeconds, getSettlementDate, getTimeRef, getTrade, QUARTER } from './common';

import {
  getEthExchangeRate,
  getAssetExchangeRate
} from './exchange_rates/utils'

import { updateMarkets } from './markets';
import { convertAssetToUnderlying, getBalance, getNTokenChange, updateAccount, updateNTokenPortfolio } from './accounts';
import { 
  updateAssetExchangeRateHistoricalData, 
  updateEthExchangeRateHistoricalData, 
  updateMarketHistoricalData, 
  updateNTokenPresentValueHistoricalData, 
  updateTvlHistoricalData,
  updateVaultHistoricalData
} from './timeseriesUpdate';
import { getTreasury } from './treasury';

const LocalCurrency = 'LocalCurrency';
const LocalFcash = 'LocalFcash';
const CollateralCurrency = 'CollateralCurrency';
const CrossCurrencyFcash = 'CrossCurrencyFcash';

export const BI_HOURLY_BLOCK_UPDATE = 138;
export const BI_DAILY_BLOCK_UPDATE = 3300;

function getCurrency(id: string): Currency {
  let entity = Currency.load(id);
  if (entity == null) {
    entity = new Currency(id);
  }
  return entity as Currency;
}

export function getCashGroup(id: string): CashGroup {
  let entity = CashGroup.load(id);
  if (entity == null) {
    entity = new CashGroup(id);
    entity.reserveBalance = BigInt.fromI32(0);
    entity.reserveBuffer = BigInt.fromI32(0);
  }
  return entity as CashGroup;
}

export function getNToken(id: string): nToken {
  let entity = nToken.load(id);
  if (entity == null) {
    entity = new nToken(id);
  }
  return entity as nToken;
}

function getSettlementRate(currencyId: i32, maturity: i32): SettlementRate {
  let id = currencyId.toString() + ':' + maturity.toString();
  let entity = SettlementRate.load(id);
  if (entity == null) {
    entity = new SettlementRate(id);
  }
  return entity as SettlementRate;
}

function getMarketInitialization(currencyId: i32, tRef: i32): MarketInitialization {
  let id = currencyId.toString() + ':' + tRef.toString();
  let entity = MarketInitialization.load(id);
  if (entity == null) {
    entity = new MarketInitialization(id);
  }
  return entity as MarketInitialization;
}

export function getNTokenPresentValueHistoricalData(id: string): NTokenPresentValueHistoricalData {
  let entity = NTokenPresentValueHistoricalData.load(id);
  if (entity == null) {
    entity = new NTokenPresentValueHistoricalData(id);
  }
  return entity as NTokenPresentValueHistoricalData;
}

export function getTvlHistoricalData(id: string, timestamp: i32): TvlHistoricalData {
  let entity = TvlHistoricalData.load(id);
  if (entity == null) {
    entity = new TvlHistoricalData(id);
    let roundedTimestamp = (timestamp / 86400) * 86400;
    entity.timestamp = roundedTimestamp;
  }
  return entity as TvlHistoricalData;
}

export function getCurrencyTvl(id: string): CurrencyTvl {
  let entity = CurrencyTvl.load(id);
  if (entity == null) {
    entity = new CurrencyTvl(id);
  }
  return entity as CurrencyTvl;
}

export function getTokenNameAndSymbol(tokenAddress: Address): string[] {
  log.debug('Fetching token symbol and name at {}', [tokenAddress.toHexString()]);
  let erc20 = ERC20.bind(tokenAddress);
  let nameResult = erc20.try_name();
  let name: string;
  let symbol: string;
  if (nameResult.reverted) {
    name = 'unknown';
  } else {
    name = nameResult.value;
  }

  let symbolResult = erc20.try_symbol();
  if (symbolResult.reverted) {
    symbol = 'unknown';
  } else {
    symbol = symbolResult.value;
  }

  return [name, symbol];
}

function getTokenTypeString(tokenType: i32): string {
  if (tokenType == 0) return 'UnderlyingToken';
  if (tokenType == 1) return 'cToken';
  if (tokenType == 2) return 'cETH';
  if (tokenType == 3) return 'Ether';
  if (tokenType == 4) return 'NonMintable';

  return 'unknown';
}

export function handleBlockUpdates(event: ethereum.Block): void {
  handleHourlyUpdates(event);
  handleDailyUpdates(event);
}

function handleHourlyUpdates(event: ethereum.Block): void {
  if (event.number.toI32() % BI_HOURLY_BLOCK_UPDATE != 0) {
    return;
  }

  let notional = Notional.bind(dataSource.address());
  let result = notional.try_getMaxCurrencyId();
  if (result.reverted) return;
  let maxCurrencyId = result.value;

  for (let currencyId: i32 = 1; currencyId <= maxCurrencyId; currencyId++) {
    updateAssetExchangeRateHistoricalData(notional, currencyId, event.timestamp.toI32());
    updateEthExchangeRateHistoricalData(notional, currencyId, event.timestamp.toI32());
    updateNTokenPresentValueHistoricalData(notional, currencyId, event.timestamp.toI32());
    updateMarketHistoricalData(notional, currencyId, event.timestamp.toI32());
  }

  updateVaultHistoricalData(event.timestamp.toI32());
}

function handleDailyUpdates(event: ethereum.Block): void {
  if (event.number.toI32() % BI_DAILY_BLOCK_UPDATE != 0) {
    return;
  }

  let notional = Notional.bind(dataSource.address());
  let result = notional.try_getMaxCurrencyId();
  if (result.reverted) return;
  let maxCurrencyId = result.value;

  updateTvlHistoricalData(notional, maxCurrencyId, event.timestamp.toI32());
}

export function handleListCurrency(event: ListCurrency): void {
  let notional = Notional.bind(event.address);
  let results = notional.getCurrency(event.params.newCurrencyId);
  let id = event.params.newCurrencyId as i32;
  let currency = getCurrency(id.toString());

  let assetToken = results.value0;
  let underlyingToken = results.value1;

  let tokenType = assetToken.tokenType as i32;
  currency.tokenType = getTokenTypeString(tokenType);
  let assetTokenNameAndSymbol = getTokenNameAndSymbol(assetToken.tokenAddress);
  currency.name = assetTokenNameAndSymbol[0];
  currency.symbol = assetTokenNameAndSymbol[1];
  currency.tokenAddress = assetToken.tokenAddress;
  currency.decimals = assetToken.decimals;
  currency.hasTransferFee = assetToken.hasTransferFee;
  currency.maxCollateralBalance = assetToken.maxCollateralBalance;

  if (underlyingToken.tokenAddress != Address.zero()) {
    let underlyingTokenNameAndSymbol = getTokenNameAndSymbol(underlyingToken.tokenAddress);
    currency.underlyingName = underlyingTokenNameAndSymbol[0];
    currency.underlyingSymbol = underlyingTokenNameAndSymbol[1];
    currency.underlyingTokenAddress = underlyingToken.tokenAddress;
    currency.underlyingDecimals = underlyingToken.decimals;
    currency.underlyingHasTransferFee = underlyingToken.hasTransferFee;
  } else if (currency.tokenType == 'cETH') {
    currency.underlyingName = 'Ether';
    currency.underlyingSymbol = 'ETH';
    currency.underlyingDecimals = BigInt.fromI32(10).pow(18);
    currency.underlyingHasTransferFee = false;
  }

  if (currency.tokenAddress.equals(Address.fromString("0xc11b1268c1a384e55c48c2391d8d480264a3a7f4"))) {
    // There was a mistake during mainnet deployment where cWBTC1 was listed instead of cWBTC2, it was fixed
    // but there was no event emitted so we will hardcode a patch here.
    currency.tokenAddress = Address.fromString("0xccf4429db6322d5c611ee964527d42e5d685dd6a") as Bytes;
  } else if (currency.tokenAddress.equals(Address.fromString("0xed36a75a9ca4f72ad0fd8f3fb56b2c9aa8cea28d"))) {
    // On kovan there are two "DAI" tokens deployed. This token refers to the AAVE test DAI token. Renaming it here.
    currency.underlyingSymbol = 'aDAI';
  }

  currency.lastUpdateBlockNumber = event.block.number.toI32();
  currency.lastUpdateTimestamp = event.block.timestamp.toI32();
  currency.lastUpdateBlockHash = event.block.hash;
  currency.lastUpdateTransactionHash = event.transaction.hash;

  log.debug('Updated currency variables for entity {}', [currency.id]);
  currency.save();
}

export function handleUpdateMaxCollateralBalance(event: UpdateMaxCollateralBalance): void {
  let id = event.params.currencyId as i32;
  let currency = getCurrency(id.toString());
  currency.maxCollateralBalance = event.params.maxCollateralBalance
  log.debug('Updated max collateral balance on currency {}', [currency.id])
  currency.save()
}

export function handleUpdateETHRate(event: UpdateETHRate): void {
  let notional = Notional.bind(event.address);
  let results = notional.getRateStorage(event.params.currencyId);
  let ethRate = results.value0;
  let id = event.params.currencyId as i32;
  let ethExchangeRate = getEthExchangeRate(id.toString());

  ethExchangeRate.baseCurrency = ethExchangeRate.id;
  ethExchangeRate.rateOracle = ethRate.rateOracle;
  ethExchangeRate.rateDecimalPlaces = ethRate.rateDecimalPlaces;
  ethExchangeRate.mustInvert = ethRate.mustInvert;
  // This is renamed from "buffer" in the abi to prevent clashes with AssemblyScript
  // variable names
  ethExchangeRate.buffer = ethRate.rateBuffer;
  ethExchangeRate.haircut = ethRate.haircut;
  ethExchangeRate.liquidationDiscount = ethRate.liquidationDiscount;

  ethExchangeRate.lastUpdateBlockNumber = event.block.number.toI32();
  ethExchangeRate.lastUpdateTimestamp = event.block.timestamp.toI32();
  ethExchangeRate.lastUpdateBlockHash = event.block.hash;
  ethExchangeRate.lastUpdateTransactionHash = event.transaction.hash;

  log.debug('Updated ethExchangeRate variables for entity {}', [ethExchangeRate.id]);
  ethExchangeRate.save();
}

export function handleUpdateAssetRate(event: UpdateAssetRate): void {
  let notional = Notional.bind(event.address);
  let results = notional.getRateStorage(event.params.currencyId);
  let assetRate = results.value1;
  let id = event.params.currencyId as i32;
  let assetExchangeRate = getAssetExchangeRate(id.toString());

  assetExchangeRate.assetCurrency = assetExchangeRate.id;
  assetExchangeRate.rateAdapterAddress = assetRate.rateOracle;
  assetExchangeRate.underlyingDecimalPlaces = assetRate.underlyingDecimalPlaces;

  assetExchangeRate.lastUpdateBlockNumber = event.block.number.toI32();
  assetExchangeRate.lastUpdateTimestamp = event.block.timestamp.toI32();
  assetExchangeRate.lastUpdateBlockHash = event.block.hash;
  assetExchangeRate.lastUpdateTransactionHash = event.transaction.hash;

  log.debug('Updated assetExchangeRate variables for entity {}', [assetExchangeRate.id]);
  assetExchangeRate.save();
}

export function handleUpdateCashGroup(event: UpdateCashGroup): void {
  let notional = Notional.bind(event.address);
  let cashGroupResult = notional.getCashGroup(event.params.currencyId);
  let id = event.params.currencyId as i32;
  let cashGroup = getCashGroup(id.toString());

  cashGroup.currency = id.toString();
  cashGroup.maxMarketIndex = cashGroupResult.maxMarketIndex;
  cashGroup.maxMarketMaturityLengthSeconds = getMarketMaturityLengthSeconds(cashGroupResult.maxMarketIndex);
  cashGroup.rateOracleTimeWindowSeconds = cashGroupResult.rateOracleTimeWindow5Min * 300;
  cashGroup.totalFeeBasisPoints = cashGroupResult.totalFeeBPS * BASIS_POINTS;
  cashGroup.reserveFeeSharePercent = cashGroupResult.reserveFeeShare;
  cashGroup.debtBufferBasisPoints = cashGroupResult.debtBuffer5BPS * 5 * BASIS_POINTS;
  cashGroup.fCashHaircutBasisPoints = cashGroupResult.fCashHaircut5BPS * 5 * BASIS_POINTS;
  cashGroup.settlementPenaltyRateBasisPoints = cashGroupResult.settlementPenaltyRate5BPS * 5 * BASIS_POINTS;
  cashGroup.liquidationfCashHaircutBasisPoints = cashGroupResult.liquidationfCashHaircut5BPS * 5 * BASIS_POINTS;
  cashGroup.liquidationDebtBufferBasisPoints = cashGroupResult.liquidationDebtBuffer5BPS * 5 * BASIS_POINTS;

  let liquidityTokenHaircutsPercent = new Array<i32>();
  let haircuts = cashGroupResult.liquidityTokenHaircuts;
  for (let i: i32 = 0; i < cashGroupResult.liquidityTokenHaircuts.length; i++) {
    liquidityTokenHaircutsPercent.push(haircuts[i]);
  }
  cashGroup.liquidityTokenHaircutsPercent = liquidityTokenHaircutsPercent;

  let rateScalars = new Array<i32>();
  let scalars = cashGroupResult.rateScalars;
  for (let i: i32 = 0; i < cashGroupResult.rateScalars.length; i++) {
    // Rate scalars are multiplied by RATE_PRECISION inside the contract
    rateScalars.push(scalars[i]);
  }
  cashGroup.rateScalars = rateScalars;

  cashGroup.lastUpdateBlockNumber = event.block.number.toI32();
  cashGroup.lastUpdateTimestamp = event.block.timestamp.toI32();
  cashGroup.lastUpdateBlockHash = event.block.hash;
  cashGroup.lastUpdateTransactionHash = event.transaction.hash;

  log.debug('Updated cashGroup variables for entity {}', [cashGroup.id]);
  cashGroup.save();
}

export function handleDeployNToken(event: DeployNToken): void {
  let id = event.params.currencyId as i32;
  let nTokenEntity = getNToken(id.toString());
  let symbolAndName = getTokenNameAndSymbol(event.params.nTokenAddress);

  nTokenEntity.cashGroup = nTokenEntity.id;
  nTokenEntity.currency = nTokenEntity.id;
  nTokenEntity.tokenAddress = event.params.nTokenAddress;
  nTokenEntity.name = symbolAndName[0];
  nTokenEntity.symbol = symbolAndName[1];
  nTokenEntity.decimals = BigInt.fromI32(10).pow(8);
  nTokenEntity.totalSupply = BigInt.fromI32(0);
  nTokenEntity.integralTotalSupply = BigInt.fromI32(0);
  nTokenEntity.lastSupplyChangeTime = BigInt.fromI32(0);
  nTokenEntity.depositShares = [];
  nTokenEntity.leverageThresholds = [];
  nTokenEntity.annualizedAnchorRates = [];
  nTokenEntity.proportions = [];

  nTokenEntity.lastUpdateBlockNumber = event.block.number.toI32();
  nTokenEntity.lastUpdateTimestamp = event.block.timestamp.toI32();
  nTokenEntity.lastUpdateBlockHash = event.block.hash;
  nTokenEntity.lastUpdateTransactionHash = event.transaction.hash;
  log.debug('Updated nToken variables for entity {}', [nTokenEntity.id]);
  nTokenEntity.save();

  // Creates the nToken account entity that holds the balances and asset for the nToken
  let nTokenAccount = new Account(event.params.nTokenAddress.toHexString());
  nTokenAccount.nextSettleTime = BigInt.fromI32(0);
  nTokenAccount.hasPortfolioAssetDebt = false;
  nTokenAccount.hasCashDebt = false;
  nTokenAccount.assetBitmapCurrency = id.toString();

  // Ensure that a balance object exists
  let balance = getBalance(event.params.nTokenAddress.toHexString(), id.toString());
  balance.lastUpdateBlockNumber = event.block.number.toI32();
  balance.lastUpdateTimestamp = event.block.timestamp.toI32();
  balance.lastUpdateBlockHash = event.block.hash;
  balance.lastUpdateTransactionHash = event.transaction.hash;
  balance.save();

  let balanceArray = new Array<string>();
  balanceArray.push(balance.id);
  nTokenAccount.balances = balanceArray;

  nTokenAccount.portfolio = [];
  nTokenAccount.nToken = nTokenEntity.id;

  nTokenAccount.lastUpdateBlockNumber = event.block.number.toI32();
  nTokenAccount.lastUpdateTimestamp = event.block.timestamp.toI32();
  nTokenAccount.lastUpdateBlockHash = event.block.hash;
  nTokenAccount.lastUpdateTransactionHash = event.transaction.hash;
  log.debug('Updated nToken account for entity {}', [nTokenAccount.id]);
  nTokenAccount.save();
}

export function handleUpdateDepositParameters(event: UpdateDepositParameters): void {
  let notional = Notional.bind(event.address);
  let depositParameterResult = notional.getDepositParameters(event.params.currencyId);
  let id = event.params.currencyId as i32;
  let nTokenEntity = getNToken(id.toString());

  let depositShares = new Array<i32>();
  let shares = depositParameterResult.value0;
  for (let i: i32 = 0; i < shares.length; i++) {
    depositShares.push(shares[i].toI32());
  }
  nTokenEntity.depositShares = depositShares;

  let leverageThresholds = new Array<i32>();
  let thresholds = depositParameterResult.value1;
  for (let i: i32 = 0; i < thresholds.length; i++) {
    leverageThresholds.push(thresholds[i].toI32());
  }
  nTokenEntity.leverageThresholds = leverageThresholds;

  nTokenEntity.lastUpdateBlockNumber = event.block.number.toI32();
  nTokenEntity.lastUpdateTimestamp = event.block.timestamp.toI32();
  nTokenEntity.lastUpdateBlockHash = event.block.hash;
  nTokenEntity.lastUpdateTransactionHash = event.transaction.hash;
  log.debug('Updated nToken deposit parameters for entity {}', [nTokenEntity.id]);
  nTokenEntity.save();
}

export function handleUpdateInitializationParameters(event: UpdateInitializationParameters): void {
  let notional = Notional.bind(event.address);
  let tryInitParameterResult = notional.try_getInitializationParameters(event.params.currencyId);
  // There was an error on Kovan that caused this to revert when set to zero. Init parameters cannot
  // be set to zero so this will in effect skip that block. This is the proposal in question:
  // https://kovan.etherscan.io/tx/0x9c059b46e74ca0310c3fa6cde1439461f4bc1e86a091e335246e6df55c087bae
  if (tryInitParameterResult.reverted) return;
  let initParameterResult = tryInitParameterResult.value

  let id = event.params.currencyId as i32;
  let nTokenEntity = getNToken(id.toString());

  let annualizedAnchorRates = new Array<i32>();
  let anchors = initParameterResult.value0;
  for (let i: i32 = 0; i < anchors.length; i++) {
    annualizedAnchorRates.push(anchors[i].toI32());
  }
  nTokenEntity.annualizedAnchorRates = annualizedAnchorRates;

  let proportions = new Array<i32>();
  let result = initParameterResult.value1;
  for (let i: i32 = 0; i < result.length; i++) {
    proportions.push(result[i].toI32());
  }
  nTokenEntity.proportions = proportions;

  nTokenEntity.lastUpdateBlockNumber = event.block.number.toI32();
  nTokenEntity.lastUpdateTimestamp = event.block.timestamp.toI32();
  nTokenEntity.lastUpdateBlockHash = event.block.hash;
  nTokenEntity.lastUpdateTransactionHash = event.transaction.hash;
  log.debug('Updated nToken init parameters for entity {}', [nTokenEntity.id]);
  nTokenEntity.save();
}

export function handleUpdateIncentiveEmissionRate(event: UpdateIncentiveEmissionRate): void {
  let notional = Notional.bind(event.address);
  let id = event.params.currencyId as i32;
  let nTokenEntity = getNToken(id.toString());
  let nTokenAccountResult = notional.getNTokenAccount(Address.fromBytes(nTokenEntity.tokenAddress));

  // When incentives change, the nToken accumulated NOTE also changes to bring the values up to date
  let nTokenChangeObject = getNTokenChange(nTokenEntity, event);
  nTokenChangeObject.accumulatedNOTEPerNTokenAfter = nTokenAccountResult.value6
  nTokenChangeObject.lastSupplyChangeTimeAfter = nTokenAccountResult.value7
  nTokenChangeObject.save()

  // This is saved as uint32 on chain
  nTokenEntity.incentiveEmissionRate = nTokenAccountResult.value2.times(BigInt.fromI32(10).pow(8));
  nTokenEntity.accumulatedNOTEPerNToken = nTokenAccountResult.value6;
  nTokenEntity.lastSupplyChangeTime = nTokenAccountResult.value7;

  nTokenEntity.lastUpdateBlockNumber = event.block.number.toI32();
  nTokenEntity.lastUpdateTimestamp = event.block.timestamp.toI32();
  nTokenEntity.lastUpdateBlockHash = event.block.hash;
  nTokenEntity.lastUpdateTransactionHash = event.transaction.hash;
  log.debug('Updated nToken incentive emission rate for entity {}', [nTokenEntity.id]);
  nTokenEntity.save();
}

export function handleUpdateTokenCollateralParameters(event: UpdateTokenCollateralParameters): void {
  let notional = Notional.bind(event.address);
  let id = event.params.currencyId as i32;
  let nTokenEntity = getNToken(id.toString());
  let nTokenAccountResult = notional.getNTokenAccount(Address.fromBytes(nTokenEntity.tokenAddress));
  let parameters = ByteArray.fromHexString(nTokenAccountResult.value4.toHexString());

  // LIQUIDATION_HAIRCUT_PERCENTAGE = 0;
  // CASH_WITHHOLDING_BUFFER = 1;
  // RESIDUAL_PURCHASE_TIME_BUFFER = 2;
  // PV_HAIRCUT_PERCENTAGE = 3;
  // RESIDUAL_PURCHASE_INCENTIVE = 4;
  nTokenEntity.liquidationHaircutPercentage = parameters[0];
  nTokenEntity.cashWithholdingBufferBasisPoints = (parameters[1] as i32) * 10 * BASIS_POINTS;
  let bufferHours = parameters[2] as i32;
  nTokenEntity.residualPurchaseTimeBufferSeconds = bufferHours * 60;
  nTokenEntity.pvHaircutPercentage = parameters[3];
  nTokenEntity.residualPurchaseIncentiveBasisPoints = (parameters[4] as i32) * 10 * BASIS_POINTS;

  nTokenEntity.lastUpdateBlockNumber = event.block.number.toI32();
  nTokenEntity.lastUpdateTimestamp = event.block.timestamp.toI32();
  nTokenEntity.lastUpdateBlockHash = event.block.hash;
  nTokenEntity.lastUpdateTransactionHash = event.transaction.hash;
  log.debug('Updated nToken collateral parameters for entity {}', [nTokenEntity.id]);
  nTokenEntity.save();
}

export function handleUpdateGlobalTransferOperator(event: UpdateGlobalTransferOperator): void {
  let operator = GlobalTransferOperator.load(event.params.operator.toHexString());

  if (event.params.approved && operator == null) {
    operator = new GlobalTransferOperator(event.params.operator.toHexString());
    operator.lastUpdateBlockNumber = event.block.number.toI32();
    operator.lastUpdateTimestamp = event.block.timestamp.toI32();
    operator.lastUpdateBlockHash = event.block.hash;
    operator.lastUpdateTransactionHash = event.transaction.hash;
    log.debug('Created global transfer operator {}', [operator.id]);
    operator.save();
  } else if (!event.params.approved && operator != null) {
    log.debug('Deleted global transfer operator {}', [operator.id]);
    store.remove('GlobalTransferOperator', event.params.operator.toHexString());
  }
}

export function handleUpdateAuthorizedCallbackContract(event: UpdateAuthorizedCallbackContract): void {
  let operator = AuthorizedCallbackContract.load(event.params.operator.toHexString());
  if (event.params.approved && operator == null) {
    operator = new AuthorizedCallbackContract(event.params.operator.toHexString());
    operator.name = getTokenNameAndSymbol(event.params.operator)[0];
    operator.lastUpdateBlockNumber = event.block.number.toI32();
    operator.lastUpdateTimestamp = event.block.timestamp.toI32();
    operator.lastUpdateBlockHash = event.block.hash;
    operator.lastUpdateTransactionHash = event.transaction.hash;
    log.debug('Created authorized callback contract {}', [operator.id]);
    operator.save();
  } else if (!event.params.approved && operator != null) {
    log.debug('Deleted authorized callback contract {}', [operator.id]);
    store.remove('AuthorizedCallbackContract', event.params.operator.toHexString());
  }
}

export function handleUpdateSecondaryIncentiveRewarder(event: UpdateSecondaryIncentiveRewarder): void {
  let currencyId = event.params.currencyId as i32;
  if (event.params.rewarder == Address.zero()) {
    log.debug('Deleted secondary incentive rewarder {}', [currencyId.toString()]);
    store.remove('SecondaryIncentiveRewarder', currencyId.toString());
  } else {
    let rewarder = new SecondaryIncentiveRewarder(currencyId.toString());
    rewarder.currency = currencyId.toString();
    rewarder.nToken = currencyId.toString();
    rewarder.lastUpdateBlockNumber = event.block.number.toI32();
    rewarder.lastUpdateTimestamp = event.block.timestamp.toI32();
    rewarder.lastUpdateBlockHash = event.block.hash;
    rewarder.lastUpdateTransactionHash = event.transaction.hash;
    log.debug('Created secondary rewarder callback contract {}', [rewarder.id]);
    rewarder.save();
  }
}

export function handleSetSettlementRate(event: SetSettlementRate): void {
  let currencyId = event.params.currencyId.toI32();
  let maturity = event.params.maturity.toI32();
  let settlementRate = getSettlementRate(currencyId, maturity);

  // Deletes settlement rates from the Notional V21 fix
  if (event.params.rate.isZero() && (maturity == 1648512000 || maturity == 1664064000)) {
    store.remove('SettlementRate', settlementRate.id)
  }

  settlementRate.currency = currencyId.toString();
  settlementRate.assetExchangeRate = currencyId.toString();
  settlementRate.maturity = maturity;
  settlementRate.rate = event.params.rate;

  settlementRate.lastUpdateBlockNumber = event.block.number.toI32();
  settlementRate.lastUpdateTimestamp = event.block.timestamp.toI32();
  settlementRate.lastUpdateBlockHash = event.block.hash;
  settlementRate.lastUpdateTransactionHash = event.transaction.hash;
  log.debug('Created settlement rate {}', [settlementRate.id]);
  settlementRate.save();
}

export function handleMarketsInitialized(event: MarketsInitialized): void {
  let currencyId = event.params.currencyId as i32;
  let tRef = getTimeRef(event.block.timestamp.toI32());
  let marketInitialization = getMarketInitialization(currencyId, tRef);

  marketInitialization.currency = currencyId.toString();
  marketInitialization.markets = updateMarkets(currencyId, tRef, event);

  marketInitialization.blockNumber = event.block.number.toI32();
  marketInitialization.timestamp = event.block.timestamp.toI32();
  marketInitialization.blockHash = event.block.hash;
  marketInitialization.transactionHash = event.transaction.hash;
  marketInitialization.transactionOrigin = event.transaction.from;

  log.debug('Markets initialized {}', [marketInitialization.id]);
  marketInitialization.save();

  let nToken = getNToken(currencyId.toString());
  updateNTokenPortfolio(nToken, event, null);
}

export function handleSweepCashIntoMarkets(event: SweepCashIntoMarkets): void {
  let currencyId = event.params.currencyId as i32;
  let tRef = getTimeRef(event.block.timestamp.toI32());
  let nToken = getNToken(currencyId.toString());
  updateNTokenPortfolio(nToken, event, null);
  updateMarkets(currencyId, tRef, event);
}

export function handleAccountContextUpdate(event: AccountContextUpdate): void {
  updateAccount(event.params.account, event);
}

export function handleAccountSettled(event: AccountSettled): void {
  updateAccount(event.params.account, event);
}

export function handleNTokenSupplyChange(event: nTokenSupplyChange): void {
  let currencyId = event.params.currencyId;
  let tRef = getTimeRef(event.block.timestamp.toI32());
  let nToken = getNToken(currencyId.toString());
  updateNTokenPortfolio(nToken, event, event.params.account);
  updateMarkets(currencyId, tRef, event);
}

export function handleLendBorrowTrade(event: LendBorrowTrade): void {
  updateMarkets(event.params.currencyId, event.block.timestamp.toI32(), event);
  let notional = Notional.bind(event.address);

  let currencyId = event.params.currencyId as i32;
  let trade = getTrade(currencyId, event.params.account, event, 0);

  let maturity = event.params.maturity;
  let marketIndex = getMarketIndex(maturity, event.block.timestamp)
  let settlementDate = getSettlementDate(maturity, marketIndex);
  trade.market = currencyId.toString() + ':' + settlementDate.toString() + ':' + maturity.toString();

  if (event.params.netAssetCash.gt(BigInt.fromI32(0))) {
    trade.tradeType = 'Borrow';
  } else {
    trade.tradeType = 'Lend';
  }

  trade.netAssetCash = event.params.netAssetCash;
  trade.netUnderlyingCash = convertAssetToUnderlying(notional, currencyId, trade.netAssetCash);
  trade.netfCash = event.params.netfCash;
  trade.maturity = maturity;

  updateDailyLendBorrowVolume(event)

  trade.save();
  log.debug('Logged lend borrow trade event at {}', [trade.id]);
}

export function handleAddRemoveLiquidity(event: AddRemoveLiquidity): void {
  updateMarkets(event.params.currencyId, event.block.timestamp.toI32(), event);
  let notional = Notional.bind(event.address);

  let currencyId = event.params.currencyId as i32;
  let trade = getTrade(currencyId, event.params.account, event, 0);

  let maturity = event.params.maturity;
  let marketIndex = getMarketIndex(maturity, event.block.timestamp)
  let settlementDate = getSettlementDate(maturity, marketIndex);
  trade.market = currencyId.toString() + ':' + settlementDate.toString() + ':' + maturity.toString();

  if (event.params.netLiquidityTokens.gt(BigInt.fromI32(0))) {
    trade.tradeType = 'AddLiquidity';
  } else {
    trade.tradeType = 'RemoveLiquidity';
  }

  trade.netAssetCash = event.params.netAssetCash;
  trade.netUnderlyingCash = convertAssetToUnderlying(notional, currencyId, trade.netAssetCash);
  trade.netfCash = event.params.netfCash;
  trade.netLiquidityTokens = event.params.netLiquidityTokens;
  trade.maturity = maturity;
  trade.save();
  log.debug('Logged add remove liquidity trade event at {}', [trade.id]);
}

export function handleSettledCashDebt(event: SettledCashDebt): void {
  updateMarkets(event.params.currencyId, event.block.timestamp.toI32(), event);
  let notional = Notional.bind(event.address);

  let currencyId = event.params.currencyId as i32;
  // Settle cash debt happens at the 3 month maturity
  let maturity = BigInt.fromI32(getTimeRef(event.block.timestamp.toI32()) + QUARTER);
  let tradeSettledAccount = getTrade(currencyId, event.params.settledAccount, event, 0);
  tradeSettledAccount.tradeType = 'SettleCashDebt';
  tradeSettledAccount.netAssetCash = event.params.amountToSettleAsset;
  tradeSettledAccount.netUnderlyingCash = convertAssetToUnderlying(notional, currencyId, tradeSettledAccount.netAssetCash);
  tradeSettledAccount.netfCash = event.params.fCashAmount;
  tradeSettledAccount.maturity = maturity;
  tradeSettledAccount.save();

  let tradeSettler = getTrade(currencyId, event.params.settler, event, 0);
  tradeSettler.tradeType = 'SettleCashDebt';
  tradeSettler.netAssetCash = event.params.amountToSettleAsset.neg();
  tradeSettler.netUnderlyingCash = convertAssetToUnderlying(notional, currencyId, tradeSettler.netAssetCash);
  tradeSettler.netfCash = event.params.fCashAmount.neg();
  tradeSettler.maturity = maturity;
  tradeSettler.save();

  log.debug('Logged settled cash debt trade event at {} and {}', [tradeSettledAccount.id, tradeSettler.id]);
}

export function handleNTokenResidualPurchase(event: nTokenResidualPurchase): void {
  updateMarkets(event.params.currencyId, event.block.timestamp.toI32(), event);
  let notional = Notional.bind(event.address);

  let nToken = getNToken(event.params.currencyId.toString());
  updateNTokenPortfolio(nToken, event, null);

  let currencyId = event.params.currencyId as i32;
  let nTokenAddress = notional.nTokenAddress(currencyId);
  let tradeNToken = getTrade(currencyId, nTokenAddress, event, 0);
  tradeNToken.tradeType = 'PurchaseNTokenResidual';
  tradeNToken.netAssetCash = event.params.netAssetCashNToken;
  tradeNToken.netUnderlyingCash = convertAssetToUnderlying(notional, currencyId, tradeNToken.netAssetCash);
  tradeNToken.netfCash = event.params.fCashAmountToPurchase;
  tradeNToken.maturity = event.params.maturity;
  tradeNToken.save();

  let tradePurchaser = getTrade(currencyId, event.params.purchaser, event, 0);
  tradePurchaser.tradeType = 'PurchaseNTokenResidual';
  tradePurchaser.netAssetCash = event.params.netAssetCashNToken.neg();
  tradePurchaser.netUnderlyingCash = convertAssetToUnderlying(notional, currencyId, tradePurchaser.netAssetCash);
  tradePurchaser.netfCash = event.params.fCashAmountToPurchase.neg();
  tradePurchaser.maturity = event.params.maturity;
  tradePurchaser.save();

  log.debug('Logged nToken residual purchase trade event at {}', [tradeNToken.id, tradePurchaser.id]);
}

function getLiquidation(event: ethereum.Event): Liquidation {
  let id =
    event.transaction.hash.toHexString() +
    ':' +
    event.logIndex.toString();
  let liq = new Liquidation(id);
  liq.blockHash = event.block.hash;
  liq.blockNumber = event.block.number.toI32();
  liq.timestamp = event.block.timestamp.toI32();
  liq.transactionHash = event.transaction.hash;
  liq.transactionOrigin = event.transaction.from;

  return liq;
}

export function handleLiquidateLocalCurrency(event: LiquidateLocalCurrency): void {
  let liq = getLiquidation(event);

  liq.type = LocalCurrency;
  liq.account = event.params.liquidated.toHexString();
  liq.liquidator = event.params.liquidator.toHexString();
  let localId = event.params.localCurrencyId as i32;
  liq.localCurrency = localId.toString();
  liq.netLocalFromLiquidator = event.params.netLocalFromLiquidator;
  liq.save();

  log.debug('Logged liquidate collateral currency event at {}', [liq.id]);
}

export function handleLiquidateCollateralCurrency(event: LiquidateCollateralCurrency): void {
  let liq = getLiquidation(event);

  liq.type = CollateralCurrency;
  liq.account = event.params.liquidated.toHexString();
  liq.liquidator = event.params.liquidator.toHexString();
  let localId = event.params.localCurrencyId as i32;
  liq.localCurrency = localId.toString();
  let collateralId = event.params.collateralCurrencyId as i32;
  liq.collateralOrFcashCurrency = collateralId.toString();
  liq.netCollateralTransfer = event.params.netCollateralTransfer;
  liq.netLocalFromLiquidator = event.params.netLocalFromLiquidator;
  liq.netNTokenTransfer = event.params.netNTokenTransfer;
  liq.save();

  log.debug('Logged liquidate local currency event at {}', [liq.id]);
}

export function handleLiquidatefCash(event: LiquidatefCashEvent): void {
  let liq = getLiquidation(event);

  if (event.params.localCurrencyId == event.params.fCashCurrency) {
    liq.type = LocalFcash;
  } else {
    liq.type = CrossCurrencyFcash;
  }

  liq.account = event.params.liquidated.toHexString();
  liq.liquidator = event.params.liquidator.toHexString();
  let localId = event.params.localCurrencyId as i32;
  liq.localCurrency = localId.toString();
  let fcashId = event.params.fCashCurrency as i32;
  liq.collateralOrFcashCurrency = fcashId.toString();
  liq.netLocalFromLiquidator = event.params.netLocalFromLiquidator;
  liq.fCashMaturities = event.params.fCashMaturities;
  liq.fCashNotionalTransfer = event.params.fCashNotionalTransfer;
  liq.save();

  log.debug('Logged liquidate fcash event at {}', [liq.id]);
}

export function handleIncentivesMigrated(event: IncentivesMigrated): void {
  let currencyId = event.params.currencyId as i32;
  let migration = new IncentiveMigration(currencyId.toString())
  migration.currency = currencyId.toString();
  migration.migrationEmissionRate = event.params.migrationEmissionRate;
  migration.migrationTime = event.params.migrationTime;
  migration.finalIntegralTotalSupply = event.params.finalIntegralTotalSupply;
  migration.save();

  let nToken = getNToken(currencyId.toString());
  // Update these parameters to the snapshot
  nToken.integralTotalSupply = migration.finalIntegralTotalSupply;
  nToken.lastSupplyChangeTime = migration.migrationTime;
  nToken.save();

  log.debug('Logged incentive migration event event at {}', [migration.id]);
}

/* Reserve balances are updated in updateMarkets, here we just handle treasury manager actions */
export function handleReserveBalanceUpdated(event: ReserveBalanceUpdated): void {
  let currencyId = event.params.currencyId as i32;
  let cashGroup = getCashGroup(currencyId.toString())
  cashGroup.reserveBalance = event.params.newBalance;
  cashGroup.save();
  log.debug('Reserve balance updated in cash group', [cashGroup.id]);
}

export function handleExcessReserveBalanceHarvested(event: ExcessReserveBalanceHarvested): void {
  let currencyId = event.params.currencyId as i32;
  let cashGroup = getCashGroup(currencyId.toString())
  cashGroup.reserveBalance = cashGroup.reserveBalance.minus(event.params.harvestAmount)
  cashGroup.save();
  log.debug('Reserve balance updated in cash group', [cashGroup.id]);
}

export function handleTreasuryManagerChanged(event: TreasuryManagerChanged): void {
  let treasury = getTreasury(event.params.newManager)
  treasury.lastUpdateBlockNumber = event.block.number.toI32();
  treasury.lastUpdateTimestamp = event.block.timestamp.toI32();
  treasury.lastUpdateBlockHash = event.block.hash;
  treasury.lastUpdateTransactionHash = event.transaction.hash;
  treasury.save()
  log.debug('Updated treasury manager address', []);
}

export function handleReserveBufferUpdated(event: ReserveBufferUpdated): void {
  let currencyId = event.params.currencyId as i32;
  let cashGroup = getCashGroup(currencyId.toString())
  cashGroup.reserveBuffer = event.params.bufferAmount;
  cashGroup.save();
  log.debug('Reserve buffer updated in cash group', [cashGroup.id]);
}

function logERC1155Transfer(
  from: Address,
  to: Address,
  operator: Address,
  id: BigInt,
  value: BigInt,
  event: ethereum.Event,
  batchIndex: i32
): void {
  let decoded = decodeERC1155Id(id)
  let currencyId = decoded[2]
  let assetType = decoded[0].toI32()
  let sender = getTrade(currencyId.toI32(), from, event, batchIndex);
  let receiver = getTrade(currencyId.toI32(), to, event, batchIndex);

  sender.tradeType = "Transfer"
  sender.maturity = decoded[1]
  sender.netAssetCash = BigInt.fromI32(0)
  sender.transferOperator = operator;

  receiver.tradeType = "Transfer"
  receiver.maturity = decoded[1]
  receiver.netAssetCash = BigInt.fromI32(0)
  receiver.transferOperator = operator;

  if (assetType == 1) {
    sender.netfCash = value.neg()
    receiver.netfCash = value
  } else {
    sender.netfCash = BigInt.fromI32(0)
    receiver.netfCash = BigInt.fromI32(0)
    sender.netLiquidityTokens = value.neg()
    receiver.netLiquidityTokens = value
  }

  sender.save();
  receiver.save();
}

export function handleERC1155Transfer(event: TransferSingle): void {
  logERC1155Transfer(
    event.params.from,
    event.params.to,
    event.params.operator,
    event.params.id,
    event.params.value,
    event,
    0
  )
}
export function handleERC1155BatchTransfer(event: TransferBatch): void {
  for (let i = 0; i < event.params.ids.length; i++) {
    logERC1155Transfer(
      event.params.from,
      event.params.to,
      event.params.operator,
      event.params.ids[i],
      event.params.values[i],
      event,
      i
    )
  }
}