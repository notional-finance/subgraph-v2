import { Address, BigInt } from "@graphprotocol/graph-ts";

export const ZERO_ADDRESS = Address.zero()
export const FEE_RESERVE = Address.fromHexString("0x0000000000000000000000000000000000000FEE");
export const SETTLEMENT_RESERVE = Address.fromHexString("0x00000000000000000000000000000000000005e7");
export const PRIME_CASH_VAULT_MATURITY = 2 ** 40 - 1
export const INTERNAL_TOKEN_PRECISION = BigInt.fromI32(10).pow(8);

// Enum Values as Constants

// Asset Type
export const nToken = 'nToken'
export const PrimeCash = 'PrimeCash'
export const PrimeDebt = 'PrimeDebt'
export const fCash = 'fCash'
export const VaultShare = 'VaultShare'
export const VaultDebt = 'VaultDebt'
export const VaultCash = 'VaultCash'
export const NOTE = 'NOTE'

// System Account
export const None = 'None';
export const ZeroAddress = 'ZeroAddress';
export const FeeReserve = 'FeeReserve';
export const SettlementReserve = 'SettlementReserve';
// export const nToken = 'nToken'; NOTE: duplicated above
export const Vault = 'Vault';
export const Notional = 'Notional';


// Transfer Type
export const Mint = 'Mint'
export const Burn = 'Burn'
export const Transfer = 'Transfer'