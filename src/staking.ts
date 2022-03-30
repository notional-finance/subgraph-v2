import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts"
import { ERC20 } from "../generated/Notional/ERC20"
import { StakedNoteBalance, StakedNoteChange } from "../generated/schema"
import { SNoteMinted, SNoteRedeemed } from "../generated/StakedNote/sNOTE"

function getStakedNoteBalance(id: string): StakedNoteBalance {
  let entity = StakedNoteBalance.load(id)
  if (entity == null) {
    entity = new StakedNoteBalance(id)
    entity.account = id
    entity.sNOTEBalance = BigInt.fromI32(0)
    entity.ethAmountJoined = BigInt.fromI32(0)
    entity.noteAmountJoined = BigInt.fromI32(0)
    entity.ethAmountRedeemed = BigInt.fromI32(0)
    entity.noteAmountRedeemed = BigInt.fromI32(0)
  }
  return entity as StakedNoteBalance
}

function getStakedNoteChange(balance: StakedNoteBalance, event: ethereum.Event): StakedNoteChange {
  let id = balance.id + ':' + event.transaction.hash.toHexString() + ':' + event.transactionLogIndex.toString()
  let entity = new StakedNoteChange(id)
  entity.blockHash = event.block.hash;
  entity.blockNumber = event.block.number.toI32();
  entity.timestamp = event.block.timestamp.toI32();
  entity.transactionHash = event.transaction.hash;
  entity.account = balance.account;
  entity.stakedNoteBalance = balance.id
  entity.sNOTEAmountBefore = balance.sNOTEBalance;

  return entity as StakedNoteChange
}

function updateStakedNoteBalance(
  account: Address,
  stakedNoteBalance: StakedNoteBalance,
  ethAmount: BigInt,
  noteAmount: BigInt,
  event: ethereum.Event
): BigInt {
  stakedNoteBalance.lastUpdateBlockHash = event.block.hash;
  stakedNoteBalance.lastUpdateBlockNumber = event.block.number.toI32();
  stakedNoteBalance.lastUpdateTimestamp = event.block.timestamp.toI32();
  stakedNoteBalance.lastUpdateTransactionHash = event.transaction.hash;

  let sNOTE = ERC20.bind(event.address);
  let sNOTEAmountAfter = sNOTE.balanceOf(account);
  stakedNoteBalance.sNOTEBalance = sNOTEAmountAfter;
  if (ethAmount.gt(BigInt.fromI32(0))) {
    stakedNoteBalance.ethAmountJoined = stakedNoteBalance.ethAmountJoined.plus(ethAmount);
  } else {
    stakedNoteBalance.ethAmountRedeemed = stakedNoteBalance.ethAmountRedeemed.plus(ethAmount.abs());
  }

  if (noteAmount.gt(BigInt.fromI32(0))) {
    stakedNoteBalance.noteAmountJoined = stakedNoteBalance.noteAmountJoined.plus(noteAmount);
  } else {
    stakedNoteBalance.noteAmountRedeemed = stakedNoteBalance.noteAmountRedeemed.plus(noteAmount.abs());
  }

  stakedNoteBalance.save();

  return sNOTEAmountAfter;
}

export function handleSNoteMinted(event: SNoteMinted): void {
  let accountId = event.params.account.toHexString()
  let balance = getStakedNoteBalance(accountId)
  let change = getStakedNoteChange(balance, event)

  change.sNOTEAmountAfter = updateStakedNoteBalance(
    event.params.account,
    balance,
    event.params.wethChangeAmount,
    event.params.noteChangeAmount,
    event
  );

  change.ethAmountChange = event.params.wethChangeAmount;
  change.noteAmountChange = event.params.noteChangeAmount;
  change.bptAmountChange = event.params.bptChangeAmount;
  change.save()
}

export function handleSNoteRedeemed(event: SNoteRedeemed): void {
  let accountId = event.params.account.toHexString()
  let balance = getStakedNoteBalance(accountId)
  let change = getStakedNoteChange(balance, event)

  change.sNOTEAmountAfter = updateStakedNoteBalance(
    event.params.account,
    balance,
    event.params.wethChangeAmount.neg(),
    event.params.noteChangeAmount.neg(),
    event
  );

  change.ethAmountChange = event.params.wethChangeAmount.neg();
  change.noteAmountChange = event.params.noteChangeAmount.neg();
  change.bptAmountChange = event.params.bptChangeAmount.neg();
  change.save()
}
