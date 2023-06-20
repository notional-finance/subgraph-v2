import { Address, BigInt } from "@graphprotocol/graph-ts";

export const ZERO_ADDRESS = Address.zero();
export const FEE_RESERVE = Address.fromHexString("0x0000000000000000000000000000000000000FEE");
export const SETTLEMENT_RESERVE = Address.fromHexString(
  "0x00000000000000000000000000000000000005e7"
);
// TODO: temporary fix until we can run a full resync
// export const PRIME_CASH_VAULT_MATURITY = 2 ** 40 - 1;
export const PRIME_CASH_VAULT_MATURITY_BIGINT = BigInt.fromI32(2)
  .pow(40)
  .minus(BigInt.fromI32(1));
export const PRIME_CASH_VAULT_MATURITY = -1;
export const INTERNAL_TOKEN_DECIMALS = 8;
export const INTERNAL_TOKEN_PRECISION = BigInt.fromI32(10).pow(8);
export const USD_ASSET_ID = "0";
export const ETH_CURRENCY_ID = 1 as i32;
export const ORACLE_REGISTRY_ID = "0";
export const RATE_DECIMALS = 9;
export const RATE_PRECISION = BigInt.fromI32(10).pow(9);
export const BASIS_POINT = 1e5 as i32;
export const SCALAR_DECIMALS = 18;
export const SCALAR_PRECISION = BigInt.fromI32(10).pow(18);
export const DOUBLE_SCALAR_DECIMALS = 36;
export const DOUBLE_SCALAR_PRECISION = BigInt.fromI32(10).pow(36);

export const SECONDS_IN_YEAR = BigInt.fromI32(360 * 86400);

// Refresh the oracle six hours
export const ORACLE_REFRESH_SECONDS = 21600;

export const FCASH_ASSET_TYPE_ID = BigInt.fromI32(1);
export const VAULT_SHARE_ASSET_TYPE_ID = BigInt.fromI32(9);
export const VAULT_DEBT_ASSET_TYPE_ID = BigInt.fromI32(10);
export const VAULT_CASH_ASSET_TYPE_ID = BigInt.fromI32(11);
export const LEGACY_NTOKEN_ASSET_TYPE_ID = BigInt.fromI32(12);

// Enum Values as Constants

// Token Type
export const Underlying = "Underlying";
export const nToken = "nToken";
export const PrimeCash = "PrimeCash";
export const PrimeDebt = "PrimeDebt";
export const fCash = "fCash";
export const VaultShare = "VaultShare";
export const VaultDebt = "VaultDebt";
export const VaultCash = "VaultCash";
export const NOTE = "NOTE";

// System Account
export const None = "None";
export const ZeroAddress = "ZeroAddress";
export const FeeReserve = "FeeReserve";
export const SettlementReserve = "SettlementReserve";
// export const nToken = 'nToken'; NOTE: duplicated above
export const Vault = "Vault";
export const Notional = "Notional";

// Transfer Type
export const Mint = "Mint";
export const Burn = "Burn";
export const Transfer = "Transfer";

// Oracle Type
export const Chainlink = "Chainlink";
export const fCashOracleRate = "fCashOracleRate";
export const fCashToUnderlyingExchangeRate = "fCashToUnderlyingExchangeRate";
export const fCashSpotRate = "fCashSpotRate";
export const fCashSettlementRate = "fCashSettlementRate";
export const PrimeCashToUnderlyingOracleInterestRate = "PrimeCashToUnderlyingOracleInterestRate";
export const MoneyMarketToUnderlyingOracleInterestRate =
  "MoneyMarketToUnderlyingOracleInterestRate";
export const PrimeCashToUnderlyingExchangeRate = "PrimeCashToUnderlyingExchangeRate";
export const PrimeCashToMoneyMarketExchangeRate = "PrimeCashToMoneyMarketExchangeRate";
export const PrimeDebtToUnderlyingExchangeRate = "PrimeDebtToUnderlyingExchangeRate";
export const PrimeDebtToMoneyMarketExchangeRate = "PrimeDebtToMoneyMarketExchangeRate";
export const MoneyMarketToUnderlyingExchangeRate = "MoneyMarketToUnderlyingExchangeRate";
export const VaultShareOracleRate = "VaultShareOracleRate";
export const nTokenToUnderlyingExchangeRate = "nTokenToUnderlyingExchangeRate";

// Whitelisted Capability
export const GlobalTransferOperator = "GlobalTransferOperator";
export const AuthorizedCallbackContract = "AuthorizedCallbackContract";
