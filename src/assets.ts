import { ethereum, log } from "@graphprotocol/graph-ts";
import {
  ListCurrency,
  DeployNToken,
  Notional,
  PrimeProxyDeployed,
} from "../generated/Assets/Notional";
import { Asset } from "../generated/schema";
import {
  None,
  NOTE,
  Notional as _Notional,
  nToken,
  PrimeCash,
  PrimeDebt,
  Underlying,
} from "./common/constants";
import { getAccount, getUnderlying } from "./common/entities";
import { createERC20ProxyAsset, createERC20TokenAsset } from "./common/erc20";

function _initializeNOTEToken(notional: Notional, event: ethereum.Event): void {
  let noteToken = notional.getNoteToken();
  if (Asset.load(noteToken.toHexString()) == null) {
    createERC20ProxyAsset(noteToken, NOTE, event);
  }
}

export function handleListCurrency(event: ListCurrency): void {
  let notional = Notional.bind(event.address);
  let results = notional.getCurrency(event.params.newCurrencyId);
  let id = event.params.newCurrencyId as i32;
  let underlyingToken = results.getUnderlyingToken();

  let underlying = createERC20TokenAsset(
    underlyingToken.tokenAddress,
    underlyingToken.hasTransferFee,
    event
  );

  underlying.assetType = Underlying;
  underlying.currencyId = event.params.newCurrencyId;

  underlying.lastUpdateBlockNumber = event.block.number.toI32();
  underlying.lastUpdateTimestamp = event.block.timestamp.toI32();
  underlying.lastUpdateTransactionHash = event.transaction.hash;

  log.debug("Updated currency variables for entity {}", [id.toString()]);
  underlying.save();

  // Set the Notional proxy account if it is not set already to initialize it
  let notionalAccount = getAccount(event.address.toHexString(), event);
  if (notionalAccount.systemAccountType == None) {
    notionalAccount.systemAccountType = _Notional;
    notionalAccount.save();

    // Also initialize the NOTE token asset
    _initializeNOTEToken(notional, event);
  }
}

export function handleDeployNToken(event: DeployNToken): void {
  let currencyId = event.params.currencyId as i32;
  let nTokenAddress = event.params.nTokenAddress;
  let asset = createERC20ProxyAsset(nTokenAddress, nToken, event);

  asset.currencyId = currencyId;
  asset.underlying = getUnderlying(currencyId).id;

  asset.save();
}

export function handleDeployPrimeProxy(event: PrimeProxyDeployed): void {
  let currencyId = event.params.currencyId as i32;
  let nTokenAddress = event.params.proxy;
  let asset = createERC20ProxyAsset(
    nTokenAddress,
    event.params.isCashProxy ? PrimeCash : PrimeDebt,
    event
  );

  asset.currencyId = currencyId;
  asset.underlying = getUnderlying(currencyId).id;
  asset.save();
}
