import { LendBorrowDayData } from '../../generated/schema'
import { Notional, LendBorrowTrade } from '../../generated/Notional/Notional';
import { BigInt } from '@graphprotocol/graph-ts'
import { getMarketIndex } from '../common';
import { convertAssetToUnderlying } from '../accounts';

export function updateLendBorrowDayData(event: LendBorrowTrade): LendBorrowDayData
{
    let notional = Notional.bind(event.address);
    let timestamp = event.block.timestamp.toI32()
    let dayId = timestamp / 86400 // rounded
    let dayStartTimestamp = dayId * 86400
    let currencyId = event.params.currencyId as i32;
    let maturity = event.params.maturity;
    let marketIndex = getMarketIndex(maturity, event.block.timestamp)
    let key = dayId.toString() + ':' + currencyId.toString() + ':' + marketIndex.toString()

    let lendBorrowDayData = LendBorrowDayData.load(key)
    if (lendBorrowDayData === null) {

        lendBorrowDayData = new LendBorrowDayData(key)

        if (event.params.netAssetCash.gt(BigInt.fromI32(0))) {
            lendBorrowDayData.tradeType = 'Borrow';
        } else {
            lendBorrowDayData.tradeType = 'Lend';
        }
        lendBorrowDayData.date = dayStartTimestamp
        lendBorrowDayData.volumeNetUnderlyingCash = BigInt.fromString('0')
        lendBorrowDayData.txCount = BigInt.fromI32(0)
    }

    let convertedAssetToUnderlying = convertAssetToUnderlying(notional, currencyId, event.params.netAssetCash).abs();
    lendBorrowDayData.volumeNetUnderlyingCash = lendBorrowDayData.volumeNetUnderlyingCash.plus(convertedAssetToUnderlying)
    lendBorrowDayData.txCount = lendBorrowDayData.txCount.plus(BigInt.fromI32(1))
    lendBorrowDayData.save()
    
    return lendBorrowDayData as LendBorrowDayData
}