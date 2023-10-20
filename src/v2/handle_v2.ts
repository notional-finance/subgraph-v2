import { BigInt, dataSource } from "@graphprotocol/graph-ts";
import {
  FCASH_ASSET_TYPE_ID,
  RATE_DECIMALS,
  RATE_PRECISION,
  SCALAR_DECIMALS,
  SCALAR_PRECISION,
  fCashOracleRate,
  fCashSettlementRate,
  fCashSpotRate,
  fCashToUnderlyingExchangeRate,
} from "../common/constants";
import {
  getAsset,
  getIncentives,
  getNotionalV2,
  getOracle,
  getUnderlying,
} from "../common/entities";
import { convertToNegativeFCashId, getOrCreateERC1155Asset } from "../common/erc1155";
import {
  AccountSettled,
  CashBalanceChange,
  IncentivesMigrated,
  LendBorrowTrade,
  LiquidateCollateralCurrency,
  LiquidateLocalCurrency,
  LiquidatefCashEvent,
  ReserveBalanceUpdated,
  ReserveFeeAccrued,
  SetSettlementRate,
  SettledCashDebt,
  nTokenResidualPurchase,
  nTokenSupplyChange,
} from "../../generated/Assets/NotionalV2";

export function handleV2SettlementRate(event: SetSettlementRate): void {
  let notional = getNotionalV2();
  let positivefCashId = notional.encodeToId(
    event.params.currencyId.toI32(),
    event.params.maturity,
    FCASH_ASSET_TYPE_ID.toI32()
  );
  let currency = notional.getCurrency(event.params.currencyId.toI32());
  let assetCash = getAsset(currency.getAssetToken().tokenAddress.toHexString());

  let positivefCash = getOrCreateERC1155Asset(positivefCashId, event.block, event.transaction.hash);
  let negativefCashId = convertToNegativeFCashId(positivefCashId);
  let negativefCash = getOrCreateERC1155Asset(negativefCashId, event.block, event.transaction.hash);

  let posOracle = getOracle(positivefCash, assetCash, fCashSettlementRate);
  posOracle.oracleAddress = notional._address;
  // TODO: what precision are these oracle rates?
  posOracle.decimals = SCALAR_DECIMALS;
  posOracle.ratePrecision = SCALAR_PRECISION;
  posOracle.latestRate = event.params.rate;
  posOracle.lastUpdateBlockNumber = event.block.number;
  posOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
  posOracle.lastUpdateTransaction = event.transaction.hash.toHexString();
  posOracle.save();

  let base = getUnderlying(event.params.currencyId.toI32());
  {
    let fCashExRate = getOracle(base, positivefCash, fCashToUnderlyingExchangeRate);
    fCashExRate.oracleAddress = notional._address;
    fCashExRate.decimals = RATE_DECIMALS;
    fCashExRate.ratePrecision = RATE_PRECISION;
    fCashExRate.latestRate = RATE_PRECISION;
    fCashExRate.lastUpdateBlockNumber = event.block.number;
    fCashExRate.lastUpdateTimestamp = event.block.timestamp.toI32();
    fCashExRate.lastUpdateTransaction = event.transaction.hash.toHexString();
    fCashExRate.matured = true;
    fCashExRate.save();
  }

  {
    let fCashOracle = getOracle(base, positivefCash, fCashOracleRate);
    fCashOracle.oracleAddress = notional._address;
    fCashOracle.decimals = RATE_DECIMALS;
    fCashOracle.ratePrecision = RATE_PRECISION;
    // Oracle interest rate is now zero
    fCashOracle.latestRate = BigInt.fromI32(0);
    fCashOracle.lastUpdateBlockNumber = event.block.number;
    fCashOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
    fCashOracle.lastUpdateTransaction = event.transaction.hash.toHexString();
    fCashOracle.matured = true;
    fCashOracle.save();
  }

  // Spot interest rate is also zero, same as oracle interest rate
  {
    let fCashSpot = getOracle(base, positivefCash, fCashSpotRate);
    fCashSpot.oracleAddress = notional._address;
    fCashSpot.decimals = RATE_DECIMALS;
    fCashSpot.ratePrecision = RATE_PRECISION;
    fCashSpot.latestRate = BigInt.fromI32(0);
    fCashSpot.lastUpdateBlockNumber = event.block.number;
    fCashSpot.lastUpdateTimestamp = event.block.timestamp.toI32();
    fCashSpot.lastUpdateTransaction = event.transaction.hash.toHexString();
    fCashSpot.matured = true;
    fCashSpot.save();
  }

  {
    let negOracle = getOracle(negativefCash, assetCash, fCashSettlementRate);
    negOracle.oracleAddress = notional._address;
    // TODO: what precision are these oracle rates?
    negOracle.decimals = SCALAR_DECIMALS;
    negOracle.ratePrecision = SCALAR_PRECISION;
    negOracle.latestRate = event.params.rate;
    negOracle.lastUpdateBlockNumber = event.block.number;
    negOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
    negOracle.lastUpdateTransaction = event.transaction.hash.toHexString();
    negOracle.save();
  }

  {
    let fCashExRate = getOracle(base, negativefCash, fCashToUnderlyingExchangeRate);
    fCashExRate.oracleAddress = notional._address;
    fCashExRate.decimals = RATE_DECIMALS;
    fCashExRate.ratePrecision = RATE_PRECISION;
    fCashExRate.latestRate = RATE_PRECISION;
    fCashExRate.lastUpdateBlockNumber = event.block.number;
    fCashExRate.lastUpdateTimestamp = event.block.timestamp.toI32();
    fCashExRate.lastUpdateTransaction = event.transaction.hash.toHexString();
    fCashExRate.matured = true;
    fCashExRate.save();
  }
}

export function handleIncentivesMigrated(event: IncentivesMigrated): void {
  let currencyId = event.params.currencyId as i32;
  let migration = getIncentives(currencyId, event);
  migration.migrationEmissionRate = event.params.migrationEmissionRate;
  migration.migrationTime = event.params.migrationTime;
  migration.finalIntegralTotalSupply = event.params.finalIntegralTotalSupply;
  migration.save();

  let context = dataSource.context();
  context.setBoolean("incentivesMigrated", true);
}

export function handleReserveBalanceUpdated(event: ReserveBalanceUpdated): void {
  // burn asset cash from reserve
}
// export function handleReserveFeeAccrued(event: ReserveFeeAccrued): void {
//   // transfer fee to ntoken?
// }
export function handleAccountSettled(event: AccountSettled): void {}
export function handleLendBorrowTrade(event: LendBorrowTrade): void {}
export function handleSettledCashDebt(event: SettledCashDebt): void {}
export function handleNTokenSupplyChange(event: nTokenSupplyChange): void {}
export function handleNTokenResidualPurchase(event: nTokenResidualPurchase): void {}
export function handleLiquidateLocalCurrency(event: LiquidateLocalCurrency): void {}
export function handleLiquidateCollateralCurrency(event: LiquidateCollateralCurrency): void {}
export function handleLiquidatefCashEvent(event: LiquidatefCashEvent): void {}
export function handleCashBalanceChange(event: CashBalanceChange): void {}
