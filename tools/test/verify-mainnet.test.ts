// verify.mjs --mainnet against a local RPC stub serving a SYNTHETIC chain. No real network is touched.
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CANDIDATE_CODE_HASH, FINAL_BLOCK, GRANT_KEY, STRANGER_KEY, SYNTHETIC_BUNDLE, runVerify, startChain, stopChain, syntheticLiveEvidence, syntheticRepo, tempDir, type ChainOptions } from "./fixtures/verify/synthetic.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const lineOf = (out: string, gate: string): string => out.split("\n").find((l) => l.slice(13).startsWith(`${gate}  `)) ?? `(no line for ${gate})`;
const tradeLine = (out: string): string => out.split("\n").find((l) => l.slice(13).startsWith("mainnet.trade ")) ?? "(no mainnet.trade line)";
const lines = (out: string, status: string): string[] => out.split("\n").filter((l) => l.startsWith(status));

/** A synthetic repository whose bundle carries `evidence` as live-mainnet.json, re-hashed into SHA256SUMS. */
async function repo(evidence: Record<string, unknown> | null = syntheticLiveEvidence()): Promise<string> {
  const dir = tempDir("bm-verify-mainnet-");
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  syntheticRepo(dir);
  if (evidence !== null) writeFileSync(join(dir, SYNTHETIC_BUNDLE, "live-mainnet.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  expect((await runVerify(["--root", dir, "--write-manifest", SYNTHETIC_BUNDLE])).code).toBe(0);
  return dir;
}

async function chain(o: ChainOptions = {}): Promise<{ url: string; requests: string[]; codeReads: (number | "final")[] }> {
  const c = await startChain(o);
  cleanups.push(() => stopChain(c.server));
  return c;
}

const receiptsOf = (ev: Record<string, unknown>) => ev.receipts as { label: string; tx_hash: string; outcome: string; block_height: number; detail: Record<string, unknown> }[];

describe("verify.mjs --mainnet (SYNTHETIC chain and receipts)", () => {
  it("verifies every recorded transaction, the key lifecycle and the end balances", async () => {
    const dir = await repo();
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lines(r.out, "FAIL")).toEqual([]);
    expect(lines(r.out, "NOT VERIFIED ")).toEqual([]);
    const recorded = String((syntheticLiveEvidence().assertions as unknown[]).length);
    expect(lineOf(r.out, "mainnet.run")).toMatch(new RegExp(`^PASS .* ${recorded} of ${recorded} assertions passed`));
    expect(lineOf(r.out, "mainnet.chain")).toMatch(/^PASS /);
    expect(lines(r.out, "PASS         mainnet.tx ")).toHaveLength(receiptsOf(syntheticLiveEvidence()).length);
    for (const gate of ["mainnet.pinned", "mainnet.source", "mainnet.candidate", "mainnet.code", "mainnet.manifest", "mainnet.outcomes", "mainnet.complete", "mainnet.recovered"]) expect(lineOf(r.out, gate)).toMatch(/^PASS /);
    expect(r.out).toMatch(new RegExp(`^VERIFIED: .* Mainnet transactions and state were read from ${url} \\(not this script's default RPC; the result is only as good as that endpoint\\)\\.$`, "m"));
    expect(lineOf(r.out, `mainnet.grant-key ${GRANT_KEY}`)).toMatch(/^PASS .*at block 130, removed by intents\.near\.remove_public_key in the successful revoke .*gone by block 162, absent now/);
    expect(lineOf(r.out, "mainnet.relay step 5 relay_withheld")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.balances")).toMatch(new RegExp(`^PASS .*at block ${String(FINAL_BLOCK)}`));
    expect(r.code).toBe(0);
  });

  it("reads end state at the run's final block, so a later open challenge grant and deposit are not failures", async () => {
    // The synthetic chain registers a second key and deposits 1 USDC at block 200, after the run ended at block 162.
    const dir = await repo();
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.final-block")).toContain(String(FINAL_BLOCK));
    expect(r.code).toBe(0);
  });

  it("the RPC URL can come from MANDATE_VERIFY_RPC", async () => {
    const dir = await repo();
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet"], { MANDATE_VERIFY_RPC: url });
    expect(r.out).toContain(`querying ${url}`);
    expect(r.code).toBe(0);
  });

  it("fails on an altered receipt (re-hashed into SHA256SUMS, so only the chain can catch it)", async () => {
    const ev = syntheticLiveEvidence();
    const revoke = receiptsOf(ev).find((x) => x.label === "step 4 revoke");
    if (revoke === undefined) throw new Error("no revoke receipt");
    revoke.detail.receiver_id = "attacker.near";
    const relay = receiptsOf(ev).find((x) => x.label === "step 5 relay_withheld");
    if (relay === undefined) throw new Error("no relay receipt");
    relay.outcome = "success";
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.tx step 4 revoke")).toMatch(/^FAIL /);
    expect(r.out).toContain("receiver mandate.synthetic.near != recorded attacker.near");
    expect(lineOf(r.out, "mainnet.tx step 5 relay_withheld")).toMatch(/^FAIL /);
    expect(r.out).toContain("chain outcome failure != recorded success");
    expect(r.code).toBe(1);
  });

  it("fails on an altered receipt that was not re-hashed: the file check fails and the chain comparison still names the difference", async () => {
    const dir = await repo();
    const path = join(dir, SYNTHETIC_BUNDLE, "live-mainnet.json");
    const ev = syntheticLiveEvidence();
    const first = receiptsOf(ev)[0];
    if (first === undefined) throw new Error("no receipt");
    first.block_height += 1;
    writeFileSync(path, `${JSON.stringify(ev, null, 2)}\n`);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "bundle.files")).toMatch(/^FAIL /);
    expect(lineOf(r.out, "mainnet.tx step 1 grant")).toMatch(/^FAIL .*/);
    expect(r.out).toContain("included in block 100, recorded 101");
    expect(r.code).toBe(1);
  });

  it("fails on the wrong chain and reads nothing else", async () => {
    const dir = await repo();
    const { url, requests } = await chain({ chainId: "testnet" });
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.chain")).toMatch(/^FAIL /);
    expect(r.out).toContain('RPC chain id is "testnet"');
    expect(requests).toEqual(["status"]);
    expect(r.code).toBe(1);
  });

  it("fails when the evidence itself names another chain", async () => {
    const ev = syntheticLiveEvidence();
    ev.environment = { chain_id: "testnet" };
    const dir = await repo(ev);
    const { url, requests } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.evidence")).toMatch(/^FAIL /);
    expect(requests).toEqual([]);
    expect(r.code).toBe(1);
  });

  it("a network error is not verified, never a pass", async () => {
    const dir = await repo();
    const closed = createServer();
    await new Promise<void>((done) => closed.listen(0, "127.0.0.1", done));
    const address = closed.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    await new Promise<void>((done) => closed.close(() => { done(); }));
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", `http://127.0.0.1:${String(port)}`]);
    expect(lineOf(r.out, "mainnet.chain")).toMatch(/^NOT VERIFIED /);
    expect(r.out).not.toMatch(/^PASS +mainnet\.(chain|tx|grant-key|relay|balances)/m);
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
  });

  it("a timeout is not verified", async () => {
    const dir = await repo();
    const { url } = await chain({ hang: true });
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url, "--timeout-ms", "300"]);
    expect(lineOf(r.out, "mainnet.chain")).toMatch(/^NOT VERIFIED .*/);
    expect(r.out).toContain("timed out after 300 ms");
    expect(r.code).toBe(1);
  });

  it("a transaction the node does not return is not verified, and end state is not checked", async () => {
    const ev = syntheticLiveEvidence();
    const revoke = receiptsOf(ev).find((x) => x.label === "step 4 revoke");
    if (revoke === undefined) throw new Error("no revoke receipt");
    const dir = await repo(ev);
    const { url } = await chain({ missing: [revoke.tx_hash] });
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.tx step 4 revoke")).toMatch(/^NOT VERIFIED /);
    expect(lineOf(r.out, "mainnet.state")).toMatch(/^NOT VERIFIED /);
    expect(r.code).toBe(1);
  });

  it("fails when the grant key was never removed", async () => {
    const dir = await repo();
    const { url } = await chain({ keyNeverRemoved: true });
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, `mainnet.grant-key ${GRANT_KEY}`)).toMatch(/^FAIL /);
    expect(r.out).toContain("still registered at the run's final block 162");
    expect(r.code).toBe(1);
  });

  it("fails when the end balances differ from the recorded ones", async () => {
    const dir = await repo();
    const { url } = await chain({ usdcLeftInMandate: true });
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.balances")).toMatch(/^FAIL /);
    expect(r.out).toContain("mandate.synthetic.near Intents usdc: 5000000 at block 162, recorded 0");
    expect(r.code).toBe(1);
  });

  it("does not verify a run that stopped after revoke: no relay receipt, and the stop is a recorded unknown", async () => {
    const ev = syntheticLiveEvidence();
    ev.receipts = receiptsOf(ev).filter((x) => ["step 1 grant", "step 2 propose", "step 3 fill", "step 4 revoke"].includes(x.label));
    ev.assertions = (ev.assertions as { id: string }[]).filter((a) => ["preflight-network", "step-1-grant", "step-2-propose", "step-3-fill", "step-4-revoke"].includes(a.id));
    ev.unknowns = ["run stopped: SYNTHETIC stop after revoke"];
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^FAIL /);
    expect(r.out).toContain("unknown: run stopped: SYNTHETIC stop after revoke");
    expect(lineOf(r.out, "mainnet.relay")).toMatch(/^NOT VERIFIED .*no withheld-order relay/);
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
  });

  it("does not verify a complete-looking run without a withheld-order relay", async () => {
    const ev = syntheticLiveEvidence();
    ev.receipts = receiptsOf(ev).filter((x) => x.label !== "step 5 relay_withheld");
    ev.assertions = (ev.assertions as { id: string }[]).filter((a) => a.id !== "step-5-relay_withheld");
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.relay")).toMatch(/^NOT VERIFIED /);
    expect(r.code).toBe(1);
  });

  it("fails when a step assertion records passed false, naming it", async () => {
    const ev = syntheticLiveEvidence();
    const step = (ev.assertions as { id: string; passed: boolean }[]).find((a) => a.id === "step-6-recover");
    if (step === undefined) throw new Error("no step-6-recover assertion");
    step.passed = false;
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^FAIL /);
    expect(r.out).toContain("assertion step-6-recover passed false");
    expect(r.code).toBe(1);
  });

  it("judges a retried step by its latest attempt", async () => {
    const ev = syntheticLiveEvidence();
    const assertions = ev.assertions as { id: string; passed: boolean }[];
    const i = assertions.findIndex((a) => a.id === "step-6-recover");
    const step = assertions[i];
    if (step === undefined) throw new Error("no step-6-recover assertion");
    assertions.splice(i, 1, { ...step, passed: false }, { ...step, id: "step-6-recover-attempt-2" });
    const dir = await repo(ev);
    const { url } = await chain();
    const passed = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(passed.out, "mainnet.run")).toMatch(/^PASS /);
    expect(passed.code).toBe(0);

    assertions.splice(i, 2, { ...step }, { ...step, id: "step-6-recover-attempt-2", passed: false });
    const failedDir = await repo(ev);
    const failed = await runVerify(["--root", failedDir, "--mainnet", "--rpc", url]);
    expect(lineOf(failed.out, "mainnet.run")).toMatch(/^FAIL /);
    expect(failed.out).toContain("assertion step-6-recover-attempt-2 passed false");
    expect(failed.code).toBe(1);
  });

  it("says plainly when the bundle has no mainnet receipts", async () => {
    const dir = await repo(null);
    const { url, requests } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet")).toMatch(/^NOT VERIFIED +mainnet {2}no mainnet receipts/);
    expect(requests).toEqual([]);
    expect(r.code).toBe(1);
  });

  const assertionsOf = (ev: Record<string, unknown>) => ev.assertions as { id: string; passed: boolean; observed: Record<string, unknown> }[];
  const anOther = "9".repeat(44);

  // Each record below is re-hashed into SHA256SUMS and, where the chain is involved, the chain agrees with the
  // evidence: only a check anchored outside the evidence can catch it.
  it.each([
    ["verifier", "fake-intents.near"],
    ["signer", "fake-signer.near"],
  ])("fails without a network read when the evidence names another %s", async (role, account) => {
    const ev = syntheticLiveEvidence();
    (ev.identifiers as Record<string, string>)[role] = account;
    const dir = await repo(ev);
    const { url, requests } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.pinned")).toMatch(/^FAIL /);
    expect(r.out).toContain(`evidence names ${role} "${account}"`);
    expect(requests).toEqual([]);
    expect(r.code).toBe(1);
  });

  it("fails when the evidence names another token contract", async () => {
    const ev = syntheticLiveEvidence();
    assertionsOf(ev).push({ id: "step-8-register_storage", passed: true, observed: { asset: "usdc", token: "usdc.fake.near", registered: true } });
    const dir = await repo(ev);
    const { url, requests } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.pinned")).toMatch(/^FAIL /);
    expect(r.out).toContain("evidence names token usdc.fake.near for usdc");
    expect(requests).toEqual([]);
    expect(r.code).toBe(1);
  });

  it.each<[string, ChainOptions, RegExp]>([
    ["at the run's final block", { mandateCode: anOther }, /code hash at block 162 is 9+/],
    ["now", { mandateCodeNow: anOther }, /code hash now is 9+/],
  ])("fails when the mandate account does not run the deployment candidate %s", async (_when, o, reason) => {
    const dir = await repo();
    const { url } = await chain(o);
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.code")).toMatch(/^FAIL /);
    expect(r.out).toMatch(reason);
    expect(r.code).toBe(1);
  });

  it("does not verify the mandate's code without the checkout's deployment candidate", async () => {
    const dir = await repo();
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url, "--no-checkout"]);
    expect(lineOf(r.out, "mainnet.code")).toMatch(/^NOT VERIFIED /);
    expect(lineOf(r.out, "mainnet.candidate")).toMatch(/^NOT VERIFIED /);
    expect(lines(r.out, "FAIL")).toEqual([]);
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
  });

  it.each<[string, (source: Record<string, unknown>, ids: Record<string, unknown>) => void, string]>([
    ["another commit", (source) => { source.product_commit = "0".repeat(40); }, "mainnet.source"],
    ["a dirty tree", (source) => { source.dirty = true; }, "mainnet.source"],
    ["another SPEC.md", (source) => { source.spec_sha256 = "0".repeat(64); }, "mainnet.source"],
    ["another contract binary", (source) => { source.contract_wasm_sha256 = anOther; }, "mainnet.candidate"],
    ["another mandate code hash", (_source, ids) => { ids.mandate_code_hash = anOther; }, "mainnet.candidate"],
  ])("fails when the run records %s than the bundle and its candidate", async (_name, edit, gate) => {
    const ev = syntheticLiveEvidence();
    edit(ev.source as Record<string, unknown>, ev.identifiers as Record<string, unknown>);
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, gate)).toMatch(/^FAIL /);
    expect(r.code).toBe(1);
    const offline = await runVerify(["--root", dir]);
    expect(lineOf(offline.out, gate)).toMatch(/^FAIL /);
    expect(offline.code).toBe(1);
  });

  it("fails when a revoke was sent to another account, even though the evidence records that receiver", async () => {
    const o = { revokeReceiver: "attacker.near" };
    const dir = await repo(syntheticLiveEvidence(o));
    const { url } = await chain(o);
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.tx step 4 revoke")).toMatch(/^FAIL /);
    expect(r.out).toContain("revoke must be called on mandate.synthetic.near, the chain shows receiver attacker.near");
    expect(r.code).toBe(1);
  });

  it("fails when a transaction is not the call its step makes", async () => {
    const ev = syntheticLiveEvidence();
    const propose = receiptsOf(ev).find((x) => x.label === "step 2 propose");
    if (propose === undefined) throw new Error("no propose receipt");
    propose.label = "step 2 settle";
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.tx step 2 settle")).toMatch(/^FAIL /);
    expect(r.out).toContain("a settle step calls settle_order, the chain shows propose_order");
    expect(r.code).toBe(1);
  });

  it("fails when the revoke's key removal did not land on intents.near", async () => {
    const o = { removalReceiver: "fake-intents.near" };
    const dir = await repo(syntheticLiveEvidence(o));
    const { url } = await chain(o);
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, `mainnet.grant-key ${GRANT_KEY}`)).toMatch(/^FAIL /);
    expect(r.out).toContain("has no receipt mandate.synthetic.near -> intents.near.remove_public_key for this key");
    expect(lineOf(r.out, "mainnet.relay step 5 relay_withheld")).toMatch(/^FAIL /);
    expect(r.code).toBe(1);
  });

  it("fails when the revoke transaction itself failed, even if the key is gone afterwards", async () => {
    const o = { revokeFails: true };
    const dir = await repo(syntheticLiveEvidence(o));
    const { url } = await chain(o);
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.tx step 4 revoke")).toMatch(/^PASS .* failure/);
    expect(lineOf(r.out, `mainnet.grant-key ${GRANT_KEY}`)).toMatch(/^FAIL /);
    expect(r.out).toMatch(/the revoke transaction \S+ did not succeed on chain \(failure\)/);
    expect(r.code).toBe(1);
  });

  it("fails when the rejected relay names a key that was never a grant key", async () => {
    const o = { rejectedKey: STRANGER_KEY };
    const dir = await repo(syntheticLiveEvidence(o));
    const { url } = await chain(o);
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, `mainnet.grant-key ${GRANT_KEY}`)).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.relay step 5 relay_withheld")).toMatch(/^FAIL /);
    expect(r.out).toContain(`the rejected key ${STRANGER_KEY} is not a grant key the chain shows registered before its revoke and absent after`);
    expect(r.code).toBe(1);
  });

  it("fails when the evidence names another revoked key than the chain rejected", async () => {
    const ev = syntheticLiveEvidence();
    const relay = assertionsOf(ev).find((a) => a.id === "step-5-relay_withheld");
    if (relay === undefined) throw new Error("no relay assertion");
    relay.observed.revoked_key = STRANGER_KEY;
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.relay step 5 relay_withheld")).toMatch(/^FAIL /);
    expect(r.code).toBe(1);
  });

  it("fails on a duplicate assertion id instead of taking the last one", async () => {
    const ev = syntheticLiveEvidence();
    const all = assertionsOf(ev);
    const i = all.findIndex((a) => a.id === "step-6-recover");
    const step = all[i];
    if (step === undefined) throw new Error("no step-6-recover assertion");
    all.splice(i, 0, { ...step, passed: false });
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^FAIL /);
    expect(r.out).toContain("assertion id step-6-recover appears 2 times");
    expect(r.code).toBe(1);
  });

  it("does not verify a --live file outside the hashed bundle, whatever the chain says", async () => {
    const dir = await repo();
    const outside = join(dir, "live-outside.json");
    writeFileSync(outside, `${JSON.stringify(syntheticLiveEvidence(), null, 2)}\n`);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url, "--live", outside]);
    expect(lineOf(r.out, "mainnet.evidence-file")).toMatch(/^NOT VERIFIED .*outside the hashed bundle/);
    expect(lines(r.out, "FAIL")).toEqual([]);
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
    const own = await runVerify(["--root", dir, "--mainnet", "--rpc", url, "--live", join(dir, SYNTHETIC_BUNDLE, "live-mainnet.json")]);
    expect(own.out).not.toContain("mainnet.evidence-file");
    expect(own.code).toBe(0);
  });
});

// Counterexamples from an independent review: each record is re-hashed into SHA256SUMS and agrees with what it claims,
// so only a rule pinned in the verifier or a read of the chain can refuse it. Every case has a passing control.
describe("verify.mjs --mainnet does not verify a failed, incomplete or differently coded run (SYNTHETIC)", () => {
  const assertionsOf = (ev: Record<string, unknown>) => ev.assertions as { id: string; passed: boolean; observed: Record<string, unknown> }[];
  const environmentOf = (ev: Record<string, unknown>) => ev.environment as Record<string, string>;
  const mainnet = async (ev: Record<string, unknown>, o: ChainOptions = {}) => {
    const dir = await repo(ev);
    const c = await chain(o);
    return { ...(await runVerify(["--root", dir, "--mainnet", "--rpc", c.url])), codeReads: c.codeReads, dir };
  };
  const anOther = "9".repeat(44);
  const NEW_GATES = ["mainnet.manifest", "mainnet.outcomes", "mainnet.complete", "mainnet.recovered", "mainnet.code"];

  // gate: LIVE
  it("control: the untouched synthetic run is VERIFIED", async () => {
    const r = await mainnet(syntheticLiveEvidence());
    for (const gate of NEW_GATES) expect(lineOf(r.out, gate)).toMatch(/^PASS /);
    expect(r.out).toMatch(/^VERIFIED: /m);
    expect(r.code).toBe(0);
  });

  // gate: LIVE
  it("control: the fill is bound to the mandate's signed order and its token movement", async () => {
    const r = await mainnet(syntheticLiveEvidence());
    expect(tradeLine(r.out)).toMatch(/^PASS .*executed the order the mandate signed with ed25519:SyntheticGrantKey.*moved by exactly the signed amounts \(nep141:\S+ -1000000, nep141:wrap\.near \+200000000000000000000000\)/);
    expect(r.code).toBe(0);
  });

  // gate: LIVE
  // The reviewer's counterexample: the pinned verifier accepts execute_intents with no signed intents and moves nothing.
  it("a successful fill with an empty bundle is not a trade, although the transaction succeeded and the record passed", async () => {
    const o = { fillBundle: "empty", fillMovesNothing: true } as const;
    const r = await mainnet(syntheticLiveEvidence(o), o);
    expect(lineOf(r.out, "mainnet.tx step 3 fill")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^PASS /);
    expect(tradeLine(r.out)).toMatch(/^FAIL /);
    expect(r.out).toContain("the execute_intents call carries no signed intents");
    expect(lineOf(r.out, "mainnet.complete")).toMatch(/^FAIL /);
    expect(r.out).toContain("no successful fill transaction that executed the mandate's proposed order");
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("a nonempty bundle of other accounts' intents is not the mandate's trade", async () => {
    const o = { fillBundle: "unrelated", fillMovesNothing: true } as const;
    const r = await mainnet(syntheticLiveEvidence(o), o);
    expect(tradeLine(r.out)).toMatch(/^FAIL /);
    expect(r.out).toContain("carries 0 signed for mandate.synthetic.near, expected exactly one");
    expect(lineOf(r.out, "mainnet.complete")).toMatch(/^FAIL /);
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("a payload naming the mandate that the mandate never logged as signed is not its proposed order", async () => {
    for (const o of [{ fillBundle: "unproposed" }, { proposalNotSigned: true }] as const) {
      const r = await mainnet(syntheticLiveEvidence(o), o);
      expect(tradeLine(r.out)).toMatch(/^FAIL /);
      expect(r.out).toContain("is not an order the mandate logged as signed in a successful proposal transaction of the run");
      expect(lineOf(r.out, "mainnet.complete")).toMatch(/^FAIL /);
      expect(r.code).toBe(1);
    }
  });

  // gate: LIVE
  it("the proposed order in the bundle is not a trade when the mandate's balances and the order's nonce did not move", async () => {
    const r = await mainnet(syntheticLiveEvidence(), { fillMovesNothing: true });
    expect(tradeLine(r.out)).toMatch(/^FAIL /);
    expect(r.out).toContain("changed by 0 between blocks 120 and 122, the signed order moves -1000000");
    expect(r.out).toContain("the order's nonce is not used at block 122, after the fill");
    expect(lineOf(r.out, "mainnet.complete")).toMatch(/^FAIL /);
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("a run whose recover transactions failed is not verified, although every assertion is marked passed", async () => {
    const o = { recoverFails: true };
    const ev = syntheticLiveEvidence(o);
    expect(assertionsOf(ev).every((a) => a.passed)).toBe(true);
    const r = await mainnet(ev, o);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.outcomes")).toMatch(/^FAIL /);
    for (const rc of receiptsOf(ev).filter((x) => x.label.endsWith(" recover"))) expect(r.out).toContain(`${rc.label} (${rc.tx_hash}): a recover step must succeed on chain, it shows failure; the runner never retries a failed recover`);
    expect(lineOf(r.out, "mainnet.complete")).toMatch(/^FAIL /);
    expect(r.out).toContain("no successful recover transaction for usdc");
    expect(r.out).toContain("no successful recover transaction for wnear");
    expect(lineOf(r.out, "mainnet.recovered")).toMatch(/^FAIL /);
    expect(r.out).toContain("mandate.synthetic.near still holds 5000000 usdc on intents.near at block 162");
    // The recorded balances agree with the chain, so the comparison alone would not have caught it.
    expect(lineOf(r.out, "mainnet.balances")).toMatch(/^PASS /);
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("a run whose recover transactions failed and whose record says so fails", async () => {
    const o = { recoverFails: true };
    const ev = syntheticLiveEvidence(o);
    for (const a of assertionsOf(ev)) if (a.id.endsWith("-recover")) a.passed = false;
    const r = await mainnet(ev, o);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^FAIL /);
    expect(lineOf(r.out, "mainnet.manifest")).toMatch(/^FAIL /);
    expect(lineOf(r.out, "mainnet.outcomes")).toMatch(/^FAIL /);
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("assets left in the mandate fail even when every transaction succeeded and the record states the same balance", async () => {
    const ev = syntheticLiveEvidence();
    for (const a of assertionsOf(ev)) if (a.id.endsWith("-recover")) a.observed.mandate_after = { ...(a.observed.mandate_after as Record<string, string>), usdc: "5000000" };
    const r = await mainnet(ev, { usdcLeftInMandate: true });
    expect(lineOf(r.out, "mainnet.balances")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.outcomes")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.recovered")).toMatch(/^FAIL /);
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("reads the mandate's code at the block of each receipt it executed and the block before, once per block", async () => {
    const ev = syntheticLiveEvidence();
    // On the synthetic chain receipt i of a transaction executes i blocks after its inclusion block.
    const executed = receiptsOf(ev).flatMap((rc) => (rc.detail.receipts as { executor_id: string }[]).flatMap((x, i) => (x.executor_id === "mandate.synthetic.near" ? [rc.block_height + i] : [])));
    expect(executed.length).toBeGreaterThan(0);
    const expected = [...new Set([...executed.flatMap((h) => [h - 1, h]), FINAL_BLOCK])].sort((a, b) => a - b);
    const r = await mainnet(ev);
    expect(r.codeReads.filter((b) => b !== "final").sort((a, b) => a - b)).toEqual(expected);
    expect(r.codeReads.filter((b) => b === "final")).toHaveLength(1);
    expect(lineOf(r.out, "mainnet.code")).toMatch(new RegExp(`^PASS .*each of the ${String(executed.length)} receipts it executed .*Not excluded: a deploy and redeploy inside one block`));
    expect(r.code).toBe(0);
  });

  // gate: LIVE
  it("fails when the mandate ran other code during the run and has the candidate at the final block and now", async () => {
    // Other code through grant and revoke (blocks below 155), the candidate from then on.
    const r = await mainnet(syntheticLiveEvidence(), { mandateCodeBefore: { block: 155, code: anOther } });
    expect(lineOf(r.out, "mainnet.code")).toMatch(/^FAIL /);
    expect(r.out).toContain(`code hash at block 101 is ${anOther}, the candidate's is ${CANDIDATE_CODE_HASH}`);
    expect(r.out).toContain(`code hash at block 131 is ${anOther}`);
    expect(r.out).not.toContain(`code hash at block ${String(FINAL_BLOCK)} is`);
    expect(r.out).not.toContain("code hash now is");
    for (const gate of NEW_GATES.filter((g) => g !== "mainnet.code")) expect(lineOf(r.out, gate)).toMatch(/^PASS /);
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("fails when the mandate ran other code through the run's final block and has the candidate only now", async () => {
    const r = await mainnet(syntheticLiveEvidence(), { mandateCodeBefore: { block: FINAL_BLOCK + 1, code: anOther } });
    expect(lineOf(r.out, "mainnet.code")).toMatch(/^FAIL /);
    expect(r.out).toContain(`code hash at block ${String(FINAL_BLOCK)} is ${anOther}`);
    expect(r.out).toContain(`code hash at block 101 is ${anOther}`);
    expect(r.out).not.toContain("code hash now is");
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("fails without a recover step, whether or not the manifest step list still names it", async () => {
    const without = (keepInManifest: boolean): Record<string, unknown> => {
      const ev = syntheticLiveEvidence();
      const kinds = environmentOf(ev).manifest_steps?.split(",") ?? [];
      expect(kinds.at(-1)).toBe("recover");
      const n = String(kinds.length);
      ev.receipts = receiptsOf(ev).filter((x) => x.label !== `step ${n} recover`);
      ev.assertions = assertionsOf(ev).filter((a) => a.id !== `step-${n}-recover`);
      expect(receiptsOf(ev)).toHaveLength(kinds.length - 1);
      if (!keepInManifest) environmentOf(ev).manifest_steps = kinds.slice(0, -1).join(",");
      return ev;
    };
    // A shortened manifest list makes the record self-consistent: only the pinned completeness rule and the chain refuse it.
    const shortened = await mainnet(without(false));
    expect(lineOf(shortened.out, "mainnet.run")).toMatch(/^PASS /);
    expect(lineOf(shortened.out, "mainnet.manifest")).toMatch(/^PASS /);
    expect(lineOf(shortened.out, "mainnet.complete")).toMatch(/^FAIL /);
    expect(shortened.out).toContain("no successful recover transaction for wnear");
    expect(shortened.out).not.toContain("no successful recover transaction for usdc");
    expect(lineOf(shortened.out, "mainnet.recovered")).toMatch(/^FAIL /);
    expect(shortened.code).toBe(1);

    const listed = await mainnet(without(true));
    expect(lineOf(listed.out, "mainnet.manifest")).toMatch(/^FAIL /);
    expect(listed.out).toContain("step 7 recover: the record has no assertion for this manifest step");
    expect(listed.out).toContain("step 7 recover: 1 of 1 without a transaction among the receipts");
    expect(listed.code).toBe(1);
  });

  // gate: LIVE
  it("fails when a passed transaction step has no transaction among the receipts", async () => {
    const ev = syntheticLiveEvidence();
    ev.receipts = receiptsOf(ev).filter((x) => x.label !== "step 3 fill");
    const r = await mainnet(ev);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.manifest")).toMatch(/^FAIL /);
    expect(r.out).toContain("step 3 fill: 1 of 1 without a transaction among the receipts");
    expect(lineOf(r.out, "mainnet.complete")).toMatch(/^FAIL /);
    expect(r.out).toContain("no successful fill transaction");
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("fails without environment.manifest_steps, on chain and offline", async () => {
    const ev = syntheticLiveEvidence();
    const { manifest_steps: dropped, ...rest } = environmentOf(ev);
    expect(dropped).toBe("grant,propose,fill,revoke,relay_withheld,recover,recover");
    ev.environment = rest;
    const r = await mainnet(ev);
    expect(lineOf(r.out, "mainnet.manifest")).toMatch(/^FAIL /);
    expect(r.out).toContain("environment.manifest_steps is missing");
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
    const offline = await runVerify(["--root", r.dir]);
    expect(lineOf(offline.out, "mainnet.manifest")).toMatch(/^FAIL /);
    expect(lineOf(offline.out, "mainnet")).toMatch(/^NOT VERIFIED /);
    expect(offline.code).toBe(1);
  });

  // gate: LIVE
  it("fails when a refused_proposal succeeded on chain; the same step refused is VERIFIED", async () => {
    const accepted = { refusedProposal: "accepted" as const };
    const ev = syntheticLiveEvidence(accepted);
    const rc = receiptsOf(ev).find((x) => x.label.endsWith(" refused_proposal"));
    if (rc === undefined) throw new Error("no refused_proposal receipt");
    expect(rc.outcome).toBe("success");
    const r = await mainnet(ev, accepted);
    expect(lineOf(r.out, `mainnet.tx ${rc.label}`)).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.outcomes")).toMatch(/^FAIL /);
    expect(r.out).toContain(`${rc.label} (${rc.tx_hash}): a refused_proposal step must fail on chain, it shows success`);
    expect(r.code).toBe(1);

    const refused = { refusedProposal: "refused" as const };
    const control = await mainnet(syntheticLiveEvidence(refused), refused);
    expect(lineOf(control.out, "mainnet.outcomes")).toMatch(/^PASS .*2 refused_proposal\/relay_withheld transactions failed/);
    expect(control.out).toMatch(/^VERIFIED: /m);
    expect(control.code).toBe(0);
  });

  // gate: LIVE
  it("a withdrawal whose first attempt failed and whose retry on resume succeeded is VERIFIED", async () => {
    // The live runner retries only a withdrawal after a failed transaction (retryWithdrawals in tools/src/live/main.ts).
    const o = { withdrawRetried: true };
    const ev = syntheticLiveEvidence(o);
    const attempts = assertionsOf(ev).filter((a) => /^step-8-withdraw/.test(a.id));
    expect(attempts.map((a) => [a.id, a.passed])).toEqual([["step-8-withdraw", false], ["step-8-withdraw-attempt-2", true]]);
    const failed = receiptsOf(ev).filter((x) => x.outcome === "failure").map((x) => x.label);
    expect(failed).toEqual(["reconcile relay_withheld", "reconcile withdraw"]);
    const r = await mainnet(ev, o);
    expect(lines(r.out, "FAIL")).toEqual([]);
    expect(lines(r.out, "NOT VERIFIED ")).toEqual([]);
    expect(lineOf(r.out, "mainnet.outcomes")).toMatch(/^PASS .*1 failed withdrawal attempts superseded by a later successful attempt of the same step/);
    expect(lineOf(r.out, "mainnet.relay reconcile relay_withheld")).toMatch(/^PASS /);
    expect(r.out).toMatch(/^VERIFIED: /m);
    expect(r.code).toBe(0);
  });

  // gate: LIVE
  it("a failed withdrawal without a later successful attempt fails", async () => {
    const o = { withdrawRetried: true };
    const ev = syntheticLiveEvidence(o);
    // The retry is the run's last receipt; without it the first attempt is superseded by nothing.
    ev.receipts = receiptsOf(ev).slice(0, -1);
    const r = await mainnet(ev, o);
    expect(lineOf(r.out, "mainnet.outcomes")).toMatch(/^FAIL /);
    expect(r.out).toMatch(/a withdraw step must succeed on chain, it shows failure and no later successful attempt of the same step/);
    expect(r.code).toBe(1);
  });

  // gate: LIVE
  it("a failed recover followed by a successful one fails: the runner never retries a recover", async () => {
    const o = { recoverRetried: true };
    const ev = syntheticLiveEvidence(o);
    expect(receiptsOf(ev).filter((x) => x.label === "step 6 recover").map((x) => x.outcome)).toEqual(["failure", "success"]);
    const r = await mainnet(ev, o);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.outcomes")).toMatch(/^FAIL /);
    expect(r.out).toMatch(/a recover step must succeed on chain, it shows failure; the runner never retries a failed recover/);
    // The assets did arrive, so only the outcome rule refuses this record.
    expect(lineOf(r.out, "mainnet.complete")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.recovered")).toMatch(/^PASS /);
    expect(r.code).toBe(1);
  });
});

describe("verify.mjs offline on a bundle with a recorded mainnet run (SYNTHETIC)", () => {
  it("a complete record is skipped, and the summary says the chain was not consulted", async () => {
    const dir = await repo();
    const r = await runVerify(["--root", dir], { MANDATE_VERIFY_RPC: "http://127.0.0.1:1" });
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet")).toMatch(/^SKIP .*the chain was not consulted, so nothing on mainnet is verified here; run node verify\.mjs --mainnet/);
    expect(r.out).not.toMatch(/^\S.* mainnet\.(chain|tx|code|grant-key|relay|balances)/m);
    expect(r.out.trimEnd().split("\n").at(-1)).toMatch(/^VERIFIED: .* Mainnet: NOT CHECKED\. The bundle records a mainnet run, but the chain was not consulted; run node verify\.mjs --mainnet\.$/);
    expect(r.code).toBe(0);
  });

  it("a record with an unknown or a failed assertion is not verified", async () => {
    const stopped = syntheticLiveEvidence();
    stopped.unknowns = ["run stopped: SYNTHETIC stop after revoke"];
    const failed = syntheticLiveEvidence();
    const step = (failed.assertions as { id: string; passed: boolean }[]).find((a) => a.id === "step-5-relay_withheld");
    if (step === undefined) throw new Error("no relay assertion");
    step.passed = false;
    for (const ev of [stopped, failed]) {
      const dir = await repo(ev);
      const r = await runVerify(["--root", dir]);
      expect(lineOf(r.out, "mainnet.run")).toMatch(/^FAIL /);
      expect(lineOf(r.out, "mainnet")).toMatch(/^NOT VERIFIED .*failed, incomplete or inconsistent/);
      expect(r.out.trimEnd().split("\n").at(-1)).toMatch(/^NOT VERIFIED: .* Mainnet: NOT CHECKED\./);
      expect(r.code).toBe(1);
    }
  });

  it("a record naming another verifier fails offline too", async () => {
    const ev = syntheticLiveEvidence();
    (ev.identifiers as Record<string, string>).verifier = "fake-intents.near";
    const dir = await repo(ev);
    const r = await runVerify(["--root", dir]);
    expect(lineOf(r.out, "mainnet.pinned")).toMatch(/^FAIL /);
    expect(r.code).toBe(1);
  });
});
