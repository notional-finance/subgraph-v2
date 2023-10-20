import { ByteArray, Bytes, BigInt } from "@graphprotocol/graph-ts";

export function decodeERC1155Id(id: BigInt): BigInt[] {
  let idHex = id.toHexString();
  // Pad idHex out to a length of 20 (including the 0x prefix)
  idHex = "0x" + idHex.slice(2).padStart(18, "0");
  let bytes = ByteArray.fromHexString(idHex);

  let assetType = bytes[8] as i32;
  let maturityBytes = new Bytes(5);
  // Parsing bytes into ints is done in reverse order
  maturityBytes[0] = bytes[7];
  maturityBytes[1] = bytes[6];
  maturityBytes[2] = bytes[5];
  maturityBytes[3] = bytes[4];
  maturityBytes[4] = bytes[3];
  let maturity = maturityBytes.toI64();

  let currencyBytes = new Bytes(2);
  currencyBytes[0] = bytes[2];
  currencyBytes[1] = bytes[1];
  let currencyId = currencyBytes.toI32();

  let isfCashDebtBytes = new Bytes(1);
  isfCashDebtBytes[0] = bytes[0];
  let isfCashDebt = isfCashDebtBytes.toI32();

  return [
    BigInt.fromI32(assetType),
    BigInt.fromI64(maturity),
    BigInt.fromI32(currencyId),
    BigInt.fromI32(isfCashDebt),
  ];
}
