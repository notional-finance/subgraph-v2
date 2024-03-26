import { DelegateChanged, DelegateVotesChanged, NoteERC20, Transfer } from "../generated/NoteERC20/NoteERC20"
import { BigInt, dataSource } from "@graphprotocol/graph-ts";
import { Delegate, NoteBalance, NoteBalanceChange, VotingPowerChange } from "../generated/schema";

export function getDelegate(address: string): Delegate {
  let delegate = Delegate.load(address);

  if (delegate === null) {
    delegate = new Delegate(address);
    delegate.account = address
    delegate.NOTEVotingPower = BigInt.fromI32(0)
    delegate.sNOTEVotingPower = BigInt.fromI32(0)
  }

  return delegate as Delegate;
}

function getNoteBalance(address: string): NoteBalance {
  let balance = NoteBalance.load(address);

  if (balance === null) {
    balance = new NoteBalance(address);
    balance.account = address
    balance.noteBalance = BigInt.fromI32(0);
  }

  return balance as NoteBalance;
}

export function handleDelegateChanged(event: DelegateChanged): void {
  let noteBalance = getNoteBalance(event.params.delegator.toHexString());
  noteBalance.lastUpdateBlockNumber = event.block.number.toI32();
  noteBalance.lastUpdateTimestamp = event.block.timestamp.toI32();
  noteBalance.lastUpdateBlockHash = event.block.hash;
  noteBalance.lastUpdateTransactionHash = event.transaction.hash;
  noteBalance.delegate = event.params.toDelegate.toHexString();
  noteBalance.save();
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
    + delegate.id + ":"
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
  let sender = getNoteBalance(event.params.from.toHexString());
  let receiver = getNoteBalance(event.params.to.toHexString());
  let NOTEContract = NoteERC20.bind(dataSource.address())
  let senderBalanceAfter = NOTEContract.balanceOf(event.params.from);
  let receiverBalanceAfter = NOTEContract.balanceOf(event.params.to);

  let senderChangeId = event.address.toHexString() + ":" 
    + sender.id + ":"
    + event.transaction.hash.toHexString() + ":"
    + event.logIndex.toString();
  let senderBalanceChange = new NoteBalanceChange(senderChangeId)
  senderBalanceChange.blockNumber = event.block.number.toI32();
  senderBalanceChange.timestamp = event.block.timestamp.toI32();
  senderBalanceChange.blockHash = event.block.hash;
  senderBalanceChange.transactionHash = event.transaction.hash;
  senderBalanceChange.account = sender.id;
  senderBalanceChange.noteBalance = sender.id;
  senderBalanceChange.noteBalanceBefore = sender.noteBalance;
  senderBalanceChange.noteBalanceAfter = senderBalanceAfter;
  senderBalanceChange.sender = event.params.from;
  senderBalanceChange.receiver = event.params.to;
  senderBalanceChange.save();

  sender.lastUpdateBlockNumber = event.block.number.toI32();
  sender.lastUpdateTimestamp = event.block.timestamp.toI32();
  sender.lastUpdateBlockHash = event.block.hash;
  sender.lastUpdateTransactionHash = event.transaction.hash;
  sender.noteBalance = senderBalanceAfter;
  sender.save();

  let receiverChangeId = event.address.toHexString() + ":" 
    + receiver.id + ":"
    + event.transaction.hash.toHexString() + ":"
    + event.logIndex.toString();
  let receiverBalanceChange = new NoteBalanceChange(receiverChangeId)
  receiverBalanceChange.blockNumber = event.block.number.toI32();
  receiverBalanceChange.timestamp = event.block.timestamp.toI32();
  receiverBalanceChange.blockHash = event.block.hash;
  receiverBalanceChange.transactionHash = event.transaction.hash;
  receiverBalanceChange.account = receiver.id;
  receiverBalanceChange.noteBalance = receiver.id;
  receiverBalanceChange.noteBalanceBefore = receiver.noteBalance;
  receiverBalanceChange.noteBalanceAfter = receiverBalanceAfter;
  receiverBalanceChange.sender = event.params.from;
  receiverBalanceChange.receiver = event.params.to;
  receiverBalanceChange.save();

  receiver.lastUpdateBlockNumber = event.block.number.toI32();
  receiver.lastUpdateTimestamp = event.block.timestamp.toI32();
  receiver.lastUpdateBlockHash = event.block.hash;
  receiver.lastUpdateTransactionHash = event.transaction.hash;
  receiver.noteBalance = receiverBalanceAfter;
  receiver.save();
}
