import {
  Address,
  BigInt,
  ByteArray,
  Bytes,
  dataSource,
  ethereum,
  log,
} from "@graphprotocol/graph-ts";
import {
  FEE_RESERVE,
  RATE_DECIMALS,
  RATE_PRECISION,
  SCALAR_DECIMALS,
  SCALAR_PRECISION,
  ZERO_ADDRESS,
  fCashOracleRate,
  fCashSettlementRate,
  fCashSpotRate,
  fCashToUnderlyingExchangeRate,
} from "../common/constants";
import {
  createTransfer,
  createTransferBundle,
  getAccount,
  getAsset,
  getIncentives,
  getNotionalV2,
  getOracle,
  getUnderlying,
  isV2,
} from "../common/entities";
import {
  convertToNegativeFCashId,
  convertToPositiveFCashId,
  encodeFCashID,
  getOrCreateERC1155Asset,
} from "../common/erc1155";
import {
  IncentivesMigrated,
  LendBorrowTrade,
  LiquidateCollateralCurrency,
  LiquidateLocalCurrency,
  LiquidatefCashEvent,
  ReserveBalanceUpdated,
  SetSettlementRate,
  SettledCashDebt,
  nTokenResidualPurchase,
  nTokenSupplyChange,
} from "../../generated/Assets/NotionalV2";
import { AccountContextUpdate } from "../../generated/Configuration/NotionalV3";
import { Transfer as TransferEvent } from "../../generated/Assets/ERC20";
import { Token, Transfer, TransferBundle, VersionContext } from "../../generated/schema";
import {
  convertValueToUnderlying,
  decodeSystemAccount,
  decodeTransferType,
} from "../common/transfers";
import { processProfitAndLoss } from "../common/profit_loss";
import { QUARTER, getTimeRef } from "../common/market";
import { getBalance, updateAccount } from "../balances";

export function getAssetToken(currencyId: i32): Address {
  let notional = getNotionalV2();
  let currency = notional.getCurrency(currencyId);
  let tokenAddress = currency.getAssetToken().tokenAddress;
  if (tokenAddress.equals(Address.fromString("0xc11b1268c1a384e55c48c2391d8d480264a3a7f4"))) {
    // There was a mistake during mainnet deployment where cWBTC1 was listed instead of cWBTC2, it was fixed
    // but there was no event emitted so we will hardcode a patch here.
    tokenAddress = Address.fromString("0xccf4429db6322d5c611ee964527d42e5d685dd6a");
  }

  return tokenAddress;
}

export function handleV2SettlementRate(event: SetSettlementRate): void {
  let notional = getNotionalV2();
  // NOTE: need to encode manually because one time we shut off the contract on initialize markets
  let positivefCashId = encodeFCashID(event.params.currencyId, event.params.maturity);
  let currency = notional.getCurrency(event.params.currencyId.toI32());
  let assetCash = getAsset(currency.getAssetToken().tokenAddress.toHexString());

  let positivefCash = getOrCreateERC1155Asset(positivefCashId, event.block, event.transaction.hash);
  let negativefCashId = convertToNegativeFCashId(positivefCashId);
  let negativefCash = getOrCreateERC1155Asset(negativefCashId, event.block, event.transaction.hash);

  let posOracle = getOracle(positivefCash, assetCash, fCashSettlementRate);
  posOracle.oracleAddress = notional._address;
  // TODO: what precision are these oracle rates?
  posOracle.decimals = SCALAR_DECIMALS;
  posOracle.ratePrecision = SCALAR_PRECISION;
  posOracle.latestRate = event.params.rate;
  posOracle.lastUpdateBlockNumber = event.block.number;
  posOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
  posOracle.lastUpdateTransaction = event.transaction.hash.toHexString();
  posOracle.save();

  let base = getUnderlying(event.params.currencyId.toI32());
  {
    let fCashExRate = getOracle(base, positivefCash, fCashToUnderlyingExchangeRate);
    fCashExRate.oracleAddress = notional._address;
    fCashExRate.decimals = RATE_DECIMALS;
    fCashExRate.ratePrecision = RATE_PRECISION;
    fCashExRate.latestRate = RATE_PRECISION;
    fCashExRate.lastUpdateBlockNumber = event.block.number;
    fCashExRate.lastUpdateTimestamp = event.block.timestamp.toI32();
    fCashExRate.lastUpdateTransaction = event.transaction.hash.toHexString();
    fCashExRate.matured = true;
    fCashExRate.save();
  }

  {
    let fCashOracle = getOracle(base, positivefCash, fCashOracleRate);
    fCashOracle.oracleAddress = notional._address;
    fCashOracle.decimals = RATE_DECIMALS;
    fCashOracle.ratePrecision = RATE_PRECISION;
    // Oracle interest rate is now zero
    fCashOracle.latestRate = BigInt.fromI32(0);
    fCashOracle.lastUpdateBlockNumber = event.block.number;
    fCashOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
    fCashOracle.lastUpdateTransaction = event.transaction.hash.toHexString();
    fCashOracle.matured = true;
    fCashOracle.save();
  }

  // Spot interest rate is also zero, same as oracle interest rate
  {
    let fCashSpot = getOracle(base, positivefCash, fCashSpotRate);
    fCashSpot.oracleAddress = notional._address;
    fCashSpot.decimals = RATE_DECIMALS;
    fCashSpot.ratePrecision = RATE_PRECISION;
    fCashSpot.latestRate = BigInt.fromI32(0);
    fCashSpot.lastUpdateBlockNumber = event.block.number;
    fCashSpot.lastUpdateTimestamp = event.block.timestamp.toI32();
    fCashSpot.lastUpdateTransaction = event.transaction.hash.toHexString();
    fCashSpot.matured = true;
    fCashSpot.save();
  }

  {
    let negOracle = getOracle(negativefCash, assetCash, fCashSettlementRate);
    negOracle.oracleAddress = notional._address;
    // TODO: what precision are these oracle rates?
    negOracle.decimals = SCALAR_DECIMALS;
    negOracle.ratePrecision = SCALAR_PRECISION;
    negOracle.latestRate = event.params.rate;
    negOracle.lastUpdateBlockNumber = event.block.number;
    negOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
    negOracle.lastUpdateTransaction = event.transaction.hash.toHexString();
    negOracle.save();
  }

  {
    let fCashExRate = getOracle(base, negativefCash, fCashToUnderlyingExchangeRate);
    fCashExRate.oracleAddress = notional._address;
    fCashExRate.decimals = RATE_DECIMALS;
    fCashExRate.ratePrecision = RATE_PRECISION;
    fCashExRate.latestRate = RATE_PRECISION;
    fCashExRate.lastUpdateBlockNumber = event.block.number;
    fCashExRate.lastUpdateTimestamp = event.block.timestamp.toI32();
    fCashExRate.lastUpdateTransaction = event.transaction.hash.toHexString();
    fCashExRate.matured = true;
    fCashExRate.save();
  }
}

export function handleIncentivesMigrated(event: IncentivesMigrated): void {
  let currencyId = event.params.currencyId as i32;
  let migration = getIncentives(currencyId, event);
  migration.migrationEmissionRate = event.params.migrationEmissionRate;
  migration.migrationTime = event.params.migrationTime;
  migration.finalIntegralTotalSupply = event.params.finalIntegralTotalSupply;
  migration.save();

  let versionContext = VersionContext.load("0");
  if (versionContext) {
    versionContext.didMigrateIncentives = true;
    versionContext.save();
  }
}

export function handleReserveBalanceUpdated(event: ReserveBalanceUpdated): void {}

export function handleV2AccountContextUpdate(event: AccountContextUpdate): void {
  if (!isV2()) return;
  if (event.receipt == null) log.critical("Transaction Receipt not Found", []);
  let notional = getNotionalV2();
  let receipt = event.receipt as ethereum.TransactionReceipt;
  let eventType: string[] = new Array<string>();
  let events: ethereum.Event[] = new Array<ethereum.Event>();
  let account = event.params.account;

  // Returns any settled balances, fCash repays and borrows
  let transferBundles = updateV2AccountBalances(account, event);

  // Parse all the relevant events in the receipt
  for (let i = 0; i < receipt.logs.length; i++) {
    let _log = receipt.logs[i];
    if (_log.address != notional._address) continue;
    // NOTE: this will be the hash of the signature of the event
    let topic = _log.topics[0].toHexString();
    for (let i = 0; i < EventsConfig.length; i++) {
      let e = EventsConfig[i];
      if (topic != e.topicHash) continue;
      eventType.push(e.name);
      events.push(e.parseLog(_log, event));
    }
  }

  for (let i = 0; i < events.length; i++) {
    let eventName = eventType[i];
    // If the account context being updated is not the primary actor in the
    // action we do not create transfer bundles so that we avoid creating
    // duplicate bundles

    // Convert the events list into a set of bundles and transfers
    // inside those bundles
    for (let j = 0; j < EventsConfig.length; j++) {
      if (eventName != EventsConfig[j].name) continue;
      let bundles = EventsConfig[j].createBundle(events[i], account);
      if (bundles !== null) {
        transferBundles = transferBundles.concat(bundles);
      }
    }
  }

  // Finally sort this into some expected ordering and call profitLossLineItem
  let bundleArray: string[] = new Array<string>();
  for (let i = 0; i < transferBundles.length; i++) {
    // TODO: sort these somehow....
    bundleArray.push(transferBundles[i].id);
  }

  /*
  for (let i = 0; i < transferBundles.length; i++) {
    let transfers: Transfer[] = transferBundles[i].transfers.map<Transfer>((id: string) => {
      // The transfer must always be found at this point
      let t = Transfer.load(id);
      if (t == null) log.critical("{} transfer id not found", [id]);
      return t as Transfer;
    });

    processProfitAndLoss(transferBundles[i], transfers, bundleArray, event);
  }
  */
}

function updateV2AccountBalances(acct: Address, event: ethereum.Event): TransferBundle[] {
  let account = getAccount(acct.toHexString(), event);
  for (let currencyId = 1; currencyId <= 4; currencyId++) {
    let assetCash = getAssetCash(currencyId);
    let cashBalance = getBalance(account, assetCash, event);
    updateAccount(assetCash, account, cashBalance, event);

    let nToken = getNToken(currencyId);
    let nTokenBalance = getBalance(account, nToken, event);
    updateAccount(nToken, account, nTokenBalance, event);
  }

  let notional = getNotionalV2();
  let portfolio = notional.getAccountPortfolio(acct);

  let context = dataSource.context();
  let _f = context.get(acct.toHexString());
  let prevfCashIds: Array<string>;
  if (_f == null) {
    prevfCashIds = new Array<string>();
  } else {
    prevfCashIds = _f.toString().split(":");
  }

  let transferBundles: TransferBundle[] = new Array<TransferBundle>();
  for (let i = 0; i < prevfCashIds.length; i++) {
    // This is stored as the positive or negative fCash id
    let fCash = getAsset(prevfCashIds[i]);
    let fCashIdInt = encodeFCashID(BigInt.fromI32(fCash.currencyId), fCash.maturity!);

    let balance = getBalance(account, fCash, event);
    let snapshot = updateAccount(fCash, account, balance, event);

    if (fCash.maturity!.le(event.block.timestamp)) {
      // Return a settle fCash and cash bundle pair
      let assetCash = getAssetCash(fCash.currencyId);
      transferBundles.push(
        createBundle("Settle fCash", event, [
          burnToken(acct, fCash, snapshot.previousBalance, event),
        ])
      );

      transferBundles.push(
        createBundle("Settle Cash", event, [
          // TODO: need to convert settlement rate here...
          mintToken(acct, assetCash, snapshot.previousBalance, event),
        ])
      );
    } else if (fCash.isfCashDebt && snapshot.currentBalance.lt(snapshot.previousBalance)) {
      let repayAmount = snapshot.previousBalance.minus(snapshot.currentBalance);
      let posfCash = getPositivefCash(fCashIdInt, event);

      transferBundles.push(
        createBundle("Repay fCash", event, [
          burnToken(acct, posfCash, repayAmount, event),
          burnToken(acct, fCash, repayAmount, event),
        ])
      );
    } else if (fCash.isfCashDebt && snapshot.currentBalance.gt(snapshot.previousBalance)) {
      let borrowAmount = snapshot.currentBalance.minus(snapshot.previousBalance);
      let posfCash = getPositivefCash(fCashIdInt, event);

      transferBundles.push(
        createBundle("Borrow fCash", event, [
          burnToken(acct, posfCash, borrowAmount, event),
          burnToken(acct, fCash, borrowAmount, event),
        ])
      );
    }
  }

  let newfCashIds = new Array<string>();
  for (let i = 0; i < portfolio.length; i++) {
    if (portfolio[i].currencyId.equals(BigInt.zero())) continue;
    let fCashId = encodeFCashID(portfolio[i].currencyId, portfolio[i].maturity);

    if (portfolio[i].notional.lt(BigInt.zero())) {
      fCashId = convertToNegativeFCashId(fCashId);
    }

    let idString = fCashId.toHexString();
    newfCashIds.push(idString);

    // Don't re-update existing fCash ids
    if (!prevfCashIds.includes(idString)) {
      let fCash = getOrCreateERC1155Asset(fCashId, event.block, event.transaction.hash);
      let balance = getBalance(account, fCash, event);
      updateAccount(fCash, account, balance, event);

      if (portfolio[i].notional.lt(BigInt.zero())) {
        let borrowAmount = portfolio[i].notional.neg();
        let posfCash = getPositivefCash(fCashId, event);

        transferBundles.push(
          createBundle("Borrow fCash", event, [
            burnToken(acct, posfCash, borrowAmount, event),
            burnToken(acct, fCash, borrowAmount, event),
          ])
        );
      }
    }
  }

  context.setString(acct.toHexString(), newfCashIds.join(":"));
  return transferBundles;
}

function getPositivefCash(fCashId: BigInt, event: ethereum.Event): Token {
  let fCashIdInt = convertToPositiveFCashId(fCashId);
  return getOrCreateERC1155Asset(fCashIdInt, event.block, event.transaction.hash);
}

class TopicConfig {
  topicHash: string;
  indexedNames: string[];
  indexedTypes: string[];
  dataResolver: (data: Bytes) => ethereum.EventParam[];
  createBundle: (event: ethereum.Event, account: Address) => TransferBundle[] | null;
  name: string;

  constructor(
    name: string,
    topicHash: string,
    indexedNames: string[],
    indexedTypes: string[],
    dataResolver: (data: Bytes) => ethereum.EventParam[],
    createBundle: (event: ethereum.Event, account: Address) => TransferBundle[] | null
  ) {
    this.name = name;
    this.topicHash = topicHash;
    this.indexedNames = indexedNames;
    this.indexedTypes = indexedTypes;
    this.dataResolver = dataResolver;
    this.createBundle = createBundle;
  }

  parseLog(_log: ethereum.Log, event: ethereum.Event): ethereum.Event {
    let parameters = new Array<ethereum.EventParam>();

    for (let i = 0; i < this.indexedNames.length; i++) {
      if (_log.topics.length < i + 1) continue;

      let topic = _log.topics[i + 1];
      if (this.indexedTypes[i] == "address") {
        let address = ethereum.decode("address", topic)!;
        parameters.push(new ethereum.EventParam(this.indexedNames[i], address));
      } else if (this.indexedTypes[i] == "uint16") {
        let num = ethereum.decode("uint16", topic)!;
        parameters.push(new ethereum.EventParam(this.indexedNames[i], num));
      } else if (this.indexedTypes[i] == "uint40") {
        let num = ethereum.decode("uint40", topic)!;
        parameters.push(new ethereum.EventParam(this.indexedNames[i], num));
      }
    }

    // Decode the remaining data params
    let dataParams = this.dataResolver(_log.data);
    parameters = parameters.concat(dataParams);

    return new ethereum.Event(
      _log.address,
      _log.logIndex,
      _log.transactionLogIndex,
      _log.logType,
      event.block,
      event.transaction,
      parameters,
      null
    );
  }
}

function createBundle(
  bundleName: string,
  event: ethereum.Event,
  transfers: Transfer[]
): TransferBundle {
  let bundle = createTransferBundle(
    event.transaction.hash.toHexString(),
    bundleName,
    event.transactionLogIndex.toI32(),
    event.transactionLogIndex.toI32()
  );
  bundle.blockNumber = event.block.number;
  bundle.timestamp = event.block.timestamp.toI32();
  bundle.transactionHash = event.transaction.hash.toHexString();
  bundle.bundleName = bundleName;
  bundle.startLogIndex = event.transactionLogIndex.toI32();
  bundle.endLogIndex = event.transactionLogIndex.toI32();

  let transferArray = new Array<string>();
  for (let i = 0; i < transfers.length; i++) {
    transferArray.push(transfers[i].id);
    transfers[i].save();
  }

  bundle.transfers = transferArray;
  bundle.save();
  return bundle;
}

function makeTransfer(
  from: Address,
  to: Address,
  token: Token,
  value: BigInt,
  event: ethereum.Event
): Transfer {
  let transfer = createTransfer(event, 0);
  transfer.from = from.toHexString();
  transfer.to = to.toHexString();
  transfer.token = token.id;
  transfer.tokenType = token.tokenType;
  transfer.value = value;

  transfer.valueInUnderlying = convertValueToUnderlying(value, token, event.block.timestamp);
  transfer.fromSystemAccount = decodeSystemAccount(from, event);
  transfer.toSystemAccount = decodeSystemAccount(to, event);
  transfer.transactionHash = event.transaction.hash.toHexString();
  transfer.transferType = decodeTransferType(from, to);
  transfer.underlying = getUnderlying(token.currencyId).id;

  return transfer;
}

function burnToken(from: Address, token: Token, value: BigInt, event: ethereum.Event): Transfer {
  return makeTransfer(from, ZERO_ADDRESS, token, value, event);
}

function mintToken(to: Address, token: Token, value: BigInt, event: ethereum.Event): Transfer {
  return makeTransfer(to, ZERO_ADDRESS, token, value, event);
}

function getAssetCash(currencyId: i32): Token {
  let tokenAddress = getAssetToken(currencyId);
  return getAsset(tokenAddress.toHexString());
}

function getNToken(currencyId: i32): Token {
  let notional = getNotionalV2();
  let ntoken = notional.nTokenAddress(currencyId);
  return getAsset(ntoken.toHexString());
}

let EventsConfig = [
  new TopicConfig(
    "MintCToken",
    "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f",
    [],
    [],
    (data: Bytes): ethereum.EventParam[] => {
      let values = ethereum.decode("(address,uint256,uint256)", data)!.toTuple();
      return [
        new ethereum.EventParam("minter", values[0]),
        new ethereum.EventParam("mintAmount", values[1]),
        new ethereum.EventParam("mintTokens", values[2]),
      ];
    },
    (event: ethereum.Event, account: Address): TransferBundle[] | null => {
      // This returns underlying to asset cash deposits
      let minter = event.parameters[0].value.toAddress();
      let notional = getNotionalV2();
      if (minter !== notional._address) return null;
      let assetCash = getAsset(event.address.toHexString());
      let mintAmount = event.parameters[2].value.toBigInt();

      return [createBundle("Deposit", event, [mintToken(account, assetCash, mintAmount, event)])];
    }
  ),
  new TopicConfig(
    "RedeemCToken",
    "0xe5b754fb1abb7f01b499791d0b820ae3b6af3424ac1c59768edb53f4ec31a929",
    [],
    [],
    (data: Bytes): ethereum.EventParam[] => {
      let values = ethereum.decode("(address,uint256,uint256)", data)!.toTuple();
      return [
        new ethereum.EventParam("redeemer", values[0]),
        new ethereum.EventParam("redeemAmount", values[1]),
        new ethereum.EventParam("redeemTokens", values[2]),
      ];
    },
    (event: ethereum.Event, account: Address): TransferBundle[] | null => {
      // This returns asset cash to underlying withdraws
      let redeemer = event.parameters[0].value.toAddress();
      let notional = getNotionalV2();
      if (redeemer !== notional._address) return null;
      let assetCash = getAsset(event.address.toHexString());
      let redeemAmount = event.parameters[2].value.toBigInt();

      return [
        createBundle("Withdraw", event, [burnToken(account, assetCash, redeemAmount, event)]),
      ];
    }
  ),
  new TopicConfig(
    "Transfer",
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    ["from", "to"],
    ["address", "address"],
    (data: Bytes): ethereum.EventParam[] => {
      let value = ethereum.decode("uint256", data);
      return [new ethereum.EventParam("value", value!)];
    },
    (event: ethereum.Event): TransferBundle[] | null => {
      // This returns asset cash direct transfers
      let t = changetype<TransferEvent>(event);
      let notional = getNotionalV2();
      let currency = notional.try_getCurrencyId(t.address);
      if (currency.reverted) return null;
      let assetCash = getAssetCash(currency.value);
      if (t.params.from === notional._address) {
        return [
          createBundle("Withdraw", event, [
            burnToken(t.params.to, assetCash, t.params.value, event),
          ]),
        ];
      } else if (t.params.to === notional._address) {
        return [
          createBundle("Deposit", event, [
            mintToken(t.params.from, assetCash, t.params.value, event),
          ]),
        ];
      }

      return null;
    }
  ),
  new TopicConfig(
    "LendBorrowTrade",
    "0xc53d733b6fdfac3f892b49bf468cd1cae7773ab553e440dc689ed6b09bb646b1",
    ["account", "currencyId"],
    ["address", "uint16"],
    (data: Bytes): ethereum.EventParam[] => {
      let values = ethereum.decode("(uint40,int256,int256)", data)!.toTuple();
      return [
        new ethereum.EventParam("maturity", values[0]),
        new ethereum.EventParam("netAssetCash", values[1]),
        new ethereum.EventParam("netfCash", values[2]),
      ];
    },
    (event: ethereum.Event): TransferBundle[] | null => {
      let l = changetype<LendBorrowTrade>(event);
      let assetCash = getAssetCash(l.params.currencyId);
      let nToken = getNToken(l.params.currencyId);

      let fCash = getOrCreateERC1155Asset(
        encodeFCashID(BigInt.fromI32(l.params.currencyId), l.params.maturity),
        event.block,
        event.transaction.hash
      );
      if (l.params.netfCash.gt(BigInt.zero())) {
        return [
          createBundle("Buy fCash", event, [
            makeTransfer(
              changetype<Address>(nToken.tokenAddress),
              l.params.account,
              fCash,
              l.params.netfCash,
              event
            ),
            makeTransfer(
              l.params.account,
              changetype<Address>(FEE_RESERVE),
              assetCash,
              BigInt.zero(),
              event
            ),
            makeTransfer(
              l.params.account,
              changetype<Address>(nToken.tokenAddress),
              assetCash,
              l.params.netAssetCash.neg(),
              event
            ),
          ]),
        ];
      } else {
        return [
          createBundle("Sell fCash", event, [
            makeTransfer(
              l.params.account,
              changetype<Address>(nToken.tokenAddress),
              fCash,
              l.params.netfCash.neg(),
              event
            ),
            makeTransfer(
              l.params.account,
              changetype<Address>(FEE_RESERVE),
              assetCash,
              BigInt.zero(),
              event
            ),
            makeTransfer(
              changetype<Address>(nToken.tokenAddress),
              l.params.account,
              assetCash,
              l.params.netAssetCash,
              event
            ),
          ]),
        ];
      }
    }
  ),
  // new TopicConfig(
  //   "AccountSettled",
  //   "0xe8fafb2a45bb3c597b46894e13460ced12d06a721cf3b1f3a70f6d9465cf9d28",
  //   ["account"],
  //   ["address"],
  //   (_data: Bytes): ethereum.EventParam[] => {
  //     return [];
  //   }
  //   (event: ethereum.Event): TransferBundle[] | null => {
  //   }
  //   // Look at balances before and after and find matured fCash
  //   // Bundle => Settle fCash [ Burn Transfer Single fCash fCashNotional.abs()]
  //   // Bundle => Settle Cash [ Transfer Asset Cash SettlementReserve to account CashAmount]
  // ),
  new TopicConfig(
    "SettledCashDebt",
    "0xc76e4e38ccd25a7b0a39cdaa81a20efa0c2127e74c448b7b05aef1c427d5732b",
    ["account", "currencyId", "settler"],
    ["address", "uint16", "address"],
    (data: Bytes): ethereum.EventParam[] => {
      let values = ethereum.decode("(int256,int256)", data)!.toTuple();
      return [
        new ethereum.EventParam("amountToSettleAsset", values[0]),
        new ethereum.EventParam("fCashAmount", values[1]),
      ];
    },
    (event: ethereum.Event, account: Address): TransferBundle[] | null => {
      let t = changetype<SettledCashDebt>(event);
      if (t.params.settler !== account) return null;

      let fCash = getOrCreateERC1155Asset(
        encodeFCashID(
          BigInt.fromI32(t.params.currencyId),
          BigInt.fromI32(getTimeRef(event.block.timestamp.toI32()) + QUARTER)
        ),
        event.block,
        event.transaction.hash
      );
      let assetCash = getAssetCash(t.params.currencyId);
      // TODO: Borrow fCash on settled but requires detection....
      // TODO: the PnL line item will not properly create this PnL here...
      return [
        createBundle("Transfer Asset", event, [
          makeTransfer(
            t.params.settledAccount,
            t.params.settler,
            fCash,
            t.params.fCashAmount,
            event
          ),
        ]),
        createBundle("Transfer Asset", event, [
          makeTransfer(
            t.params.settler,
            t.params.settledAccount,
            assetCash,
            t.params.amountToSettleAsset,
            event
          ),
        ]),
      ];
    }
  ),
  new TopicConfig(
    "nTokenSupplyChange",
    "0x412bc13d202a2ea5119e55fec9c5e420dddb18faf186373ad9795ad4f4545aa9",
    ["account", "currencyId"],
    ["address", "uint16"],
    (data: Bytes): ethereum.EventParam[] => {
      let values = ethereum.decode("int256", data)!;
      return [new ethereum.EventParam("tokenSupplyChange", values)];
    },
    (event: ethereum.Event): TransferBundle[] | null => {
      let t = changetype<nTokenSupplyChange>(event);
      let nToken = getNToken(t.params.currencyId);
      let assetCash = getAssetCash(t.params.currencyId);

      let nTokenPV = convertValueToUnderlying(
        t.params.tokenSupplyChange.abs(),
        nToken,
        event.block.timestamp
      );
      if (t.params.tokenSupplyChange.gt(BigInt.zero()) && nTokenPV !== null) {
        return [
          createBundle("Mint nToken", event, [
            makeTransfer(
              t.params.account,
              changetype<Address>(nToken.tokenAddress),
              assetCash,
              nTokenPV,
              event
            ),
            mintToken(t.params.account, nToken, t.params.tokenSupplyChange, event),
          ]),
        ];
      } else if (nTokenPV !== null) {
        return [
          createBundle("Redeem nToken", event, [
            makeTransfer(
              changetype<Address>(nToken.tokenAddress),
              t.params.account,
              assetCash,
              nTokenPV,
              event
            ),
            burnToken(t.params.account, nToken, t.params.tokenSupplyChange.neg(), event),
          ]),
        ];
      }

      return null;
    }
  ),
  new TopicConfig(
    "nTokenResidualPurchase",
    "0xe85dd6c9c85c29a2f4d4cb74e31514bfc478c8c5a50da255ea565123d8793352",
    ["currencyId", "maturity", "purchaser"],
    ["uint16", "uint40", "address"],
    (data: Bytes): ethereum.EventParam[] => {
      let values = ethereum.decode("(int256,int256)", data)!.toTuple();
      return [
        new ethereum.EventParam("fCashAmountToPurchase", values[0]),
        new ethereum.EventParam("netAssetCashNToken", values[1]),
      ];
    },
    (event: ethereum.Event): TransferBundle[] | null => {
      let t = changetype<nTokenResidualPurchase>(event);
      let fCash = getOrCreateERC1155Asset(
        encodeFCashID(BigInt.fromI32(t.params.currencyId), t.params.maturity),
        event.block,
        event.transaction.hash
      );
      let assetCash = getAssetCash(t.params.currencyId);
      let nToken = getNToken(t.params.currencyId);
      // Bundle => Transfer Asset [ Transfer fCash from nToken to account ]
      // Bundle => Transfer Asset Cash [ Transfer Asset Cash from account to nToken ]
      if (t.params.fCashAmountToPurchase.gt(BigInt.zero())) {
        return [
          createBundle("Transfer Asset", event, [
            makeTransfer(
              changetype<Address>(nToken.tokenAddress),
              t.params.purchaser,
              fCash,
              t.params.fCashAmountToPurchase,
              event
            ),
          ]),
          createBundle("Transfer Asset", event, [
            makeTransfer(
              t.params.purchaser,
              changetype<Address>(nToken.tokenAddress),
              assetCash,
              t.params.netAssetCashNToken.neg(),
              event
            ),
          ]),
        ];
      } else {
        return [
          createBundle("Transfer Asset", event, [
            makeTransfer(
              t.params.purchaser,
              changetype<Address>(nToken.tokenAddress),
              fCash,
              t.params.fCashAmountToPurchase.neg(),
              event
            ),
          ]),
          createBundle("Transfer Asset", event, [
            makeTransfer(
              nToken.tokenAddress as Address,
              t.params.purchaser,
              assetCash,
              t.params.netAssetCashNToken,
              event
            ),
          ]),
        ];
      }
    }
  ),
  new TopicConfig(
    "LiquidateLocalCurrency",
    "0x4596c3b6545e97eb42b719442dd0afa8eb7680f3ff72c762763d4b292ee26ea7",
    ["liquidated", "liquidator"],
    ["address", "address"],
    (data: Bytes): ethereum.EventParam[] => {
      let values = ethereum.decode("(uint16,int256)", data)!.toTuple();
      return [
        new ethereum.EventParam("localCurrencyId", values[0]),
        new ethereum.EventParam("netLocalFromLiquidator", values[1]),
      ];
    },
    (event: ethereum.Event, account: Address): TransferBundle[] | null => {
      let t = changetype<LiquidateLocalCurrency>(event);
      if (t.params.liquidator !== account) return null;
      let assetCash = getAssetCash(t.params.localCurrencyId);
      let nToken = getNToken(t.params.localCurrencyId);

      return [
        createBundle("Transfer Asset", event, [
          makeTransfer(
            t.params.liquidator,
            t.params.liquidated,
            assetCash,
            t.params.netLocalFromLiquidator,
            event
          ),
        ]),
        createBundle("Transfer Asset", event, [
          makeTransfer(
            t.params.liquidated,
            t.params.liquidator,
            nToken,
            getNTokenTransferForLocalLiquidation(event.transaction.hash.toHexString()),
            event
          ),
        ]),
      ];
    }
  ),
  new TopicConfig(
    "LiquidateCollateralCurrency",
    "0x88fff2f00941b1272999212de454ee8d15f54d132723b35e3423ef742109861c",
    ["liquidated", "liquidator"],
    ["address", "address"],
    (data: Bytes): ethereum.EventParam[] => {
      let values = ethereum.decode("(uint16,uint16,int256,int256,int256)", data)!.toTuple();
      return [
        new ethereum.EventParam("localCurrencyId", values[0]),
        new ethereum.EventParam("collateralCurrencyId", values[1]),
        new ethereum.EventParam("netLocalFromLiquidator", values[2]),
        new ethereum.EventParam("netCollateralFromLiquidator", values[3]),
        new ethereum.EventParam("netNTokenTransfer", values[4]),
      ];
    },
    (event: ethereum.Event, account: Address): TransferBundle[] | null => {
      let t = changetype<LiquidateCollateralCurrency>(event);
      if (t.params.liquidator !== account) return null;
      let localCash = getAssetCash(t.params.localCurrencyId);
      let collateralCash = getAssetCash(t.params.collateralCurrencyId);
      let nToken = getNToken(t.params.collateralCurrencyId);

      return [
        createBundle("Transfer Asset", event, [
          makeTransfer(
            t.params.liquidator,
            t.params.liquidated,
            localCash,
            t.params.netLocalFromLiquidator,
            event
          ),
        ]),
        createBundle("Transfer Asset", event, [
          makeTransfer(
            t.params.liquidated,
            t.params.liquidator,
            collateralCash,
            t.params.netCollateralTransfer,
            event
          ),
        ]),
        createBundle("Transfer Asset", event, [
          makeTransfer(
            t.params.liquidated,
            t.params.liquidator,
            nToken,
            t.params.netNTokenTransfer,
            event
          ),
        ]),
      ];
    }
  ),
  new TopicConfig(
    "LiquidatefCashEvent",
    "0x1f20e4ccba6c78861ee4c638fecd0b6a53b1232adb96ca3a0065b9bb12d6214d",
    ["liquidated", "liquidator"],
    ["address", "address"],
    (data: Bytes): ethereum.EventParam[] => {
      let _values = ethereum.decode("(uint16,uint16,int256,uint256[],int256[])", data);
      if (_values === null) return [];
      let values = _values.toTuple();

      return [
        new ethereum.EventParam("localCurrencyId", values[0]),
        new ethereum.EventParam("fCashCurrencyId", values[1]),
        new ethereum.EventParam("netLocalFromLiquidator", values[2]),
        new ethereum.EventParam("fCashMaturities", values[3]),
        new ethereum.EventParam("fCashNotionalTransfer", values[4]),
      ];
    },
    (event: ethereum.Event, account: Address): TransferBundle[] | null => {
      let t = changetype<LiquidatefCashEvent>(event);
      if (t.params.liquidator !== account) return null;
      let localCash = getAssetCash(t.params.localCurrencyId);
      let transferBundles: TransferBundle[] = new Array<TransferBundle>();
      transferBundles.push(
        createBundle("Transfer Asset", event, [
          makeTransfer(
            t.params.liquidator,
            t.params.liquidated,
            localCash,
            t.params.netLocalFromLiquidator,
            event
          ),
        ])
      );

      for (let i = 0; i < t.params.fCashMaturities.length; i++) {
        let fCash = getOrCreateERC1155Asset(
          encodeFCashID(BigInt.fromI32(t.params.fCashCurrency), t.params.fCashMaturities[i]),
          event.block,
          event.transaction.hash
        );

        transferBundles.push(
          createBundle("Transfer Asset", event, [
            makeTransfer(
              t.params.liquidated,
              t.params.liquidator,
              fCash,
              t.params.fCashNotionalTransfer[i],
              event
            ),
          ])
        );
      }

      return transferBundles;
    }
  ),
];

function getNTokenTransferForLocalLiquidation(hash: string): BigInt {
  if (hash == "0x682028d3bf0463e19e9a8a2670b3547414ea5eb73daadfb6a7a90a16b3759e43") {
    return BigInt.fromString("1843739875817310");
  } else if (hash == "0xd2aba79767af02879303ef850321b77722c91d54c447167d3ade1da44796c10f") {
    return BigInt.fromString("50147413355384");
  } else if (hash == "0xa25fa3bf4f7390a2b17e16020a6246e02faaa0961b578a3ceb4cb206ff81a519") {
    return BigInt.fromString("30088448013231");
  } else if (hash == "0xf859180d79fcef5e510cc9568ee2cd0a10f41567bf72013dfe566314e16192e2") {
    return BigInt.fromString("30088448013231");
  } else if (hash == "0x8199d9f9dcdbbd42ca6393ee602011d4728a83c682d7bb46ef471a4ce34406fa") {
    return BigInt.fromString("30088448013231");
  } else {
    return BigInt.zero();
  }
}
