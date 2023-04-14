import { Address } from "@graphprotocol/graph-ts";

export const ZERO_ADDRESS = Address.zero()
export const FEE_RESERVE = Address.fromHexString("0x0000000000000000000000000000000000000FEE");
export const SETTLEMENT_RESERVE = Address.fromHexString("0x00000000000000000000000000000000000005e7");

// Enum Values as Constants

// Asset Type
export const nToken = 'nToken'
export const PrimeCash = 'PrimeCash'
export const PrimeDebt = 'PrimeDebt'
export const PositivefCash = 'PositivefCash'
export const NegativefCash = 'NegativefCash'
export const VaultShare = 'VaultShare'
export const VaultDebt = 'VaultDebt'
export const VaultCash = 'VaultCash'

// System Account
export const None = 'None';
export const ZeroAddress = 'ZeroAddress';
export const FeeReserve = 'FeeReserve';
export const SettlementReserve = 'SettlementReserve';
// export const nToken = 'nToken'; NOTE: duplicated above
export const Vault = 'Vault';


// Transfer Type
export const Mint = 'Mint'
export const Burn = 'Burn'
export const Transfer = 'Transfer'