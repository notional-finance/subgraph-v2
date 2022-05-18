import { Address, BigInt, ByteArray, Bytes, ethereum, log } from "@graphprotocol/graph-ts";

import { IncentiveMigration, Trade } from '../generated/schema';

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

export function getTrade(currencyId: i32, account: Address, event: ethereum.Event, batchIndex: i32): Trade {
  let id =
    currencyId.toString() +
    ':' +
    account.toHexString() +
    ':' +
    event.transaction.hash.toHexString() +
    ':' +
    event.logIndex.toString() +
    ":" +
    batchIndex.toString();
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

export function hasIncentiveMigrationOccurred(currencyId: string): boolean {
  let migration = IncentiveMigration.load(currencyId)
  if (migration == null) return false
  return true
}

export function decodeERC1155Id(id: BigInt): BigInt[] {
  // Pad idHex out to a length of 18 (including the 0x prefix)
  let idHex = id.toHexString()
  let len = idHex.length;
  if (len == 15) { idHex = '0x000' + idHex.slice(2) }
  else if (len == 16) { idHex = '0x00' + idHex.slice(2) }
  else if (len == 17) { idHex = '0x0' + idHex.slice(2) }
  let bytes = ByteArray.fromHexString(idHex)

  let assetType = bytes[7] as i32
  let maturityBytes = new Bytes(5)
  // Parsing bytes into ints is done in reverse order
  maturityBytes[0] = bytes[6]
  maturityBytes[1] = bytes[5]
  maturityBytes[2] = bytes[4]
  maturityBytes[3] = bytes[3]
  maturityBytes[4] = bytes[2]
  let maturity = maturityBytes.toI64()

  let currencyBytes = new Bytes(2)
  currencyBytes[0] = bytes[1]
  currencyBytes[1] = bytes[0]
  let currencyId = currencyBytes.toI32()

  return [BigInt.fromI32(assetType), BigInt.fromI64(maturity), BigInt.fromI32(currencyId)]
}