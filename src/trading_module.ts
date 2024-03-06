import { Address, ethereum, ByteArray, BigInt, dataSource, Bytes } from "@graphprotocol/graph-ts";
import { Token, TradingModulePermission } from "../generated/schema";
import {
  PriceOracleUpdated,
  TokenPermissionsUpdated,
  TradingModule,
} from "../generated/TradingModule/TradingModule";
import { Underlying, USD_ASSET_ID, ZERO_ADDRESS, ZeroAddress } from "./common/constants";
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

export function handleInitialOracles(block: ethereum.Block): void {
  if (dataSource.network() == "mainnet") {
    let trading = TradingModule.bind(
      Address.fromHexString("0x594734c7e06C3D483466ADBCe401C6Bd269746C8")
    );

    // Creates an empty event for method compatibility
    let event = new ethereum.Event(
      trading._address,
      BigInt.zero(),
      BigInt.zero(),
      null,
      block,
      new ethereum.Transaction(
        Bytes.fromBigInt(BigInt.zero()),
        BigInt.zero(),
        trading._address,
        ZERO_ADDRESS,
        BigInt.zero(),
        BigInt.zero(),
        BigInt.zero(),
        Bytes.fromBigInt(BigInt.zero()),
        BigInt.zero()
      ),
      new Array<ethereum.EventParam>(),
      null
    );
    let initialQuoteAssets = [
      // wstETH
      Address.fromHexString("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0"),
      // stETH
      Address.fromHexString("0xae7ab96520de3a18e5e111b5eaab095312d7fe84"),
      // BAL
      Address.fromHexString("0xba100000625a3754423978a60c9317c58a424e3D"),
      // WBTC
      Address.fromHexString("0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"),
      // USDT
      Address.fromHexString("0xdac17f958d2ee523a2206206994597c13d831ec7"),
      // USDC
      Address.fromHexString("0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"),
      // DAI
      Address.fromHexString("0x6b175474e89094c44da98b954eedeac495271d0f"),
      // WETH
      Address.fromHexString("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"),
      // ETH
      Address.fromHexString("0x0000000000000000000000000000000000000000"),
    ];
    let usdBaseAsset = getUSDAsset(event);

    for (let i = 0; i < initialQuoteAssets.length; i++) {
      let quoteAsset = createERC20TokenAsset(initialQuoteAssets[i], false, event, Underlying);
      let oracle = trading.priceOracles(initialQuoteAssets[i]);
      registerChainlinkOracle(usdBaseAsset, quoteAsset, oracle.getOracle(), false, event);
    }
  }
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
    let nameSymbol = getTokenNameAndSymbol(ERC20.bind(token));
    permissions.name = nameSymbol[0];
    permissions.symbol = nameSymbol[1];

    let t = getAsset(token.toHexString());
    if (t.get("symbol") !== null) {
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
