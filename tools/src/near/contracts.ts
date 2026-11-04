// Typed wrappers for the mandate contract (provisional ABI) and the pinned Intents verifier.
import type { Account } from "near-api-js";
import { z } from "zod";
import { GrantView, OrderView, SignedNep413, type Asset, type Policy, type Proposal } from "../types.js";
import { MAX_GAS, ONE_YOCTO, TGAS, type NearClient, type Outcome } from "./client.js";

const U128 = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const MandateConfigView = z
  .object({
    owner_id: z.string(),
    agent_id: z.string(),
    verifier_id: z.string(),
    signer_id: z.string(),
    oracle_id: z.string(),
    usdc: z.object({ token: z.string(), decimals: z.number().int(), price_id: z.string() }).loose(),
    wnear: z.object({ token: z.string(), decimals: z.number().int(), price_id: z.string() }).loose(),
  })
  .loose();
export type MandateConfigView = z.infer<typeof MandateConfigView>;

export const tokenId = (token: string): string => `nep141:${token}`;

export const AssetRecoveryView = z.object({ asset: z.enum(["usdc", "wnear"]), in_flight: z.boolean(), attempts: z.number().int(), recovered: U128 }).loose();
export type AssetRecoveryView = z.infer<typeof AssetRecoveryView>;

/** Order states in which signed authority may exist or still be created. */
export const OPEN_ORDER_STATES = ["pricing", "signing", "signed", "sign_unknown"];

export class MandateClient {
  constructor(
    readonly client: NearClient,
    readonly id: string,
  ) {}

  config(): Promise<MandateConfigView> {
    return this.client.view(this.id, "get_config", {}, MandateConfigView);
  }
  grant(): Promise<GrantView | null> {
    return this.client.view(this.id, "get_grant", {}, GrantView.nullable());
  }
  order(orderId: string): Promise<OrderView | null> {
    return this.client.view(this.id, "get_order", { order_id: orderId }, OrderView.nullable());
  }
  listOrders(fromIndex = 0, limit = 100): Promise<OrderView[]> {
    return this.client.view(this.id, "list_orders", { from_index: fromIndex.toString(), limit }, z.array(OrderView));
  }
  recovery(): Promise<unknown> {
    return this.client.view(this.id, "get_recovery", {}, z.unknown());
  }
  recoveryViews(): Promise<AssetRecoveryView[]> {
    return this.client.view(this.id, "get_recovery", {}, z.array(AssetRecoveryView));
  }
  /** Every order, paging through list_orders (limit <= 100). */
  async allOrders(): Promise<OrderView[]> {
    const out: OrderView[] = [];
    for (;;) {
      const page = await this.listOrders(out.length, 100);
      out.push(...page);
      if (page.length < 100) return out;
    }
  }

  grantPolicy(owner: Account, policy: Policy): Promise<Outcome> {
    return this.client.call("owner grant", owner, this.id, "grant", { policy }, { gas: MAX_GAS });
  }
  revoke(owner: Account, label = "owner revoke"): Promise<Outcome> {
    return this.client.call(label, owner, this.id, "revoke", {}, { gas: MAX_GAS });
  }
  recover(owner: Account, asset: Asset): Promise<Outcome> {
    return this.client.call(`owner recover ${asset}`, owner, this.id, "recover", { asset }, { gas: MAX_GAS });
  }
  propose(agent: Account, proposal: Proposal, label = "agent propose_order"): Promise<Outcome> {
    return this.client.call(label, agent, this.id, "propose_order", { proposal }, { gas: MAX_GAS });
  }
  settle(caller: Account, orderId: string): Promise<Outcome> {
    return this.client.call(`settle_order ${orderId}`, caller, this.id, "settle_order", { order_id: orderId }, { gas: MAX_GAS });
  }
  expire(caller: Account, orderId: string): Promise<Outcome> {
    return this.client.call(`expire_order ${orderId}`, caller, this.id, "expire_order", { order_id: orderId }, { gas: MAX_GAS });
  }
}

export const Pips = z.number().int().min(0).max(1_000_000);

export class VerifierClient {
  constructor(
    readonly client: NearClient,
    readonly id: string,
  ) {}

  async balance(accountId: string, token: string): Promise<bigint> {
    return BigInt(await this.client.view(this.id, "mt_balance_of", { account_id: accountId, token_id: tokenId(token) }, U128));
  }
  isNonceUsed(accountId: string, nonceB64: string): Promise<boolean> {
    return this.client.view(this.id, "is_nonce_used", { account_id: accountId, nonce: nonceB64 }, z.boolean());
  }
  publicKeysOf(accountId: string): Promise<string[]> {
    return this.client.view(this.id, "public_keys_of", { account_id: accountId }, z.array(z.string()));
  }
  hasPublicKey(accountId: string, publicKey: string): Promise<boolean> {
    return this.client.view(this.id, "has_public_key", { account_id: accountId, public_key: publicKey }, z.boolean());
  }
  currentSalt(): Promise<string> {
    return this.client.view(this.id, "current_salt", {}, z.string().regex(/^[0-9a-f]{8}$/));
  }
  async feePips(): Promise<bigint> {
    return BigInt(await this.client.view(this.id, "fee", {}, Pips));
  }
  /** Dry run of execute_intents; the verifier panics on an invalid bundle. */
  simulate(signed: SignedNep413[]): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    return this.client.tryView(this.id, "simulate_intents", { signed }, z.unknown());
  }
  execute(relayer: Account, signed: SignedNep413[], label: string): Promise<Outcome> {
    return this.client.call(label, relayer, this.id, "execute_intents", { signed }, { gas: MAX_GAS });
  }
  addPublicKey(account: Account, publicKey: string): Promise<Outcome> {
    return this.client.call(`add_public_key ${account.accountId}`, account, this.id, "add_public_key", { public_key: publicKey }, {
      gas: 30n * TGAS,
      deposit: ONE_YOCTO,
    });
  }
}

/** Finds a SignedNep413 inside an `order_signed` event payload; `multi_payload` may be a JSON string. */
export function findSignedPayload(data: unknown): SignedNep413 | null {
  if (typeof data === "string") {
    if (!data.trimStart().startsWith("{")) return null;
    try {
      return findSignedPayload(JSON.parse(data));
    } catch {
      return null;
    }
  }
  const direct = SignedNep413.safeParse(data);
  if (direct.success) return direct.data;
  if (typeof data === "object" && data !== null) {
    for (const value of Object.values(data)) {
      const found = findSignedPayload(value);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Polls an order until it leaves the asynchronous pricing/signing states (or the timeout passes). */
export async function settledOrder(mandate: MandateClient, orderId: string, timeoutMs = 20_000): Promise<OrderView | null> {
  const start = Date.now();
  for (;;) {
    const order = await mandate.order(orderId);
    if (order === null || !["pricing", "signing"].includes(order.state.state) || Date.now() - start > timeoutMs) return order;
    await new Promise((r) => setTimeout(r, 500));
  }
}
