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
import { COMPBalance } from '../generated/schema';
import { createDailyTvlId } from './common';
import { getTvlHistoricalData } from './notional';

const BI_HOURLY_BLOCK_UPDATE = 138;
const BI_DAILY_BLOCK_UPDATE = 3300;

function getNotionalAddress(network: string): Address {
    if (network == "goerli") {
        return Address.fromHexString("0xD8229B55bD73c61D840d339491219ec6Fa667B0a") as Address;
    }
    if (network == "mainnet") {
        return Address.fromHexString("0x1344A36A1B56144C3Bc62E7757377D288fDE0369") as Address;
    }
    return Address.fromHexString("0xfa5f002555eb670019bD938604802f901208aE71") as Address;
}

export function handleBlockUpdates(event: ethereum.Block): void {
    handleDailyUpdates(event);
}

function saveCOMPBalance(timestamp: i32): void {
    let historicalId = createDailyTvlId(timestamp);
    let tvlHistoricalData = getTvlHistoricalData(historicalId);
    let comptroller = Comptroller.bind(dataSource.address());
    let addr = getNotionalAddress(dataSource.network());

    let compBalance = COMPBalance.load(tvlHistoricalData.compBalance);
    if (compBalance == null) {
        compBalance = new COMPBalance(historicalId)
    }

    compBalance.value = comptroller.compAccrued(addr);

    compBalance.save()
}

function handleDailyUpdates(event: ethereum.Block): void {
    if (event.number.toI32() % BI_HOURLY_BLOCK_UPDATE != 0) {
        return;
    }

    saveCOMPBalance(event.timestamp.toI32());
}

export function handleDistributedSupplierComp(event: DistributedSupplierComp): void {
    if (event.params.supplier == getNotionalAddress(dataSource.network())) {
        log.info("CToken addr = {}", [event.params.cToken.toHexString()]);
        log.info("CompDelta = {}", [event.params.compDelta.toString()])
        saveCOMPBalance(Math.floor(event.block.timestamp.toI32() / BI_HOURLY_BLOCK_UPDATE) as i32)
    }
}