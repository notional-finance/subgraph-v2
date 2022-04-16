import { Address, BigInt, dataSource, ethereum } from "@graphprotocol/graph-ts"
import { ERC20 } from "../generated/Notional/ERC20"
import { BalancerVault } from "../generated/StakedNote/BalancerVault"
import { StakedNoteBalance, StakedNoteChange, StakedNotePool, StakedNoteTvl } from "../generated/schema"
import { createDailyTvlId } from './timeseriesUpdate';
import { sNOTE, SNoteMinted, SNoteRedeemed } from "../generated/StakedNote/sNOTE"
import { BI_DAILY_BLOCK_UPDATE, getTvlHistoricalData } from "./notional";

export function handleBlockUpdates(event: ethereum.Block): void {
  handleHourlyUpdates(event);
}

function getStakedNOTETvl(id: string, timestamp: i32) {
  let entity = StakedNoteTvl.load(id);
  if (entity == null) {
    entity = new StakedNoteTvl(id);
    entity.timestamp = timestamp
  }
  return entity as StakedNoteTvl;

}

function handleHourlyUpdates(event: ethereum.Block): void {
  if (event.number.toI32() % BI_DAILY_BLOCK_UPDATE != 0) {
      return;
  }
  let timestamp = event.timestamp.toI32();
  let historicalId = createDailyTvlId(timestamp);
  let tvlHistoricalData = getTvlHistoricalData(historicalId, timestamp);
  let sNOTETvl = getStakedNOTETvl(historicalId, tvlHistoricalData.timestamp);

  let sNOTEContract = sNOTE.bind(dataSource.address())
  let WETH_INDEX = sNOTEContract.WETH_INDEX().toI32()
  let NOTE_INDEX = sNOTEContract.NOTE_INDEX().toI32()
  let balancerPool = ERC20.bind(sNOTEContract.BALANCER_POOL_TOKEN())
  let balancerVault = BalancerVault.bind(sNOTEContract.BALANCER_VAULT())
  let poolTokens = balancerVault.getPoolTokens(sNOTEContract.NOTE_ETH_POOL_ID())

  sNOTETvl.sNOTETotalSupply = sNOTEContract.totalSupply();
  // Use this instead of balanceOf on the BPT Token to account for gauge staking
  sNOTETvl.poolBPTBalance = sNOTEContract.getPoolTokenShare(sNOTETvl.sNOTETotalSupply);

  let totalSupply = balancerPool.totalSupply()
  sNOTETvl.poolNOTEBalance = poolTokens.value1[NOTE_INDEX].times(sNOTETvl.poolBPTBalance).div(totalSupply);
  sNOTETvl.poolETHBalance = poolTokens.value1[WETH_INDEX].times(sNOTETvl.poolBPTBalance).div(totalSupply);

  // Numerator: WETH * 5 * 1e18
  let spotPriceNumerator = sNOTETvl.poolETHBalance
    .times(BigInt.fromI32(10).pow(18))
    .times(BigInt.fromI32(5));
  // Denominator: NOTE * 1e10 * 1.25
  let spotPriceDenominator = sNOTETvl.poolNOTEBalance
    .times(BigInt.fromI32(10).pow(10))
    .times(BigInt.fromI32(125))
    .div(BigInt.fromI32(100));
  sNOTETvl.spotPrice = spotPriceNumerator.div(spotPriceDenominator);

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