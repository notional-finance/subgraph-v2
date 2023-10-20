import { Address, dataSource, ethereum, log } from "@graphprotocol/graph-ts";
import {
  ListCurrency,
  DeployNToken,
  NotionalV3,
  PrimeProxyDeployed,
} from "../generated/Assets/NotionalV3";
import { Token } from "../generated/schema";
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
    let assetCash = createERC20TokenAsset(
      assetToken.tokenAddress,
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

export function initialize(_block: ethereum.Block): void {
  let network = dataSource.network();
  let context = dataSource.context();
  if (network == "mainnet" || network == "goerli") {
    context.setString("version", "v2");
    context.setBoolean("incentivesMigrated", false);
  } else {
    context.setString("version", "v3");
    context.setBoolean("incentivesMigrated", true);
  }
}
