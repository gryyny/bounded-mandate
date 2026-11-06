// Journey evidence that `make demo` records inside demo.json and the page, the video and the console read: chain state
// after each demo step, the console review, the attack log's enforcement layers and the owner's withdrawal. Every value
// is recorded from execution; these schemas only name the fields. Older evidence without them still parses elsewhere:
// readers treat an absent field as "not recorded", never as a default.
import { z } from "zod";

const dec = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
export const AssetPair = z.object({ usdc: dec, wnear: dec });
export type AssetPair = z.infer<typeof AssetPair>;

/** Chain state read through views at the end of a demo step (environment.steps[i].state). */
export const StepState = z.object({
  /** "none" before the first grant, otherwise the contract's GrantStatus. */
  grant_status: z.string(),
  grant_epoch: z.number().int().nullable(),
  /** The grant key's registration on the verifier; null when there is no grant key. */
  key_present: z.boolean().nullable(),
  /** Orders in pricing, signing, signed or sign_unknown. */
  open_orders: z.number().int().nonnegative(),
  /** Intents balances of the mandate and the owner, and the owner's NEAR-side token balances. */
  mandate: AssetPair,
  owner_intents: AssetPair,
  owner_near: AssetPair,
  block_time_ns: dec,
});
export type StepState = z.infer<typeof StepState>;

export const DemoStep = z.object({
  step: z.string(),
  started_ms: z.number().nonnegative().optional(),
  first_receipt: z.number().int().nonnegative(),
  first_assertion: z.number().int().nonnegative(),
  state: StepState.optional(),
});
export type DemoStep = z.infer<typeof DemoStep>;

/** Parses environment.steps; null when absent or malformed (older evidence). */
export function demoSteps(environment: Record<string, string>): DemoStep[] | null {
  const raw = environment.steps;
  if (raw === undefined) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = z.array(DemoStep).safeParse(json);
  return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}

/** Single configuration of the planned (not yet published) hosting locations. Always shown with PLANNED_LABEL. */
export const PLANNED_SITE = "https://gryyny.github.io/bounded-mandate/";
export const PLANNED_URLS = { page: PLANNED_SITE, console: `${PLANNED_SITE}console/` } as const;
export const PLANNED_LABEL = "planned, unpublished";
/** Where `make demo` writes the console view, relative to the repository root. */
export const CONSOLE_LOCAL_PATH = "out/console/index.html";

/** Observed values of the console-review assertion. */
export const ConsoleReview = z.object({
  state: StepState,
  config: z.object({ owner: z.string(), agent: z.string(), verifier: z.string(), usdc_token: z.string(), wnear_token: z.string() }),
  view: z.object({
    /** Repository-relative path of the console view rendered by this run, or null when this run rendered none. */
    local_path: z.string().nullable(),
    planned_url: z.string(),
    planned_label: z.literal(PLANNED_LABEL),
  }),
});
export type ConsoleReview = z.infer<typeof ConsoleReview>;

/**
 * Enforcement layer of an attack, from the boundary the attack suite classified from the observed result
 * (src/attacks/suite.ts `classify`). This maps vocabulary only; it never assumes where an attack stopped.
 */
export const LAYERS = {
  "adapter-schema": { layer: "local validation", where: "agent adapter, before any transaction" },
  "near-access-key": { layer: "agent key permission", where: "NEAR protocol refused the transaction before inclusion" },
  "contract-role": { layer: "contract method check", where: "mandate contract: caller role or private callback" },
  "contract-schema": { layer: "contract method check", where: "mandate contract: strict input type" },
  "contract-policy": { layer: "policy validation", where: "mandate contract: grant policy" },
  verifier: { layer: "verifier", where: "Intents verifier: signing key check" },
} as const satisfies Record<string, { layer: string; where: string }>;

export function enforcementLayer(observed: string): { layer: string; where: string } {
  return observed in LAYERS ? LAYERS[observed as keyof typeof LAYERS] : { layer: observed === "not-stopped" ? "not stopped" : "unclassified", where: "no enforcement layer observed" };
}

/** A source line located from the observed failure text (demo time); null when no line could be located. */
export const SourceRef = z.object({ file: z.string(), line: z.number().int().positive(), excerpt: z.string() });
export type SourceRef = z.infer<typeof SourceRef>;

/** Fields the demo adds to each attack-* assertion's observed value. */
export const AttackLogFields = z.object({
  observed: z.string(),
  contained: z.boolean(),
  origin: z.string().optional(),
  layer: z.string().optional(),
  /** The failure text the enforcement layer produced (error or adapter reason). */
  reason: z.string().optional(),
  source: SourceRef.nullable().optional(),
  submitted: z.boolean().optional(),
  tx_hash: z.string().optional(),
  model_output: z.string().optional(),
});
export type AttackLogFields = z.infer<typeof AttackLogFields>;

export const WithdrawalAttempt = z.object({
  tx_hash: z.string().nullable(),
  success: z.boolean(),
  /** Amount the verifier's ft_withdraw returned (withdrawn units); null when it returned nothing. */
  returned: dec.nullable(),
  intents_after: dec,
  near_after: dec,
  error: z.string().nullable(),
});

export const AssetWithdrawal = z.object({
  asset: z.enum(["usdc", "wnear"]),
  token: z.string(),
  registration: z.object({ registered_before: z.boolean(), storage_deposit_tx: z.string().nullable(), deposit_yocto: dec, registered_after: z.boolean() }),
  amount: dec,
  intents_before: dec,
  near_before: dec,
  attempts: z.array(WithdrawalAttempt),
  outcome: z.enum(["withdrawn", "failed", "nothing-to-withdraw"]),
});
export type AssetWithdrawal = z.infer<typeof AssetWithdrawal>;

/** Observed values of the owner-withdrawal assertion: the owner's own action, outside every recovery claim. */
export const OwnerWithdrawal = z.object({
  owner: z.string(),
  verifier: z.string(),
  outside_recovery: z.literal(true),
  assets: z.array(AssetWithdrawal),
});
export type OwnerWithdrawal = z.infer<typeof OwnerWithdrawal>;
