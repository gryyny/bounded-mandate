// gate: EXAMPLE — the integration example (SPEC.md "Integration example"): the independent strategy client in
// examples/strategy-client, started by the harness as a separate process against a local sandbox with test doubles,
// reaches its three observations (an accepted proposal, a refusal and the revocation), and each matches the chain as
// the harness reads it. Needs the client's dependencies installed (`npm ci` in examples/strategy-client).
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CaseRecorder, REPO_ROOT } from "../src/evidence/report.js";
import { CLIENT_DIR, CLIENT_ENTRY, EXAMPLE_OUT, OBSERVATIONS, refusalProblems, runExample, txProblems, type ExampleCheck, type ExampleResult, type Observation, type ProposeTx } from "../src/example/main.js";

// Kept apart from `make example`'s own output.
const OUT = `${EXAMPLE_OUT}-test`;
// EXAMPLE.strategy-client passes only if every check below ran and passed (src/evidence/report.ts).
const evidence = new CaseRecorder("EXAMPLE", "strategy-client", ["independent-client", ...OBSERVATIONS, "sandbox-labelled", "mismatches-detected"]);

let result: ExampleResult;

const json = (rel: string): unknown => JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
type Lock = { packages: Record<string, { version?: string; integrity?: string }> };

const observed = (id: Observation): ExampleCheck => {
  const found = result.checks.filter((c) => c.id === id);
  expect(found, `${id} checked once`).toHaveLength(1);
  const [check] = found;
  if (check === undefined) throw new Error("unreachable");
  // The harness's comparison of the client's line with the chain found nothing to report.
  expect(check.problems, id).toEqual([]);
  expect(check.passed, id).toBe(true);
  expect(check.client?.observation, id).toBe(id);
  return check;
};

/** The contract's reason as the client reported it with a refusal. */
const reasonOf = (check: ExampleCheck): string => {
  const line = check.client;
  if (line === null || line.observation === "accepted") throw new Error(`${check.id} carries no reason`);
  return line.reason;
};

beforeAll(async () => {
  result = await runExample({ outRoot: OUT, command: "vitest run test/example.test.ts" });
}, 300_000);

afterAll(() => {
  // result is undefined when the run failed; the report then records the missing checks as not passed.
  // Only the fixture stems that no target/near build shares: the prebuilt doubles are covered by the manifest hash.
  const wasm = typeof result === "undefined" ? {} : Object.fromEntries([result.wasm.mandate, result.wasm.verifier].flatMap((w) => (w === undefined ? [] : [[basename(w.path, ".wasm"), w.sha256]])));
  evidence.write("sandbox", wasm, { result: typeof result === "undefined" ? null : result });
});

describe("integration example: the independent strategy client", () => {
  // gate: EXAMPLE
  it("is a separate package that imports only near-api-js, pinned as the tools package resolves it", () => evidence.check("independent-client", () => {
    const source = readFileSync(join(REPO_ROOT, CLIENT_ENTRY), "utf8");
    const imports = [...source.matchAll(/^import\s[^"']*["']([^"']+)["'];?\s*$/gm)].map((m) => m[1] ?? "");
    expect(imports).toContain("near-api-js");
    for (const spec of imports) expect(spec === "near-api-js" || spec.startsWith("node:"), spec).toBe(true);
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    expect(source.split("\n").length).toBeLessThan(200);

    const pkg = json(`${CLIENT_DIR}/package.json`) as { private?: boolean; type?: string; dependencies?: Record<string, string>; devDependencies?: unknown };
    const tools = json("tools/package.json") as { dependencies: Record<string, string> };
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies).toEqual({ "near-api-js": tools.dependencies["near-api-js"] });
    expect(pkg.devDependencies).toBeUndefined();

    // Every package the client's lockfile resolves is one the tools lockfile resolves, byte for byte, so the
    // release license check over tools/package-lock.json covers the example too.
    const byName = new Map(Object.entries((json("tools/package-lock.json") as Lock).packages).map(([path, p]) => [`${path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)}@${p.version ?? "?"}`, p.integrity]));
    const own = Object.entries((json(`${CLIENT_DIR}/package-lock.json`) as Lock).packages).filter(([path]) => path !== "");
    expect(own.length).toBeGreaterThan(0);
    for (const [path, p] of own) {
      const key = `${path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length)}@${p.version ?? "?"}`;
      expect(byName.has(key), `${key} is not in tools/package-lock.json`).toBe(true);
      expect(p.integrity, key).toBe(byName.get(key));
    }
    expect(result.client.near_api_js).toBe(tools.dependencies["near-api-js"]);
  }));

  // gate: EXAMPLE
  it("proposes an allowed trade and observes it accepted: signed by the mandate and filled on the pinned verifier", () => evidence.check("accepted", () => {
    const check = observed("accepted");
    expect(check.chain).toMatchObject({
      tx: { success: true, signer_id: result.accounts.agent, receiver_id: result.accounts.mandate },
      fill: { order: { state: { state: "signed" } }, fill_state: "filled", settle_success: true, final_state: { state: "released", reason: "settled" } },
    });
  }));

  // gate: EXAMPLE
  it("proposes a trade outside the limits and observes the contract's refusal with its reason", () => evidence.check("refused", () => {
    const check = observed("refused");
    const accepted = observed("accepted").client;
    const { tx, orders } = check.chain as { tx: ProposeTx; orders: string[] };
    expect(tx.success).toBe(false);
    expect(tx.signer_id).toBe(result.accounts.agent);
    expect(tx.mandate_error).toContain(reasonOf(check));
    // The refused proposal left no order: the mandate still holds only the accepted one.
    expect(orders).toEqual([accepted?.observation === "accepted" ? accepted.order_id : null]);
  }));

  // gate: EXAMPLE
  it("observes revocation: the grant shows revoked and a further proposal is refused", () => evidence.check("revoked", () => {
    const check = observed("revoked");
    expect(check.client).toMatchObject({ grant_status: "revoked" });
    expect(check.chain).toMatchObject({ revoke: { success: true }, grant_status: "revoked", grant_key_registered: false, tx: { success: false, signer_id: result.accounts.agent } });
    const { tx, revoke } = check.chain as { tx: ProposeTx; revoke: { block_height: number } };
    expect(tx.block_height).toBeGreaterThan(revoke.block_height);
    expect(tx.mandate_error).toContain(reasonOf(check));
  }));

  // gate: EXAMPLE
  it("finishes cleanly, labelled as sandbox with test doubles, and leaves no key file", () => evidence.check("sandbox-labelled", () => {
    expect(result.problems).toEqual([]);
    expect(result.passed).toBe(true);
    expect(result.client.exit_code).toBe(0);
    expect(result.client.lines).toHaveLength(OBSERVATIONS.length);
    expect(result.mode).toBe("sandbox");
    expect(result.label).toMatch(/SANDBOX WITH TEST DOUBLES/);
    expect(result.statement).toMatch(/test doubles for the MPC signer, the oracle and both tokens/);
    expect(result.statement).toMatch(/not a mainnet result/);
    expect(Object.values(result.wasm).every((w) => w.path.startsWith("fixtures/"))).toBe(true);
    const written = json(`${OUT}/result.json`) as ExampleResult;
    expect(written.checks.map((c) => [c.id, c.passed])).toEqual(OBSERVATIONS.map((id) => [id, true]));
    expect(existsSync(join(REPO_ROOT, OUT, "agent-key.json"))).toBe(false);
    expect(JSON.stringify(written)).not.toMatch(/private_key/);
  }));

  // gate: EXAMPLE
  it("the harness's comparison reports a client whose lines do not match the chain", () => evidence.check("mismatches-detected", () => {
    // The transactions the run's own client named, as the harness read them; only the claims about them are altered.
    const accepted = (observed("accepted").chain as { tx: ProposeTx }).tx;
    const refused = (observed("refused").chain as { tx: ProposeTx }).tx;
    const who = { agent: accepted.signer_id, agentKey: accepted.public_key ?? "", mandate: accepted.receiver_id };
    if (accepted.proposal === null || refused.proposal === null) throw new Error("the run recorded no proposals");
    const line = { tx_hash: accepted.tx_hash, proposal: accepted.proposal };
    expect(txProblems(who, accepted, line)).toEqual([]);
    expect(txProblems(who, null, line)).toEqual([`transaction ${accepted.tx_hash} is unknown to the node`]);
    expect(txProblems(who, accepted, { ...line, proposal: refused.proposal })[0]).toMatch(/is not the reported/);
    expect(txProblems({ ...who, agent: result.accounts.owner }, accepted, line)[0]).toMatch(/not the agent/);
    expect(txProblems({ ...who, agentKey: "ed25519:other" }, accepted, line)).toEqual(["not signed with the agent's function-call key"]);
    expect(txProblems({ ...who, mandate: result.accounts.verifier }, accepted, line)[0]).toMatch(/not the mandate/);
    expect(txProblems(who, { ...accepted, proposal: null }, line)).toEqual(["not a single propose_order call with a proposal"]);

    const reason = reasonOf(observed("refused"));
    expect(refusalProblems(refused, reason)).toEqual([]);
    expect(refusalProblems(refused, "a reason the contract never gave")[0]).toMatch(/is not in the mandate's failure/);
    expect(refusalProblems(accepted, reason)).toEqual(["the transaction succeeded on chain; nothing was refused"]);
    expect(refusalProblems({ ...refused, mandate_error: null }, reason)[0]).toMatch(/not the contract's/);
  }));
});
