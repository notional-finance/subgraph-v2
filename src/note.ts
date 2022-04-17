import { DelegateChanged, DelegateVotesChanged, Transfer } from "../generated/NoteERC20/NoteERC20"
import { BigInt, log } from "@graphprotocol/graph-ts";
import { Delegate, VotingPowerChange } from "../generated/schema";

function getDelegate(address: string): Delegate {
  let delegate = Delegate.load(address);

  if (delegate === null) {
    delegate = new Delegate(address);
    delegate.account = address
    delegate.NOTEVotingPower = BigInt.fromI32(0)
    delegate.sNOTEVotingPower = BigInt.fromI32(0)
  }

  return delegate as Delegate;
}


export function handleDelegateChanged(event: DelegateChanged): void {

}

export function handleDelegateVotesChanged(event: DelegateVotesChanged): void {
  let delegate = getDelegate(event.params.delegate.toHexString())
  delegate.lastUpdateBlockNumber = event.block.number.toI32();
  delegate.lastUpdateTimestamp = event.block.timestamp.toI32();
  delegate.lastUpdateBlockHash = event.block.hash;
  delegate.lastUpdateTransactionHash = event.transaction.hash;
  delegate.NOTEVotingPower = event.params.newBalance;
  delegate.totalVotingPower = delegate.NOTEVotingPower.plus(delegate.sNOTEVotingPower);
  delegate.save();

  let id = event.address.toHexString() + ":" 
    + event.transaction.hash.toHexString() + ":"
    + event.logIndex.toString();
  let powerChange = new VotingPowerChange(id)
  powerChange.blockNumber = event.block.number.toI32();
  powerChange.timestamp = event.block.timestamp.toI32();
  powerChange.blockHash = event.block.hash;
  powerChange.transactionHash = event.transaction.hash;
  powerChange.delegate = delegate.id;
  powerChange.source = 'NOTE';
  powerChange.votingPowerBefore = event.params.previousBalance;
  powerChange.votingPowerAfter = event.params.newBalance;
  powerChange.save();
}

export function handleTransfer(event: Transfer): void {
  log.info("Hello world", []);
}
