import { DailyLendBorrowVolume } from '../../generated/schema'
import { Notional, LendBorrowTrade } from '../../generated/Notional/Notional';
import { BigInt } from '@graphprotocol/graph-ts'
import { getMarketIndex, getSettlementDate, getTrade } from '../common';
import { convertAssetToUnderlying } from '../accounts';

export function updateDailyLendBorrowVolume(event: LendBorrowTrade): void {
    let notional = Notional.bind(event.address);
    let timestamp = event.block.timestamp.toI32()
    let dayId = timestamp / 86400 // rounded
    let dayStartTimestamp = dayId * 86400
    let currencyId = event.params.currencyId as i32;
    let maturity = event.params.maturity;
    let marketIndex = getMarketIndex(maturity, event.block.timestamp)
    let settlementDate = getSettlementDate(maturity, marketIndex);
    let tradeType = '';
    let convertedAssetToUnderlying = convertAssetToUnderlying(notional, currencyId, event.params.netAssetCash).abs();
    let netAssetCash = event.params.netAssetCash.abs()
    let netfCash = event.params.netfCash.abs();
    if (event.params.netAssetCash.gt(BigInt.fromI32(0))) {
        tradeType = 'Borrow';
    } else if (event.params.netAssetCash.lt(BigInt.fromI32(0))) {
        tradeType = 'Lend';
    } else {
        // If net asset cash is zero then it is a transfer, don't log
        // it in the daily trade volume
        return;
    }

    let trade = getTrade(currencyId, event.params.account, event, 0);

    let key = dayId.toString() + ':' + currencyId.toString() + ':' + marketIndex.toString() + ':' + tradeType
    let dailyLendBorrowVolume = DailyLendBorrowVolume.load(key)

    if (dailyLendBorrowVolume === null) {
        dailyLendBorrowVolume = new DailyLendBorrowVolume(key)
        dailyLendBorrowVolume.date = dayStartTimestamp
        dailyLendBorrowVolume.currency = currencyId.toString()
        dailyLendBorrowVolume.market = currencyId.toString() + ':' + settlementDate.toString() + ':' + maturity.toString();
        dailyLendBorrowVolume.trades = new Array<string>();
        dailyLendBorrowVolume.marketIndex = marketIndex
        dailyLendBorrowVolume.tradeType = tradeType;
        dailyLendBorrowVolume.totalVolumeUnderlyingCash = BigInt.fromString('0')
        dailyLendBorrowVolume.totalVolumeNetAssetCash = BigInt.fromString('0')
        dailyLendBorrowVolume.totalVolumeNetfCash = BigInt.fromString('0')
        dailyLendBorrowVolume.txCount = BigInt.fromI32(0)
    }

    let trades = dailyLendBorrowVolume.trades
    trades.push(trade.id)
    dailyLendBorrowVolume.trades = trades
    dailyLendBorrowVolume.totalVolumeUnderlyingCash = dailyLendBorrowVolume.totalVolumeUnderlyingCash.plus(convertedAssetToUnderlying)
    dailyLendBorrowVolume.totalVolumeNetAssetCash = dailyLendBorrowVolume.totalVolumeNetAssetCash.plus(netAssetCash)
    dailyLendBorrowVolume.totalVolumeNetfCash = dailyLendBorrowVolume.totalVolumeNetfCash.plus(netfCash)
    dailyLendBorrowVolume.txCount = dailyLendBorrowVolume.txCount.plus(BigInt.fromI32(1));
    dailyLendBorrowVolume.save();
}