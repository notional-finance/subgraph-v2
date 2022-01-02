import { BigInt, log } from '@graphprotocol/graph-ts';
import { Notional } from '../generated/Notional/Notional';
import { ERC20 } from '../generated/Notional/ERC20';
import { convertAssetToUnderlying } from './accounts';
import { Currency } from '../generated/schema';

import { 
  getAssetExchangeRateHistoricalData,
  getEthExchangeRateHistoricalData
} from './exchange_rates/utils'

import { getCurrencyTvl, getNTokenPresentValueHistoricalData, getTvlHistoricalData } from './notional';


const USDC_CURRENCY_ID = 3;

function createDailyTvlId(timestamp: i32): string {
  let uniqueDayIndex = timestamp / 86400;

  return 'tvl:'.concat(uniqueDayIndex.toString());
}

function createCurrencyDailyTvlId(timestamp: i32, currencyId: i32): string {
  let uniqueDayIndex = timestamp / 86400;

  return 'tvl:'
    .concat(currencyId.toString())
    .concat(':')
    .concat(uniqueDayIndex.toString());
}

function createHourlyId(currencyId: number, timestamp: i32): string {
  let uniqueHourIndex = timestamp / 3600; // Integer division will always floor result

  return currencyId
    .toString()
    .concat(':')
    .concat(uniqueHourIndex.toString());
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
  let tvlCurrencies = new Array<string>();
  let currenciesTotal = BigInt.fromI32(0);

  for (let currencyId: i32 = 1; currencyId <= 4; currencyId++) {
    let result = notional.try_getCurrencyAndRates(currencyId);
    if (!result.reverted) {
      let assetToken = result.value.value0;
      let erc20 = ERC20.bind(assetToken.tokenAddress);
      let assetTokenBalance = erc20.balanceOf(notional._address);
      let underlyingValue = convertAssetToUnderlying(notional, currencyId, assetTokenBalance);
      let ethRate = result.value.value2;
      let ethRateDecimals = result.value.value2.rateDecimals;
      let ethValue = underlyingValue.times(ethRate.rate).div(ethRateDecimals).div(assetToken.decimals);
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
        tvlCurrencies.push(currencyTvl.id);
        currenciesTotal = currenciesTotal.plus(underlyingValue);
      }
    }
  }

  if (tvlCurrencies.length > 0 && currenciesTotal.gt(BigInt.fromI32(0))) {
    let historicalId = createDailyTvlId(timestamp);
    let tvlHistoricalData = getTvlHistoricalData(historicalId);
    let roundedTimestamp = (timestamp / 86400) * 86400;
  
    tvlHistoricalData.timestamp = roundedTimestamp;
    tvlHistoricalData.tvlCurrencies = tvlCurrencies;

    log.debug('Updated tvlHistoricalData variables for entity {}', [tvlHistoricalData.id]);
    tvlHistoricalData.save();
  }
}

function ethToUsd(notional: Notional, ethValue: BigInt): BigInt {
  let result = notional.try_getCurrencyAndRates(USDC_CURRENCY_ID);
  if (result.reverted) return BigInt.fromI32(0);

  let usdcEthRate = result.value.value2.rate;
  let rateDecimals = result.value.value2.rateDecimals
  let usdcValue = ethValue.times(rateDecimals).div(usdcEthRate);

  return usdcValue;
}
