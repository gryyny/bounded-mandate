// Acceptance evaluation against SYNTHETIC gate reports in a throwaway git repository.
// Every report here is written by the test; none is a recorded result.
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluate, makeTestCommands, writeAcceptance } from "../src/checks/acceptance.js";
import { readRun, recordWasm, startRun } from "../src/checks/run.js";
import { REQUIRED_CASES, requiredCaseIds } from "../src/evidence/required.js";
import { Acceptance, GateReportV2, REPORT_SCHEMA, type RunRecord } from "../src/evidence/schema.js";

const repo = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

/** A committed copy of the spec, fixtures and Makefile, with one fake built WASM. */
function tempRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "bm-acceptance-"));
  roots.push(root);
  for (const f of ["SPEC.md", "spec-source.json", "Makefile"]) cpSync(join(repo, f), join(root, f));
  cpSync(join(repo, "fixtures"), join(root, "fixtures"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "out/\ntarget/\n");
  mkdirSync(join(root, "target/near/bounded_mandate"), { recursive: true });
  writeFileSync(join(root, "target/near/bounded_mandate/bounded_mandate.wasm"), "SYNTHETIC wasm bytes");
  sh(root, ["init", "-q"]);
  sh(root, ["add", "-A"]);
  sh(root, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "synthetic"]);
  return root;
}

const t5Data = {
  command: "synthetic",
  hashes: {},
  environment: {},
  baseline: { name: "SYNTHETIC", repository: "https://example.invalid", commit: "f".repeat(40), license: "MIT", adaptations: [] },
  assertions: [],
  cases: [],
};

function report(run: RunRecord, wasm: Record<string, string>, id: string, over: Partial<GateReportV2> = {}): GateReportV2 {
  const [gate, name] = id.split(".") as [string, string];
  return {
    schema: REPORT_SCHEMA,
    gate,
    case: name,
    passed: true,
    mode: "sandbox",
    run_id: run.run_id,
    source: { revision: run.revision ?? "unknown", dirty: run.dirty },
    spec_sha256: run.spec_sha256,
    fixture_manifest_sha256: run.fixture_manifest_sha256,
    wasm_sha256: wasm,
    command: "synthetic",
    generated_at_unix: 0,
    data: id === "T5.baseline" ? t5Data : { synthetic: true },
    ...over,
  };
}

const put = (root: string, file: string, value: unknown): void => {
  mkdirSync(join(root, "out/evidence/tests"), { recursive: true });
  writeFileSync(join(root, "out/evidence/tests", file), JSON.stringify(value));
};

/** Starts a run, records WASM and writes every required case as passed, except those in `skip`. */
function fullRun(root: string, skip: readonly string[] = []) {
  const run = startRun(root);
  const wasm = recordWasm(root).wasm_sha256;
  for (const id of requiredCaseIds().filter((x) => !skip.includes(x))) put(root, `${id}.json`, report(run, wasm, id));
  return { run, wasm };
}

const status = (a: Acceptance, id: string) => [...a.cases, ...a.separate].find((c) => c.id === id)?.status;

describe("run protocol", () => {
  it("start records the run and clears earlier reports and verdicts", () => {
    const root = tempRepo();
    put(root, "T1.withheld-regrant.json", { stale: true });
    mkdirSync(join(root, "out/evidence"), { recursive: true });
    writeFileSync(join(root, "out/evidence/acceptance.json"), "{}");
    const run = startRun(root);
    expect(readRun(root)).toEqual(run);
    expect(run.dirty).toBe(false);
    expect(readdirSync(join(root, "out/evidence"))).toEqual([]);
  });

  it("records the make test commands from the Makefile", () => {
    expect(makeTestCommands(repo).length).toBeGreaterThan(3);
    expect(makeTestCommands(repo).join("\n")).toContain("cargo test");
  });
});

describe("acceptance", () => {
  it("certifies a clean run where every required case passed exactly once and matched", () => {
    const root = tempRepo();
    fullRun(root);
    const a = evaluate(root);
    expect(a.problems).toEqual([]);
    expect(a.cases.map((c) => c.status)).toEqual(requiredCaseIds().map(() => "passed"));
    expect({ complete: a.complete, certified: a.certified }).toEqual({ complete: true, certified: true });
    expect(a.baseline).not.toBeNull();
    expect(Acceptance.parse(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(writeAcceptance(root, a)).toBe(join(root, "out/evidence/acceptance.json"));
  });

  it("an incomplete run is not complete", () => {
    const root = tempRepo();
    fullRun(root, ["T4.open-order-limit"]);
    const a = evaluate(root);
    expect(status(a, "T4.open-order-limit")).toBe("missing");
    expect(a.complete).toBe(false);
    expect(a.certified).toBe(false);
  });

  it("a run from a dirty tree is never certified", () => {
    const root = tempRepo();
    appendFileSync(join(root, "Makefile"), "\n# local edit\n");
    const { run } = fullRun(root);
    expect(run.dirty).toBe(true);
    const a = evaluate(root);
    expect(a.complete).toBe(true);
    expect(a.certified).toBe(false);
  });

  it("a tree that changes during the run is a run problem", () => {
    const root = tempRepo();
    fullRun(root);
    appendFileSync(join(root, "Makefile"), "\n# edited mid-run\n");
    const a = evaluate(root);
    expect(a.problems.join("\n")).toMatch(/working tree changed during the run/);
    expect(a.complete).toBe(false);
  });

  const overrides: [string, (run: RunRecord) => Partial<GateReportV2>, RegExp][] = [
    ["revision", (run) => ({ source: { revision: "0".repeat(40), dirty: run.dirty } }), /revision/],
    ["dirty flag", (run) => ({ source: { revision: run.revision ?? "", dirty: true } }), /dirty=true/],
    ["spec hash", () => ({ spec_sha256: "1".repeat(64) }), /spec_sha256/],
    ["fixture hash", () => ({ fixture_manifest_sha256: "2".repeat(64) }), /fixture_manifest_sha256/],
    ["WASM hash", () => ({ wasm_sha256: { bounded_mandate: "3".repeat(64) } }), /wasm bounded_mandate/],
    ["unrecorded WASM", () => ({ wasm_sha256: { other_contract: "4".repeat(64) } }), /not recorded/],
    ["missing WASM binding", () => ({ wasm_sha256: {} }), /binds no WASM/],
  ];
  it.each(overrides)("a report with a mismatched %s does not count", (_what, over, reason) => {
    const root = tempRepo();
    const { run, wasm } = fullRun(root);
    put(root, "T2b.disclosed-relay.json", report(run, wasm, "T2b.disclosed-relay", over(run)));
    const a = evaluate(root);
    const c = a.cases.find((x) => x.id === "T2b.disclosed-relay");
    expect(c?.status).toBe("mismatched");
    expect(c?.reason).toMatch(reason);
    expect(a.complete).toBe(false);
  });

  it("a failed case fails the run", () => {
    const root = tempRepo();
    const { run, wasm } = fullRun(root);
    put(root, "T3.breaker.json", report(run, wasm, "T3.breaker", { passed: false }));
    const a = evaluate(root);
    expect(status(a, "T3.breaker")).toBe("failed");
    expect(a.complete).toBe(false);
  });

  it("a case reported twice is a duplicate", () => {
    const root = tempRepo();
    const { run, wasm } = fullRun(root);
    put(root, "T1.pending-sign.duplicate-2.json", report(run, wasm, "T1.pending-sign"));
    const a = evaluate(root);
    expect(status(a, "T1.pending-sign")).toBe("duplicate");
    expect(a.complete).toBe(false);
  });

  it("reports from another run are listed, never counted", () => {
    const root = tempRepo();
    const { run, wasm } = fullRun(root, ["T1.withheld-regrant"]);
    put(root, "T1.withheld-regrant.json", report(run, wasm, "T1.withheld-regrant", { run_id: "earlier-run" }));
    put(root, "MODEL.recorded-proposal.json", report(run, wasm, "MODEL.recorded-proposal", { run_id: null }));
    const a = evaluate(root);
    expect(status(a, "T1.withheld-regrant")).toBe("stale");
    expect(status(a, "MODEL.recorded-proposal")).toBe("stale");
    expect(a.ignored.map((i) => i.file)).toEqual(expect.arrayContaining(["T1.withheld-regrant.json", "MODEL.recorded-proposal.json"]));
    expect(a.complete).toBe(false);
  });

  it("an old v1 report is ignored as legacy and does not satisfy a case", () => {
    const root = tempRepo();
    fullRun(root, ["T5.baseline"]);
    put(root, "T5.json", { gate: "T5", part: null, passed: true, mode: "sandbox", source_revision: "x", dirty: false, data: {} });
    const a = evaluate(root);
    expect(a.ignored).toContainEqual({ file: "T5.json", reason: "legacy v1 report: not counted under v2 rules" });
    expect(status(a, "T5.baseline")).toBe("missing");
    expect(a.baseline).toBeNull();
  });

  it("unknown cases and non-report files are listed, never counted", () => {
    const root = tempRepo();
    const { run, wasm } = fullRun(root);
    put(root, "T1.extra.json", report(run, wasm, "T1.extra"));
    put(root, "notes.json", { hello: "world" });
    const a = evaluate(root);
    expect(a.ignored.map((i) => i.reason)).toEqual(expect.arrayContaining(["unknown case T1.extra"]));
    expect(a.ignored.some((i) => i.file === "notes.json")).toBe(true);
    expect(a.certified).toBe(true);
  });

  it("the owner-key rescue is reported separately and never counts toward a gate", () => {
    const root = tempRepo();
    const { run, wasm } = fullRun(root, ["T4.registration-reconcile"]);
    put(root, "RESCUE.owner-key.json", report(run, wasm, "RESCUE.owner-key"));
    const a = evaluate(root);
    expect(status(a, "RESCUE.owner-key")).toBe("passed");
    expect(a.cases.some((c) => c.gate === "RESCUE")).toBe(false);
    expect(status(a, "T4.registration-reconcile")).toBe("missing");
    expect(a.complete).toBe(false);
  });

  it("without a run record nothing counts", () => {
    const root = tempRepo();
    const a = evaluate(root);
    expect(a.problems.join("\n")).toMatch(/no run record/);
    expect(a.cases.every((c) => c.status === "missing")).toBe(true);
    expect(a.complete).toBe(false);
  });

  it("a WASM rebuilt after recording is a run problem", () => {
    const root = tempRepo();
    fullRun(root);
    writeFileSync(join(root, "target/near/bounded_mandate/bounded_mandate.wasm"), "rebuilt");
    expect(evaluate(root).problems.join("\n")).toMatch(/bounded_mandate\.wasm changed after it was recorded/);
  });

  it("a T5 report without baseline data does not count", () => {
    const root = tempRepo();
    const { run, wasm } = fullRun(root);
    put(root, "T5.baseline.json", report(run, wasm, "T5.baseline", { data: { cases: "none" } }));
    const a = evaluate(root);
    expect(status(a, "T5.baseline")).toBe("mismatched");
    expect(a.baseline).toBeNull();
  });

  it("the registry covers every required gate", () => {
    expect(Object.keys(REQUIRED_CASES)).toEqual(["T1", "T2", "T2b", "T3", "T4", "T5", "BOUNDARY", "MODEL"]);
  });
});
