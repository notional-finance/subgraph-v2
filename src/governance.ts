import { Address, log } from '@graphprotocol/graph-ts';
import {
  ListCurrency,
  DeployNToken,
  Notional,
  PrimeProxyDeployed,
} from '../generated/Governance/Notional';
import { None, Notional as _Notional } from './common/constants';
import { getAccount, getAsset, getUnderlying } from './common/entities';
import { createERC20ProxyAsset, getTokenNameAndSymbol } from './common/erc20';

export function handleListCurrency(event: ListCurrency): void {
  let notional = Notional.bind(event.address);
  let results = notional.getCurrency(event.params.newCurrencyId);
  let id = event.params.newCurrencyId as i32;
  let underlying = getUnderlying(id.toString());

  let underlyingToken = results.getUnderlyingToken()
  underlying.precision = underlyingToken.decimals;
  underlying.tokenAddress = underlyingToken.tokenAddress;
  underlying.hasTransferFee = underlyingToken.hasTransferFee;

  if (underlyingToken.tokenAddress != Address.zero()) {
    let underlyingTokenNameAndSymbol = getTokenNameAndSymbol(underlyingToken.tokenAddress);
    underlying.name = underlyingTokenNameAndSymbol[0];
    underlying.symbol = underlyingTokenNameAndSymbol[1];
  } else if (underlyingToken.tokenType == 3) { // TokenType == Ether
    underlying.name = 'Ether';
    underlying.symbol = 'ETH';
  }

  underlying.lastUpdateBlockNumber = event.block.number.toI32();
  underlying.lastUpdateTimestamp = event.block.timestamp.toI32();
  underlying.lastUpdateTransactionHash = event.transaction.hash;

  log.debug('Updated currency variables for entity {}', [id.toString()]);
  underlying.save();

  // Set the Notional proxy account if it is not set already to initialize it
  let notionalAccount = getAccount(event.address.toHexString(), event)
  if (notionalAccount.systemAccountType == None) {
    notionalAccount.systemAccountType = _Notional;
    notionalAccount.save();

    // Also initialize the NOTE token asset
    let noteToken = notional.getNoteToken()
    let noteAsset = getAsset(noteToken.toHexString())
    createERC20ProxyAsset(noteAsset, noteToken, event)
  }
}

export function handleDeployNToken(event: DeployNToken): void {
  let currencyId = event.params.currencyId as i32;
  let nTokenAddress = event.params.nTokenAddress;
  let asset = getAsset(nTokenAddress.toString());

  asset.assetType = 'nToken';
  asset.underlying = currencyId.toString();

  createERC20ProxyAsset(asset, nTokenAddress, event)
  asset.save();
}

export function handleDeployPrimeProxy(event: PrimeProxyDeployed): void {
  let currencyId = event.params.currencyId as i32;
  let nTokenAddress = event.params.proxy;
  let asset = getAsset(nTokenAddress.toString());

  asset.assetType = event.params.isCashProxy ? 'pCash' : 'pDebt';
  asset.underlying = currencyId.toString();

  createERC20ProxyAsset(asset, nTokenAddress, event)
  asset.save();
}