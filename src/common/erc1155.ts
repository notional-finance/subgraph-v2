import { ethereum, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { NotionalV3__decodeERC1155IdResult } from "../../generated/Assets/NotionalV3";
import { Token } from "../../generated/schema";
import {
  fCash,
  INTERNAL_TOKEN_DECIMALS,
  INTERNAL_TOKEN_PRECISION,
  LEGACY_NTOKEN_ASSET_TYPE_ID,
  PRIME_CASH_VAULT_MATURITY,
  VaultCash,
  VaultDebt,
  VaultShare,
  ZERO_ADDRESS,
} from "./constants";
import { getAsset, getNotional, getUnderlying, isV2 } from "./entities";
import { decodeERC1155Id } from "../v2/v2_utils";

const FCASH_ASSET_TYPE = 1;
const VAULT_SHARE_ASSET_TYPE = 9;
const VAULT_DEBT_ASSET_TYPE = 10;
const VAULT_CASH_ASSET_TYPE = 11;

function _setAssetType(decodedId: NotionalV3__decodeERC1155IdResult, token: Token): void {
  let tokenType = decodedId.getAssetType().toI32();
  let maturity = decodedId.getMaturity().toString();
  let underlying = getUnderlying(decodedId.getCurrencyId());
  let underlyingSymbol = underlying.symbol;

  if (tokenType == FCASH_ASSET_TYPE) {
    token.tokenType = fCash;
    if (decodedId.getIsfCashDebt()) {
      token.name = "f" + underlyingSymbol + " Debt Maturing " + maturity;
      token.symbol = "-f" + underlyingSymbol + ":fixed@" + maturity;
    } else {
      token.name = "f" + underlyingSymbol + " Maturing " + maturity;
      token.symbol = "f" + underlyingSymbol + ":fixed@" + maturity;
    }
    return;
  }

  let vaultMaturityString =
    decodedId.getMaturity() == PRIME_CASH_VAULT_MATURITY
      ? " Open Term"
      : " Fixed Term @ " + maturity;
  let vaultMaturitySymbol =
    decodedId.getMaturity() == PRIME_CASH_VAULT_MATURITY ? ":open" : ":fixed@" + maturity;
  let vaultAddress = decodedId.getVaultAddress().toHexString();

  if (tokenType == VAULT_SHARE_ASSET_TYPE) {
    token.tokenType = VaultShare;
    token.name =
      "Vault Shares in " + underlyingSymbol + " for " + vaultAddress + vaultMaturityString;
    token.symbol = "vs" + underlyingSymbol + ":" + vaultAddress + vaultMaturitySymbol;
  } else if (tokenType == VAULT_DEBT_ASSET_TYPE) {
    token.tokenType = VaultDebt;
    token.name = "Vault " + underlyingSymbol + " Debt for " + vaultAddress + vaultMaturityString;
    token.symbol = "vd" + underlyingSymbol + ":" + vaultAddress + vaultMaturitySymbol;
  } else if (tokenType == VAULT_CASH_ASSET_TYPE) {
    token.tokenType = VaultCash;
    token.name = "Vault " + underlyingSymbol + " Cash for " + vaultAddress + vaultMaturityString;
    token.symbol = "vc" + underlyingSymbol + ":" + vaultAddress + vaultMaturitySymbol;
  }
}

export function getOrCreateERC1155Asset(
  erc1155ID: BigInt,
  block: ethereum.Block,
  txnHash: Bytes | null
): Token {
  let notional = getNotional();
  let decodedId: NotionalV3__decodeERC1155IdResult;

  if (isV2()) {
    // The decodeERC1155Id method does not exist in v2
    let decoded = decodeERC1155Id(erc1155ID);
    decodedId = new NotionalV3__decodeERC1155IdResult(
      decoded[2].toI32(), // currencyId
      decoded[1], // maturity
      decoded[0], // asset type
      ZERO_ADDRESS, // vault address
      decoded[3].equals(BigInt.fromI32(1)) // isfCashDebt
    );
  } else {
    decodedId = notional.decodeERC1155Id(erc1155ID);
  }

  if (decodedId.getAssetType() == LEGACY_NTOKEN_ASSET_TYPE_ID) {
    // In this case return the token as the ERC20 nToken token
    let nTokenAddress = notional.nTokenAddress(decodedId.getCurrencyId());
    return getAsset(nTokenAddress.toHexString());
  }

  // Pad the ids to 256 bit hex strings
  let id =
    "0x" +
    erc1155ID
      .toHexString()
      .slice(2)
      .padStart(64, "0");

  let token = Token.load(id);
  if (token == null) {
    token = new Token(id);
    token.tokenInterface = "ERC1155";
    token.underlying = getUnderlying(decodedId.getCurrencyId()).id;
    token.currencyId = decodedId.getCurrencyId();
    token.maturity = decodedId.getMaturity();
    token.vaultAddress = decodedId.getVaultAddress();
    token.isfCashDebt = decodedId.getIsfCashDebt();
    _setAssetType(decodedId, token);

    // Initialize this at zero
    token.totalSupply = BigInt.zero();
    token.decimals = INTERNAL_TOKEN_DECIMALS;
    token.precision = INTERNAL_TOKEN_PRECISION;
    token.tokenAddress = notional._address;
    token.hasTransferFee = false;

    token.lastUpdateBlockNumber = block.number;
    token.lastUpdateTimestamp = block.timestamp.toI32();
    token.lastUpdateTransactionHash = txnHash;

    token.firstUpdateBlockNumber = block.number;
    token.firstUpdateTimestamp = block.timestamp.toI32();
    token.firstUpdateTransactionHash = txnHash;

    token.save();
  }

  return token as Token;
}
