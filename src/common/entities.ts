import { Address, BigInt, Bytes, dataSource, ethereum, log } from "@graphprotocol/graph-ts";
import { NotionalV2 } from "../../generated/Assets/NotionalV2";
import { NotionalV3 } from "../../generated/Assets/NotionalV3";
import {
  Account,
  Token,
  CurrencyConfiguration,
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

export function isV2(): boolean {
  let context = dataSource.context();
  return context.getString("version") === "v2";
}

export function getNotionalV2(): NotionalV2 {
  if (dataSource.network() == "mainnet") {
    return NotionalV2.bind(Address.fromString("0x1344A36A1B56144C3Bc62E7757377D288fDE0369"));
  } else if (dataSource.network() == "arbitrum-one") {
    return NotionalV2.bind(Address.fromString("0x1344A36A1B56144C3Bc62E7757377D288fDE0369"));
  }

  log.critical("Unsupported network {}", [dataSource.network()]);
  // This return statement will never be reached
  return null as NotionalV2;
}

export function getNotional(): NotionalV3 {
  if (dataSource.network() == "mainnet") {
    return NotionalV3.bind(Address.fromString("0x1344A36A1B56144C3Bc62E7757377D288fDE0369"));
  } else if (dataSource.network() == "arbitrum-one") {
    return NotionalV3.bind(Address.fromString("0x1344A36A1B56144C3Bc62E7757377D288fDE0369"));
  }

  log.critical("Unsupported network {}", [dataSource.network()]);
  // This return statement will never be reached
  return null as NotionalV3;
}

export function getAsset(id: string): Token {
  let entity = Token.load(id);
  if (entity == null) {
    entity = new Token(id);
  }
  return entity as Token;
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

    entity.firstUpdateBlockNumber = event.block.number;
    entity.firstUpdateTimestamp = event.block.timestamp.toI32();
    entity.firstUpdateTransactionHash = event.transaction.hash;

    entity.lastUpdateBlockNumber = event.block.number;
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
    // Pad the start with zeros to ensure that the sort order is preserved
    event.transactionLogIndex.toString().padStart(6, "0") +
    ":" +
    index.toString();
  let transfer = new Transfer(id);
  transfer.blockNumber = event.block.number;
  transfer.timestamp = event.block.timestamp.toI32();
  transfer.transactionHash = event.transaction.hash.toHexString();
  transfer.logIndex = event.transactionLogIndex.toI32();

  return transfer;
}

export function getTransaction(event: ethereum.Event): Transaction {
  let transaction = Transaction.load(event.transaction.hash.toHexString());
  if (transaction == null) {
    transaction = new Transaction(event.transaction.hash.toHexString());
    transaction.blockNumber = event.block.number;
    transaction.timestamp = event.block.timestamp.toI32();
    transaction.transactionHash = event.transaction.hash;

    transaction._transferBundles = new Array<string>();
    transaction._transfers = new Array<string>();
    transaction._nextStartIndex = 0;
  }

  return transaction as Transaction;
}

export function createTransferBundle(
  txnHash: string,
  bundleName: string,
  startLogIndex: i32,
  endLogIndex: i32
): TransferBundle {
  let bundleId =
    txnHash +
    ":" +
    // Pad numbers to ensure sort order is preserved
    startLogIndex.toString().padStart(6, "0") +
    ":" +
    // Pad numbers to ensure sort order is preserved
    endLogIndex.toString().padStart(6, "0") +
    ":" +
    bundleName;
  return new TransferBundle(bundleId);
}

export function getOracleRegistry(): OracleRegistry {
  let registry = OracleRegistry.load(ORACLE_REGISTRY_ID);
  if (registry == null) {
    registry = new OracleRegistry(ORACLE_REGISTRY_ID);
    registry.chainlinkOracles = new Array<string>();
    registry.listedVaults = new Array<Bytes>();
    registry.fCashEnabled = new Array<string>();
    registry.lastRefreshBlockNumber = BigInt.fromI32(0);
    registry.lastRefreshTimestamp = 0;
    registry.save();
  }

  return registry as OracleRegistry;
}

export function getOracle(base: Token, quote: Token, oracleType: string): Oracle {
  let id = base.id + ":" + quote.id + ":" + oracleType;
  let oracle = Oracle.load(id);
  if (oracle == null) {
    oracle = new Oracle(id);
    oracle.base = base.id;
    oracle.quote = quote.id;
    oracle.oracleType = oracleType;
    oracle.mustInvert = false;
    oracle.matured = false;
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

  incentives.lastUpdateBlockNumber = event.block.number;
  incentives.lastUpdateTimestamp = event.block.timestamp.toI32();
  incentives.lastUpdateTransactionHash = event.transaction.hash;

  return incentives;
}

export function getUnderlying(currencyId: i32): Token {
  let c = CurrencyConfiguration.load(currencyId.toString());
  if (c) return getAsset(c.underlying as string);

  log.critical("Underlying not found for {}", [currencyId.toString()]);
  return null as Token;
}
