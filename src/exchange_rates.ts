import { ethereum } from "@graphprotocol/graph-ts";
import { PrimeCashInterestAccrued } from "../generated/Governance/Notional";

export function handleBlockOracleUpdate(event: ethereum.Block) {
  // Update:
  //    Chainlink
  //    fCashOracleRate
  //    VaultShareOracleRate
  //    PrimeCashToUnderlyingOracleSupplyRate
  //    PrimeCashToMoneyMarketOracleSupplyRate

}

export function registerETHOracle() {

}

export function registerVaultShareOracle() {

}

export function updatefCashSpotRate() {

}

export function handlePrimeCashAccrued(event: PrimeCashInterestAccrued) {

}

export function handleSettlementRate() {
  // Asset is positive and negative fCash to prime cash

}