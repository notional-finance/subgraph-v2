import { ethereum } from "@graphprotocol/graph-ts";
import { StrategyVault, StrategyVaultAccount, StrategyVaultCapacity, StrategyVaultMaturity, StrategyVaultTrade } from "../generated/schema";

function getVault(id: string): StrategyVault {
  let entity = StrategyVault.load(id);
  if (entity == null) {
    entity = new StrategyVault(id);
  }
  return entity as StrategyVault
}

function getVaultAccount(vault: string, account: string): StrategyVaultAccount {
  let id = vault + ":" + account
  let entity = StrategyVaultAccount.load(id);
  if (entity == null) {
    entity = new StrategyVaultAccount(id);
    entity.strategyVault = vault
    entity.account = account
  }

  return entity as StrategyVaultAccount
}

function getVaultMaturity(vault: string, maturity: i32): StrategyVaultMaturity {
  let id = vault + ":" + maturity.toString()
  let entity = StrategyVaultMaturity.load(id);
  if (entity == null) {
    entity = new StrategyVaultMaturity(id);
    entity.strategyVault = vault
    entity.maturity = maturity
  }

  return entity as StrategyVaultMaturity
}

function getVaultCapacity(vault: string): StrategyVaultCapacity {
  let id = vault
  let entity = StrategyVaultCapacity.load(id);
  if (entity == null) {
    entity = new StrategyVaultCapacity(id);
    entity.strategyVault = vault
  }

  return entity as StrategyVaultCapacity
}

function getVaultTrade(
  vault: string,
  maturity: i32,
  account: string,
  event: ethereum.Event
): StrategyVaultTrade {
  let id = (
    vault + ':' 
    + maturity.toString() + ':'
    + account.toString() + ':'
    + event.transaction.hash.toHexString() + ':'
    + event.logIndex.toString()
  );

  let entity = new StrategyVaultTrade(id);
  entity.blockHash = event.block.hash;
  entity.blockNumber = event.block.number.toI32();
  entity.timestamp = event.block.timestamp.toI32();
  entity.transactionHash = event.transaction.hash;
  entity.transactionOrigin = event.transaction.from;
  entity.isVaultAction = vault == account
  entity.strategyVaultMaturity = vault + ":" + maturity.toString()
  if (vault != account) {
    entity.strategyVaultAccount = vault + ":" + account
  }

  return entity
}

export function handleVaultUpdated()
export function handleVaultPauseStatus()
export function handleVaultUpdateSecondaryBorrowCapacity()
export function handleVaultBorrowCapacityChange()