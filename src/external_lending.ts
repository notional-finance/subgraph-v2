import { ethereum, BigInt } from "@graphprotocol/graph-ts";
import { AssetInterestHarvested, CurrencyRebalanced } from "../generated/Configuration/Notional";
import { ExternalLending, ExternalLendingSnapshot, UnderlyingSnapshot } from "../generated/schema";
import { getNotional, getUnderlying } from "./common/entities";
import { ERC20 } from "../generated/templates/ERC20Proxy/ERC20";
import { PrimeCashHoldingsOracle } from "../generated/Configuration/PrimeCashHoldingsOracle";
import { RATE_PRECISION, SCALAR_PRECISION } from "./common/constants";

function getExternalLending(currencyId: i32, block: ethereum.Block): ExternalLending {
  let id = currencyId.toString();
  let entity = ExternalLending.load(id);
  if (entity == null) {
    entity = new ExternalLending(id);
    entity.underlying = getUnderlying(currencyId).id;
    entity.protocolRevenueAllTime = BigInt.zero();
  }

  entity.lastUpdateBlockNumber = block.number;
  entity.lastUpdateTimestamp = block.timestamp.toI32();

  return entity as ExternalLending;
}

function getUnderlyingSnapshot(currencyId: i32, block: ethereum.Block): UnderlyingSnapshot {
  let id = currencyId.toString() + ":" + block.number.toString();
  let snapshot = new UnderlyingSnapshot(id);
  let underlying = getUnderlying(currencyId);
  let erc20 = ERC20.bind(underlying.tokenAddress);
  let notional = getNotional();

  snapshot.blockNumber = block.number.toI32();
  snapshot.timestamp = block.timestamp.toI32();
  snapshot.balanceOf = erc20.balanceOf(notional._address);
  snapshot.storedBalanceOf = notional.getStoredTokenBalances([underlying.tokenAddress])[0];

  return snapshot;
}

function getExternalLendingSnapshot(
  currencyId: i32,
  event: ethereum.Event
): ExternalLendingSnapshot | null {
  let id = currencyId.toString() + ":" + event.transaction.hash.toHexString();
  let notional = getNotional();

  let snapshot = new ExternalLendingSnapshot(id);
  let holdingsOracle = PrimeCashHoldingsOracle.bind(
    notional.getPrimeCashHoldingsOracle(currencyId)
  );
  let factors = notional.getRebalancingFactors(currencyId);
  snapshot.cooldownTime = factors.getContext().rebalancingCooldownInSeconds.toI32();
  snapshot.withdrawThreshold = factors.getExternalWithdrawThreshold();
  snapshot.targetUtilization = factors.getTarget();
  let primeFactors = notional.getPrimeFactors(currencyId, event.block.timestamp);
  snapshot.currentUtilization = primeFactors
    .getTotalUnderlyingDebt()
    .times(RATE_PRECISION)
    .div(primeFactors.getTotalUnderlyingSupply())
    .toI32();

  let externalLendingToken = factors.getHolding();
  let externalLendingERC20 = ERC20.bind(externalLendingToken);
  let oracleData = holdingsOracle.getOracleData();

  snapshot.blockNumber = event.block.number;
  snapshot.timestamp = event.block.timestamp;
  snapshot.transactionHash = event.transaction.hash;

  snapshot.externalLendingToken = externalLendingToken.toHexString();
  snapshot.storedBalanceOf = notional.getStoredTokenBalances([externalLendingToken])[0];
  snapshot.storedBalanceOfUnderlying = holdingsOracle.holdingValuesInUnderlying()[0];

  let underlyingExchangeRate = snapshot.storedBalanceOfUnderlying
    .times(SCALAR_PRECISION)
    .div(snapshot.storedBalanceOf);
  snapshot.balanceOf = externalLendingERC20.balanceOf(notional._address);
  // This is inferred using the exchange rate since the prime cash holdings oracle is not aware
  // of the actual balanceOf
  snapshot.balanceOfUnderlying = snapshot.balanceOf
    .times(underlyingExchangeRate)
    .div(SCALAR_PRECISION);
  snapshot.holdingAvailableToWithdraw = oracleData.externalUnderlyingAvailableForWithdraw;

  // NOTE: this is set by listening to a different event
  snapshot.protocolInterestHarvested = BigInt.zero();

  return snapshot;
}

export function handleUnderlyingSnapshot(block: ethereum.Block): void {
  // Create UnderlyingSnapshot on a block cadence
  let notional = getNotional();
  let maxCurrencyId = notional.getMaxCurrencyId();

  for (let i = 1; i <= maxCurrencyId; i++) {
    let external = getExternalLending(i, block);
    let snapshot = getUnderlyingSnapshot(i, block);

    snapshot.externalLending = external.id;
    snapshot.prevSnapshot = external.currentUnderlying;
    external.currentUnderlying = snapshot.id;

    external.save();
    snapshot.save();
  }
}

export function handleCurrencyRebalanced(event: CurrencyRebalanced): void {
  let external = getExternalLending(event.params.currencyId, event.block);
  let snapshot = getExternalLendingSnapshot(event.params.currencyId, event);
  if (snapshot == null) return;

  snapshot.externalLending = external.id;
  snapshot.prevSnapshot = external.currentExternal;
  external.currentExternal = snapshot.id;

  if (snapshot.prevSnapshot !== null) {
    let prevSnapshot = ExternalLendingSnapshot.load(snapshot.prevSnapshot as string);
    if (prevSnapshot !== null) {
      snapshot.protocolRevenueSinceLastSnapshot = snapshot.balanceOfUnderlying
        .minus(snapshot.storedBalanceOfUnderlying)
        // This is set on the prev snapshot if interest is harvested
        .plus(prevSnapshot.protocolInterestHarvested)
        .minus(prevSnapshot.balanceOfUnderlying.minus(snapshot.storedBalanceOfUnderlying));

      external.protocolRevenueAllTime = external.protocolRevenueAllTime.plus(
        snapshot.protocolRevenueSinceLastSnapshot
      );
    } else {
      snapshot.protocolRevenueSinceLastSnapshot = BigInt.zero();
      external.protocolRevenueAllTime = BigInt.zero();
    }
  }

  external.save();
  snapshot.save();
}

export function handleInterestHarvested(event: AssetInterestHarvested): void {
  let external = getExternalLending(event.params.currencyId, event.block);
  if (external.currentExternal !== null) {
    let snapshot = ExternalLendingSnapshot.load(external.currentExternal as string);
    if (snapshot !== null) {
      snapshot.protocolInterestHarvested = event.params.harvestAmount;
      snapshot.save();
      external.save();
    }
  }
}
