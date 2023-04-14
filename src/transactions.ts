import { TransferBatch, TransferSingle } from "../generated/Governance/Notional";
import { Transfer as TransferEvent } from "../generated/templates/ERC20Proxy/ERC20";
import { getAsset, getTransfer } from "./common/entities";
import { convertValueToUnderlying, decodeSystemAccount, decodeTransferType, processTransfer } from "./common/transfers";

export function handleERC1155Transfer(event: TransferSingle): void {
  let asset = getAsset(event.params.id.toString())
  let transfer = getTransfer(event, 0);

  // decode transfer type
  transfer.from = event.params.from.toHexString();
  transfer.fromSystemAccount = decodeSystemAccount(event.params.from, event);
  transfer.to = event.params.to.toHexString();
  transfer.toSystemAccount = decodeSystemAccount(event.params.to, event);

  transfer.transferType = decodeTransferType(event.params.from, event.params.to)
  transfer.value = event.params.value;
  transfer.valueInUnderlying = convertValueToUnderlying(event.params.value, asset);
  transfer.asset = asset.id;
  transfer.assetType = asset.assetType;
  transfer.operator = event.params.operator.toHexString()

  // Calls transfer.save() inside
  processTransfer(transfer, event)
}

export function handleERC1155BatchTransfer(event: TransferBatch): void {
  for (let i = 0; i < event.params.ids.length; i++) {
    let asset = getAsset(event.params.ids[i].toString())
    let transfer = getTransfer(event, i);

    transfer.from = event.params.from.toHexString();
    transfer.fromSystemAccount = decodeSystemAccount(event.params.from, event);
    transfer.to = event.params.to.toHexString();
    transfer.toSystemAccount = decodeSystemAccount(event.params.to, event);
    transfer.transferType = decodeTransferType(event.params.from, event.params.to)
    transfer.value = event.params.values[i];
    transfer.valueInUnderlying = convertValueToUnderlying(event.params.values[i], asset);
    transfer.asset = asset.id;
    transfer.assetType = asset.assetType;
    transfer.operator = event.params.operator.toHexString()

    // Calls transfer.save() inside
    processTransfer(transfer, event)
  }
}

export function handleERC20Transfer(event: TransferEvent): void {
    let asset = getAsset(event.address.toHexString())
    let transfer = getTransfer(event, 0);

    transfer.from = event.params.from.toHexString();
    transfer.fromSystemAccount = decodeSystemAccount(event.params.from, event);
    transfer.to = event.params.to.toHexString();
    transfer.toSystemAccount = decodeSystemAccount(event.params.to, event);
    transfer.transferType = decodeTransferType(event.params.from, event.params.to)
    transfer.value = event.params.value;
    transfer.value = convertValueToUnderlying(transfer.value, asset);
    transfer.asset = asset.id;
    transfer.assetType = asset.assetType;

    // Calls transfer.save() inside
    processTransfer(transfer, event)
}