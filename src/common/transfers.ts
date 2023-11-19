import { Address, ethereum, BigInt, log, Bytes, store } from "@graphprotocol/graph-ts";
import { ProfitLossLineItem, Token, Transfer } from "../../generated/schema";
import { IStrategyVault } from "../../generated/Transactions/IStrategyVault";
import { ERC4626 } from "../../generated/Transactions/ERC4626";
import {
  fCash,
  INTERNAL_TOKEN_PRECISION,
  NOTE,
  nToken,
  PrimeCash,
  PrimeDebt,
  PRIME_CASH_VAULT_MATURITY,
  VaultCash,
  VaultDebt,
  VaultShare,
  ZERO_ADDRESS,
  RATE_PRECISION,
  SECONDS_IN_YEAR,
  AssetCash,
  ASSET_RATE_DECIMAL_DIFFERENCE,
} from "./constants";
import {
  createTransferBundle,
  getAccount,
  getNotional,
  getNotionalV2,
  getTransaction,
  getUnderlying,
  isV2,
} from "./entities";
import { BundleCriteria } from "./bundles";
import { processProfitAndLoss } from "./profit_loss";
import {
  calculateNTokenValue,
  calculateSettledfCashValue,
  calculateifCashPresentValue,
} from "../v2/v2_utils";

export function getExpFactor(rateInRatePrecision: BigInt, timeToMaturity: BigInt): f64 {
  return (
    (rateInRatePrecision
      .times(timeToMaturity)
      .div(RATE_PRECISION)
      .toI64() as f64) / (SECONDS_IN_YEAR.toI64() as f64)
  );
}

export function decodeTransferType(from: Address, to: Address): string {
  if (from == ZERO_ADDRESS) {
    return "Mint";
  } else if (to == ZERO_ADDRESS) {
    return "Burn";
  } else {
    return "Transfer";
  }
}

export function decodeSystemAccount(addr: Address, event: ethereum.Event): string {
  let account = getAccount(addr.toHexString(), event);
  return account.systemAccountType;
}

export function convertValueToUnderlying(
  value: BigInt,
  token: Token,
  blockTime: BigInt
): BigInt | null {
  // There is no corresponding underlying for NOTE so just return null
  if (token.tokenType == NOTE) return null;

  let notional = getNotional();
  let currencyId = token.currencyId as i32;
  let underlyingExternal: ethereum.CallResult<BigInt>;

  if (token.tokenType == nToken) {
    underlyingExternal = notional.try_convertNTokenToUnderlying(currencyId, value);

    if (underlyingExternal.reverted && isV2()) {
      // Convert nToken to Underlying does not exist in V3
      return calculateNTokenValue(currencyId, token, value);
    }
  } else if (
    token.tokenType == PrimeDebt ||
    (token.tokenType == VaultDebt &&
      token.get("maturity") != null &&
      (token.maturity as BigInt) == PRIME_CASH_VAULT_MATURITY)
  ) {
    let pDebtAddress = notional.pDebtAddress(currencyId);
    let pDebt = ERC4626.bind(pDebtAddress);
    underlyingExternal = pDebt.try_convertToAssets(value.abs());
  } else if (token.tokenType == PrimeCash || token.tokenType == VaultCash) {
    underlyingExternal = notional.try_convertCashBalanceToExternal(currencyId, value, true);
  } else if (
    token.tokenType == fCash ||
    (token.tokenType == VaultDebt &&
      token.get("maturity") != null &&
      (token.maturity as BigInt).notEqual(PRIME_CASH_VAULT_MATURITY))
  ) {
    if ((token.maturity as BigInt) <= blockTime) {
      // If the fCash has matured then get the settled value
      underlyingExternal = notional.try_convertSettledfCash(
        currencyId,
        token.maturity as BigInt,
        value,
        blockTime
      );

      if (underlyingExternal.reverted && isV2()) {
        return calculateSettledfCashValue(currencyId, token, value);
      }
    } else {
      let activeMarkets = notional.getActiveMarkets(currencyId);
      for (let i = 0; i < activeMarkets.length; i++) {
        if (activeMarkets[i].maturity == (token.maturity as BigInt)) {
          let lastImpliedRate = activeMarkets[i].lastImpliedRate;
          let timeToMaturity = (token.maturity as BigInt).minus(blockTime);
          let x: f64 = getExpFactor(lastImpliedRate, timeToMaturity);
          let discountFactor = BigInt.fromI64(
            Math.floor(Math.exp(-x) * (RATE_PRECISION.toI64() as f64)) as i64
          );
          let underlying = getUnderlying(currencyId);

          return value
            .times(discountFactor)
            .times(underlying.precision)
            .div(RATE_PRECISION)
            .div(INTERNAL_TOKEN_PRECISION);
        }
      }

      // NOTE: if the search falls through to this point, use the oracle value b/c
      // the fCash is idiosyncratic
      underlyingExternal = notional.try_getPresentfCashValue(
        currencyId,
        token.maturity as BigInt,
        value,
        blockTime,
        false
      );

      if (underlyingExternal.reverted && isV2()) {
        return calculateifCashPresentValue(currencyId, token, value, activeMarkets);
      }
    }

    if (!underlyingExternal.reverted) {
      // Scale to external decimals
      let underlying = getUnderlying(currencyId);
      return underlyingExternal.value.times(underlying.precision).div(INTERNAL_TOKEN_PRECISION);
    }
  } else if (token.tokenType == VaultShare) {
    let vault = IStrategyVault.bind(Address.fromBytes(token.vaultAddress as Bytes));
    underlyingExternal = vault.try_convertStrategyToUnderlying(
      Address.fromBytes(token.vaultAddress as Bytes),
      value,
      token.maturity as BigInt
    );
    if (underlyingExternal.reverted) {
      // Sometimes when the vault clears, the convertStrategyToUnderlying will fail on a
      // divide by zero error. In this case we just use the spot exchange rate for the
      // underlying value.
      let exchangeRate = vault.try_getExchangeRate(token.maturity as BigInt);
      if (!exchangeRate.reverted) {
        let underlying = getUnderlying(currencyId);
        return value.times(exchangeRate.value).div(underlying.precision);
      }
    }
  } else if (token.tokenType == AssetCash) {
    let notionalV2 = getNotionalV2();
    let assetRate = notionalV2.try_getCurrencyAndRates(currencyId);
    if (!assetRate.reverted) {
      let underlying = getUnderlying(currencyId);
      let rate = assetRate.value.getAssetRate().rate;
      return value
        .times(rate)
        .div(ASSET_RATE_DECIMAL_DIFFERENCE)
        .div(underlying.precision);
    }

    // Some times getCurrencyAndRates reverts
    return BigInt.zero();
  } else {
    // Unknown token type
    return null;
  }

  return underlyingExternal.reverted ? null : underlyingExternal.value;
}

export function processTransfer(transfer: Transfer, event: ethereum.Event): void {
  let txn = getTransaction(event);

  let transferArray = txn._transfers as string[];
  let bundleArray = txn._transferBundles as string[];

  // Append the transfer to the transfer array
  transferArray.push(transfer.id);
  transfer.save();

  // Scan unbundled transfers
  txn._nextStartIndex = scanTransferBundle(txn._nextStartIndex, transferArray, bundleArray, event);
  txn._transferBundles = bundleArray;
  txn._transfers = transferArray;
  txn.save();
}

function scanTransferBundle(
  startIndex: i32,
  transferArray: string[],
  bundleArray: string[],
  event: ethereum.Event
): i32 {
  for (let i = 0; i < BundleCriteria.length; i++) {
    let criteria = BundleCriteria[i];
    // Go to the next criteria if the window size does not match
    if (transferArray.length - startIndex < criteria.windowSize) continue;

    let lookBehind = criteria.lookBehind;
    // Check if the lookbehind is satisfied
    if (startIndex < lookBehind) {
      if (criteria.canStart && startIndex == 0) {
        // If the criteria can start, then set the look behind to zero
        lookBehind = 0;
      } else {
        // Have not satisfied the lookbehind, go to the next criteria
        continue;
      }
    }

    let window = transferArray
      .slice(startIndex - lookBehind, startIndex + criteria.windowSize)
      .map<Transfer>((transferId: string) => {
        // The transfer must always be found at this point
        let t = Transfer.load(transferId);
        if (t == null) log.critical("{} transfer id not found", [transferId]);
        return t as Transfer;
      });

    if (criteria.func(window)) {
      let windowStartIndex = criteria.rewrite ? 0 : lookBehind;
      let windowEndIndex = lookBehind + criteria.bundleSize - 1;
      let startLogIndex = window[windowStartIndex].logIndex;
      let endLogIndex = window[windowEndIndex].logIndex;
      let txnHash = event.transaction.hash.toHexString();
      let bundle = createTransferBundle(txnHash, criteria.bundleName, startLogIndex, endLogIndex);
      bundle.blockNumber = event.block.number;
      bundle.timestamp = event.block.timestamp.toI32();
      bundle.transactionHash = txnHash;
      bundle.bundleName = criteria.bundleName;
      bundle.startLogIndex = startLogIndex;
      bundle.endLogIndex = endLogIndex;

      let bundleTransfers = new Array<string>();
      let transfers = new Array<Transfer>();
      for (let i = windowStartIndex; i <= windowEndIndex; i++) {
        // Update the bundle id on all the transfers
        bundleTransfers.push(window[i].id);
        transfers.push(window[i]);
      }

      if (criteria.rewrite) {
        let oldBundle = bundleArray.pop();
        if (oldBundle) {
          store.remove("TransferBundle", oldBundle);

          // Remove any linked profit loss line items
          let lineItem = 0;
          while (lineItem < 256) {
            let id = oldBundle + ":" + lineItem.toString();
            let item = ProfitLossLineItem.load(id);
            if (item) {
              store.remove("ProfitLossLineItem", id);
            } else {
              break;
            }
          }
        }
      }

      bundleArray.push(bundle.id);
      bundle.transfers = bundleTransfers;
      bundle.save();

      processProfitAndLoss(bundle, transfers, bundleArray, event);

      // Marks the next start index in the transaction level transfer array
      return startIndex + criteria.bundleSize;
    }
  }

  return startIndex;
}
