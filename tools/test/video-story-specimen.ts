// SYNTHETIC specimens for the revocation story, the mainnet section and the short video. Every value below is
// invented here for testing the renderers and is labelled as such; none is a recorded run.
import { createHash } from "node:crypto";
import { type Assertion, Evidence, type Receipt } from "../src/types.js";

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

const price = (id: string, p: { price: bigint; expo: number }) => ({ price_id: id, price: p.price.toString(), conf: "1", expo: p.expo, publish_time_sec: "1000000000" });

/** Evidence carrying every assertion and receipt the seven story stages bind to. */
export function storyEvidence(): Evidence {
  const s = STORY;
  const after = { usdc: (s.before.usdc - s.sell).toString(), wnear: (s.before.wnear + s.buy).toString() };
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
  return evidence({
    receipts: [
      tx("owner grant"),
      tx("agent propose_order (order 1)"),
      tx("filler execute_intents order 6"),
      tx("settle_order 6"),
      tx("agent propose_order (order 2, scripted, withheld)", { events: [{ event: "order_sign_requested", data: { order: withheldOrder } }] }),
      tx("owner revoke"),
      tx("relayer execute_intents (withheld order after revocation)", { signer_id: "relayer.synthetic", events: [] }, "failure"),
      tx("oracle set_fail(true)"),
      tx("mpc set_mode(hold)"),
      tx("agent propose_order after revocation", {}, "failure"),
      tx("owner recover usdc"),
      tx("owner recover wnear"),
    ],
    assertions: [
      held("mandate-no-keys", []),
      held("agent-one-restricted-key", [{ permission: { FunctionCall: { method_names: ["propose_order"], receiver_id: "mandate.synthetic" } } }]),
      held("grant-active", {
        epoch: 1,
        path: "mandate/v1/1",
        public_key: s.key,
        policy,
        initial_reference: { usdc: price("SYNTHETIC-usdc", s.reference.usdc), wnear: price("SYNTHETIC-wnear", s.reference.wnear), observed_at_ns: "1000000000000000000" },
      }),
      held("grant-initial-value", { contract: s.initialValue.toString() }),
      held("model-proposal-on-chain", { mode: "recorded-model", decision: { model: s.model }, order: { id: "6", sell: "usdc", sell_amount: s.sell.toString(), buy: "wnear", buy_amount: s.buy.toString(), concession_bps: 40 } }),
      held("trade-executed", { before: { usdc: s.before.usdc.toString(), wnear: s.before.wnear.toString() }, after, signed: { sell: "usdc", sell_amount: s.sell.toString(), buy: "wnear", buy_amount: s.buy.toString() } }),
      held("settled-release", { state: "released", reason: "settled" }),
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
      held("revoked", { status: "revoked", key_registered: false, grant_public_key: s.key }),
      held("withheld-released", { state: "released", reason: "key_removed" }),
      held("withheld-rejected", {
        error: `SYNTHETIC Smart contract panicked: public key '${s.key}' doesn't exist for account 'mandate.synthetic'`,
        relay_block_time_ns: (s.relayNs - 1_000_000_000n).toString(),
        order_deadline_ns: s.deadlineNs.toString(),
        nonce_used: false,
        relayer: "relayer.synthetic",
        mandate: "mandate.synthetic",
        revoked_key: s.key,
        bundle_sha256: s.bundleSha256,
        verifier_receipt: { id: "SYNTHETICreceipt", block_hash: "SYNTHETICblock", block_time_ns: s.relayNs.toString() },
      }),
      held("agent-stopped", "SYNTHETIC grant is not active"),
      held("recovered", { recovered: after, mandate_final: { usdc: "0", wnear: "0" } }),
    ],
  });
}

/** SYNTHETIC: the same story in the format of demos before the withheld identity and grant reference were recorded. */
export function olderStoryEvidence(): Evidence {
  const ev = storyEvidence();
  const older: Record<string, (o: Record<string, unknown>) => unknown> = {
    "grant-active": (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "initial_reference")),
    "withheld-executable": () => "accepted",
    revoked: (o) => Object.fromEntries(Object.entries(o).filter(([k]) => k !== "grant_public_key")),
    "withheld-rejected": (o) => ({ error: o.error, relay_block_time_ns: o.relay_block_time_ns, order_deadline_ns: o.order_deadline_ns, nonce_used: o.nonce_used }),
  };
  return { ...ev, assertions: ev.assertions.map((a) => (a.id in older ? { ...a, observed: older[a.id]?.(a.observed as Record<string, unknown>) } : a)) };
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
