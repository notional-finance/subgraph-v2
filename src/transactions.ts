import { Address, ethereum, log, BigInt } from "@graphprotocol/graph-ts";
import { TransferBatch, TransferSingle } from "../generated/Transactions/Notional";
import { Transfer as TransferEvent } from "../generated/templates/ERC20Proxy/ERC20";
import { updateBalance } from "./balances";
import { getAsset, createTransfer } from "./common/entities";
import { getOrCreateERC1155Asset } from "./common/erc1155";
import { Asset, Transfer } from "../generated/schema";
import {
  convertValueToUnderlying,
  decodeSystemAccount,
  decodeTransferType,
  processTransfer,
} from "./common/transfers";

function _logTransfer(
  from: Address,
  to: Address,
  value: BigInt,
  event: ethereum.Event,
  transfer: Transfer,
  asset: Asset
): void {
  // decode transfer type
  transfer.from = from.toHexString();
  transfer.fromSystemAccount = decodeSystemAccount(from, event);
  transfer.to = to.toHexString();
  transfer.toSystemAccount = decodeSystemAccount(to, event);

  transfer.transferType = decodeTransferType(from, to);
  transfer.value = value;
  transfer.valueInUnderlying = convertValueToUnderlying(value, asset, event.block.timestamp);

  // inherit asset properties
  transfer.asset = asset.id;
  transfer.assetType = asset.assetType;
  if (asset.get("maturity") != null) transfer.maturity = asset.maturity;

  if (asset.get("underlying") == null) log.critical("Unknown underlying for asset {}", [asset.id]);
  transfer.underlying = asset.underlying as string;

  updateBalance(asset, transfer, event);

  // Calls transfer.save() inside
  processTransfer(transfer, event);
}

export function handleERC1155Transfer(event: TransferSingle): void {
  let asset = getOrCreateERC1155Asset(event.params.id, event.block, event.transaction.hash);
  let transfer = createTransfer(event, 0);
  transfer.operator = event.params.operator.toHexString();
  _logTransfer(event.params.from, event.params.to, event.params.value, event, transfer, asset);
}

export function handleERC1155BatchTransfer(event: TransferBatch): void {
  for (let i = 0; i < event.params.ids.length; i++) {
    let asset = getOrCreateERC1155Asset(event.params.ids[i], event.block, event.transaction.hash);
    let transfer = createTransfer(event, i);

    transfer.operator = event.params.operator.toHexString();
    _logTransfer(
      event.params.from,
      event.params.to,
      event.params.values[i],
      event,
      transfer,
      asset
    );
  }
}

export function handleERC20Transfer(event: TransferEvent): void {
  let asset = getAsset(event.address.toHexString());
  let transfer = createTransfer(event, 0);
  _logTransfer(event.params.from, event.params.to, event.params.value, event, transfer, asset);
}
