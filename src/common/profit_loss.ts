import { ethereum, BigInt, log } from "@graphprotocol/graph-ts";
import { ProfitLossLineItem, Transfer, TransferBundle } from "../../generated/schema";
import { getAccount, getAsset, getNotional } from "./entities";
import { getBalance, getBalanceSnapshot } from "../balances";
import {
  Burn,
  INTERNAL_TOKEN_PRECISION,
  Mint,
  PRIME_CASH_VAULT_MATURITY,
  RATE_PRECISION,
  Transfer as _Transfer,
  nToken,
} from "./constants";
import { convertValueToUnderlying } from "./transfers";

const DUST = BigInt.fromI32(100);

export function processProfitAndLoss(
  bundle: TransferBundle,
  transfers: Transfer[],
  bundleArray: string[],
  event: ethereum.Event
): void {
  let lineItems = extractProfitLossLineItem(bundle, transfers, bundleArray);

  for (let i = 0; i < lineItems.length; i++) {
    let item = lineItems[i];

    let token = getAsset(item.token);
    let underlying = getAsset(token.underlying as string);
    let account = getAccount(item.account, event);
    let balance = getBalance(account, token, event);
    let snapshot = getBalanceSnapshot(balance, event);
    item.balanceSnapshot = snapshot.id;

    snapshot._accumulatedBalance = snapshot._accumulatedBalance.plus(item.tokenAmount);
    // This never gets reset to zero. Accumulated cost is a positive number. underlyingAmountRealized
    // is negative when purchasing tokens, positive when selling so we invert it here.
    snapshot._accumulatedCostRealized = snapshot._accumulatedCostRealized.minus(
      item.underlyingAmountRealized
    );

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
    } else {
      if (item.tokenAmount.ge(BigInt.zero())) {
        // Accumulated cost adjusted basis is a positive number, similar to _accumulatedCostRealized
        snapshot._accumulatedCostAdjustedBasis = snapshot._accumulatedCostAdjustedBasis.minus(
          item.underlyingAmountRealized
        );
      } else {
        snapshot._accumulatedCostAdjustedBasis = snapshot._accumulatedCostAdjustedBasis.plus(
          item.tokenAmount.times(snapshot.adjustedCostBasis).div(INTERNAL_TOKEN_PRECISION)
        );
      }

      // Adjusted cost basis is in underlying precision and a positive number.
      if (snapshot._accumulatedCostRealized.abs().le(DUST)) {
        snapshot.adjustedCostBasis = BigInt.fromI32(0);
      } else {
        snapshot.adjustedCostBasis = snapshot._accumulatedBalance
          .times(underlying.precision)
          .times(underlying.precision)
          .div(snapshot._accumulatedCostRealized)
          .div(INTERNAL_TOKEN_PRECISION);
      }

      let accumulatedBalanceValueAtSpot = convertValueToUnderlying(
        snapshot._accumulatedBalance,
        token,
        event.block.timestamp
      );

      if (accumulatedBalanceValueAtSpot !== null) {
        snapshot.currentProfitAndLossAtSnapshot = accumulatedBalanceValueAtSpot.minus(
          snapshot._accumulatedBalance.times(snapshot.adjustedCostBasis).div(underlying.precision)
        );
        snapshot.totalProfitAndLossAtSnapshot = accumulatedBalanceValueAtSpot.minus(
          snapshot._accumulatedCostRealized
        );

        // Both underlyingAmountSpot and underlyingAmountRealized are negative numbers. Spot prices
        // are higher than realized prices so ILandFees is positive here.
        let ILandFees = item.underlyingAmountRealized.minus(item.underlyingAmountSpot);
        if (ILandFees.ge(BigInt.zero())) {
          snapshot.totalILAndFeesAtSnapshot = snapshot.totalILAndFeesAtSnapshot.plus(ILandFees);
        } else if (snapshot._accumulatedBalance.minus(item.tokenAmount) != BigInt.zero()) {
          let total = snapshot.totalILAndFeesAtSnapshot.plus(ILandFees);
          let ratio = total
            .times(item.tokenAmount)
            .div(snapshot._accumulatedBalance.minus(item.tokenAmount));

          snapshot.totalILAndFeesAtSnapshot = total.plus(
            total.times(ratio).div(underlying.precision)
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
  bundleArray: string[]
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
    //  TODO: bundle.bundleName == "Deposit and Transfer" ||
  } else if (bundle.bundleName == "Transfer Incentive") {
    // Spot price for NOTE does not exist on all chains.
    // Only do a "Mint" here because we don't register an PnL item on the Notional side.
    createLineItem(bundle, transfers[0], Mint, lineItems, BigInt.fromI32(0), BigInt.fromI32(0));
  } else if (bundle.bundleName == "Transfer Asset") {
    // TODO: not clear how to mark direct asset transfers
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
  } else if (bundle.bundleName == "Borrow fCash" || bundle.bundleName == "Repay fCash") {
    let trade = findPrecedingBundle(
      bundle.bundleName == "Borrow fCash" ? "Sell fCash" : "Repay fCash",
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
    // } else if (bundle.bundleName == "Vault Liquidate Excess Cash") {
  }

  return lineItems;
}

function findPrecedingBundle(name: string, bundleArray: string[]): Transfer[] | null {
  for (let i = bundleArray.length - 1; i > -1; i--) {
    // Search the bundle array in reverse order
    let id = bundleArray[i];
    if (!id.endsWith(name)) continue;

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

  return null;
}

function createVaultDebtLineItem(
  bundle: TransferBundle,
  vaultDebt: Transfer,
  lineItems: ProfitLossLineItem[],
  bundleArray: string[]
): void {
  let underlyingDebtAmountRealized: BigInt | null = null;

  if (vaultDebt.maturity === PRIME_CASH_VAULT_MATURITY) {
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
  createLineItem(
    bundle,
    vaultShares,
    vaultShares.transferType,
    lineItems,
    underlyingShareAmountRealized,
    vaultShares.valueInUnderlying as BigInt
  );
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

  let underlyingAmountRealized: BigInt;
  if (isBuy) {
    underlyingAmountRealized = (fCashTrade[0].valueInUnderlying as BigInt).plus(
      fCashTrade[1].valueInUnderlying as BigInt
    );
  } else {
    underlyingAmountRealized = (fCashTrade[0].valueInUnderlying as BigInt).minus(
      fCashTrade[1].valueInUnderlying as BigInt
    );
  }

  createLineItem(
    bundle,
    fCashTransfer,
    // TODO: This will properly negate negative fCash debt transfers [not true, exactly....]
    isBuy ? Mint : Burn,
    lineItems,
    underlyingAmountRealized,
    fCashTransfer.valueInUnderlying as BigInt,
    ratio
  );
}
