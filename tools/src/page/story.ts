// The demo journey, bound to the demo evidence it shows. Nine detailed stages (grant, console review, bounded proposal
// and trade, hostile requests, withheld order, revocation, rejected relay, recovery, and the owner's separate
// withdrawal) group into the owner's eight-step journey (`ownerJourney`): the mandate's limits, a permitted trade,
// hostile requests refused, the withheld signed order, revocation, the same order rejected, recovery, withdrawal.
// The page's opening sequence and both video cuts read it. Every value comes from one run's assertions, receipts and
// recorded step states; a stage whose evidence is absent lists what is missing and shows no numbers. A stage whose check
// did not hold, or whose evidence is inconclusive, narrates that outcome instead of its success sentence; a journey step
// shows the worst outcome of its stages. Acceptance certification is separate.
import { z } from "zod";
import { SYSTEM_PROMPT } from "../agent/prompt.js";
import { VALUE_DECIMALS, formatPrice, valueUnits } from "../agent/snapshot.js";
import { DECIMALS } from "../demo/market.js";
import {
  AttackLogFields,
  CONSOLE_BROWSER_LABEL,
  ConsoleReview,
  ConsoleRevoke,
  OWNER_CONTROLS_LABEL,
  OwnerWithdrawal,
  PLANNED_LABEL,
  demoSteps,
  enforcementLayer,
  type StepState,
} from "../evidence/journey.js";
import { Policy, Reference, type Evidence, type Receipt } from "../types.js";

/** Decimal string of integer units with `decimals`, rounded down to `places`. */
export function units(raw: string, decimals: number, places: number): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const frac = ((abs % scale) * 10n ** BigInt(places)) / scale;
  const whole = (abs / scale).toLocaleString("en-US");
  return `${neg ? "-" : ""}${whole}${places > 0 ? `.${frac.toString().padStart(places, "0")}` : ""}`;
}
export const usdc = (raw: string): string => `${units(raw, DECIMALS.usdc, 2)} USDC`;
export const wnear = (raw: string): string => `${units(raw, DECIMALS.wnear, 4)} wNEAR`;
export const usd = (raw: string): string => `$${units(raw, VALUE_DECIMALS, 2)}`;
export const amount = (asset: string, raw: string): string => (asset === "usdc" ? usdc(raw) : asset === "wnear" ? wnear(raw) : `${raw} ${asset}`);
/** Reading form for the journey: USDC to the cent, wNEAR to at most 4 places without trailing zeros; both rounded down. */
export const readable = (asset: string, raw: string): string =>
  asset === "usdc" ? usdc(raw) : asset === "wnear" ? `${units(raw, DECIMALS.wnear, 4).replace(/\.?0+$/, "")} wNEAR` : `${raw} ${asset}`;
/** Shortened hash or key; a curve prefix such as "ed25519:" is kept. */
export const shortHash = (h: string): string => {
  const colon = h.indexOf(":") + 1;
  const body = h.slice(colon);
  return body.length > 16 ? `${h.slice(0, colon)}${body.slice(0, 6)}…${body.slice(-4)}` : h;
};
const pct = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;
/** UTC time of a nanosecond timestamp, to the millisecond. */
export const isoNs = (ns: string): string => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

/** The agent's objective, quoted from its system prompt. It is an instruction to the agent; the contract does not enforce it. */
export const AGENT_OBJECTIVE: string = /Objective: ([^.]+)\./.exec(SYSTEM_PROMPT)?.[1] ?? "not stated in the agent prompt";

export interface Split {
  units: { usdc: string; wnear: string };
  /** USD value at the reference prices, in 10^-12 USD, rounded down per asset. */
  value: { usdc: bigint; wnear: bigint; total: bigint };
  /** USDC share of the total value in hundredths of a percent, rounded to the nearest. */
  usdcShare: bigint;
}

export interface Allocation {
  /** The grant's initial reference, as recorded in grant-active. */
  reference: Reference;
  before: Split;
  after: Split;
}

/** "52.63%" from hundredths of a percent. */
export const share = (hundredths: bigint): string => `${(hundredths / 100n).toString()}.${(hundredths % 100n).toString().padStart(2, "0")}%`;
/** Distance of the USDC share from 50%, in percentage points. */
export const offBalance = (s: Split): string => share(s.usdcShare >= 5_000n ? s.usdcShare - 5_000n : 5_000n - s.usdcShare).replace("%", " pts");
export const priceText = (ref: Reference): string => `USDC $${formatPrice(ref.usdc)}, wNEAR $${formatPrice(ref.wnear)}`;


export type StageKey = "console" | "limits" | "trade" | "withheld" | "attacks" | "revoked" | "rejected" | "recovered" | "withdrawn";

export interface StageCheck {
  id: string;
  description: string;
  /** null: the assertion is not in this evidence. */
  held: boolean | null;
}

/** held: every check held; not-held: a check failed; inconclusive: the evidence cannot show the stage; missing: evidence absent. */
export type StageOutcome = "held" | "not-held" | "inconclusive" | "missing";

export interface Stage {
  key: StageKey;
  title: string;
  outcome: StageOutcome;
  /** The stage's main number line, or its failure/inconclusive statement; null when its evidence is missing. */
  headline: string | null;
  facts: [string, string][];
  /** Execution labels beyond the run's mode, e.g. recorded genuine model output. */
  labels: string[];
  receipts: { index: number; receipt: Receipt }[];
  checks: StageCheck[];
  /** Narration with this run's numbers, or of the failure/inconclusive outcome; null when evidence is missing. */
  caption: string | null;
  /** One short outcome line for the eight-step journey, with readable amounts; null when evidence is missing. */
  short: string | null;
  missing: string[];
  /** Chain state recorded at the end of the demo step this stage ends in; null when the evidence records none. */
  state: StepState | null;
}

/** Stage fields a stage builder supplies; `failure` replaces the generic sentence when a check did not hold. */
type Built = Pick<Stage, "headline" | "facts" | "labels" | "caption" | "short"> & { failure?: string };

const dec = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const Pair = z.object({ usdc: dec, wnear: dec });
const OrderLike = z.object({ id: z.string(), sell: z.string(), sell_amount: dec, buy: z.string(), buy_amount: dec.nullable() });
const Events = z.object({ signer_id: z.string().optional(), events: z.array(z.object({ event: z.string(), data: z.unknown() })) });

const SHAPES = {
  "trade-executed": z.object({ before: Pair, after: Pair, signed: z.object({ sell: z.string(), sell_amount: dec, buy: z.string(), buy_amount: dec.nullable() }) }),
  "grant-initial-value": z.object({ contract: dec }),
  "grant-active": z.object({ epoch: z.number(), path: z.string(), public_key: z.string().nullable(), policy: Policy, initial_reference: Reference.nullable().optional() }),
  "agent-one-restricted-key": z.array(z.object({ permission: z.object({ FunctionCall: z.object({ method_names: z.array(z.string()), receiver_id: z.string() }) }) })),
  "model-proposal-on-chain": z.object({ mode: z.string(), decision: z.object({ model: z.string(), adapter_verdict: z.object({ kind: z.string() }).optional() }).nullable(), order: OrderLike.extend({ concession_bps: z.number() }).nullable() }),
  revoked: z.object({ status: z.string().optional(), key_registered: z.boolean(), grant_public_key: z.string().nullable().optional() }),
  "console-review": ConsoleReview,
  "revoke-through-console": ConsoleRevoke,
  "owner-withdrawal": OwnerWithdrawal,
  "withheld-released": z.object({ state: z.string(), reason: z.string().optional() }),
  "withheld-rejected": z.object({
    error: z.string(),
    relay_block_time_ns: dec,
    order_deadline_ns: dec.nullable(),
    nonce_used: z.boolean(),
    relay_tx_hash: z.string().nullable().optional(),
    relayer: z.string().optional(),
    mandate: z.string().optional(),
    revoked_key: z.string().optional(),
    bundle_sha256: z.string().optional(),
    verifier_receipt: z.object({ id: z.string(), block_hash: z.string(), block_time_ns: dec }).nullable().optional(),
  }),
  recovered: z.object({ recovered: Pair, mandate_final: Pair, destination: z.string().optional() }),
} as const;
type Shape<K extends keyof typeof SHAPES> = z.infer<(typeof SHAPES)[K]>;

/** Identity of the withheld order and its simulation, recorded by newer demos; older evidence holds only "accepted". */
export const WithheldIdentity = z.object({
  simulation: z.string(),
  order_id: z.string(),
  epoch: z.number(),
  mandate: z.string(),
  signing_public_key: z.string(),
  mandate_nonce: z.string(),
  deadline_ns: dec.nullable(),
  payload_sha256: z.string().nullable(),
  bundle_sha256: z.string(),
  filler_nonce: z.string(),
});
export type WithheldIdentity = z.infer<typeof WithheldIdentity>;

export const withheldIdentity = (ev: Evidence): WithheldIdentity | null => {
  const parsed = WithheldIdentity.safeParse(ev.assertions.find((a) => a.id === "withheld-executable")?.observed);
  return parsed.success ? parsed.data : null;
};

function split(units: { usdc: string; wnear: string }, ref: Reference): Split {
  const usdcValue = valueUnits(BigInt(units.usdc), DECIMALS.usdc, ref.usdc);
  const wnearValue = valueUnits(BigInt(units.wnear), DECIMALS.wnear, ref.wnear);
  const total = usdcValue + wnearValue;
  return { units, value: { usdc: usdcValue, wnear: wnearValue, total }, usdcShare: total === 0n ? 0n : (usdcValue * 20_000n / total + 1n) / 2n };
}

/**
 * The mandate's allocation before and after the permitted trade (trade-executed), valued at the grant's initial
 * reference (grant-active). Integer arithmetic on recorded values; null with the reasons when either is absent.
 */
export function allocation(ev: Evidence): { ok: true; value: Allocation } | { ok: false; missing: string[] } {
  const trade = SHAPES["trade-executed"].safeParse(ev.assertions.find((a) => a.id === "trade-executed")?.observed);
  const grant = SHAPES["grant-active"].safeParse(ev.assertions.find((a) => a.id === "grant-active")?.observed);
  const ref = grant.success ? (grant.data.initial_reference ?? null) : null;
  const missing = [...(trade.success ? [] : ["balances before and after the trade (trade-executed)"]), ...(ref === null ? ["the grant's initial reference prices (grant-active)"] : [])];
  if (!trade.success || ref === null) return { ok: false, missing };
  return { ok: true, value: { reference: ref, before: split(trade.data.before, ref), after: split(trade.data.after, ref) } };
}

/** Collects the evidence one stage is bound to, and what is missing. */
class Binder {
  readonly missing: string[] = [];
  readonly checks: StageCheck[] = [];
  readonly receipts: { index: number; receipt: Receipt }[] = [];
  readonly inconclusive: string[] = [];
  /** Indices of the assertions this stage checked. */
  readonly assertionIndices: number[] = [];

  constructor(
    private readonly ev: Evidence,
    private readonly claimed: Set<number>,
  ) {}

  check(id: string): boolean | null {
    const a = this.ev.assertions.find((x) => x.id === id);
    if (a === undefined) {
      this.missing.push(`assertion ${id}`);
      this.checks.push({ id, description: "not in this evidence", held: null });
      return null;
    }
    this.checks.push({ id, description: a.description, held: a.passed });
    this.assertionIndices.push(this.ev.assertions.indexOf(a));
    return a.passed;
  }

  observed<K extends keyof typeof SHAPES>(id: K): Shape<K> | null {
    if (this.check(id) === null) return null;
    const parsed = SHAPES[id].safeParse(this.ev.assertions.find((x) => x.id === id)?.observed);
    if (!parsed.success) {
      this.missing.push(`observed values of assertion ${id}`);
      return null;
    }
    return parsed.data as Shape<K>;
  }

  /** Claims every not yet claimed receipt whose label matches, in evidence order. */
  tx(pattern: RegExp): Receipt[] {
    const found = this.ev.receipts.flatMap((receipt, index) => (pattern.test(receipt.label) && !this.claimed.has(index) ? [{ index, receipt }] : []));
    if (found.length === 0) this.missing.push(`receipt matching /${pattern.source}/`);
    for (const f of found) this.claimed.add(f.index);
    this.receipts.push(...found);
    return found.map((f) => f.receipt);
  }
}

/** Why a recorded console revocation did not hold, from its observed values. */
const consoleRevokeFailure = (r: ConsoleRevoke): string => {
  const reasons = [
    ...(r.preview_problems.length > 0 ? [`preview differs: ${r.preview_problems.join("; ")}`] : []),
    ...(r.sign_requests.length === 1 ? [] : [`${String(r.sign_requests.length)} sign requests, expected 1`]),
    ...(r.outcome === "success" ? [] : [r.outcome === "not-found" ? "no revoke transaction found on chain" : `revoke transaction ${r.tx_hash ?? ""} failed`]),
  ];
  return reasons.length > 0 ? reasons.join("; ") : "the revoke-through-console check failed";
};

const verifierReason = (error: string): string =>
  (/ExecutionError\\?":\\?"([^"\\]+)/.exec(error)?.[1] ?? error).replace(/^Smart contract panicked: /, "");

/** One line of chain state: grant status, key, open orders and balances. */
export function stateLine(st: StepState): string {
  const key = st.key_present === null ? "no grant key" : st.key_present ? "key registered" : "key removed";
  return `grant ${st.grant_status} · ${key} · open orders ${String(st.open_orders)} · mandate ${usdc(st.mandate.usdc)} + ${wnear(st.mandate.wnear)} · owner Intents ${usdc(st.owner_intents.usdc)} + ${wnear(st.owner_intents.wnear)} · owner NEAR ${usdc(st.owner_near.usdc)} + ${wnear(st.owner_near.wnear)}`;
}

/** Index of the demo step containing a receipt or assertion index, from the recorded step offsets. */
const stepAt = (starts: readonly number[], index: number): number => {
  let found = -1;
  starts.forEach((start, i) => {
    if (start <= index) found = i;
  });
  return found;
};

const ASSET_NAME: Record<string, string> = { usdc: "USDC", wnear: "wNEAR" };

/** The attack-* assertions with their enforcement layer, derived from the boundary each attack actually reached. */
export interface AttackRow {
  index: number;
  id: string;
  description: string;
  passed: boolean;
  origin: string | null;
  observed: string;
  layer: string;
  where: string;
  contained: boolean | null;
  reason: string | null;
  source: { file: string; line: number; excerpt: string } | null;
  submitted: boolean | null;
  tx_hash: string | null;
  model_output: string | null;
}

export function attackRows(ev: Evidence): AttackRow[] {
  return ev.assertions.flatMap((a, index) => {
    if (!a.id.startsWith("attack-")) return [];
    const o = AttackLogFields.safeParse(a.observed);
    const origin = /\((injected-request|scripted-direct)\)\s*$/.exec(a.description)?.[1] ?? null;
    const observed = o.success ? o.data.observed : "unclassified";
    const layer = enforcementLayer(observed);
    return [
      {
        index,
        id: a.id,
        description: a.description.replace(/ -> stopped by [a-z-]+ \((injected-request|scripted-direct)\)$/, ""),
        passed: a.passed,
        origin: o.success ? (o.data.origin ?? origin) : origin,
        observed,
        layer: layer.layer,
        where: layer.where,
        contained: o.success ? o.data.contained : null,
        reason: o.success ? (o.data.reason ?? null) : null,
        source: o.success ? (o.data.source ?? null) : null,
        submitted: o.success ? (o.data.submitted ?? null) : null,
        tx_hash: o.success ? (o.data.tx_hash ?? null) : null,
        model_output: o.success ? (o.data.model_output ?? null) : null,
      },
    ];
  });
}

/** Attacks refused per enforcement layer, in order of first appearance. */
export const layerCounts = (rows: readonly AttackRow[]): [string, number][] => {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.passed && r.contained === true) counts.set(r.layer, (counts.get(r.layer) ?? 0) + 1);
  return [...counts.entries()];
};

/** The nine detailed stages, in journey order (hostile requests before the withheld order), from one run's evidence. */
export function revocationStory(ev: Evidence): Stage[] {
  const claimed = new Set<number>();
  const steps = demoSteps(ev.environment);
  const stateOf = (b: Binder): StepState | null => {
    if (steps === null) return null;
    const r = b.receipts.length === 0 ? -1 : stepAt(steps.map((s) => s.first_receipt), Math.max(...b.receipts.map((x) => x.index)));
    const a = b.assertionIndices.length === 0 ? -1 : stepAt(steps.map((s) => s.first_assertion), Math.max(...b.assertionIndices));
    const i = Math.max(r, a);
    return i < 0 ? null : (steps[i]?.state ?? null);
  };
  const stage = (key: StageKey, title: string, build: (b: Binder) => Built): Stage => {
    const b = new Binder(ev, claimed);
    const { failure, ...built } = build(b);
    const failed = b.checks.filter((c) => c.held === false);
    const outcome: StageOutcome = b.missing.length > 0 ? "missing" : b.inconclusive.length > 0 ? "inconclusive" : failed.length > 0 ? "not-held" : "held";
    const notHeld = failed.map((c) => `"${c.description}" (${c.id})`).join("; ");
    const failedSentence = failed.length === 0 ? "" : ` Check ${notHeld} did not hold.`;
    const narration: Record<StageOutcome, { headline: string | null; caption: string | null; short: string | null }> = {
      held: { headline: built.headline, caption: built.caption, short: built.short },
      missing: { headline: null, caption: null, short: null },
      inconclusive: {
        headline: `inconclusive: ${b.inconclusive.join("; ")}`,
        caption: `${title} is inconclusive in this run: ${b.inconclusive.join("; ")}.${failedSentence} This stage is not shown as evidence.`,
        short: `inconclusive: ${b.inconclusive.join("; ")}`,
      },
      "not-held": {
        headline: `did not hold: ${failed.map((c) => c.id).join(", ")}`,
        caption: failure === undefined ? `${title}: in this run, check ${notHeld} did not hold. This stage is not shown as evidence.` : `${failure} This stage is not shown as evidence.`,
        short: failure === undefined ? `did not hold: ${failed.map((c) => c.id).join(", ")}` : failure,
      },
    };
    return { key, title, outcome, ...built, ...narration[outcome], receipts: b.receipts, checks: b.checks, missing: b.missing, state: stateOf(b) };
  };
  const mandate = ev.identifiers.mandate ?? "the mandate";
  const owner = ev.identifiers.owner ?? "the owner";
  const initial = SHAPES["grant-initial-value"].safeParse(ev.assertions.find((a) => a.id === "grant-initial-value")?.observed);
  const grantKey = SHAPES["grant-active"].safeParse(ev.assertions.find((a) => a.id === "grant-active")?.observed);

  return [
    stage("limits", "Grant and limits", (b) => {
      b.tx(/^owner grant$/);
      const grant = b.observed("grant-active");
      const value = b.observed("grant-initial-value");
      const p = grant?.policy;
      const cap = (bps: number): string => (initial.success ? ` (${usd(((BigInt(initial.data.contract) * BigInt(bps)) / 10_000n).toString())})` : "");
      return {
        headline: p === undefined ? null : `≤ ${pct(p.per_order_cap_bps)} per order · ≤ ${pct(p.max_concession_bps)} price concession`,
        facts:
          p === undefined || grant === null
            ? []
            : [
                ...(value === null ? [] : [["Reference value", usd(value.contract)] as [string, string]]),
                ["Per-order cap", `${pct(p.per_order_cap_bps)} of initial value${cap(p.per_order_cap_bps)}`],
                ["Outstanding cap", `${pct(p.outstanding_cap_bps)}${cap(p.outstanding_cap_bps)}`],
                ["Turnover cap", pct(p.turnover_cap_bps)],
                ["Order deadline", `${String(p.order_ttl_sec)} s`],
                ["Grant key path", grant.path],
              ],
        labels: [],
        caption:
          p === undefined || value === null
            ? null
            : `The owner grants fixed limits on ${usd(value.contract)}: each order at most ${String(p.per_order_cap_bps / 100)}%${cap(p.per_order_cap_bps)}, price concession at most ${String(p.max_concession_bps / 100)}%.`,
        short: p === undefined || value === null ? null : `${usd(value.contract)} under mandate at the ${ev.mode === "sandbox" ? "sandbox's " : ""}reference prices; each order at most ${String(p.per_order_cap_bps / 100)}%${cap(p.per_order_cap_bps)}, price concession at most ${String(p.max_concession_bps / 100)}%`,
      };
    }),
    stage("console", "Reviewed in the console", (b) => {
      const review = b.observed("console-review");
      const keys = b.observed("agent-one-restricted-key");
      b.check("mandate-no-keys");
      const methods = keys?.map((k) => k.permission.FunctionCall.method_names.join(", ")).join("; ") ?? "";
      const shown = review?.rendered;
      // Older demos compared Node views only and never opened the console; that is not a console review.
      if (review !== null && shown === undefined) b.inconclusive.push("this evidence records no values read from the rendered console");
      if (review !== null && (review.mismatches ?? []).length > 0) b.inconclusive.push(`the console showed values that differ from the chain: ${(review.mismatches ?? []).join("; ")}`);
      const view = review?.view;
      const largest = shown?.limits.find(([k]) => k === "Largest single order")?.[1];
      return {
        headline: shown === undefined ? null : `grant ${shown.grant_status} · key ${shown.key_on_verifier.replace(/ on .*$/, "")} · ${shown.mandate_balances.USDC ?? "?"} USDC + ${shown.mandate_balances.wNEAR ?? "?"} wNEAR`,
        facts:
          review === null || shown === undefined
            ? []
            : [
                ["Read in", `${CONSOLE_BROWSER_LABEL}, ${shown.browser.replace(/ headless \(playwright\)$/, "")}`],
                ["Console read", `${/final block #[0-9]+/.exec(shown.badge)?.[0] ?? "block not shown"} of the sandbox; chain and deployment ${shown.chain_verified && shown.deployment_matches ? "matched" : "did not match"}`],
                ["Limits as shown", `${String(shown.limits.length)} rows${largest === undefined ? "" : `; largest order ${largest}`}`],
                ["Signer connected", OWNER_CONTROLS_LABEL],
                ["Grant key as shown", shown.grant_key],
                ["Fixed owner", review.config.owner],
                ["Agent's only key", methods === "" ? "not recorded" : `${methods} on ${mandate}`],
                ["Served at", shown.origin],
                ["Screenshot", shown.screenshot.path],
                ["Static console view", view?.local_path ?? "not rendered by this run"],
                ["Console URL", `${view?.planned_url ?? ""} (${PLANNED_LABEL})`],
              ],
        labels: [CONSOLE_BROWSER_LABEL],
        caption:
          shown === undefined || methods === ""
            ? null
            : `The owner console reads it back from the sandbox: grant ${shown.grant_status}, key ${shown.key_on_verifier.replace(/ on .*$/, "")} on the verifier, limits as granted.`,
        short: shown === undefined ? null : `read in the owner console: grant ${shown.grant_status}, key ${shown.key_on_verifier.replace(/ on .*$/, "")}, limits as granted`,
      };
    }),
    stage("trade", "Bounded proposal and trade", (b) => {
      // Older demos labelled the first proposal "order 1", by position; its on-chain id is 0.
      b.tx(/propose_order \((order 1|first order)\)/);
      b.tx(/execute_intents order/);
      b.tx(/^settle_order/);
      const model = b.observed("model-proposal-on-chain");
      const trade = b.observed("trade-executed");
      b.check("settled-release");
      // Model output only when the replayed verdict was a proposal: after a decline or a refusal the first order is scripted.
      const modelName = model !== null && model.mode === "recorded-model" && model.decision?.adapter_verdict?.kind === "proposal" ? model.decision.model : null;
      const reason = modelReason(ev);
      const s = trade?.signed;
      const alloc = allocation(ev);
      const moved = alloc.ok ? `${share(alloc.value.before.usdcShare)} → ${share(alloc.value.after.usdcShare)}` : null;
      return {
        headline: s === undefined || s.buy_amount === null ? null : `sold ${amount(s.sell, s.sell_amount)} → bought ${amount(s.buy, s.buy_amount)}`,
        facts:
          trade === null || model === null
            ? []
            : [
                ["Proposed by", modelName === null ? "a scripted proposal" : `recorded output of ${modelName}`],
                ...(modelName === null || reason === null ? [] : [["Agent's reason (recorded)", reason.length > 220 ? `${reason.slice(0, 217)}…` : reason] as [string, string]]),
                ...(model.order === null ? [] : [["Order id", `${model.order.id}, concession ≤ ${String(model.order.concession_bps)} bps`] as [string, string]]),
                ["Mandate after", `${usdc(trade.after.usdc)} + ${wnear(trade.after.wnear)}`],
                ...(moved === null ? [] : [["USDC share of value", `${moved} (target 50%, at the grant's reference prices)`] as [string, string]]),
              ],
        labels: modelName === null ? ["scripted proposal"] : ["recorded genuine model output"],
        caption:
          s === undefined || s.buy_amount === null
            ? null
            : moved === null
              ? `${modelName === null ? "A scripted proposal" : `A recorded ${modelName} proposal, replayed,`} sells ${readable(s.sell, s.sell_amount)}. The contract signs it, and our filler executes it for ${readable(s.buy, s.buy_amount)}, exactly as signed.`
              : // Kept to one caption frame: the allocation replaces words, not adds a frame.
                `${modelName === null ? "A scripted proposal" : `A recorded ${modelName} proposal, replayed,`} sells ${readable(s.sell, s.sell_amount)} for ${readable(s.buy, s.buy_amount)}, filled exactly as signed. USDC share: ${moved.replace(" → ", " to ")}, target 50%.`,
        short:
          s === undefined || s.buy_amount === null
            ? null
            : `sold ${readable(s.sell, s.sell_amount)} for ${readable(s.buy, s.buy_amount)}, as signed; proposed by ${modelName === null ? "a scripted proposal" : `recorded ${modelName} output (replayed)`}`,
      };
    }),
    stage("attacks", "Hostile requests", (b) => {
      const rows = attackRows(ev);
      if (rows.length === 0) b.missing.push("attack-* assertions");
      for (const r of rows) b.check(r.id);
      const injected = ev.assertions.some((a) => a.id === "injection-recording") ? b.check("injection-recording") : null;
      const counts = layerCounts(rows);
      const refused = counts.reduce((sum, [, n]) => sum + n, 0);
      const notContained = rows.filter((r) => r.contained === false).length;
      if (rows.length > 0 && rows.some((r) => r.contained === null)) b.inconclusive.push("this evidence does not record whether each attack changed state");
      return {
        headline: rows.length === 0 ? null : `${String(refused)} of ${String(rows.length)} refused · state unchanged${notContained > 0 ? ` except ${String(notContained)}` : ""}`,
        facts: [...counts.map(([layer, n]): [string, string] => [sentenceStart(layer), `${String(n)} refused`]), ...(injected === null ? [] : [["Injected prompt", "a recorded genuine model response to it left the adapter only as a strict proposal or a decline"] as [string, string]])],
        labels: ["scripted attacks", ...(injected === null ? [] : ["recorded genuine model output"])],
        caption:
          rows.length === 0
            ? null
            : `${String(refused)} of ${String(rows.length)} scripted hostile requests refused, nothing changed: ${counts.map(([l, n]) => `${l} ${String(n)}`).join(", ")}.`,
        short: rows.length === 0 ? null : `${String(refused)} of ${String(rows.length)} scripted hostile requests refused, no state changed${injected === null ? "" : "; an injected prompt could not express a withdrawal"}`,
        failure: `Hostile requests: in this run ${String(rows.length - refused)} of ${String(rows.length)} were not refused at their expected layer with no state change.`,
      };
    }),
    stage("withheld", "Signed order withheld", (b) => {
      const [r] = b.tx(/scripted, withheld/);
      const executable = b.check("withheld-executable");
      const detail = Events.safeParse(r?.detail);
      const signRequested = detail.success ? detail.data.events.find((e) => e.event === "order_sign_requested") : undefined;
      const order = z.object({ order: OrderLike }).safeParse(signRequested?.data);
      if (r !== undefined && !order.success) b.missing.push("signed order in the withheld receipt's events");
      const o = order.success ? order.data.order : null;
      const id = withheldIdentity(ev);
      const key = grantKey.success ? grantKey.data.public_key : null;
      if (id !== null && o !== null && id.order_id !== o.id) b.inconclusive.push(`the simulated order ${id.order_id} is not the signed order ${o.id}`);
      if (id !== null && key !== null && id.signing_public_key !== key) b.inconclusive.push("the withheld order was not signed by the grant key");
      const identity: [string, string][] =
        id === null
          ? [["Identity", "order nonce, deadline and bundle hash are not recorded in this evidence"]]
          : [
              ["Mandate nonce", id.mandate_nonce],
              ...(id.deadline_ns === null ? [] : [["Deadline", `${isoNs(id.deadline_ns)} (${id.deadline_ns} ns)`] as [string, string]]),
              ["Signing key", id.signing_public_key],
              ...(id.payload_sha256 === null ? [] : [["NEP-413 payload hash", id.payload_sha256] as [string, string]]),
              ["Bundle sha256", id.bundle_sha256],
            ];
      return {
        headline: o === null || o.buy_amount === null ? null : `order id ${o.id}: ${amount(o.sell, o.sell_amount)} → ${amount(o.buy, o.buy_amount)}`,
        facts: [
          ["State", "signed by the grant key, withheld from the verifier"],
          ...(executable === true ? [["Before revoke", id === null ? "the verifier's simulation accepts it" : "the verifier's simulation (simulate_intents) accepts this exact bundle"] as [string, string]] : []),
          ...identity,
        ],
        labels: ["scripted proposal"],
        caption:
          o === null || o.buy_amount === null
            ? null
            : `A second, scripted order, ${readable(o.sell, o.sell_amount)} for ${readable(o.buy, o.buy_amount)}, is signed by the grant key and withheld. The verifier would still accept it.`,
        short:
          o === null || o.buy_amount === null
            ? null
            : `order id ${o.id}: ${readable(o.sell, o.sell_amount)} for ${readable(o.buy, o.buy_amount)}, signed by the grant key${id === null ? "" : ` ${shortHash(id.signing_public_key)}`} and held back${executable === true ? "; the verifier's simulation accepts it" : ""}${id === null ? "" : ` (bundle sha256 ${id.bundle_sha256.slice(0, 8)}…)`}`,
      };
    }),
    stage("revoked", "Owner revocation", (b) => {
      b.tx(/^owner revoke/);
      // Newer demos revoke through the console's owner controls; older ones called revoke directly.
      const viaConsole = ev.assertions.some((a) => a.id === "revoke-through-console") ? b.observed("revoke-through-console") : null;
      const revoked = b.observed("revoked");
      const released = b.observed("withheld-released");
      const key = revoked?.grant_public_key ?? (grantKey.success ? grantKey.data.public_key : null);
      const direct = !ev.assertions.some((a) => a.id === "revoke-through-console");
      const consoleHeld = ev.assertions.find((a) => a.id === "revoke-through-console")?.passed === true;
      return {
        headline: revoked === null ? null : `grant ${revoked.status ?? "revoked"} · key registered: ${revoked.key_registered ? "yes" : "no"}`,
        facts: [
          viaConsole !== null && !consoleHeld
            ? ["Revocation", `console revocation did not hold: ${consoleRevokeFailure(viaConsole)}`]
            : ["Through", viaConsole === null ? (direct ? "a direct owner call (not through the console)" : "not recorded") : `the console's Revoke control, ${OWNER_CONTROLS_LABEL}`],
          ...(viaConsole === null || !consoleHeld
            ? []
            : ([
                ["Preview", viaConsole.preview_problems.length === 0 ? "exact: receiver, method, arguments, gas and deposit as derived" : `differs: ${viaConsole.preview_problems.join("; ")}`],
                ["Sign requests", String(viaConsole.sign_requests.length)],
                ["Transaction", viaConsole.tx_hash ?? "none"],
              ] as [string, string][])),
          ...(key === null ? [] : [["Removed key", key] as [string, string]]),
          ...(released === null ? [] : [["Withheld order", `${released.state}${released.reason === undefined ? "" : ` (${released.reason})`}`] as [string, string]]),
        ],
        labels: viaConsole === null ? [] : [OWNER_CONTROLS_LABEL],
        caption:
          revoked === null
            ? null
            : viaConsole === null
              ? "The owner revokes the grant with a direct owner call. The verifier confirms its key is removed; only then is the withheld reservation released."
              : "After an exact preview, the owner revokes in the console with the local sandbox test signer, not a wallet. Key removal is confirmed.",
        short:
          revoked === null
            ? null
            : `${viaConsole === null ? "revoked by a direct owner call" : "revoked in the owner console, signed by the local sandbox test signer (not a wallet)"}; key removal confirmed`,
      };
    }),
    stage("rejected", "Withheld order relayed", (b) => {
      const [r] = b.tx(/withheld order after revocation/);
      const rej = b.observed("withheld-rejected");
      const relayer = Events.safeParse(r?.detail);
      // The failed verifier receipt's block time when recorded; older evidence has only the block time read just before the relay.
      const atNs = rej?.verifier_receipt?.block_time_ns ?? rej?.relay_block_time_ns ?? null;
      const leftNs = rej?.order_deadline_ns == null || atNs === null ? null : BigInt(rej.order_deadline_ns) - BigInt(atNs);
      const broadcastNs = rej?.order_deadline_ns == null ? null : BigInt(rej.order_deadline_ns) - BigInt(rej.relay_block_time_ns);
      const secondsLeft = leftNs === null ? null : Number(leftNs / 1_000_000_000n);
      if (rej !== null && leftNs === null) b.inconclusive.push("the withheld order's deadline is not recorded");
      // The verifier expires orders strictly after the deadline. This demo requires a positive margin before it.
      if (leftNs !== null && leftNs <= 0n) {
        b.inconclusive.push(
          leftNs === 0n
            ? "the recorded relay time equals the order deadline. This demonstration requires a positive margin before the deadline"
            : `the withheld order was relayed ${units((-leftNs).toString(), 9, 1)} s after its deadline, so its rejection does not show the effect of revocation`,
        );
      }
      if (broadcastNs !== null && broadcastNs <= 0n && (leftNs === null || leftNs > 0n)) b.inconclusive.push("the withheld order had no lifetime left when the relay was broadcast");
      const key = rej?.revoked_key ?? (grantKey.success ? grantKey.data.public_key : null);
      const id = withheldIdentity(ev);
      if (rej !== null && key === null) b.inconclusive.push("the removed signing key is not recorded");
      if (rej !== null && key !== null && !rej.error.includes(`public key '${key}' doesn't exist for account '${rej.mandate ?? mandate}'`)) {
        b.inconclusive.push("the verifier error does not name the removed grant key");
      }
      if (rej?.bundle_sha256 !== undefined && id !== null && rej.bundle_sha256 !== id.bundle_sha256) b.inconclusive.push("the relayed bundle is not the simulated bundle");
      const receipt = rej?.verifier_receipt ?? null;
      return {
        headline: rej === null || secondsLeft === null ? null : `rejected ${String(secondsLeft)} s before its deadline`,
        facts:
          rej === null
            ? []
            : [
                ["Relayed by", rej.relayer ?? (relayer.success && relayer.data.signer_id !== undefined ? relayer.data.signer_id : "another account")],
                ["Verifier error", verifierReason(rej.error)],
                ...(broadcastNs === null ? [] : [["Lifetime left at broadcast", `${units(broadcastNs.toString(), 9, 1)} s`] as [string, string]]),
                ...(rej.order_deadline_ns === null ? [] : [["Deadline", isoNs(rej.order_deadline_ns)] as [string, string]]),
                receipt === null
                  ? ["Block time before relay", isoNs(rej.relay_block_time_ns)]
                  : ["Rejected in block", `${receipt.block_hash} at ${isoNs(receipt.block_time_ns)}`],
                ["Nonce used", rej.nonce_used ? "yes" : "no"],
                ...(rej.bundle_sha256 === undefined || id === null ? [] : [["Same bundle as simulated", rej.bundle_sha256 === id.bundle_sha256 ? "yes (bundle sha256 matches)" : "no"] as [string, string]]),
              ],
        labels: [],
        caption:
          secondsLeft === null ? null : `Another account relays the withheld order ${String(secondsLeft)} s before its deadline. The verifier rejects it: the signing key no longer exists.`,
        short:
          secondsLeft === null
            ? null
            : `${rej?.bundle_sha256 !== undefined && id !== null && rej.bundle_sha256 === id.bundle_sha256 ? `the same bundle (sha256 ${id.bundle_sha256.slice(0, 8)}…)` : "the withheld order"}, relayed by another account ${String(secondsLeft)} s before its deadline; the verifier rejects it because the signing key no longer exists`,
      };
    }),
    stage("recovered", "Recovery to the owner's Intents account", (b) => {
      b.tx(/set_fail|set_mode|propose_order after revocation/);
      b.tx(/^owner recover/);
      const rec = b.observed("recovered");
      b.check("agent-stopped");
      return {
        headline: rec === null ? null : `${usdc(rec.recovered.usdc)} + ${wnear(rec.recovered.wnear)} to the owner's Intents account`,
        facts:
          rec === null
            ? []
            : [
                ["Destination", `${owner} (owner's Intents account, not an external wallet)`],
                ["Mandate left", `${usdc(rec.mandate_final.usdc)} + ${wnear(rec.mandate_final.wnear)}`],
                ["Without", "agent (rejected), oracle (failing), MPC test double (on hold)"],
              ],
        labels: ["ordinary recovery (not the owner-key rescue)"],
        caption:
          rec === null
            ? null
            : `With the oracle failing and the MPC test double on hold, the owner recovers ${readable("usdc", rec.recovered.usdc)} and ${readable("wnear", rec.recovered.wnear)} into its Intents account.`,
        short: rec === null ? null : `${readable("usdc", rec.recovered.usdc)} and ${readable("wnear", rec.recovered.wnear)} to the owner's Intents account, with the oracle failing and the MPC test double on hold`,
      };
    }),
    stage("withdrawn", "Owner withdrawal to NEAR", (b) => {
      b.tx(/^owner storage_deposit|^owner ft_withdraw/);
      const w = b.observed("owner-withdrawal");
      const done = w?.assets.filter((a) => a.outcome === "withdrawn") ?? [];
      const failed = w?.assets.filter((a) => a.outcome === "failed") ?? [];
      const reg = (a: (typeof done)[number]): string =>
        a.registration.registered_before ? "already registered" : a.registration.storage_deposit_tx === null ? "not registered" : `registered first (tx ${shortHash(a.registration.storage_deposit_tx)})`;
      const amountOf = (a: (typeof done)[number]): string => amount(a.asset, a.amount);
      const failedText = failed
        .map((a) => `${ASSET_NAME[a.asset] ?? a.asset} withdrawal failed after ${String(a.attempts.length)} attempt${a.attempts.length === 1 ? "" : "s"} (${a.attempts.at(-1)?.error ?? "not registered on the token, so not attempted"}); ${amount(a.asset, a.attempts.at(-1)?.intents_after ?? a.intents_before)} stays in the owner's Intents account`)
        .join(". ");
      return {
        headline: w === null || done.length === 0 ? null : `${done.map(amountOf).join(" + ")} to ${w.owner}'s NEAR account`,
        facts:
          w === null
            ? []
            : [
                ...w.assets.map((a): [string, string] => [
                  ASSET_NAME[a.asset] ?? a.asset,
                  a.outcome === "withdrawn"
                    ? `${amountOf(a)} withdrawn; ${reg(a)}; NEAR balance ${amount(a.asset, a.near_before)} → ${amount(a.asset, a.attempts.at(-1)?.near_after ?? "0")}`
                    : a.outcome === "failed"
                      ? `failed: ${a.attempts.at(-1)?.error ?? "not attempted"}`
                      : "nothing to withdraw",
                ]),
                ["Scope", "the owner's own ft_withdraw on the verifier, outside the mandate contract and every recovery claim"],
              ],
        labels: ["owner action, outside recovery claims"],
        caption:
          w === null || done.length === 0
            ? null
            : `Separately, outside recovery, the owner withdraws ${done.map((a) => readable(a.asset, a.amount)).join(" and ")} to its NEAR account, registering storage only where needed.`,
        short: w === null || done.length === 0 ? null : `${done.map((a) => readable(a.asset, a.amount)).join(" and ")} from the owner's Intents account to its NEAR account`,
        failure: `Owner withdrawal: ${failedText === "" ? "the withdrawal did not complete as recorded" : failedText}.`,
      };
    }),
  ];
}

export type JourneyKey = "mandate" | "trade" | "attacks" | "withheld" | "revoked" | "rejected" | "recovered" | "withdrawn";

export interface JourneyStep {
  n: number;
  key: JourneyKey;
  /** The owner's view of the step, in a few words; claims the outcome, so shown only when every stage held. */
  title: string;
  /** The step named without claiming its outcome, for a step that did not hold. */
  neutral: string;
  /** One word for a progress rail. */
  rail: string;
  /** The status word when every stage held; otherwise the outcome is shown. */
  done: string;
  /** Worst outcome of its stages: not-held, then missing, then inconclusive, then held. */
  outcome: StageOutcome;
  /** One line from the run: the stages' short lines when held, else the first non-held stage's narration. */
  result: string | null;
  /** Execution labels beyond the run's mode, from its stages. */
  labels: string[];
  stages: Stage[];
}

/** The owner's eight steps and the detailed stages each groups. */
export const JOURNEY: readonly { key: JourneyKey; title: string; neutral: string; rail: string; done: string; stages: readonly StageKey[] }[] = [
  { key: "mandate", title: "Read the mandate and its limits", neutral: "The mandate and its limits", rail: "Limits", done: "reviewed", stages: ["limits", "console"] },
  { key: "trade", title: "The agent makes a permitted trade", neutral: "The agent's trade", rail: "Trade", done: "executed", stages: ["trade"] },
  { key: "attacks", title: "Hostile requests are refused", neutral: "Hostile requests", rail: "Hostile", done: "refused", stages: ["attacks"] },
  { key: "withheld", title: "Spot the withheld signed order", neutral: "The withheld signed order", rail: "Withheld", done: "signed, held back", stages: ["withheld"] },
  { key: "revoked", title: "Revoke with the owner controls", neutral: "Owner revocation", rail: "Revoke", done: "removal confirmed", stages: ["revoked"] },
  { key: "rejected", title: "The same order is rejected", neutral: "The withheld order relayed", rail: "Rejected", done: "rejected", stages: ["rejected"] },
  { key: "recovered", title: "Recover without agent, oracle or MPC", neutral: "Recovery", rail: "Recover", done: "recovered", stages: ["recovered"] },
  { key: "withdrawn", title: "Withdraw to the owner's NEAR account", neutral: "Owner withdrawal", rail: "Withdraw", done: "withdrawn", stages: ["withdrawn"] },
];

/** A check that did not hold outranks absent evidence, which outranks an inconclusive one. */
const WORST: readonly StageOutcome[] = ["not-held", "missing", "inconclusive", "held"];

/**
 * The owner's eight-step journey from one run's evidence; each step's outcome is the worst of its stages. A stage
 * whose checks held but whose outcome line cannot be built from the recorded values makes its step "missing": a
 * success status is never shown without the values it stands for.
 */
export function ownerJourney(ev: Evidence, stages: readonly Stage[] = revocationStory(ev)): JourneyStep[] {
  return JOURNEY.map((j, i) => {
    const of = j.stages.flatMap((k) => stages.filter((s) => s.key === k));
    const unbuilt = of.filter((s) => s.outcome === "held" && s.short === null).map((s) => `${s.title}: its outcome values are not recorded in this evidence`);
    const worst = WORST.find((o) => of.some((s) => s.outcome === o)) ?? "missing";
    const outcome: StageOutcome = worst === "held" && unbuilt.length > 0 ? "missing" : of.length === 0 ? "missing" : worst;
    const first = of.find((s) => s.outcome === outcome);
    const result =
      outcome === "held"
        ? of.map((s) => s.short).join("; ")
        : outcome === "missing"
          ? `not in this evidence: ${[...of.flatMap((s) => s.missing), ...unbuilt].join("; ")}`
          : (first?.short ?? null);
    return { n: i + 1, key: j.key, title: j.title, neutral: j.neutral, rail: j.rail, done: j.done, outcome, result, labels: [...new Set(of.flatMap((s) => s.labels))], stages: of };
  });
}

/** Journey number of a detailed stage: "1a", "1b" for a step with two stages, else the step number. */
export function stageNumber(key: StageKey): string {
  const i = JOURNEY.findIndex((j) => j.stages.includes(key));
  const j = JOURNEY[i];
  if (j === undefined) return "?";
  return j.stages.length === 1 ? String(i + 1) : `${String(i + 1)}${String.fromCharCode(97 + j.stages.indexOf(key))}`;
}

const sentenceStart = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

/** The recorded model's stated reason for its proposal, from the decision text; null when not recorded. */
export function modelReason(ev: Evidence): string | null {
  const o = z.object({ decision: z.object({ decision_text: z.string() }).nullable() }).safeParse(ev.assertions.find((a) => a.id === "model-proposal-on-chain")?.observed);
  if (!o.success || o.data.decision === null) return null;
  try {
    const parsed = z.object({ reason: z.string() }).safeParse(JSON.parse(o.data.decision.decision_text));
    return parsed.success ? parsed.data.reason : null;
  } catch {
    return null;
  }
}

/** Labels of receipts no stage is bound to. */
export const unboundReceipts = (ev: Evidence, stages: readonly Stage[]): string[] => {
  const bound = new Set(stages.flatMap((s) => s.receipts.map((r) => r.index)));
  return ev.receipts.flatMap((r, i) => (bound.has(i) ? [] : [r.label]));
};
