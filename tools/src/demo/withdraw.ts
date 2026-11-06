// The owner's withdrawal from its own Intents account to its NEAR account (SPEC.md "Owner withdrawal"): the owner's
// action on the verifier, outside the mandate contract and outside every recovery claim. Minimal local helper for the
// demo; the runner's own ft_withdraw/storage helpers (src/near, src/live) can replace it once they exist.
import { z } from "zod";
import { MAX_GAS, ONE_YOCTO, type Outcome } from "../near/client.js";
import { tokenId } from "../near/contracts.js";
import type { AssetWithdrawal } from "../evidence/journey.js";
import type { Asset } from "../types.js";
import type { Recorder } from "./story.js";
import type { World } from "./world.js";

const U128 = z.string().regex(/^(0|[1-9][0-9]*)$/);
const StorageBalance = z.object({ total: U128, available: U128 }).loose().nullable();

export const ftBalance = async (world: World, asset: Asset, accountId: string): Promise<bigint> =>
  BigInt(await world.client.view(world.tokens[asset], "ft_balance_of", { account_id: accountId }, U128));

export const isRegistered = async (world: World, asset: Asset, accountId: string): Promise<boolean> =>
  (await world.client.view(world.tokens[asset], "storage_balance_of", { account_id: accountId }, StorageBalance)) !== null;

const storageMin = async (world: World, asset: Asset): Promise<bigint> =>
  BigInt((await world.client.view(world.tokens[asset], "storage_balance_bounds", {}, z.object({ min: U128 }).loose())).min);

const errorOf = (o: Outcome): string | null => o.error ?? o.receipts.find((r) => !r.success)?.error ?? null;

/** At most one retry, and only while the Intents balance is intact, so a unit is never withdrawn twice. */
const MAX_ATTEMPTS = 2;

/**
 * Withdraws the owner's whole Intents balance of `asset` to the owner's NEAR account: registers the owner on the token
 * only when it is not registered, then calls the verifier's ft_withdraw. Success is read from the final receipts and
 * the balances on both sides; a failed or refunded receipt leaves the Intents balance intact and is retried once.
 */
export async function withdrawToOwner(world: World, rec: Recorder, asset: Asset): Promise<AssetWithdrawal> {
  const { client, owner, verifier } = world;
  const token = world.tokens[asset];
  const amount = await verifier.balance(owner.id, token);
  const nearBefore = await ftBalance(world, asset, owner.id);
  const registeredBefore = await isRegistered(world, asset, owner.id);
  let storageTx: string | null = null;
  let depositYocto = 0n;
  if (!registeredBefore) {
    depositYocto = await storageMin(world, asset);
    const reg = rec.receipt(
      await client.call(`owner storage_deposit on ${asset} token`, owner.account, token, "storage_deposit", { account_id: owner.id, registration_only: true }, { gas: 30n * 10n ** 12n, deposit: depositYocto }),
      { owner_action: "storage registration before withdrawal", outside_recovery: true },
    );
    storageTx = reg.tx_hash ?? null;
  }
  const registeredAfter = await isRegistered(world, asset, owner.id);
  const base = {
    asset,
    token,
    registration: { registered_before: registeredBefore, storage_deposit_tx: storageTx, deposit_yocto: depositYocto.toString(), registered_after: registeredAfter },
    amount: amount.toString(),
    intents_before: amount.toString(),
    near_before: nearBefore.toString(),
  };
  if (amount === 0n) return { ...base, attempts: [], outcome: "nothing-to-withdraw" };

  const attempts: AssetWithdrawal["attempts"] = [];
  for (let n = 1; n <= MAX_ATTEMPTS && registeredAfter; n++) {
    const outcome = rec.receipt(
      await client.call(`owner ft_withdraw ${asset} to its NEAR account (attempt ${String(n)})`, owner.account, verifier.id, "ft_withdraw", { token, receiver_id: owner.id, amount: amount.toString() }, { gas: MAX_GAS, deposit: ONE_YOCTO }),
      { owner_action: "withdrawal from the owner's Intents account", outside_recovery: true, token_id: tokenId(token) },
    );
    const intentsAfter = await verifier.balance(owner.id, token);
    const nearAfter = await ftBalance(world, asset, owner.id);
    const returned = U128.safeParse(outcome.return_value);
    const success =
      outcome.success && !outcome.any_receipt_failed && returned.success && returned.data === amount.toString() && intentsAfter === 0n && nearAfter === nearBefore + amount;
    attempts.push({
      tx_hash: outcome.tx_hash ?? null,
      success,
      returned: returned.success ? returned.data : null,
      intents_after: intentsAfter.toString(),
      near_after: nearAfter.toString(),
      error: success ? null : (errorOf(outcome) ?? "withdrawal receipts or balances do not show the full amount withdrawn"),
    });
    // Retry only a refunded or failed withdrawal whose Intents balance is intact; anything else stops here.
    if (success || intentsAfter !== amount) break;
  }
  return { ...base, attempts, outcome: attempts.at(-1)?.success === true ? "withdrawn" : "failed" };
}
