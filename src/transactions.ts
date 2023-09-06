import { Address, ethereum, log, BigInt } from "@graphprotocol/graph-ts";
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

function _logTransfer(
  from: Address,
  to: Address,
  value: BigInt,
  event: ethereum.Event,
  transfer: Transfer,
  token: Token
): void {
  // decode transfer type
  transfer.from = from.toHexString();
  transfer.fromSystemAccount = decodeSystemAccount(from, event);
  transfer.to = to.toHexString();
  transfer.toSystemAccount = decodeSystemAccount(to, event);

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
    transfer.save();
  } else {
    transfer.underlying = token.underlying as string;

    // Ensures the balance snapshot exists for the PnL calculations
    updateBalance(token, transfer, event);

    // Calls transfer.save() inside
    processTransfer(transfer, event);
  }
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
