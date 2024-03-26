import { Address, BigInt, log } from '@graphprotocol/graph-ts';
import { Notional } from '../generated/Notional/Notional';
import { ERC20 } from '../generated/Notional/ERC20';
import { convertAssetToUnderlying } from './accounts';
import { Currency, LeveragedVaultHistoricalValue } from '../generated/schema';

import { 
  getAssetExchangeRateHistoricalData,
  getEthExchangeRateHistoricalData,
  getMarketHistoricalData
} from './exchange_rates/utils'

import { getCurrencyTvl, getNTokenPresentValueHistoricalData, getTvlHistoricalData } from './notional';
import { getMarketMaturityLengthSeconds, getSettlementDate, getTimeRef } from './common';
import { getMarket } from './markets';
import { getVault, getVaultDirectory } from './vaults';
import { IStrategyVault } from '../generated/NotionalVaults/IStrategyVault';


const USDC_CURRENCY_ID = 3;

export function createDailyTvlId(timestamp: i32): string {
  let uniqueDayIndex = timestamp / 86400;

  return 'tvl:'.concat(uniqueDayIndex.toString());
}

export function createCurrencyDailyTvlId(timestamp: i32, currencyId: i32): string {
  let uniqueDayIndex = timestamp / 86400;

  return 'tvl:'
    .concat(currencyId.toString())
    .concat(':')
    .concat(uniqueDayIndex.toString());
}

export function createHourlyId(currencyId: number, timestamp: i32): string {
  let uniqueHourIndex = timestamp / 3600; // Integer division will always floor result

  return currencyId
    .toString()
    .concat(':')
    .concat(uniqueHourIndex.toString());
}

export function updateMarketHistoricalData(notional: Notional, currencyId: i32, timestamp: i32): void {
  let try_marketsResult = notional.try_getActiveMarketsAtBlockTime(currencyId, BigInt.fromI32(timestamp));
  if (try_marketsResult.reverted) return

  let marketsResult = try_marketsResult.value
  for (let i: i32 = 0; i < marketsResult.length; i++) {
    let marketIndex = i + 1;
    let maturity = marketsResult[i].maturity;
    let settlementDate = getSettlementDate(maturity, marketIndex);
    // This is just used to get the id
    let market = getMarket(currencyId, settlementDate, maturity, marketIndex);

    let historicalData = getMarketHistoricalData(market.id + ":" + createHourlyId(currencyId, timestamp));
    historicalData.market = market.id;
    historicalData.totalAssetCash = marketsResult[i].totalAssetCash;
    historicalData.totalfCash = marketsResult[i].totalfCash;
    historicalData.totalLiquidity = marketsResult[i].totalLiquidity;
    historicalData.lastImpliedRate = marketsResult[i].lastImpliedRate.toI32();
    historicalData.oracleRate = marketsResult[i].oracleRate.toI32();
    historicalData.previousTradeTime = marketsResult[i].previousTradeTime.toI32();
    historicalData.save();
  }
}

export function updateEthExchangeRateHistoricalData(notional: Notional, currencyId: i32, timestamp: i32): void {
  let result = notional.try_getCurrencyAndRates(currencyId);
  if (result.reverted) return;
  let ethRate = result.value.value2;

  let historicalId = createHourlyId(currencyId, timestamp);
  let ethExchangeRateHistoricalData = getEthExchangeRateHistoricalData(historicalId);
  let roundedTimestamp = (timestamp / 3600) * 3600;

  ethExchangeRateHistoricalData.timestamp = roundedTimestamp;
  ethExchangeRateHistoricalData.value = ethRate.rate;
  ethExchangeRateHistoricalData.currency = currencyId.toString();

  log.debug('Updated ethExchangeRateHistoricalData variables for entity {}', [ethExchangeRateHistoricalData.id]);
  ethExchangeRateHistoricalData.save();
}

export function updateAssetExchangeRateHistoricalData(notional: Notional, currencyId: i32, timestamp: i32): void {
  let result = notional.try_getCurrencyAndRates(currencyId);
  if (result.reverted) return;
  let assetRate = result.value.value3;

  let historicalId = createHourlyId(currencyId, timestamp);
  let assetExchangeRateHistoricalData = getAssetExchangeRateHistoricalData(historicalId);
  let roundedTimestamp = (timestamp / 3600) * 3600;

  assetExchangeRateHistoricalData.timestamp = roundedTimestamp;
  assetExchangeRateHistoricalData.value = assetRate.rate;
  assetExchangeRateHistoricalData.currency = currencyId.toString();

  log.debug('Updated assetExchangeRateHistoricalData variables for entity {}', [assetExchangeRateHistoricalData.id]);
  assetExchangeRateHistoricalData.save();
}

export function updateNTokenPresentValueHistoricalData(notional: Notional, currencyId: i32, timestamp: i32): void {
  let pvAsset = notional.try_nTokenPresentValueAssetDenominated(currencyId)
  let pvUnderlying = notional.try_nTokenPresentValueUnderlyingDenominated(currencyId)
  if (pvAsset.reverted || pvUnderlying.reverted) return;
  
  let historicalId = createHourlyId(currencyId, timestamp);
  let nTokenPresentValueHistoricalData = getNTokenPresentValueHistoricalData(historicalId);
  let roundedTimestamp = (timestamp / 3600) * 3600;

  nTokenPresentValueHistoricalData.timestamp = roundedTimestamp;
  nTokenPresentValueHistoricalData.pvAsset = pvAsset.value;
  nTokenPresentValueHistoricalData.pvUnderlying = pvUnderlying.value;
  nTokenPresentValueHistoricalData.currency = currencyId.toString();

  log.debug('Updated nTokenPresentValueHistoricalData variables for entity {}', [nTokenPresentValueHistoricalData.id]);
  nTokenPresentValueHistoricalData.save();
}

export function updateTvlHistoricalData(notional: Notional, maxCurrencyId: i32, timestamp: i32): void {
  let perCurrencyTvl = new Array<string>();
  let usdTotal = BigInt.fromI32(0);

  for (let currencyId: i32 = 1; currencyId <= maxCurrencyId; currencyId++) {
    let result = notional.try_getCurrencyAndRates(currencyId);
    if (!result.reverted) {
      let assetToken = result.value.value0;
      let erc20 = ERC20.bind(assetToken.tokenAddress);
      let assetTokenBalance = erc20.balanceOf(notional._address);
      let underlyingValue = convertAssetToUnderlying(notional, currencyId, assetTokenBalance);
      let ethRate = result.value.value2;
      let ethRateDecimals = result.value.value2.rateDecimals;
      let ethValue = underlyingValue.times(ethRate.rate).div(ethRateDecimals);
      let usdValue = ethToUsd(notional, ethValue);
      let currencyTvlId = createCurrencyDailyTvlId(timestamp, currencyId);
      let currencyTvl = getCurrencyTvl(currencyTvlId);
      let currencyEntity = Currency.load(currencyId.toString());
      
      if (currencyEntity != null) {
        currencyTvl.currency = currencyId.toString();
        currencyTvl.underlyingValue = underlyingValue;
        currencyTvl.usdValue = usdValue;
  
        log.debug('Updated tvlCurrency variables for entity {}', [currencyTvl.id]);
        currencyTvl.save();
        perCurrencyTvl.push(currencyTvl.id);
        usdTotal = usdTotal.plus(usdValue);
      }
    }
  }

  if (perCurrencyTvl.length > 0 && usdTotal.gt(BigInt.fromI32(0))) {
    let historicalId = createDailyTvlId(timestamp);
    let tvlHistoricalData = getTvlHistoricalData(historicalId, timestamp);
    tvlHistoricalData.usdTotal = usdTotal;
    tvlHistoricalData.perCurrencyTvl = perCurrencyTvl;

    log.debug('Updated tvlHistoricalData variables for entity {}', [tvlHistoricalData.id]);
    tvlHistoricalData.save();
  }
}

export function ethToUsd(notional: Notional, ethValue: BigInt): BigInt {
  let result = notional.try_getCurrencyAndRates(USDC_CURRENCY_ID);
  if (result.reverted) return BigInt.fromI32(0);

  let usdcEthRate = result.value.value2.rate;
  let rateDecimals = result.value.value2.rateDecimals
  let usdcValue = ethValue.times(rateDecimals).div(usdcEthRate);

  return usdcValue;
}

function getVaultHistoricalValue(
  vault: string,
  maturity: i32,
  timestamp: i32
): LeveragedVaultHistoricalValue {
  let id = (
    vault + ':' 
    + maturity.toString() + ':'
    + timestamp.toString()
  );

  let entity = new LeveragedVaultHistoricalValue(id);
  entity.timestamp = timestamp;
  entity.leveragedVaultMaturity = vault + ":" + maturity.toString()
  return entity
}

export function updateVaultHistoricalData(timestamp: i32): void {
  let directory = getVaultDirectory()
  for (let i = 0; i < directory.listedLeveragedVaults.length; i++) {
    let vault = getVault(directory.listedLeveragedVaults[i])

    for (let m = 1; m <= vault.maxBorrowMarketIndex; m++) {
      let maturityLength = getMarketMaturityLengthSeconds(m)
      let tRef = getTimeRef(timestamp)
      let maturity = tRef + maturityLength
      let historicalValue = getVaultHistoricalValue(vault.id, maturity, timestamp)
      let vaultAddress = Address.fromBytes(vault.vaultAddress)
      let leveragedVaultContract = IStrategyVault.bind(vaultAddress)
      let underlyingValue = leveragedVaultContract.try_convertStrategyToUnderlying(
        vaultAddress,
        BigInt.fromI32(10).pow(8),
        BigInt.fromI32(maturity)
      )

      let rateHistoricalId = createHourlyId(BigInt.fromString(vault.primaryBorrowCurrency).toI32(), timestamp);
      historicalValue.assetExchangeRate = rateHistoricalId;
      historicalValue.ethExchangeRate = rateHistoricalId;
      
      if (!underlyingValue.reverted) {
        historicalValue.underlyingValueOfStrategyToken = underlyingValue.value;
        historicalValue.save();
      }
    }
  }
}