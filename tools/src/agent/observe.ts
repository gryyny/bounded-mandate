// Read-only observer for a rehearsal before the first grant exists. It checks the RPC's chain id and genesis hash
// against the manifest, then reads, at one final block, the mandate's grant (none, or no account yet), its verifier
// balances and both oracle prices with the PLANNED policy's maximum age, and writes a rehearsal state file. It uses
// view calls only: no key, signer or transaction (asserted by tools/test/agent-rehearsal.test.ts).
//
//   npx tsx src/agent/observe.ts --manifest <manifest.json> --out <state.json> [--rpc <url>]
//
// Then: npx tsx src/agent/rehearse.ts --state <state.json> --manifest <manifest.json> ...
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { JsonRpcProvider, type Provider } from "near-api-js";
import { z } from "zod";
import { Policy } from "../types.js";
import { sha256Hex } from "./decision.js";
import type { FreshObservations } from "./objective.js";
import { readObservations, type ChainIds } from "./rebalance.js";

const AccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "NEAR account id (fill in the planned mandate account; it need not be deployed yet)");
const Asset = z.object({ token: AccountId, decimals: z.number().int().min(0).max(30), price_id: z.string().min(1) }).loose();

/** Only what the observer reads; the full manifest is validated by the live runner. */
export const ObserverManifest = z
  .object({
    network: z.object({ chain_id: z.string().min(1), genesis_hash: z.string().min(1), rpc_url: z.url() }).loose(),
    accounts: z.object({ mandate: AccountId, verifier: AccountId, oracle: AccountId }).loose(),
    mandate_config: z.object({ usdc: Asset, wnear: Asset }).loose(),
    steps: z.array(z.object({ kind: z.string() }).loose()),
  })
  .loose();
export type ObserverManifest = z.infer<typeof ObserverManifest>;

export interface ObservedState {
  schema: "bounded-mandate/rehearsal-state/1";
  observed_by: { tool: "src/agent/observe.ts"; manifest_sha256: string; rpc_url: string; chain_id: string; genesis_hash: string; planned_oracle_max_age_sec: number };
  observations: FreshObservations;
  decimals: { usdc: number; wnear: number };
  notes: string[];
}

/** The planned grant step's policy and the live model step's notes, from the manifest. */
export function plannedFromManifest(m: ObserverManifest): { policy: Policy; notes: string[] } {
  const grant = m.steps.find((s) => s.kind === "grant");
  if (grant === undefined) throw new Error("observe: the manifest has no grant step to plan from");
  const policy = Policy.strict().parse(grant.policy);
  const propose = m.steps.find((s) => s.kind === "propose" && z.object({ source: z.object({ from: z.literal("near-ai") }).loose() }).loose().safeParse(s).success);
  const notes = propose === undefined ? [] : z.array(z.string()).parse((propose.source as { notes?: unknown }).notes);
  return { policy, notes };
}

/** Observes at one final block after the network check; refuses (and reads nothing) on the wrong chain. */
export async function observe(provider: Pick<Provider, "viewNodeStatus" | "viewBlock" | "callFunctionRaw">, m: ObserverManifest, manifestText: string, rpcUrl: string): Promise<ObservedState> {
  const status = z.object({ chain_id: z.string(), genesis_hash: z.string() }).loose().parse(await provider.viewNodeStatus());
  if (status.chain_id !== m.network.chain_id || status.genesis_hash !== m.network.genesis_hash) {
    throw new Error(`observe: the RPC is on chain ${status.chain_id} (genesis ${status.genesis_hash}), the manifest names ${m.network.chain_id} (genesis ${m.network.genesis_hash}); nothing was read`);
  }
  const { policy, notes } = plannedFromManifest(m);
  const ids: ChainIds = {
    mandate: m.accounts.mandate,
    verifier: m.accounts.verifier,
    oracle: m.accounts.oracle,
    tokens: { usdc: m.mandate_config.usdc.token, wnear: m.mandate_config.wnear.token },
    priceIds: { usdc: m.mandate_config.usdc.price_id, wnear: m.mandate_config.wnear.price_id },
  };
  const observations = await readObservations({ provider: provider as Provider, finality: "final" }, ids, { plannedMaxAgeSec: policy.oracle_max_age_sec });
  return {
    schema: "bounded-mandate/rehearsal-state/1",
    observed_by: {
      tool: "src/agent/observe.ts",
      manifest_sha256: sha256Hex(manifestText),
      rpc_url: rpcUrl,
      chain_id: status.chain_id,
      genesis_hash: status.genesis_hash,
      planned_oracle_max_age_sec: policy.oracle_max_age_sec,
    },
    observations,
    decimals: { usdc: m.mandate_config.usdc.decimals, wnear: m.mandate_config.wnear.decimals },
    notes,
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { manifest: { type: "string" }, out: { type: "string" }, rpc: { type: "string" } } });
  const text = readFileSync(z.string().min(1).parse(values.manifest), "utf8");
  const m = ObserverManifest.parse(JSON.parse(text));
  const rpcUrl = values.rpc ?? m.network.rpc_url;
  const state = await observe(new JsonRpcProvider({ url: rpcUrl }), m, text, rpcUrl);
  const out = resolve(z.string().min(1).parse(values.out));
  writeFileSync(out, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  const o = state.observations;
  console.log(JSON.stringify({ path: out, block: o.block, grant: o.grant === null ? null : { epoch: o.grant.epoch, status: o.grant.status }, balances: o.balances, prices: o.prices, read_errors: o.read_errors }, null, 2));
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
