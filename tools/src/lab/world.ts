// One session's complete sandbox world and the read-only view of it. A world is built by the demo's own setupWorld
// under a session-scoped parent account (`<role>.<scope>.sandbox`): its own mandate, verifier, oracle double, MPC
// double, tokens, owner, agent, filler and relayer. No account, contract or key is shared between two worlds.
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DEPOSITS, FILLER_DEPOSITS, PRICES, PRICE_IDS } from "../demo/market.js";
import { fillerKey, setupWorld, type World } from "../demo/world.js";
import { Filler } from "../filler/filler.js";
import { AssetRecoveryView } from "../near/contracts.js";
import type { Asset, GrantView, OrderView, SignedNep413 } from "../types.js";
import { RUN_FUNDING_NEAR } from "./alternatives.js";
import type { Lease } from "./pool.js";

/** setupWorld spends about 276 NEAR of the parent's balance on accounts and deployments. */
export const WORLD_NEAR = 300n;
/** Added to the parent before each comparison run: alternatives.ts funds its run with RUN_FUNDING_NEAR from it. */
export const ALTERNATIVE_NEAR = RUN_FUNDING_NEAR + 1n;
export const MAX_ALTERNATIVE_RUNS = 12;
export const LEASE_BUDGET_NEAR = WORLD_NEAR + ALTERNATIVE_NEAR * BigInt(MAX_ALTERNATIVE_RUNS);

/** The filler's own leg outlives any order lifetime a grant allows, so a withheld bundle never fails for it. */
const FILLER_TTL_SEC = 3_600n;

export interface WithheldOrder {
  bundle: SignedNep413[];
  signed: SignedNep413;
  deadline_ns: string | null;
  relayed: boolean;
}

export interface LabWorld {
  /** Name of the parent account; every account of this world ends in `.<scope>.<sandbox root>`. */
  scope: string;
  lease: Lease;
  world: World;
  filler: Filler;
  dir: string;
  createdAt: number;
  /** Signed mandate payloads by order id, taken from the `order_signed` event of the proposal's own receipts. */
  signed: Map<string, SignedNep413>;
  withheld: Map<string, WithheldOrder>;
  /** wNEAR price the lab posts to this world's oracle double (mantissa at exponent -8). */
  wnearPrice: bigint;
  oracleAvailable: boolean;
  alternativeRuns: number;
}

export type WorldWasm = World["wasm"];

export async function createLabWorld(lease: Lease, wasm: WorldWasm, tmpRoot: string): Promise<LabWorld> {
  const scope = `s${randomBytes(5).toString("hex")}`;
  const net = await lease.open(scope, WORLD_NEAR);
  const world = await setupWorld(net, { wasm });
  const dir = join(tmpRoot, scope);
  mkdirSync(dir, { recursive: true });
  const filler = new Filler({
    client: world.client,
    mandate: world.mandate,
    verifier: world.verifier,
    account: world.filler.account,
    key: fillerKey(world),
    statePath: join(dir, "filler-state.json"),
    ttlSec: FILLER_TTL_SEC,
  });
  return { scope, lease, world, filler, dir, createdAt: Date.now(), signed: new Map(), withheld: new Map(), wnearPrice: PRICES.wnear.price, oracleAvailable: true, alternativeRuns: 0 };
}

export async function destroyLabWorld(lw: LabWorld): Promise<void> {
  rmSync(lw.dir, { recursive: true, force: true });
  await lw.lease.release();
}

type Pair = Record<Asset, string>;

export interface OraclePrice {
  price: string;
  conf: string;
  expo: number;
  publish_time: number;
}

export interface LabState {
  block_time_ns: string;
  accounts: {
    mandate: string;
    verifier: string;
    owner: string;
    agent: string;
    filler: string;
    relayer: string;
    oracle_test_double: string;
    signer_test_double: string;
    usdc_test_double: string;
    wnear_test_double: string;
  };
  grant: GrantView | null;
  /** The grant key's registration on the verifier, read from the verifier; null when there is no grant key. */
  key_on_verifier: boolean | null;
  orders: OrderView[];
  /** Order ids whose signed bundle this session holds back. */
  withheld: { order_id: string; relayed: boolean }[];
  balances: { mandate: Pair; owner_intents: Pair; filler: Pair };
  recovery: AssetRecoveryView[];
  /** Read from the oracle double: its current prices, or the error of its failing price call. */
  oracle: { available: true; prices: Record<Asset, OraclePrice | null> } | { available: false; error: string };
  /** The MPC double's mode: `immediate` signs, `immediate_error` answers every request with an error. */
  signer_mode: string;
}

const OraclePriceView = z
  .object({ price: z.union([z.string(), z.number()]), conf: z.union([z.string(), z.number()]), expo: z.number().int(), publish_time: z.number().int() })
  .nullable();

const pair = (b: Record<Asset, bigint>): Pair => ({ usdc: b.usdc.toString(), wnear: b.wnear.toString() });

async function intentsBalances(world: World, accountId: string): Promise<Pair> {
  const [usdc, wnear] = await Promise.all([world.verifier.balance(accountId, world.tokens.usdc), world.verifier.balance(accountId, world.tokens.wnear)]);
  return pair({ usdc, wnear });
}

async function oracleState(world: World): Promise<LabState["oracle"]> {
  const read = (asset: Asset) => world.client.tryView(world.oracleId, "get_price_no_older_than", { price_id: PRICE_IDS[asset], age: 3_600 }, OraclePriceView);
  const [usdc, wnear] = await Promise.all([read("usdc"), read("wnear")]);
  if (!usdc.ok) return { available: false, error: usdc.error };
  if (!wnear.ok) return { available: false, error: wnear.error };
  const view = (p: z.infer<typeof OraclePriceView>): OraclePrice | null => (p === null ? null : { price: String(p.price), conf: String(p.conf), expo: p.expo, publish_time: p.publish_time });
  return { available: true, prices: { usdc: view(usdc.value), wnear: view(wnear.value) } };
}

/** Everything a visitor may see of a world, through contract views only. */
export async function labState(lw: LabWorld): Promise<LabState> {
  const { world } = lw;
  const { mandate, verifier, client } = world;
  const [grant, orders, blockTime, mandateBal, ownerBal, fillerBal, recovery, oracle, signerMode] = await Promise.all([
    mandate.grant(),
    mandate.allOrders(),
    client.blockTimestampNs(),
    intentsBalances(world, mandate.id),
    intentsBalances(world, world.owner.id),
    intentsBalances(world, world.filler.id),
    mandate.recoveryViews(),
    oracleState(world),
    client.view(world.mpcId, "get_mode", {}, z.string()),
  ]);
  return {
    block_time_ns: blockTime.toString(),
    accounts: {
      mandate: mandate.id,
      verifier: verifier.id,
      owner: world.owner.id,
      agent: world.agent.id,
      filler: world.filler.id,
      relayer: world.relayer.id,
      oracle_test_double: world.oracleId,
      signer_test_double: world.mpcId,
      usdc_test_double: world.tokens.usdc,
      wnear_test_double: world.tokens.wnear,
    },
    grant,
    key_on_verifier: grant?.public_key == null ? null : await verifier.hasPublicKey(mandate.id, grant.public_key),
    orders,
    withheld: [...lw.withheld].map(([order_id, w]) => ({ order_id, relayed: w.relayed })),
    balances: { mandate: mandateBal, owner_intents: ownerBal, filler: fillerBal },
    recovery,
    oracle,
    signer_mode: signerMode,
  };
}

/** What every new world starts with, from the demo's market constants (not read back from a run). */
export const STARTING_BALANCES = {
  mandate: pair(DEPOSITS),
  owner_intents: pair({ usdc: 0n, wnear: 0n }),
  filler: pair(FILLER_DEPOSITS),
};
