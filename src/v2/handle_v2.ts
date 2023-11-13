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
  FCASH_ASSET_TYPE_ID,
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
  getAsset,
  getIncentives,
  getNotionalV2,
  getOracle,
  getUnderlying,
  isV2,
} from "../common/entities";
import {
  convertToNegativeFCashId,
  encodeFCashID,
  getOrCreateERC1155Asset,
} from "../common/erc1155";
import {
  AccountSettled,
  CashBalanceChange,
  IncentivesMigrated,
  LendBorrowTrade,
  LiquidateCollateralCurrency,
  LiquidateLocalCurrency,
  LiquidatefCashEvent,
  NotionalV2,
  ReserveBalanceUpdated,
  ReserveFeeAccrued,
  SetSettlementRate,
  SettledCashDebt,
  nTokenResidualPurchase,
  nTokenSupplyChange,
} from "../../generated/Assets/NotionalV2";
import { AccountContextUpdate } from "../../generated/Configuration/NotionalV3";
import { Transfer as TransferEvent } from "../../generated/Assets/ERC20";
import { Token, Transfer, TransferBundle, VersionContext } from "../../generated/schema";
import { logTransfer } from "../transactions";

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

export function handleReserveBalanceUpdated(event: ReserveBalanceUpdated): void {
  // // burn asset cash from reserve
  // let transfer = createTransfer(event, 0);
  // // TODO: does this get bundled as anything?
  // logTransfer(
  //   FEE_RESERVE,
  //   ZERO_ADDRESS,
  //   BigInt.zero(), // diff in reserve balance,
  //   event,
  //   transfer,
  //   assetCash
  // );
}

export function handleV2AccountContextUpdate(event: AccountContextUpdate): void {
  if (!isV2()) return;
  if (event.receipt == null) log.critical("Transaction Receipt not Found", []);
  let notional = getNotionalV2();
  let receipt = event.receipt as ethereum.TransactionReceipt;
  let eventType: string[] = new Array<string>();
  let events: ethereum.Event[] = new Array<ethereum.Event>();

  // TODO: Update all balances before and after and also detect
  // settlements and borrow / repays for fCash

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
      log.debug("Parsed {}", [e.name]);
    }
  }

  // NOTE: we should only create bundles for the "primary" actor in the
  // action. So exclude these updates for liquidated or settled accounts
  // to avoid duplications.
  // Also in the case for liquidations there are multiple account context
  // updates and we should avoid that as well.
  let transfers: Transfer[] = new Array<Transfer>();
  let transferBundles: TransferBundle[] = new Array<TransferBundle>();
  let bundleArray: string[] = new Array<string>();

  // Convert the events list into a set of bundles and transfers
  // inside those bundles

  // TODO: these need to look at before and after events
  // Borrow / Repay fCash => look at portfolio before and after
  // Settlement => look at portfolio before and after

  // Finally sort this into some expected ordering...
}

class TopicConfig {
  topicHash: string;
  indexedNames: string[];
  indexedTypes: string[];
  dataResolver: (data: Bytes) => ethereum.EventParam[];
  name: string;

  constructor(
    name: string,
    topicHash: string,
    indexedNames: string[],
    indexedTypes: string[],
    dataResolver: (data: Bytes) => ethereum.EventParam[]
  ) {
    this.name = name;
    this.topicHash = topicHash;
    this.indexedNames = indexedNames;
    this.indexedTypes = indexedTypes;
    this.dataResolver = dataResolver;
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
    parameters.concat(dataParams);

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

let EventsConfig = [
  new TopicConfig(
    "Transfer",
    "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    ["from", "to"],
    ["address", "address"],
    (data: Bytes): ethereum.EventParam[] => {
      let value = ethereum.decode("uint256", data);
      return [new ethereum.EventParam("value", value!)];
    }
    /**
     * Filter for transfers to / from Notional
     * If underlying, convert to asset cash denomination
     * If asset cash, it's just 1-1
     * NOTE: this won't work for ETH transfers, maybe i should look for transfers
     * from notional to cTokens? But then I don't see the address, but that is the
     * AccountUpdateContext except in special situations...
     * There's also cToken Mint and Redeem where the address is Notional...
     *
     * If transfer to Notional
     * Bundle =>
     *    Deposit [ Mint Asset Cash (tokens) ]
     *
     * If transfer from Notional
     * Bundle =>
     *    Withdraw [ Burn Asset Cash (tokens) ]
     */
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
    }
    /**
     *
     * if netfCash > 0
     * Bundle =>
     *   Buy fCash [
     *     TransferSingle fCash nToken to Account netfCash
     *     Transfer Asset Cash account to feeReserve ?
     *     Transfer Asset Cash account to nToken netAssetCash.neg()
     *   ]
     * if netfCash < 0
     * Bundle =>
     *   Sell fCash [
     *     TransferSingle fCash account to nToken netfCash
     *     ReserveFeeAccrued /// it is between these....
     *     Transfer Asset Cash account to feeReserve ?
     *     Transfer Asset Cash nToken to account netAssetCash
     *   ]
     */
  ),
  new TopicConfig(
    "AccountSettled",
    "0xe8fafb2a45bb3c597b46894e13460ced12d06a721cf3b1f3a70f6d9465cf9d28",
    ["account"],
    ["address"],
    (_data: Bytes): ethereum.EventParam[] => {
      return [];
    }
    // Look at balances before and after and find matured fCash
    // Bundle => Settle fCash [ Burn Transfer Single fCash fCashNotional.abs()]
    // Bundle => Settle Cash [ Transfer Asset Cash SettlementReserve to account CashAmount]
  ),
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
      // TODO: Borrow fCash on settled but requires detection....
      // TODO: the PnL line item will not properly create this PnL here...
      // Bundle => Transfer Asset [ Transfer fCash settled to settler ]
      // Bundle => Transfer Asset [ Transfer Asset Cash settler to settled ]
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
    }
    // if tokenSupplyChange > 0
    // Bundle => Mint nToken [
    //   Transfer Asset Cash from account to nToken at current PV
    //   Mint nToken to account
    // ]
    // if tokenSupplyChange < 0
    // Bundle => Mint nToken [
    //   Transfer Asset Cash from nToken to account at current PV
    //   Burn nToken from account
    // ]
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
    }
    // Bundle => Transfer Asset [ Transfer fCash from nToken to account ]
    // Bundle => Transfer Asset Cash [ Transfer Asset Cash from account to nToken ]
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
    }
    // Bundle => Transfer Asset [ Transfer Asset Cash from liquidator to liquidated ]
    // TODO: not clear how much is transferred here...
    // Bundle => Transfer nToken [ Transfer nToken from liquidated to liquidator ]
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
      // Bundle => Transfer Asset [ Transfer Asset Cash from liquidator to liquidated ]
      // Bundle => Transfer Asset [ Transfer Asset Cash from liquidated to liquidator ]
      // Bundle => Transfer Asset [ Transfer nToken from liquidated to liquidator ]
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
      // Bundle => Transfer Asset [ Transfer Asset Cash from liquidator to liquidated ]
      // Bundle => Transfer Asset [ Transfer Asset Cash from liquidated to liquidator ]
      // Bundle => Transfer Asset [ Transfer nToken from liquidated to liquidator ]
    }
  ),
];

// let Topics = [
//   "Transfer",
//   "LendBorrowTrade",
//   "AccountSettled",
//   "SettledCashDebt",
//   "nTokenSupplyChange",
//   "nTokenResidualPurchase",
//   "LiquidateLocalCurrency",
//   "LiquidateCollateralCurrency",
//   "LiquidatefCashEvent",
// ];

// let TopicsFull = [
//   // (indexed from, indexed to, value)
//   "Transfer(address,address,uint256)",
//   // (indexed account, indexed currencyId, maturity, netAssetCash, netfCash)
//   "LendBorrowTrade(address,uint16,uint40,int256,int256)",
//   // (indexed account)
//   "AccountSettled(address)",
//   // (indexed account, indexed currencyId, indexed settler, amountToSettleAsset, fCashAmount)
//   "SettledCashDebt(address,uint16,address,int256,int256)",
//   // (indexed account, indexed currencyId, tokenSupplyChange)
//   "nTokenSupplyChange(address,uint16,int256)",
//   // (indexed currencyId, indexed maturity, indexed purchaser, fCashAmountToPurchase, netAssetCashNToken)
//   "nTokenResidualPurchase(uint16,uint40,address,int256,int256)",
//   // (indexed liquidated, indexed liquidator, localCurrencyId, netLocalFromLiquidator)
//   "LiquidateLocalCurrency(address,address,uint16,int256)",
//   // (indexed liquidated, indexed liquidator, localCurrencyId, collateralCurrency, netLocalFromLiquidator, netCollateralTransfer, netNTokenTransfer)
//   "LiquidateCollateralCurrency(address,address,uint16,uint16,int256,int256,int256)",
//   // (indexed liquidated, indexed liquidator, localCurrencyId, fCashCurrency, netLocalFromLiquidator, fCashMaturities, fCashNotionalTransfer)
//   "LiquidatefCashEvent(address,address,uint16,uint16,int256,uint256[],int256[])",
// ];

// // Check these here: https://openchain.xyz/signatures
// let TopicsHashed = [
//   "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
//   "0xc53d733b6fdfac3f892b49bf468cd1cae7773ab553e440dc689ed6b09bb646b1",
//   "0xe8fafb2a45bb3c597b46894e13460ced12d06a721cf3b1f3a70f6d9465cf9d28",
//   "0xc76e4e38ccd25a7b0a39cdaa81a20efa0c2127e74c448b7b05aef1c427d5732b",
//   "0x412bc13d202a2ea5119e55fec9c5e420dddb18faf186373ad9795ad4f4545aa9",
//   "0xe85dd6c9c85c29a2f4d4cb74e31514bfc478c8c5a50da255ea565123d8793352",
//   "0x4596c3b6545e97eb42b719442dd0afa8eb7680f3ff72c762763d4b292ee26ea7",
//   "0x88fff2f00941b1272999212de454ee8d15f54d132723b35e3423ef742109861c",
//   "0x1f20e4ccba6c78861ee4c638fecd0b6a53b1232adb96ca3a0065b9bb12d6214d",
// ];

// 000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000120af200000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000e0000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000632f9a0000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000003e603f1
