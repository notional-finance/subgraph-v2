import {Address, BigInt, log} from '@graphprotocol/graph-ts';
import { Notional, UpdateAssetRate, UpdateETHRate } from '../generated/Notional/Notional';

import { 
    AssetExchangeRate,
    EthExchangeRate
} from '../generated/schema';

import { 
    getAssetExchangeRateHistoricalData,
    getEthExchangeRateHistoricalData
} from './exchange_rates/utils'

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

export function updateEthExchangeRateHistoricalData(ethExchangeRate: EthExchangeRate, event: UpdateETHRate): void {
    let historicalId = createHourlyId(event.params.currencyId, event.block.timestamp.toI32());
    let ethExchangeRateHistoricalData = getEthExchangeRateHistoricalData(historicalId);
    let roundedTimestamp = (event.block.timestamp.toI32() / 3600) * 3600;

    let notional = Notional.bind(event.address);
    let rateResult = notional.getCurrencyAndRates(event.params.currencyId);
    let ethRate = rateResult.value2;

    ethExchangeRateHistoricalData.timestamp = roundedTimestamp;
    ethExchangeRateHistoricalData.value = ethRate.rate.div(BigInt.fromI32(10).pow(10));
    ethExchangeRateHistoricalData.ethExchangeRate = ethExchangeRate.id;

    log.debug('Updated ethExchangeRateHistoricalData variables for entity {}', [ethExchangeRateHistoricalData.id]);
    ethExchangeRateHistoricalData.save();
}

export function updateAssetExchangeRateHistoricalData(assetExchangeRate: AssetExchangeRate, event: UpdateAssetRate): void {
    let historicalId = createHourlyId(event.params.currencyId, event.block.timestamp.toI32());
    let assetExchangeRateHistoricalData = getAssetExchangeRateHistoricalData(historicalId);
    let roundedTimestamp = (event.block.timestamp.toI32() / 3600) * 3600;

    let notional = Notional.bind(event.address);
    let rateResult = notional.getCurrencyAndRates(event.params.currencyId);
    let assetRate = rateResult.value3;

    assetExchangeRateHistoricalData.timestamp = roundedTimestamp;
    assetExchangeRateHistoricalData.value = assetRate.rate.div(BigInt.fromI32(10).pow(10));
    assetExchangeRateHistoricalData.assetExchangeRate = assetExchangeRate.id;

    log.debug('Updated assetExchangeRateHistoricalData variables for entity {}', [assetExchangeRateHistoricalData.id]);
    assetExchangeRateHistoricalData.save();
}
