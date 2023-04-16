import { ethereum } from "@graphprotocol/graph-ts";
import { Account, Asset, Balance, Transaction, Transfer, TransferBundle } from "../../generated/schema";
import { FeeReserve, FEE_RESERVE, None, SettlementReserve, SETTLEMENT_RESERVE, ZeroAddress, ZERO_ADDRESS } from "./constants";

export function getAsset(id: string): Asset {
  let entity = Asset.load(id);
  if (entity == null) {
    entity = new Asset(id);
  }
  return entity as Asset;
}

export function getBalance(id: string): Balance {
  let entity = Balance.load(id);
  if (entity == null) {
    entity = new Balance(id);
  }
  return entity as Balance;
}

export function getAccount(id: string, event: ethereum.Event): Account {
  let entity = Account.load(id);
  if (entity == null) {
    entity = new Account(id);

    if (id == FEE_RESERVE.toHexString()) {
      entity.systemAccountType = FeeReserve;
    } else if (id == SETTLEMENT_RESERVE.toHexString()) {
      entity.systemAccountType = SettlementReserve;
    } else if (id == ZERO_ADDRESS.toHexString()) {
      entity.systemAccountType = ZeroAddress;
    } else {
      // NOTE: ERC20 proxies will update their system account type after
      // calling getAccount. Otherwise this creates a new default account
      entity.systemAccountType = None;
    }

    entity.firstUpdateBlockNumber = event.block.number.toI32();
    entity.firstUpdateTimestamp = event.block.timestamp.toI32();
    entity.firstUpdateTransactionHash = event.transaction.hash;

    entity.lastUpdateBlockNumber = event.block.number.toI32();
    entity.lastUpdateTimestamp = event.block.timestamp.toI32();
    entity.lastUpdateTransactionHash = event.transaction.hash;

    entity.save()
  }

  return entity as Account;
}

export function createTransfer(event: ethereum.Event, index: i32): Transfer {
  let id = event.transaction.hash.toHexString() + ":" + event.transactionLogIndex.toString() + ":" + index.toString()
  let transfer = new Transfer(id)
  transfer.blockNumber = event.block.number.toI32();
  transfer.timestamp = event.block.timestamp.toI32();
  transfer.transactionHash = event.transaction.hash.toString();
  transfer.logIndex = event.transactionLogIndex.toI32();

  return transfer
}

export function getTransaction(event: ethereum.Event): Transaction {
  let transaction = new Transaction(event.transaction.hash.toHexString())
  transaction.blockNumber = event.block.number.toI32();
  transaction.timestamp = event.block.timestamp.toI32();
  transaction.transactionHash = event.transaction.hash;

  transaction._transactionTypes = new Array<string>();
  transaction._transferBundles = new Array<string>();
  transaction._transfers = new Array<string>();
  transaction._lastBundledTransfer = 0;

  return transaction;
}

export function createTransferBundle(txnHash: string, bundleName: string, startLogIndex: i32, endLogIndex: i32): TransferBundle {
  let bundleId = txnHash + ":" + startLogIndex.toString() + ":" + endLogIndex.toString() + ":" + bundleName;
  return new TransferBundle(bundleId);
}