import { Address, BigInt, ethereum, log } from "@graphprotocol/graph-ts";

import { Trade } from '../generated/schema';

export const RATE_PRECISION = 1000000000;
export const BASIS_POINTS = 100000;
export const DAY = 86400;
export const WEEK = DAY * 6;
export const MONTH = DAY * 30;
export const QUARTER = DAY * 90;
export const YEAR = QUARTER * 4;

export function getTimeRef(timestamp: i32): i32 {
  return timestamp - (timestamp % QUARTER);
}

export function getSettlementDate(maturity: BigInt, marketIndex: i32): BigInt {
  if (marketIndex == 1) return maturity;
  let marketLength = BigInt.fromI32(getMarketMaturityLengthSeconds(marketIndex));
  
  return maturity.minus(marketLength).plus(BigInt.fromI32(QUARTER));
}

export function getMarketIndex(maturity: BigInt, timestamp: BigInt): i32 {
  let tRef = getTimeRef(timestamp.toI32())
  for (let i = 1; i <= 7; i++) {
    let marketLength = getMarketMaturityLengthSeconds(i)
    if (BigInt.fromI32(tRef + marketLength).equals(maturity)) return i;
  }

  log.critical('Unknown maturity {} at {}', [maturity.toString(), timestamp.toString()])
  return 0;
}

export function getTrade(currencyId: i32, account: Address, event: ethereum.Event): Trade {
  let id =
    currencyId.toString() +
    ':' +
    account.toHexString() +
    ':' +
    event.transaction.hash.toHexString() +
    ':' +
    event.logIndex.toString();
  let trade = new Trade(id);
  trade.blockHash = event.block.hash;
  trade.blockNumber = event.block.number.toI32();
  trade.timestamp = event.block.timestamp.toI32();
  trade.transactionHash = event.transaction.hash;
  trade.transactionOrigin = event.transaction.from;

  trade.account = account.toHexString();
  trade.currency = currencyId.toString();

  return trade;
}

export function getMarketMaturityLengthSeconds(maxMarketIndex: i32): i32 {
  if (maxMarketIndex == 1) return QUARTER;
  if (maxMarketIndex == 2) return 2 * QUARTER;
  if (maxMarketIndex == 3) return YEAR;
  if (maxMarketIndex == 4) return 2 * YEAR;
  if (maxMarketIndex == 5) return 5 * YEAR;
  if (maxMarketIndex == 6) return 10 * YEAR;
  if (maxMarketIndex == 7) return 20 * YEAR;

  return 0;
}
