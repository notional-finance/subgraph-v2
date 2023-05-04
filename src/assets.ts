import { ethereum, log } from "@graphprotocol/graph-ts";
import {
  ListCurrency,
  DeployNToken,
  Notional,
  PrimeProxyDeployed,
} from "../generated/Assets/Notional";
import { Token } from "../generated/schema";
import {
  None,
  NOTE,
  Notional as _Notional,
  nToken,
  PrimeCash,
  PrimeDebt,
  Underlying,
} from "./common/constants";
import { getAccount, getNotional, getUnderlying } from "./common/entities";
import { createERC20ProxyAsset, createERC20TokenAsset } from "./common/erc20";

function _initializeNOTEToken(notional: Notional, event: ethereum.Event): void {
  let noteToken = notional.getNoteToken();
  if (Token.load(noteToken.toHexString()) == null) {
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
    event,
    Underlying
  );

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
  let notional = getNotional();
  let results = notional.getCurrency(event.params.currencyId);

  token.currencyId = currencyId;
  token.underlying = results.getUnderlyingToken().tokenAddress.toHexString();
  token.save();
}
