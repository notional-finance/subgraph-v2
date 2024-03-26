import { Address, BigInt, dataSource, ethereum } from "@graphprotocol/graph-ts"
import { ERC20 } from "../generated/Notional/ERC20"
import { BalancerVault } from "../generated/StakedNote/BalancerVault"
import { StakedNoteBalance, StakedNoteChange, StakedNoteCoolDown, StakedNotePool, StakedNoteTvl, VotingPowerChange } from "../generated/schema"
import { createDailyTvlId } from './timeseriesUpdate';
import { CoolDownEnded, CoolDownStarted, DelegateChanged, DelegateVotesChanged, sNOTE, SNoteMinted, SNoteRedeemed, Transfer } from "../generated/StakedNote/sNOTE"
import { BI_DAILY_BLOCK_UPDATE, getTvlHistoricalData } from "./notional";
import { getDelegate } from "./note";

export function handleBlockUpdates(event: ethereum.Block): void {
  handleDailyUpdates(event);
}

function getStakedNOTETvl(id: string, timestamp: i32): StakedNoteTvl {
  let entity = StakedNoteTvl.load(id);
  if (entity == null) {
    entity = new StakedNoteTvl(id);
    entity.timestamp = timestamp
  }
  return entity as StakedNoteTvl;

}

function handleDailyUpdates(event: ethereum.Block): void {
  if (event.number.toI32() % BI_DAILY_BLOCK_UPDATE != 0) {
      return;
  }
  let timestamp = event.timestamp.toI32();
  let historicalId = createDailyTvlId(timestamp);
  let tvlHistoricalData = getTvlHistoricalData(historicalId, timestamp);
  let sNOTETvl = getStakedNOTETvl(historicalId, tvlHistoricalData.timestamp);

  let sNOTEContract = sNOTE.bind(dataSource.address())
  let WETH_INDEX = sNOTEContract.try_WETH_INDEX();
  let NOTE_INDEX = sNOTEContract.try_NOTE_INDEX();
  // These values are unavailable in the first deployment on goerli
  if (WETH_INDEX.reverted || NOTE_INDEX.reverted) return

  let balancerPool = ERC20.bind(sNOTEContract.BALANCER_POOL_TOKEN())
  let balancerVault = BalancerVault.bind(sNOTEContract.BALANCER_VAULT())
  let poolTokens = balancerVault.getPoolTokens(sNOTEContract.NOTE_ETH_POOL_ID())

  sNOTETvl.sNOTETotalSupply = sNOTEContract.totalSupply();
  // Use this instead of balanceOf on the BPT Token to account for gauge staking
  sNOTETvl.poolBPTBalance = sNOTEContract.getPoolTokenShare(sNOTETvl.sNOTETotalSupply);

  let totalSupply = balancerPool.totalSupply()
  // Handle div by zero
  if (totalSupply.isZero()) return;

  sNOTETvl.poolNOTEBalance = poolTokens.value1[NOTE_INDEX.value.toI32()]
    .times(sNOTETvl.poolBPTBalance)
    .div(totalSupply);
  sNOTETvl.poolETHBalance = poolTokens.value1[WETH_INDEX.value.toI32()]
    .times(sNOTETvl.poolBPTBalance)
    .div(totalSupply);

  // Numerator: WETH * 5 * 1e18
  let spotPriceNumerator = sNOTETvl.poolETHBalance
    .times(BigInt.fromI32(10).pow(18))
    .times(BigInt.fromI32(5));
  // Denominator: NOTE * 1e10 * 1.25
  let spotPriceDenominator = sNOTETvl.poolNOTEBalance
    .times(BigInt.fromI32(10).pow(10))
    .times(BigInt.fromI32(125))
    .div(BigInt.fromI32(100));

  // Handle div by zero
  if (spotPriceDenominator.isZero()) return;
  sNOTETvl.spotPrice = spotPriceNumerator.div(spotPriceDenominator);

  // Handle div by zero
  if (sNOTETvl.spotPrice.isZero()) return;

  // (spotPrice * poolETHValue) / (1e18 * 1e10) + noteBalance
  sNOTETvl.totalPoolValueInNOTE =  sNOTETvl.poolNOTEBalance.plus(
    sNOTETvl.spotPrice
      .times(sNOTETvl.poolETHBalance)
      .div(BigInt.fromI32(10).pow(28))
  );

  // (poolNoteBalance * 1e10 * 1e18) / (spotPrice) + ethBalance
  sNOTETvl.totalPoolValueInETH = sNOTETvl.poolETHBalance.plus(
    sNOTETvl.poolNOTEBalance
      .times(BigInt.fromI32(10).pow(28))
      .div(sNOTETvl.spotPrice)
  );

  sNOTETvl.save();
  tvlHistoricalData.sNOTETvl = sNOTETvl.id;
  tvlHistoricalData.save();
}


export function getStakedNotePool(sNOTEAddress: string): StakedNotePool {
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

function getStakedNoteCoolDown(balance: StakedNoteBalance, event: ethereum.Event): StakedNoteCoolDown {
  let id =
    balance.id +
    ":" +
    event.transaction.hash.toHexString() +
    ":" +
    event.transactionLogIndex.toString()
  let entity = new StakedNoteCoolDown(id)
  entity.startedBlockHash = event.block.hash
  entity.startedBlockNumber = event.block.number.toI32()
  entity.startedTimestamp = event.block.timestamp.toI32()
  entity.startedTransactionHash = event.transaction.hash
  entity.stakedNoteBalance = balance.id;
  return entity as StakedNoteCoolDown
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

export function updateStakedNotePool(sNOTEAddress: Address, pool: StakedNotePool, event: ethereum.Event): BigInt {
  let sNOTEContract = sNOTE.bind(sNOTEAddress)
  pool.lastUpdateBlockHash = event.block.hash
  pool.lastUpdateBlockNumber = event.block.number.toI32()
  pool.lastUpdateTimestamp = event.block.timestamp.toI32()
  pool.lastUpdateTransactionHash = event.transaction.hash

  pool.totalSupply = sNOTEContract.totalSupply()
  // Use this to account for gauge staking
  pool.totalBPTTokens = sNOTEContract.getPoolTokenShare(pool.totalSupply)
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

  change.sNOTEChangeType = 'Stake';
  change.ethAmountChange = event.params.wethChangeAmount;
  change.noteAmountChange = event.params.noteChangeAmount;
  change.bptAmountChange = event.params.bptChangeAmount;
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

  change.sNOTEChangeType = 'Unstake';
  change.ethAmountChange = event.params.wethChangeAmount.neg()
  change.noteAmountChange = event.params.noteChangeAmount.neg()
  change.bptAmountChange = event.params.bptChangeAmount.neg()
  change.save()
  
  let pool = getStakedNotePool(event.address.toHexString())
  updateStakedNotePool(event.address, pool, event);
}

export function handleSNoteTransfer(event: Transfer): void {
  // Don't log mint or redeem transfers
  if (event.params.from == Address.zero() || event.params.to == Address.zero()) return;

  let sender = getStakedNoteBalance(event.params.from.toHexString())
  let receiver = getStakedNoteBalance(event.params.to.toHexString())
  let sNOTEContract = sNOTE.bind(dataSource.address())
  let senderBalanceAfter = sNOTEContract.balanceOf(event.params.from);
  let receiverBalanceAfter = sNOTEContract.balanceOf(event.params.to);
  let senderBalanceChange = getStakedNoteChange(sender, event);
  let receiverBalanceChange = getStakedNoteChange(receiver, event);

  senderBalanceChange.sNOTEChangeType = 'Transfer'
  senderBalanceChange.sender = event.params.from
  senderBalanceChange.receiver = event.params.to
  senderBalanceChange.sNOTEAmountAfter = senderBalanceAfter;
  senderBalanceChange.ethAmountChange = BigInt.fromI32(0);
  senderBalanceChange.noteAmountChange = BigInt.fromI32(0);
  senderBalanceChange.bptAmountChange = BigInt.fromI32(0);
  senderBalanceChange.save()

  sender.lastUpdateBlockNumber = event.block.number.toI32();
  sender.lastUpdateTimestamp = event.block.timestamp.toI32();
  sender.lastUpdateBlockHash = event.block.hash;
  sender.lastUpdateTransactionHash = event.transaction.hash;
  sender.sNOTEBalance = senderBalanceAfter;
  sender.save();

  receiverBalanceChange.sNOTEChangeType = 'Transfer'
  receiverBalanceChange.sender = event.params.from
  receiverBalanceChange.receiver = event.params.to
  receiverBalanceChange.sNOTEAmountAfter = receiverBalanceAfter;
  receiverBalanceChange.ethAmountChange = BigInt.fromI32(0);
  receiverBalanceChange.noteAmountChange = BigInt.fromI32(0);
  receiverBalanceChange.bptAmountChange = BigInt.fromI32(0);
  receiverBalanceChange.save()

  receiver.lastUpdateBlockNumber = event.block.number.toI32();
  receiver.lastUpdateTimestamp = event.block.timestamp.toI32();
  receiver.lastUpdateBlockHash = event.block.hash;
  receiver.lastUpdateTransactionHash = event.transaction.hash;
  receiver.sNOTEBalance = receiverBalanceAfter;
  receiver.save();
}

export function handleCoolDownEnded(event: CoolDownEnded): void {
  let balance = getStakedNoteBalance(event.params.account.toHexString())
  let coolDown = getStakedNoteCoolDown(balance, event);
  balance.lastUpdateBlockNumber = event.block.number.toI32();
  balance.lastUpdateTimestamp = event.block.timestamp.toI32();
  balance.lastUpdateBlockHash = event.block.hash;
  balance.lastUpdateTransactionHash = event.transaction.hash;
  balance.currentCoolDown = null;
  balance.save()

  coolDown.userEndedCoolDown = true;
  coolDown.endedBlockNumber = event.block.number.toI32();
  coolDown.endedTimestamp = event.block.timestamp.toI32();
  coolDown.endedBlockHash = event.block.hash;
  coolDown.endedTransactionHash = event.transaction.hash;
  coolDown.save()
}

export function handleCoolDownStarted(event: CoolDownStarted): void {
  let balance = getStakedNoteBalance(event.params.account.toHexString())
  let coolDown = getStakedNoteCoolDown(balance, event);
  balance.lastUpdateBlockNumber = event.block.number.toI32();
  balance.lastUpdateTimestamp = event.block.timestamp.toI32();
  balance.lastUpdateBlockHash = event.block.hash;
  balance.lastUpdateTransactionHash = event.transaction.hash;
  balance.currentCoolDown = coolDown.id;
  balance.save()

  coolDown.userEndedCoolDown = false;
  coolDown.redeemWindowBegin = event.params.redeemWindowBegin.toI32();
  coolDown.redeemWindowEnd = event.params.redeemWindowEnd.toI32();
  coolDown.save()
}

export function handleDelegateChanged(event: DelegateChanged): void {
  let sNoteBalance = getStakedNoteBalance(event.params.delegator.toHexString());
  sNoteBalance.lastUpdateBlockNumber = event.block.number.toI32();
  sNoteBalance.lastUpdateTimestamp = event.block.timestamp.toI32();
  sNoteBalance.lastUpdateBlockHash = event.block.hash;
  sNoteBalance.lastUpdateTransactionHash = event.transaction.hash;
  sNoteBalance.delegate = event.params.toDelegate.toHexString();
  sNoteBalance.save();
}

export function handleDelegateVotesChanged(event: DelegateVotesChanged): void {
  let delegate = getDelegate(event.params.delegate.toHexString())
  delegate.lastUpdateBlockNumber = event.block.number.toI32();
  delegate.lastUpdateTimestamp = event.block.timestamp.toI32();
  delegate.lastUpdateBlockHash = event.block.hash;
  delegate.lastUpdateTransactionHash = event.transaction.hash;
  delegate.sNOTEVotingPower = event.params.newBalance;
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
  powerChange.source = 'sNOTE';
  powerChange.votingPowerBefore = event.params.previousBalance;
  powerChange.votingPowerAfter = event.params.newBalance;
  powerChange.save();
}