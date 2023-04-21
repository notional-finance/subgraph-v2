import { BigInt, ethereum } from "@graphprotocol/graph-ts";
import { Notional__getActiveMarketsResultValue0Struct } from "../../generated/Assets/Notional";
import { ActiveMarkets, Market, MarketSnapshot } from "../../generated/schema";
import { getNotional, getUnderlying } from "./entities";

const DAY = 86400;
const QUARTER = DAY * 90;
const YEAR = QUARTER * 4;

function getCurrentSettlementDate(blockTime: BigInt): i32 {
  return getTimeRef(blockTime.toI32()) + QUARTER;
}

function getMarketIndex(maturity: i32, settlementDate: i32): i32 {
  let timeToMaturity = maturity - settlementDate - QUARTER;

  if (timeToMaturity == QUARTER) return 1;
  if (timeToMaturity == 2 * QUARTER) return 2;
  if (timeToMaturity == YEAR) return 3;
  if (timeToMaturity == 2 * YEAR) return 4;
  if (timeToMaturity == 5 * YEAR) return 5;
  if (timeToMaturity == 10 * YEAR) return 6;
  if (timeToMaturity == 20 * YEAR) return 7;

  return 0;
}

function getTimeRef(timestamp: i32): i32 {
  return timestamp - (timestamp % QUARTER);
}

function getMarketMaturityLengthSeconds(maxMarketIndex: i32): i32 {
  if (maxMarketIndex == 1) return QUARTER;
  if (maxMarketIndex == 2) return 2 * QUARTER;
  if (maxMarketIndex == 3) return YEAR;
  if (maxMarketIndex == 4) return 2 * YEAR;
  if (maxMarketIndex == 5) return 5 * YEAR;
  if (maxMarketIndex == 6) return 10 * YEAR;
  if (maxMarketIndex == 7) return 20 * YEAR;

  return 0;
}

function getMarket(
  currencyId: i32,
  settlementDate: i32,
  maturity: i32,
  event: ethereum.Event
): Market {
  let id = currencyId.toString() + ":" + settlementDate.toString() + ":" + maturity.toString();
  let market = Market.load(id);
  if (market == null) {
    market = new Market(id);
    market.underlying = getUnderlying(currencyId).id;
    market.maturity = maturity;
    market.settlementDate = settlementDate;
    market.marketIndex = getMarketIndex(maturity, settlementDate);
    market.marketMaturityLengthSeconds = getMarketMaturityLengthSeconds(market.marketIndex);
  }

  market.lastUpdateBlockNumber = event.block.number.toI32();
  market.lastUpdateTimestamp = event.block.timestamp.toI32();
  market.lastUpdateTransactionHash = event.transaction.hash;
  return market;
}

function updateMarketWithSnapshot(
  currencyId: i32,
  event: ethereum.Event,
  marketData: Notional__getActiveMarketsResultValue0Struct
): string {
  let settlementDate = getCurrentSettlementDate(event.block.timestamp);
  let market = getMarket(currencyId, settlementDate, marketData.maturity.toI32(), event);
  let snapshot = new MarketSnapshot(market.id + ":" + event.transaction.hash.toHexString());
  snapshot.market = market.id;
  snapshot.blockNumber = event.block.number.toI32();
  snapshot.timestamp = event.block.timestamp.toI32();
  snapshot.transactionHash = event.transaction.hash;
  snapshot.totalfCash = marketData.totalfCash;
  snapshot.totalPrimeCash = marketData.totalPrimeCash;
  snapshot.totalLiquidity = marketData.totalLiquidity;
  snapshot.lastImpliedRate = marketData.lastImpliedRate.toI32();
  snapshot.oracleRate = marketData.oracleRate.toI32();
  snapshot.previousTradeTime = marketData.previousTradeTime.toI32();
  snapshot.save();

  market.current = snapshot.id;
  market.save();

  return market.id;
}

export function updateMarket(currencyId: i32, maturity: i32, event: ethereum.Event): void {
  let notional = getNotional();
  let activeMarkets = notional.getActiveMarkets(currencyId);

  for (let i = 0; i < activeMarkets.length; i++) {
    if (activeMarkets[i].maturity.toI32() == maturity) {
      updateMarketWithSnapshot(currencyId, event, activeMarkets[i]);
    }
  }
}

export function setActiveMarkets(currencyId: i32, event: ethereum.Event): void {
  let activeMarkets = ActiveMarkets.load(currencyId.toString());
  if (activeMarkets == null) {
    activeMarkets = new ActiveMarkets(currencyId.toString());
    activeMarkets.underlying = currencyId.toString();
  }

  activeMarkets.lastUpdateBlockNumber = event.block.number.toI32();
  activeMarkets.lastUpdateTimestamp = event.block.timestamp.toI32();
  activeMarkets.lastUpdateTransactionHash = event.transaction.hash;

  let notional = getNotional();
  let _activeMarkets = notional.getActiveMarkets(currencyId);
  let activeMarketIds = new Array<string>();
  for (let i = 0; i < _activeMarkets.length; i++) {
    let id = updateMarketWithSnapshot(currencyId, event, _activeMarkets[i]);
    activeMarketIds.push(id);
  }

  activeMarkets.markets = activeMarketIds;
  activeMarkets.save();
}
