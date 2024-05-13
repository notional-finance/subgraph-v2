import { ethereum, BigInt, Address } from "@graphprotocol/graph-ts";
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
import { Token, ExchangeRate, Oracle, Incentive } from "../generated/schema";
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
  nTokenSecondaryIncentiveRate,
  nTokenInterestAccrued,
  SECONDS_IN_YEAR,
  VaultShareInterestAccrued,
} from "./common/constants";
import {
  getAsset,
  getNotional,
  getOracle,
  getOracleRegistry,
  getUnderlying,
} from "./common/entities";
import { getOrCreateERC1155Asset } from "./common/erc1155";
import { updatePrimeCashMarket, updatefCashMarket } from "./common/market";
import { convertValueToUnderlying, getExpFactor } from "./common/transfers";
import { readUnderlyingTokenFromNotional } from "./assets";
import { getNTokenFeeBuffer } from "./balances";
import { Notional__getNTokenAccountResult } from "../generated/Assets/Notional";
import { handleUnderlyingSnapshot } from "./external_lending";

const SIX_HOURS = BigInt.fromI32(21_600);

export function accumulateInterestEarnedRate(
  oracle: Oracle,
  interestAPY: BigInt,
  block: ethereum.Block
): void {
  let ts = block.timestamp.minus(block.timestamp.mod(SIX_HOURS)).minus(SIX_HOURS);
  let id = oracle.id + ":" + ts.toString();
  let previousRate = ExchangeRate.load(id);

  let interestAccrued = oracle.ratePrecision;
  if (previousRate) {
    let timesSinceLastReinvest = block.timestamp.minus(BigInt.fromI32(previousRate.timestamp));
    // Interest Accrued = previousRate.rate +
    // 1 unit underlying * (rate * timeSinceLastReinvest / SECONDS_IN_YEAR)
    // NOTE: interest accrued here is in underlying precision
    interestAccrued = previousRate.rate.plus(
      oracle.ratePrecision
        .times(interestAPY)
        .times(timesSinceLastReinvest)
        .div(SECONDS_IN_YEAR)
        .div(RATE_PRECISION)
    );
  }

  updateExchangeRate(oracle, interestAccrued, block, null);
}

export function updateExchangeRate(
  oracle: Oracle,
  rate: BigInt,
  block: ethereum.Block,
  txnHash: string | null
): void {
  let ts = block.timestamp.minus(block.timestamp.mod(SIX_HOURS));
  let id = oracle.id + ":" + ts.toString();

  // Only save the exchange rate once per ID.
  if (ExchangeRate.load(id) === null) {
    let exchangeRate = new ExchangeRate(id);
    exchangeRate.blockNumber = block.number;
    exchangeRate.timestamp = block.timestamp.toI32();
    exchangeRate.rate = rate;
    exchangeRate.oracle = oracle.id;
    exchangeRate.transaction = txnHash;
    let quote = getAsset(oracle.quote);
    // Snapshot the total supply figure for TVL calculations
    exchangeRate.totalSupply = quote.totalSupply;
    exchangeRate.save();

    oracle.latestRate = rate;
    oracle.lastUpdateBlockNumber = block.number;
    oracle.lastUpdateTimestamp = block.timestamp.toI32();
    oracle.lastUpdateTransaction = txnHash;
    oracle.save();
  }
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
  block: ethereum.Block,
  interestAccrued: BigInt | null,
  txnHash: string | null
): void {
  let notional = getNotional();
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let vault = IStrategyVault.bind(vaultAddress);

  let shareValue = vault.try_getExchangeRate(maturity);
  let value: BigInt;
  if (shareValue.reverted) {
    let v = vault.try_getExchangeRate(maturity);
    if (!v.reverted) value = v.value;
    else value = BigInt.zero();
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

  if (interestAccrued !== null) {
    let o = getOracle(base, vaultShareAsset, VaultShareInterestAccrued);
    o.decimals = base.decimals;
    o.ratePrecision = base.precision;
    o.oracleAddress = vaultAddress;

    let prevTs = block.timestamp.minus(block.timestamp.mod(SIX_HOURS)).minus(SIX_HOURS);
    let prevId = oracle.id + ":" + prevTs.toString();

    let currentTs = block.timestamp.minus(block.timestamp.mod(SIX_HOURS));
    let currentId = oracle.id + ":" + currentTs.toString();

    // Multiple reinvestments happen at the same block so need to accrue reinvestments
    // at the same timestamp together.
    let currentRate = ExchangeRate.load(currentId);
    if (currentRate) {
      // If there is a current rate then accumulate it, this is the only place
      // where we do this so we don't call the function here.
      let newRate = currentRate.rate.plus(interestAccrued);

      currentRate.blockNumber = block.number;
      currentRate.timestamp = block.timestamp.toI32();
      currentRate.rate = newRate;
      currentRate.oracle = oracle.id;
      currentRate.transaction = txnHash;
      let quote = getAsset(oracle.quote);
      currentRate.totalSupply = quote.totalSupply;
      currentRate.save();

      oracle.latestRate = newRate;
      oracle.lastUpdateBlockNumber = block.number;
      oracle.lastUpdateTimestamp = block.timestamp.toI32();
      oracle.lastUpdateTransaction = txnHash;
      oracle.save();
    } else {
      let previousRate = ExchangeRate.load(prevId);
      let newRate = interestAccrued;
    if (previousRate) {
        // If there is a previous rate then accrue that into the object
        newRate = previousRate.rate.plus(interestAccrued);
    }
      updateExchangeRate(o, newRate, block, txnHash);
    }
  }
}

export function updateVaultOracles(
  vaultAddress: Address,
  block: ethereum.Block,
  interestAccrued: BigInt | null,
  txnHash: string | null
): void {
  let notional = getNotional();
  let vaultConfig = notional.getVaultConfig(vaultAddress);
  let base = getUnderlying(vaultConfig.borrowCurrencyId);

  // prettier-ignore
  updateVaultOracleMaturity(
    vaultAddress, PRIME_CASH_VAULT_MATURITY, base, block, interestAccrued, txnHash
  );

  let activeMarkets = notional.try_getActiveMarkets(vaultConfig.borrowCurrencyId);
  if (activeMarkets.reverted) return;

  for (let i = 0; i < activeMarkets.value.length; i++) {
    if (i + 1 <= vaultConfig.maxBorrowMarketIndex.toI32()) {
      let a = activeMarkets.value[i];
      // prettier-ignore
      updateVaultOracleMaturity(
        vaultAddress, a.maturity, base, block, interestAccrued, txnHash
      );
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

  let interestRates = notional.try_getPrimeInterestRate(currencyId);
  let pCashAddress = notional.pCashAddress(currencyId);
  let pCashAsset = getAsset(pCashAddress.toHexString());
  let pCashSupplyRate = interestRates.reverted
    ? BigInt.zero()
    : interestRates.value.getAnnualSupplyRate();

  let nToken = getAsset(notional.nTokenAddress(currencyId).toHexString());
  let nTokenAccount = notional.getNTokenAccount(Address.fromBytes(nToken.tokenAddress));
  let nTokenCash = convertValueToUnderlying(
    nTokenAccount.getCashBalance(),
    pCashAsset,
    block.timestamp
  );
  if (nTokenCash === null) nTokenCash = BigInt.zero();
  let nTokenBlendedInterestNumerator = nTokenCash.times(pCashSupplyRate);
  let nTokenBlendedInterestDenominator = nTokenCash;

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
    let negativefCashId = notional.encode(
      currencyId,
      a.maturity,
      FCASH_ASSET_TYPE_ID,
      ZERO_ADDRESS,
      true
    ) as BigInt;
    let negFCash = getOrCreateERC1155Asset(negativefCashId, block, null);

    // prettier-ignore
    updatefCashExchangeRate(
      fCashOracleRate,
      a.oracleRate,
      base, notional._address, posFCash, negFCash, block, txnHash
    );

    // NOTE: these fCash exchange rate updates are suppressed if they fall outside
    // the oracle update cadence
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

    // NOTE: these fCash exchange rate updates are suppressed if they fall outside
    // the oracle update cadence
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
      pCashAsset,
      block.timestamp
    );

    if (fCashPV !== null && cashPV !== null) {
      nTokenBlendedInterestNumerator = nTokenBlendedInterestNumerator
        .plus(fCashPV.times(activeMarkets.value[i].oracleRate))
        .plus(cashPV.times(pCashSupplyRate));
      nTokenBlendedInterestDenominator = nTokenBlendedInterestDenominator
        .plus(fCashPV)
        .plus(cashPV);
    }
  }

  // NOTE: these nToken exchange rate updates are suppressed if they fall outside
  // the oracle update cadence
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
  nTokenAccount: Notional__getNTokenAccountResult,
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

  let o = getOracle(base, nToken, nTokenInterestAccrued);
  o.decimals = base.decimals;
  o.ratePrecision = base.precision;
  o.oracleAddress = notional._address;
  accumulateInterestEarnedRate(o, interestAPY, block);

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
    let incentives = Incentive.load(currencyId.toString());
    if (incentives == null) return;

    let noteAPYInNOTETerms = incentives.incentiveEmissionRate
      ? (incentives.incentiveEmissionRate as BigInt)
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

    // This is the APY of the secondary incentive in its own terms
    let secondaryAPY = incentives.secondaryEmissionRate
      ? (incentives.secondaryEmissionRate as BigInt)
          .times(INTERNAL_TOKEN_PRECISION)
          .times(RATE_PRECISION)
          .div(nTokenUnderlyingPV)
      : BigInt.zero();

    // prettier-ignore
    updateNTokenRate(
      nTokenSecondaryIncentiveRate,
      secondaryAPY,
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

    updateVaultOracles(vaultAddress, event.block, null, null);
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
  updatePrimeCashMarket(event.params.currencyId, event.block, event.transaction.hash.toHexString());
}

function updatePrimeCashRates(currencyId: i32, block: ethereum.Block): void {
  let notional = getNotional();
  let base = getUnderlying(currencyId);
  let pCashAddress = notional.pCashAddress(currencyId);
  let pCashAsset = getAsset(pCashAddress.toHexString());
  let factors = notional.getPrimeFactorsStored(currencyId);

  // Supply Scalar * Underlying Scalar
  let pCashExchangeRate = getOracle(base, pCashAsset, PrimeCashToUnderlyingExchangeRate);
  pCashExchangeRate.decimals = DOUBLE_SCALAR_DECIMALS;
  pCashExchangeRate.ratePrecision = DOUBLE_SCALAR_PRECISION;
  pCashExchangeRate.oracleAddress = notional._address;
  updateExchangeRate(
    pCashExchangeRate,
    factors.supplyScalar.times(factors.underlyingScalar),
    block,
    null
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
  updateExchangeRate(pCashMoneyMarketExchangeRate, factors.supplyScalar, block, null);

  // Underlying Scalar
  let moneyMarketExchangeRate = getOracle(base, pCashAsset, MoneyMarketToUnderlyingExchangeRate);
  moneyMarketExchangeRate.decimals = SCALAR_DECIMALS;
  moneyMarketExchangeRate.ratePrecision = SCALAR_PRECISION;
  moneyMarketExchangeRate.oracleAddress = notional._address;
  updateExchangeRate(moneyMarketExchangeRate, factors.underlyingScalar, block, null);

  let pDebtAddress = notional.pDebtAddress(currencyId);
  let interestRates = notional.try_getPrimeInterestRate(currencyId);
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
      block,
      null
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
    updateExchangeRate(pDebtMoneyMarketExchangeRate, factors.debtScalar, block, null);

    // Debt interest rate
    let pDebtSpotInterestRate = getOracle(base, pDebtAsset, PrimeDebtPremiumInterestRate);
    pDebtSpotInterestRate.decimals = SCALAR_DECIMALS;
    pDebtSpotInterestRate.ratePrecision = SCALAR_PRECISION;
    pDebtSpotInterestRate.oracleAddress = notional._address;
    let debtRate = interestRates.reverted
      ? BigInt.zero()
      : interestRates.value.getAnnualDebtRatePostFee();
    updateExchangeRate(pDebtSpotInterestRate, debtRate, block, null);
  }

  // Supply Rate
  let pCashSpotInterestRate = getOracle(base, pCashAsset, PrimeCashPremiumInterestRate);
  pCashSpotInterestRate.decimals = SCALAR_DECIMALS;
  pCashSpotInterestRate.ratePrecision = SCALAR_PRECISION;
  pCashSpotInterestRate.oracleAddress = notional._address;
  let supplyRate = interestRates.reverted
    ? BigInt.zero()
    : interestRates.value.getAnnualSupplyRate();
  updateExchangeRate(pCashSpotInterestRate, supplyRate, block, null);
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
  updateExchangeRate(
    posOracle,
    event.params.supplyFactor,
    event.block,
    event.transaction.hash.toHexString()
  );

  let base = getUnderlying(event.params.currencyId.toI32());
  {
    let fCashExRate = getOracle(base, positivefCash, fCashToUnderlyingExchangeRate);
    fCashExRate.oracleAddress = notional._address;
    fCashExRate.decimals = RATE_DECIMALS;
    fCashExRate.ratePrecision = RATE_PRECISION;
    fCashExRate.matured = true;
    updateExchangeRate(
      fCashExRate,
      RATE_PRECISION,
      event.block,
      event.transaction.hash.toHexString()
    );
  }

  {
    let fCashOracle = getOracle(base, positivefCash, fCashOracleRate);
    fCashOracle.oracleAddress = notional._address;
    fCashOracle.decimals = RATE_DECIMALS;
    fCashOracle.ratePrecision = RATE_PRECISION;
    fCashOracle.matured = true;
    updateExchangeRate(
      fCashOracle,
      // Oracle interest rate is now zero
      BigInt.fromI32(0),
      event.block,
      event.transaction.hash.toHexString()
    );
  }

  // Spot interest rate is also zero, same as oracle interest rate
  {
    let fCashSpot = getOracle(base, positivefCash, fCashSpotRate);
    fCashSpot.oracleAddress = notional._address;
    fCashSpot.decimals = RATE_DECIMALS;
    fCashSpot.ratePrecision = RATE_PRECISION;
    fCashSpot.matured = true;
    updateExchangeRate(
      fCashSpot,
      // Oracle interest rate is now zero
      BigInt.fromI32(0),
      event.block,
      event.transaction.hash.toHexString()
    );
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
      updateExchangeRate(
        negOracle,
        event.params.debtFactor,
        event.block,
        event.transaction.hash.toHexString()
      );
    }

    {
      let fCashExRate = getOracle(base, negativefCash, fCashToUnderlyingExchangeRate);
      fCashExRate.oracleAddress = notional._address;
      fCashExRate.decimals = RATE_DECIMALS;
      fCashExRate.ratePrecision = RATE_PRECISION;
      fCashExRate.matured = true;
      updateExchangeRate(
        fCashExRate,
        RATE_PRECISION,
        event.block,
        event.transaction.hash.toHexString()
      );
    }
  }
}

/***** BLOCK HANDLER *********/

export function handleBlockOracleUpdate(block: ethereum.Block): void {
  let registry = getOracleRegistry();
  registry.lastRefreshBlockNumber = block.number;
  registry.lastRefreshTimestamp = block.timestamp.toI32();
  registry.save();
  let notional = getNotional();
  let maxCurrencyId = notional.getMaxCurrencyId();

  // Updates underlying held at regular snapshots
  handleUnderlyingSnapshot(block);

  for (let i = 1; i <= maxCurrencyId; i++) {
    updatePrimeCashRates(i, block);
  }

  // Aggregate the same oracle types with each other.
  for (let i = 0; i < registry.chainlinkOracles.length; i++) {
    let oracle = Oracle.load(registry.chainlinkOracles[i]) as Oracle;
    updateChainlinkOracle(oracle, block);
  }

  for (let i = 0; i < registry.listedVaults.length; i++) {
    updateVaultOracles(Address.fromBytes(registry.listedVaults[i]), block, null, null);
  }

  for (let i = 0; i < registry.fCashEnabled.length; i++) {
    updatefCashOraclesAndMarkets(registry.fCashEnabled[i], block, null);
  }
}
