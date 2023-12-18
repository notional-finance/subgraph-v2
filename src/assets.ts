import { Address, dataSource, ethereum, log } from "@graphprotocol/graph-ts";
import {
  ListCurrency,
  DeployNToken,
  NotionalV3,
  PrimeProxyDeployed,
  Upgraded,
} from "../generated/Assets/NotionalV3";
import { Token, VersionContext } from "../generated/schema";
import {
  None,
  NOTE,
  Notional as _Notional,
  nToken,
  PrimeCash,
  PrimeDebt,
  Underlying,
  ARB_USDC,
  ARB_USDC_E,
  AssetCash,
} from "./common/constants";
import { getAccount, getNotional, getUnderlying, isV2 } from "./common/entities";
import { createERC20ProxyAsset, createERC20TokenAsset } from "./common/erc20";
import { getAssetToken } from "./v2/handle_v2";

export function readUnderlyingTokenFromNotional(currencyId: i32): Address {
  let notional = getNotional();
  let results = notional.getCurrency(currencyId);

  let tokenAddress = results.getUnderlyingToken().tokenAddress;

  // Rewrite the USDC address on arbitrum
  let network = dataSource.network();
  if (network == "arbitrum-one" && tokenAddress == Address.fromBytes(ARB_USDC_E)) {
    // Rewrite the USDC address to account for the token migration
    tokenAddress = Address.fromBytes(ARB_USDC);
  }

  return tokenAddress;
}

function _initializeNOTEToken(notional: NotionalV3, event: ethereum.Event): void {
  let noteToken = notional.getNoteToken();
  if (dataSource.network() == "goerli") {
    // This is incorrect on the initial Goerli deployment
    noteToken = Address.fromString("0xC5e91B01F9B23952821410Be7Aa3c45B6429C670");
  }

  if (Token.load(noteToken.toHexString()) == null) {
    createERC20ProxyAsset(noteToken, NOTE, event);
  }
}

export function handleListCurrency(event: ListCurrency): void {
  let notional = getNotional();
  let results = notional.getCurrency(event.params.newCurrencyId);
  let id = event.params.newCurrencyId as i32;
  let underlyingToken = results.getUnderlyingToken();
  let tokenAddress = readUnderlyingTokenFromNotional(event.params.newCurrencyId);

  let underlying = createERC20TokenAsset(
    tokenAddress,
    underlyingToken.hasTransferFee,
    event,
    Underlying
  );

  underlying.currencyId = event.params.newCurrencyId;
  underlying.lastUpdateBlockNumber = event.block.number;
  underlying.lastUpdateTimestamp = event.block.timestamp.toI32();
  underlying.lastUpdateTransactionHash = event.transaction.hash;

  log.debug("Updated currency variables for entity {}", [id.toString()]);
  underlying.save();

  if (isV2()) {
    let assetToken = results.getAssetToken();
    let tokenAddress = getAssetToken(id);

    let assetCash = createERC20TokenAsset(
      tokenAddress,
      assetToken.hasTransferFee,
      event,
      AssetCash
    );
    assetCash.currencyId = event.params.newCurrencyId;
    assetCash.lastUpdateBlockNumber = event.block.number;
    assetCash.lastUpdateTimestamp = event.block.timestamp.toI32();
    assetCash.lastUpdateTransactionHash = event.transaction.hash;
    assetCash.save();
  }

  // Set the Notional proxy account if it is not set already to initialize it
  let notionalAccount = getAccount(event.address.toHexString(), event);
  if (notionalAccount.systemAccountType == None) {
    notionalAccount.systemAccountType = _Notional;
    notionalAccount.save();

    // Also initialize the NOTE token
    _initializeNOTEToken(notional, event);
  }
}

export function handleDeployNToken(event: DeployNToken): void {
  let currencyId = event.params.currencyId as i32;
  let nTokenAddress = event.params.nTokenAddress;
  let token = createERC20ProxyAsset(nTokenAddress, nToken, event);

  token.currencyId = currencyId;
  token.underlying = getUnderlying(currencyId).id;

  token.save();
}

export function handleDeployPrimeProxy(event: PrimeProxyDeployed): void {
  let currencyId = event.params.currencyId as i32;
  let proxyAddress = event.params.proxy;
  let token = createERC20ProxyAsset(
    proxyAddress,
    event.params.isCashProxy ? PrimeCash : PrimeDebt,
    event
  );

  // This is required due to the order in which events are emitted (this is
  // emitted prior to list currency)
  let tokenAddress = readUnderlyingTokenFromNotional(currencyId);
  token.underlying = tokenAddress.toHexString();
  token.currencyId = currencyId;
  token.save();
}

export function handleUpgrade(event: Upgraded): void {
  let versionContext = VersionContext.load("0");
  let network = dataSource.network();

  if (versionContext == null) {
    versionContext = new VersionContext("0");
    if (network == "mainnet" || network == "goerli") {
      versionContext.version = "v2";
      versionContext.didMigrateIncentives = false;
      versionContext.isMigratingToV3 = false;
    } else {
      versionContext.version = "v3";
      versionContext.didMigrateIncentives = true;
      versionContext.isMigratingToV3 = false;
    }
  }

  versionContext.lastUpdateBlockNumber = event.block.number;
  versionContext.lastUpdateTimestamp = event.block.timestamp.toI32();
  versionContext.lastUpdateTransactionHash = event.transaction.hash;
  versionContext.routerImplementation = event.params.implementation;
  versionContext.save();
}
