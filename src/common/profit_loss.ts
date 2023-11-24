import { ethereum, BigInt, log } from "@graphprotocol/graph-ts";
import {
  BalanceSnapshot,
  ProfitLossLineItem,
  Token,
  Transfer,
  TransferBundle,
} from "../../generated/schema";
import { getAccount, getAsset, getNotional, getUnderlying } from "./entities";
import { getBalance, getBalanceSnapshot } from "../balances";
import {
  Burn,
  INTERNAL_TOKEN_PRECISION,
  Mint,
  PRIME_CASH_VAULT_MATURITY,
  RATE_PRECISION,
  SCALAR_PRECISION,
  SECONDS_IN_YEAR,
  Transfer as _Transfer,
  nToken,
} from "./constants";
import { convertValueToUnderlying } from "./transfers";

const TRANSIENT_DUST = BigInt.fromI32(5000);
const DUST = BigInt.fromI32(100);

export function processProfitAndLoss(
  bundle: TransferBundle,
  transfers: Transfer[],
  bundleArray: string[],
  event: ethereum.Event
): void {
  let lineItems = extractProfitLossLineItem(bundle, transfers, bundleArray, event);

  for (let i = 0; i < lineItems.length; i++) {
    let item = lineItems[i];

    let token: Token;
    if (item.get("incentivizedToken") !== null) {
      token = getAsset(item.incentivizedToken as string);
    } else {
      token = getAsset(item.token);
    }
    let account = getAccount(item.account, event);
    let balance = getBalance(account, token, event);
    let snapshot = getBalanceSnapshot(balance, event);
    item.balanceSnapshot = snapshot.id;

    if (item.get("incentivizedToken") !== null) {
      updateSnapshotForIncentives(snapshot, item);

      snapshot.save();
      item.save();
      continue;
    }

    snapshot._accumulatedBalance = snapshot._accumulatedBalance.plus(item.tokenAmount);
    // This never gets reset to zero. Accumulated cost is a positive number. underlyingAmountRealized
    // is negative when purchasing tokens, positive when selling so we invert it here.
    if (item.tokenAmount.isZero()) {
      // Do nothing
    } else if (item.tokenAmount.gt(BigInt.zero())) {
      snapshot._accumulatedCostRealized = snapshot._accumulatedCostRealized.minus(
        // Underlying amount realized is negative in this case
        item.underlyingAmountRealized
      );
    } else {
      snapshot._accumulatedCostRealized = snapshot._accumulatedCostRealized.minus(
        // Token amount is negative here but this expression is a positive number
        snapshot.adjustedCostBasis.times(item.tokenAmount.neg()).div(INTERNAL_TOKEN_PRECISION)
      );
    }

    // If the change in the snapshot balance is negligible from the previous snapshot then this
    // is a "transient" line item, such as depositing cash before lending fixed or minting nTokens.
    // These only exist to maintain proper internal accounting, so mark it here so that we can filter
    // them out when presenting transaction histories.
    item.isTransientLineItem = snapshot.currentBalance
      .minus(snapshot.previousBalance)
      .abs()
      .le(TRANSIENT_DUST);

    // If sell fcash flips negative clear this to zero...
    if (snapshot._accumulatedBalance.abs().le(DUST)) {
      // Clear all snapshot amounts back to zero if the accumulated balance goes below zero
      snapshot._accumulatedBalance = BigInt.zero();
      snapshot._accumulatedCostAdjustedBasis = BigInt.zero();
      snapshot.adjustedCostBasis = BigInt.zero();
      snapshot.currentProfitAndLossAtSnapshot = BigInt.zero();
      snapshot.totalInterestAccrualAtSnapshot = BigInt.zero();
      snapshot.totalILAndFeesAtSnapshot = BigInt.zero();
      snapshot.totalProfitAndLossAtSnapshot = snapshot._accumulatedCostRealized.neg();
      snapshot.impliedFixedRate = null;
    } else {
      if (item.tokenAmount.ge(BigInt.zero())) {
        // Accumulated cost adjusted basis is a positive number, similar to _accumulatedCostRealized
        snapshot._accumulatedCostAdjustedBasis = snapshot._accumulatedCostAdjustedBasis.minus(
          item.underlyingAmountRealized
        );

        if (item.impliedFixedRate !== null) {
          let prevImpliedFixedRate =
            snapshot.impliedFixedRate !== null
              ? (snapshot.impliedFixedRate as BigInt)
              : BigInt.zero();
          snapshot.impliedFixedRate = snapshot._accumulatedBalance
            .times(prevImpliedFixedRate)
            .plus(
              item.tokenAmount.times((item.impliedFixedRate as BigInt).minus(prevImpliedFixedRate))
            )
            .div(snapshot._accumulatedBalance);
        }
      } else {
        snapshot._accumulatedCostAdjustedBasis = snapshot._accumulatedCostAdjustedBasis.plus(
          item.tokenAmount.times(snapshot.adjustedCostBasis).div(INTERNAL_TOKEN_PRECISION)
        );
      }

      // Adjusted cost basis is in underlying precision and a positive number.
      if (snapshot._accumulatedCostRealized.abs().le(DUST)) {
        snapshot.adjustedCostBasis = BigInt.fromI32(0);
      } else {
        snapshot.adjustedCostBasis = snapshot._accumulatedCostRealized
          .times(INTERNAL_TOKEN_PRECISION)
          .div(snapshot._accumulatedBalance);
      }

      let accumulatedBalanceValueAtSpot = convertValueToUnderlying(
        snapshot._accumulatedBalance,
        token,
        event.block.timestamp
      );

      if (accumulatedBalanceValueAtSpot !== null) {
        snapshot.currentProfitAndLossAtSnapshot = accumulatedBalanceValueAtSpot.minus(
          snapshot.adjustedCostBasis
            .times(snapshot._accumulatedBalance)
            .div(INTERNAL_TOKEN_PRECISION)
        );
        snapshot.totalProfitAndLossAtSnapshot = accumulatedBalanceValueAtSpot.minus(
          snapshot._accumulatedCostRealized
        );

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
            total.times(item.tokenAmount).div(snapshot._accumulatedBalance)
          );
        }

        snapshot.totalInterestAccrualAtSnapshot = snapshot.currentProfitAndLossAtSnapshot.minus(
          snapshot.totalILAndFeesAtSnapshot
        );
      }
    }

    item.save();
    snapshot.save();
  }
}

function updateSnapshotForIncentives(snapshot: BalanceSnapshot, item: ProfitLossLineItem): void {
  snapshot.totalNOTEClaimed = snapshot.totalNOTEClaimed.plus(item.tokenAmount);
  // If the balance increases, add the token amount to the virtual NOTE balance
  snapshot.adjustedNOTEClaimed = snapshot.adjustedNOTEClaimed.plus(item.tokenAmount);

  if (snapshot.previousBalance.gt(snapshot.currentBalance)) {
    // When nTokens are redeemed, we adjust the note earned downwards
    let noteAdjustment = snapshot.previousBalance
      .minus(snapshot.currentBalance)
      .times(INTERNAL_TOKEN_PRECISION)
      .div(snapshot.previousBalance);
    snapshot.adjustedNOTEClaimed = snapshot.adjustedNOTEClaimed.minus(noteAdjustment);
  }
}

function createLineItem(
  bundle: TransferBundle,
  tokenTransfer: Transfer,
  transferType: string,
  lineItems: ProfitLossLineItem[],
  underlyingAmountRealized: BigInt,
  underlyingAmountSpot: BigInt,
  ratio: BigInt | null = null
): void {
  let item = new ProfitLossLineItem(bundle.id + ":" + lineItems.length.toString());
  item.bundle = bundle.id;
  item.blockNumber = bundle.blockNumber;
  item.timestamp = bundle.timestamp;
  item.transactionHash = bundle.transactionHash;
  item.token = tokenTransfer.token;
  item.underlyingToken = tokenTransfer.underlying;

  if (transferType == Mint) {
    item.account = tokenTransfer.to;
    item.tokenAmount = tokenTransfer.value;
    item.underlyingAmountRealized = underlyingAmountRealized.neg();
    item.underlyingAmountSpot = underlyingAmountSpot.neg();
  } else if (transferType == Burn) {
    item.account = tokenTransfer.from;
    item.tokenAmount = tokenTransfer.value.neg();
    item.underlyingAmountRealized = underlyingAmountRealized;
    item.underlyingAmountSpot = underlyingAmountSpot;
  } else {
    log.critical("Unknown transfer type {}", [transferType]);
  }

  // This ratio is used to split fCash transfers between the positive and negative portions
  if (ratio) {
    item.tokenAmount = item.tokenAmount.times(ratio).div(RATE_PRECISION);
    item.underlyingAmountRealized = item.underlyingAmountRealized.times(ratio).div(RATE_PRECISION);
    item.underlyingAmountSpot = item.underlyingAmountSpot.times(ratio).div(RATE_PRECISION);
  }

  // Don't create an inconsequential PnL item
  if (item.tokenAmount == BigInt.zero()) return;

  // Prices are in underlying.precision
  item.realizedPrice = underlyingAmountRealized
    .times(INTERNAL_TOKEN_PRECISION)
    .div(item.tokenAmount)
    .abs();

  item.spotPrice = underlyingAmountSpot
    .times(INTERNAL_TOKEN_PRECISION)
    .div(item.tokenAmount)
    .abs();

  let token = getAsset(item.token);
  if (token.maturity !== null && (token.maturity as BigInt).notEqual(PRIME_CASH_VAULT_MATURITY)) {
    let underlying = getUnderlying(token.currencyId);
    // Convert the realized price to an implied fixed rate for fixed vault debt
    // and fCash tokens
    let realizedPriceInRatePrecision: f64 = item.realizedPrice
      .times(RATE_PRECISION)
      .div(underlying.precision)
      .toI64() as f64;
    let ratePrecision = RATE_PRECISION.toI64() as f64;
    let timeToMaturity = (token.maturity as BigInt).minus(BigInt.fromI32(bundle.timestamp));
    let x: f64 = Math.trunc(Math.log(ratePrecision / realizedPriceInRatePrecision) * ratePrecision);
    if (isFinite(x)) {
      let r = BigInt.fromI64(x as i64);
      let fixedRate = r.times(SECONDS_IN_YEAR).div(timeToMaturity);
      item.impliedFixedRate = fixedRate;
    }
  }

  lineItems.push(item);
}

function createIncentiveLineItem(
  bundle: TransferBundle,
  tokenTransfer: Transfer,
  transferAmount: BigInt,
  incentivizedTokenId: string,
  lineItems: ProfitLossLineItem[]
): void {
  let item = new ProfitLossLineItem(bundle.id + ":" + lineItems.length.toString());
  item.bundle = bundle.id;
  item.blockNumber = bundle.blockNumber;
  item.timestamp = bundle.timestamp;
  item.transactionHash = bundle.transactionHash;
  item.token = tokenTransfer.token;
  item.underlyingToken = tokenTransfer.underlying;

  item.account = tokenTransfer.to;
  item.tokenAmount = transferAmount;
  item.underlyingAmountRealized = BigInt.zero();
  item.underlyingAmountSpot = BigInt.zero();
  item.realizedPrice = BigInt.zero();
  item.spotPrice = BigInt.zero();
  item.isTransientLineItem = false;
  item.incentivizedToken = incentivizedTokenId;

  lineItems.push(item);
}

/**
 * Non-Listed PnL Items
 * Transfer Asset
 * Vault Entry Transfer
 * Vault Secondary Deposit
 *
 * nToken Add Liquidity
 * nToken Remove Liquidity
 * nToken Deleverage
 *
 * Global Settlement
 *
 * Liquidations need to be processed via event emission
 */

function extractProfitLossLineItem(
  bundle: TransferBundle,
  transfers: Transfer[],
  bundleArray: string[],
  event: ethereum.Event
): ProfitLossLineItem[] {
  let lineItems = new Array<ProfitLossLineItem>();
  log.debug("INSIDE BUNDLE {}", [bundle.bundleName]);
  /** Deposits and Withdraws */
  if (bundle.bundleName == "Deposit" || bundle.bundleName == "Withdraw") {
    if (transfers[0].valueInUnderlying !== null) {
      createLineItem(
        bundle,
        transfers[0],
        transfers[0].transferType,
        lineItems,
        transfers[0].valueInUnderlying as BigInt,
        transfers[0].valueInUnderlying as BigInt
      );
    }
    /** Transfers */
  } else if (bundle.bundleName == "Deposit and Transfer") {
    // Deposit / Transfer rewrites and deletes the preceding bundle, so we have
    // to change it the pointer here.
    let depositLineItemId =
      bundle.transactionHash +
      ":" +
      bundle.startLogIndex.toString().padStart(6, "0") +
      ":" +
      bundle.startLogIndex.toString().padStart(6, "0") +
      ":Deposit:0";
    let depositLineItem = ProfitLossLineItem.load(depositLineItemId);

    if (depositLineItem) {
      // NOTE: the deposit line item id itself will not change
      depositLineItem.bundle = bundle.id;
      depositLineItem.save();

      // The original depositor burns their cash balance
      createLineItem(
        bundle,
        transfers[1],
        Burn,
        lineItems,
        transfers[1].valueInUnderlying as BigInt,
        transfers[1].valueInUnderlying as BigInt
      );

      // The receiver of the transfer will mint a balance
      createLineItem(
        bundle,
        transfers[1],
        Mint,
        lineItems,
        transfers[1].valueInUnderlying as BigInt,
        transfers[1].valueInUnderlying as BigInt
      );
    }
  } else if (bundle.bundleName == "Transfer Incentive") {
    // Due to the nature of this update it cannot run twice for a given transaction
    // or the transfers will be double counted.
    let prevTransfer = findPrecedingBundle("Transfer Incentive", bundleArray.slice(0, -1));
    if (prevTransfer !== null) return lineItems;

    let notional = getNotional();
    let maxCurrencyId = notional.getMaxCurrencyId();
    for (let i = 1; i <= maxCurrencyId; i++) {
      // No nToken address available
      let nTokenAddress = notional.try_nTokenAddress(i);
      if (nTokenAddress.reverted) continue;

      let snapshotId =
        transfers[0].to +
        ":" +
        nTokenAddress.value.toHexString() +
        ":" +
        event.block.number.toString();
      // No Snapshot available
      let snapshot = BalanceSnapshot.load(snapshotId);
      if (snapshot == null) continue;

      let accumulatedNOTEPerNToken = notional
        .getNTokenAccount(nTokenAddress.value)
        .getAccumulatedNOTEPerNToken();

      // This is mimics the incentive claim calculation internally
      let incentivesClaimed = snapshot.previousBalance
        .times(accumulatedNOTEPerNToken)
        .div(SCALAR_PRECISION)
        .minus(snapshot.previousNOTEIncentiveDebt);

      createIncentiveLineItem(
        bundle,
        transfers[0],
        incentivesClaimed,
        nTokenAddress.value.toHexString(),
        lineItems
      );
    }
  } else if (bundle.bundleName == "Transfer Asset") {
    // Don't create transfer PnL items if the value is null (happens for NOTE tokens)
    let valueInUnderlying = transfers[0].valueInUnderlying;
    if (valueInUnderlying === null) return lineItems;

    // Creates one line item on the sender and receiver at the current spot price.
    createLineItem(bundle, transfers[0], Mint, lineItems, valueInUnderlying, valueInUnderlying);

    createLineItem(bundle, transfers[0], Burn, lineItems, valueInUnderlying, valueInUnderlying);
    /** Residual Purchase */
  } else if (
    bundle.bundleName == "nToken Purchase Positive Residual" ||
    bundle.bundleName == "nToken Purchase Negative Residual"
  ) {
    // This is the pCash transferred spot price
    let underlyingAmountRealized = transfers[0].valueInUnderlying;
    // This is the fCash oracle value without risk adjustments
    let underlyingAmountSpot = transfers[1].valueInUnderlying;
    if (underlyingAmountRealized !== null && underlyingAmountSpot !== null) {
      // Captures both sized of the prime cash transfer into and out of the nToken
      createLineItem(
        bundle,
        transfers[0],
        Burn,
        lineItems,
        underlyingAmountRealized,
        underlyingAmountRealized
      );

      createLineItem(
        bundle,
        transfers[0],
        Mint,
        lineItems,
        underlyingAmountRealized,
        underlyingAmountRealized
      );

      // Captures both sides of the fCash transfer into and out of the nToken
      createLineItem(
        bundle,
        transfers[1],
        Mint,
        lineItems,
        underlyingAmountRealized,
        underlyingAmountSpot
      );

      createLineItem(
        bundle,
        transfers[1],
        Burn,
        lineItems,
        underlyingAmountRealized,
        underlyingAmountSpot
      );
    }
    /** nToken */
  } else if (bundle.bundleName == "Mint nToken" || bundle.bundleName == "Redeem nToken") {
    // This is the pCash transferred spot price
    let underlyingAmountRealized = transfers[0].valueInUnderlying;
    // This is the nToken PV
    let underlyingAmountSpot = transfers[1].valueInUnderlying;

    if (underlyingAmountRealized !== null && underlyingAmountSpot !== null) {
      // Captures the Prime Cash transfer to the nToken
      createLineItem(
        bundle,
        transfers[0],
        // This is the opposite of the nToken transfer type
        transfers[1].transferType == Mint ? Burn : Mint,
        lineItems,
        underlyingAmountRealized,
        underlyingAmountRealized
      );

      // Captures the nToken amount minted or burned
      createLineItem(
        bundle,
        transfers[1],
        transfers[1].transferType,
        lineItems,
        underlyingAmountRealized,
        underlyingAmountSpot
      );
    }
  } else if (
    /** Settlement */
    bundle.bundleName == "Settle fCash" ||
    bundle.bundleName == "Settle fCash Vault" ||
    bundle.bundleName == "Settle fCash nToken"
  ) {
    let notional = getNotional();
    let token = getAsset(transfers[0].token);
    let settlementValue = notional.try_convertSettledfCash(
      token.currencyId,
      transfers[0].maturity as BigInt,
      transfers[0].value,
      transfers[0].maturity as BigInt
    );
    let underlyingAmountRealized: BigInt | null = null;
    if (!settlementValue.reverted) underlyingAmountRealized = settlementValue.value;
    // This is the fCash at the present value of cash
    let underlyingAmountSpot = transfers[0].valueInUnderlying;

    if (underlyingAmountRealized !== null && underlyingAmountSpot !== null) {
      createLineItem(
        bundle,
        transfers[0],
        transfers[0].transferType,
        lineItems,
        underlyingAmountRealized,
        underlyingAmountSpot
      );
    }
  } else if (bundle.bundleName == "Settle Cash" || bundle.bundleName == "Settle Cash nToken") {
    if (transfers[0].valueInUnderlying !== null) {
      // Settlement Reserve always transfers to the settled account
      createLineItem(
        bundle,
        transfers[0],
        Mint,
        lineItems,
        transfers[0].valueInUnderlying as BigInt,
        transfers[0].valueInUnderlying as BigInt
      );
    }
  } else if (
    /** Borrow Prime Debt */
    bundle.bundleName == "Borrow Prime Cash" ||
    bundle.bundleName == "Repay Prime Cash" ||
    bundle.bundleName == "Borrow Prime Cash Vault" ||
    bundle.bundleName == "Repay Prime Cash Vault"
  ) {
    if (transfers[0].valueInUnderlying !== null && transfers[1].valueInUnderlying !== null) {
      createLineItem(
        bundle,
        // This is a prime debt transfer
        transfers[0],
        transfers[0].transferType,
        lineItems,
        transfers[0].valueInUnderlying as BigInt,
        transfers[0].valueInUnderlying as BigInt
      );

      createLineItem(
        bundle,
        // This is a prime cash transfer
        transfers[1],
        transfers[1].transferType,
        lineItems,
        transfers[1].valueInUnderlying as BigInt,
        transfers[1].valueInUnderlying as BigInt
      );
    }
    /** fCash */
  } else if (bundle.bundleName == "Buy fCash" || bundle.bundleName == "Sell fCash") {
    // NOTE: this section only applies to positive fCash. fCash debt PnL is tracked
    // in a separate if condition below. The tokens transferred here are always
    // positive fCash. These fCash line items may be deleted by the "Borrow fCash" or "Repay fCash"
    // bundles.
    createfCashLineItems(bundle, transfers, transfers[2], lineItems);
  } else if (bundle.bundleName == "nToken Residual Transfer") {
    let positiveResidual = transfers[0].fromSystemAccount == "nToken";
    let trade = findPrecedingBundle(positiveResidual ? "Sell fCash" : "Buy fCash", bundleArray);

    if (trade) {
      // Create line item for the fCash transfer to "undo the trade", negative residuals result
      // in Buy fCash so negate the boolean here.
      let underlyingAmountRealized = getfCashAmountRealized(!positiveResidual, trade);
      let underlyingAmountSpot = transfers[0].valueInUnderlying as BigInt;
      createLineItem(
        bundle,
        transfers[0],
        // This matches the direction of the transfer, the trade was in the opposite
        // direction of the transfer.
        positiveResidual ? Mint : Burn,
        lineItems,
        underlyingAmountRealized,
        underlyingAmountSpot
      );

      let redeem = findPrecedingBundle("Redeem nToken", bundleArray);
      if (redeem) {
        // Create a line item for the nToken redeem to account for the trade pCash
        createLineItem(
          bundle,
          redeem[1],
          Burn,
          lineItems,
          positiveResidual ? underlyingAmountRealized : underlyingAmountRealized.neg(),
          positiveResidual ? underlyingAmountSpot : underlyingAmountSpot.neg()
        );

        // Clear the token amount, realized price and spot price. They are not accurate here. These
        // values are not used in the PnL calculation.
        lineItems[lineItems.length - 1].tokenAmount = BigInt.zero();
        lineItems[lineItems.length - 1].realizedPrice = BigInt.zero();
        lineItems[lineItems.length - 1].spotPrice = BigInt.zero();
      }
    } else {
      // Create line item for the fCash transfer
      createLineItem(
        bundle,
        transfers[0],
        // This matches the direction of the transfer, the trade was in the opposite
        // direction of the transfer.
        positiveResidual ? Mint : Burn,
        lineItems,
        transfers[0].valueInUnderlying as BigInt,
        transfers[0].valueInUnderlying as BigInt
      );
    }
  } else if (bundle.bundleName == "Borrow fCash" || bundle.bundleName == "Repay fCash") {
    let trade = findPrecedingBundle(
      bundle.bundleName == "Borrow fCash" ? "Sell fCash" : "Buy fCash",
      bundleArray
    );

    if (trade) {
      let underlyingAmountRealized = (trade[0].valueInUnderlying as BigInt)
        .plus(
          bundle.bundleName == "Borrow fCash"
            ? (trade[1].valueInUnderlying as BigInt).neg()
            : (trade[1].valueInUnderlying as BigInt)
        )
        .times(transfers[0].value)
        .div(trade[2].value);

      createLineItem(
        bundle,
        transfers[0],
        transfers[0].transferType,
        lineItems,
        underlyingAmountRealized,
        transfers[0].valueInUnderlying as BigInt
      );

      createLineItem(
        bundle,
        transfers[1],
        transfers[1].transferType,
        lineItems,
        underlyingAmountRealized,
        transfers[1].valueInUnderlying as BigInt
      );
    }
    /** Vaults */
  } else if (bundle.bundleName == "Vault Entry") {
    // vault debt minted
    createVaultDebtLineItem(bundle, transfers[0], lineItems, bundleArray);
    let vaultEntry = findPrecedingBundle("Vault Entry Transfer", bundleArray);
    if (vaultEntry !== null && vaultEntry[0].valueInUnderlying !== null) {
      createVaultShareLineItem(
        bundle,
        transfers[1],
        lineItems,
        // Value of underlying transferred to the vault to mint vault shares
        vaultEntry[0].valueInUnderlying as BigInt
      );
    }
  } else if (bundle.bundleName == "Vault Exit") {
    // vault debt burned
    createVaultDebtLineItem(bundle, transfers[0], lineItems, bundleArray);
    let vaultRedeem = findPrecedingBundle("Vault Redeem", bundleArray);
    if (vaultRedeem !== null && vaultRedeem[0].valueInUnderlying !== null) {
      createVaultShareLineItem(
        bundle,
        transfers[1],
        lineItems,
        // Value of underlying transferred to the vault to burn vault shares
        vaultRedeem[0].valueInUnderlying as BigInt
      );
    } else if ((transfers[1].maturity as BigInt) == PRIME_CASH_VAULT_MATURITY) {
      // If the vault redeem is not found, then the account was deleveraged.
      let vaultDeleverage = findPrecedingBundle("Vault Deleverage Prime Debt", bundleArray);

      if (vaultDeleverage !== null) {
        createVaultShareLineItem(
          bundle,
          transfers[1],
          lineItems,
          // The first transfer in the deleverage transaction is the underlying amount
          // paid to purchase the vault shares
          vaultDeleverage[0].valueInUnderlying as BigInt
        );
      }
    } else {
      let vaultDeleverage = findPrecedingBundle("Vault Deleverage fCash", bundleArray);
      if (vaultDeleverage !== null) {
        // Creates the vault cash line item on the liquidated account
        createLineItem(
          bundle,
          vaultDeleverage[0],
          vaultDeleverage[0].transferType,
          lineItems,
          vaultDeleverage[0].valueInUnderlying as BigInt,
          vaultDeleverage[0].valueInUnderlying as BigInt
        );

        createVaultShareLineItem(
          bundle,
          transfers[1],
          lineItems,
          // The first transfer in the deleverage transaction is the underlying amount
          // paid to purchase the vault shares
          vaultDeleverage[0].valueInUnderlying as BigInt
        );
      }
    }
  } else if (bundle.bundleName == "Vault Roll" || bundle.bundleName == "Vault Settle") {
    // TODO: there are rewrites and cash settlement to worry about inside here.

    // Find the entry transfer bundle immediately preceding
    let vaultEntry = findPrecedingBundle("Vault Entry Transfer", bundleArray);
    // vault share burned at oracle price
    createVaultShareLineItem(
      bundle,
      transfers[1],
      lineItems,
      transfers[1].valueInUnderlying as BigInt
    );
    // vault shares created
    if (vaultEntry !== null && vaultEntry[0].valueInUnderlying !== null) {
      createVaultShareLineItem(
        bundle,
        transfers[3],
        lineItems,
        (transfers[1].valueInUnderlying as BigInt).plus(vaultEntry[0].valueInUnderlying as BigInt)
      );
    } else {
      createVaultShareLineItem(
        bundle,
        transfers[3],
        lineItems,
        transfers[1].valueInUnderlying as BigInt
      );
    }
    // vault debt burned
    createVaultDebtLineItem(bundle, transfers[0], lineItems, bundleArray);
    // new vault debt
    createVaultDebtLineItem(bundle, transfers[2], lineItems, bundleArray);
    /* Vault Liquidation */
  } else if (
    bundle.bundleName == "Vault Deleverage fCash" ||
    bundle.bundleName == "Vault Deleverage Prime Debt"
  ) {
    // These are the vault shares transferred to the liquidator, the value is the
    // amount of cash paid for the vault shares.
    createLineItem(
      bundle,
      transfers[1],
      Mint,
      lineItems,
      // This is the value of cash paid for shares
      transfers[0].valueInUnderlying as BigInt,
      transfers[1].valueInUnderlying as BigInt
    );
  } else if (bundle.bundleName == "Vault Liquidate Cash") {
    // Liquidator Receives Cash
    createLineItem(
      bundle,
      transfers[0],
      Mint,
      lineItems,
      transfers[0].valueInUnderlying as BigInt,
      transfers[0].valueInUnderlying as BigInt
    );

    // Liquidator Burns fCash
    createLineItem(
      bundle,
      transfers[1],
      Burn,
      lineItems,
      // Realized value is the amount of cash received
      transfers[0].valueInUnderlying as BigInt,
      // Spot Value is the value of fCash
      transfers[1].valueInUnderlying as BigInt
    );

    // Liquidated Burns Vault Debt
    createLineItem(
      bundle,
      transfers[2],
      transfers[2].transferType,
      lineItems,
      // Realized value is the amount of cash burned
      transfers[3].valueInUnderlying as BigInt,
      // Spot Value is the value of fCash
      transfers[2].valueInUnderlying as BigInt
    );

    // Liquidated Burns Vault Cash at Par
    createLineItem(
      bundle,
      transfers[3],
      transfers[3].transferType,
      lineItems,
      transfers[3].valueInUnderlying as BigInt,
      transfers[3].valueInUnderlying as BigInt
    );
  } else if (bundle.bundleName == "Vault Liquidate Excess Cash") {
    // Liquidator receives cash from vault
    createLineItem(
      bundle,
      transfers[0],
      Mint,
      lineItems,
      transfers[0].valueInUnderlying as BigInt,
      transfers[0].valueInUnderlying as BigInt
    );

    // Liquidator withdraws cash
    createLineItem(
      bundle,
      transfers[1],
      transfers[1].transferType,
      lineItems,
      transfers[1].valueInUnderlying as BigInt,
      transfers[1].valueInUnderlying as BigInt
    );

    // Vault account burns cash
    createLineItem(
      bundle,
      transfers[2],
      transfers[2].transferType,
      lineItems,
      transfers[2].valueInUnderlying as BigInt,
      transfers[2].valueInUnderlying as BigInt
    );

    // Liquidator deposits and transfers cash to vault in 3 and 4, we don't track vault PnL
    // so those don't get logged here.

    // Vault account mints cash in a different currency
    createLineItem(
      bundle,
      transfers[5],
      transfers[5].transferType,
      lineItems,
      transfers[5].valueInUnderlying as BigInt,
      transfers[5].valueInUnderlying as BigInt
    );
  }

  return lineItems;
}

function findPrecedingBundleIndex(name: string, bundleArray: string[]): i32 {
  for (let i = bundleArray.length - 1; i > -1; i--) {
    // Search the bundle array in reverse order
    let id = bundleArray[i];
    if (!id.endsWith(name)) continue;

    return i;
  }

  return -1;
}

function findPrecedingBundle(name: string, bundleArray: string[]): Transfer[] | null {
  let index = findPrecedingBundleIndex(name, bundleArray);
  if (index == -1) return null;

  let id = bundleArray[index];
  let bundle = TransferBundle.load(id);
  if (bundle === null) return null;

  let transfers = new Array<Transfer>();
  for (let i = 0; i < bundle.transfers.length; i++) {
    let t = Transfer.load(bundle.transfers[i]);
    if (t === null) log.error("Could not load transfer {}", [bundle.transfers[i]]);
    else transfers.push(t);
  }

  return transfers;
}

function createVaultDebtLineItem(
  bundle: TransferBundle,
  vaultDebt: Transfer,
  lineItems: ProfitLossLineItem[],
  bundleArray: string[]
): void {
  let underlyingDebtAmountRealized: BigInt | null = null;

  if ((vaultDebt.maturity as BigInt).equals(PRIME_CASH_VAULT_MATURITY)) {
    underlyingDebtAmountRealized = vaultDebt.valueInUnderlying as BigInt;
  } else if (vaultDebt.transferType == Mint) {
    // If this is an fCash then look for the traded fCash value
    let borrow = findPrecedingBundle("Sell fCash Vault", bundleArray);
    let vaultFees = findPrecedingBundle("Vault Fees", bundleArray);

    if (
      borrow !== null &&
      borrow[0].valueInUnderlying !== null &&
      borrow[1].valueInUnderlying !== null
    ) {
      underlyingDebtAmountRealized = (borrow[0].valueInUnderlying as BigInt).minus(
        borrow[1].valueInUnderlying as BigInt
      );
      if (
        vaultFees &&
        vaultFees[0].valueInUnderlying !== null &&
        vaultFees[0].valueInUnderlying !== null
      ) {
        underlyingDebtAmountRealized = underlyingDebtAmountRealized
          .minus(vaultFees[0].valueInUnderlying as BigInt)
          .minus(vaultFees[0].valueInUnderlying as BigInt);
      }
    }
  } else if (vaultDebt.transferType == Burn) {
    let lend = findPrecedingBundle("Buy fCash Vault", bundleArray);
    let lendAtZero = findPrecedingBundle("Vault Lend at Zero", bundleArray);

    if (lendAtZero !== null && lendAtZero[0].valueInUnderlying !== null) {
      underlyingDebtAmountRealized = lendAtZero[0].valueInUnderlying;
    } else if (
      lend !== null &&
      lend[0].valueInUnderlying !== null &&
      lend[1].valueInUnderlying !== null
    ) {
      underlyingDebtAmountRealized = (lend[0].valueInUnderlying as BigInt).plus(
        lend[1].valueInUnderlying as BigInt
      );
    }
  }

  if (underlyingDebtAmountRealized !== null) {
    createLineItem(
      bundle,
      vaultDebt,
      vaultDebt.transferType,
      lineItems,
      underlyingDebtAmountRealized,
      vaultDebt.valueInUnderlying as BigInt
    );
  }
}

function createVaultShareLineItem(
  bundle: TransferBundle,
  vaultShares: Transfer,
  lineItems: ProfitLossLineItem[],
  underlyingShareAmountRealized: BigInt
): void {
  let underlyingShareAmountSpot: BigInt;
  // In some cases, the spot price cannot be calculated via the contract. Just use the underlying
  // share amount realized instead. This will mark the ILandFees value at 0.
  if (vaultShares.valueInUnderlying === null) {
    underlyingShareAmountSpot = underlyingShareAmountRealized;
  } else {
    underlyingShareAmountSpot = vaultShares.valueInUnderlying as BigInt;
  }

  createLineItem(
    bundle,
    vaultShares,
    vaultShares.transferType,
    lineItems,
    underlyingShareAmountRealized,
    underlyingShareAmountSpot
  );
}

function getfCashAmountRealized(isBuy: boolean, fCashTrade: Transfer[]): BigInt {
  if (isBuy) {
    return (fCashTrade[0].valueInUnderlying as BigInt).plus(
      fCashTrade[1].valueInUnderlying as BigInt
    );
  } else {
    return (fCashTrade[0].valueInUnderlying as BigInt).minus(
      fCashTrade[1].valueInUnderlying as BigInt
    );
  }
}

function createfCashLineItems(
  bundle: TransferBundle,
  fCashTrade: Transfer[],
  fCashTransfer: Transfer,
  lineItems: ProfitLossLineItem[]
): void {
  let isBuy = fCashTrade[0].toSystemAccount == nToken;
  let ratio: BigInt | null =
    fCashTrade[2].value === fCashTransfer.value.abs()
      ? null
      : fCashTransfer.value
          .times(RATE_PRECISION)
          .div(fCashTrade[2].value)
          .abs();

  createLineItem(
    bundle,
    fCashTrade[0],
    isBuy ? Burn : Mint,
    lineItems,
    fCashTrade[0].valueInUnderlying as BigInt,
    fCashTrade[0].valueInUnderlying as BigInt,
    ratio
  );

  // prime cash fee transfer
  createLineItem(
    bundle,
    fCashTrade[1],
    Burn,
    lineItems,
    fCashTrade[1].valueInUnderlying as BigInt,
    fCashTrade[1].valueInUnderlying as BigInt,
    ratio
  );

  let underlyingAmountRealized = getfCashAmountRealized(isBuy, fCashTrade);
  createLineItem(
    bundle,
    fCashTransfer,
    isBuy ? Mint : Burn,
    lineItems,
    underlyingAmountRealized,
    fCashTransfer.valueInUnderlying as BigInt,
    ratio
  );
}
