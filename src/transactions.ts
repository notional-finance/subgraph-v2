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
  let txHash = event.transaction.hash.toHexString();
  log.info("Getting migration address for transaction: {}", [txHash]);

  if (txHash == "0xbcaf4f2069b95ad6382e1631c3c60a9daf6fd1b469486ccb9beab233a6d6924a") {
    return Address.fromString("0xcc57354e7e6a13d519dec111a781823f9aa058c6");
  } else if (txHash == "0x404fd9098a2f3cd6233f4bbb4c770ab60d8ca70f922908626592b18c9baccb8e") {
    return Address.fromString("0x9ca55348524a85148b17e053e16e6e2f2d8b7d29");
  } else if (txHash == "0xa9821d73a1e92575cdd52b0a8d77e203d08e95119e56c7b027e9ed00dec47fd6") {
    return Address.fromString("0x5699cae66db88b06cd73b26f00b918e0691b64c2");
  } else if (txHash == "0xd0212a9886360c996c283e8b7a018ed43d731fe2d0c57feb1cc0a02eb33dbf18") {
    return Address.fromString("0x0d2b271e5b6b6515dc9563d396fcec5fd8474900");
  } else if (txHash == "0x8586b68f6c5260338cf010705c8afeb3f23279fcb13b11c3b8639e2c337eb84d") {
    return Address.fromString("0x400790b21180330f32dc1fb5460c7837e9bdf0f9");
  } else if (txHash == "0x17b963937e9b5efeab2122b3fd4291bdf27d73ab9fda3fa2df4118d1ed47583e") {
    return Address.fromString("0x23062b8a8f1de57673d5d9e771d0b165c1b00fe9");
  } else if (txHash == "0x39a6d7a16dc879720bbd4f01f457d80ff198f45bd4fb21ba641e45bf6d5b6ae2") {
    return Address.fromString("0x5786dfcfc889020364cd736531b4bb11c45b4165");
  } else if (txHash == "0x3e83224833d47f8b9ae97d0e849f0b343def43c6f1091dbebd1dd6b4cf5646d5") {
    return Address.fromString("0xfba5c82289a969d8cc2f2fcf45b2a9e5e2a01dd4");
  } else if (txHash == "0x985f5f4aa25c7fc3d16e8b790925fdc5aceddf3b8b6c282a2f272c919832ca47") {
    return Address.fromString("0x04a3b17cfbeef344127e78ad082fecb36ad76d64");
  } else if (txHash == "0xfc96b935362faab7ab1a6c0d3aa608d85322f5bb03ca532c15a04e5eebcfff05") {
    return Address.fromString("0x120395d18e5f12f5e57d2b86031e5978b256d8fa");
  } else if (txHash == "0xe449ff155fbf791dc5ee70593e05671c6425bddd8102056b443b9604a79eb415") {
    return Address.fromString("0x15025f5bc20ec36dbf4b73f8234a3ab7cb1df172");
  } else if (txHash == "0x1fbbf9edadeadc8c9cc403543e6a1964e4d7c1d36bcd0b804b5fdffe8247e7aa") {
    return Address.fromString("0xe6fb62c2218fd9e3c948f0549a2959b509a293c8");
  } else if (txHash == "0xbbc3e6bd57b36d20df71d7913da8c4d95f1d698f9b3e4bd8bb3b8f569cf20055") {
    return Address.fromString("0x31905f2aab23dd0d8a96ea8424471d3f3f328825");
  } else if (txHash == "0x7b62767bb706f701f54d4752f63952705abf17c3426f86b0be5c9dd3b5bd2bf0") {
    return Address.fromString("0x87eac5a3678a46119d2b050a43717fcf94e1855d");
  } else if (txHash == "0xc868e417d178c084ee698c816dc5dc9bfb75fdcf592531b07a3cf972fc4972ca") {
    return Address.fromString("0x6b7cc4757c41540d49d6e8b8fdd6d52020429516");
  } else if (txHash == "0x4abcefbd8c4fd67a620d835cf594e6131f4252a27e081b768af6078aa78285d0") {
    return Address.fromString("0xbe4f974164586795a429d62cecb145163514f0cd");
  } else if (txHash == "0xf229fdec733f7b95b9a37bcd911b5d16c04a6ebd94e23efc92d1fda19488ec02") {
    return Address.fromString("0xfb27c8582976f1a29d58e89bcc89da1e54d78076");
  } else if (txHash == "0x242db029f2a78ccf7f5107b57c56dd07723aa66bff5db696a5eff3ccff99ebff") {
    return Address.fromString("0x67c6dea057747019f5a8c1519a632d7cd6b890a7");
  } else if (txHash == "0x8da5d6a1bc54be52f1b59bf35c1e30ffb85f0f387c37ba4b22a9e02e3e950f7a") {
    return Address.fromString("0x5a1cbf51ae340aa03c3f5d183e9a47dc733e28cd");
  } else if (txHash == "0x77004982295936c4ea4028555706ff7aabca3fbe2fbd6a438b83706fa45e7079") {
    return Address.fromString("0x3036f1ffa91f1da5e608ab261584215f1f38e749");
  } else if (txHash == "0x5091400663c886da710221d616b05b0105f40a3b07c0c0301428524ecdd53b8d") {
    return Address.fromString("0xc95a4d4078b12572d1dc4c85eb268e77b1805e83");
  } else if (txHash == "0x5933a6ad58a60db6580a00716a162db763b1a345e406255e62abfc53a614224a") {
    return Address.fromString("0x2a3a69441f2bf06c45cbf302f056363e74720e68");
  } else if (txHash == "0x498a7f5891f93875ef1825555d82429852fad137ff84df837d38d2cd20f7919c") {
    return Address.fromString("0x6f3b4096abaed2de7f08405a975d7aafe223ecbe");
  } else if (txHash == "0x27fdaabff39339f189837a949e9fc844566f30e1fab041ac2ff46b15fb4bbdf8") {
    return Address.fromString("0x834374e98175524ffecdcc73e344a8123896d29a");
  } else if (txHash == "0xa5ef902690f73f5b252f665b890551e51de3c41e73ab6a688c11b94f4a059867") {
    return Address.fromString("0xd998171b51dede5bb420228f8ca6e349daf0fd62");
  } else if (txHash == "0x9e130e5c1f478bbb49687df97f50faec454f451dd823c473e5298a1c9b24ab63") {
    return Address.fromString("0xab7b8654c68a17892f7db8b6e3e66fca86965d06");
  } else if (txHash == "0x8d26cdf33559ecd591e7be9218340fcf31b3e5d968e7becba9bdad20da1ad595") {
    return Address.fromString("0x2d01d09276e57a0f38b64c5f75f5ea00b59a9aeb");
  } else if (txHash == "0x286d51546709caf8cbf1e5735019a156b5d6342c236499327cc53105de5e441a") {
    return Address.fromString("0xaa60084b1170bce4b6aaa1c56c1aa5f3dca85923");
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
  if (
    dataSource.network() == "mainnet" &&
    event.block.number.gt(BigInt.fromI32(20391970)) &&
    event.block.number.lt(BigInt.fromI32(20421610))
  ) {
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
