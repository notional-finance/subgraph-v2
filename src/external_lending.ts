import { ethereum, BigInt } from "@graphprotocol/graph-ts";
import { CurrencyRebalanced } from "../generated/Configuration/Notional";
import {
  ExternalLending,
  ExternalLendingSnapshot,
  ExternalLendingSnapshotLoader,
  UnderlyingSnapshot,
} from "../generated/schema";
import { getNotional, getUnderlying } from "./common/entities";
import { ERC20 } from "../generated/templates/ERC20Proxy/ERC20";

function getExternalLending(currencyId: i32, block: ethereum.Block): ExternalLending {
  let id = currencyId.toString();
  let entity = ExternalLending.load(id);
  if (entity == null) {
    entity = new ExternalLending(id);
    entity.underlying = getUnderlying(currencyId).id;
    entity.protocolRevenueAllTime = BigInt.zero();
    entity.primeCashRevenueAllTime = BigInt.zero();
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
): ExternalLendingSnapshot {
  let id = currencyId.toString() + ":" + event.transaction.hash.toHexString();
  let notional = getNotional();

  let snapshot = new ExternalLendingSnapshot(id);
  // TODO: get these ABIs
  let holdingsOracle = PrimeCashHoldingsOracle.bind(
    notional.getPrimeCashHoldingsOracle(currencyId)
  );
  let externalLendingToken = holdingsOracle.holdings()[0];

  snapshot.blockNumber = event.block.number.toI32();
  snapshot.timestamp = event.block.timestamp.toI32();
  snapshot.transactionHash = event.transaction.hash;

  // externalLendingToken: Token!

  // balanceOf: BigInt!
  // balanceOfUnderlying: BigInt!
  // storedBalanceOf: BigInt!
  // storedBalanceOfUnderlying: BigInt!

  // protocolRevenueSinceLastSnapshot: BigInt!
  // primeCashRevenueSinceLastSnapshot: BigInt!

  // cooldownTime: Int!
  // withdrawThreshold: Int!
  // targetUtilization: Int!
  // currentUtilization: Int!
  // holdingAvailableToWithdraw: BigInt!

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

  snapshot.externalLending = external.id;
  snapshot.prevSnapshot = external.currentExternal;
  external.currentExternal = snapshot.id;

  external.protocolRevenueAllTime = external.protocolRevenueAllTime.plus(
    snapshot.protocolRevenueSinceLastSnapshot
  );
  external.primeCashRevenueAllTime = external.primeCashRevenueAllTime.plus(
    snapshot.primeCashRevenueSinceLastSnapshot
  );

  external.save();
  snapshot.save();
}
