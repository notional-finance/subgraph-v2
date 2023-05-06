import { Address, ethereum, BigInt, log, Bytes, store } from "@graphprotocol/graph-ts";
import { Token, Transfer } from "../../generated/schema";
import { IStrategyVault } from "../../generated/Transactions/IStrategyVault";
import { ERC4626 } from "../../generated/Transactions/ERC4626";
import {
  fCash,
  NOTE,
  nToken,
  PrimeCash,
  PrimeDebt,
  PRIME_CASH_VAULT_MATURITY,
  VaultCash,
  VaultDebt,
  VaultShare,
  ZERO_ADDRESS,
} from "./constants";
import { createTransferBundle, getAccount, getNotional, getTransaction } from "./entities";
import { BundleCriteria } from "./bundles";

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
  } else if (
    token.tokenType == PrimeDebt ||
    (token.tokenType == VaultDebt &&
      token.get("maturity") != null &&
      token.maturity == PRIME_CASH_VAULT_MATURITY)
  ) {
    let pDebtAddress = notional.pDebtAddress(currencyId);
    let pDebt = ERC4626.bind(pDebtAddress);
    underlyingExternal = pDebt.try_convertToAssets(value);
  } else if (token.tokenType == PrimeCash || token.tokenType == VaultCash) {
    underlyingExternal = notional.try_convertCashBalanceToExternal(currencyId, value, true);
  } else if (
    token.tokenType == fCash ||
    (token.tokenType == VaultDebt &&
      token.get("maturity") != null &&
      token.maturity != PRIME_CASH_VAULT_MATURITY)
  ) {
    if (token.maturity <= blockTime.toI32()) {
      // If the fCash has matured then get the settled value
      underlyingExternal = notional.try_convertSettledfCash(
        currencyId,
        BigInt.fromI32(token.maturity),
        value,
        blockTime
      );
    } else {
      underlyingExternal = notional.try_getPresentfCashValue(
        currencyId,
        BigInt.fromI32(token.maturity),
        value,
        blockTime,
        false
      );
    }
  } else if (token.tokenType == VaultShare) {
    let vault = IStrategyVault.bind(Address.fromBytes(token.vaultAddress as Bytes));
    underlyingExternal = vault.try_convertStrategyToUnderlying(
      Address.fromBytes(token.vaultAddress as Bytes),
      value,
      BigInt.fromI32(token.maturity)
    );
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
  txn._nextStartIndex = scanTransferBundle(
    txn._nextStartIndex,
    transferArray,
    bundleArray,
    event.transaction.hash.toHexString(),
    event.block.number.toI32(),
    event.block.timestamp.toI32()
  );
  txn._transferBundles = bundleArray;
  txn._transfers = transferArray;
  txn.save();
}

export function scanTransferBundle(
  startIndex: i32,
  transferArray: string[],
  bundleArray: string[],
  txnHash: string,
  blockNumber: i32,
  timestamp: i32
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
      let bundle = createTransferBundle(txnHash, criteria.bundleName, startLogIndex, endLogIndex);
      bundle.blockNumber = blockNumber;
      bundle.timestamp = timestamp;
      bundle.transactionHash = txnHash;
      bundle.bundleName = criteria.bundleName;
      bundle.startLogIndex = startLogIndex;
      bundle.endLogIndex = endLogIndex;

      let bundleTransfers = new Array<string>();
      for (let i = windowStartIndex; i <= windowEndIndex; i++) {
        // Update the bundle id on all the transfers
        bundleTransfers.push(window[i].id);
      }

      if (criteria.rewrite) {
        let oldBundle = bundleArray.pop();
        if (oldBundle) store.remove("TransferBundle", oldBundle);
      }

      bundleArray.push(bundle.id);
      bundle.transfers = bundleTransfers;
      bundle.save();

      // Marks the next start index in the transaction level transfer array
      return startIndex + criteria.bundleSize;
    }
  }

  return startIndex;
}
