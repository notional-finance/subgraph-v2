import { ethereum, BigInt } from "@graphprotocol/graph-ts";
import { BalanceSnapshot, ProfitLossLineItem, Token } from "../../../generated/schema";
import { convertValueToUnderlying } from "../transfers";
import {
  INTERNAL_TOKEN_PRECISION,
  PRIME_CASH_VAULT_MATURITY,
  PrimeCash,
  PrimeDebt,
  RATE_PRECISION,
  SECONDS_IN_YEAR,
  VaultDebt,
  VaultShare,
  VaultShareInterestAccrued,
  fCash,
  nToken,
  nTokenInterestAccrued,
} from "../constants";
import { getOracle, getUnderlying } from "../entities";

export const TRANSIENT_DUST = BigInt.fromI32(5000);

/** Updates IL and Fee figures after trading */
export function updateTotalILAndFees(snapshot: BalanceSnapshot, item: ProfitLossLineItem): void {
  // Both underlyingAmountSpot and underlyingAmountRealized are negative numbers. Spot prices
  // are higher than realized prices so ILandFees is positive here.
  let ILandFees = item.underlyingAmountRealized.minus(item.underlyingAmountSpot);
  if (ILandFees.ge(BigInt.zero())) {
    snapshot.totalILAndFeesAtSnapshot = snapshot.totalILAndFeesAtSnapshot.plus(ILandFees);
  } else if (
    snapshot._accumulatedBalance.minus(item.tokenAmount).abs().gt(TRANSIENT_DUST) &&
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
  event: ethereum.Event,
  item: ProfitLossLineItem | null
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

    if (token.tokenType == nToken || token.tokenType == VaultShare) {
      let base = getUnderlying(token.currencyId);
      let oracle = getOracle(
        base,
        token,
        token.tokenType == nToken ? nTokenInterestAccrued : VaultShareInterestAccrued
      );

      // For the nToken and vault shares, the interest accumulator is the latest rate that
      // we've seen for the total interest accrued.
      let lastInterestAccumulator =
        snapshot._lastInterestAccumulator !== null
          ? snapshot._lastInterestAccumulator
          : oracle.latestRate;

      if (oracle.latestRate !== null && lastInterestAccumulator !== null) {
        if (
          snapshot.currentBalance.lt(snapshot.previousBalance) &&
          !snapshot.previousBalance.isZero()
        ) {
          // totalInterestAccrual += (latestAccumulator - lastInterestAccumulator) * currentBalance / prevBalance
          snapshot.totalInterestAccrualAtSnapshot = snapshot.totalInterestAccrualAtSnapshot.plus(
            // latestRate and lastInterestAccumulator are both in underlying precision here
            (oracle.latestRate as BigInt)
              .minus(lastInterestAccumulator)
              .times(snapshot.currentBalance)
              .div(snapshot.previousBalance)
          );
        } else {
          // totalInterestAccrual += (latestAccumulator - lastInterestAccumulator) * prevBalance
          snapshot.totalInterestAccrualAtSnapshot = snapshot.totalInterestAccrualAtSnapshot.plus(
            // latestRate and lastInterestAccumulator are both in underlying precision here
            (oracle.latestRate as BigInt)
              .minus(lastInterestAccumulator)
              .times(snapshot.previousBalance)
              .div(INTERNAL_TOKEN_PRECISION)
          );
        }
        snapshot._lastInterestAccumulator = oracle.latestRate as BigInt;
      }
    } else if (
      token.tokenType == fCash ||
      (token.tokenType == VaultDebt && (token.maturity as BigInt) != PRIME_CASH_VAULT_MATURITY)
    ) {
      let prevSnapshot = snapshot.previousSnapshot
        ? BalanceSnapshot.load(snapshot.previousSnapshot as string)
        : null;

      if (prevSnapshot !== null && !snapshot.previousBalance.isZero()) {
        // For fCash, _lastInterestAccumulator is the amount of interest that the position would accrue
        // over an entire year, in here we just need to scale it down. accruedInterest is in underlying
        // precision here, so is totalInterestAccrualAtSnapshot
        let accruedInterest = snapshot._lastInterestAccumulator
          .times(
            event.block.timestamp.minus(BigInt.fromI32((prevSnapshot as BalanceSnapshot).timestamp))
          )
          .div(SECONDS_IN_YEAR);
        snapshot.totalInterestAccrualAtSnapshot =
          snapshot.totalInterestAccrualAtSnapshot.plus(accruedInterest);
      }

      if (item && item.impliedFixedRate !== null) {
        snapshot._lastInterestAccumulator = snapshot._lastInterestAccumulator.plus(
          (item.impliedFixedRate as BigInt)
            .times(item.underlyingAmountRealized.neg())
            .div(RATE_PRECISION)
        );
      }
    } else if (
      token.tokenType == PrimeCash ||
      token.tokenType == PrimeDebt ||
      (token.tokenType == VaultDebt && (token.maturity as BigInt) == PRIME_CASH_VAULT_MATURITY)
    ) {
      // For variable rates, the entire PnL is interest accrual
      snapshot.totalInterestAccrualAtSnapshot = snapshot.currentProfitAndLossAtSnapshot;
    }
  }
}
