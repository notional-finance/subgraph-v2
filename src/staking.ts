import { Address, BigInt, ethereum } from "@graphprotocol/graph-ts"
import { ERC20 } from "../generated/Notional/ERC20"
import {  StakedNoteBalance, StakedNoteChange, StakedNoteInvestment, StakedNotePool } from "../generated/schema"
import { sNOTE, SNoteMinted, SNoteRedeemed } from "../generated/StakedNote/sNOTE"
import { AssetsInvested, TreasuryManager } from "../generated/TreasuryManager/TreasuryManager"

function getStakedNotePool(sNOTEAddress: string): StakedNotePool {
    let entity = StakedNotePool.load(sNOTEAddress);
    if (entity == null) {
        entity = new StakedNotePool(sNOTEAddress)
        entity.totalBPTTokens = BigInt.fromI32(0);
        entity.totalSupply = BigInt.fromI32(0);
        entity.bptPerSNOTE = BigInt.fromI32(0);
    }

    return entity as StakedNotePool
}

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
  let id =
    balance.id +
    ":" +
    event.transaction.hash.toHexString() +
    ":" +
    event.transactionLogIndex.toString()
  let entity = new StakedNoteChange(id)
  entity.blockHash = event.block.hash
  entity.blockNumber = event.block.number.toI32()
  entity.timestamp = event.block.timestamp.toI32()
  entity.transactionHash = event.transaction.hash
  entity.account = balance.account
  entity.stakedNoteBalance = balance.id
  entity.sNOTEAmountBefore = balance.sNOTEBalance

  return entity as StakedNoteChange
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

function updateStakedNoteBalance(
  account: Address,
  stakedNoteBalance: StakedNoteBalance,
  ethAmount: BigInt,
  noteAmount: BigInt,
  event: ethereum.Event
): BigInt {
  stakedNoteBalance.lastUpdateBlockHash = event.block.hash
  stakedNoteBalance.lastUpdateBlockNumber = event.block.number.toI32()
  stakedNoteBalance.lastUpdateTimestamp = event.block.timestamp.toI32()
  stakedNoteBalance.lastUpdateTransactionHash = event.transaction.hash

  let sNOTE = ERC20.bind(event.address)
  let sNOTEAmountAfter = sNOTE.balanceOf(account)
  stakedNoteBalance.sNOTEBalance = sNOTEAmountAfter
  if (ethAmount.gt(BigInt.fromI32(0))) {
    stakedNoteBalance.ethAmountJoined = stakedNoteBalance.ethAmountJoined.plus(ethAmount)
  } else {
    stakedNoteBalance.ethAmountRedeemed = stakedNoteBalance.ethAmountRedeemed.plus(ethAmount.abs())
  }

  if (noteAmount.gt(BigInt.fromI32(0))) {
    stakedNoteBalance.noteAmountJoined = stakedNoteBalance.noteAmountJoined.plus(noteAmount)
  } else {
    stakedNoteBalance.noteAmountRedeemed = stakedNoteBalance.noteAmountRedeemed.plus(
      noteAmount.abs()
    )
  }

  stakedNoteBalance.save()

  return sNOTEAmountAfter
}

function updateStakedNotePool(sNOTEAddress: Address, pool: StakedNotePool, event: ethereum.Event): BigInt {
  let sNOTEContract = sNOTE.bind(sNOTEAddress)
  let balancerPool = ERC20.bind(sNOTEContract.BALANCER_POOL_TOKEN())

  pool.lastUpdateBlockHash = event.block.hash
  pool.lastUpdateBlockNumber = event.block.number.toI32()
  pool.lastUpdateTimestamp = event.block.timestamp.toI32()
  pool.lastUpdateTransactionHash = event.transaction.hash

  pool.totalBPTTokens = balancerPool.balanceOf(sNOTEAddress)
  pool.totalSupply = sNOTEContract.totalSupply()
  pool.bptPerSNOTE = sNOTEContract.getPoolTokenShare(BigInt.fromI32(10).pow(18))
  pool.save();

  return pool.bptPerSNOTE;
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
  )

  change.ethAmountChange = event.params.wethChangeAmount
  change.noteAmountChange = event.params.noteChangeAmount
  change.bptAmountChange = event.params.bptChangeAmount
  change.save()

  let pool = getStakedNotePool(event.address.toHexString())
  updateStakedNotePool(event.address, pool, event);
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
  )

  change.ethAmountChange = event.params.wethChangeAmount.neg()
  change.noteAmountChange = event.params.noteChangeAmount.neg()
  change.bptAmountChange = event.params.bptChangeAmount.neg()
  change.save()
  
  let pool = getStakedNotePool(event.address.toHexString())
  updateStakedNotePool(event.address, pool, event);
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
