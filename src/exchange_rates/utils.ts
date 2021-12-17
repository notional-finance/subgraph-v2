import {
    AssetExchangeRate,
    AssetExchangeRateHistoricalData,
    EthExchangeRate,
    EthExchangeRateHistoricalData
} from '../../generated/schema';

export function getEthExchangeRate(id: string): EthExchangeRate {
    let entity = EthExchangeRate.load(id);
    if (entity == null) {
      entity = new EthExchangeRate(id);
    }
    return entity as EthExchangeRate;
}

export function getAssetExchangeRate(id: string): AssetExchangeRate {
    let entity = AssetExchangeRate.load(id);
    if (entity == null) {
      entity = new AssetExchangeRate(id);
    }
    return entity as AssetExchangeRate;
}

export function getEthExchangeRateHistoricalData(id: string): EthExchangeRateHistoricalData {
    let entity = EthExchangeRateHistoricalData.load(id);
    if (entity == null) {
        entity = new EthExchangeRateHistoricalData(id);
    }
    return entity as EthExchangeRateHistoricalData;
}

export function getAssetExchangeRateHistoricalData(id: string): AssetExchangeRateHistoricalData {
    let entity = AssetExchangeRateHistoricalData.load(id);
    if (entity == null) {
        entity = new AssetExchangeRateHistoricalData(id);
    }
    return entity as AssetExchangeRateHistoricalData;
}
