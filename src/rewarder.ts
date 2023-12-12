import { Address, DataSourceContext, ethereum } from "@graphprotocol/graph-ts";
import { SecondaryRewarder } from "../generated/templates";
import { getAsset, createTransfer } from "./common/entities";
import { _logTransfer } from "./transactions";
import { createERC20TokenAsset } from "./common/erc20";
import { Underlying } from "./common/constants";

export function createSecondaryRewarderContext(rewarder: Address, event: ethereum.Event) {
  let r = ISecondaryRewarder.bind(rewarder);
  let rewardToken = r.rewardToken();
  let nToken = r.nToken();

  // Ensure that the reward token is in the system
  createERC20TokenAsset(rewardToken, false, event, Underlying);

  // Creates a new data source to listen for transfer events on
  let context = new DataSourceContext();
  context.setString("rewardToken", rewardToken);
  context.setString("nToken", nToken);
  SecondaryRewarder.createWithContext(rewarder, context);
}

export function handleSecondaryRewardTransfer(event: SecondaryRewardTransfer): void {
  let token = getAsset(event.address.toHexString());
  let transfer = createTransfer(event, 0);
  // Just need to log a to and a value, the from will be the emitter
  _logTransfer(event.address, event.params.to, event.params.value, event, transfer, token);
}
