import { ethereum, BigInt } from "@graphprotocol/graph-ts";
import { BalanceSnapshot, ProfitLossLineItem, Token } from "../../../generated/schema";
import { convertValueToUnderlying } from "../transfers";
import { INTERNAL_TOKEN_PRECISION } from "../constants";

export const TRANSIENT_DUST = BigInt.fromI32(5000);

/** Updates IL and Fee figures after trading */
export function updateTotalILAndFees(snapshot: BalanceSnapshot, item: ProfitLossLineItem): void {
  // Both underlyingAmountSpot and underlyingAmountRealized are negative numbers. Spot prices
  // are higher than realized prices so ILandFees is positive here.
  let ILandFees = item.underlyingAmountRealized.minus(item.underlyingAmountSpot);
  if (ILandFees.ge(BigInt.zero())) {
    snapshot.totalILAndFeesAtSnapshot = snapshot.totalILAndFeesAtSnapshot.plus(ILandFees);
  } else if (
    snapshot._accumulatedBalance
      .minus(item.tokenAmount)
      .abs()
      .gt(TRANSIENT_DUST) &&
    // NOTE: for nToken residuals this will not compute IL and fees properly
    !item.tokenAmount.isZero()
  ) {
    // Equation here should be:
    // newTotal = totalILAndFeesAtSnapshot * (1 + tokenAmount / accumulatedBalance)
    // or
    // newTotal = totalILAndFeesAtSnapshot + (totalILAndFeesAtSnapshot * tokenAmount / accumulatedBalance)
    let total = snapshot.totalILAndFeesAtSnapshot.plus(ILandFees);

    snapshot.totalILAndFeesAtSnapshot = total.plus(
      total.times(item.tokenAmount).div(snapshot._accumulatedBalance.minus(item.tokenAmount))
    );
  }
}

/** Updates current snapshot PnL figures */
export function updateCurrentSnapshotPnL(
  snapshot: BalanceSnapshot,
  token: Token,
  event: ethereum.Event
): void {
  let accumulatedBalanceValueAtSpot = convertValueToUnderlying(
    snapshot._accumulatedBalance,
    token,
    event.block.timestamp
  );

  if (accumulatedBalanceValueAtSpot !== null) {
    snapshot.currentProfitAndLossAtSnapshot = accumulatedBalanceValueAtSpot.minus(
      snapshot.adjustedCostBasis.times(snapshot._accumulatedBalance).div(INTERNAL_TOKEN_PRECISION)
    );
    snapshot.totalProfitAndLossAtSnapshot = accumulatedBalanceValueAtSpot.minus(
      snapshot._accumulatedCostRealized
    );
    snapshot.totalInterestAccrualAtSnapshot = snapshot.currentProfitAndLossAtSnapshot.minus(
      snapshot.totalILAndFeesAtSnapshot
    );
  }
}
