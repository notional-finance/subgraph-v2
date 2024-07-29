import { Address, ethereum, log, BigInt, dataSource } from "@graphprotocol/graph-ts";
import { TransferBatch, TransferSingle } from "../generated/Transactions/Notional";
import { ERC20, Transfer as TransferEvent } from "../generated/templates/ERC20Proxy/ERC20";
import { updateBalance } from "./balances";
import { getAsset, createTransfer } from "./common/entities";
import { getOrCreateERC1155Asset } from "./common/erc1155";
import { Token, Transfer } from "../generated/schema";
import {
  convertValueToUnderlying,
  decodeSystemAccount,
  decodeTransferType,
  processTransfer,
} from "./common/transfers";
import { ProxyRenamed } from "../generated/Transactions/ERC4626";
import { getTokenNameAndSymbol } from "./common/erc20";

export const V2_MIGRATION = Address.fromString("0xa9f0fb2528a8ada9b11be582ac1d13bdbfb8d437");

function getMigrationAddress(event: ethereum.Event): Address {
  if (
    event.transaction.hash.toHexString() ===
    "0xbcaf4f2069b95ad6382e1631c3c60a9daf6fd1b469486ccb9beab233a6d6924a"
  ) {
    return Address.fromString("0xCC57354E7E6A13D519dEc111A781823F9aA058C6");
  } else if (
    event.transaction.hash.toHexString() ===
    "0x404fd9098a2f3cd6233f4bbb4c770ab60d8ca70f922908626592b18c9baccb8e"
  ) {
    return Address.fromString("0x9Ca55348524a85148b17e053E16e6e2f2D8B7D29");
  } else if (
    event.transaction.hash.toHexString() ===
    "0xa9821d73a1e92575cdd52b0a8d77e203d08e95119e56c7b027e9ed00dec47fd6"
  ) {
    return Address.fromString("0xA9F0Fb2528a8ada9B11bE582aC1D13BdbFB8d437");
  } else {
    return V2_MIGRATION;
  }
}

export function _logTransfer(
  from: Address,
  to: Address,
  value: BigInt,
  event: ethereum.Event,
  transfer: Transfer,
  token: Token
): void {
  // The V2 migration has incorrectly emitted transfer events. We need to rewrite the
  // from or to address to the correct address via a lookup table.
  if (dataSource.network() == "mainnet") {
    if (from.equals(V2_MIGRATION)) from = getMigrationAddress(event);
    if (to.equals(V2_MIGRATION)) to = getMigrationAddress(event);
  }

  // decode transfer type
  transfer.from = from.toHexString();
  transfer.fromSystemAccount = decodeSystemAccount(from, event);
  transfer.to = to.toHexString();
  transfer.toSystemAccount = decodeSystemAccount(to, event);
  transfer.transactionHash = event.transaction.hash.toHexString();

  transfer.transferType = decodeTransferType(from, to);
  transfer.value = value;
  transfer.valueInUnderlying = convertValueToUnderlying(value, token, event.block.timestamp);

  // inherit token properties
  transfer.token = token.id;
  transfer.tokenType = token.tokenType;
  if (token.get("maturity") != null) transfer.maturity = token.maturity;

  if (token.get("underlying") == null) {
    // This is a NOTE token transfer, we don't track any balance snapshots for this yet
    transfer.underlying = token.id;
  } else {
    transfer.underlying = token.underlying as string;
  }

  // Ensures the balance snapshot exists for the PnL calculations
  updateBalance(token, transfer, event);

  // Calls transfer.save() inside
  processTransfer(transfer, event);
}

export function handleERC1155Transfer(event: TransferSingle): void {
  let token = getOrCreateERC1155Asset(event.params.id, event.block, event.transaction.hash);
  let transfer = createTransfer(event, 0);
  transfer.operator = event.params.operator.toHexString();
  _logTransfer(event.params.from, event.params.to, event.params.value, event, transfer, token);
}

export function handleERC1155BatchTransfer(event: TransferBatch): void {
  for (let i = 0; i < event.params.ids.length; i++) {
    let token = getOrCreateERC1155Asset(event.params.ids[i], event.block, event.transaction.hash);
    let transfer = createTransfer(event, i);

    transfer.operator = event.params.operator.toHexString();
    _logTransfer(
      event.params.from,
      event.params.to,
      event.params.values[i],
      event,
      transfer,
      token
    );
  }
}

export function handleERC20Transfer(event: TransferEvent): void {
  let token = getAsset(event.address.toHexString());
  let transfer = createTransfer(event, 0);
  _logTransfer(event.params.from, event.params.to, event.params.value, event, transfer, token);
}

export function handleProxyRenamed(event: ProxyRenamed): void {
  let token = getAsset(event.address.toHexString());
  let erc20 = ERC20.bind(event.address);
  let symbolAndName = getTokenNameAndSymbol(erc20);
  token.name = symbolAndName[0];
  token.symbol = symbolAndName[1];
  token.save();
}
