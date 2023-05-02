import { Address, DataSourceContext, ethereum, log, BigInt } from "@graphprotocol/graph-ts";
import { Asset } from "../../generated/schema";
import { ERC20 } from "../../generated/templates/ERC20Proxy/ERC20";
import { ERC20Proxy } from "../../generated/templates";
import { getAccount } from "./entities";
import { ZERO_ADDRESS } from "./constants";

export function getTokenNameAndSymbol(erc20: ERC20): string[] {
  let nameResult = erc20.try_name();
  let name: string;
  let symbol: string;
  if (nameResult.reverted) {
    name = "unknown";
  } else {
    name = nameResult.value;
  }

  let symbolResult = erc20.try_symbol();
  if (symbolResult.reverted) {
    symbol = "unknown";
  } else {
    symbol = symbolResult.value;
  }

  return [name, symbol];
}

export function createERC20ProxyAsset(
  tokenAddress: Address,
  assetType: string,
  event: ethereum.Event
): Asset {
  let asset = createERC20TokenAsset(tokenAddress, false, event, assetType);
  asset.totalSupply = BigInt.zero();

  // Creates a new data source to listen for transfer events on
  let context = new DataSourceContext();
  context.setString("name", asset.name);
  context.setString("symbol", asset.symbol);
  context.setString("assetType", asset.assetType);
  // Notional will always be the event emitter when creating new proxy assets
  context.setBytes("notional", event.address);
  ERC20Proxy.createWithContext(tokenAddress, context);

  let account = getAccount(tokenAddress.toHexString(), event);
  account.lastUpdateBlockNumber = event.block.number.toI32();
  account.lastUpdateTimestamp = event.block.timestamp.toI32();
  account.lastUpdateTransactionHash = event.transaction.hash;

  // This will be one of nToken, PrimeCash, PrimeDebt
  account.systemAccountType = asset.assetType;

  account.save();

  return asset;
}

export function createERC20TokenAsset(
  tokenAddress: Address,
  hasTransferFee: boolean,
  event: ethereum.Event,
  assetType: string
): Asset {
  let asset = Asset.load(tokenAddress.toHexString());
  if (asset) return asset;

  // If asset does not exist, then create it here
  asset = new Asset(tokenAddress.toHexString());

  if (tokenAddress == ZERO_ADDRESS) {
    asset.name = "Ether";
    asset.symbol = "ETH";
    asset.precision = BigInt.fromI32(10).pow(18);
  } else {
    let erc20 = ERC20.bind(tokenAddress);
    let symbolAndName = getTokenNameAndSymbol(erc20);
    let decimals = erc20.decimals();
    asset.name = symbolAndName[0];
    asset.symbol = symbolAndName[1];
    asset.precision = BigInt.fromI32(10).pow(decimals as u8);
  }

  asset.assetInterface = "ERC20";
  asset.tokenAddress = tokenAddress;
  asset.hasTransferFee = hasTransferFee;
  asset.assetType = assetType;
  asset.isfCashDebt = false;

  asset.lastUpdateBlockNumber = event.block.number.toI32();
  asset.lastUpdateTimestamp = event.block.timestamp.toI32();
  asset.lastUpdateTransactionHash = event.transaction.hash;

  asset.firstUpdateBlockNumber = event.block.number.toI32();
  asset.firstUpdateTimestamp = event.block.timestamp.toI32();
  asset.firstUpdateTransactionHash = event.transaction.hash;

  log.debug("Updated asset variables for entity {}", [asset.id]);
  asset.save();

  return asset;
}
