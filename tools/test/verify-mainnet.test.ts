// verify.mjs --mainnet against a local RPC stub serving a SYNTHETIC chain. No real network is touched.
import { rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FINAL_BLOCK, GRANT_KEY, SYNTHETIC_BUNDLE, runVerify, startChain, stopChain, syntheticLiveEvidence, syntheticRepo, tempDir, type ChainOptions } from "./fixtures/verify/synthetic.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const lineOf = (out: string, gate: string): string => out.split("\n").find((l) => l.slice(13).startsWith(`${gate}  `)) ?? `(no line for ${gate})`;
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

async function chain(o: ChainOptions = {}): Promise<{ url: string; requests: string[] }> {
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
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^PASS .*6 of 6 assertions passed/);
    expect(lineOf(r.out, "mainnet.chain")).toMatch(/^PASS /);
    expect(lines(r.out, "PASS         mainnet.tx ")).toHaveLength(6);
    expect(lineOf(r.out, `mainnet.grant-key ${GRANT_KEY}`)).toMatch(/^PASS .*at block 130, removed by block 162, absent now/);
    expect(lineOf(r.out, "mainnet.relay relay_withheld")).toMatch(/^PASS /);
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
    const revoke = receiptsOf(ev).find((x) => x.label === "revoke");
    if (revoke === undefined) throw new Error("no revoke receipt");
    revoke.detail.receiver_id = "attacker.near";
    const relay = receiptsOf(ev).find((x) => x.label === "relay_withheld");
    if (relay === undefined) throw new Error("no relay receipt");
    relay.outcome = "success";
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.tx revoke")).toMatch(/^FAIL /);
    expect(r.out).toContain("receiver mandate.synthetic.near != recorded attacker.near");
    expect(lineOf(r.out, "mainnet.tx relay_withheld")).toMatch(/^FAIL /);
    expect(r.out).toContain("chain outcome failure != recorded success");
    expect(r.code).toBe(1);
  });

  it("fails on an altered receipt that was not re-hashed, before any network read", async () => {
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
    expect(lineOf(r.out, "mainnet.tx grant")).toMatch(/^FAIL .*/);
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
    const revoke = receiptsOf(ev).find((x) => x.label === "revoke");
    if (revoke === undefined) throw new Error("no revoke receipt");
    const dir = await repo(ev);
    const { url } = await chain({ missing: [revoke.tx_hash] });
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.tx revoke")).toMatch(/^NOT VERIFIED /);
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
    ev.receipts = receiptsOf(ev).filter((x) => ["grant", "propose_order", "revoke"].includes(x.label));
    ev.assertions = (ev.assertions as { id: string }[]).filter((a) => ["preflight-network", "step-1-grant", "step-3-revoke"].includes(a.id));
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
    ev.receipts = receiptsOf(ev).filter((x) => x.label !== "relay_withheld");
    ev.assertions = (ev.assertions as { id: string }[]).filter((a) => a.id !== "step-4-relay_withheld");
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet.relay")).toMatch(/^NOT VERIFIED /);
    expect(r.code).toBe(1);
  });

  it("fails when a step assertion records passed false, naming it", async () => {
    const ev = syntheticLiveEvidence();
    const step = (ev.assertions as { id: string; passed: boolean }[]).find((a) => a.id === "step-5-recover");
    if (step === undefined) throw new Error("no step-5-recover assertion");
    step.passed = false;
    const dir = await repo(ev);
    const { url } = await chain();
    const r = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(r.out, "mainnet.run")).toMatch(/^FAIL /);
    expect(r.out).toContain("assertion step-5-recover passed false");
    expect(r.code).toBe(1);
  });

  it("judges a retried step by its latest attempt", async () => {
    const ev = syntheticLiveEvidence();
    const assertions = ev.assertions as { id: string; passed: boolean }[];
    const i = assertions.findIndex((a) => a.id === "step-5-recover");
    const step = assertions[i];
    if (step === undefined) throw new Error("no step-5-recover assertion");
    assertions.splice(i, 1, { ...step, passed: false }, { ...step, id: "step-5-recover-attempt-2" });
    const dir = await repo(ev);
    const { url } = await chain();
    const passed = await runVerify(["--root", dir, "--mainnet", "--rpc", url]);
    expect(lineOf(passed.out, "mainnet.run")).toMatch(/^PASS /);
    expect(passed.code).toBe(0);

    assertions.splice(i, 2, { ...step }, { ...step, id: "step-5-recover-attempt-2", passed: false });
    const failedDir = await repo(ev);
    const failed = await runVerify(["--root", failedDir, "--mainnet", "--rpc", url]);
    expect(lineOf(failed.out, "mainnet.run")).toMatch(/^FAIL /);
    expect(failed.out).toContain("assertion step-5-recover-attempt-2 passed false");
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
});
