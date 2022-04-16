import { Address, dataSource, ethereum } from "@graphprotocol/graph-ts";
import { StakedNoteInvestment, StakedNotePool, Treasury, TreasuryManager as TreasuryManagerSchema, TreasuryManagerTradingLimit } from "../generated/schema";
import { sNOTE } from "../generated/StakedNote/sNOTE";
import { AssetsInvested, InvestmentCoolDownUpdated, ManagementTransferred, NOTEPurchaseLimitUpdated, PriceOracleUpdated, SlippageLimitUpdated, TreasuryManager } from "../generated/TreasuryManager/TreasuryManager"
import { ADDRESS_ZERO } from "./common";
import { getTokenNameAndSymbol } from "./notional";
import { getStakedNotePool, updateStakedNotePool } from "./staking";

export function getTreasury(contract: Address): Treasury {
  let id = contract.toHexString()
  let treasury = Treasury.load(id)
  if (treasury == null) {
    treasury = new Treasury(id)
    treasury.contractAddress = contract;
    treasury.tradingLimits = [];
    treasury.managers = []
  }

  return treasury as Treasury
}
  
export function getTreasuryManager(addr: Address, event: ethereum.Event): TreasuryManagerSchema {
  let id = addr.toHexString()
  let manager = TreasuryManagerSchema.load(id);
  if (manager == null) {
    manager = new TreasuryManagerSchema(id);
    manager.startedBlockNumber = event.block.number.toI32();
    manager.startedTimestamp = event.block.timestamp.toI32();
    manager.startedBlockHash = event.block.hash;
    manager.startedTransactionHash = event.transaction.hash;
  }

  return manager as TreasuryManagerSchema
}

export function getTreasuryManagerTradingLimit(token: Address): TreasuryManagerTradingLimit {
  let id = token.toHexString()
  let limit = TreasuryManagerTradingLimit.load(id)
  if (limit == null) {
    limit = new TreasuryManagerTradingLimit(id);
    limit.tokenAddress = token;
    let strings = getTokenNameAndSymbol(token)
    limit.name = strings[0];
    limit.symbol = strings[1];
    limit.treasury = dataSource.address().toHexString();
  }

  return limit as TreasuryManagerTradingLimit
}

function getStakedNoteInvestment(pool: StakedNotePool, event: ethereum.Event): StakedNoteInvestment {
  let id =
    event.transaction.hash.toHexString() +
    ":" +
    event.transactionLogIndex.toString()

  let entity = new StakedNoteInvestment(id)
  entity.blockHash = event.block.hash
  entity.blockNumber = event.block.number.toI32()
  entity.timestamp = event.block.timestamp.toI32()
  entity.transactionHash = event.transaction.hash
  entity.bptPerSNOTEBefore = pool.bptPerSNOTE;

  return entity;
}

export function handleAssetsInvested(event: AssetsInvested): void {
  let managerContract = TreasuryManager.bind(event.address);
  let sNOTEAddress = managerContract.sNOTE();
  let sNOTEContract = sNOTE.bind(sNOTEAddress);
  let pool = getStakedNotePool(sNOTEAddress.toHexString());
  let investment = getStakedNoteInvestment(pool, event);

  investment.bptPerSNOTEAfter = updateStakedNotePool(sNOTEAddress, pool, event);
  investment.totalETHInvested = event.params.wethAmount;
  investment.totalNOTEInvested = event.params.noteAmount;
  investment.totalSNOTESupply = sNOTEContract.totalSupply();
  investment.save();
}

export function handleManagementTransferred(event: ManagementTransferred): void {
  let treasury = getTreasury(dataSource.address());
  if (event.params.prevManager != ADDRESS_ZERO()) {
    let oldManager = getTreasuryManager(event.params.prevManager, event);
    oldManager.endedBlockNumber = event.block.number.toI32();
    oldManager.endedTimestamp = event.block.timestamp.toI32();
    oldManager.endedBlockHash = event.block.hash;
    oldManager.endedTransactionHash = event.transaction.hash;
    oldManager.isActiveManager = false;
    oldManager.save();
  }

  let newManager = getTreasuryManager(event.params.newManager, event);
  newManager.isActiveManager = true;
  newManager.treasury = dataSource.address().toHexString();
  newManager.save();

  treasury.activeManager = newManager.id;
  treasury.save();
}

export function handleNOTEPurchaseLimitUpdated(event: NOTEPurchaseLimitUpdated): void {
  let treasury = getTreasury(dataSource.address());
  treasury.NOTEPurchaseLimit = event.params.purchaseLimit
  treasury.lastUpdateBlockNumber = event.block.number.toI32();
  treasury.lastUpdateTimestamp = event.block.timestamp.toI32();
  treasury.lastUpdateBlockHash = event.block.hash;
  treasury.lastUpdateTransactionHash = event.transaction.hash;
  treasury.save();
}

export function handleInvestmentCoolDownUpdated(event: InvestmentCoolDownUpdated): void {
  let treasury = getTreasury(dataSource.address());
  treasury.investmentCoolDownInSeconds = event.params.newCoolDownTimeSeconds;
  treasury.lastUpdateBlockNumber = event.block.number.toI32();
  treasury.lastUpdateTimestamp = event.block.timestamp.toI32();
  treasury.lastUpdateBlockHash = event.block.hash;
  treasury.lastUpdateTransactionHash = event.transaction.hash;
  treasury.save();
}

export function handleSlippageLimitUpdated(event: SlippageLimitUpdated): void {
  let limit = getTreasuryManagerTradingLimit(event.params.tokenAddress)
  limit.slippageLimit = event.params.slippageLimit;
  limit.lastUpdateBlockNumber = event.block.number.toI32();
  limit.lastUpdateTimestamp = event.block.timestamp.toI32();
  limit.lastUpdateBlockHash = event.block.hash;
  limit.lastUpdateTransactionHash = event.transaction.hash;
  limit.save();
}

export function handlePriceOracleUpdated(event: PriceOracleUpdated): void {
  let limit = getTreasuryManagerTradingLimit(event.params.tokenAddress)
  limit.oracle = event.params.oracleAddress;
  limit.lastUpdateBlockNumber = event.block.number.toI32();
  limit.lastUpdateTimestamp = event.block.timestamp.toI32();
  limit.lastUpdateBlockHash = event.block.hash;
  limit.lastUpdateTransactionHash = event.transaction.hash;
  limit.save();
}