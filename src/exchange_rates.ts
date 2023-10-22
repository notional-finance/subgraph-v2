import { ethereum, BigInt, Address } from "@graphprotocol/graph-ts";
import {
  PrimeCashInterestAccrued,
  UpdateETHRate,
  VaultUpdated,
  SetPrimeSettlementRate,
  DeployNToken,
  CurrencyRebalanced,
} from "../generated/ExchangeRates/NotionalV3";
import { IStrategyVault } from "../generated/ExchangeRates/IStrategyVault";
import { Aggregator } from "../generated/ExchangeRates/Aggregator";
import { AssetRateAggregator } from "../generated/ExchangeRates/AssetRateAggregator";
import { Token, ExchangeRate, Oracle } from "../generated/schema";
import {
  Chainlink,
  DOUBLE_SCALAR_DECIMALS,
  DOUBLE_SCALAR_PRECISION,
  fCashOracleRate,
  fCashSettlementRate,
  fCashSpotRate,
  fCashToUnderlyingExchangeRate,
  FCASH_ASSET_TYPE_ID,
  INTERNAL_TOKEN_PRECISION,
  MoneyMarketToUnderlyingExchangeRate,
  nTokenToUnderlyingExchangeRate,
  PrimeCashToMoneyMarketExchangeRate,
  PrimeCashToUnderlyingExchangeRate,
  PrimeCashToUnderlyingOracleInterestRate,
  PrimeDebtToMoneyMarketExchangeRate,
  PrimeDebtToUnderlyingExchangeRate,
  RATE_DECIMALS,
  RATE_PRECISION,
  SCALAR_DECIMALS,
  SCALAR_PRECISION,
  VaultShareOracleRate,
  VAULT_SHARE_ASSET_TYPE_ID,
  ZERO_ADDRESS,
  PrimeDebtPremiumInterestRate,
  PrimeCashPremiumInterestRate,
  PrimeCashExternalLendingInterestRate,
  PRIME_CASH_VAULT_MATURITY,
  nTokenBlendedInterestRate,
  nTokenFeeRate,
  nTokenIncentiveRate,
} from "./common/constants";
import {
  getAsset,
  getNotional,
  getOracle,
  getOracleRegistry,
  getUnderlying,
  isV2,
} from "./common/entities";
import { convertToNegativeFCashId, getOrCreateERC1155Asset } from "./common/erc1155";
import { updatefCashMarket } from "./common/market";
import { convertValueToUnderlying, getExpFactor } from "./common/transfers";
import { readUnderlyingTokenFromNotional } from "./assets";
import { getNTokenFeeBuffer } from "./balances";
import { getCurrencyConfiguration } from "./configuration";
import { NotionalV3__getNTokenAccountResult } from "../generated/Assets/NotionalV3";

function updateExchangeRate(
  oracle: Oracle,
  rate: BigInt,
  block: ethereum.Block,
  txnHash: string | null
): void {
  let hashString = txnHash ? txnHash : "0x";
  let id = oracle.id + ":" + block.number.toString() + ":" + hashString;
  let exchangeRate = new ExchangeRate(id);
  exchangeRate.blockNumber = block.number;
  exchangeRate.timestamp = block.timestamp.toI32();
  exchangeRate.rate = rate;
  exchangeRate.oracle = oracle.id;
  exchangeRate.transaction = txnHash;
  exchangeRate.save();

  oracle.latestRate = rate;
  oracle.lastUpdateBlockNumber = block.number;
  oracle.lastUpdateTimestamp = block.timestamp.toI32();
  oracle.lastUpdateTransaction = txnHash;
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

function updateVaultOracleMaturity(
  vaultAddress: Address,
  maturity: BigInt,
  base: Token,
  block: ethereum.Block
): void {
  let notional = getNotional();
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let vault = IStrategyVault.bind(vaultAddress);

  let shareValue = vault.try_convertStrategyToUnderlying(
    vaultAddress,
    INTERNAL_TOKEN_PRECISION,
    maturity
  );
  let value: BigInt;
  if (shareValue.reverted) {
    value = BigInt.fromI32(0);
  } else {
    value = shareValue.value;
  }

  let vaultShareId = notional.encode(
    vaultConfig.borrowCurrencyId,
    maturity,
    VAULT_SHARE_ASSET_TYPE_ID,
    vaultAddress,
    false
  ) as BigInt;
  let vaultShareAsset = getOrCreateERC1155Asset(vaultShareId, block, null);
  let oracle = getOracle(base, vaultShareAsset, VaultShareOracleRate);
  // These will never change but set them here just in case
  oracle.decimals = base.decimals;
  oracle.ratePrecision = base.precision;
  oracle.oracleAddress = vaultAddress;

  updateExchangeRate(oracle, value, block, null);
}

export function updateVaultOracles(vaultAddress: Address, block: ethereum.Block): void {
  if (isV2()) return;

  let notional = getNotional();
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let base = getUnderlying(vaultConfig.borrowCurrencyId);

  updateVaultOracleMaturity(vaultAddress, PRIME_CASH_VAULT_MATURITY, base, block);

  let activeMarkets = notional.try_getActiveMarkets(vaultConfig.borrowCurrencyId);
  if (activeMarkets.reverted) return;

  for (let i = 0; i < activeMarkets.value.length; i++) {
    if (i + 1 <= vaultConfig.maxBorrowMarketIndex.toI32()) {
      let a = activeMarkets.value[i];
      updateVaultOracleMaturity(vaultAddress, a.maturity, base, block);
    }
  }
}

function updatefCashExchangeRate(
  oracleName: string,
  rate: BigInt,
  base: Token,
  notional: Address,
  posFCash: Token,
  negFCash: Token,
  block: ethereum.Block,
  txnHash: string | null
): void {
  let p = getOracle(base, posFCash, oracleName);
  p.decimals = RATE_DECIMALS;
  p.ratePrecision = RATE_PRECISION;
  p.oracleAddress = notional;
  updateExchangeRate(p, rate, block, txnHash);

  let n = getOracle(base, negFCash, oracleName);
  n.decimals = RATE_DECIMALS;
  n.ratePrecision = RATE_PRECISION;
  n.oracleAddress = notional;
  updateExchangeRate(n, rate, block, txnHash);
}

export function updatefCashOraclesAndMarkets(
  underlyingId: string,
  block: ethereum.Block,
  txnHash: string | null
): void {
  let notional = getNotional();
  let base = getAsset(underlyingId);
  let currencyId = base.currencyId;
  let activeMarkets = notional.try_getActiveMarkets(currencyId);
  if (activeMarkets.reverted) return;

  let supplyRate: BigInt;
  let cashAsset: Token;
  if (isV2()) {
    let currency = notional.getCurrencyAndRates(currencyId);
    cashAsset = getAsset(currency.getAssetToken().tokenAddress.toHexString());
    let aggregator = AssetRateAggregator.bind(currency.getAssetRate().rateOracle);
    supplyRate = aggregator.getAnnualizedSupplyRate();
  } else {
    let interestRates = notional.try_getPrimeInterestRate(currencyId);
    let pCashAddress = notional.pCashAddress(currencyId);
    cashAsset = getAsset(pCashAddress.toHexString());
    supplyRate = interestRates.reverted ? BigInt.zero() : interestRates.value.getAnnualSupplyRate();
  }

  let nToken = getAsset(notional.nTokenAddress(currencyId).toHexString());
  let nTokenAccount = notional.getNTokenAccount(Address.fromBytes(nToken.tokenAddress));
  let nTokenCash = convertValueToUnderlying(
    nTokenAccount.getCashBalance(),
    cashAsset,
    block.timestamp
  );
  if (nTokenCash === null) nTokenCash = BigInt.zero();
  let nTokenBlendedInterestNumerator = nTokenCash.times(supplyRate);
  let nTokenBlendedInterestDenominator = nTokenCash;

  for (let i = 0; i < activeMarkets.value.length; i++) {
    let a = activeMarkets.value[i];
    let positivefCashId = notional.encodeToId(
      currencyId,
      a.maturity,
      FCASH_ASSET_TYPE_ID.toI32()
    ) as BigInt;
    let posFCash = getOrCreateERC1155Asset(positivefCashId, block, null);
    let negativefCashId = convertToNegativeFCashId(positivefCashId);
    let negFCash = getOrCreateERC1155Asset(negativefCashId, block, null);

    // prettier-ignore
    updatefCashExchangeRate(
      fCashOracleRate,
      a.oracleRate,
      base, notional._address, posFCash, negFCash, block, txnHash
    );

    // prettier-ignore
    updatefCashExchangeRate(
      fCashSpotRate,
      a.lastImpliedRate,
      base, notional._address, posFCash, negFCash, block, txnHash
    );

    let x: f64 = getExpFactor(a.lastImpliedRate, a.maturity.minus(block.timestamp));
    let exchangeRate = BigInt.fromI64(
      Math.floor(Math.exp(x) * (RATE_PRECISION.toI64() as f64)) as i64
    );
    // prettier-ignore
    updatefCashExchangeRate(
      fCashToUnderlyingExchangeRate,
      exchangeRate,
      base, notional._address, posFCash, negFCash, block, txnHash
    );

    // Takes a snapshot of the fCash market
    updatefCashMarket(currencyId, a.maturity.toI32(), block, txnHash);

    // Updates blended interest rate factors
    let fCashPV = convertValueToUnderlying(
      activeMarkets.value[i].totalfCash,
      posFCash,
      block.timestamp
    );

    let cashPV = convertValueToUnderlying(
      activeMarkets.value[i].totalPrimeCash,
      cashAsset,
      block.timestamp
    );

    if (fCashPV !== null && cashPV !== null) {
      nTokenBlendedInterestNumerator = nTokenBlendedInterestNumerator
        .plus(fCashPV.times(activeMarkets.value[i].oracleRate))
        .plus(cashPV.times(supplyRate));
      nTokenBlendedInterestDenominator = nTokenBlendedInterestDenominator
        .plus(fCashPV)
        .plus(cashPV);
    }
  }

  updateNTokenRates(
    currencyId,
    base,
    nToken,
    nTokenAccount,
    nTokenBlendedInterestNumerator,
    nTokenBlendedInterestDenominator,
    block,
    txnHash
  );
}

function updateNTokenRate(
  oracleName: string,
  rate: BigInt,
  base: Token,
  nToken: Token,
  notional: Address,
  block: ethereum.Block,
  txnHash: string | null
): void {
  let n = getOracle(base, nToken, oracleName);
  n.decimals = RATE_DECIMALS;
  n.ratePrecision = RATE_PRECISION;
  n.oracleAddress = notional;
  updateExchangeRate(n, rate, block, txnHash);
}

function updateNTokenRates(
  currencyId: i32,
  base: Token,
  nToken: Token,
  nTokenAccount: NotionalV3__getNTokenAccountResult,
  numerator: BigInt,
  denominator: BigInt,
  block: ethereum.Block,
  txnHash: string | null
): void {
  let notional = getNotional();
  let nTokenUnderlyingPV = notional.nTokenPresentValueUnderlyingDenominated(currencyId);
  let totalSupply = nTokenAccount.getTotalSupply();

  let nTokenExRate = totalSupply.isZero()
    ? BigInt.zero()
    : nTokenUnderlyingPV.times(RATE_PRECISION).div(totalSupply);
  // prettier-ignore
  updateNTokenRate(
    nTokenToUnderlyingExchangeRate,
    nTokenExRate,
    base, nToken, notional._address, block, txnHash
  );

  // NOTE: no need to multiply by rate precision since numerator is already rate * value
  let interestAPY = denominator.isZero() ? BigInt.zero() : numerator.div(denominator);
  // prettier-ignore
  updateNTokenRate(
    nTokenBlendedInterestRate,
    interestAPY,
    base, nToken, notional._address, block, txnHash
  );

  if (nTokenUnderlyingPV.gt(BigInt.zero())) {
    let feeBuffer = getNTokenFeeBuffer(currencyId);
    let underlying = getUnderlying(currencyId);
    // NOTE: last 30 day fees is in underlying external precision
    let feeAPY = feeBuffer.last30DayNTokenFees
      // NOTE: this sets the value on an annualized basis
      .times(BigInt.fromI32(12))
      .times(RATE_PRECISION)
      .div(nTokenUnderlyingPV.times(underlying.precision).div(INTERNAL_TOKEN_PRECISION));
    // prettier-ignore
    updateNTokenRate(
    nTokenFeeRate,
    feeAPY,
    base, nToken, notional._address, block, txnHash
  );

    // incentiveAPY needs a NOTE token price / nTokenTVL
    // noteToNTokenExRate * [(noteIncentives * RATE_PRECISION) / nTokenTVL]
    let config = getCurrencyConfiguration(currencyId);
    let noteAPYInNOTETerms = config.incentiveEmissionRate
      ? (config.incentiveEmissionRate as BigInt)
          .times(INTERNAL_TOKEN_PRECISION)
          .times(RATE_PRECISION)
          .div(nTokenUnderlyingPV)
      : BigInt.zero();
    // prettier-ignore
    updateNTokenRate(
    nTokenIncentiveRate,
    noteAPYInNOTETerms,
    base, nToken, notional._address, block, txnHash
  );
  }
}

export function registerChainlinkOracle(
  baseAsset: Token,
  quoteAsset: Token,
  oracleAddress: Address,
  mustInvert: boolean,
  event: ethereum.Event
): void {
  let oracle = getOracle(baseAsset, quoteAsset, Chainlink);
  oracle.oracleAddress = oracleAddress;
  oracle.mustInvert = mustInvert;
  oracle.lastUpdateBlockNumber = event.block.number;
  oracle.lastUpdateTimestamp = event.block.timestamp.toI32();
  oracle.lastUpdateTransaction = event.transaction.hash.toHexString();

  if (oracleAddress == ZERO_ADDRESS) {
    // Set the ETH rate oracle just once to its own hardcoded rate of 1
    oracle.decimals = 18;
    oracle.ratePrecision = BigInt.fromI32(10).pow(18);
    oracle.latestRate = oracle.ratePrecision;
    oracle.save();
  } else {
    let _oracle = Aggregator.bind(oracleAddress);
    let decimals = _oracle.decimals();
    oracle.decimals = decimals;
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
  let quoteId = readUnderlyingTokenFromNotional(event.params.currencyId).toHexString();
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

    updateVaultOracles(vaultAddress, event.block);
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
  pCashExchangeRate.decimals = DOUBLE_SCALAR_DECIMALS;
  pCashExchangeRate.ratePrecision = DOUBLE_SCALAR_PRECISION;
  pCashExchangeRate.oracleAddress = notional._address;
  updateExchangeRate(
    pCashExchangeRate,
    factors.supplyScalar.times(factors.underlyingScalar),
    event.block,
    event.transaction.hash.toHexString()
  );

  // Supply Scalar
  let pCashMoneyMarketExchangeRate = getOracle(
    base,
    pCashAsset,
    PrimeCashToMoneyMarketExchangeRate
  );
  pCashMoneyMarketExchangeRate.decimals = SCALAR_DECIMALS;
  pCashMoneyMarketExchangeRate.ratePrecision = SCALAR_PRECISION;
  pCashMoneyMarketExchangeRate.oracleAddress = notional._address;
  updateExchangeRate(
    pCashMoneyMarketExchangeRate,
    factors.supplyScalar,
    event.block,
    event.transaction.hash.toHexString()
  );

  // Underlying Scalar
  let moneyMarketExchangeRate = getOracle(base, pCashAsset, MoneyMarketToUnderlyingExchangeRate);
  moneyMarketExchangeRate.decimals = SCALAR_DECIMALS;
  moneyMarketExchangeRate.ratePrecision = SCALAR_PRECISION;
  moneyMarketExchangeRate.oracleAddress = notional._address;
  updateExchangeRate(
    moneyMarketExchangeRate,
    factors.underlyingScalar,
    event.block,
    event.transaction.hash.toHexString()
  );

  let pDebtAddress = notional.pDebtAddress(event.params.currencyId);
  let interestRates = notional.try_getPrimeInterestRate(event.params.currencyId);
  if (pDebtAddress != ZERO_ADDRESS) {
    let pDebtAsset = getAsset(pDebtAddress.toHexString());

    // Debt Scalar * Underlying Scalar
    let pDebtExchangeRate = getOracle(base, pDebtAsset, PrimeDebtToUnderlyingExchangeRate);
    pDebtExchangeRate.decimals = DOUBLE_SCALAR_DECIMALS;
    pDebtExchangeRate.ratePrecision = DOUBLE_SCALAR_PRECISION;
    pDebtExchangeRate.oracleAddress = notional._address;
    updateExchangeRate(
      pDebtExchangeRate,
      factors.debtScalar.times(factors.underlyingScalar),
      event.block,
      event.transaction.hash.toHexString()
    );

    // Debt Scalar
    let pDebtMoneyMarketExchangeRate = getOracle(
      base,
      pDebtAsset,
      PrimeDebtToMoneyMarketExchangeRate
    );
    pDebtMoneyMarketExchangeRate.decimals = SCALAR_DECIMALS;
    pDebtMoneyMarketExchangeRate.ratePrecision = SCALAR_PRECISION;
    pDebtMoneyMarketExchangeRate.oracleAddress = notional._address;
    updateExchangeRate(
      pDebtMoneyMarketExchangeRate,
      factors.debtScalar,
      event.block,
      event.transaction.hash.toHexString()
    );

    // Debt interest rate
    let pDebtSpotInterestRate = getOracle(base, pDebtAsset, PrimeDebtPremiumInterestRate);
    pDebtSpotInterestRate.decimals = SCALAR_DECIMALS;
    pDebtSpotInterestRate.ratePrecision = SCALAR_PRECISION;
    pDebtSpotInterestRate.oracleAddress = notional._address;
    let debtRate = interestRates.reverted
      ? BigInt.zero()
      : interestRates.value.getAnnualDebtRatePostFee();
    updateExchangeRate(
      pDebtSpotInterestRate,
      debtRate,
      event.block,
      event.transaction.hash.toHexString()
    );
  }

  // Supply Rate
  let pCashSpotInterestRate = getOracle(base, pCashAsset, PrimeCashPremiumInterestRate);
  pCashSpotInterestRate.decimals = SCALAR_DECIMALS;
  pCashSpotInterestRate.ratePrecision = SCALAR_PRECISION;
  pCashSpotInterestRate.oracleAddress = notional._address;
  let supplyRate = interestRates.reverted
    ? BigInt.zero()
    : interestRates.value.getAnnualSupplyRate();
  updateExchangeRate(
    pCashSpotInterestRate,
    supplyRate,
    event.block,
    event.transaction.hash.toHexString()
  );
}

export function handleRebalance(event: CurrencyRebalanced): void {
  let notional = getNotional();
  let base = getUnderlying(event.params.currencyId);
  let pCashAddress = notional.pCashAddress(event.params.currencyId);
  let pCashAsset = getAsset(pCashAddress.toHexString());
  let factors = notional.getPrimeFactorsStored(event.params.currencyId);

  // Oracle Rate
  let pCashSupplyRate = getOracle(base, pCashAsset, PrimeCashToUnderlyingOracleInterestRate);
  pCashSupplyRate.decimals = RATE_DECIMALS;
  pCashSupplyRate.ratePrecision = RATE_PRECISION;
  pCashSupplyRate.oracleAddress = notional._address;

  updateExchangeRate(
    pCashSupplyRate,
    factors.oracleSupplyRate,
    event.block,
    event.transaction.hash.toHexString()
  );

  // External lending rate
  let pCashExternalLending = getOracle(base, pCashAsset, PrimeCashExternalLendingInterestRate);
  let interestRates = notional.getPrimeInterestRate(event.params.currencyId);
  pCashSupplyRate.decimals = RATE_DECIMALS;
  pCashSupplyRate.ratePrecision = RATE_PRECISION;
  pCashSupplyRate.oracleAddress = notional._address;
  updateExchangeRate(
    pCashExternalLending,
    // The external lending rate is the difference between the oracle supply rate
    // and the prime supply premium
    factors.oracleSupplyRate.minus(interestRates.getAnnualSupplyRate()),
    event.block,
    event.transaction.hash.toHexString()
  );
}

export function handleSettlementRate(event: SetPrimeSettlementRate): void {
  // NOTE: This will only ever be called in V3
  // Token is positive and negative fCash to prime cash
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

  let posOracle = getOracle(positivefCash, pCash, fCashSettlementRate);
  posOracle.oracleAddress = notional._address;
  posOracle.decimals = DOUBLE_SCALAR_DECIMALS;
  posOracle.ratePrecision = DOUBLE_SCALAR_PRECISION;
  posOracle.latestRate = event.params.supplyFactor;
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

    {
      let negOracle = getOracle(negativefCash, pDebt, fCashSettlementRate);
      negOracle.oracleAddress = notional._address;
      negOracle.decimals = DOUBLE_SCALAR_DECIMALS;
      negOracle.ratePrecision = DOUBLE_SCALAR_PRECISION;
      negOracle.latestRate = event.params.debtFactor;
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
}

/***** BLOCK HANDLER *********/

export function handleBlockOracleUpdate(block: ethereum.Block): void {
  let registry = getOracleRegistry();
  registry.lastRefreshBlockNumber = block.number;
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
    updatefCashOraclesAndMarkets(registry.fCashEnabled[i], block, null);
  }
}
