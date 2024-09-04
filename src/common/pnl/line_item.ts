import { BigInt, ethereum, log } from "@graphprotocol/graph-ts";
import { ProfitLossLineItem, Transfer, TransferBundle } from "../../../generated/schema";
import {
  Burn,
  INTERNAL_TOKEN_PRECISION,
  Mint,
  PRIME_CASH_VAULT_MATURITY,
  RATE_PRECISION,
  SECONDS_IN_YEAR,
  nToken,
} from "../constants";
import { getAsset, getUnderlying } from "../entities";
import { calculateTotalFCashFee } from "../../balances";

export function createLineItem(
  bundle: TransferBundle,
  tokenTransfer: Transfer,
  transferType: string,
  lineItems: ProfitLossLineItem[],
  underlyingAmountRealized: BigInt,
  underlyingAmountSpot: BigInt,
  ratio: BigInt | null = null,
  underlyingAmountForImpliedRate: BigInt | null = null,
  feesPaid: BigInt | null = null
): void {
  let item = new ProfitLossLineItem(bundle.id + ":" + lineItems.length.toString());
  item.bundle = bundle.id;
  item.blockNumber = bundle.blockNumber;
  item.timestamp = bundle.timestamp;
  item.transactionHash = bundle.transactionHash;
  item.token = tokenTransfer.token;
  item.underlyingToken = tokenTransfer.underlying;
  item.feesPaid = feesPaid;

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

  item.spotPrice = underlyingAmountSpot.times(INTERNAL_TOKEN_PRECISION).div(item.tokenAmount).abs();

  let token = getAsset(item.token);
  if (
    token.maturity !== null &&
    (token.maturity as BigInt).notEqual(PRIME_CASH_VAULT_MATURITY) &&
    underlyingAmountForImpliedRate !== null
  ) {
    let underlying = getUnderlying(token.currencyId);
    let realizedPriceForImpliedRate = underlyingAmountForImpliedRate
      .times(INTERNAL_TOKEN_PRECISION)
      .div(item.tokenAmount)
      .abs();
    // Convert the realized price to an implied fixed rate for fixed vault debt
    // and fCash tokens
    let _realizedPriceInRatePrecision = realizedPriceForImpliedRate
      .times(RATE_PRECISION)
      .div(underlying.precision);

    if (_realizedPriceInRatePrecision.lt(BigInt.fromI64(i64.MAX_VALUE))) {
      let realizedPriceInRatePrecision = _realizedPriceInRatePrecision.toI64() as f64;
      let ratePrecision = RATE_PRECISION.toI64() as f64;
      let timeToMaturity = (token.maturity as BigInt).minus(BigInt.fromI32(bundle.timestamp));
      let x: f64 = Math.trunc(
        Math.log(ratePrecision / realizedPriceInRatePrecision) * ratePrecision
      );

      if (isFinite(x)) {
        let r = BigInt.fromI64(x as i64);
        let fixedRate = r.times(SECONDS_IN_YEAR).div(timeToMaturity);
        item.impliedFixedRate = fixedRate;
      }
    }
  }

  lineItems.push(item);
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

export function findPrecedingBundle(name: string, bundleArray: string[]): Transfer[] | null {
  let index = findPrecedingBundleIndex(name, bundleArray);
  if (index == -1) return null;

  let id = bundleArray[index];
  let bundle = TransferBundle.load(id);
  if (bundle == null) return null;

  let transfers = new Array<Transfer>();
  for (let i = 0; i < bundle.transfers.length; i++) {
    let t = Transfer.load(bundle.transfers[i]);
    if (t == null) log.error("Could not load transfer {}", [bundle.transfers[i]]);
    else transfers.push(t);
  }

  return transfers;
}

export function createVaultDebtLineItem(
  bundle: TransferBundle,
  vaultDebt: Transfer,
  lineItems: ProfitLossLineItem[],
  bundleArray: string[]
): void {
  let underlyingDebtAmountRealized: BigInt | null = null;
  let underlyingDebtForImpliedRate: BigInt | null = null;

  if (
    (vaultDebt.maturity as BigInt).equals(PRIME_CASH_VAULT_MATURITY) ||
    // When matured the value in underlying is the settled value which includes the
    // variable debt accrued post maturity.
    (vaultDebt.maturity as BigInt).le(BigInt.fromI32(vaultDebt.timestamp))
  ) {
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
      underlyingDebtForImpliedRate = borrow[0].valueInUnderlying as BigInt;
      underlyingDebtAmountRealized = (borrow[0].valueInUnderlying as BigInt).minus(
        borrow[1].valueInUnderlying as BigInt
      );
      if (
        vaultFees &&
        vaultFees[0].valueInUnderlying !== null &&
        vaultFees[1].valueInUnderlying !== null
      ) {
        underlyingDebtAmountRealized = underlyingDebtAmountRealized
          .minus(vaultFees[0].valueInUnderlying as BigInt)
          .minus(vaultFees[1].valueInUnderlying as BigInt);
      }
    }
  } else if (vaultDebt.transferType == Burn) {
    let lend = findPrecedingBundle("Buy fCash Vault", bundleArray);
    let lendAtZero = findPrecedingBundle("Vault Lend at Zero", bundleArray);

    if (lendAtZero !== null && lendAtZero[0].valueInUnderlying !== null) {
      underlyingDebtAmountRealized = lendAtZero[0].valueInUnderlying;
      underlyingDebtForImpliedRate = lendAtZero[0].valueInUnderlying;
    } else if (
      lend !== null &&
      lend[0].valueInUnderlying !== null &&
      lend[1].valueInUnderlying !== null
    ) {
      underlyingDebtForImpliedRate = lend[0].valueInUnderlying;
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
      vaultDebt.valueInUnderlying as BigInt,
      null,
      underlyingDebtForImpliedRate
    );
  }
}

export function createVaultShareLineItem(
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

export function getfCashAmountRealized(isBuy: boolean, fCashTrade: Transfer[]): BigInt {
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

export function createfCashLineItems(
  bundle: TransferBundle,
  fCashTrade: Transfer[],
  fCashTransfer: Transfer,
  lineItems: ProfitLossLineItem[]
): void {
  let isBuy = fCashTrade[0].toSystemAccount == nToken;
  let ratio: BigInt | null =
    fCashTrade[2].value === fCashTransfer.value.abs()
      ? null
      : fCashTransfer.value.times(RATE_PRECISION).div(fCashTrade[2].value).abs();

  // This is the prime cash transfer
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

  // This is the fCash cash transfer
  let underlyingAmountRealized = getfCashAmountRealized(isBuy, fCashTrade);
  let currencyId = getAsset(fCashTrade[0].token).currencyId;
  let totalFCashFee = calculateTotalFCashFee(currencyId, fCashTrade[0].valueInUnderlying as BigInt);
  createLineItem(
    bundle,
    fCashTransfer,
    isBuy ? Mint : Burn,
    lineItems,
    underlyingAmountRealized,
    fCashTransfer.valueInUnderlying as BigInt,
    ratio,
    fCashTrade[0].valueInUnderlying, // For the implied rate, do not include the fee
    totalFCashFee
  );
}
