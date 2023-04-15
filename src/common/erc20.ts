import { Address, DataSourceContext, ethereum, log, BigInt } from "@graphprotocol/graph-ts";
import { Asset } from "../../generated/schema";
import { ERC20 } from "../../generated/templates/ERC20Proxy/ERC20"
import { ERC20Proxy } from "../../generated/templates"
import { getAccount } from "./entities";
import { INTERNAL_TOKEN_PRECISION } from "./constants";

export function getTokenNameAndSymbol(tokenAddress: Address): string[] {
  log.debug('Fetching token symbol and name at {}', [tokenAddress.toHexString()]);
  let erc20 = ERC20.bind(tokenAddress);
  let nameResult = erc20.try_name();
  let name: string;
  let symbol: string;
  if (nameResult.reverted) {
    name = 'unknown';
  } else {
    name = nameResult.value;
  }

  let symbolResult = erc20.try_symbol();
  if (symbolResult.reverted) {
    symbol = 'unknown';
  } else {
    symbol = symbolResult.value;
  }

  return [name, symbol];
}

export function createERC20ProxyAsset(asset: Asset, tokenAddress: Address, event: ethereum.Event): void {
  let symbolAndName = getTokenNameAndSymbol(tokenAddress);
  asset.assetInterface = 'ERC20';
  asset.name = symbolAndName[0];
  asset.symbol = symbolAndName[1];
  asset.precision = INTERNAL_TOKEN_PRECISION;
  asset.emitterAddress = tokenAddress;

  asset.lastUpdateBlockNumber = event.block.number.toI32();
  asset.lastUpdateTimestamp = event.block.timestamp.toI32();
  asset.lastUpdateTransactionHash = event.transaction.hash;

  asset.firstUpdateBlockNumber = event.block.number.toI32();
  asset.firstUpdateTimestamp = event.block.timestamp.toI32();
  asset.firstUpdateTransactionHash = event.transaction.hash;
  updateERC20ProxyTotalSupply(asset);

  log.debug('Updated asset variables for entity {}', [asset.id]);
  asset.save();

  // Creates a new data source to listen for transfer events on
  let context = new DataSourceContext();
  context.setString('name', symbolAndName[0]);
  context.setString('symbol', symbolAndName[1]);
  context.setString('assetType', asset.assetType);
  context.setString('underlying', asset.underlying);
  // Notional will always be the event emitter when creating new proxy assets
  context.setBytes('notional', event.address);
  ERC20Proxy.createWithContext(tokenAddress, context);

  let account = getAccount(tokenAddress.toHexString(), event);
  account.lastUpdateBlockNumber = event.block.number.toI32();
  account.lastUpdateTimestamp = event.block.timestamp.toI32();
  account.lastUpdateTransactionHash = event.transaction.hash;

  // This will be one of nToken, PrimeCash, PrimeDebt
  account.systemAccountType = asset.assetType;

  account.save();
}

export function updateERC20ProxyTotalSupply(asset: Asset): void {
  if (asset.assetInterface != 'ERC20') return
  let erc20 = ERC20.bind(asset.emitterAddress as Address);
  let totalSupply = erc20.try_totalSupply()
  if (totalSupply.reverted) {
    log.error("Unable to fetch total supply for {}", [asset.emitterAddress.toHexString()])
  } else {
    asset.totalSupply = totalSupply.value
  }

  asset.save()
}