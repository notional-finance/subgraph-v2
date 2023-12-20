import { Address, ethereum, ByteArray, BigInt } from "@graphprotocol/graph-ts";
import { Token, TradingModulePermission } from "../generated/schema";
import {
  PriceOracleUpdated,
  TokenPermissionsUpdated,
} from "../generated/TradingModule/TradingModule";
import { Underlying, USD_ASSET_ID } from "./common/constants";
import { createERC20TokenAsset, getTokenNameAndSymbol } from "./common/erc20";
import { registerChainlinkOracle } from "./exchange_rates";
import { getAsset } from "./common/entities";
import { ERC20 } from "../generated/templates/ERC20Proxy/ERC20";

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
    permissions.tokenAddress = token;
    permissions.allowedDexes = new Array<string>();
    permissions.allowedTradeTypes = new Array<string>();
    let [name, symbol] = getTokenNameAndSymbol(ERC20.bind(token));
    permissions.name = name;
    permissions.symbol = symbol;

    let t = getAsset(token.toHexString());
    if (t.symbol !== null) {
      // Only set the token link if the asset exists, otherwise just set the
      // token address
      permissions.token = token.toHexString();
    }
  }

  permissions.lastUpdateBlockNumber = event.block.number;
  permissions.lastUpdateTimestamp = event.block.timestamp.toI32();
  permissions.lastUpdateTransactionHash = event.transaction.hash;

  return permissions;
}

export function handleTokenPermissionsUpdate(event: TokenPermissionsUpdated): void {
  let permissions = getTradingModulePermissions(event.params.sender, event.params.token, event);
  permissions.allowSell = event.params.permissions.allowSell;
  let dexFlags = event.params.permissions.dexFlags.toI32();
  let dexes = new Array<string>();
  if ((dexFlags & 1) == 1) dexes.push("UNUSED");
  if ((dexFlags & 2) == 2) dexes.push("UNISWAP_V2");
  if ((dexFlags & 4) == 4) dexes.push("UNISWAP_V3");
  if ((dexFlags & 8) == 8) dexes.push("ZERO_EX");
  if ((dexFlags & 16) == 16) dexes.push("BALANCER_V2");
  if ((dexFlags & 32) == 32) dexes.push("CURVE");
  if ((dexFlags & 64) == 64) dexes.push("NOTIONAL_VAULT");
  if ((dexFlags & 128) == 128) dexes.push("CURVE_V2");
  permissions.allowedDexes = dexes;

  let tradeTypeFlags = event.params.permissions.tradeTypeFlags.toI32();
  let tradeType = new Array<string>();
  if ((tradeTypeFlags & 1) == 1) tradeType.push("EXACT_IN_SINGLE");
  if ((tradeTypeFlags & 2) == 2) tradeType.push("EXACT_OUT_SINGLE");
  if ((tradeTypeFlags & 4) == 4) tradeType.push("EXACT_IN_BATCH");
  if ((tradeTypeFlags & 8) == 8) tradeType.push("EXACT_OUT_BATCH");
  permissions.allowedTradeTypes = tradeType;

  permissions.save();
}
