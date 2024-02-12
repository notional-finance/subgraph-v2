import { ethereum, BigInt, log, Address, Bytes } from "@graphprotocol/graph-ts";
import {
  BalanceSnapshot,
  Incentive,
  IncentiveSnapshot,
  ProfitLossLineItem,
  Token,
  Transfer,
  TransferBundle,
} from "../../../generated/schema";
import { INTERNAL_TOKEN_PRECISION, NOTE, SCALAR_PRECISION } from "../constants";
import { SecondaryRewarder } from "../../../generated/Configuration/SecondaryRewarder";
import { getAccount, getAsset, getNotional } from "../entities";
import { getBalance } from "../../balances";

function toAddress(account: string): Address {
  return Address.fromBytes(Address.fromHexString(account));
}

function getNOTE(): Token {
  return getAsset(
    getNotional()
      .getNoteToken()
      .toHexString()
  );
}

export function shouldCreateIncentiveSnapshot(
  bundleName: string,
  currencyId: i32,
  transfer: Transfer,
  event: ethereum.Event,
  nToken: Token
): boolean {
  if (bundleName == "Transfer Secondary Incentive") {
    // Secondary rewarder transfers come directly from the matched rewarder so we can check
    // here if the transfer is coming from the secondary.
    let incentives = Incentive.load(currencyId.toString());
    return (
      incentives !== null &&
      incentives.secondaryIncentiveRewarder !== null &&
      (incentives.secondaryIncentiveRewarder as Bytes).toHexString() == transfer.from
    );
  } else if (bundleName == "Transfer Incentive") {
    let NOTE_Token = getNOTE();
    let account = getAccount(transfer.to, event);
    let balance = getBalance(account, nToken, event);
    if (balance.get("current") === null) return false;

    let prevSnapshot = IncentiveSnapshot.load((balance.current as string) + ":" + NOTE_Token.id);
    let currentIncentiveDebt = getAccountIncentiveDebt(account.id, currencyId);

    // Return true if the incentive debt did change
    return (
      prevSnapshot !== null &&
      !currentIncentiveDebt.isZero() &&
      prevSnapshot.currentIncentiveDebt != currentIncentiveDebt
    );
  }

  return false;
}

/**
 * Creates the initial incentive snapshot when establishing a balance. Since no transfers
 * occur. This sets the initial reward debt.
 */
export function setInitialIncentiveSnapshot(
  account: string,
  snapshot: BalanceSnapshot,
  token: Token
): void {
  // When establishing an nToken balance, must also set the initial reward debt
  let NOTE_Token = getNOTE();
  let s = createSnapshotForIncentives(account, snapshot, NOTE_Token, token);
  if (s) s.save();
  let incentives = Incentive.load(token.currencyId.toString());

  // Set the secondary reward debt if it exists
  if (incentives !== null && incentives.secondaryIncentiveRewarder !== null) {
    let rewardToken = getAsset(incentives.currentSecondaryReward as string);
    let s = createSnapshotForIncentives(account, snapshot, rewardToken, token);
    if (s) s.save();
  }
}

function getAccountIncentiveDebt(account: string, currencyId: i32): BigInt {
  let notional = getNotional();
  let b = notional.getAccount(toAddress(account)).getAccountBalances();
  for (let i = 0; i < b.length; i++) {
    if (b[i].currencyId == currencyId) return b[i].accountIncentiveDebt;
  }

  // Return zero if not found
  return BigInt.zero();
}

export function createIncentiveLineItem(
  bundle: TransferBundle,
  tokenTransfer: Transfer,
  transferAmount: BigInt,
  incentivizedTokenId: string,
  lineItems: ProfitLossLineItem[]
): void {
  let item = new ProfitLossLineItem(bundle.id + ":" + lineItems.length.toString());
  item.bundle = bundle.id;
  item.blockNumber = bundle.blockNumber;
  item.timestamp = bundle.timestamp;
  item.transactionHash = bundle.transactionHash;
  item.token = tokenTransfer.token;
  item.underlyingToken = tokenTransfer.underlying;

  item.account = tokenTransfer.to;
  item.tokenAmount = transferAmount;
  item.underlyingAmountRealized = BigInt.zero();
  item.underlyingAmountSpot = BigInt.zero();
  item.realizedPrice = BigInt.zero();
  item.spotPrice = BigInt.zero();
  item.isTransientLineItem = false;
  item.incentivizedToken = incentivizedTokenId;

  lineItems.push(item);
}

function createSnapshotForIncentives(
  account: string,
  snapshot: BalanceSnapshot,
  rewardToken: Token,
  nToken: Token
): IncentiveSnapshot | null {
  let id = snapshot.id + ":" + rewardToken.id;

  // If the incentive snapshot has already been created, then return a zero and don't re-calculate
  // due to the nature of how how incentive transfers work.
  if (IncentiveSnapshot.load(id)) return null;

  let incentiveSnapshot = new IncentiveSnapshot(id);
  incentiveSnapshot.blockNumber = snapshot.blockNumber;
  incentiveSnapshot.timestamp = snapshot.timestamp;
  incentiveSnapshot.transaction = snapshot.transaction;
  incentiveSnapshot.balanceSnapshot = snapshot.id;
  incentiveSnapshot.rewardToken = rewardToken.id;

  incentiveSnapshot.previousIncentiveDebt = BigInt.zero();
  incentiveSnapshot.totalClaimed = BigInt.zero();
  incentiveSnapshot.adjustedClaimed = BigInt.zero();

  if (snapshot.previousSnapshot) {
    let prevSnapshot = IncentiveSnapshot.load(
      (snapshot.previousSnapshot as string) + ":" + rewardToken.id
    );

    if (prevSnapshot) {
      incentiveSnapshot.previousIncentiveDebt = prevSnapshot.currentIncentiveDebt;
      incentiveSnapshot.totalClaimed = prevSnapshot.totalClaimed;
      incentiveSnapshot.adjustedClaimed = prevSnapshot.adjustedClaimed;
    }
  }

  if (rewardToken.symbol == NOTE) {
    incentiveSnapshot.currentIncentiveDebt = getAccountIncentiveDebt(account, nToken.currencyId);
  } else {
    let incentives = Incentive.load(nToken.currencyId.toString());
    incentiveSnapshot.currentIncentiveDebt = BigInt.zero();
    if (incentives !== null && incentives.secondaryIncentiveRewarder !== null) {
      let r = SecondaryRewarder.bind(
        Address.fromBytes(incentives.secondaryIncentiveRewarder as Bytes)
      );
      incentiveSnapshot.currentIncentiveDebt = r.rewardDebtPerAccount(toAddress(account));
    }
  }

  return incentiveSnapshot;
}

export function updateSnapshotForIncentives(
  snapshot: BalanceSnapshot,
  transfer: Transfer,
  nToken: Token
): BigInt {
  let rewardToken = getAsset(transfer.token);
  let incentiveSnapshot = createSnapshotForIncentives(transfer.to, snapshot, rewardToken, nToken);
  // In these cases, no incentive has been accrued to the account
  if (
    incentiveSnapshot == null ||
    incentiveSnapshot.currentIncentiveDebt.isZero() ||
    incentiveSnapshot.currentIncentiveDebt == incentiveSnapshot.previousIncentiveDebt
  )
    return BigInt.zero();

  let incentivesClaimed: BigInt;
  if (rewardToken.symbol == NOTE) {
    // NOTE incentives are found on the notional contract directly
    let notional = getNotional();

    let accumulatedPerNToken = notional
      .getNTokenAccount(Address.fromBytes(Address.fromHexString(nToken.id)))
      .getAccumulatedNOTEPerNToken();

    // This is mimics the incentive claim calculation internally
    incentivesClaimed = snapshot.previousBalance
      .times(accumulatedPerNToken)
      .div(SCALAR_PRECISION)
      .minus(incentiveSnapshot.previousIncentiveDebt);
  } else {
    let r = SecondaryRewarder.bind(Address.fromBytes(Address.fromHexString(transfer.from)));
    // If this is not the matching nToken, then don't calculate the incentives claimed
    let r_nToken = r.NTOKEN_ADDRESS().toHexString();
    if (r_nToken != nToken.id) return BigInt.zero();
    let accumulatedPerNToken = r.accumulatedRewardPerNToken();

    incentivesClaimed = snapshot.previousBalance
      .times(accumulatedPerNToken)
      .div(INTERNAL_TOKEN_PRECISION)
      // This incentive debt is always in SCALAR_PRECISION
      .minus(incentiveSnapshot.previousIncentiveDebt)
      .times(rewardToken.precision)
      .div(SCALAR_PRECISION);
  }

  incentiveSnapshot.totalClaimed = incentiveSnapshot.totalClaimed.plus(incentivesClaimed);
  // If the balance increases, add the token amount to the virtual NOTE balance
  incentiveSnapshot.adjustedClaimed = incentiveSnapshot.adjustedClaimed.plus(incentivesClaimed);

  // This is referring to the nToken balance snapshot
  if (snapshot.previousBalance.gt(snapshot.currentBalance)) {
    // When nTokens are redeemed, we adjust the reward earned downwards
    let rewardAdjustment = snapshot.previousBalance
      .minus(snapshot.currentBalance)
      // Converts to the reward token precision
      .times(incentiveSnapshot.adjustedClaimed)
      .div(snapshot.previousBalance);

    incentiveSnapshot.adjustedClaimed = incentiveSnapshot.adjustedClaimed.minus(rewardAdjustment);
  }

  incentiveSnapshot.save();

  return incentivesClaimed;
}
