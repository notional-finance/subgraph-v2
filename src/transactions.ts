import { TransferBatch, TransferSingle } from "../generated/Governance/Notional";
import { Transfer as TransferEvent } from "../generated/templates/ERC20Proxy/ERC20";
import { getAsset, createTransfer } from "./common/entities";
import { getOrCreateERC1155Asset } from "./common/erc1155";
import { convertValueToUnderlying, decodeSystemAccount, decodeTransferType, processTransfer } from "./common/transfers";

export function handleERC1155Transfer(event: TransferSingle): void {
  let asset = getOrCreateERC1155Asset(event.params.id, event)
  let transfer = createTransfer(event, 0);

  // decode transfer type
  transfer.from = event.params.from.toHexString();
  transfer.fromSystemAccount = decodeSystemAccount(event.params.from, event);
  transfer.to = event.params.to.toHexString();
  transfer.toSystemAccount = decodeSystemAccount(event.params.to, event);
  transfer.operator = event.params.operator.toHexString()

  transfer.transferType = decodeTransferType(event.params.from, event.params.to)
  transfer.value = event.params.value;
  transfer.valueInUnderlying = convertValueToUnderlying(event.params.value, asset, event.block.timestamp);
  
  // inherit asset properties
  transfer.asset = asset.id;
  transfer.assetType = asset.assetType;
  transfer.underlying = asset.underlying;
  transfer.maturity = asset.maturity;

  // Calls transfer.save() inside
  processTransfer(transfer, event)
}

export function handleERC1155BatchTransfer(event: TransferBatch): void {
  for (let i = 0; i < event.params.ids.length; i++) {
    let asset = getOrCreateERC1155Asset(event.params.ids[i], event)
    let transfer = createTransfer(event, i);

    transfer.from = event.params.from.toHexString();
    transfer.fromSystemAccount = decodeSystemAccount(event.params.from, event);
    transfer.to = event.params.to.toHexString();
    transfer.toSystemAccount = decodeSystemAccount(event.params.to, event);
    transfer.operator = event.params.operator.toHexString()

    transfer.transferType = decodeTransferType(event.params.from, event.params.to)
    transfer.value = event.params.values[i];
    transfer.valueInUnderlying = convertValueToUnderlying(event.params.values[i], asset, event.block.timestamp);

  // inherit asset properties
    transfer.asset = asset.id;
    transfer.assetType = asset.assetType;
    transfer.underlying = asset.underlying;
    transfer.maturity = asset.maturity;

    // Calls transfer.save() inside
    processTransfer(transfer, event)
  }
}

export function handleERC20Transfer(event: TransferEvent): void {
    let asset = getAsset(event.address.toHexString())
    let transfer = createTransfer(event, 0);

    transfer.from = event.params.from.toHexString();
    transfer.fromSystemAccount = decodeSystemAccount(event.params.from, event);
    transfer.to = event.params.to.toHexString();
    transfer.toSystemAccount = decodeSystemAccount(event.params.to, event);

    transfer.transferType = decodeTransferType(event.params.from, event.params.to)
    transfer.value = event.params.value;
    transfer.valueInUnderlying = convertValueToUnderlying(transfer.value, asset, event.block.timestamp);

    // inherit asset properties
    transfer.asset = asset.id;
    transfer.assetType = asset.assetType;
    transfer.underlying = asset.underlying;

    // Calls transfer.save() inside
    processTransfer(transfer, event)
}