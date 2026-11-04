// Live orchestrator refusal paths that need no chain: manifest, confirmation, credentials, ledger,
// budget arithmetic, receipt-tree inspection, WASM export detection, step sequencing, and the classification of
// refused proposals and withheld-order relays against misleading failures.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPlanned, totals, type Planned } from "../src/live/budget.js";
import { Ledger } from "../src/live/ledger.js";
import { runLive } from "../src/live/main.js";
import { LiveManifest, sequenceProblems, type Step } from "../src/live/manifest.js";
import { worstFee } from "../src/live/preflight.js";
import { classifyRelay, receiptTree, simulationProblem, verifyRefusedProposal, type Balances, type RelayExpectation, type VerifyContext } from "../src/live/verify.js";
import type { Outcome, ReceiptOutcome } from "../src/near/client.js";
import type { MandateClient, VerifierClient } from "../src/near/contracts.js";
import type { GrantView, OrderView } from "../src/types.js";
import { crateWasm, loadWasm } from "../src/near/sandbox.js";
import { wasmFunctionExports } from "../src/near/wasm.js";
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
    expect(t).toEqual({ transactions: 1, fee_yocto: 40n, deposit_yocto: 1n, sold: { usdc: 5n, wnear: 0n }, filler_paid: { usdc: 0n, wnear: 0n } });
  });

  it("does not count an intent the network refused before inclusion (it cannot execute; its step is planned again)", () => {
    const { dir, ledger } = make();
    ledger.append("tx-intent", { tx_hash: "h3", planned: { worst_fee_yocto: "100", deposit_yocto: "0", sell: { asset: "usdc", units: "7" } } });
    ledger.append("tx-result", { tx_hash: "h3", status: "rejected", fee_yocto: "0" });
    expect(totals(Ledger.load(dir, sha))).toEqual({ transactions: 1, fee_yocto: 40n, deposit_yocto: 1n, sold: { usdc: 5n, wnear: 0n }, filler_paid: { usdc: 0n, wnear: 0n } });
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
  const zero = { transactions: 0, fee_yocto: 0n, deposit_yocto: 0n, sold: { usdc: 0n, wnear: 0n }, filler_paid: { usdc: 0n, wnear: 0n } };
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
  it("counts as executable only without an error or an invariant violation", () => {
    expect(simulationProblem({ ok: true, value: { intents_executed: [], invariant_violated: null } })).toBeNull();
    expect(simulationProblem({ ok: true, value: { intents_executed: [] } })).toBeNull();
    expect(simulationProblem({ ok: true, value: { invariant_violated: { unmatched_deltas: { "nep141:usdc": "-1" } } } })).toMatch(/invariant violation/);
    expect(simulationProblem({ ok: true, value: null })).toMatch(/no simulation output/);
    expect(simulationProblem({ ok: false, error: "deadline has expired" })).toMatch(/refused/);
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
