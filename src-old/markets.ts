import {Notional} from '../generated/Notional/Notional';
import {BigInt, ethereum, log} from '@graphprotocol/graph-ts';
import {getMarketMaturityLengthSeconds, getSettlementDate} from './common';
import {Market} from '../generated/schema';
import {getCashGroup} from './notional';

export function getMarket(currencyId: i32, settlementDate: BigInt, maturity: BigInt, marketIndex: i32): Market {
  let id = currencyId.toString() + ':' + settlementDate.toString() + ':' + maturity.toString();

  let entity = Market.load(id);
  if (entity == null) {
    entity = new Market(id);
    entity.currency = currencyId.toString();
    entity.maturity = maturity.toI32();
    entity.settlementDate = settlementDate.toI32();
    entity.marketIndex = marketIndex;
    entity.marketMaturityLengthSeconds = getMarketMaturityLengthSeconds(marketIndex);
    entity.totalfCash = BigInt.fromI32(0);
    entity.totalAssetCash = BigInt.fromI32(0);
    entity.totalLiquidity = BigInt.fromI32(0);
    entity.lastImpliedRate = 0;
    entity.oracleRate = 0;
    entity.previousTradeTime = 0;
  }
  return entity as Market;
}

export function updateMarkets(currencyId: i32, blockTime: i32, event: ethereum.Event): Array<string> {
  let marketIds = new Array<string>();
  let notional = Notional.bind(event.address);
  let marketsResult = notional.getActiveMarketsAtBlockTime(currencyId, BigInt.fromI32(blockTime));

  for (let i: i32 = 0; i < marketsResult.length; i++) {
    let marketIndex = i + 1;
    let maturity = marketsResult[i].maturity;
    let settlementDate = getSettlementDate(maturity, marketIndex);
    let market = getMarket(currencyId, settlementDate, maturity, marketIndex);
    let didUpdate = false;

    if (market.totalAssetCash.notEqual(marketsResult[i].totalAssetCash)) {
      market.totalAssetCash = marketsResult[i].totalAssetCash;
      didUpdate = true;
    }

    if (market.totalfCash.notEqual(marketsResult[i].totalfCash)) {
      market.totalfCash = marketsResult[i].totalfCash;
      didUpdate = true;
    }

    if (market.totalLiquidity.notEqual(marketsResult[i].totalLiquidity)) {
      market.totalLiquidity = marketsResult[i].totalLiquidity;
      didUpdate = true;
    }

    if (market.lastImpliedRate != marketsResult[i].lastImpliedRate.toI32()) {
      market.lastImpliedRate = marketsResult[i].lastImpliedRate.toI32();
      didUpdate = true;
    }

    if (market.oracleRate != marketsResult[i].oracleRate.toI32()) {
      market.oracleRate = marketsResult[i].oracleRate.toI32();
      didUpdate = true;
    }

    if (market.previousTradeTime != marketsResult[i].previousTradeTime.toI32()) {
      market.previousTradeTime = marketsResult[i].previousTradeTime.toI32();
      didUpdate = true;
    }

    if (didUpdate) {
      market.lastUpdateBlockNumber = event.block.number.toI32();
      market.lastUpdateTimestamp = event.block.timestamp.toI32();
      market.lastUpdateBlockHash = event.block.hash;
      market.lastUpdateTransactionHash = event.transaction.hash;

      log.debug('Updated market entity {}', [market.id]);
      market.save();
    }

    marketIds.push(market.id);
  }

  updateReserve(currencyId, event);

  return marketIds;
}

function updateReserve(currencyId: i32, event: ethereum.Event): void {
  let notional = Notional.bind(event.address);
  let cashGroup = getCashGroup(currencyId.toString());
  let reserveBalance = notional.getReserveBalance(currencyId);

  if (reserveBalance.notEqual(cashGroup.reserveBalance)) {
    cashGroup.reserveBalance = reserveBalance;
    cashGroup.lastUpdateBlockNumber = event.block.number.toI32();
    cashGroup.lastUpdateTimestamp = event.block.timestamp.toI32();
    cashGroup.lastUpdateBlockHash = event.block.hash;
    cashGroup.lastUpdateTransactionHash = event.transaction.hash;
    log.debug('Cash group reserve balance updated {}', [cashGroup.id]);
    cashGroup.save();
  }
}
