// gate: LAB — the sandbox lab operated through its HTTP API on the exact deployment candidate, the pinned verifier
// and the hash-pinned prebuilt TEST DOUBLES (MPC signer, price oracle, tokens): the full visitor workflow with chain
// receipts for every step, limits that change outcomes, reset, and an exported scenario replayed on a fresh sandbox.
// Expected values come from the market constants, from the chain read independently of the lab's answers, or from
// arithmetic done here; none is copied from a run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { valueUnits } from "../src/agent/snapshot.js";
import { DECIMALS, DEPOSITS, PRICES } from "../src/demo/market.js";
import { removedKeyError } from "../src/evidence/journey.js";
import { CaseRecorder } from "../src/evidence/report.js";
import type { ActionRecord } from "../src/lab/actions.js";
import { DEFAULT_CONFIG, LAB_POLICY, TEST_DOUBLES, configFromEnv } from "../src/lab/config.js";
import { Lab, type SessionView } from "../src/lab/lab.js";
import { replayFile } from "../src/lab/replay.js";
import { REPLAY_COMMAND, Scenario, differences, normalize } from "../src/lab/scenario.js";
import { STARTING_BALANCES } from "../src/lab/world.js";
import { NearClient } from "../src/near/client.js";
import { REPO_ROOT } from "../src/near/sandbox.js";
import { QUICK_WASM } from "../src/quick/prebuilt.js";
import { act, labWasm, panicOf, proposed, serve, startSession, view, type Served } from "./lab-helpers.js";

const cases = {
  workflow: new CaseRecorder("LAB", "workflow", ["starts-from-the-deposits", "grant-registers-the-key", "permitted-trade-fills", "unsafe-trades-refused-by-the-contract", "poor-trade-permitted-and-filled", "withheld-order-rejected-after-revocation", "recovery-without-agent-oracle-signer", "every-step-has-chain-receipts"]),
  limits: new CaseRecorder("LAB", "limits-change-outcomes", ["same-trades-other-limits", "contract-validates-the-limits"]),
  reset: new CaseRecorder("LAB", "reset", ["clean-reproducible-start", "usable-after-reset"]),
  replay: new CaseRecorder("LAB", "export-replay", ["scenario-names-revision-binaries-doubles", "replays-to-the-same-outcomes", "a-different-outcome-is-reported", "other-binaries-are-refused"]),
};

let lab: Served;
let tmp: string;
let session: SessionView;
/** The workflow's records by step name, shared by the checks that follow it. */
const step: Record<string, ActionRecord> = {};

beforeAll(async () => {
  lab = await serve({ sessionStartsPerHour: 100, maxSessions: 6, maxSessionsPerClient: 6 });
  tmp = mkdtempSync(join(tmpdir(), "bm-lab-test-"));
  session = await startSession(lab);
}, 180_000);

afterAll(async () => {
  const bound = labWasm(lab.lab);
  for (const c of Object.values(cases)) c.write("sandbox", bound.wasm, bound.data);
  await lab.close();
  rmSync(tmp, { recursive: true, force: true });
});

const units = (b: { usdc: string; wnear: string }) => ({ usdc: BigInt(b.usdc), wnear: BigInt(b.wnear) });
const USDC_50 = (50n * 10n ** 6n).toString();

/** wNEAR units 50 USDC is worth at the posted prices (both at exponent -8), before any concession. */
const fairWnear = (sellUsdc: bigint): bigint => (sellUsdc * PRICES.usdc.price * 10n ** BigInt(DECIMALS.wnear - DECIMALS.usdc)) / PRICES.wnear.price;

describe("the lab workflow over HTTP", () => {
  // gate: LAB
  it("starts every session from the same deposits, with no grant", () => cases.workflow.check("starts-from-the-deposits", () => {
    expect(session.state.balances).toEqual(STARTING_BALANCES);
    expect(STARTING_BALANCES.mandate).toEqual({ usdc: DEPOSITS.usdc.toString(), wnear: DEPOSITS.wnear.toString() });
    expect(session.state.grant).toBeNull();
    expect(session.state.orders).toEqual([]);
    expect(session.state.key_on_verifier).toBeNull();
  }));

  // gate: LAB
  it("grants with the visitor's limits: the contract activates the grant and registers its key", () => cases.workflow.check("grant-registers-the-key", async () => {
    step.grant = await act(lab, session.session_id, "grant", { policy: LAB_POLICY });
    const grant = step.grant.state.grant;
    expect(grant?.status).toBe("active");
    expect(grant?.policy).toEqual(LAB_POLICY);
    expect(step.grant.state.key_on_verifier).toBe(true);
    const expected = valueUnits(DEPOSITS.usdc, DECIMALS.usdc, { price: PRICES.usdc.price.toString(), expo: PRICES.usdc.expo }) + valueUnits(DEPOSITS.wnear, DECIMALS.wnear, { price: PRICES.wnear.price.toString(), expo: PRICES.wnear.expo });
    expect(grant?.initial_value).toBe(expected.toString());
  }));

  // gate: LAB
  it("a permitted trade is signed by the contract and filled on the verifier", () => cases.workflow.check("permitted-trade-fills", async () => {
    step.permitted = await act(lab, session.session_id, "propose", { sell: "usdc", sell_amount: USDC_50, max_concession_bps: 20 });
    const o = proposed(step.permitted);
    expect(o.state.state).toBe("signed");
    const buy = BigInt(o.buy_amount ?? "0");
    const fair = fairWnear(BigInt(USDC_50));
    // The signed price gives up at most 20 bps against the posted reference, and nothing is gained over it.
    expect(buy * 10_000n).toBeGreaterThanOrEqual(fair * (10_000n - 20n));
    expect(buy).toBeLessThanOrEqual(fair);
    const before = units(step.permitted.state.balances.mandate);
    step.fill = await act(lab, session.session_id, "fill", { order_id: o.id });
    expect(units(step.fill.state.balances.mandate)).toEqual({ usdc: before.usdc - BigInt(USDC_50), wnear: before.wnear + buy });
    expect(step.fill.state.orders.find((x) => x.id === o.id)?.state).toEqual({ state: "released", reason: "settled" });
  }));

  // gate: LAB
  it("unsafe trades are refused by the mandate contract itself, and nothing changes", () => cases.workflow.check("unsafe-trades-refused-by-the-contract", async () => {
    const before = step.fill?.state;
    if (before === undefined) throw new Error("the permitted trade did not run");
    const mandate = before.accounts.mandate;
    // 600 USDC is about 31% of the starting value; the limit per order is 20%. 500 bps is ten times the 50 bps limit.
    const expectRefusal = (r: ActionRecord, message: string): void => {
      const tx = r.transactions.at(-1);
      expect(tx?.method).toBe("propose_order");
      expect(tx?.success).toBe(false);
      const refusing = tx?.receipts.find((x) => !x.success);
      expect(refusing?.executor_id).toBe(mandate);
      expect(panicOf(refusing?.error ?? null)).toBe(message);
      expect(r.state.orders).toEqual(before.orders);
      expect(r.state.balances).toEqual(before.balances);
      expect(r.state.grant?.turnover_used).toBe(before.grant?.turnover_used);
    };
    step.tooLarge = await act(lab, session.session_id, "propose", { sell: "usdc", sell_amount: (600n * 10n ** 6n).toString(), max_concession_bps: 20 });
    expectRefusal(step.tooLarge, "per-order cap exceeded");
    step.tooPoor = await act(lab, session.session_id, "propose", { sell: "usdc", sell_amount: USDC_50, max_concession_bps: 500 });
    expectRefusal(step.tooPoor, "concession above policy maximum");
  }));

  // gate: LAB
  it("a poor but permitted trade (the maximum concession) is still signed and filled", () => cases.workflow.check("poor-trade-permitted-and-filled", async () => {
    step.poor = await act(lab, session.session_id, "propose", { sell: "usdc", sell_amount: USDC_50, max_concession_bps: LAB_POLICY.max_concession_bps });
    const o = proposed(step.poor);
    expect(o.state.state).toBe("signed");
    const buy = BigInt(o.buy_amount ?? "0");
    const fair = fairWnear(BigInt(USDC_50));
    const max = BigInt(LAB_POLICY.max_concession_bps);
    // Worse for the owner than the 20 bps trade by more than 49 bps of the reference, and never beyond the limit.
    expect(buy * 10_000n).toBeGreaterThanOrEqual(fair * (10_000n - max));
    expect(buy * 10_000n).toBeLessThan(fair * (10_000n - (max - 1n)));
    expect(buy).toBeLessThan(BigInt(proposed(step.permitted as ActionRecord).buy_amount ?? "0"));
    const before = units(step.poor.state.balances.mandate);
    step.poorFill = await act(lab, session.session_id, "fill", { order_id: o.id });
    expect(units(step.poorFill.state.balances.mandate)).toEqual({ usdc: before.usdc - BigInt(USDC_50), wnear: before.wnear + buy });
  }));

  // gate: LAB
  it("a withheld signed order executes in the verifier's dry run, and is rejected for the removed key after revocation", () => cases.workflow.check("withheld-order-rejected-after-revocation", async () => {
    step.toWithhold = await act(lab, session.session_id, "propose", { sell: "wnear", sell_amount: (20n * 10n ** 24n).toString(), max_concession_bps: 30 });
    const o = proposed(step.toWithhold);
    expect(o.state.state).toBe("signed");
    const grantKey = step.toWithhold.state.grant?.public_key ?? "";
    expect(grantKey).toMatch(/^ed25519:/);
    step.withhold = await act(lab, session.session_id, "withhold", { order_id: o.id });
    expect(step.withhold.transactions).toEqual([]);
    expect(step.withhold.result.executable_now).toBe(true);
    expect(step.withhold.state.withheld).toEqual([{ order_id: o.id, relayed: false }]);

    step.revoke = await act(lab, session.session_id, "revoke");
    expect(step.revoke.transactions.map((t) => [t.method, t.success, t.any_receipt_failed])).toEqual([["revoke", true, false]]);
    expect(step.revoke.state.grant?.status).toBe("revoked");
    expect(step.revoke.state.key_on_verifier).toBe(false);
    expect(step.revoke.state.orders.find((x) => x.id === o.id)?.state).toEqual({ state: "released", reason: "key_removed" });

    step.relay = await act(lab, session.session_id, "relay", { order_id: o.id });
    const tx = step.relay.transactions[0];
    expect(tx?.method).toBe("execute_intents");
    expect(tx?.signer_id).toBe(step.relay.state.accounts.relayer);
    expect(tx?.success).toBe(false);
    const refusing = tx?.receipts.find((x) => !x.success);
    expect(refusing?.executor_id).toBe(step.relay.state.accounts.verifier);
    // The verifier's own words, for the key the grant held before revocation.
    expect(panicOf(refusing?.error ?? null)).toBe(removedKeyError(grantKey, step.relay.state.accounts.mandate));
    expect(step.relay.result).toMatchObject({ executed: false, rejected_for_removed_key: true, before_deadline: true, not_a_revocation_rejection_because: [] });
    // Still inside the order's lifetime by the chain's clock: the rejection is not an expiry.
    expect(BigInt(step.relay.state.block_time_ns)).toBeLessThan(BigInt(o.deadline_ns ?? "0"));
    expect(step.relay.state.balances).toEqual(step.revoke.state.balances);
  }), 120_000);

  // gate: LAB
  it("recovers both assets to the owner's Intents account with the oracle and the signer doubles failing", () => cases.workflow.check("recovery-without-agent-oracle-signer", async () => {
    step.oracleOff = await act(lab, session.session_id, "set_oracle", { available: false });
    step.signerOff = await act(lab, session.session_id, "set_signer", { available: false });
    expect(step.signerOff.state.oracle.available).toBe(false);
    expect(step.signerOff.state.signer_mode).toBe("immediate_error");
    const held = units(step.signerOff.state.balances.mandate);
    expect(held.usdc + held.wnear).toBeGreaterThan(0n);
    step.recover = await act(lab, session.session_id, "recover");
    expect(step.recover.transactions.map((t) => [t.method, t.success, t.any_receipt_failed])).toEqual([["recover", true, false], ["recover", true, false]]);
    expect(units(step.recover.state.balances.mandate)).toEqual({ usdc: 0n, wnear: 0n });
    expect(units(step.recover.state.balances.owner_intents)).toEqual(held);
  }));

  // gate: LAB
  it("every step returned the chain's own transactions and receipts", () => cases.workflow.check("every-step-has-chain-receipts", async () => {
    const names = ["grant", "permitted", "fill", "tooLarge", "tooPoor", "poor", "poorFill", "toWithhold", "withhold", "revoke", "relay", "oracleOff", "signerOff", "recover"];
    const [rpcUrl] = lab.lab.stats().rpcUrls;
    if (rpcUrl === undefined) throw new Error("no sandbox process");
    // Read straight from the sandbox node, bypassing the lab.
    const chain = new NearClient(rpcUrl);
    let transactions = 0;
    for (const name of names) {
      const record = step[name];
      if (record === undefined) throw new Error(`step ${name} did not run`);
      expect(record.transactions.length, name).toBeGreaterThan(name === "withhold" ? -1 : 0);
      for (const tx of record.transactions) {
        expect(tx.tx_hash, name).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
        expect(tx.receipts.length, name).toBeGreaterThan(0);
        const onChain = await chain.resolve(tx.label, tx.signer_id, tx.tx_hash ?? "", tx.method);
        expect(onChain, `${name}: ${tx.label}`).not.toBeNull();
        const chainReceipts = new Map((onChain?.receipts ?? []).map((r) => [r.id, [r.executor_id, r.success, r.error ?? null, r.logs]]));
        for (const r of tx.receipts) expect([r.executor_id, r.success, r.error, r.logs], `${name}: receipt ${r.receipt_id}`).toEqual(chainReceipts.get(r.receipt_id));
        // The node answers before gas refunds execute; nothing else may be missing from the lab's answer.
        const returned = new Set(tx.receipts.map((r) => r.receipt_id));
        for (const r of onChain?.receipts ?? []) {
          if (!returned.has(r.id)) expect([r.executor_id, r.success, r.logs], `${name}: unreported receipt ${r.id}`).toEqual([tx.signer_id, true, []]);
        }
        expect(tx.success).toBe(onChain?.success);
        transactions += 1;
      }
    }
    expect(transactions).toBeGreaterThanOrEqual(names.length);
    const log = await lab.api("GET", `/api/sessions/${session.session_id}/log`);
    expect((log.body.log as ActionRecord[]).map((r) => r.action)).toEqual(names.map((n) => (step[n] as ActionRecord).action));
  }));
});

describe("limits decide the outcomes", () => {
  // gate: LAB
  it("the same two proposals are signed under the starting limits and refused under tighter ones", () => cases.limits.check("same-trades-other-limits", async () => {
    const tight = { ...LAB_POLICY, per_order_cap_bps: 500, outstanding_cap_bps: 500, max_concession_bps: 10 };
    const [wide, narrow] = await Promise.all([startSession(lab, "198.51.100.11"), startSession(lab, "198.51.100.12")]);
    const [gw, gn] = await Promise.all([act(lab, wide.session_id, "grant", { policy: LAB_POLICY }), act(lab, narrow.session_id, "grant", { policy: tight })]);
    expect([gw.state.grant?.status, gn.state.grant?.status]).toEqual(["active", "active"]);
    expect(gn.state.grant?.policy).toEqual(tight);
    // 200 USDC is about 10.5% of the starting value: inside a 20% limit per order, outside a 5% one.
    const large = { sell: "usdc", sell_amount: (200n * 10n ** 6n).toString(), max_concession_bps: 5 };
    // 30 bps: inside a 50 bps limit, outside a 10 bps one.
    const poor = { sell: "usdc", sell_amount: (20n * 10n ** 6n).toString(), max_concession_bps: 30 };
    const [w1, n1] = await Promise.all([act(lab, wide.session_id, "propose", large), act(lab, narrow.session_id, "propose", large)]);
    const [w2, n2] = await Promise.all([act(lab, wide.session_id, "propose", poor), act(lab, narrow.session_id, "propose", poor)]);
    expect([proposed(w1).state.state, proposed(w2).state.state]).toEqual(["signed", "signed"]);
    expect(n1.transactions.at(-1)?.success).toBe(false);
    expect(panicOf(n1.transactions.at(-1)?.error ?? null)).toBe("per-order cap exceeded");
    expect(panicOf(n2.transactions.at(-1)?.error ?? null)).toBe("concession above policy maximum");
    expect(n2.state.orders).toEqual([]);
    for (const id of [wide.session_id, narrow.session_id]) expect((await lab.api("DELETE", `/api/sessions/${id}`)).status).toBe(200);
  }), 240_000);

  // gate: LAB
  it("limits the contract does not accept are refused by the contract, not by the lab", () => cases.limits.check("contract-validates-the-limits", async () => {
    const s = await startSession(lab, "198.51.100.13");
    // Well-formed for the lab (an integer of the field's width); a zero cap is the contract's to refuse.
    const r = await act(lab, s.session_id, "grant", { policy: { ...LAB_POLICY, per_order_cap_bps: 0 } });
    const tx = r.transactions.at(-1);
    expect(tx?.method).toBe("grant");
    expect(tx?.success).toBe(false);
    expect(tx?.receipts.find((x) => !x.success)?.executor_id).toBe(r.state.accounts.mandate);
    expect(panicOf(tx?.error ?? null)).toBe("per_order_cap_bps must be in 1..=10000");
    expect(r.state.grant).toBeNull();
    expect((await lab.api("DELETE", `/api/sessions/${s.session_id}`)).status).toBe(200);
  }), 120_000);
});

describe("reset", () => {
  // gate: LAB
  it("replaces the world with a clean one that equals a new session's start", () => cases.reset.check("clean-reproducible-start", async () => {
    const before = await view(lab, session.session_id);
    expect(before.state.orders.length).toBeGreaterThan(0);
    expect(before.state.balances).not.toEqual(STARTING_BALANCES);
    const r = await lab.api("POST", `/api/sessions/${session.session_id}/reset`);
    expect(r.status, r.text).toBe(200);
    const after = r.body.session as SessionView;
    expect(after.session_id).toBe(session.session_id);
    expect(after.resets).toBe(1);
    expect(after.actions_used).toBe(0);
    expect(after.state.balances).toEqual(STARTING_BALANCES);
    expect(after.state.grant).toBeNull();
    expect(after.state.orders).toEqual([]);
    expect(after.state.withheld).toEqual([]);
    expect(after.state.oracle.available).toBe(true);
    expect(after.state.signer_mode).toBe("immediate");
    // A new world: no account of the old one is reused.
    const old = new Set(Object.values(before.state.accounts));
    for (const account of Object.values(after.state.accounts)) expect(old.has(account)).toBe(false);
    expect((await lab.api("GET", `/api/sessions/${session.session_id}/log`)).body.log).toEqual([]);
    // Apart from its account scope and the clock, the state is the one the session first started with.
    const scopeOf = (v: SessionView): string => v.state.accounts.mandate.split(".")[1] ?? "";
    expect(differences(normalize(session.state, scopeOf(session)), normalize(after.state, scopeOf(after)))).toEqual([]);
    session = after;
  }), 120_000);

  // gate: LAB
  it("the reset session works again from epoch 1", () => cases.reset.check("usable-after-reset", async () => {
    const g = await act(lab, session.session_id, "grant", { policy: LAB_POLICY });
    expect(g.seq).toBe(1);
    expect(g.state.grant?.status).toBe("active");
    expect(g.state.grant?.epoch).toBe(1);
    const p = await act(lab, session.session_id, "propose", { sell: "usdc", sell_amount: USDC_50, max_concession_bps: 20 });
    expect(proposed(p).id).toBe("0");
    expect(proposed(p).state.state).toBe("signed");
  }));
});

describe("exported scenario", () => {
  let scenario: Scenario;
  let file: string;
  const sha256 = (rel: string): string => createHash("sha256").update(readFileSync(join(REPO_ROOT, "fixtures", rel))).digest("hex");
  const git = (...args: string[]): string => execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();

  // gate: LAB
  it("names the source revision, the WASM hashes and the labelled test doubles, with every action in order", () => cases.replay.check("scenario-names-revision-binaries-doubles", async () => {
    // A session of its own: owner, agent, filler, a withheld order across revocation, recovery, and one comparison run.
    const s = await startSession(lab, "198.51.100.21");
    const id = s.session_id;
    await act(lab, id, "grant", { policy: LAB_POLICY }, "198.51.100.21");
    const first = await act(lab, id, "propose", { sell: "usdc", sell_amount: USDC_50, max_concession_bps: 20 }, "198.51.100.21");
    await act(lab, id, "fill", { order_id: proposed(first).id }, "198.51.100.21");
    await act(lab, id, "propose", { sell: "usdc", sell_amount: (600n * 10n ** 6n).toString(), max_concession_bps: 20 }, "198.51.100.21");
    const held = await act(lab, id, "propose", { sell: "wnear", sell_amount: (20n * 10n ** 24n).toString(), max_concession_bps: 50 }, "198.51.100.21");
    await act(lab, id, "withhold", { order_id: proposed(held).id }, "198.51.100.21");
    await act(lab, id, "revoke", {}, "198.51.100.21");
    await act(lab, id, "relay", { order_id: proposed(held).id }, "198.51.100.21");
    await act(lab, id, "recover", {}, "198.51.100.21");
    await act(lab, id, "alternative", { id: "cancel_incomplete" }, "198.51.100.21");
    const log = (await lab.api("GET", `/api/sessions/${id}/log`)).body.log as ActionRecord[];
    const exported = await lab.api("GET", `/api/sessions/${id}/export`);
    expect(exported.status).toBe(200);
    scenario = Scenario.parse(exported.body.scenario);

    expect(scenario.source).toEqual({ revision: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain") !== "" });
    for (const [role, rel] of Object.entries(QUICK_WASM)) {
      expect(scenario.wasm[role as keyof typeof QUICK_WASM]).toEqual({ path: `fixtures/${rel}`, sha256: sha256(rel) });
    }
    expect(scenario.test_doubles.map((d) => [d.role, d.sha256])).toEqual(TEST_DOUBLES.map((d) => [d.role, sha256(QUICK_WASM[d.wasm])]));
    for (const d of scenario.test_doubles) expect(d.note).toContain("TEST DOUBLE");
    expect(scenario.label).toContain("TEST DOUBLES");
    expect(scenario.replay_command).toBe(REPLAY_COMMAND);
    expect(scenario.actions.map((a) => [a.seq, a.action, a.input])).toEqual(log.map((r) => [r.seq, r.action, r.input]));
    // Outcomes carry no value tied to this run's accounts, transactions or clock.
    const text = JSON.stringify(scenario.actions);
    expect(text).not.toContain(s.state.accounts.mandate.split(".")[1]);
    for (const tx of log.flatMap((r) => r.transactions)) expect(text).not.toContain(tx.tx_hash);
    file = join(tmp, "scenario.json");
    writeFileSync(file, JSON.stringify(scenario, null, 2));
    expect((await lab.api("DELETE", `/api/sessions/${id}`, undefined, "198.51.100.21")).status).toBe(200);
  }), 240_000);

  // gate: LAB
  it("replays on a fresh sandbox to the same outcomes", () => cases.replay.check("replays-to-the-same-outcomes", async () => {
    const result = await replayFile(file);
    expect(result.problems).toEqual([]);
    expect(result.matches).toBe(true);
    expect(result.actions.map((a) => [a.seq, a.matches])).toEqual(scenario.actions.map((a) => [a.seq, true]));
  }), 300_000);

  // gate: LAB
  it("reports a recorded outcome that the replay does not reproduce", () => cases.replay.check("a-different-outcome-is-reported", async () => {
    // The first two actions, with the recorded price of the signed order raised by one unit.
    const [grant, propose] = scenario.actions;
    if (grant === undefined || propose === undefined) throw new Error("scenario too short");
    const outcome = structuredClone(propose.outcome) as { result: { order: { buy_amount: string } } };
    outcome.result.order.buy_amount = (BigInt(outcome.result.order.buy_amount) + 1n).toString();
    const altered = join(tmp, "altered.json");
    writeFileSync(altered, JSON.stringify({ ...scenario, actions: [grant, { ...propose, outcome }] }));
    const result = await replayFile(altered);
    expect(result.matches).toBe(false);
    expect(result.actions.map((a) => a.matches)).toEqual([true, false]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("$.result.order.buy_amount");
  }), 300_000);

  // gate: LAB
  it("refuses to compare a scenario that ran other binaries", () => cases.replay.check("other-binaries-are-refused", async () => {
    const other = join(tmp, "other.json");
    writeFileSync(other, JSON.stringify({ ...scenario, wasm: { ...scenario.wasm, mandate: { ...scenario.wasm.mandate, sha256: "0".repeat(64) } } }));
    const result = await replayFile(other);
    expect(result.matches).toBe(false);
    expect(result.actions).toEqual([]);
    expect(result.problems).toEqual([`wasm mandate: the scenario ran ${"0".repeat(64)}, this checkout has ${sha256(QUICK_WASM.mandate)}`]);
  }));
});

describe("lab start-up", () => {
  // gate: LAB
  it("refuses to start when a binary it would deploy differs from its pin", () => {
    for (const rel of [QUICK_WASM.mandate, QUICK_WASM.mpc]) {
      const copy = mkdtempSync(join(tmpdir(), "bm-lab-pin-"));
      try {
        cpSync(join(REPO_ROOT, "fixtures"), join(copy, "fixtures"), { recursive: true });
        const path = join(copy, "fixtures", rel);
        const bytes = readFileSync(path);
        bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0x01;
        writeFileSync(path, bytes);
        expect(() => Lab.start({ config: DEFAULT_CONFIG, root: copy })).toThrow(new RegExp(`prebuilt pin check failed:[\\s\\S]*fixtures/${rel.replaceAll(".", "\\.")}: sha256`));
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    }
  });

  // gate: LAB
  it("takes its bind address, port and limits from the environment, and is local by default", () => {
    expect(DEFAULT_CONFIG).toMatchObject({ host: "127.0.0.1", port: 8791, allowedOrigin: null, publicOrigin: null, trustProxy: false });
    expect(configFromEnv({ LAB_HOST: "0.0.0.0", LAB_PORT: "9000", LAB_ALLOWED_ORIGIN: "https://evidence.example", LAB_PUBLIC_ORIGIN: "https://lab.example", LAB_TRUST_PROXY: "1", LAB_MAX_SESSIONS: "3", LAB_MAX_SESSIONS_PER_CLIENT: "1", LAB_SESSION_IDLE_SEC: "120", LAB_REQUESTS_PER_MINUTE: "30" })).toMatchObject({
      host: "0.0.0.0",
      port: 9000,
      allowedOrigin: "https://evidence.example",
      publicOrigin: "https://lab.example",
      trustProxy: true,
      maxSessions: 3,
      maxSessionsPerClient: 1,
      sessionIdleSec: 120,
      requestsPerMinute: 30,
    });
    for (const bad of [{ LAB_PORT: "http" }, { LAB_MAX_SESSIONS: "0" }, { LAB_MAX_SESSIONS: "2.5" }, { LAB_ALLOWED_ORIGIN: "*" }, { LAB_ALLOWED_ORIGIN: "https://evidence.example/path" }, { LAB_TRUST_PROXY: "yes" }]) {
      expect(() => configFromEnv(bad), JSON.stringify(bad)).toThrow(/lab configuration/);
    }
  });
});
