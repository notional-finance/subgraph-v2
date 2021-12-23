import { log } from '@graphprotocol/graph-ts';
import { Notional } from '../generated/Notional/Notional';

import { 
  getAssetExchangeRateHistoricalData,
  getEthExchangeRateHistoricalData
} from './exchange_rates/utils'

import { getNTokenPresentValueHistoricalData } from './notional';

/* 
    Historical data is stored on an hourly basis to keep it lean, this could be changed in the future
    or be kept as multiple time periods. New values during the timespan updates the hourly value
*/

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
