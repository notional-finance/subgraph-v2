import {
    Address,
    BigInt,
    dataSource,
    ethereum,
} from '@graphprotocol/graph-ts';
import { Comptroller, DistributedSupplierComp } from '../generated/Comptroller/Comptroller';
import { Aggregator } from '../generated/Comptroller/Aggregator';
import { COMPBalance } from '../generated/schema';
import { createDailyTvlId } from './timeseriesUpdate';
import { ERC20 } from '../generated/Notional/ERC20';
import { BI_DAILY_BLOCK_UPDATE, getTvlHistoricalData } from './notional';

class Addresses {
    notional: Address;
    compOracle: Address;
    treasuryManager: Address;
}

function getAddresses(network: string): Addresses {
    if (network == "goerli") {
        return {
            notional: Address.fromString("0xD8229B55bD73c61D840d339491219ec6Fa667B0a"),
            // This testnet oracle returns COMP/ETH
            compOracle: Address.fromString("0x51D73fdd11555a5aCF0af8218264f0d96ec5fc3d"),
            treasuryManager: Address.fromString("0x8638f94155c333fd7087c012Dc51B0528bb06035")
        }
    }
    if (network == "kovan") {
        return {
            notional: Address.fromString("0x0EAE7BAdEF8f95De91fDDb74a89A786cF891Eb0e"),
            // This testnet oracle returns COMP/ETH
            compOracle: Address.fromString("0x9657Eb0e7c57afE5049eB8802f3811860069B31A"),
            treasuryManager: Address.fromString("0x049bbb3868850AEb8d606c4080A92D02CfC0b042")
        }
    }
    if (network == "mainnet") {
        return {
            notional: Address.fromString("0x1344A36A1B56144C3Bc62E7757377D288fDE0369"),
            // This is the Chainlink COMP/USD oracle
            compOracle: Address.fromString("0xdbd020caef83efd542f4de03e3cf0c28a4428bd5"),
            treasuryManager: Address.fromString("0x53144559c0d4a3304e2dd9dafbd685247429216d")
        }
    }
    return {
        notional: Address.zero(),
        compOracle: Address.zero(),
        treasuryManager: Address.zero()
    }
}

export function handleBlockUpdates(event: ethereum.Block): void {
    handleDailyUpdates(event);
}

function saveCOMPBalance(timestamp: i32): void {
    let historicalId = createDailyTvlId(timestamp);
    let tvlHistoricalData = getTvlHistoricalData(historicalId, timestamp);

    let comptroller = Comptroller.bind(dataSource.address());
    let compToken = ERC20.bind(comptroller.getCompAddress())
    let addr = getAddresses(dataSource.network());

    let oracle = Aggregator.bind(addr.compOracle)
    let compBalance = COMPBalance.load(historicalId);
    if (compBalance == null) {
        compBalance = new COMPBalance(historicalId);
        compBalance.timestamp = tvlHistoricalData.timestamp;
    }

    let compAmount = comptroller.compAccrued(addr.notional);
    let compInTreasury = compToken.try_balanceOf(addr.treasuryManager)

    if (!compInTreasury.reverted) {
        // compInTreasury may revert if the COMP token does not exist (such as on testnet)
        compAmount = compAmount.plus(compInTreasury.value)
    }

    let answer = oracle.try_latestAnswer();
    let usdValue = BigInt.fromI32(0);
    if (!answer.reverted)
        usdValue = answer.value.times(compAmount).div(BigInt.fromI32(10).pow(18));

    compBalance.value = compAmount;
    compBalance.usdValue = usdValue; // this is in 8 decimal precision
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
