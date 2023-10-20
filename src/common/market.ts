import { BigInt, ByteArray, Bytes, ethereum, log } from "@graphprotocol/graph-ts";
import { NotionalV3__getActiveMarketsResultValue0Struct } from "../../generated/Assets/NotionalV3";
import {
  ActiveMarket,
  fCashMarket,
  fCashMarketSnapshot,
  PrimeCashMarket,
  PrimeCashMarketSnapshot,
} from "../../generated/schema";
import { FCASH_ASSET_TYPE_ID } from "./constants";
import { getAsset, getNotional, getUnderlying } from "./entities";
import { getOrCreateERC1155Asset } from "./erc1155";
import { convertValueToUnderlying } from "./transfers";
import { getTotalfCashDebt } from "../balances";

const DAY = 86400;
const QUARTER = DAY * 90;
const YEAR = QUARTER * 4;

function getCurrentSettlementDate(blockTime: BigInt): i32 {
  return getTimeRef(blockTime.toI32()) + QUARTER;
}

function getMarketIndex(maturity: i32, settlementDate: i32): i32 {
  let timeToMaturity = maturity - settlementDate + QUARTER;

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

function getfCashMarket(
  currencyId: i32,
  settlementDate: i32,
  maturity: i32,
  block: ethereum.Block,
  txnHash: string | null
): fCashMarket {
  let id = currencyId.toString() + ":" + settlementDate.toString() + ":" + maturity.toString();
  let market = fCashMarket.load(id);
  if (market == null) {
    market = new fCashMarket(id);
    market.underlying = getUnderlying(currencyId).id;
    market.maturity = maturity;
    market.settlementDate = settlementDate;
    market.marketIndex = getMarketIndex(maturity, settlementDate);
    market.marketMaturityLengthSeconds = getMarketMaturityLengthSeconds(market.marketIndex);

    let notional = getNotional();
    let fCashID = notional.encodeToId(
      currencyId,
      BigInt.fromI32(maturity),
      FCASH_ASSET_TYPE_ID.toI32()
    );
    let _txnHash: Bytes | null = null;
    if (txnHash !== null) _txnHash = ByteArray.fromHexString(txnHash) as Bytes;
    market.fCash = getOrCreateERC1155Asset(fCashID, block, _txnHash).id;
  }

  market.lastUpdateBlockNumber = block.number;
  market.lastUpdateTimestamp = block.timestamp.toI32();
  market.lastUpdateTransaction = txnHash;
  return market;
}

function getPrimeCashMarket(
  currencyId: i32,
  block: ethereum.Block,
  txnHash: string | null
): PrimeCashMarket {
  let id = currencyId.toString();
  let market = PrimeCashMarket.load(id);
  if (market == null) {
    market = new PrimeCashMarket(id);
    let notional = getNotional();
    market.underlying = getUnderlying(currencyId).id;
    market.primeCash = notional.pCashAddress(currencyId).toHexString();
    market.primeDebt = notional.pDebtAddress(currencyId).toHexString();
  }

  market.lastUpdateBlockNumber = block.number;
  market.lastUpdateTimestamp = block.timestamp.toI32();
  market.lastUpdateTransaction = txnHash;
  return market;
}

function updatefCashMarketWithSnapshot(
  currencyId: i32,
  block: ethereum.Block,
  txnHash: string | null,
  marketData: NotionalV3__getActiveMarketsResultValue0Struct
): string {
  let settlementDate = getCurrentSettlementDate(block.timestamp);
  let market = getfCashMarket(
    currencyId,
    settlementDate,
    marketData.maturity.toI32(),
    block,
    txnHash
  );

  let snapshot = new fCashMarketSnapshot(market.id + ":" + block.number.toString());
  snapshot.market = market.id;
  snapshot.blockNumber = block.number;
  snapshot.timestamp = block.timestamp.toI32();
  snapshot.transaction = txnHash;

  snapshot.totalfCash = marketData.totalfCash;
  snapshot.totalPrimeCash = marketData.totalPrimeCash;
  snapshot.totalLiquidity = marketData.totalLiquidity;
  snapshot.lastImpliedRate = marketData.lastImpliedRate.toI32();
  snapshot.oracleRate = marketData.oracleRate.toI32();
  snapshot.previousTradeTime = marketData.previousTradeTime.toI32();

  let notional = getNotional();
  let pCashToken = getAsset(notional.pCashAddress(currencyId).toHexString());
  let fCashToken = getAsset(market.fCash);
  snapshot.totalPrimeCashInUnderlying = convertValueToUnderlying(
    snapshot.totalPrimeCash,
    pCashToken,
    block.timestamp
  );
  snapshot.totalfCashPresentValue = convertValueToUnderlying(
    snapshot.totalfCash,
    fCashToken,
    block.timestamp
  );
  // NOTE: this always returns zero in V2
  snapshot.totalfCashDebtOutstanding = getTotalfCashDebt(
    currencyId,
    BigInt.fromI32(market.maturity)
  );
  snapshot.totalfCashDebtOutstandingPresentValue = convertValueToUnderlying(
    snapshot.totalfCashDebtOutstanding,
    fCashToken,
    block.timestamp
  );
  snapshot.save();

  market.current = snapshot.id;
  market.save();

  return market.id;
}

export function updatefCashMarket(
  currencyId: i32,
  maturity: i32,
  block: ethereum.Block,
  txnHash: string | null
): void {
  let notional = getNotional();
  let activeMarkets = notional.getActiveMarkets(currencyId);

  for (let i = 0; i < activeMarkets.length; i++) {
    if (activeMarkets[i].maturity.toI32() == maturity) {
      updatefCashMarketWithSnapshot(currencyId, block, txnHash, activeMarkets[i]);
    }
  }
}

export function updatePrimeCashMarket(
  currencyId: i32,
  block: ethereum.Block,
  txnHash: string | null
): PrimeCashMarket {
  let pCashMarket = getPrimeCashMarket(currencyId, block, txnHash);
  let pCashSnapshot = new PrimeCashMarketSnapshot(pCashMarket.id + ":" + block.number.toString());
  pCashSnapshot.blockNumber = block.number;
  pCashSnapshot.timestamp = block.timestamp.toI32();
  pCashSnapshot.transaction = txnHash;
  pCashSnapshot.market = pCashMarket.id;

  let notional = getNotional();
  let factors = notional.getPrimeFactorsStored(currencyId);

  pCashSnapshot.totalPrimeCash = factors.totalPrimeSupply;
  pCashSnapshot.totalPrimeDebt = factors.totalPrimeDebt;
  pCashSnapshot.totalUnderlyingHeld = factors.lastTotalUnderlyingValue;
  pCashSnapshot.supplyScalar = factors.supplyScalar;
  pCashSnapshot.debtScalar = factors.debtScalar;
  pCashSnapshot.underlyingScalar = factors.underlyingScalar;

  let pCashToken = getAsset(notional.pCashAddress(currencyId).toHexString());
  pCashSnapshot.totalPrimeCashInUnderlying = convertValueToUnderlying(
    factors.totalPrimeSupply,
    pCashToken,
    block.timestamp
  );
  if (factors.totalPrimeDebt.gt(BigInt.zero())) {
    let pDebtToken = getAsset(notional.pDebtAddress(currencyId).toHexString());
    pCashSnapshot.totalPrimeDebtInUnderlying = convertValueToUnderlying(
      factors.totalPrimeDebt,
      pDebtToken,
      block.timestamp
    );
  }

  // TODO: does this get the right value if we have not properly accrued?
  let interestRates = notional.try_getPrimeInterestRate(currencyId);
  if (!interestRates.reverted) {
    pCashSnapshot.supplyInterestRate = interestRates.value.getAnnualSupplyRate();
    pCashSnapshot.debtInterestRate = interestRates.value.getAnnualDebtRatePostFee();
    pCashSnapshot.externalLendingRate = factors.oracleSupplyRate.minus(
      interestRates.value.getAnnualSupplyRate()
    );
  }

  pCashSnapshot.save();

  pCashMarket.current = pCashSnapshot.id;
  pCashMarket.save();

  return pCashMarket;
}

export function setActiveMarkets(
  currencyId: i32,
  block: ethereum.Block,
  txnHash: string | null
): void {
  let activeMarkets = ActiveMarket.load(currencyId.toString());
  if (activeMarkets == null) {
    activeMarkets = new ActiveMarket(currencyId.toString());
    let underlying = getUnderlying(currencyId);
    activeMarkets.underlying = underlying.id;
  }

  activeMarkets.lastUpdateBlockNumber = block.number;
  activeMarkets.lastUpdateTimestamp = block.timestamp.toI32();
  activeMarkets.lastUpdateTransaction = txnHash;

  let notional = getNotional();
  let _activeMarkets = notional.getActiveMarkets(currencyId);
  let activeMarketIds = new Array<string>();
  for (let i = 0; i < _activeMarkets.length; i++) {
    let id = updatefCashMarketWithSnapshot(currencyId, block, txnHash, _activeMarkets[i]);
    activeMarketIds.push(id);
  }
  activeMarkets.fCashMarkets = activeMarketIds;

  let pCashMarket = updatePrimeCashMarket(currencyId, block, txnHash);
  activeMarkets.pCashMarket = pCashMarket.id;

  activeMarkets.save();
}
