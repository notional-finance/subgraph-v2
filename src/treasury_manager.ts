import { VaultRewardReinvested } from "../generated/TreasuryManager/TreasuryManager";
import { ISingleSidedLPStrategyVault } from "../generated/TreasuryManager/ISingleSidedLPStrategyVault";
import { Reinvestment } from "../generated/schema";
import { BigInt } from "@graphprotocol/graph-ts";
import { INTERNAL_TOKEN_PRECISION, RATE_PRECISION, SECONDS_IN_YEAR } from "./common/constants";
import { createERC20TokenAsset } from "./common/erc20";
import { updateVaultOracles } from "./exchange_rates";

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
    }
    if (!vaultSharePrice.reverted) {
      reinvestment.vaultSharePrice = vaultSharePrice.value;
    }

    let reinvestAPY = tokensAsVaultShares
      .times(RATE_PRECISION)
      .div(context.value.totalVaultShares.minus(tokensAsVaultShares).times(SECONDS_IN_YEAR));
    updateVaultOracles(event.params.vault, event.block, reinvestAPY);
  }

  reinvestment.save();
}
