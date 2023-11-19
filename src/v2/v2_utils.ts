import { ByteArray, Bytes, BigInt, Address } from "@graphprotocol/graph-ts";
import { getNotionalV2, getUnderlying } from "../common/entities";
import { Token } from "../../generated/schema";
import { INTERNAL_TOKEN_PRECISION } from "../common/constants";
import { NotionalV3__getActiveMarketsResultValue0Struct } from "../../generated/Assets/NotionalV3";

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

export function calculateNTokenValue(currencyId: i32, token: Token, value: BigInt): BigInt {
  let notional = getNotionalV2();
  let nTokenPV = notional.nTokenPresentValueUnderlyingDenominated(currencyId);
  let totalSupply = notional
    .getNTokenAccount(Address.fromBytes(token.tokenAddress))
    .getTotalSupply();
  let underlying = getUnderlying(currencyId);

  return value
    .times(nTokenPV)
    .times(underlying.precision)
    .div(totalSupply)
    .div(INTERNAL_TOKEN_PRECISION);
}

export function calculateSettledfCashValue(currencyId: i32, token: Token, value: BigInt): BigInt {
  let notional = getNotionalV2();
  let underlying = getUnderlying(currencyId);
  let settlementRate = notional.getSettlementRate(currencyId, token.maturity!).rate;

  return value
    .times(BigInt.fromI32(10).pow(10))
    .times(underlying.precision)
    .div(settlementRate);
}

export function calculateifCashPresentValue(
  currencyId: i32,
  token: Token,
  value: BigInt,
  activeMarkets: NotionalV3__getActiveMarketsResultValue0Struct[]
): BigInt {
  // TODO: not sure if this ever actually happens so just use a zero here..
  return BigInt.zero();
}
