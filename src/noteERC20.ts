import { DelegateChanged, DelegateVotesChanged, Transfer } from "../generated/NoteERC20/NoteERC20"
import { log } from "@graphprotocol/graph-ts";

export function handleDelegateChanged(event: DelegateChanged): void {

}

export function handleDelegateVotesChanged(event: DelegateVotesChanged): void {

}

export function handleTransfer(event: Transfer): void {
  log.info("Hello world", []);
}
