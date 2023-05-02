import { ethereum, BigInt, Bytes, Address, log } from "@graphprotocol/graph-ts";
import {
  PrimeCashInterestAccrued,
  UpdateETHRate,
  VaultUpdated,
  SetPrimeSettlementRate,
  DeployNToken,
  CurrencyRebalanced,
} from "../generated/ExchangeRates/Notional";
import { IStrategyVault } from "../generated/ExchangeRates/IStrategyVault";
import { Aggregator } from "../generated/ExchangeRates/Aggregator";
import { Asset, ExchangeRate, Oracle } from "../generated/schema";
import {
  Chainlink,
  DOUBLE_SCALAR_PRECISION,
  fCashOracleRate,
  fCashSettlementRate,
  FCASH_ASSET_TYPE_ID,
  INTERNAL_TOKEN_PRECISION,
  MoneyMarketToUnderlyingExchangeRate,
  MoneyMarketToUnderlyingOracleInterestRate,
  ORACLE_REFRESH_SECONDS,
  PrimeCashToMoneyMarketExchangeRate,
  PrimeCashToUnderlyingExchangeRate,
  PrimeCashToUnderlyingOracleInterestRate,
  PrimeDebtToMoneyMarketExchangeRate,
  PrimeDebtToUnderlyingExchangeRate,
  RATE_PRECISION,
  SCALAR_PRECISION,
  VaultShareOracleRate,
  VAULT_SHARE_ASSET_TYPE_ID,
  ZERO_ADDRESS,
} from "./common/constants";
import {
  getAsset,
  getNotional,
  getOracle,
  getOracleRegistry,
  getUnderlying,
} from "./common/entities";
import { getOrCreateERC1155Asset } from "./common/erc1155";

function updateExchangeRate(
  oracle: Oracle,
  rate: BigInt,
  block: ethereum.Block,
  txnHash: Bytes | null
): void {
  let hashString = txnHash ? txnHash.toHexString() : "0x";
  let id = oracle.id + ":" + block.number.toString() + ":" + hashString;
  let exchangeRate = new ExchangeRate(id);
  exchangeRate.blockNumber = block.number.toI32();
  exchangeRate.timestamp = block.timestamp.toI32();
  exchangeRate.rate = rate;
  exchangeRate.oracle = oracle.id;
  exchangeRate.save();

  oracle.latestRate = rate;
  oracle.lastUpdateBlockNumber = block.number.toI32();
  oracle.lastUpdateTimestamp = block.timestamp.toI32();
  oracle.lastUpdateTransactionHash = txnHash;
  oracle.save();
}

/**** ORACLE UPDATES *******/
export function updateChainlinkOracle(oracle: Oracle, block: ethereum.Block): void {
  let aggregator = Aggregator.bind(Address.fromBytes(oracle.oracleAddress));
  let latestRate = aggregator.try_latestAnswer();
  if (!latestRate.reverted) {
    let rate = oracle.mustInvert
      ? oracle.ratePrecision.times(oracle.ratePrecision).div(latestRate.value)
      : latestRate.value;

    updateExchangeRate(oracle, rate, block, null);
  }
}

export function updateVaultOracles(vaultAddress: Address, block: ethereum.Block): void {
  let notional = getNotional();
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let vault = IStrategyVault.bind(vaultAddress);
  let base = getUnderlying(vaultConfig.borrowCurrencyId);

  let activeMarkets = notional.try_getActiveMarkets(vaultConfig.borrowCurrencyId);
  if (activeMarkets.reverted) return;

  for (let i = 0; i < activeMarkets.value.length; i++) {
    if (i + 1 <= vaultConfig.maxBorrowMarketIndex.toI32()) {
      let a = activeMarkets.value[i];
      let shareValue = vault.try_convertStrategyToUnderlying(
        vaultAddress,
        INTERNAL_TOKEN_PRECISION,
        a.maturity
      );
      if (shareValue.reverted) return;

      let vaultShareId = notional.encode(
        vaultConfig.borrowCurrencyId,
        a.maturity,
        VAULT_SHARE_ASSET_TYPE_ID,
        vaultAddress,
        false
      ) as BigInt;
      let vaultShareAsset = getOrCreateERC1155Asset(vaultShareId, block, null);
      let oracle = getOracle(base, vaultShareAsset, VaultShareOracleRate);
      // These will never change but set them here just in case
      oracle.ratePrecision = base.precision;
      oracle.oracleAddress = vaultAddress;

      updateExchangeRate(oracle, shareValue.value, block, null);
    }
  }
}

export function updatefCashOracles(underlyingId: string, block: ethereum.Block): void {
  let notional = getNotional();
  let base = getAsset(underlyingId);
  let currencyId = base.currencyId;
  let activeMarkets = notional.try_getActiveMarkets(currencyId);
  if (activeMarkets.reverted) return;

  for (let i = 0; i < activeMarkets.value.length; i++) {
    let a = activeMarkets.value[i];
    let positivefCashId = notional.encode(
      currencyId,
      a.maturity,
      FCASH_ASSET_TYPE_ID,
      ZERO_ADDRESS,
      false
    ) as BigInt;
    let posFCash = getOrCreateERC1155Asset(positivefCashId, block, null);
    let posOracle = getOracle(base, posFCash, fCashOracleRate);
    posOracle.ratePrecision = RATE_PRECISION;
    posOracle.oracleAddress = notional._address;
    updateExchangeRate(posOracle, a.oracleRate, block, null);

    let negativefCashId = notional.encode(
      currencyId,
      a.maturity,
      FCASH_ASSET_TYPE_ID,
      ZERO_ADDRESS,
      true
    ) as BigInt;
    let negFCash = getOrCreateERC1155Asset(negativefCashId, block, null);
    let negOracle = getOracle(base, negFCash, fCashOracleRate);
    negOracle.ratePrecision = RATE_PRECISION;
    negOracle.oracleAddress = notional._address;
    updateExchangeRate(negOracle, a.oracleRate, block, null);
  }
}

export function registerChainlinkOracle(
  baseAsset: Asset,
  quoteAsset: Asset,
  oracleAddress: Address,
  mustInvert: boolean,
  event: ethereum.Event
): void {
  let oracle = getOracle(baseAsset, quoteAsset, Chainlink);
  oracle.oracleAddress = oracleAddress;
  oracle.mustInvert = mustInvert;
  oracle.lastUpdateBlockNumber = event.block.number.toI32();
  oracle.lastUpdateTimestamp = event.block.timestamp.toI32();
  oracle.lastUpdateTransactionHash = event.transaction.hash;

  if (oracleAddress == ZERO_ADDRESS) {
    // Set the ETH rate oracle just once to its own hardcoded rate of 1
    oracle.ratePrecision = BigInt.fromI32(10).pow(18);
    oracle.latestRate = oracle.ratePrecision;
    oracle.save();
  } else {
    let _oracle = Aggregator.bind(oracleAddress);
    let decimals = _oracle.decimals();
    oracle.ratePrecision = BigInt.fromI32(10).pow(decimals as u8);

    // Will call oracle.save inside
    updateChainlinkOracle(oracle, event.block);
  }

  let registry = getOracleRegistry();
  let chainlinkOracles = registry.chainlinkOracles;
  if (!chainlinkOracles.includes(oracle.id)) {
    chainlinkOracles.push(oracle.id);
    registry.chainlinkOracles = chainlinkOracles;
    registry.save();
  }
}

/**** EVENT HANDLERS *******/

export function handleUpdateETHRate(event: UpdateETHRate): void {
  let notional = getNotional();
  let results = notional.getCurrency(event.params.currencyId);
  let quoteId = results.getUnderlyingToken().tokenAddress.toHexString();
  let quoteAsset = getAsset(quoteId);
  let ethBaseAsset = getAsset(Address.zero().toHexString());
  let rateStorage = notional.getRateStorage(event.params.currencyId);
  let ethRate = rateStorage.getEthRate();

  registerChainlinkOracle(ethBaseAsset, quoteAsset, ethRate.rateOracle, ethRate.mustInvert, event);
}

export function handleVaultListing(event: VaultUpdated): void {
  let vaultAddress = event.params.vault;
  let registry = getOracleRegistry();
  let listedVaults = registry.listedVaults;

  if (!listedVaults.includes(vaultAddress)) {
    // Add the vault if it is not listed already
    listedVaults.push(vaultAddress);
    registry.listedVaults = listedVaults;
    registry.save();
  }
}

export function handlefCashEnabled(event: DeployNToken): void {
  let base = getUnderlying(event.params.currencyId);
  let registry = getOracleRegistry();
  let fCashEnabled = registry.fCashEnabled;
  if (!fCashEnabled.includes(base.id)) {
    fCashEnabled.push(base.id);
    registry.fCashEnabled = fCashEnabled;
    registry.save();
  }
}

export function handlePrimeCashAccrued(event: PrimeCashInterestAccrued): void {
  let notional = getNotional();
  let base = getUnderlying(event.params.currencyId);
  let pCashAddress = notional.pCashAddress(event.params.currencyId);
  let pCashAsset = getAsset(pCashAddress.toHexString());
  let factors = notional.getPrimeFactorsStored(event.params.currencyId);

  // Supply Scalar * Underlying Scalar
  let pCashExchangeRate = getOracle(base, pCashAsset, PrimeCashToUnderlyingExchangeRate);
  pCashExchangeRate.ratePrecision = DOUBLE_SCALAR_PRECISION;
  pCashExchangeRate.oracleAddress = notional._address;
  updateExchangeRate(
    pCashExchangeRate,
    factors.supplyScalar.times(factors.underlyingScalar),
    event.block,
    event.transaction.hash
  );

  // Supply Scalar
  let pCashMoneyMarketExchangeRate = getOracle(
    base,
    pCashAsset,
    PrimeCashToMoneyMarketExchangeRate
  );
  pCashMoneyMarketExchangeRate.ratePrecision = SCALAR_PRECISION;
  pCashMoneyMarketExchangeRate.oracleAddress = notional._address;
  updateExchangeRate(
    pCashMoneyMarketExchangeRate,
    factors.supplyScalar,
    event.block,
    event.transaction.hash
  );

  // Underlying Scalar
  let moneyMarketExchangeRate = getOracle(base, pCashAsset, MoneyMarketToUnderlyingExchangeRate);
  moneyMarketExchangeRate.ratePrecision = SCALAR_PRECISION;
  moneyMarketExchangeRate.oracleAddress = notional._address;
  updateExchangeRate(
    moneyMarketExchangeRate,
    factors.underlyingScalar,
    event.block,
    event.transaction.hash
  );

  // Oracle Rate
  let pCashSupplyRate = getOracle(base, pCashAsset, PrimeCashToUnderlyingOracleInterestRate);
  pCashSupplyRate.ratePrecision = RATE_PRECISION;
  pCashSupplyRate.oracleAddress = notional._address;
  updateExchangeRate(
    pCashSupplyRate,
    factors.oracleSupplyRate,
    event.block,
    event.transaction.hash
  );

  let pDebtAddress = notional.pDebtAddress(event.params.currencyId);
  if (pDebtAddress != ZERO_ADDRESS) {
    let pDebtAsset = getAsset(pDebtAddress.toHexString());

    // Debt Scalar * Underlying Scalar
    let pDebtExchangeRate = getOracle(base, pDebtAsset, PrimeDebtToUnderlyingExchangeRate);
    pDebtExchangeRate.ratePrecision = DOUBLE_SCALAR_PRECISION;
    pDebtExchangeRate.oracleAddress = notional._address;
    updateExchangeRate(
      pDebtExchangeRate,
      factors.debtScalar.times(factors.underlyingScalar),
      event.block,
      event.transaction.hash
    );

    // Debt Scalar
    let pDebtMoneyMarketExchangeRate = getOracle(
      base,
      pDebtAsset,
      PrimeDebtToMoneyMarketExchangeRate
    );
    pDebtMoneyMarketExchangeRate.ratePrecision = SCALAR_PRECISION;
    pDebtMoneyMarketExchangeRate.oracleAddress = notional._address;
    updateExchangeRate(
      pDebtMoneyMarketExchangeRate,
      factors.debtScalar,
      event.block,
      event.transaction.hash
    );
  }
}

export function handleRebalance(event: CurrencyRebalanced): void {
  let notional = getNotional();
  let base = getUnderlying(event.params.currencyId);
  let pCashAddress = notional.pCashAddress(event.params.currencyId);
  let pCashAsset = getAsset(pCashAddress.toHexString());

  // Money Market Oracle Rate
  let moneyMarketSupplyRate = getOracle(
    base,
    pCashAsset,
    MoneyMarketToUnderlyingOracleInterestRate
  );
  moneyMarketSupplyRate.ratePrecision = RATE_PRECISION;
  moneyMarketSupplyRate.oracleAddress = notional._address;
  updateExchangeRate(
    moneyMarketSupplyRate,
    event.params.annualizedInterestRate,
    event.block,
    event.transaction.hash
  );
}

export function handleSettlementRate(event: SetPrimeSettlementRate): void {
  // Asset is positive and negative fCash to prime cash
  let notional = getNotional();

  // This is the conversion for positive fCash to positive prime cash
  let pCashAddress = notional.pCashAddress(event.params.currencyId.toI32());
  let pCash = getAsset(pCashAddress.toHexString());
  let positivefCashId = notional.encode(
    event.params.currencyId.toI32(),
    event.params.maturity,
    FCASH_ASSET_TYPE_ID,
    ZERO_ADDRESS,
    false
  ) as BigInt;

  let positivefCash = getOrCreateERC1155Asset(positivefCashId, event.block, event.transaction.hash);

  let posOracle = getOracle(pCash, positivefCash, fCashSettlementRate);
  posOracle.oracleAddress == notional._address;
  posOracle.ratePrecision = DOUBLE_SCALAR_PRECISION;
  posOracle.latestRate = event.params.supplyFactor;
  posOracle.lastUpdateBlockNumber = event.block.number.toI32();
  posOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
  posOracle.lastUpdateTransactionHash = event.transaction.hash;
  posOracle.save();

  let base = getUnderlying(event.params.currencyId.toI32());
  let fCashOracle = getOracle(base, positivefCash, fCashSettlementRate);
  // No need to create a new exchange rate object here, just set the latest rate to
  // zero since the fCash has matured
  fCashOracle.latestRate = BigInt.fromI32(0);
  fCashOracle.lastUpdateBlockNumber = event.block.number.toI32();
  fCashOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
  fCashOracle.lastUpdateTransactionHash = event.transaction.hash;
  fCashOracle.save();

  // This is the conversion for negative fCash to negative prime debt
  let pDebtAddress = notional.pDebtAddress(event.params.currencyId.toI32());
  if (pDebtAddress != ZERO_ADDRESS) {
    let pDebt = getAsset(pDebtAddress.toHexString());
    let negativefCashId = notional.encode(
      event.params.currencyId.toI32(),
      event.params.maturity,
      FCASH_ASSET_TYPE_ID,
      ZERO_ADDRESS,
      true
    ) as BigInt;

    let negativefCash = getOrCreateERC1155Asset(
      negativefCashId,
      event.block,
      event.transaction.hash
    );
    let negOracle = getOracle(pDebt, negativefCash, fCashSettlementRate);
    negOracle.oracleAddress = notional._address;
    negOracle.ratePrecision = DOUBLE_SCALAR_PRECISION;
    negOracle.latestRate = event.params.debtFactor;
    negOracle.lastUpdateBlockNumber = event.block.number.toI32();
    negOracle.lastUpdateTimestamp = event.block.timestamp.toI32();
    negOracle.lastUpdateTransactionHash = event.transaction.hash;
    negOracle.save();
  }
}

/***** BLOCK HANDLER *********/

export function handleBlockOracleUpdate(block: ethereum.Block): void {
  let registry = getOracleRegistry();
  if (block.timestamp.toI32() - registry.lastRefreshTimestamp < ORACLE_REFRESH_SECONDS) return;
  registry.lastRefreshBlockNumber = block.number.toI32();
  registry.lastRefreshTimestamp = block.timestamp.toI32();
  registry.save();

  // Aggregate the same oracle types with each other.
  for (let i = 0; i < registry.chainlinkOracles.length; i++) {
    let oracle = Oracle.load(registry.chainlinkOracles[i]) as Oracle;
    updateChainlinkOracle(oracle, block);
  }

  for (let i = 0; i < registry.listedVaults.length; i++) {
    updateVaultOracles(Address.fromBytes(registry.listedVaults[i]), block);
  }

  for (let i = 0; i < registry.fCashEnabled.length; i++) {
    updatefCashOracles(registry.fCashEnabled[i], block);
  }
}
