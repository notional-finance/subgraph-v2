import { Address, DataSourceContext, ethereum } from "@graphprotocol/graph-ts";
import {
  RewardTransfer,
  SecondaryRewarder as ISecondaryRewarder,
} from "../generated/Configuration/SecondaryRewarder";
import { SecondaryRewarder } from "../generated/templates";
import { getAsset, createTransfer } from "./common/entities";
import { _logTransfer } from "./transactions";
import { createERC20TokenAsset } from "./common/erc20";
import { Underlying } from "./common/constants";

export function createSecondaryRewarderContext(rewarder: Address, event: ethereum.Event): void {
  let r = ISecondaryRewarder.bind(rewarder);
  let rewardToken = r.REWARD_TOKEN();
  let nToken = r.NTOKEN_ADDRESS();

  // Ensure that the reward token is in the system
  createERC20TokenAsset(rewardToken, false, event, Underlying);

  // Creates a new data source to listen for transfer events on
  let context = new DataSourceContext();
  context.setString("rewardToken", rewardToken.toHexString());
  context.setString("nToken", nToken.toHexString());
  SecondaryRewarder.createWithContext(rewarder, context);
}

export function handleSecondaryRewardTransfer(event: RewardTransfer): void {
  let token = getAsset(event.params.rewardToken.toHexString());
  let transfer = createTransfer(event, 0);
  // Just need to log to and a value, the from will be the emitter
  _logTransfer(event.address, event.params.account, event.params.amount, event, transfer, token);
}
