import {Address, BigInt, ethereum, log, store} from '@graphprotocol/graph-ts';
import {
  Notional,
  Notional__getAccountResultAccountBalancesStruct,
  Notional__getAccountResultPortfolioStruct,
} from '../generated/Notional/Notional';
import {Account, Asset, AssetChange, Balance, BalanceChange, nToken, nTokenChange} from '../generated/schema';
import {getSettlementDate} from './common';
import {updateMarkets} from './markets';

export function convertAssetToUnderlying(notional: Notional, currencyId: i32, assetAmount: BigInt): BigInt {
  let rateResult = notional.getCurrencyAndRates(currencyId);
  let assetRate = rateResult.value3;
  return assetRate.rate.times(assetAmount).div(BigInt.fromI32(10).pow(10)).div(assetRate.underlyingDecimals);
}

function convertNTokenToAsset(notional: Notional, currencyId: i32, nTokenBalance: BigInt): BigInt {
  if (nTokenBalance.isZero()) return BigInt.fromI32(0);

  let nTokenPV = notional.nTokenPresentValueAssetDenominated(currencyId);
  let nTokenAddress = notional.nTokenAddress(currencyId);
  let nTokenTotalSupply = notional.nTokenTotalSupply(nTokenAddress);
  return nTokenBalance.times(nTokenPV).div(nTokenTotalSupply);
}

function getAccount(id: string): Account {
  let entity = Account.load(id);
  if (entity == null) {
    entity = new Account(id);
    entity.balances = new Array<string>();
    entity.portfolio = new Array<string>();
  }

  return entity as Account;
}

export function getBalance(accountAddress: string, currencyId: string): Balance {
  let id = accountAddress + ':' + currencyId;
  let entity = Balance.load(id);
  if (entity == null) {
    entity = new Balance(id);
    entity.currency = currencyId;
    entity.assetCashBalance = BigInt.fromI32(0);
    entity.nTokenBalance = BigInt.fromI32(0);
    entity.lastClaimTime = 0;
    entity.lastClaimIntegralSupply = BigInt.fromI32(0);
  }

  return entity as Balance;
}

function getBalanceChange(
  accountAddress: string,
  currencyId: i32,
  event: ethereum.Event,
  balanceBefore: Balance,
  notional: Notional,
): BalanceChange {
  let id = balanceBefore.id + ':' + event.transaction.hash.toHexString() + ':' + event.logIndex.toString();
  let entity = new BalanceChange(id);
  entity.blockHash = event.block.hash;
  entity.blockNumber = event.block.number.toI32();
  entity.timestamp = event.block.timestamp.toI32();
  entity.transactionHash = event.transaction.hash;
  entity.transactionOrigin = event.transaction.from;

  entity.account = accountAddress;
  entity.currency = currencyId.toString();

  // After values be replaced if they have updated
  entity.assetCashBalanceBefore = balanceBefore.assetCashBalance;
  entity.assetCashBalanceAfter = balanceBefore.assetCashBalance;
  entity.assetCashValueUnderlyingBefore = convertAssetToUnderlying(notional, currencyId, entity.assetCashBalanceBefore);
  entity.assetCashValueUnderlyingAfter = entity.assetCashValueUnderlyingBefore;

  entity.nTokenBalanceBefore = balanceBefore.nTokenBalance;
  entity.nTokenBalanceAfter = balanceBefore.nTokenBalance;
  entity.nTokenValueAssetBefore = convertNTokenToAsset(notional, currencyId, entity.nTokenBalanceBefore);
  entity.nTokenValueAssetAfter = entity.nTokenValueAssetBefore;
  entity.nTokenValueUnderlyingBefore = convertAssetToUnderlying(notional, currencyId, entity.nTokenValueAssetBefore);
  entity.nTokenValueUnderlyingAfter = entity.nTokenValueUnderlyingBefore;

  entity.lastClaimTimeBefore = balanceBefore.lastClaimTime;
  entity.lastClaimTimeAfter = balanceBefore.lastClaimTime;
  entity.lastClaimIntegralSupplyBefore = balanceBefore.lastClaimIntegralSupply;
  entity.lastClaimIntegralSupplyAfter = balanceBefore.lastClaimIntegralSupply;

  return entity as BalanceChange;
}

function getAsset(accountAddress: string, currencyId: string, assetType: i32, maturity: BigInt): Asset {
  let assetTypeString = getAssetTypeString(assetType);
  let id = accountAddress + ':' + currencyId + ':' + assetTypeString + ':' + maturity.toString();
  let entity = Asset.load(id);
  if (entity == null) {
    entity = new Asset(id);
    entity.currency = currencyId;
    entity.assetType = assetTypeString;
    entity.maturity = maturity;
    entity.notional = BigInt.fromI32(0);
    if (assetType == 1) {
      entity.settlementDate = maturity;
    } else {
      entity.settlementDate = getSettlementDate(maturity, assetType - 1);
    }
  }

  return entity as Asset;
}

function getAssetChange(accountAddress: string, asset: Asset, event: ethereum.Event): AssetChange {
  let id = asset.id + ':' + event.transaction.hash.toHexString() + ':' + event.logIndex.toString();
  let entity = new AssetChange(id);
  entity.blockHash = event.block.hash;
  entity.blockNumber = event.block.number.toI32();
  entity.timestamp = event.block.timestamp.toI32();
  entity.transactionHash = event.transaction.hash;
  entity.transactionOrigin = event.transaction.from;

  entity.account = accountAddress;
  entity.currency = asset.currency;
  entity.maturity = asset.maturity;
  entity.settlementDate = asset.settlementDate;
  entity.assetType = asset.assetType;
  entity.notionalBefore = asset.notional;

  return entity;
}

function getNTokenChange(nTokenAccount: nToken, event: ethereum.Event): nTokenChange {
  let id =
    nTokenAccount.tokenAddress.toHexString() +
    ':' +
    event.transaction.hash.toHexString() +
    ':' +
    event.logIndex.toString();
  let entity = new nTokenChange(id);
  entity.blockHash = event.block.hash;
  entity.blockNumber = event.block.number.toI32();
  entity.timestamp = event.block.timestamp.toI32();
  entity.transactionHash = event.transaction.hash;
  entity.transactionOrigin = event.transaction.from;

  entity.nToken = nTokenAccount.id;
  entity.totalSupplyBefore = nTokenAccount.totalSupply;
  entity.totalSupplyAfter = nTokenAccount.totalSupply;
  entity.integralTotalSupplyBefore = nTokenAccount.integralTotalSupply;
  entity.integralTotalSupplyAfter = nTokenAccount.integralTotalSupply;
  entity.lastSupplyChangeTimeBefore = nTokenAccount.lastSupplyChangeTime;
  entity.lastSupplyChangeTimeAfter = nTokenAccount.lastSupplyChangeTime;

  return entity;
}

function getAssetTypeString(assetType: i32): string {
  if (assetType == 1) return 'fCash';
  if (assetType == 2) return 'LiquidityToken_3Month';
  if (assetType == 3) return 'LiquidityToken_6Month';
  if (assetType == 4) return 'LiquidityToken_1Year';
  if (assetType == 5) return 'LiquidityToken_2Year';
  if (assetType == 6) return 'LiquidityToken_5Year';
  if (assetType == 7) return 'LiquidityToken_10Year';
  if (assetType == 8) return 'LiquidityToken_20Year';

  return 'unknown';
}

export function updateAccount(accountAddress: Address, event: ethereum.Event): void {
  let notional = Notional.bind(event.address);
  let account = getAccount(accountAddress.toHexString());
  let accountResult = notional.getAccount(accountAddress);
  let accountContext = accountResult.value0;

  account.nextSettleTime = accountContext.nextSettleTime;
  let hasDebtHex = accountContext.hasDebt.toHexString();
  if (hasDebtHex == '0x01' || hasDebtHex == '0x03') {
    account.hasPortfolioAssetDebt = true;
  } else {
    account.hasPortfolioAssetDebt = false;
  }

  if (hasDebtHex == '0x02' || hasDebtHex == '0x03') {
    account.hasCashDebt = true;
  } else {
    account.hasCashDebt = false;
  }

  if (accountContext.bitmapCurrencyId != 0) {
    let id = accountContext.bitmapCurrencyId as i32;
    account.assetBitmapCurrency = id.toString();
  } else {
    account.assetBitmapCurrency = null;
  }

  updateBalances(account, accountResult.value1, event, notional);
  updateAssets(account, accountResult.value2, event);

  account.lastUpdateBlockNumber = event.block.number.toI32();
  account.lastUpdateTimestamp = event.block.timestamp.toI32();
  account.lastUpdateBlockHash = event.block.hash;
  account.lastUpdateTransactionHash = event.transaction.hash;

  log.debug('Updated account variables for entity {}', [account.id]);
  account.save();
}

export function updateNTokenPortfolio(nTokenObj: nToken, event: ethereum.Event, minter: Address | null): void {
  let notional = Notional.bind(event.address);
  let account = getAccount(nTokenObj.tokenAddress.toHexString());
  let nTokenAccountResult = notional.getNTokenAccount(nTokenObj.tokenAddress as Address);
  let nTokenPortfolioResult = notional.getNTokenPortfolio(nTokenObj.tokenAddress as Address);
  let currencyId = nTokenAccountResult.value0;
  let nTokenChangeObject = getNTokenChange(nTokenObj, event);

  if (minter) {
    // This is the account that is minting or redeeming nTokens. Will be set to null on initialze markets
    nTokenChangeObject.account = minter.toHexString();
  }

  // Update cash balance (this must exist as a result of deploying an nToken)
  let balance = getBalance(account.id, currencyId.toString());
  if (balance.assetCashBalance.notEqual(nTokenAccountResult.value5)) {
    let balanceChange = getBalanceChange(account.id, currencyId, event, balance, notional);
    balance.assetCashBalance = nTokenAccountResult.value5;
    balanceChange.assetCashBalanceAfter = nTokenAccountResult.value5;
    balanceChange.assetCashValueUnderlyingAfter = convertAssetToUnderlying(
      notional,
      currencyId,
      balanceChange.assetCashBalanceAfter,
    );

    balance.lastUpdateBlockNumber = event.block.number.toI32();
    balance.lastUpdateTimestamp = event.block.timestamp.toI32();
    balance.lastUpdateBlockHash = event.block.hash;
    balance.lastUpdateTransactionHash = event.transaction.hash;

    log.debug('Updated nToken balance entity {}', [balance.id]);
    balance.save();
    balanceChange.save();
    nTokenChangeObject.balanceChange = balanceChange.id;
  }

  // Update total supply
  if (nTokenObj.totalSupply.notEqual(nTokenAccountResult.value1)) {
    nTokenObj.totalSupply = nTokenAccountResult.value1;
    nTokenObj.integralTotalSupply = nTokenAccountResult.value6;
    nTokenObj.lastSupplyChangeTime = nTokenAccountResult.value7;
    nTokenChangeObject.totalSupplyAfter = nTokenAccountResult.value1;
    nTokenChangeObject.integralTotalSupplyAfter = nTokenAccountResult.value6;
    nTokenChangeObject.lastSupplyChangeTimeAfter = nTokenAccountResult.value7;

    nTokenObj.lastUpdateBlockNumber = event.block.number.toI32();
    nTokenObj.lastUpdateTimestamp = event.block.timestamp.toI32();
    nTokenObj.lastUpdateBlockHash = event.block.hash;
    nTokenObj.lastUpdateTransactionHash = event.transaction.hash;

    log.debug('Updated nToken.totalSupply {}', [nTokenObj.id]);
    nTokenObj.save();
  }

  // Update portfolio. This casting works because the underlying type returned from solidity is the same
  let mergedAssetArray = new Array<Notional__getAccountResultPortfolioStruct>();
  let liquidityTokens = nTokenPortfolioResult.value0;
  let fCashAssets = nTokenPortfolioResult.value1;
  for (let i: i32 = 0; i < liquidityTokens.length; i++) {
    mergedAssetArray.push(liquidityTokens[i] as Notional__getAccountResultPortfolioStruct);
  }

  for (let i: i32 = 0; i < fCashAssets.length; i++) {
    mergedAssetArray.push(fCashAssets[i] as Notional__getAccountResultPortfolioStruct);
  }

  nTokenChangeObject.assetChanges = updateAssets(account, mergedAssetArray, event);
  nTokenChangeObject.save();

  account.lastUpdateBlockNumber = event.block.number.toI32();
  account.lastUpdateTimestamp = event.block.timestamp.toI32();
  account.lastUpdateBlockHash = event.block.hash;
  account.lastUpdateTransactionHash = event.transaction.hash;
  log.debug('Updated nToken account entity {}', [account.id]);
  account.save();
}

function updateBalances(
  account: Account,
  accountBalances: Notional__getAccountResultAccountBalancesStruct[],
  event: ethereum.Event,
  notional: Notional,
): string[] {
  let newBalanceIds = new Array<string>();
  let balanceChangeIds = new Array<string>();
  for (let i: i32 = 0; i < accountBalances.length; i++) {
    let currencyId = accountBalances[i].currencyId;
    if (currencyId == 0) continue;

    let balance = getBalance(account.id, currencyId.toString());
    let balanceChange = getBalanceChange(account.id, currencyId, event, balance, notional);
    let didUpdate = false;

    if (balance.assetCashBalance.notEqual(accountBalances[i].cashBalance)) {
      didUpdate = true;
      balance.assetCashBalance = accountBalances[i].cashBalance;
      balanceChange.assetCashBalanceAfter = accountBalances[i].cashBalance;
      balanceChange.assetCashValueUnderlyingAfter = convertAssetToUnderlying(
        notional,
        currencyId,
        balanceChange.assetCashBalanceAfter,
      );
    }

    if (balance.nTokenBalance.notEqual(accountBalances[i].nTokenBalance)) {
      didUpdate = true;
      balance.nTokenBalance = accountBalances[i].nTokenBalance;
      balanceChange.nTokenBalanceAfter = accountBalances[i].nTokenBalance;
      balanceChange.nTokenValueAssetAfter = convertNTokenToAsset(
        notional,
        currencyId,
        balanceChange.nTokenBalanceAfter,
      );
      balanceChange.nTokenValueUnderlyingAfter = convertAssetToUnderlying(
        notional,
        currencyId,
        balanceChange.nTokenValueAssetAfter,
      );
    }

    if (balance.lastClaimIntegralSupply.notEqual(accountBalances[i].lastClaimIntegralSupply)) {
      didUpdate = true;
      balance.lastClaimIntegralSupply = accountBalances[i].lastClaimIntegralSupply;
      balanceChange.lastClaimIntegralSupplyAfter = accountBalances[i].lastClaimIntegralSupply;
    }

    if (balance.lastClaimTime != accountBalances[i].lastClaimTime.toI32()) {
      didUpdate = true;
      balance.lastClaimTime = accountBalances[i].lastClaimTime.toI32();
      balanceChange.lastClaimTimeAfter = accountBalances[i].lastClaimTime.toI32();
    }

    if (didUpdate) {
      balanceChange.save();
      balance.lastUpdateBlockNumber = event.block.number.toI32();
      balance.lastUpdateTimestamp = event.block.timestamp.toI32();
      balance.lastUpdateBlockHash = event.block.hash;
      balance.lastUpdateTransactionHash = event.transaction.hash;

      log.debug('Updated balance entity {}', [balance.id]);
      balance.save();
    }

    // If both cash balances and nToken balances are zero, this account balances object should not
    // be listed in the balance ids list.
    if (!accountBalances[i].cashBalance.isZero() || !accountBalances[i].nTokenBalance.isZero()) {
      newBalanceIds.push(balance.id);
    }
  }

  let oldBalances = account.balances;
  for (let i: i32 = 0; i < oldBalances.length; i++) {
    // Removes old balance ids that are no longer part of the account
    if (newBalanceIds.indexOf(oldBalances[i]) == -1) {
      let deletedBalance = Balance.load(oldBalances[i]);
      // If this happens something weird occurred.
      if (deletedBalance == null) {
        log.critical('Deleted balance not found {}', [oldBalances[i]]);
      } else {
        let balanceChange = getBalanceChange(
          account.id,
          parseI32(deletedBalance.currency, 10),
          event,
          deletedBalance as Balance,
          notional,
        );
        balanceChange.assetCashBalanceAfter = BigInt.fromI32(0);
        balanceChange.assetCashValueUnderlyingAfter = BigInt.fromI32(0);
        balanceChange.nTokenBalanceAfter = BigInt.fromI32(0);
        balanceChange.nTokenValueAssetAfter = BigInt.fromI32(0);
        balanceChange.nTokenValueUnderlyingAfter = BigInt.fromI32(0);
        balanceChange.lastClaimTimeAfter = 0;
        balanceChange.lastClaimIntegralSupplyAfter = BigInt.fromI32(0);
        balanceChange.save();
        store.remove('Balance', deletedBalance.id);
        log.debug('Balance entity deleted {}', [deletedBalance.id]);

        balanceChangeIds.push(balanceChange.id);
      }
    }
  }

  account.balances = newBalanceIds;

  return balanceChangeIds;
}

function updateAssets(
  account: Account,
  portfolio: Notional__getAccountResultPortfolioStruct[],
  event: ethereum.Event,
): string[] {
  let newAssetIds = new Array<string>();
  let assetChangeIds = new Array<string>();

  for (let i: i32 = 0; i < portfolio.length; i++) {
    let currencyId = portfolio[i].currencyId.toI32();
    let maturity = portfolio[i].maturity;
    let asset = getAsset(account.id, currencyId.toString(), portfolio[i].assetType.toI32(), maturity);

    if (asset.notional.notEqual(portfolio[i].notional)) {
      let assetChange = getAssetChange(account.id, asset, event);
      assetChange.notionalAfter = portfolio[i].notional;
      assetChange.save();

      asset.notional = portfolio[i].notional;
      asset.lastUpdateBlockNumber = event.block.number.toI32();
      asset.lastUpdateTimestamp = event.block.timestamp.toI32();
      asset.lastUpdateBlockHash = event.block.hash;
      asset.lastUpdateTransactionHash = event.transaction.hash;

      log.debug('Updated asset entity {}', [asset.id]);
      asset.save();
    }

    newAssetIds.push(asset.id);
  }

  let oldAssets = account.portfolio;
  for (let i: i32 = 0; i < oldAssets.length; i++) {
    // Removes old balance ids that are no longer part of the account
    if (newAssetIds.indexOf(oldAssets[i]) == -1) {
      let deletedAsset = Asset.load(oldAssets[i]);
      // If this happens something weird occurred.
      if (deletedAsset == null) {
        log.critical('Deleted asset not found {}', [oldAssets[i]]);
      } else {
        // If deleted asset is a liquidity token, need to update markets
        if (deletedAsset.assetType != 'fCash') {
          let currencyId = I32.parseInt(deletedAsset.currency);
          // The deleted asset block time is used to get active markets at a particular block time,
          // in this case it is right before settlement
          let deletedAssetBlockTime = deletedAsset.settlementDate.minus(BigInt.fromI32(1)).toI32();
          updateMarkets(currencyId, deletedAssetBlockTime, event);
        }

        let assetChange = getAssetChange(account.id, deletedAsset as Asset, event);
        assetChange.notionalAfter = BigInt.fromI32(0);
        assetChange.save();
        store.remove('Asset', deletedAsset.id);
        log.debug('Asset entity deleted {}', [deletedAsset.id]);

        assetChangeIds.push(assetChange.id);
      }
    }
  }

  account.portfolio = newAssetIds;

  return assetChangeIds;
}
