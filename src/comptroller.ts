import {
    Address,
    BigInt,
    ByteArray,
    Bytes,
    dataSource,
    ethereum,
    log,
    store
} from '@graphprotocol/graph-ts';
import { Comptroller, DistributedSupplierComp } from '../generated/Comptroller/Comptroller';
import { Aggregator } from '../generated/Comptroller/Aggregator';
import { COMPBalance, TvlHistoricalData } from '../generated/schema';
import { createDailyTvlId, createHourlyId, ethToUsd } from './timeseriesUpdate';
import { getTvlHistoricalData } from './notional';
import { Notional } from '../generated/Notional/Notional';
import { ADDRESS_ZERO } from './common';

const BI_HOURLY_BLOCK_UPDATE = 138;
const BI_DAILY_BLOCK_UPDATE = 3300;

class Addresses {
    notional: Address;
    compOracle: Address;
}

function getAddresses(network: string): Addresses {
    if (network == "goerli") {
        return {
            notional: Address.fromHexString("0xD8229B55bD73c61D840d339491219ec6Fa667B0a") as Address,
            compOracle: Address.fromHexString("0x51D73fdd11555a5aCF0af8218264f0d96ec5fc3d") as Address
        }
    }
    if (network == "kovan") {
        return {
            notional: Address.fromHexString("0x0EAE7BAdEF8f95De91fDDb74a89A786cF891Eb0e") as Address,
            compOracle: Address.fromHexString("0x9657Eb0e7c57afE5049eB8802f3811860069B31A") as Address
        }
    }
    if (network == "mainnet") {
        return {
            notional: Address.fromHexString("0x1344A36A1B56144C3Bc62E7757377D288fDE0369") as Address,
            compOracle: Address.fromHexString("0xD14b0FDC8Dd3a3ECFec8ad538aE1621fF6F3Dc1F") as Address
        }
    }
    return {
        notional: ADDRESS_ZERO(),
        compOracle: ADDRESS_ZERO()
    }
}

export function handleBlockUpdates(event: ethereum.Block): void {
    handleDailyUpdates(event);
}

function saveCOMPBalance(timestamp: i32): void {
    let historicalId = createDailyTvlId(timestamp);

    let entity = TvlHistoricalData.load(historicalId);
    if (entity == null) {
        entity = new TvlHistoricalData(historicalId);
        entity.timestamp = (timestamp / 86400) * 86400;
        entity.usdTotal = BigInt.fromI32(0);
        entity.perCurrencyTvl = new Array<string>();
    }
    let tvlHistoricalData = entity as TvlHistoricalData;

    let comptroller = Comptroller.bind(dataSource.address());
    let addr = getAddresses(dataSource.network());
    let oracle = Aggregator.bind(addr.compOracle)
    let notional = Notional.bind(addr.notional);

    let compBalance = COMPBalance.load(historicalId);
    if (compBalance == null) {
        compBalance = new COMPBalance(historicalId)
    }

    let comp = comptroller.compAccrued(addr.notional);
    let answer = oracle.try_latestAnswer();
    let ethValue = BigInt.fromI32(0);
    if (!answer.reverted)
        ethValue = answer.value.times(comp).div(BigInt.fromI32(10).pow(18));

    compBalance.value = comp;
    compBalance.usdValue = ethToUsd(notional, ethValue);
    compBalance.save()

    tvlHistoricalData.compBalance = compBalance.id;
    tvlHistoricalData.save()
}

function handleDailyUpdates(event: ethereum.Block): void {
    if (event.number.toI32() % BI_DAILY_BLOCK_UPDATE != 0) {
        return;
    }

    saveCOMPBalance(event.timestamp.toI32());
}

export function handleDistributedSupplierComp(event: DistributedSupplierComp): void {
    let addr = getAddresses(dataSource.network());
    if (event.params.supplier == addr.notional) {
        saveCOMPBalance(Math.floor(event.block.timestamp.toI32() / BI_DAILY_BLOCK_UPDATE) as i32)
    }
}
