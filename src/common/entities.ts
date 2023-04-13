import { Account, Asset, Balance, Underlying } from "../../generated/schema";

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