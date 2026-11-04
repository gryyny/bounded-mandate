// The approved live manifest: every identity, key, code hash, step and budget the run may touch.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Asset, Policy, Proposal } from "../types.js";

const Units = z.string().regex(/^(0|[1-9][0-9]*)$/, "decimal integer string");
const AccountId = z
  .string()
  .min(2)
  .max(64)
  .regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "NEAR account id");
const PublicKey = z.string().regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/, "ed25519 public key");
const CodeHash = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "base58 code hash");
const PerAsset = z.object({ usdc: Units, wnear: Units }).strict();
const AssetConfig = z.object({ token: AccountId, decimals: z.number().int().min(0).max(30), price_id: z.string().min(1) }).strict();

export const OrderExpectation = z.enum(["signed", "rejected"]);

export const Step = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check") }).strict(),
  z.object({ kind: z.literal("grant"), policy: Policy.strict() }).strict(),
  z
    .object({
      kind: z.literal("propose"),
      source: z.discriminatedUnion("from", [
        z.object({ from: z.literal("manifest"), proposal: Proposal }).strict(),
        z.object({ from: z.literal("model"), provider: z.enum(["anthropic", "claude-cli"]), notes: z.array(z.string()) }).strict(),
      ]),
      expect: OrderExpectation.default("signed"),
    })
    .strict(),
  z.object({ kind: z.literal("fill"), order_id: Units.optional() }).strict(),
  z.object({ kind: z.literal("settle"), order_id: Units.optional() }).strict(),
  z.object({ kind: z.literal("revoke") }).strict(),
  z.object({ kind: z.literal("reconcile_registration") }).strict(),
  z.object({ kind: z.literal("recover"), asset: Asset }).strict(),
]);
export type Step = z.infer<typeof Step>;
export type StepKind = Step["kind"];

/** Prepaid gas per operation (TGas). Defaults cover the contract's documented minimums with margin. */
export const DEFAULT_GAS_TGAS = {
  grant: 250,
  propose: 150,
  fill: 100,
  settle: 50,
  revoke: 150,
  reconcile_registration: 200,
  recover: 80,
} as const;
const GasTgas = z
  .object({
    grant: z.number().int().positive().max(300),
    propose: z.number().int().positive().max(300),
    fill: z.number().int().positive().max(300),
    settle: z.number().int().positive().max(300),
    revoke: z.number().int().positive().max(300),
    reconcile_registration: z.number().int().positive().max(300),
    recover: z.number().int().positive().max(300),
  })
  .strict();

export const LiveManifest = z
  .object({
    schema_version: z.literal(2),
    /** Human notes for the approver; ignored by the runner. */
    notes: z.array(z.string()).optional(),
    network: z.object({ name: z.enum(["mainnet", "sandbox"]), chain_id: z.string().min(1), genesis_hash: CodeHash, rpc_url: z.url() }).strict(),
    approval: z.object({ approved_by: z.string().min(1), reference: z.string().min(1) }).strict(),
    accounts: z
      .object({ mandate: AccountId, owner: AccountId, agent: AccountId, filler: AccountId, verifier: AccountId, signer: AccountId, oracle: AccountId })
      .strict(),
    code_hashes: z.object({ mandate: CodeHash, verifier: CodeHash, signer: CodeHash, oracle: CodeHash }).strict(),
    /** NEP-330 `contract_source_metadata.version`, when pinned. */
    versions: z.object({ verifier: z.string(), signer: z.string(), oracle: z.string() }).partial().strict().default({}),
    mandate_config: z
      .object({
        owner_id: AccountId,
        agent_id: AccountId,
        verifier_id: AccountId,
        signer_id: AccountId,
        oracle_id: AccountId,
        usdc: AssetConfig,
        wnear: AssetConfig,
      })
      .strict(),
    keys: z
      .object({
        /** Upgrade-key policy: exactly these full-access keys on the mandate account ([] = locked). */
        mandate_full_access: z.array(PublicKey),
        agent: z.object({ public_key: PublicKey, max_allowance_yocto: Units }).strict(),
        owner: z.object({ public_key: PublicKey }).strict(),
        filler: z.object({ public_key: PublicKey, intents_public_key: PublicKey }).strict(),
      })
      .strict(),
    credentials: z.object({ owner: z.string(), agent: z.string(), filler: z.string(), filler_intents: z.string() }).strict(),
    budget: z
      .object({
        /** Cap on transaction fees: sum of tokens_burnt over every receipt of every transaction. */
        max_fee_yocto: Units,
        /** Cap on attached deposits (e.g. 1 yocto calls). */
        max_deposit_yocto: Units,
        max_transactions: z.number().int().positive(),
        /** Owner inventory: the mandate's Intents holdings may not exceed this when the run starts. */
        owner_inventory_max: PerAsset,
        /** Largest single order the mandate may sell (proposals and filled pre-existing orders). */
        max_order_sell: PerAsset,
        /** Cumulative units the mandate may sell in this run. */
        max_total_sell: PerAsset,
        /** Cumulative units the filler may pay out, fees included. */
        filler_spend_max: PerAsset,
      })
      .strict(),
    gas_tgas: GasTgas.default(DEFAULT_GAS_TGAS),
    /** Orders that existed before the run and may be filled/settled by it. Others are refused. */
    fillable_preexisting_orders: z.array(Units).default([]),
    /** Optional: access-key nonces at approval time; any earlier use of the keys refuses a fresh start. */
    expected_nonces: z.object({ owner: Units, agent: Units, filler: Units }).strict().optional(),
    steps: z.array(Step).min(1),
  })
  .strict();
export type LiveManifest = z.infer<typeof LiveManifest>;

export class Refusal extends Error {}

export interface LoadedManifest {
  manifest: LiveManifest;
  sha256: string;
  path: string;
}

export function loadManifest(env: NodeJS.ProcessEnv): LoadedManifest {
  if (env.MANDATE_LIVE !== "1") throw new Refusal("live: set MANDATE_LIVE=1 and MANDATE_LIVE_MANIFEST=<approved manifest>; the flag is not spending approval");
  const path = env.MANDATE_LIVE_MANIFEST;
  if (path === undefined || path === "") throw new Refusal("live: MANDATE_LIVE_MANIFEST is not set");
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    throw new Refusal(`live: cannot read manifest ${path}`);
  }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Refusal(`live: manifest ${path} is not JSON`);
  }
  const result = LiveManifest.safeParse(parsed);
  if (!result.success) throw new Refusal(`live: invalid manifest: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (result.data.network.name === "mainnet" && env.MANDATE_LIVE_CONFIRM !== sha256) {
    throw new Refusal(`live: mainnet requires MANDATE_LIVE_CONFIRM=<sha256 of the approved manifest> (this manifest: ${sha256})`);
  }
  return { manifest: result.data, sha256, path };
}
