import { Address, ethereum, BigInt, log } from "@graphprotocol/graph-ts";
import { Asset, Transfer } from "../../generated/schema";
import { ZERO_ADDRESS } from "./constants";
import { createTransferBundle, getAccount, getTransaction } from "./entities";
import { BundleCriteria } from "./bundles";

export function decodeTransferType(from: Address, to: Address): string {
  if (from == ZERO_ADDRESS) {
    return 'Mint'
  } else if (to == ZERO_ADDRESS) {
    return 'Burn'
  } else {
    return 'Transfer'
  }
}

export function decodeSystemAccount(addr: Address, event: ethereum.Event): string {
  let account = getAccount(addr.toHexString(), event)
  return account.systemAccountType;
}

export function convertValueToUnderlying(value: BigInt, asset: Asset): BigInt {
  // TODO
  return value
}

export function processTransfer(transfer: Transfer, event: ethereum.Event): void {
  let txn = getTransaction(event)
  
  let transferArray = (txn._transfers || new Array<string>()) as string[]
  let bundleArray = (txn._transferBundles || new Array<string>()) as string[]

  // Append the transfer to the transfer array
  transferArray.push(transfer.id)

  // Scan unbundled transfers
  let didBundle = scanTransferBundle(
    txn._lastBundledTransfer,
    transferArray,
    bundleArray,
    event.transaction.hash.toHexString()
  );

  if (didBundle) txn._lastBundledTransfer = transferArray.length - 1;
  txn._transferBundles = bundleArray;
  txn._transfers = transferArray;

  transfer.save();
  txn.save();
}

export function scanTransferBundle(
  startIndex: i32,
  transferArray: string[],
  bundleArray: string[],
  txnHash: string
): boolean {
  for (let i = 0; i < BundleCriteria.length; i++) {
    let criteria = BundleCriteria[i];
    // Go to the next criteria if the window size does not match
    if (transferArray.length - startIndex != criteria.windowSize) continue;

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

    let window = transferArray.slice(startIndex - lookBehind).map<Transfer>((transferId: string) => {
      // The transfer must always be found at this point
      let t = Transfer.load(transferId)
      if (t == null) log.critical("{} transfer id not found", [transferId])
      return t as Transfer
    })

    if (criteria.func(window)) {
      let bundleSize = criteria.bundleSize
      let windowStartIndex = criteria.rewrite ? 0 : lookBehind;
      let startLogIndex = window[windowStartIndex].logIndex
      let endLogIndex = window[windowStartIndex + bundleSize - 1].logIndex
      let bundle = createTransferBundle(txnHash, criteria.bundleName, startLogIndex, endLogIndex)

      for (let i = windowStartIndex; i < bundleSize; i++) {
        // Update the bundle id on all the transfers
        window[i].bundle = bundle.id
        window[i].save()
      }

      bundleArray.push(bundle.id)

      return true
    }
  }

    return false
}