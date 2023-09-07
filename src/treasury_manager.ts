import { VaultRewardReinvested } from "../generated/TreasuryManager/TreasuryManager";
import { ISingleSidedLPStrategyVault } from "../generated/TreasuryManager/ISingleSidedLPStrategyVault";
import { Reinvestment } from "../generated/schema";
import { BigInt } from "@graphprotocol/graph-ts";
import { INTERNAL_TOKEN_PRECISION } from "./common/constants";

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
  reinvestment.rewardTokenSold = event.params.rewardToken;

  // TODO: rewrite this
  reinvestment.rewardAmountSold = event.params.primaryAmount;
  reinvestment.tokensReinvested = event.params.strategyTokenAmount;

  let vault = ISingleSidedLPStrategyVault.bind(event.params.vault);
  let context = vault.try_getStrategyVaultInfo();
  if (!context.reverted) {
    let tokensAsVaultShares = event.params.strategyTokenAmount
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

    if (!underlyingAmountRealized.reverted)
      reinvestment.underlyingAmountRealized = underlyingAmountRealized.value;
  }

  reinvestment.save();
}
