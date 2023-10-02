import {
  Address,
  DataSourceContext,
  ethereum,
  log,
  BigInt,
  dataSource,
} from "@graphprotocol/graph-ts";
import { Token } from "../../generated/schema";
import { ERC20 } from "../../generated/templates/ERC20Proxy/ERC20";
import { ERC20Proxy } from "../../generated/templates";
import { getAccount } from "./entities";
import { ARB_USDC, ARB_USDC_E, ZERO_ADDRESS } from "./constants";

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
  tokenType: string,
  event: ethereum.Event
): Token {
  let token = createERC20TokenAsset(tokenAddress, false, event, tokenType);
  token.totalSupply = BigInt.zero();

  // Creates a new data source to listen for transfer events on
  let context = new DataSourceContext();
  context.setString("name", token.name);
  context.setString("symbol", token.symbol);
  context.setString("tokenType", token.tokenType);
  // Notional will always be the event emitter when creating new proxy assets
  context.setBytes("notional", event.address);
  ERC20Proxy.createWithContext(tokenAddress, context);

  let account = getAccount(tokenAddress.toHexString(), event);
  account.lastUpdateBlockNumber = event.block.number;
  account.lastUpdateTimestamp = event.block.timestamp.toI32();
  account.lastUpdateTransactionHash = event.transaction.hash;

  // This will be one of nToken, PrimeCash, PrimeDebt
  account.systemAccountType = token.tokenType;

  account.save();

  return token;
}

export function createERC20TokenAsset(
  tokenAddress: Address,
  hasTransferFee: boolean,
  event: ethereum.Event,
  tokenType: string
): Token {
  let token = Token.load(tokenAddress.toHexString());
  if (token) return token;

  // If token does not exist, then create it here
  token = new Token(tokenAddress.toHexString());

  if (tokenAddress == ZERO_ADDRESS) {
    token.name = "Ether";
    token.symbol = "ETH";
    token.decimals = 18;
    token.precision = BigInt.fromI32(10).pow(18);
  } else {
    let erc20 = ERC20.bind(tokenAddress);
    let symbolAndName = getTokenNameAndSymbol(erc20);
    let decimals = erc20.decimals();
    token.name = symbolAndName[0];
    token.symbol = symbolAndName[1];
    token.decimals = decimals;
    token.precision = BigInt.fromI32(10).pow(decimals as u8);
  }

  token.tokenInterface = "ERC20";
  token.tokenAddress = tokenAddress;
  token.hasTransferFee = hasTransferFee;
  token.tokenType = tokenType;
  token.isfCashDebt = false;

  token.lastUpdateBlockNumber = event.block.number;
  token.lastUpdateTimestamp = event.block.timestamp.toI32();
  token.lastUpdateTransactionHash = event.transaction.hash;

  token.firstUpdateBlockNumber = event.block.number;
  token.firstUpdateTimestamp = event.block.timestamp.toI32();
  token.firstUpdateTransactionHash = event.transaction.hash;

  log.debug("Updated token variables for entity {}", [token.id]);
  token.save();

  return token;
}
