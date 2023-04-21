import { Address, Bytes, dataSource, ethereum, log } from "@graphprotocol/graph-ts";
import { Notional } from "../../generated/Assets/Notional";
import {
  Account,
  Asset,
  Incentive,
  Oracle,
  OracleRegistry,
  Transaction,
  Transfer,
  TransferBundle,
} from "../../generated/schema";
import {
  FeeReserve,
  FEE_RESERVE,
  None,
  ORACLE_REGISTRY_ID,
  SettlementReserve,
  SETTLEMENT_RESERVE,
  ZeroAddress,
  ZERO_ADDRESS,
} from "./constants";

export function getNotional(): Notional {
  if (dataSource.network() == "mainnet") {
    return Notional.bind(Address.fromString("0x1344A36A1B56144C3Bc62E7757377D288fDE0369"));
  }

  log.critical("Unsupported network {}", [dataSource.network()]);
  // This return statement will never be reached
  return null as Notional;
}

export function getAsset(id: string): Asset {
  let entity = Asset.load(id);
  if (entity == null) {
    entity = new Asset(id);
  }
  return entity as Asset;
}

export function getAccount(id: string, event: ethereum.Event): Account {
  let entity = Account.load(id);
  if (entity == null) {
    entity = new Account(id);

    if (id == FEE_RESERVE.toHexString()) {
      entity.systemAccountType = FeeReserve;
    } else if (id == SETTLEMENT_RESERVE.toHexString()) {
      entity.systemAccountType = SettlementReserve;
    } else if (id == ZERO_ADDRESS.toHexString()) {
      entity.systemAccountType = ZeroAddress;
    } else {
      // NOTE: ERC20 proxies will update their system account type after
      // calling getAccount. Otherwise this creates a new default account
      entity.systemAccountType = None;
    }

    entity.firstUpdateBlockNumber = event.block.number.toI32();
    entity.firstUpdateTimestamp = event.block.timestamp.toI32();
    entity.firstUpdateTransactionHash = event.transaction.hash;

    entity.lastUpdateBlockNumber = event.block.number.toI32();
    entity.lastUpdateTimestamp = event.block.timestamp.toI32();
    entity.lastUpdateTransactionHash = event.transaction.hash;

    entity.save();
  }

  return entity as Account;
}

export function createTransfer(event: ethereum.Event, index: i32): Transfer {
  let id =
    event.transaction.hash.toHexString() +
    ":" +
    event.transactionLogIndex.toString() +
    ":" +
    index.toString();
  let transfer = new Transfer(id);
  transfer.blockNumber = event.block.number.toI32();
  transfer.timestamp = event.block.timestamp.toI32();
  transfer.transactionHash = event.transaction.hash.toString();
  transfer.logIndex = event.transactionLogIndex.toI32();

  return transfer;
}

export function getTransaction(event: ethereum.Event): Transaction {
  let transaction = new Transaction(event.transaction.hash.toHexString());
  transaction.blockNumber = event.block.number.toI32();
  transaction.timestamp = event.block.timestamp.toI32();
  transaction.transactionHash = event.transaction.hash;

  transaction._transferBundles = new Array<string>();
  transaction._transfers = new Array<string>();
  transaction._lastBundledTransfer = 0;

  return transaction;
}

export function createTransferBundle(
  txnHash: string,
  bundleName: string,
  startLogIndex: i32,
  endLogIndex: i32
): TransferBundle {
  let bundleId =
    txnHash + ":" + startLogIndex.toString() + ":" + endLogIndex.toString() + ":" + bundleName;
  return new TransferBundle(bundleId);
}

export function getOracleRegistry(): OracleRegistry {
  let registry = OracleRegistry.load(ORACLE_REGISTRY_ID);
  if (registry == null) {
    registry = new OracleRegistry(ORACLE_REGISTRY_ID);
    registry.chainlinkOracles = new Array<string>();
    registry.listedVaults = new Array<Bytes>();
    registry.fCashEnabled = new Array<string>();
    registry.lastRefreshBlockNumber = 0;
    registry.lastRefreshTimestamp = 0;
    registry.save();
  }

  return registry as OracleRegistry;
}

export function getOracle(base: Asset, quote: Asset, oracleType: string): Oracle {
  let id = base.id + ":" + quote.id + ":" + oracleType;
  let oracle = Oracle.load(id);
  if (oracle == null) {
    oracle = new Oracle(id);
    oracle.base = base.id;
    oracle.quote = quote.id;
    oracle.oracleType = oracleType;
  }

  return oracle as Oracle;
}

export function getIncentives(currencyId: i32, event: ethereum.Event): Incentive {
  let id = currencyId.toString();
  let incentives = Incentive.load(id);
  if (incentives == null) {
    incentives = new Incentive(id);
    incentives.currencyConfiguration = id;
  }

  incentives.lastUpdateBlockNumber = event.block.number.toI32();
  incentives.lastUpdateTimestamp = event.block.timestamp.toI32();
  incentives.lastUpdateTransactionHash = event.transaction.hash;

  return incentives;
}

export function getCurrencyId(asset: Asset): i32 {
  if (!isDefined(asset.underlying)) log.critical("Unknown underlying for asset {}", [asset.id]);
  return I32.parseInt(asset.underlying as string);
}
