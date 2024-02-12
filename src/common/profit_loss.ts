import { ethereum, BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import {
  BalanceSnapshot,
  ProfitLossLineItem,
  Token,
  Transfer,
  TransferBundle,
} from "../../generated/schema";
import { getAccount, getAsset, getNotional } from "./entities";
import { getBalance, getBalanceSnapshot, updateAccount } from "../balances";
import {
  Burn,
  INTERNAL_TOKEN_PRECISION,
  Mint,
  PRIME_CASH_VAULT_MATURITY,
  Transfer as _Transfer,
} from "./constants";
import {
  createLineItem,
  createVaultDebtLineItem,
  createVaultShareLineItem,
  createfCashLineItems,
  findPrecedingBundle,
  getfCashAmountRealized,
} from "./pnl/line_item";
import { updateCurrentSnapshotPnL, updateTotalILAndFees } from "./pnl/metrics";
import {
  createIncentiveLineItem,
  setInitialIncentiveSnapshot,
  shouldCreateIncentiveSnapshot,
  updateSnapshotForIncentives,
} from "./pnl/incentives";

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
      // If there is an incentivized token, it has its own snapshot that is already updated
      item.save();
      continue;
    } else if (token.tokenType == "nToken" && snapshot.previousBalance.isZero()) {
      setInitialIncentiveSnapshot(item.account, snapshot, token);
    }

    let setAdjustedCostBasis = true;
    snapshot._accumulatedBalance = snapshot._accumulatedBalance.plus(item.tokenAmount);

    if (item.tokenAmount.isZero()) {
      // Do nothing
    } else if (item.tokenAmount.gt(BigInt.zero())) {
      snapshot._accumulatedCostRealized = snapshot._accumulatedCostRealized.minus(
        // Underlying amount realized is negative in this case
        item.underlyingAmountRealized
      );
    } else {
      // Catches the edge condition (specifically minting nTokens w/ fCash) where the negative
      // tokenAmount appears before the positive token amount and the adjusted cost basis is
      // still initialized to zero.
      if (snapshot.adjustedCostBasis.isZero() && !snapshot._accumulatedBalance.isZero()) {
        snapshot.adjustedCostBasis = item.underlyingAmountRealized
          .neg()
          .times(INTERNAL_TOKEN_PRECISION)
          .div(snapshot._accumulatedBalance);
        // Do not recalculate the adjust cost basis later in the function if this occurs
        // and we need to initialize it.
        setAdjustedCostBasis = false;
      }

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
      // NOTE: _accumulatedCostRealized is not cleared to zero in here. Is that correct?
      snapshot._accumulatedBalance = BigInt.zero();
      snapshot.adjustedCostBasis = BigInt.zero();
      snapshot.currentProfitAndLossAtSnapshot = BigInt.zero();
      snapshot.totalInterestAccrualAtSnapshot = BigInt.zero();
      snapshot.totalILAndFeesAtSnapshot = BigInt.zero();
      snapshot.totalProfitAndLossAtSnapshot = snapshot._accumulatedCostRealized.neg();
      snapshot.impliedFixedRate = null;
    } else {
      if (item.tokenAmount.ge(BigInt.zero())) {
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
      }

      // Adjusted cost basis is in underlying precision and a positive number.
      if (snapshot._accumulatedCostRealized.abs().le(DUST)) {
        snapshot.adjustedCostBasis = BigInt.fromI32(0);
      } else if (setAdjustedCostBasis) {
        snapshot.adjustedCostBasis = snapshot._accumulatedCostRealized
          .times(INTERNAL_TOKEN_PRECISION)
          .div(snapshot._accumulatedBalance);
      }

      // This will update the total IL and fees metric, which is used in the following
      // method to calculate the total interest accrued at the snapshot
      updateTotalILAndFees(snapshot, item);
      updateCurrentSnapshotPnL(snapshot, token, event);
    }

    item.save();
    snapshot.save();
  }
}

function extractProfitLossLineItem(
  bundle: TransferBundle,
  transfers: Transfer[],
  bundleArray: string[],
  event: ethereum.Event
): ProfitLossLineItem[] {
  let lineItems = new Array<ProfitLossLineItem>();
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
  } else if (
    bundle.bundleName == "Transfer Incentive" ||
    bundle.bundleName == "Transfer Secondary Incentive"
  ) {
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

      // If snapshot exists, tokens were claimed via mint or redeem
      let snapshot = BalanceSnapshot.load(snapshotId);
      let nToken = getAsset(nTokenAddress.value.toHexString());
      if (snapshot == null) {
        // If the snapshot does not exist then this is via a manual claim action, this method
        // will check if an incentive snapshot needs to be created.
        if (shouldCreateIncentiveSnapshot(bundle.bundleName, i, transfers[0], event, nToken)) {
          let account = getAccount(transfers[0].to, event);
          let balance = getBalance(account, nToken, event);

          // Creates a new snapshot and updates the current balance
          snapshot = updateAccount(nToken, account, balance, event);

          // Updates the current snapshot PnL figures
          updateCurrentSnapshotPnL(snapshot, nToken, event);
          snapshot.save();
        } else {
          // If not then continue to the next currency id
          continue;
        }
      }

      let incentivesClaimed = updateSnapshotForIncentives(snapshot, transfers[0], nToken);
      // Nothing is created if the incentive claim is zero
      if (!incentivesClaimed.isZero()) {
        createIncentiveLineItem(
          bundle,
          transfers[0],
          incentivesClaimed,
          nTokenAddress.value.toHexString(),
          lineItems
        );
      }
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
