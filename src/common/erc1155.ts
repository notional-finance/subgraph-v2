import { ethereum, BigInt } from "@graphprotocol/graph-ts";
import { Notional, Notional__decodeERC1155IdResult } from "../../generated/Governance/Notional";
import { Asset } from "../../generated/schema";
import { fCash, INTERNAL_TOKEN_PRECISION, PRIME_CASH_VAULT_MATURITY, VaultCash, VaultDebt, VaultShare } from "./constants";
import { getAsset } from "./entities";

const FCASH_ASSET_TYPE = 1
const VAULT_SHARE_ASSET_TYPE = 9
const VAULT_DEBT_ASSET_TYPE = 10
const VAULT_CASH_ASSET_TYPE = 111

function _setAssetType(decodedId: Notional__decodeERC1155IdResult, asset: Asset): void {
  let assetType = decodedId.getAssetType().toI32()
  let maturity = decodedId.getMaturity().toString()
  let underlying = getAsset(decodedId.getCurrencyId().toString())
  let underlyingSymbol = underlying.symbol;

  if (assetType == FCASH_ASSET_TYPE) {
    asset.assetType = fCash;
    if (decodedId.getIsfCashDebt()) {
      asset.name = "f" + underlyingSymbol + " debt maturing " + maturity
      asset.symbol = "-f" + underlyingSymbol + ":fixed@" + maturity
    } else {
      asset.name = "f" + underlyingSymbol + " maturing " + maturity
      asset.symbol = "f" + underlyingSymbol + ":fixed@" + maturity
    }
    return;
  }
  
  let vaultMaturityString = decodedId.getMaturity().toI32() == PRIME_CASH_VAULT_MATURITY ?
    " open term" : " fixed term @ " + maturity
  let vaultMaturitySymbol = decodedId.getMaturity().toI32() == PRIME_CASH_VAULT_MATURITY ?
    ":open" : ":fixed@" + maturity
  let vaultAddress = decodedId.getVaultAddress().toHexString()

  if (assetType == VAULT_SHARE_ASSET_TYPE) {
    asset.assetType == VaultShare;
    asset.name = "Vault Shares in " + underlyingSymbol + " for " + vaultAddress + vaultMaturityString 
    asset.symbol = "vs" + underlyingSymbol + ":" + vaultAddress + vaultMaturitySymbol
  } else if (assetType == VAULT_DEBT_ASSET_TYPE) {
    asset.assetType == VaultDebt;
    asset.name = "Vault " + underlyingSymbol + " Debt for " + vaultAddress + vaultMaturityString
    asset.symbol = "vd" + underlyingSymbol + ":" + vaultAddress + vaultMaturitySymbol
  } else if (assetType == VAULT_CASH_ASSET_TYPE) {
    asset.assetType == VaultCash;
    asset.name = "Vault " + underlyingSymbol + " Cash for " + vaultAddress + vaultMaturityString
    asset.symbol = "vc" + underlyingSymbol + ":" + vaultAddress + vaultMaturitySymbol
  }
}

export function getOrCreateERC1155Asset(erc1155ID: BigInt, event: ethereum.Event): Asset {
  let asset = Asset.load(erc1155ID.toString());
  if (asset == null) {
    let notional = Notional.bind(event.address)
    let decodedId = notional.decodeERC1155Id(erc1155ID)

    asset = new Asset(erc1155ID.toString());
    asset.assetInterface = 'ERC1155';
    asset.underlying = decodedId.getCurrencyId().toString();
    asset.maturity = decodedId.getMaturity().toI32();
    asset.vaultAddress = decodedId.getVaultAddress();
    asset.isfCashDebt = decodedId.getIsfCashDebt();
    _setAssetType(decodedId, asset);

    // Initialize this at zero
    asset.totalSupply = BigInt.zero();
    asset.precision = INTERNAL_TOKEN_PRECISION;
    asset.tokenAddress = event.address;
    asset.hasTransferFee = false;
    
    asset.lastUpdateBlockNumber = event.block.number.toI32();
    asset.lastUpdateTimestamp = event.block.timestamp.toI32();
    asset.lastUpdateTransactionHash = event.transaction.hash;

    asset.firstUpdateBlockNumber = event.block.number.toI32();
    asset.firstUpdateTimestamp = event.block.timestamp.toI32();
    asset.firstUpdateTransactionHash = event.transaction.hash;

    asset.save();
  }

  return asset as Asset
}