import { CurrencyRebalanced } from "../generated/Configuration/Notional";
import { ExternalLending, UnderlyingSnapshot } from "../generated/schema";
import { getNotional } from "./common/entities";

function getExternalLending(currencyId: i32): ExternalLending {
  let id = currencyId.toString();
  let entity = ExternalLending.load(id);
  if (entity == null) {
    entity = new ExternalLending(id);
  }
}

function getUnderlyingSnapshot(currencyId: i32): UnderlyingSnapshot {}

export function handleUnderlyingSnapshot(block: ethereum.Block): void {
  // Create UnderlyingSnapshot on a block cadence
  let notional = getNotional();
  let maxCurrencyId = notional.getMaxCurrencyId();

  for (let i = 1; i <= maxCurrencyId; i++) {}
}

// Not sure if this is required...
// export function handlePrimeCashOracleUpdate(event: PrimeCashHoldingsOracle): void {}

export function handleCurrencyRebalanced(event: CurrencyRebalanced): void {
  // Create a new snapshot
}
