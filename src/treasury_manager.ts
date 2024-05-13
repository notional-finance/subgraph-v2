import { VaultRewardReinvested } from "../generated/TreasuryManager/TreasuryManager";
import { ISingleSidedLPStrategyVault } from "../generated/TreasuryManager/ISingleSidedLPStrategyVault";
import { Reinvestment } from "../generated/schema";
import { BigInt, log } from "@graphprotocol/graph-ts";
import { INTERNAL_TOKEN_PRECISION, SCALAR_PRECISION } from "./common/constants";
import { createERC20TokenAsset } from "./common/erc20";
import { updateVaultOracles } from "./exchange_rates";
import { getNotional, getUnderlying } from "./common/entities";

export function handleVaultRewardReinvested(event: VaultRewardReinvested): void {
  let id =
    event.params.vault.toHexString() +
    ":" +
    event.params.rewardToken.toHexString() +
    ":" +
    event.transaction.hash.toHexString();

  let reinvestment = new Reinvestment(id);
  reinvestment.blockNumber = event.block.number;
  reinvestment.timestamp = event.block.timestamp.toI32();
  reinvestment.transactionHash = event.transaction.hash;

  reinvestment.vault = event.params.vault.toHexString();
  // Ensure that the reward token has a record in the system
  let rewardToken = createERC20TokenAsset(event.params.rewardToken, false, event, "Underlying");
  reinvestment.rewardTokenSold = rewardToken.id;

  reinvestment.rewardAmountSold = event.params.soldAmount;
  reinvestment.tokensReinvested = event.params.poolClaimAmount;

  let vault = ISingleSidedLPStrategyVault.bind(event.params.vault);
  let context = vault.try_getStrategyVaultInfo();
  if (!context.reverted) {
    let tokensAsVaultShares = event.params.poolClaimAmount
      .times(context.value.totalVaultShares)
      .div(context.value.totalLPTokens);

    // NOTE: this is denominated in the native LP token precision
    reinvestment.tokensPerVaultShare = context.value.totalLPTokens
      .times(INTERNAL_TOKEN_PRECISION)
      .div(context.value.totalVaultShares);
    let underlyingAmountRealized = vault.try_convertStrategyToUnderlying(
      event.params.vault,
      tokensAsVaultShares,
      BigInt.fromI32(0)
    );

    let vaultSharePrice = vault.try_convertStrategyToUnderlying(
      event.params.vault,
      INTERNAL_TOKEN_PRECISION,
      BigInt.fromI32(0)
    );

    if (!underlyingAmountRealized.reverted) {
      reinvestment.underlyingAmountRealized = underlyingAmountRealized.value;
      let notional = getNotional();
      let vaultConfig = notional.getVaultConfig(event.params.vault);
      let base = getUnderlying(vaultConfig.borrowCurrencyId);
      // Total Interest Accrued = underlyingAmountRealized
      // Then normalize to one vault share but in 18 decimals
      let interestPerVaultShare = underlyingAmountRealized.value
        .times(context.value.totalVaultShares)
        .times(SCALAR_PRECISION)
        .div(INTERNAL_TOKEN_PRECISION)
        .div(base.precision);

      log.debug("Vault Share Interest Accrued calling reinvestment {} {}", [
        event.params.vault.toString(),
        interestPerVaultShare.toString(),
      ]);
      updateVaultOracles(
        event.params.vault,
        event.block,
        interestPerVaultShare,
        event.transaction.hash.toString()
      );
    }
    if (!vaultSharePrice.reverted) {
      reinvestment.vaultSharePrice = vaultSharePrice.value;
    }
  }

  reinvestment.save();
}
