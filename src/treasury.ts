import { ethereum } from "@graphprotocol/graph-ts";
import { StakedNoteInvestment, StakedNotePool } from "../generated/schema";
import { sNOTE } from "../generated/StakedNote/sNOTE";
import { AssetsInvested, TreasuryManager } from "../generated/TreasuryManager/TreasuryManager"
import { getStakedNotePool, updateStakedNotePool } from "./staking";

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
  let manager = TreasuryManager.bind(event.address);
  let sNOTEAddress = manager.sNOTE();
  let sNOTEContract = sNOTE.bind(sNOTEAddress);
  let pool = getStakedNotePool(sNOTEAddress.toHexString());
  let investment = getStakedNoteInvestment(pool, event);

  investment.bptPerSNOTEAfter = updateStakedNotePool(sNOTEAddress, pool, event);
  investment.totalETHInvested = event.params.wethAmount;
  investment.totalNOTEInvested = event.params.noteAmount;
  investment.totalSNOTESupply = sNOTEContract.totalSupply();
  investment.save();
}