import { Asset, Transfer } from "../generated/schema";

export function updateBalance(asset: Asset, transfer: Transfer): void {
  // Determine which sub balance method to call and then udpate the balances by directly
  // calling Notional.

}


// Includes markets
function updateNToken(): void {}
function updateAccount(): void {}
function updateVaultAccount(): void {}
function updateVaultState(): void {}

// Includes fee reserve and settlement reserve
function updateReserves(): void {}