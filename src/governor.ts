import { 
  ProposalCreated,
  VoteCast,
  ProposalCanceled,
  ProposalQueued,
  ProposalExecuted
} from '../generated/Governor/Governor';
import { 
  Delegate,
  Proposal,
  Vote,
  ProposalState
} from '../generated/schema';
import {
  BigInt,
  Bytes
} from "@graphprotocol/graph-ts";

function getProposal(id: string): Proposal {
  let proposal = Proposal.load(id);

  if(proposal === null) {
    proposal = new Proposal(id);
  }

  return proposal as Proposal;
}

function getDelegate(addressId: string): Delegate {
  let delegate = Delegate.load(addressId);

  if(delegate === null) {
    delegate = new Delegate(addressId);
  }

  return delegate as Delegate;
}

export function handleProposalCreated(event: ProposalCreated): void {
  let proposal = getProposal(event.params.id.toString());
  let delegate = getDelegate(event.params.proposer.toHexString());
  let proposalState = new ProposalState(event.params.id.toString() + ":" + event.block.timestamp.toString()); 
  let proposalStateHistory = proposal.history || [];

  proposalState.state = 'PENDING';
  proposalState.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposalState.transactionHash =  event.transaction.hash;
  proposalState.save();

  proposalStateHistory.push(proposalState.id);

  delegate.lastUpdateBlockHash = event.block.hash;
  delegate.lastUpdateBlockNumber = event.block.number.toI32();
  delegate.lastUpdateTimestamp = event.block.timestamp.toI32();
  delegate.lastUpdateTransactionHash = event.transaction.hash;
  delegate.save();

  proposal.votes = [];

  let targets = new Array<Bytes>();
  let tempTargets = event.params.targets;
  for (
    let i: i32 = 0;
    i < tempTargets.length;
    i++
  ) {
    targets.push(tempTargets[i]);
  }

  proposal.targets = targets;

  let values = new Array<BigInt>();
  let tempValues = event.params.values;
  for (
    let i: i32 = 0;
    i < tempValues.length;
    i++
  ) {
    values.push(tempValues[i]);
  }

  proposal.values = values;

  let calldatas = new Array<Bytes>();
  let tempCallDatas = event.params.calldatas;
  for (
    let i: i32 = 0;
    i < tempCallDatas.length;
    i++
  ) {
    calldatas.push(tempCallDatas[i]);
  }

  proposal.id = event.params.id.toString();
  proposal.calldatas = calldatas;
  proposal.startBlock = event.params.startBlock.toI32();
  proposal.endBlock = event.params.endBlock.toI32();
  proposal.proposer = delegate.id;
  proposal.lastUpdateBlockNumber = event.block.number.toI32();
  proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposal.lastUpdateBlockHash = event.block.hash;
  proposal.lastUpdateTransactionHash = event.transaction.hash;
  proposal.createdAt = event.block.timestamp.toI32();
  proposal.history = proposalStateHistory;
  proposal.save(); 
}

export function handleProposalExecuted(event: ProposalExecuted): void {
  let proposal = getProposal(event.params.id.toString());
  let proposalState = new ProposalState(event.params.id.toString() + ":" + event.block.timestamp.toString()); 
  let proposalStateHistory = proposal.history || [];

  proposalState.state = 'EXECUTED';
  proposalState.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposalState.transactionHash =  event.transaction.hash;
  proposalState.save();

  proposalStateHistory.push(proposalState.id);
  
  proposal.isExecuted = true;
  proposal.isQueued = false;
  proposal.lastUpdateBlockNumber = event.block.number.toI32();
  proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposal.lastUpdateBlockHash = event.block.hash;
  proposal.lastUpdateTransactionHash = event.transaction.hash;
  proposal.history = proposalStateHistory;
  proposal.save();
}

export function handleProposalCanceled(event: ProposalCanceled): void {
  let proposal = getProposal(event.params.id.toString());
  let proposalState = new ProposalState(event.params.id.toString() + ":" + event.block.timestamp.toString()); 
  let proposalStateHistory = proposal.history || [];

  proposalState.state = 'CANCELLED';
  proposalState.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposalState.transactionHash =  event.transaction.hash;
  proposalState.save();

  proposalStateHistory.push(proposalState.id);

  proposal.isCancelled = true;
  proposal.lastUpdateBlockNumber = event.block.number.toI32();
  proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposal.lastUpdateBlockHash = event.block.hash;
  proposal.lastUpdateTransactionHash = event.transaction.hash;
  proposal.history = proposalStateHistory;
  proposal.save();
}

export function handleVoteCast(event: VoteCast): void {
  let proposal = getProposal(event.params.proposalId.toString());
  let delegate = getDelegate(event.params.voter.toHexString());
  let voteId = event.params.voter.toHexString() + ':' + proposal.id;
  let vote = new Vote(voteId); 
  let votes = proposal.votes;

  vote.proposal = proposal.id;
  vote.delegate =  delegate.id;
  vote.votingPower = event.params.votes;
  vote.yesToProposal = event.params.support;
  vote.lastUpdateBlockNumber = event.block.number.toI32();
  vote.lastUpdateTimestamp = event.block.timestamp.toI32();
  vote.lastUpdateBlockHash = event.block.hash;
  vote.lastUpdateTransactionHash = event.transaction.hash;
  vote.save();

  votes.push(vote.id);

  delegate.lastUpdateBlockHash = event.block.hash;
  delegate.lastUpdateBlockNumber = event.block.number.toI32();
  delegate.lastUpdateTimestamp = event.block.timestamp.toI32();
  delegate.lastUpdateTransactionHash = event.transaction.hash;
  delegate.save();

  proposal.votes = votes;
  proposal.lastUpdateBlockNumber = event.block.number.toI32();
  proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposal.lastUpdateBlockHash = event.block.hash;
  proposal.lastUpdateTransactionHash = event.transaction.hash;
  proposal.save();
}

export function handleProposalQueued(event: ProposalQueued): void {
  let proposal = getProposal(event.params.id.toString());
  let proposalState = new ProposalState(event.params.id.toString() + ":" + event.block.timestamp.toString()); 
  let proposalStateHistory = proposal.history || [];

  proposalState.state = 'QUEUED';
  proposalState.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposalState.transactionHash =  event.transaction.hash;
  proposalState.save();

  proposalStateHistory.push(proposalState.id);
  
  proposal.isQueued = true;
  proposal.lastUpdateBlockNumber = event.block.number.toI32();
  proposal.lastUpdateTimestamp = event.block.timestamp.toI32();
  proposal.lastUpdateBlockHash = event.block.hash;
  proposal.lastUpdateTransactionHash = event.transaction.hash;
  proposal.history = proposalStateHistory;
  proposal.save();
}
