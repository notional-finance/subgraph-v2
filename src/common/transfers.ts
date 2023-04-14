import { Address, ethereum, BigInt } from "@graphprotocol/graph-ts";
import { Asset, Transfer } from "../../generated/schema";
import { ZERO_ADDRESS } from "./constants";
import { getAccount, getTransaction } from "./entities";
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
  scanTransferBundle(txn._lastBundledTransfer, transferArray, bundleArray)


  txn._transfers = transferArray;

  transfer.save();
  txn.save();
}

export function scanTransferBundle(startIndex: i32, transferArray: string[], bundleArray: string[]): void {
  let t = new Array<Transfer>();
  for (let i = 0; i < BundleCriteria.length; i++) {
    // let criteria = BundleCriteria[i];
    // let isMatch = criteria(t)
  }

}