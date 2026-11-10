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

/**
 * Single configuration of the hosted site and the source repository. The names keep "planned" because recorded
 * evidence carries them (console-review `view.planned_url`); nothing derived from them may state whether the site is
 * or is not published: the same page bytes are read from a clone before publication and served on the site after it.
 */
export const PLANNED_SITE = "https://gryyny.github.io/bounded-mandate/";
/** Routes of the hosted site, relative to its base. Pages link to these relatively, never root-absolutely. */
export const SITE_PATHS = {
  console: "console/",
  video: "video/bounded-mandate-short.mp4",
  walkthrough: "video/bounded-mandate-demo.mp4",
} as const;
export const PLANNED_URLS = {
  page: PLANNED_SITE,
  console: `${PLANNED_SITE}${SITE_PATHS.console}`,
  video: `${PLANNED_SITE}${SITE_PATHS.video}`,
  walkthrough: `${PLANNED_SITE}${SITE_PATHS.walkthrough}`,
} as const;
export const REPO_URL = "https://github.com/gryyny/bounded-mandate";
/** Label recorded beside `view.planned_url` and shown beside the site's URLs: where it is served, not whether it is. */
export const PLANNED_LABEL = "hosted site";
/** Where the same files are in a clone: the certified bundle of a revision, relative to the repository root. */
export const bundlePaths = (revision: string): { page: string; console: string; video: string; walkthrough: string } => {
  const dir = `evidence/${revision.slice(0, 7)}`;
  return { page: `${dir}/page/index.html`, console: `${dir}/console/index.html`, video: `${dir}/${SITE_PATHS.video}`, walkthrough: `${dir}/${SITE_PATHS.walkthrough}` };
};
/** Where `make demo` writes the console view, relative to the repository root. */
export const CONSOLE_LOCAL_PATH = "out/console/index.html";

/** How the demo's owner actions in the console are signed; shown wherever such an action is narrated. */
export const OWNER_CONTROLS_LABEL = "owner controls via the local sandbox test signer (not a wallet)";
/** Where the demo's console review is read from. */
export const CONSOLE_BROWSER_LABEL = "owner console in headless Chromium";

/** A screenshot written by the demo, bound to its bytes. */
export const Screenshot = z.object({ path: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/) });
export type Screenshot = z.infer<typeof Screenshot>;

/** Values read from the rendered console's DOM in headless Chromium, as the owner sees them. */
export const ConsoleRendered = z.object({
  browser: z.string(),
  origin: z.string(),
  live_status: z.string(),
  /** The live badge, e.g. "live · Local sandbox · final block #123". */
  badge: z.string(),
  chain_verified: z.boolean(),
  deployment_matches: z.boolean(),
  owner_controls: z.string(),
  grant_status: z.string(),
  grant_line: z.string(),
  grant_key: z.string(),
  key_on_verifier: z.string(),
  limits: z.array(z.tuple([z.string(), z.string()])),
  mandate: z.array(z.tuple([z.string(), z.string()])),
  /** Mandate's Intents balance cell per asset label ("USDC", "wNEAR"). */
  mandate_balances: z.record(z.string(), z.string()),
  screenshot: Screenshot,
});
export type ConsoleRendered = z.infer<typeof ConsoleRendered>;

/** Observed values of the console-review assertion. */
export const ConsoleReview = z.object({
  state: StepState,
  config: z.object({ owner: z.string(), agent: z.string(), verifier: z.string(), usdc_token: z.string(), wnear_token: z.string() }),
  view: z.object({
    /** Repository-relative path of the console view rendered by this run, or null when this run rendered none. */
    local_path: z.string().nullable(),
    planned_url: z.string(),
    /** The label recorded at demo time; evidence up to 0bcb3f4 recorded "planned, unpublished". Readers do not display it. */
    planned_label: z.string(),
  }),
  /** Read from the rendered console; absent in older evidence, whose review compared Node views only. */
  rendered: ConsoleRendered.optional(),
  /** DOM values that differ from the chain views read in Node; empty when the console showed the chain state. */
  mismatches: z.array(z.string()).optional(),
});
export type ConsoleReview = z.infer<typeof ConsoleReview>;

/** Observed values of the revoke-through-console assertion. */
export const ConsoleRevoke = z.object({
  via: z.literal(OWNER_CONTROLS_LABEL),
  /** The review panel's rows as shown before signing. */
  preview: z.array(z.tuple([z.string(), z.string()])),
  /** Rows of the preview that differ from the independently derived intent; empty when exact. */
  preview_problems: z.array(z.string()),
  intent_sha256: z.string(),
  sign_requests: z.array(z.object({ intent_sha256: z.string().nullable(), status: z.string(), tx_hash: z.string().nullable() })),
  tx_hash: z.string().nullable(),
  ui_final: z.string().nullable(),
  outcome: z.enum(["success", "failure", "not-found"]),
  screenshot: Screenshot.nullable(),
});
export type ConsoleRevoke = z.infer<typeof ConsoleRevoke>;

/** What the withheld relay's rejection must show to count as the effect of revocation. */
export interface RelayRejectionInput {
  relaySucceeded: boolean;
  /** Error of the verifier's failed receipt; null when no verifier receipt failed. */
  verifierError: string | null;
  revokedKey: string;
  mandate: string;
  deadlineNs: bigint | null;
  /** Block time of the failed verifier receipt; null when not known. */
  rejectedAtNs: bigint | null;
  nonceUsed: boolean;
  balancesUnchanged: boolean;
}

/** The verifier's exact text for a signature by a key the account does not hold (defuse v0.4.5). */
export const removedKeyError = (key: string, account: string): string => `public key '${key}' doesn't exist for account '${account}'`;

/**
 * Why a relayed withheld order's failure is not evidence of revocation; empty when it is. Only the verifier's exact
 * removed-key error, at a block before the order's deadline, with the nonce unused and no balance change counts: a
 * malformed signature, an expired order or an unrelated failure never does.
 */
export function relayRejectionProblems(r: RelayRejectionInput): string[] {
  const out: string[] = [];
  if (r.relaySucceeded) out.push("the relay succeeded");
  if (r.verifierError === null) out.push("no verifier receipt failed");
  else if (!r.verifierError.includes(removedKeyError(r.revokedKey, r.mandate))) out.push(`the verifier error does not name the removed key: expected "${removedKeyError(r.revokedKey, r.mandate)}"`);
  if (r.deadlineNs === null) out.push("the order's deadline is not known");
  if (r.rejectedAtNs === null) out.push("the rejection's block time is not known");
  if (r.deadlineNs !== null && r.rejectedAtNs !== null && r.rejectedAtNs >= r.deadlineNs) out.push("the rejection's block is at or after the order's deadline");
  if (r.nonceUsed) out.push("the order's nonce was used");
  if (!r.balancesUnchanged) out.push("the mandate's balances changed");
  return out;
}

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
