import { Address, ethereum, ByteArray, BigInt } from "@graphprotocol/graph-ts";
import { Token, TradingModulePermission } from "../generated/schema";
import {
  PriceOracleUpdated,
  TokenPermissionsUpdated,
} from "../generated/TradingModule/TradingModule";
import { Underlying, USD_ASSET_ID } from "./common/constants";
import { createERC20TokenAsset } from "./common/erc20";
import { registerChainlinkOracle } from "./exchange_rates";

function getUSDAsset(event: ethereum.Event): Token {
  let token = Token.load(USD_ASSET_ID);
  if (token == null) {
    token = new Token(USD_ASSET_ID);
    token.name = "US Dollar";
    token.symbol = "USD";
    token.decimals = 8;
    token.precision = BigInt.fromI32(10).pow(8);

    token.tokenInterface = "FIAT";
    token.tokenAddress = Address.fromHexString(USD_ASSET_ID);
    token.hasTransferFee = false;
    token.tokenType = "Fiat";
    token.isfCashDebt = false;

    token.lastUpdateBlockNumber = event.block.number;
    token.lastUpdateTimestamp = event.block.timestamp.toI32();
    token.lastUpdateTransactionHash = event.transaction.hash;

    token.firstUpdateBlockNumber = event.block.number;
    token.firstUpdateTimestamp = event.block.timestamp.toI32();
    token.firstUpdateTransactionHash = event.transaction.hash;

    token.save();
  }

  return token as Token;
}

export function handlePriceOracleUpdate(event: PriceOracleUpdated): void {
  let usdBaseAsset = getUSDAsset(event);
  let quoteAsset = createERC20TokenAsset(event.params.token, false, event, Underlying);
  registerChainlinkOracle(usdBaseAsset, quoteAsset, event.params.oracle, false, event);
}

function getTradingModulePermissions(
  sender: Address,
  token: Address,
  event: ethereum.Event
): TradingModulePermission {
  let id = sender.toHexString() + ":" + token.toHexString();
  let permissions = TradingModulePermission.load(id);
  if (permissions == null) {
    permissions = new TradingModulePermission(id);
    permissions.sender = sender.toHexString();
    permissions.token = token.toHexString();
    permissions.allowedDexes = new Array<string>();
    permissions.allowedTradeTypes = new Array<string>();
  }

  permissions.lastUpdateBlockNumber = event.block.number;
  permissions.lastUpdateTimestamp = event.block.timestamp.toI32();
  permissions.lastUpdateTransactionHash = event.transaction.hash;

  return permissions;
}

export function handleTokenPermissionsUpdate(event: TokenPermissionsUpdated): void {
  let permissions = getTradingModulePermissions(event.params.sender, event.params.token, event);
  permissions.allowSell = event.params.permissions.allowSell;
  let dexFlagsString =
    "0x" +
    event.params.permissions.dexFlags
      .toHexString()
      .slice(2)
      .padStart(12, "0");
  let dexFlags = ByteArray.fromHexString(dexFlagsString);
  let dexes = new Array<string>();
  if (dexFlags[0]) dexes.push("UNISWAP_V2");
  if (dexFlags[1]) dexes.push("UNISWAP_V3");
  if (dexFlags[2]) dexes.push("ZERO_EX");
  if (dexFlags[3]) dexes.push("BALANCER_V2");
  if (dexFlags[4]) dexes.push("CURVE");
  if (dexFlags[5]) dexes.push("NOTIONAL_VAULT");
  permissions.allowedDexes = dexes;

  let tradeTypeFlagsString =
    "0x" +
    event.params.permissions.tradeTypeFlags
      .toHexString()
      .slice(2)
      .padStart(8, "0");
  let tradeTypeFlags = ByteArray.fromHexString(tradeTypeFlagsString);
  let tradeType = new Array<string>();
  if (tradeTypeFlags[0]) tradeType.push("EXACT_IN_SINGLE");
  if (tradeTypeFlags[1]) tradeType.push("EXACT_OUT_SINGLE");
  if (tradeTypeFlags[2]) tradeType.push("EXACT_IN_BATCH");
  if (tradeTypeFlags[3]) tradeType.push("EXACT_OUT_BATCH");
  permissions.allowedTradeTypes = tradeType;

  permissions.save();
}
