import { ethereum } from "@graphprotocol/graph-ts";
import { Account, Asset, Balance, Transaction, Transfer, Underlying } from "../../generated/schema";

export function getUnderlying(id: string): Underlying {
  let entity = Underlying.load(id);
  if (entity == null) {
    entity = new Underlying(id);
  }
  return entity as Underlying;
}

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

export function getAccount(id: string): Account {
  let entity = Account.load(id);
  if (entity == null) {
    entity = new Account(id);
  }
  return entity as Account;
}

export function getTransfer(event: ethereum.Event, index: i32): Transfer {
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