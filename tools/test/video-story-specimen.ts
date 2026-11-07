// SYNTHETIC specimens for the revocation story, the mainnet section and the short video. Every value below is
// invented here for testing the renderers and is labelled as such; none is a recorded run.
import { createHash } from "node:crypto";
import { type Assertion, Evidence, type Receipt } from "../src/types.js";
import { OWNER_CONTROLS_LABEL, removedKeyError } from "../src/evidence/journey.js";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** A syntactically valid NEAR transaction hash (base58 of 32 bytes), derived from a seed. */
export function txHash(seed: string): string {
  const bytes = createHash("sha256").update(seed).digest();
  let n = BigInt(`0x${bytes.toString("hex")}`);
  let out = "";
  while (n > 0n) {
    out = B58.charAt(Number(n % 58n)) + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const SOURCE = {
  product_commit: "a".repeat(40),
  dirty: false,
  spec_sha256: "b".repeat(64),
  spec_commit: "c".repeat(40),
  contract_wasm_sha256: "1".repeat(64),
  fixtures: { "verifier/defuse-0.4.5.wasm": "e".repeat(64) },
  fixture_manifest_sha256: "d".repeat(64),
  wasm_sha256: { bounded_mandate: "1".repeat(64) },
};

export const evidence = (over: Partial<Evidence>): Evidence =>
  Evidence.parse({
    schema_version: 1,
    generated_at: "2026-11-04T00:00:00Z",
    mode: "sandbox",
    source: SOURCE,
    environment: { label: "SYNTHETIC specimen" },
    command: "vitest (synthetic specimen)",
    identifiers: { mandate: "mandate.synthetic", owner: "owner.synthetic" },
    receipts: [],
    assertions: [],
    unknowns: ["SYNTHETIC: nothing here was executed"],
    ...over,
  });

const held = (id: string, observed: unknown): Assertion => ({ id, gate: "SYNTHETIC", description: `SYNTHETIC ${id}`, passed: true, observed });
const tx = (label: string, detail: unknown = {}, outcome: Receipt["outcome"] = "success"): Receipt => ({ label, tx_hash: txHash(label), outcome, detail });

const E24 = 10n ** 24n;
/** Synthetic inputs, in raw units; the tests derive expected text from these. */
export const STORY = {
  before: { usdc: 2_000_000_000n, wnear: 100n * E24 },
  initialValue: 2_300_000_000_000_000n, // $2,300.00 at 12 value decimals
  sell: 12_340_000n, // 12.34 USDC
  buy: 4_000_000n * 10n ** 18n, // 4.0000 wNEAR
  withheld: { sell: 5n * E24, buy: 14_990_000n },
  relayNs: 1_000_000_000_000_000_000n,
  deadlineNs: 1_000_000_037_000_000_000n, // 37 s later
  model: "synthetic-model-1",
  /** Grant reference: USDC $1.00, wNEAR $3.00 (mantissa, exponent), so the initial value is $2,300.00. */
  reference: { usdc: { price: 100_000_000n, expo: -8 }, wnear: { price: 300_000_000n, expo: -8 } },
  key: "ed25519:SYNTHETICkeySYNTHETICkey",
  bundleSha256: "9".repeat(64),
} as const;

/** SYNTHETIC values "read from the rendered console" (nothing was rendered). */
export const CONSOLE_RENDERED = {
  browser: "SYNTHETIC chromium",
  origin: "http://127.0.0.1:1",
  live_status: "Read from http://127.0.0.1:2 at SYNTHETIC. Live chain state, not recorded evidence.",
  badge: "live · Local sandbox · final block #42",
  chain_verified: true,
  deployment_matches: true,
  owner_controls: "owner controls enabled signer owner.synthetic is the contract's owner on the expected deployment",
  grant_status: "active",
  grant_line: "active epoch 1 · active: SYNTHETIC",
  grant_key: STORY.key,
  key_on_verifier: "registered on intents.synthetic",
  limits: [["Largest single order", "20% of the grant's initial reference value"]],
  mandate: [["Owner", "owner.synthetic"]],
  mandate_balances: { USDC: "2,000", wNEAR: "100" },
  screenshot: { path: "out/console/screens/demo-console-review.png", sha256: "5".repeat(64) },
};

/** SYNTHETIC revocation "through the console's owner controls" (nothing was signed). */
export const CONSOLE_REVOKE = {
  via: OWNER_CONTROLS_LABEL,
  preview: [["Receiver", "mandate.synthetic"], ["Method", "revoke"]],
  preview_problems: [],
  intent_sha256: "6".repeat(64),
  sign_requests: [{ intent_sha256: "6".repeat(64), status: "submitted", tx_hash: txHash(`owner revoke (${OWNER_CONTROLS_LABEL})`) }],
  tx_hash: txHash(`owner revoke (${OWNER_CONTROLS_LABEL})`),
  ui_final: "final · success Revoke the grant",
  outcome: "success",
  screenshot: { path: "out/console/screens/demo-revoke-preview.png", sha256: "4".repeat(64) },
};

const price = (id: string, p: { price: bigint; expo: number }) => ({ price_id: id, price: p.price.toString(), conf: "1", expo: p.expo, publish_time_sec: "1000000000" });

/** SYNTHETIC attack results, one per enforcement layer the suite classifies (values invented here). */
export const ATTACKS = [
  { id: "attack-adapter-withdraw", boundary: "adapter-schema", origin: "injected-request", reason: "SYNTHETIC action: invalid discriminator", source: { file: "tools/src/agent/decision.ts", line: 50, excerpt: "SYNTHETIC validateDecision" }, model_output: '{"action":"withdraw","recipient":"evil.synthetic"}' },
  { id: "attack-agent-revoke", boundary: "near-access-key", origin: "scripted-direct", reason: "SYNTHETIC Access key does not allow method revoke", source: { file: "tools/src/demo/world.ts", line: 122, excerpt: "SYNTHETIC key" }, submitted: false },
  { id: "attack-attacker-grant", boundary: "contract-role", origin: "scripted-direct", reason: "only the owner", source: { file: "contract/src/lib.rs", line: 930, excerpt: '"only the owner"' }, submitted: true, tx_hash: "SYNTHETICattacktx1" },
  { id: "attack-direct-over-cap", boundary: "contract-policy", origin: "scripted-direct", reason: "per-order cap exceeded", source: { file: "contract/src/lib.rs", line: 905, excerpt: 'return Err("per-order cap exceeded");' }, submitted: true, tx_hash: "SYNTHETICattacktx2" },
  { id: "attack-forged-mandate-transfer", boundary: "verifier", origin: "injected-request", reason: "SYNTHETIC public key doesn't exist", source: null, submitted: true, tx_hash: "SYNTHETICattacktx3" },
] as const;

const attackAssertion = (a: (typeof ATTACKS)[number]): Assertion => {
  const { id, boundary, origin, ...rest } = a;
  return { id, gate: "SYNTHETIC", description: `SYNTHETIC ${id} -> stopped by ${boundary} (${origin})`, passed: true, observed: { observed: boundary, contained: true, origin, ...rest } };
};

type Pair = { usdc: bigint; wnear: bigint };
const pairStr = (p: Pair) => ({ usdc: p.usdc.toString(), wnear: p.wnear.toString() });
const zero: Pair = { usdc: 0n, wnear: 0n };
/** SYNTHETIC chain state after a step. */
const state = (grant: string, key: boolean | null, open: number, mandate: Pair, ownerIntents: Pair = zero, ownerNear: Pair = zero) => ({
  grant_status: grant,
  grant_epoch: grant === "none" ? null : 1,
  key_present: key,
  open_orders: open,
  mandate: pairStr(mandate),
  owner_intents: pairStr(ownerIntents),
  owner_near: pairStr(ownerNear),
  block_time_ns: "1000000000000000000",
});

/** Evidence carrying every assertion, receipt and step state the nine journey stages bind to. */
export function storyEvidence(): Evidence {
  const s = STORY;
  const afterPair = { usdc: s.before.usdc - s.sell, wnear: s.before.wnear + s.buy };
  const after = pairStr(afterPair);
  const policy = {
    per_order_cap_bps: 2000,
    outstanding_cap_bps: 2000,
    max_concession_bps: 50,
    oracle_max_age_sec: 60,
    max_confidence_bps: 50,
    breaker_drawdown_bps: 200,
    turnover_cap_bps: 10000,
    order_ttl_sec: 60,
    min_remaining_sec: 15,
    max_pricing_delay_sec: 30,
    proposal_charge_bps: 50,
  };
  const withheldOrder = { id: "7", sell: "wnear", sell_amount: s.withheld.sell.toString(), buy: "usdc", buy_amount: s.withheld.buy.toString() };
  const withdrawal = (asset: "usdc" | "wnear", registered: boolean) => ({
    asset,
    token: `${asset}.synthetic`,
    registration: { registered_before: registered, storage_deposit_tx: registered ? null : txHash(`owner storage_deposit on ${asset} token`), deposit_yocto: registered ? "0" : "1250000000000000000000", registered_after: true },
    amount: afterPair[asset].toString(),
    intents_before: afterPair[asset].toString(),
    near_before: "0",
    attempts: [{ tx_hash: txHash(`owner ft_withdraw ${asset}`), success: true, returned: afterPair[asset].toString(), intents_after: "0", near_after: afterPair[asset].toString(), error: null }],
    outcome: "withdrawn",
  });
  const steps: { step: string; receipts: Receipt[]; assertions: Assertion[]; state: ReturnType<typeof state> }[] = [
    {
      step: "Grant and limits",
      receipts: [tx("owner grant")],
      assertions: [
        held("grant-active", {
          epoch: 1,
          path: "mandate/v1/1",
          public_key: s.key,
          policy,
          initial_reference: { usdc: price("SYNTHETIC-usdc", s.reference.usdc), wnear: price("SYNTHETIC-wnear", s.reference.wnear), observed_at_ns: "1000000000000000000" },
        }),
        held("grant-initial-value", { contract: s.initialValue.toString() }),
      ],
      state: state("active", true, 0, s.before),
    },
    {
      step: "Mandate reviewed in the console",
      receipts: [],
      assertions: [
        held("mandate-no-keys", []),
        held("agent-one-restricted-key", [{ permission: { FunctionCall: { method_names: ["propose_order"], receiver_id: "mandate.synthetic" } } }]),
        held("console-review", {
          state: state("active", true, 0, s.before),
          config: { owner: "owner.synthetic", agent: "agent.synthetic", verifier: "intents.synthetic", usdc_token: "usdc.synthetic", wnear_token: "wnear.synthetic" },
          view: { local_path: null, planned_url: "https://gryyny.github.io/bounded-mandate/console/", planned_label: "planned, unpublished" },
          rendered: CONSOLE_RENDERED,
          mismatches: [],
        }),
      ],
      state: state("active", true, 0, s.before),
    },
    {
      step: "Bounded agent proposal (recorded genuine model output) -> propose_order",
      receipts: [tx("agent propose_order (first order)")],
      assertions: [held("model-proposal-on-chain", { mode: "recorded-model", decision: { model: s.model }, order: { id: "6", sell: "usdc", sell_amount: s.sell.toString(), buy: "wnear", buy_amount: s.buy.toString(), concession_bps: 40 } })],
      state: state("active", true, 1, s.before),
    },
    {
      step: "Filler fills the first order (actual trade on the pinned verifier)",
      receipts: [tx("filler execute_intents order 6"), tx("settle_order 6")],
      assertions: [
        held("trade-executed", { before: pairStr(s.before), after, signed: { sell: "usdc", sell_amount: s.sell.toString(), buy: "wnear", buy_amount: s.buy.toString() } }),
        held("settled-release", { state: "released", reason: "settled" }),
      ],
      state: state("active", true, 0, afterPair),
    },
    {
      step: "Hostile requests refused",
      receipts: [],
      assertions: [...ATTACKS.map(attackAssertion), held("injection-recording", { mode: "recorded-model", model: s.model, decision_text: "SYNTHETIC decline", verdict: { kind: "decline" } })],
      state: state("active", true, 0, afterPair),
    },
    {
      step: "Second signed order withheld",
      receipts: [tx("agent propose_order (second order, scripted, withheld)", { events: [{ event: "order_sign_requested", data: { order: withheldOrder } }] })],
      assertions: [
        held("withheld-executable", {
          simulation: "accepted",
          order_id: "7",
          epoch: 1,
          mandate: "mandate.synthetic",
          signing_public_key: s.key,
          mandate_nonce: "SYNTHETICnonce",
          deadline_ns: s.deadlineNs.toString(),
          payload_sha256: "8".repeat(64),
          bundle_sha256: s.bundleSha256,
          filler_nonce: "SYNTHETICfillernonce",
        }),
      ],
      state: state("active", true, 1, afterPair),
    },
    {
      step: "Owner revokes; removal confirmed",
      receipts: [tx(`owner revoke (${OWNER_CONTROLS_LABEL})`, { via: OWNER_CONTROLS_LABEL })],
      assertions: [
        held("revoke-through-console", CONSOLE_REVOKE),
        held("revoked", { status: "revoked", key_registered: false, grant_public_key: s.key }),
        held("withheld-released", { state: "released", reason: "key_removed" }),
      ],
      state: state("revoked", false, 0, afterPair),
    },
    {
      step: "Withheld order relayed from another account",
      receipts: [tx("relayer execute_intents (withheld order after revocation)", { signer_id: "relayer.synthetic", events: [] }, "failure")],
      assertions: [
        held("withheld-rejected", {
          error: `SYNTHETIC Smart contract panicked: ${removedKeyError(s.key, "mandate.synthetic")}`,
          relay_block_time_ns: (s.relayNs - 1_000_000_000n).toString(),
          order_deadline_ns: s.deadlineNs.toString(),
          nonce_used: false,
          relayer: "relayer.synthetic",
          mandate: "mandate.synthetic",
          revoked_key: s.key,
          bundle_sha256: s.bundleSha256,
          verifier_receipt: { id: "SYNTHETICreceipt", block_hash: "SYNTHETICblock", block_time_ns: s.relayNs.toString() },
        }),
      ],
      state: state("revoked", false, 0, afterPair),
    },
    {
      step: "Agent, oracle and MPC disabled",
      receipts: [tx("oracle set_fail(true)"), tx("mpc set_mode(hold)"), tx("agent propose_order after revocation", {}, "failure")],
      assertions: [held("agent-stopped", "SYNTHETIC grant is not active")],
      state: state("revoked", false, 0, afterPair),
    },
    {
      step: "Recovery to the owner's Intents account",
      receipts: [tx("owner recover usdc"), tx("owner recover wnear")],
      assertions: [held("recovered", { destination: "owner.synthetic (owner's Intents account)", recovered: after, mandate_final: { usdc: "0", wnear: "0" } })],
      state: state("revoked", false, 0, zero, afterPair),
    },
    {
      step: "Owner withdrawal to its NEAR account (outside recovery)",
      receipts: [tx("owner storage_deposit on wnear token"), tx("owner ft_withdraw usdc to its NEAR account (attempt 1)"), tx("owner ft_withdraw wnear to its NEAR account (attempt 1)")],
      assertions: [held("owner-withdrawal", { owner: "owner.synthetic", verifier: "intents.synthetic", outside_recovery: true, assets: [withdrawal("usdc", true), withdrawal("wnear", false)] })],
      state: state("revoked", false, 0, zero, zero, afterPair),
    },
  ];
  let r = 0;
  let a = 0;
  const offsets = steps.map((st) => {
    const o = { step: st.step, started_ms: 0, first_receipt: r, first_assertion: a, state: st.state };
    r += st.receipts.length;
    a += st.assertions.length;
    return o;
  });
  return evidence({
    environment: { label: "SYNTHETIC specimen", steps: JSON.stringify(offsets) },
    receipts: steps.flatMap((st) => st.receipts),
    assertions: steps.flatMap((st) => st.assertions),
  });
}

/**
 * SYNTHETIC: the same story in the format of demos before the withheld identity, the grant reference, the rendered
 * console review and the console revocation were recorded.
 */
export function olderStoryEvidence(): Evidence {
  const ev = storyEvidence();
  const older: Record<string, (o: Record<string, unknown>) => unknown> = {
    "grant-active": (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "initial_reference")),
    "withheld-executable": () => "accepted",
    revoked: (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "grant_public_key")),
    "withheld-rejected": (o) => ({ error: o.error, relay_block_time_ns: o.relay_block_time_ns, order_deadline_ns: o.order_deadline_ns, nonce_used: o.nonce_used }),
    // Older demos compared Node views only and revoked with a direct owner call.
    "console-review": (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "rendered" && k !== "mismatches")),
  };
  return {
    ...ev,
    receipts: ev.receipts.map((r) => (r.label.startsWith("owner revoke") ? { label: "owner revoke", tx_hash: txHash("owner revoke"), outcome: r.outcome, detail: {} } : r)),
    assertions: ev.assertions.filter((a) => a.id !== "revoke-through-console").map((a) => (a.id in older ? { ...a, observed: older[a.id]?.(a.observed as Record<string, unknown>) } : a)),
  };
}

/** SYNTHETIC: the withheld order relayed 4.5 s after its deadline, so the demo marks withheld-rejected as not held. */
export const EXPIRED_RELAY_NS = STORY.deadlineNs + 4_500_000_000n;
export function expiredStoryEvidence(): Evidence {
  const ev = storyEvidence();
  return {
    ...ev,
    assertions: ev.assertions.map((a) =>
      a.id === "withheld-rejected"
        ? { ...a, passed: false, observed: { error: "SYNTHETIC order expired", relay_block_time_ns: EXPIRED_RELAY_NS.toString(), order_deadline_ns: STORY.deadlineNs.toString(), nonce_used: false } }
        : a,
    ),
  };
}
