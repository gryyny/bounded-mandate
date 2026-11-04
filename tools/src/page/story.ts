// The revocation story in seven stages, each bound to the demo evidence it shows. The page's opening sequence
// and the short video both read it. Every value comes from one run's assertions and receipts; a stage whose
// evidence is absent lists what is missing and shows no numbers.
import { z } from "zod";
import { VALUE_DECIMALS } from "../agent/snapshot.js";
import { DECIMALS } from "../demo/market.js";
import { Policy, type Evidence, type Receipt } from "../types.js";

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
/** Shortened hash or key; a curve prefix such as "ed25519:" is kept. */
export const shortHash = (h: string): string => {
  const colon = h.indexOf(":") + 1;
  const body = h.slice(colon);
  return body.length > 16 ? `${h.slice(0, colon)}${body.slice(0, 6)}…${body.slice(-4)}` : h;
};
const pct = (bps: number): string => `${(bps / 100).toFixed(2).replace(/\.00$/, "")}%`;

export type StageKey = "balances" | "limits" | "trade" | "withheld" | "revoked" | "rejected" | "recovered";

export interface StageCheck {
  id: string;
  description: string;
  /** null: the assertion is not in this evidence. */
  held: boolean | null;
}

export interface Stage {
  key: StageKey;
  title: string;
  /** The stage's main number line; null when its evidence is missing. */
  headline: string | null;
  facts: [string, string][];
  /** Execution labels beyond the run's mode, e.g. recorded genuine model output. */
  labels: string[];
  receipts: { index: number; receipt: Receipt }[];
  checks: StageCheck[];
  /** One-sentence narration with this run's numbers; null when evidence is missing. */
  caption: string | null;
  missing: string[];
}

const dec = z.string().regex(/^-?(0|[1-9][0-9]*)$/);
const Pair = z.object({ usdc: dec, wnear: dec });
const OrderLike = z.object({ id: z.string(), sell: z.string(), sell_amount: dec, buy: z.string(), buy_amount: dec.nullable() });
const Events = z.object({ signer_id: z.string().optional(), events: z.array(z.object({ event: z.string(), data: z.unknown() })) });

const SHAPES = {
  "trade-executed": z.object({ before: Pair, after: Pair, signed: z.object({ sell: z.string(), sell_amount: dec, buy: z.string(), buy_amount: dec.nullable() }) }),
  "grant-initial-value": z.object({ contract: dec }),
  "grant-active": z.object({ epoch: z.number(), path: z.string(), public_key: z.string().nullable(), policy: Policy }),
  "agent-one-restricted-key": z.array(z.object({ permission: z.object({ FunctionCall: z.object({ method_names: z.array(z.string()), receiver_id: z.string() }) }) })),
  "model-proposal-on-chain": z.object({ mode: z.string(), decision: z.object({ model: z.string() }).nullable(), order: OrderLike.extend({ concession_bps: z.number() }).nullable() }),
  revoked: z.object({ status: z.string().optional(), key_registered: z.boolean() }),
  "withheld-released": z.object({ state: z.string(), reason: z.string().optional() }),
  "withheld-rejected": z.object({ error: z.string(), relay_block_time_ns: dec, order_deadline_ns: dec.nullable(), nonce_used: z.boolean() }),
  recovered: z.object({ recovered: Pair, mandate_final: Pair }),
} as const;
type Shape<K extends keyof typeof SHAPES> = z.infer<(typeof SHAPES)[K]>;

/** Collects the evidence one stage is bound to, and what is missing. */
class Binder {
  readonly missing: string[] = [];
  readonly checks: StageCheck[] = [];
  readonly receipts: { index: number; receipt: Receipt }[] = [];

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

const verifierReason = (error: string): string =>
  (/ExecutionError\\?":\\?"([^"\\]+)/.exec(error)?.[1] ?? error).replace(/^Smart contract panicked: /, "").replace(/ed25519:[1-9A-HJ-NP-Za-km-z]+/g, (k) => shortHash(k));

/** The seven stages of the revocation story, in order, from one run's evidence. */
export function revocationStory(ev: Evidence): Stage[] {
  const claimed = new Set<number>();
  const stage = (key: StageKey, title: string, build: (b: Binder) => Omit<Stage, "key" | "title" | "receipts" | "checks" | "missing">): Stage => {
    const b = new Binder(ev, claimed);
    const built = build(b);
    const complete = b.missing.length === 0;
    return { key, title, ...built, headline: complete ? built.headline : null, caption: complete ? built.caption : null, receipts: b.receipts, checks: b.checks, missing: b.missing };
  };
  const mandate = ev.identifiers.mandate ?? "the mandate";
  const owner = ev.identifiers.owner ?? "the owner";
  const initial = SHAPES["grant-initial-value"].safeParse(ev.assertions.find((a) => a.id === "grant-initial-value")?.observed);
  const grantKey = SHAPES["grant-active"].safeParse(ev.assertions.find((a) => a.id === "grant-active")?.observed);

  return [
    stage("balances", "Balances", (b) => {
      const trade = b.observed("trade-executed");
      const value = b.observed("grant-initial-value");
      return {
        headline: trade === null ? null : `${usdc(trade.before.usdc)} + ${wnear(trade.before.wnear)}`,
        facts: [
          ["Held by", `${mandate} (its Intents account)`],
          ...(value === null ? [] : [["Reference value", usd(value.contract)] as [string, string]]),
        ],
        labels: [],
        caption:
          trade === null || value === null
            ? null
            : `Starting balances: the mandate's Intents account holds ${usdc(trade.before.usdc)} and ${wnear(trade.before.wnear)}, ${usd(value.contract)} at reference prices.`,
      };
    }),
    stage("limits", "Trading limits", (b) => {
      b.tx(/^owner grant$/);
      const grant = b.observed("grant-active");
      const keys = b.observed("agent-one-restricted-key");
      b.check("mandate-no-keys");
      const methods = keys?.map((k) => k.permission.FunctionCall.method_names.join(", ")).join("; ") ?? "";
      const p = grant?.policy;
      const cap = (bps: number): string => (initial.success ? ` (${usd(((BigInt(initial.data.contract) * BigInt(bps)) / 10_000n).toString())})` : "");
      return {
        headline: p === undefined ? null : `≤ ${pct(p.per_order_cap_bps)} per order · ≤ ${pct(p.max_concession_bps)} price concession`,
        facts:
          p === undefined || grant === null
            ? []
            : [
                ["Per-order cap", `${pct(p.per_order_cap_bps)} of initial value${cap(p.per_order_cap_bps)}`],
                ["Outstanding cap", `${pct(p.outstanding_cap_bps)}${cap(p.outstanding_cap_bps)}`],
                ["Turnover cap", pct(p.turnover_cap_bps)],
                ["Order deadline", `${String(p.order_ttl_sec)} s`],
                ["Agent's only key", methods],
                ["Grant key path", grant.path],
              ],
        labels: [],
        caption:
          p === undefined
            ? null
            : `The owner grants on-chain limits: at most ${pct(p.per_order_cap_bps)}${cap(p.per_order_cap_bps)} per order and ${pct(p.max_concession_bps)} price concession. The agent can only call ${methods}.`,
      };
    }),
    stage("trade", "Successful trade", (b) => {
      b.tx(/propose_order \(order 1\)/);
      b.tx(/execute_intents order/);
      b.tx(/^settle_order/);
      const model = b.observed("model-proposal-on-chain");
      const trade = b.observed("trade-executed");
      b.check("settled-release");
      const modelName = model !== null && model.mode === "recorded-model" && model.decision !== null ? model.decision.model : null;
      const s = trade?.signed;
      return {
        headline: s === undefined || s.buy_amount === null ? null : `sold ${amount(s.sell, s.sell_amount)} → bought ${amount(s.buy, s.buy_amount)}`,
        facts:
          trade === null || model === null
            ? []
            : [
                ["Proposed by", modelName === null ? "a scripted proposal" : `recorded output of ${modelName}`],
                ...(model.order === null ? [] : [["Order id", `${model.order.id}, concession ≤ ${String(model.order.concession_bps)} bps`] as [string, string]]),
                ["Mandate after", `${usdc(trade.after.usdc)} + ${wnear(trade.after.wnear)}`],
              ],
        labels: modelName === null ? ["scripted proposal"] : ["recorded genuine model output"],
        caption:
          s === undefined || s.buy_amount === null
            ? null
            : `${modelName === null ? "A scripted proposal" : `A recorded ${modelName} proposal`} sells ${amount(s.sell, s.sell_amount)}. The contract signs it, and our filler executes it for ${amount(s.buy, s.buy_amount)}, exactly as signed.`,
      };
    }),
    stage("withheld", "Signed pending order", (b) => {
      const [r] = b.tx(/scripted, withheld/);
      const executable = b.check("withheld-executable");
      const detail = Events.safeParse(r?.detail);
      const signRequested = detail.success ? detail.data.events.find((e) => e.event === "order_sign_requested") : undefined;
      const order = z.object({ order: OrderLike }).safeParse(signRequested?.data);
      if (r !== undefined && !order.success) b.missing.push("signed order in the withheld receipt's events");
      const o = order.success ? order.data.order : null;
      return {
        headline: o === null || o.buy_amount === null ? null : `order id ${o.id}: ${amount(o.sell, o.sell_amount)} → ${amount(o.buy, o.buy_amount)}`,
        facts: [
          ["State", "signed by the grant key, withheld from the verifier"],
          ...(executable === true ? [["Before revoke", "the verifier's simulation accepts it"] as [string, string]] : []),
        ],
        labels: ["scripted proposal"],
        caption:
          o === null || o.buy_amount === null
            ? null
            : `A second order, ${amount(o.sell, o.sell_amount)} for ${amount(o.buy, o.buy_amount)}, is signed but withheld. Before revocation, the verifier would still accept it.`,
      };
    }),
    stage("revoked", "Confirmed revocation", (b) => {
      b.tx(/^owner revoke/);
      const revoked = b.observed("revoked");
      const released = b.observed("withheld-released");
      const key = grantKey.success ? grantKey.data.public_key : null;
      return {
        headline: revoked === null ? null : `grant ${revoked.status ?? "revoked"} · key registered: ${revoked.key_registered ? "yes" : "no"}`,
        facts: [
          ...(key === null ? [] : [["Removed key", shortHash(key)] as [string, string]]),
          ...(released === null ? [] : [["Withheld order", `${released.state}${released.reason === undefined ? "" : ` (${released.reason})`}`] as [string, string]]),
        ],
        labels: [],
        caption: revoked === null ? null : "The owner revokes the entire grant. The verifier confirms the grant key is removed, and the withheld order's reservation is released.",
      };
    }),
    stage("rejected", "Rejected execution", (b) => {
      const [r] = b.tx(/withheld order after revocation/);
      const rej = b.observed("withheld-rejected");
      const relayer = Events.safeParse(r?.detail);
      const secondsLeft = rej?.order_deadline_ns == null ? null : Number((BigInt(rej.order_deadline_ns) - BigInt(rej.relay_block_time_ns)) / 1_000_000_000n);
      return {
        headline: rej === null || secondsLeft === null ? null : `rejected ${String(secondsLeft)} s before its deadline`,
        facts:
          rej === null
            ? []
            : [
                ["Relayed by", relayer.success && relayer.data.signer_id !== undefined ? relayer.data.signer_id : "another account"],
                ["Verifier error", verifierReason(rej.error)],
                ["Nonce used", rej.nonce_used ? "yes" : "no"],
              ],
        labels: [],
        caption:
          secondsLeft === null ? null : `Another account relays the withheld order ${String(secondsLeft)} s before its deadline. The verifier rejects it: the signing key no longer exists.`,
      };
    }),
    stage("recovered", "Recovered balances", (b) => {
      b.tx(/set_fail|set_mode|propose_order after revocation/);
      b.tx(/recover/);
      const rec = b.observed("recovered");
      b.check("agent-stopped");
      return {
        headline: rec === null ? null : `${usdc(rec.recovered.usdc)} + ${wnear(rec.recovered.wnear)} to the owner`,
        facts:
          rec === null
            ? []
            : [
                ["Destination", `${owner} (owner's Intents account)`],
                ["Mandate left", `${usdc(rec.mandate_final.usdc)} + ${wnear(rec.mandate_final.wnear)}`],
                ["Without", "agent (rejected), oracle (failing), MPC test double (on hold)"],
              ],
        labels: ["ordinary recovery (not the owner-key rescue)"],
        caption:
          rec === null
            ? null
            : `With the oracle failing and the MPC test double on hold, the owner recovers ${usdc(rec.recovered.usdc)} and ${wnear(rec.recovered.wnear)}. The mandate holds zero.`,
      };
    }),
  ];
}

/** Labels of receipts no stage is bound to. */
export const unboundReceipts = (ev: Evidence, stages: readonly Stage[]): string[] => {
  const bound = new Set(stages.flatMap((s) => s.receipts.map((r) => r.index)));
  return ev.receipts.flatMap((r, i) => (bound.has(i) ? [] : [r.label]));
};
