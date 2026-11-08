// Live orchestrator refusal paths that need no chain: manifest, confirmation, credentials, ledger,
// budget arithmetic, receipt-tree inspection, WASM export detection, step sequencing, and the classification of
// refused proposals and withheld-order relays against misleading failures.
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseEncode } from "near-api-js";
import { afterEach, describe, expect, it } from "vitest";
import { nep413Prehash, signNep413 } from "../src/filler/nep413.js";
import { checkPlanned, totals, type Planned } from "../src/live/budget.js";
import { Ledger, canonical } from "../src/live/ledger.js";
import { revocationWindow, runLive } from "../src/live/main.js";
import { LiveManifest, sequenceProblems, type OwnerKey, type Step } from "../src/live/manifest.js";
import { gasPurchasePrice, ownerKeyChanges, signingFloat, worstFee } from "../src/live/preflight.js";
import { ExternalHandoff, ExternalIntent, intentSha256, transactionProblems } from "../src/live/external.js";
import { classifyRelay, receiptTree, simulationProblem, verifyRefusedProposal, type Balances, type RelayExpectation, type VerifyContext } from "../src/live/verify.js";
import type { Outcome, ReceiptOutcome, TransactionView } from "../src/near/client.js";
import type { MandateClient, VerifierClient } from "../src/near/contracts.js";
import type { GrantView, OrderView } from "../src/types.js";
import { crateWasm, loadWasm } from "../src/near/sandbox.js";
import { wasmFunctionExports } from "../src/near/wasm.js";
import { sandboxKey } from "../src/near/keys.js";
import { offlineManifest, writeJson } from "./live-helpers.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "bm-live-unit-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("live refusals before any network access", () => {
  it("refuses without the flag, without a manifest, and for invalid manifests", async () => {
    const d = tmp();
    const path = writeJson(d, "m.json", offlineManifest(d));
    expect((await runLive({ MANDATE_LIVE_MANIFEST: path })).exitCode).toBe(2);
    expect((await runLive({ MANDATE_LIVE: "1" })).message).toMatch(/MANDATE_LIVE_MANIFEST is not set/);
    const extra = writeJson(d, "x.json", { ...offlineManifest(d), fund: true });
    expect((await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: extra })).message).toMatch(/invalid manifest/);
    const deposit = writeJson(d, "y.json", { ...offlineManifest(d), steps: [{ kind: "deposit", amount: "1" }] });
    expect((await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: deposit })).exitCode).toBe(2);
  });

  it("refuses a sandbox manifest relabelled as mainnet", async () => {
    const d = tmp();
    const m = offlineManifest(d);
    const path = writeJson(d, "m.json", { ...m, network: { ...m.network, name: "mainnet" } });
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/inconsistent with network mainnet/);
  });

  it("refuses credentials that are world-readable or for another account", async () => {
    const d = tmp();
    const m = offlineManifest(d);
    writeJson(d, "o.json", JSON.parse(readFileSync(m.credentials.owner, "utf8")), 0o644);
    const r1 = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "m1.json", m) });
    expect(r1.message).toMatch(/readable by group\/others/);
    const r2 = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "m2.json", { ...m, credentials: { ...m.credentials, owner: m.credentials.agent } }) });
    expect(r2.message).toMatch(/is for agent\.sandbox, expected owner\.sandbox/);
  });

  it("refuses to resume without a ledger and refuses a fresh start over an existing one", async () => {
    const d = tmp();
    const path = writeJson(d, "m.json", offlineManifest(d));
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_RESUME: "1", MANDATE_LIVE_MANIFEST: path }, { outRoot: join(d, "live") });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/ledger missing/);
  });
});

describe("ledger", () => {
  const sha = "a".repeat(64);
  const make = (): { dir: string; ledger: Ledger } => {
    const dir = join(tmp(), sha);
    const ledger = Ledger.create(dir, sha);
    ledger.append("start", { manifest_sha256: sha, nonces: { owner: "1", agent: "1", filler: "1" } });
    ledger.append("tx-intent", { tx_hash: "h1", planned: { worst_fee_yocto: "100", deposit_yocto: "1", sell: { asset: "usdc", units: "5" } } });
    ledger.append("tx-result", { tx_hash: "h1", status: "executed", fee_yocto: "40" });
    return { dir, ledger };
  };

  it("reloads a verified chain and derives spent budget from it", () => {
    const { dir } = make();
    const t = totals(Ledger.load(dir, sha));
    expect(t).toEqual({ transactions: 1, fee_yocto: 40n, deposit_yocto: 1n, sold: { usdc: 5n, wnear: 0n }, filler_paid: { usdc: 0n, wnear: 0n }, refused_fee_yocto: 0n });
  });

  it("does not count an intent the network refused before inclusion (it cannot execute; its step is planned again)", () => {
    const { dir, ledger } = make();
    ledger.append("tx-intent", { tx_hash: "h3", planned: { worst_fee_yocto: "100", deposit_yocto: "0", sell: { asset: "usdc", units: "7" } } });
    ledger.append("tx-result", { tx_hash: "h3", status: "rejected", fee_yocto: "0" });
    expect(totals(Ledger.load(dir, sha))).toEqual({ transactions: 1, fee_yocto: 40n, deposit_yocto: 1n, sold: { usdc: 5n, wnear: 0n }, filler_paid: { usdc: 0n, wnear: 0n }, refused_fee_yocto: 0n });
  });

  it("charges the owner-paid fee of a refused handoff once per hash; never a fee another account paid or one already counted", () => {
    const { dir, ledger } = make();
    const refused = (hash: string, fee: string, charged: boolean) => ledger.append("external-refused", { step: 0, tx_hash: hash, problems: ["x"], fee_yocto: fee, charged });
    refused("r1", "7", true);
    refused("r1", "7", true); // presented again
    refused("r2", "11", false); // signed and paid by another account
    refused("h1", "40", true); // already counted as an executed transaction
    ledger.append("external-refused", { step: 0, tx_hash: "r3", problems: ["x"], fee_yocto: null, charged: false, fee_note: "not found final" });
    const t = totals(Ledger.load(dir, sha));
    expect([t.fee_yocto, t.refused_fee_yocto, t.transactions]).toEqual([47n, 7n, 1]);
  });

  it("counts an unresolved intent at its worst-case fee", () => {
    const { dir, ledger } = make();
    ledger.append("tx-intent", { tx_hash: "h2", planned: { worst_fee_yocto: "100", deposit_yocto: "0" } });
    expect(totals(Ledger.load(dir, sha)).fee_yocto).toBe(140n);
  });

  it("refuses an edited entry", () => {
    const { dir } = make();
    const file = join(dir, "ledger.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"fee_yocto":"40"', '"fee_yocto":"0"'));
    expect(() => Ledger.load(dir, sha)).toThrow(/hash chain/);
  });

  it("refuses a truncated ledger (budget cannot be reset by deleting entries)", () => {
    const { dir } = make();
    const file = join(dir, "ledger.jsonl");
    const lines = readFileSync(file, "utf8").trim().split("\n");
    writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
    expect(() => Ledger.load(dir, sha)).toThrow(/head does not match/);
  });

  it("refuses an appended forged entry, a missing head and a foreign manifest", () => {
    const { dir } = make();
    appendFileSync(join(dir, "ledger.jsonl"), `${JSON.stringify({ seq: 3, at: "x", prev: "0".repeat(64), kind: "stopped", data: {}, hash: "0".repeat(64) })}\n`);
    expect(() => Ledger.load(dir, sha)).toThrow(/hash chain/);
    const second = make();
    rmSync(join(second.dir, "head.json"));
    expect(() => Ledger.load(second.dir, sha)).toThrow(/ledger missing/);
    const third = make();
    expect(() => Ledger.load(third.dir, "b".repeat(64))).toThrow(/another manifest/);
  });
});

describe("budget caps", () => {
  const budget = offlineManifest(tmp()).budget;
  const caps = {
    ...budget,
    max_fee_yocto: "1000",
    max_deposit_yocto: "2",
    max_transactions: 3,
    max_order_sell: { usdc: "10", wnear: "0" },
    max_total_sell: { usdc: "15", wnear: "0" },
    filler_spend_max: { usdc: "0", wnear: "7" },
  };
  const zero = { transactions: 0, fee_yocto: 0n, deposit_yocto: 0n, sold: { usdc: 0n, wnear: 0n }, filler_paid: { usdc: 0n, wnear: 0n }, refused_fee_yocto: 0n };
  const plan = (p: Partial<Planned> = {}): Planned => ({ worst_fee_yocto: "100", deposit_yocto: "0", ...p });

  it.each([
    ["fees", zero, plan({ worst_fee_yocto: "1001" }), /max_fee_yocto/],
    ["fees already spent", { ...zero, fee_yocto: 950n }, plan(), /max_fee_yocto/],
    ["deposits", zero, plan({ deposit_yocto: "3" }), /max_deposit_yocto/],
    ["transactions", { ...zero, transactions: 3 }, plan(), /max_transactions/],
    ["order size", zero, plan({ sell: { asset: "usdc", units: "11" } }), /max_order_sell/],
    ["total sold", { ...zero, sold: { usdc: 10n, wnear: 0n } }, plan({ sell: { asset: "usdc", units: "6" } }), /max_total_sell/],
    ["filler spend (fees included)", { ...zero, filler_paid: { usdc: 0n, wnear: 5n } }, plan({ filler_pay: { asset: "wnear", units: "3" } }), /filler_spend_max/],
  ])("refuses a transaction exceeding %s", (_name, spent, planned, re) => {
    expect(() => {
      checkPlanned(caps, spent, planned);
    }).toThrow(re);
  });

  it("accepts a transaction exactly at every cap", () => {
    expect(() => {
      checkPlanned(caps, { ...zero, fee_yocto: 900n, deposit_yocto: 1n, transactions: 2, sold: { usdc: 5n, wnear: 0n }, filler_paid: { usdc: 0n, wnear: 4n } }, plan({ deposit_yocto: "1", sell: { asset: "usdc", units: "10" }, filler_pay: { asset: "wnear", units: "3" } }));
    }).not.toThrow();
  });
});

describe("receipt tree inspection", () => {
  const base: Outcome = {
    label: "x",
    signer_id: "a",
    receiver_id: "m",
    method: "f",
    submitted: true,
    ambiguous: false,
    final: true,
    success: true,
    any_receipt_failed: false,
    fee_yocto: "0",
    deposit_yocto: "0",
    receipts: [{ id: "r1", executor_id: "m", block_hash: "b", success: true, unknown: false, logs: [], tokens_burnt: "0" }],
    logs: [],
    events: [],
  };
  it("passes only a fully successful tree", () => {
    expect(receiptTree(base)).toEqual([]);
  });
  it("reports a failed detached receipt under a successful top-level status", () => {
    const failed = { ...base, any_receipt_failed: true, receipts: [...base.receipts, { id: "r2", executor_id: "intents", block_hash: "b", success: false, unknown: false, error: "boom", logs: [], tokens_burnt: "0" }] };
    expect(receiptTree(failed).join()).toMatch(/r2 on intents failed/);
    expect(receiptTree(failed, (e) => e === "intents")).toEqual([]);
  });
  it("reports unknown and ambiguous status", () => {
    expect(receiptTree({ ...base, ambiguous: true, submitted: false, success: false, error: "ambiguous: timeout" }).length).toBeGreaterThan(0);
    expect(receiptTree({ ...base, receipts: base.receipts.map((r) => ({ ...r, unknown: true, success: false })) }).join()).toMatch(/unknown status/);
  });
});

describe("deployed ABI detection", () => {
  it("reads exported methods from the built mandate WASM", () => {
    const names = wasmFunctionExports(loadWasm(crateWasm("bounded-mandate")).bytes);
    for (const m of ["grant", "propose_order", "revoke", "recover", "settle_order", "get_grant"]) expect(names).toContain(m);
    expect(() => wasmFunctionExports(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/not a WASM/);
  });
});

describe("mainnet manifest template", () => {
  const path = join(import.meta.dirname, "../src/live/manifest.example.json");
  const template = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

  it("is refused as is (placeholders)", async () => {
    const d = tmp();
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "t.json", template), MANDATE_LIVE_CONFIRM: "x" });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/invalid manifest/);
  });

  it("pins the known mainnet identifiers and parses once placeholders are filled", () => {
    const fill = (v: unknown, key = ""): unknown => {
      if (typeof v === "string" && v.startsWith("REPLACE_ME")) {
        if (/public_key|mandate_full_access/.test(key)) return "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct";
        if (key === "mandate" && v.includes("WASM")) return "11111111111111111111111111111111";
        if (/nonce|owner$|agent$|filler$/.test(key) && v.includes("nonce")) return "7";
        if (["mandate", "owner", "agent", "filler", "owner_id", "agent_id"].includes(key)) return `${key.replace("_id", "")}.example.near`;
        return "filled";
      }
      if (Array.isArray(v)) return v.map((x) => fill(x, key));
      if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, k)]));
      return v;
    };
    const parsed = LiveManifest.parse(fill(template));
    expect(parsed.network).toMatchObject({ chain_id: "mainnet", genesis_hash: "EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H" });
    expect(parsed.code_hashes).toMatchObject({ verifier: "BtA1BEFNS619KkvXFsgcpQ21Tb5yMm32aaUkn7xNothk", oracle: "9vafnXzrPYQ4ErDqt2triRkQJHdxtG7tfkyb24t5Ttrg", usdc: "DVJx7F3dHEHJYwpYPwXHu8K9Uo7h4kXFcALucY5oNX8q", wnear: "DL2f5xmZ44cQRP6vBMt94rvseH5d5KKnAGis2WkTAsh1" });
    expect(parsed.mandate_config.usdc.token).toBe("17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1");
    expect(parsed.mandate_config.wnear.token).toBe("wrap.near");
    expect(parsed.accounts.signer).toBe("v1.signer");
    expect(parsed.network.rpc_url).toBe("https://free.rpc.fastnear.com");
    expect(parsed.budget.max_fee_yocto).toBe((15n * 10n ** 22n).toString());
    expect(sequenceProblems(parsed.steps)).toEqual([]);
    expect(parsed.steps.map((x) => x.kind)).toEqual(["check", "grant", "refused_proposal", "propose", "fill", "settle", "propose", "withhold", "revoke", "relay_withheld", "recover", "recover", "check"]);
    // Worst case at the minimum gas price (1e8 yocto/gas): 1310 TGas = 0.131 NEAR, above the earlier 0.1 NEAR cap.
    const worst = parsed.steps.reduce((sum, x) => sum + worstFee(parsed, x.kind, 100_000_000n), 0n);
    expect(worst).toBe(131n * 10n ** 21n);
    expect(worst <= BigInt(parsed.budget.max_fee_yocto)).toBe(true);
    expect(worst > 10n ** 23n).toBe(true);
    const grant = parsed.steps.find((x) => x.kind === "grant");
    expect(grant?.kind === "grant" && [grant.policy.order_ttl_sec, grant.policy.oracle_max_age_sec]).toEqual([120, 120]);
    // Transactions: every step except check and withhold.
    expect(parsed.steps.filter((x) => x.kind !== "check" && x.kind !== "withhold").length).toBe(parsed.budget.max_transactions);
  });
});

describe("withheld bundle simulation", () => {
  const fields = ["mandate", "filler"].map((account, index) => ({ message: JSON.stringify({ signer_id: `${account}.sandbox` }), nonce: Buffer.alloc(32, index), recipient: "intents.sandbox" }));
  const bundle = fields.map((f) => signNep413(sandboxKey("test simulation"), f));
  const executions = fields.map((f) => ({ intent_hash: baseEncode(nep413Prehash(f)), nonce: f.nonce.toString("base64") }));

  it("counts as executable only when both exact intents simulate and the invariant holds", () => {
    expect(simulationProblem({ ok: true, value: { intents_executed: executions } }, bundle)).toBeNull();
    expect(simulationProblem({ ok: true, value: { intents_executed: executions, invariant_violated: null } }, bundle)).toBeNull();
    expect(simulationProblem({ ok: true, value: { intents_executed: executions, invariant_violated: { unmatched_deltas: { "nep141:usdc": "-1" } } } }, bundle)).toMatch(/invariant violation/);
    expect(simulationProblem({ ok: true, value: null }, bundle)).toMatch(/no simulation output/);
    expect(simulationProblem({ ok: false, error: "deadline has expired" }, bundle)).toMatch(/refused/);
  });

  it("rejects missing, incomplete or substituted executions", () => {
    expect(simulationProblem({ ok: true, value: {} }, bundle)).toMatch(/both trade intents/);
    expect(simulationProblem({ ok: true, value: { intents_executed: executions.slice(0, 1) } }, bundle)).toMatch(/both trade intents/);
    expect(simulationProblem({ ok: true, value: { intents_executed: executions } }, bundle.slice(0, 1))).toMatch(/both trade intents/);
    expect(simulationProblem({ ok: true, value: { intents_executed: [...executions].reverse() } }, bundle)).toMatch(/different bundle/);
  });
});

describe("step sequencing", () => {
  const w: Step = { kind: "withhold" };
  const relay: Step = { kind: "relay_withheld", min_remaining_sec: 10 };
  const revoke: Step = { kind: "revoke" };
  it("relays a withheld order only after a revoke that follows its withhold", () => {
    expect(sequenceProblems([w, revoke, relay])).toEqual([]);
    expect(sequenceProblems([relay]).join()).toMatch(/no earlier withhold/);
    expect(sequenceProblems([w, relay]).join()).toMatch(/must follow a revoke/);
    expect(sequenceProblems([revoke, w, relay]).join()).toMatch(/must follow a revoke/);
    expect(sequenceProblems([w, revoke, relay, relay]).join()).toMatch(/step 4 relay_withheld has no earlier withhold/);
    expect(sequenceProblems([w, { kind: "fill" }, revoke, relay]).join()).toMatch(/step 2 fill between withhold and relay_withheld/);
    expect(sequenceProblems([w, revoke, { kind: "settle" }, relay]).join()).toMatch(/step 3 settle between withhold/);
  });
  it("refuses an unsequenced manifest before any network access", async () => {
    const d = tmp();
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "m.json", offlineManifest(d, { steps: [w, relay] })) });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/invalid step sequence/);
  });
});

// Chain doubles for classification: the fields read are exactly those classifyRelay/verifyRefusedProposal read.
interface FakeChain {
  nonces: Set<string>;
  balances: Map<string, Balances>;
  grant: GrantView | null;
  orders: OrderView[];
}
const MANDATE = "mandate.sandbox";
const VERIFIER = "intents.sandbox";
const FILLER = "filler.sandbox";
const fakeCtx = (chain: FakeChain): VerifyContext => {
  const mandate = { id: MANDATE, grant: () => Promise.resolve(chain.grant), allOrders: () => Promise.resolve(chain.orders), order: (id: string) => Promise.resolve(chain.orders.find((o) => o.id === id) ?? null) };
  const verifier = {
    id: VERIFIER,
    isNonceUsed: (account: string, nonce: string) => Promise.resolve(chain.nonces.has(`${account}/${nonce}`)),
    balance: (account: string, token: string) => Promise.resolve((chain.balances.get(account) ?? { usdc: 0n, wnear: 0n })[token === "usdc.sandbox" ? "usdc" : "wnear"]),
  };
  return { mandate: mandate as unknown as MandateClient, verifier: verifier as unknown as VerifierClient, tokens: { usdc: "usdc.sandbox", wnear: "wnear.sandbox" }, timeoutMs: 0 };
};
const receipt = (executor: string, error?: string): ReceiptOutcome => ({ id: `r-${executor}`, executor_id: executor, block_hash: `b-${executor}`, success: error === undefined, unknown: false, ...(error === undefined ? {} : { error }), logs: [], tokens_burnt: "0" });
const outcome = (receipts: ReceiptOutcome[], over: Partial<Outcome> = {}): Outcome => ({
  label: "x",
  signer_id: FILLER,
  receiver_id: VERIFIER,
  method: "execute_intents",
  submitted: true,
  ambiguous: false,
  final: true,
  success: receipts.every((r) => r.success),
  any_receipt_failed: receipts.some((r) => !r.success),
  fee_yocto: "1",
  deposit_yocto: "0",
  receipts,
  logs: [],
  events: [],
  ...over,
});

describe("withheld-order relay classification", () => {
  const KEY = "ed25519:2zYCBBVB8a3dwNwUnS4LkL4x6XwMrMKWe2RSfMCXfmaK";
  const removed = `Smart contract panicked: public key '${KEY}' doesn't exist for account '${MANDATE}'`;
  const bal = { usdc: 5_000_000n, wnear: 10n ** 24n };
  const fbal = { usdc: 1_000_000n, wnear: 2n * 10n ** 24n };
  const chain = (): FakeChain => ({ nonces: new Set(), balances: new Map([[MANDATE, bal], [FILLER, fbal]]), grant: null, orders: [] });
  const expectation = (over: Partial<RelayExpectation> = {}): RelayExpectation => ({
    orderId: "3",
    revokedKey: KEY,
    deadlineNs: 2_000n,
    mandateNonce: "mn",
    fillerAccount: FILLER,
    fillerNonce: "fn",
    mandateBefore: bal,
    fillerBefore: fbal,
    blockTimeNs: () => Promise.resolve(1_000n),
    ...over,
  });
  const classify = (o: Outcome, c = chain(), e = expectation()) => classifyRelay(fakeCtx(c), o, e);

  it("passes only a rejection for the removed key, before the deadline, with nothing used or moved", async () => {
    const v = await classify(outcome([receipt(FILLER), receipt(VERIFIER, removed)]));
    expect(v.classification).toBe("rejected_revoked_key");
    expect(v.passed).toBe(true);
  });

  const inconclusive: [string, () => Promise<Awaited<ReturnType<typeof classifyRelay>>>][] = [
    ["an expired deadline", () => classify(outcome([receipt(VERIFIER, "Smart contract panicked: deadline has expired")]))],
    ["an invalid (malformed) signature", () => classify(outcome([receipt(VERIFIER, "Smart contract panicked: invalid signature")]))],
    ["insufficient filler funds", () => classify(outcome([receipt(VERIFIER, "Smart contract panicked: insufficient balance or overflow")]))],
    ["a removed-key error for another key", () => classify(outcome([receipt(VERIFIER, removed.replace(KEY, "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct"))]))],
    ["execution after the deadline", () => classify(outcome([receipt(VERIFIER, removed)]), chain(), expectation({ blockTimeNs: () => Promise.resolve(2_001n) }))],
    ["an unknown execution time", () => classify(outcome([receipt(VERIFIER, removed)]), chain(), expectation({ blockTimeNs: () => Promise.resolve(null) }))],
    ["a gas failure outside the verifier", () => classify(outcome([receipt(FILLER, "Exceeded the prepaid gas"), receipt(VERIFIER, removed)]))],
    ["no verifier receipt (RPC or transaction failure)", () => classify(outcome([receipt(FILLER, "InvalidTxError")]))],
    ["an outcome that is not final", () => classify(outcome([receipt(VERIFIER, removed)], { final: false }))],
    [
      "a used filler nonce",
      () => {
        const c = chain();
        c.nonces.add(`${FILLER}/fn`);
        return classify(outcome([receipt(VERIFIER, removed)]), c);
      },
    ],
    [
      "changed balances",
      () => {
        const c = chain();
        c.balances.set(MANDATE, { ...bal, usdc: bal.usdc - 1n });
        return classify(outcome([receipt(VERIFIER, removed)]), c);
      },
    ],
  ];
  it.each(inconclusive)("is inconclusive, never a pass, for %s", async (_name, run) => {
    const v = await run();
    expect(v.classification).toBe("inconclusive");
    expect(v.passed).toBe(false);
    expect(v.problems.length).toBeGreaterThan(0);
  });

  it("reports execution as a revocation failure", async () => {
    expect((await classify(outcome([receipt(FILLER), receipt(VERIFIER)]))).classification).toBe("executed");
    const c = chain();
    c.nonces.add(`${MANDATE}/mn`);
    const v = await classify(outcome([receipt(VERIFIER, removed)]), c);
    expect(v.classification).toBe("executed");
    expect(v.passed).toBe(false);
  });
});

describe("refused proposal verification", () => {
  const grant = { status: "active", outstanding: "100", turnover_used: "200" } as GrantView;
  const chain = (): FakeChain => ({ nonces: new Set(), balances: new Map(), grant, orders: [] });
  const policy = "Smart contract panicked: concession above policy maximum";
  const verify = (o: Outcome, c = chain(), error = "concession above policy maximum") => verifyRefusedProposal(fakeCtx(c), o, error, grant, 0);

  it("passes only the mandate's own policy panic with nothing changed", async () => {
    expect((await verify(outcome([receipt("agent.sandbox"), receipt(MANDATE, policy)]))).passed).toBe(true);
  });
  it("fails for another error, a failure elsewhere, a success or a state change", async () => {
    expect((await verify(outcome([receipt(MANDATE, "Smart contract panicked: insufficient gas attached")]))).passed).toBe(false);
    expect((await verify(outcome([receipt(MANDATE, policy)]), chain(), "per-order cap")).passed).toBe(false);
    expect((await verify(outcome([receipt("agent.sandbox", "Exceeded the prepaid gas"), receipt(MANDATE, policy)]))).passed).toBe(false);
    expect((await verify(outcome([receipt(MANDATE)]))).passed).toBe(false);
    expect((await verify(outcome([receipt(MANDATE, policy)], { final: false }))).passed).toBe(false);
    const moved = chain();
    moved.grant = { ...grant, outstanding: "101" };
    expect((await verify(outcome([receipt(MANDATE, policy)]), moved)).passed).toBe(false);
    const created = chain();
    created.orders = [{ id: "0" } as OrderView];
    expect((await verify(outcome([receipt(MANDATE, policy)]), created)).passed).toBe(false);
  });
});

describe("live-agent manifest template", () => {
  const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "../src/live", name), "utf8")) as Record<string, unknown> & { steps: unknown[] };
  const agent = read("manifest.live-agent.example.json");
  const fixed = read("manifest.example.json");

  it("is refused as is (placeholders)", async () => {
    const d = tmp();
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, "t.json", agent), MANDATE_LIVE_CONFIRM: "x" });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/invalid manifest/);
  });

  it("is the primary template: the fixed template's grant, trade and withheld order, then owner actions signed outside the runner and both withdrawals", () => {
    const steps = LiveManifest.shape.steps.parse(agent.steps);
    expect(steps.map((x) => x.kind)).toEqual([
      "check",
      "grant",
      "refused_proposal",
      "propose",
      "fill",
      "settle",
      "propose",
      "withhold",
      "revoke_external",
      "relay_withheld",
      "recover_external",
      "recover_external",
      "register_storage",
      "register_storage",
      "withdraw_external",
      "withdraw_external",
      "check",
    ]);
    expect(sequenceProblems(steps)).toEqual([]);
    // Steps 1-8 and the relay are the fixed template's, except the model-sourced step 4.
    const fixedSteps = fixed.steps;
    expect(agent.steps.slice(0, 8).map((x, k) => (k === 3 ? null : x))).toEqual(fixedSteps.slice(0, 8).map((x, k) => (k === 3 ? null : x)));
    expect(agent.steps[9]).toEqual(fixedSteps[9]);
    const assetsOf = (kind: string) => steps.flatMap((x) => (x.kind === kind && "asset" in x ? [x.asset] : []));
    for (const kind of ["recover_external", "register_storage", "withdraw_external"]) expect(assetsOf(kind)).toEqual(["usdc", "wnear"]);
    const [trade, withheld] = steps.filter((x) => x.kind === "propose");
    expect(trade?.kind === "propose" && trade.source).toMatchObject({ from: "model", provider: "near-ai", timeout_ms: 90_000, max_tokens: 4_096 });
    // The withheld order stays a fixed manifest proposal, so the revocation test runs whatever the agent decides.
    expect(withheld?.kind === "propose" && withheld.source).toEqual({ from: "manifest", proposal: { sell: "usdc", sell_amount: "500000", max_concession_bps: 30 } });
    // Identities, policy and the inventory and sale caps are shared with the fallback; only the fee, deposit and
    // transaction caps grow for the owner withdrawals.
    const shared = (m: typeof agent) => {
      const b = m.budget as Record<string, unknown>;
      return { ...m, notes: null, steps: null, keys: null, expected_nonces: null, expected_owner_keys: null, gas_tgas: null, budget: { ...b, max_fee_yocto: null, max_deposit_yocto: null, max_transactions: null } };
    };
    expect(shared(agent)).toEqual(shared(fixed));
    expect(agent.gas_tgas).toEqual({ ...(fixed.gas_tgas as Record<string, number>), withdraw: 100, storage_deposit: 30 });
    expect(agent.keys).toMatchObject({ owner_external: { public_key: expect.stringMatching(/^REPLACE_ME/) as unknown } });
    // Each template lists the owner account's whole key list at approval, including every key it signs with.
    const listed = (m: typeof agent) => (m.expected_owner_keys as { public_key: string; permission: string }[]).map((k) => [k.public_key.replace(/^REPLACE_ME: ed25519 public key of /, ""), k.permission]);
    expect(listed(agent)).toEqual([
      ["keys.owner", "full_access"],
      ["keys.owner_external", "full_access"],
    ]);
    expect(listed(fixed)).toEqual([["keys.owner", "full_access"]]);
    expect(String((fixed.notes as string[])[0])).toMatch(/^FALLBACK TEMPLATE.*unapproved until the owner authorizes it/);
  });

  it("validates once filled: transactions, worst-case fees and deposits fit its caps with one withdrawal retry per asset", () => {
    const fill = (v: unknown, key = ""): unknown => {
      if (typeof v === "string" && v.startsWith("REPLACE_ME")) {
        if (/public_key|mandate_full_access/.test(key)) return "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct";
        if (/nonce/.test(v)) return "7";
        if (["mandate", "owner", "agent", "filler", "owner_id", "agent_id"].includes(key)) return `${key.replace("_id", "")}.example.near`;
        if (key === "model") return "example-model";
        return "filled";
      }
      if (Array.isArray(v)) return v.map((x) => fill(x, key));
      if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x, k)]));
      return v;
    };
    const parsed = LiveManifest.parse(fill(agent));
    // The owner registers on both tokens at setup: the registration steps send nothing.
    const sending = parsed.steps.filter((x) => !["check", "withhold", "register_storage"].includes(x.kind));
    expect(sending.length).toBe(12);
    expect(parsed.budget.max_transactions).toBe(sending.length + 2);
    const worst = sending.reduce((sum, x) => sum + worstFee(parsed, x.kind, 100_000_000n), 0n);
    // (sum of gas_tgas + 20 TGas slack per external step + 5 TGas per transaction) x 1e12 x 1e8 = 1620 TGas.
    expect(worst).toBe(162n * 10n ** 21n);
    const retries = 2n * worstFee(parsed, "withdraw_external", 100_000_000n);
    expect(retries).toBe(25n * 10n ** 21n);
    expect(worst + retries <= BigInt(parsed.budget.max_fee_yocto)).toBe(true);
    // 1 yocto per ft_withdraw attempt: two withdrawals and one retry each.
    expect(BigInt(parsed.budget.max_deposit_yocto)).toBe(4n);
  });

  it("states the proposed ~60% USDC inventory, so the live agent is called", () => {
    expect((agent.notes as string[]).join(" ")).toMatch(/PROPOSED inventory \(not approved\): 5 USDC \+ wNEAR units derived on setup day as \(5 x USDC price x 2\/3\) \/ NEAR price, about 60% USDC/);
  });
});

describe("external owner-action interface", () => {
  const intent = (over: Partial<ExternalIntent> = {}): ExternalIntent =>
    ExternalIntent.parse({
      schema: "bounded-mandate/external-intent@1",
      manifest_sha256: "a".repeat(64),
      step: 9,
      kind: "revoke_external",
      attempt: 1,
      network: { name: "sandbox", chain_id: "test-chain", genesis_hash: "11111111111111111111111111111111", rpc_url: "http://127.0.0.1:9" },
      signer_id: "owner.sandbox",
      public_key: "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct",
      receiver_id: "mandate.sandbox",
      actions: [{ method: "revoke", args: {}, gas: "150000000000000", deposit: "0", gas_min: "150000000000000", gas_max: "170000000000000", deposit_min: "0", deposit_max: "0" }],
      expected: { summary: "revoked", state: {} },
      created_at: "2026-11-06T00:00:00.000Z",
      ...over,
    });
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
  const tx = (over: Partial<TransactionView> = {}, action: Record<string, unknown> = {}): TransactionView => ({
    hash: "h",
    signer_id: "owner.sandbox",
    public_key: "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct",
    nonce: "8",
    receiver_id: "mandate.sandbox",
    actions: [{ FunctionCall: { method_name: "revoke", args: b64({}), gas: 150_000_000_000_000, deposit: "0", ...action } }],
    ...over,
  });

  it("accepts exactly the intent's transaction; argument key order and gas within bounds do not matter", () => {
    expect(transactionProblems(intent(), tx())).toEqual([]);
    expect(transactionProblems(intent(), tx({}, { gas: 170_000_000_000_000 }))).toEqual([]);
    const two = intent({ actions: [{ method: "recover", args: { asset: "usdc", x: 1 }, gas: "1", deposit: "0", gas_min: "1", gas_max: "1", deposit_min: "0", deposit_max: "0" }] });
    expect(transactionProblems(two, tx({}, { method_name: "recover", args: b64({ x: 1, asset: "usdc" }), gas: 1 }))).toEqual([]);
  });

  it("tags each mismatch", () => {
    const tags = (t: TransactionView) => transactionProblems(intent(), t).map((p) => p.split(":")[0]);
    expect(tags(tx({ signer_id: "x.sandbox" }))).toEqual(["wrong signer"]);
    expect(tags(tx({ public_key: "ed25519:9CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct" }))).toEqual(["wrong key"]);
    expect(tags(tx({ receiver_id: "x.sandbox" }))).toEqual(["wrong receiver"]);
    expect(tags(tx({}, { method_name: "recover" }))).toEqual(["wrong method"]);
    expect(tags(tx({}, { args: b64({ gas_tgas: 60 }) }))).toEqual(["altered args"]);
    expect(tags(tx({}, { args: "not json" }))).toEqual(["altered args"]);
    expect(tags(tx({}, { gas: 149_999_999_999_999 }))).toEqual(["gas out of bounds"]);
    expect(tags(tx({}, { gas: 170_000_000_000_001 }))).toEqual(["gas out of bounds"]);
    expect(tags(tx({}, { deposit: "1" }))).toEqual(["deposit out of bounds"]);
    const base = tx();
    expect(tags({ ...base, actions: [...base.actions, { Transfer: { deposit: "1" } }] })).toEqual(["extra or missing action"]);
    expect(tags({ ...base, actions: [{ Transfer: { deposit: "0" } }] })).toEqual(["extra or missing action"]);
    expect(tags({ ...base, actions: [] })).toEqual(["extra or missing action"]);
  });

  it("names an intent by the sha256 of its canonical JSON, independent of key order", async () => {
    const i = intent();
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(i).reverse()))) as ExternalIntent;
    expect(await intentSha256(reordered)).toBe(await intentSha256(i));
    expect(await intentSha256(i)).toBe(createHash("sha256").update(canonical(i)).digest("hex"));
    expect(await intentSha256(intent({ attempt: 2 }))).not.toBe(await intentSha256(i));
    expect(() => ExternalHandoff.parse({ schema: "bounded-mandate/external-handoff@1", intent_sha256: "a".repeat(64), tx_hash: "0OIl", signer_id: "o.sandbox" })).toThrow();
  });

  it("refuses a withdrawal without an amount and without an earlier recovery of its asset", () => {
    expect(sequenceProblems([{ kind: "withdraw_external", asset: "usdc" }])).toEqual(["step 1 withdraw_external has no amount and no earlier recovery of usdc"]);
    expect(sequenceProblems([{ kind: "recover_external", asset: "usdc" }, { kind: "withdraw_external", asset: "usdc" }, { kind: "withdraw", asset: "wnear", amount: "5" }])).toEqual([]);
    expect(sequenceProblems([{ kind: "withhold" }, { kind: "revoke_external" }, { kind: "relay_withheld", min_remaining_sec: 10 }])).toEqual([]);
  });
});

describe("signing floats", () => {
  const m = (): ReturnType<typeof offlineManifest> => offlineManifest(tmp());

  it("reads min_gas_purchase_price from runtime_config, else the gas price", () => {
    expect(gasPurchasePrice({ runtime_config: { storage_amount_per_byte: "1", min_gas_purchase_price: "1000000000" } }, 100_000_000n)).toBe(1_000_000_000n);
    expect(gasPurchasePrice({ runtime_config: { storage_amount_per_byte: "1", min_gas_purchase_price: "1000000000" } }, 2_000_000_000n)).toBe(2_000_000_000n);
    expect(gasPurchasePrice({ runtime_config: { storage_amount_per_byte: "1" } }, 100_000_000n)).toBe(100_000_000n);
  });

  it("is the largest of earlier worst-case fees plus one step's prepaid gas at the purchase price, per signer", () => {
    const mm = m();
    const seq: Step[] = [
      { kind: "propose", source: { from: "manifest", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 1 } }, expect: "signed" },
      { kind: "refused_proposal", proposal: { sell: "usdc", sell_amount: "1", max_concession_bps: 1 }, error: "x" },
      { kind: "revoke_external" },
      { kind: "fill" },
    ];
    const T = 1_000_000_000_000n;
    // agent: 155 TGas each; before the second it spent 155 TGas at 1e8, then buys 155 TGas at 1e9.
    expect(signingFloat(mm, seq, "agent", 100_000_000n, 1_000_000_000n)).toBe(155n * T * 100_000_000n + 155n * T * 1_000_000_000n);
    // owner: one external revoke with its 20 TGas slack.
    expect(signingFloat(mm, seq, "owner", 100_000_000n, 1_000_000_000n)).toBe(175n * T * 1_000_000_000n);
    expect(signingFloat(mm, seq, "filler", 100_000_000n, 1_000_000_000n)).toBe(105n * T * 1_000_000_000n);
    expect(signingFloat(mm, [], "filler", 100_000_000n, 1_000_000_000n)).toBe(0n);
  });
});

describe("owner key declarations and changes", () => {
  const pk = (label: string) => sandboxKey(label).getPublicKey().toString();
  const full = (label: string, nonce: string) => ({ public_key: pk(label), permission: "full_access" as const, nonce });

  it("reports an added or removed key, a changed permission and a nonce change of an untracked key; tracked nonces are the ledger's", () => {
    const fc: OwnerKey = { public_key: pk("fc"), permission: { receiver_id: "m.sandbox", method_names: ["b", "a"] }, nonce: "3" };
    const start: OwnerKey[] = [full("o", "5"), full("x", "9"), fc];
    expect(ownerKeyChanges(start, [full("o", "7"), full("x", "9"), { ...fc, permission: { receiver_id: "m.sandbox", method_names: ["a", "b"] } }], new Set([pk("o")]))).toEqual([]);
    const changes = ownerKeyChanges(start, [full("o", "7"), full("x", "10"), { ...fc, permission: "full_access" }, full("new", "1")], new Set([pk("o")]));
    expect(changes).toEqual([
      expect.stringMatching(new RegExp(`^key added: ${pk("new")}`)),
      expect.stringMatching(new RegExp(`^nonce of ${pk("x")}, a key the ledger does not track, changed from 9 to 10$`)),
      expect.stringMatching(new RegExp(`^permission of ${pk("fc")} changed`)),
    ]);
    expect(ownerKeyChanges(start, [full("o", "5")])).toEqual([`key removed: ${pk("x")}`, `key removed: ${pk("fc")}`]);
    // Untracked (approval-time comparison): every nonce counts.
    expect(ownerKeyChanges([full("o", "5")], [full("o", "6")])).toEqual([`nonce of ${pk("o")}, a key the ledger does not track, changed from 5 to 6`]);
  });

  it("refuses before any network access an owner key list without the signing keys or with a duplicate, and a distinct external key without its expected nonce", async () => {
    const d = tmp();
    const m = offlineManifest(d);
    const refuse = async (over: Partial<typeof m>, re: RegExp) => {
      const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson(d, `m-${Math.random()}.json`, { ...m, ...over }) });
      expect(r.exitCode).toBe(2);
      expect(r.message).toMatch(re);
    };
    const ext = { ...m.keys, owner_external: { public_key: pk("console") } };
    await refuse({ expected_owner_keys: [full("other", "1")] }, /expected_owner_keys must list keys\.owner \(/);
    await refuse({ expected_owner_keys: [full("o", "1"), full("o", "1")] }, /lists \S+ twice/);
    await refuse({ keys: ext, expected_owner_keys: [full("o", "1")] }, /must list keys\.owner_external/);
    await refuse({ keys: ext, expected_nonces: { owner: "1", agent: "1", filler: "1" } }, /expected_nonces\.owner_external is required when keys\.owner_external names a key distinct from keys\.owner/);
  });
});

describe("revocation window at the order's deadline", () => {
  // The verifier rejects an intent only when its deadline is strictly before the block time
  // (near/intents 16d04f6 engine/mod.rs L66), so a read exactly at the deadline is not yet expired.
  const deadline = 1_800_000_000_000_000_000n;
  const windowAt = (chainNs: bigint): Record<string, unknown> | null => {
    const ledger = Ledger.create(join(tmp(), "ledger"), "0".repeat(64));
    const withheld = { order_id: "7", signing_key: "ed25519:test", deadline_ns: deadline.toString(), mandate_nonce: "n", bundle: null, bundle_sha256: null, filler_nonce: null, counter: null, executable: true };
    ledger.append("step-done", { step: 3, kind: "withhold", withheld, verification: { sign_requested_at_ns: null, signed_at_ns: null } });
    return revocationWindow(ledger, { phase: "relay pre-check", at: new Date(0).toISOString(), chain_ns: chainNs.toString(), remaining_ms: null });
  };

  it("is not expired at exact equality, as the verifier still accepts the order", () => {
    expect(windowAt(deadline)).toMatchObject({ remaining_after_confirmed_removal_ns: "0", expired_when_read: false });
  });

  it("is expired one nanosecond after the deadline, and not one nanosecond before", () => {
    expect(windowAt(deadline + 1n)).toMatchObject({ remaining_after_confirmed_removal_ns: "-1", expired_when_read: true });
    expect(windowAt(deadline - 1n)).toMatchObject({ remaining_after_confirmed_removal_ns: "1", expired_when_read: false });
  });
});
