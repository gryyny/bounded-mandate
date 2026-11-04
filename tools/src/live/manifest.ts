// The approved live manifest: every identity, key, code hash, step and budget the run may touch.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Asset, Policy, Proposal } from "../types.js";
import { networkProblems } from "./network.js";

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
  /** A deliberately forbidden proposal: the mandate's own receipt must fail with `error` and change nothing. */
  z.object({ kind: z.literal("refused_proposal"), proposal: Proposal, error: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("fill"), order_id: Units.optional() }).strict(),
  /**
   * Withholds a signed order of this run: the filler counter-signs a complete bundle without sending it,
   * and `simulate_intents` must accept it. The exact bundle is kept in the ledger for `relay_withheld`.
   */
  z.object({ kind: z.literal("withhold"), order_id: Units.optional() }).strict(),
  /**
   * After confirmed revocation, submits the withheld bundle before its deadline. Only a rejection for the
   * removed signing key, with both nonces unused and balances unchanged, counts as a passed revocation test.
   */
  z.object({ kind: z.literal("relay_withheld"), min_remaining_sec: z.number().int().min(1).max(3600).default(10) }).strict(),
  z.object({ kind: z.literal("settle"), order_id: Units.optional() }).strict(),
  z.object({ kind: z.literal("revoke") }).strict(),
  z.object({ kind: z.literal("reconcile_registration") }).strict(),
  z.object({ kind: z.literal("recover"), asset: Asset }).strict(),
]);
export type Step = z.infer<typeof Step>;
export type StepKind = Step["kind"];

/** A withheld order may be relayed only after a revocation step, and only once per withhold. */
export function sequenceProblems(steps: readonly Step[]): string[] {
  const p: string[] = [];
  let withheld = false;
  let revokedSinceWithhold = false;
  steps.forEach((s, i) => {
    if (s.kind === "withhold") {
      withheld = true;
      revokedSinceWithhold = false;
    } else if (s.kind === "revoke") {
      revokedSinceWithhold = true;
    } else if (withheld && (s.kind === "fill" || s.kind === "settle")) {
      p.push(`step ${i + 1} ${s.kind} between withhold and relay_withheld would act on the withheld order`);
    } else if (s.kind === "relay_withheld") {
      if (!withheld) p.push(`step ${i + 1} relay_withheld has no earlier withhold step`);
      else if (!revokedSinceWithhold) p.push(`step ${i + 1} relay_withheld must follow a revoke step after its withhold`);
      withheld = false;
    }
  });
  return p;
}

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
    /** Code hash of every contract the run relies on, including both token contracts (keyed by asset). */
    code_hashes: z.object({ mandate: CodeHash, verifier: CodeHash, signer: CodeHash, oracle: CodeHash, usdc: CodeHash, wnear: CodeHash }).strict(),
    /** NEP-330 `contract_source_metadata.version`, when pinned. */
    versions: z.object({ verifier: z.string(), signer: z.string(), oracle: z.string() }).partial().strict().default({}),
    /** Pinned verifier fee (pips); mainnet is 1. */
    verifier_fee_pips: z.number().int().min(0).max(1_000_000),
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
        /** 0 allows a read-only (check) run. */
        max_transactions: z.number().int().nonnegative(),
        /** Owner inventory: the mandate's Intents holdings may not exceed this when the run starts. */
        owner_inventory_max: PerAsset,
        /** Largest single order the mandate may sell (proposals and filled pre-existing orders). */
        max_order_sell: PerAsset,
        /** Cumulative units the mandate may sell in this run. */
        max_total_sell: PerAsset,
        /** Cumulative units the filler may pay out, fees included. */
        filler_spend_max: PerAsset,
        /** NEAR the owner must still hold (free of storage) after worst-case fees, for revoke/recover retries. */
        owner_recovery_reserve_yocto: Units,
      })
      .strict(),
    gas_tgas: GasTgas.default(DEFAULT_GAS_TGAS),
    /** Expected storage growth the mandate's free NEAR must cover. */
    storage: z
      .object({ order_record_bytes: z.number().int().positive(), grant_state_bytes: z.number().int().positive() })
      .strict()
      .default({ order_record_bytes: 1_000, grant_state_bytes: 2_000 }),
    /** A fresh start normally requires no active or in-flight grant; set to continue an existing grant. */
    expect_existing_grant: z.boolean().default(false),
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
  const sequence = sequenceProblems(result.data.steps);
  if (sequence.length > 0) throw new Refusal(`live: invalid step sequence: ${sequence.join("; ")}`);
  const shape = networkProblems(result.data);
  if (shape.length > 0) throw new Refusal(`live: manifest inconsistent with network ${result.data.network.name}: ${shape.join("; ")}`);
  if (result.data.network.name === "mainnet" && env.MANDATE_LIVE_CONFIRM !== sha256) {
    throw new Refusal(`live: mainnet requires MANDATE_LIVE_CONFIRM=<sha256 of the approved manifest> (this manifest: ${sha256})`);
  }
  return { manifest: result.data, sha256, path };
}
