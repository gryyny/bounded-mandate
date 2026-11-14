// Final step of `make test`: evaluates this run's gate reports against the run record and writes
// out/evidence/acceptance.json. Exits nonzero unless every required case is present exactly once,
// passed, and matches the run's revision, spec, fixture and WASM hashes. A dirty tree is never certified.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { arch, release, type } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { REPO_ROOT, reportsDir, treeState } from "../evidence/report.js";
import { REQUIRED_CASES, SEPARATE_CASES, caseId } from "../evidence/required.js";
import {
  ACCEPTANCE_SCHEMA,
  type Acceptance,
  type CaseResult,
  GateReportV2,
  type RunRecord,
  T5Data,
  WasmRecord,
} from "../evidence/schema.js";
import { checkIntegrity, sha256File } from "./integrity.js";
import { acceptancePath, readRun, runDir } from "./run.js";

interface Found {
  file: string;
  report: GateReportV2;
}

const tryRun = (cmd: string, args: string[]): string => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 20_000 }).trim();
  } catch {
    return "unknown";
  }
};

const lockVersion = (root: string, name: string): string => {
  const path = join(root, "Cargo.lock");
  if (!existsSync(path)) return "unknown";
  const m = new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(readFileSync(path, "utf8"));
  return m?.[1] ?? "unknown";
};

const npmVersion = (root: string, name: string): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "tools/node_modules", name, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
};

export function environment(root: string): Record<string, string> {
  return {
    os: `${type()} ${release()}`,
    arch: arch(),
    node: process.version,
    rustc: tryRun("rustc", ["--version"]),
    "cargo-near": tryRun("cargo", ["near", "--version"]),
    "near-workspaces (Rust sandbox tests)": lockVersion(root, "near-workspaces"),
    "near-sandbox (Rust crate)": lockVersion(root, "near-sandbox"),
    "near-sandbox (npm)": npmVersion(root, "near-sandbox"),
  };
}

/** The recipe lines of the Makefile `test` target, as written. */
export function makeTestCommands(root: string): string[] {
  const path = join(root, "Makefile");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  // make test runs its suites through the test-rust and test-ts sub-targets; their recipes are part of the run.
  return ["test", "test-rust", "test-ts"].flatMap((target) => {
    const start = lines.findIndex((l) => l.startsWith(`${target}:`));
    if (start < 0) return [];
    const out: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (!line.startsWith("\t")) break;
      out.push(line.trim());
    }
    return out;
  });
}

function currentWasm(root: string): Record<string, string> {
  const nearDir = join(root, "target/near");
  const out: Record<string, string> = {};
  if (!existsSync(nearDir)) return out;
  for (const crate of readdirSync(nearDir)) {
    const dir = join(nearDir, crate);
    try {
      for (const f of readdirSync(dir).filter((x) => x.endsWith(".wasm"))) out[f.slice(0, -5)] = sha256File(join(dir, f));
    } catch {
      // not a directory
    }
  }
  return out;
}

/** sha256 of fixture files by file stem (e.g. the reproducible deployment candidate), from fixtures/manifest.json. */
function fixtureStems(root: string): Record<string, string> {
  const path = join(root, "fixtures/manifest.json");
  if (!existsSync(path)) return {};
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { files?: Record<string, { sha256?: unknown }> };
  return Object.fromEntries(
    Object.entries(manifest.files ?? {})
      .filter((e): e is [string, { sha256: string }] => typeof e[1].sha256 === "string")
      .map(([file, entry]) => [basename(file).replace(/\.[^.]+$/, ""), entry.sha256]),
  );
}

function mismatches(found: Found, run: RunRecord, wasm: WasmRecord | null, fixtures: Record<string, string>): string[] {
  const r = found.report;
  const out: string[] = [];
  const expectedName = `${r.gate}.${r.case}.json`;
  if (found.file !== expectedName) out.push(`file name ${found.file} is not ${expectedName}`);
  if (r.source.revision !== run.revision) out.push(`revision ${r.source.revision} != run ${String(run.revision)}`);
  if (r.source.dirty !== run.dirty) out.push(`dirty=${String(r.source.dirty)} != run dirty=${String(run.dirty)}`);
  if (r.spec_sha256 !== run.spec_sha256) out.push(`spec_sha256 ${r.spec_sha256} != run ${run.spec_sha256}`);
  if (r.fixture_manifest_sha256 !== run.fixture_manifest_sha256) {
    out.push(`fixture_manifest_sha256 ${r.fixture_manifest_sha256} != run ${run.fixture_manifest_sha256}`);
  }
  // Committed evidence must not carry machine-local paths (user, session or checkout location).
  const local = r.command.split(" ").filter((arg) => arg.startsWith("/"));
  if (local.length > 0) out.push(`command records ${String(local.length)} machine-local absolute path(s)`);
  // Sandbox execution must be bound to the binaries it ran; only unit-VM reports run without WASM.
  if (r.mode === "sandbox" && Object.keys(r.wasm_sha256).length === 0) out.push("sandbox report binds no WASM hash");
  // A stem outside the run's target/near record is checked against a fixture of that stem (covered by the manifest hash).
  for (const [stem, hash] of Object.entries(r.wasm_sha256)) {
    const recorded = wasm?.wasm_sha256[stem] ?? fixtures[stem];
    const source = wasm?.wasm_sha256[stem] !== undefined ? "recorded" : "fixture";
    if (recorded === undefined) out.push(`wasm ${stem} not recorded for this run`);
    else if (recorded !== hash) out.push(`wasm ${stem} ${hash} != ${source} ${recorded}`);
  }
  return out;
}

function evaluateCase(
  gate: string,
  name: string,
  current: readonly Found[],
  others: readonly Found[],
  run: RunRecord | null,
  wasm: WasmRecord | null,
  fixtures: Record<string, string>,
): CaseResult {
  const id = caseId(gate, name);
  const base = { id, gate, case: name, files: current.map((f) => f.file), mode: current[0]?.report.mode ?? null };
  if (run === null) return { ...base, status: "missing", reason: "no run record (out/run/run.json)" };
  if (current.length === 0) {
    return others.length > 0
      ? { ...base, files: others.map((f) => f.file), status: "stale", reason: `only reports from other runs: ${[...new Set(others.map((f) => String(f.report.run_id)))].join(", ")}` }
      : { ...base, status: "missing", reason: "no report written in this run (test absent, filtered, or panicked before writing)" };
  }
  if (current.length > 1) return { ...base, status: "duplicate", reason: `${String(current.length)} reports in this run` };
  const [only] = current;
  if (only === undefined) throw new Error("unreachable");
  const bad = mismatches(only, run, wasm, fixtures);
  if (bad.length > 0) return { ...base, status: "mismatched", reason: bad.join("; ") };
  return only.report.passed
    ? { ...base, status: "passed", reason: "present once, passed, matches the run" }
    : { ...base, status: "failed", reason: "the test's own assertions failed" };
}

export function evaluate(root: string, now = new Date()): Acceptance {
  const problems: string[] = [];
  const ignored: Acceptance["ignored"] = [];

  let run: RunRecord | null = null;
  try {
    run = readRun(root);
    if (run === null) problems.push("no run record: run `tsx src/checks/run.ts start` at the start of make test");
  } catch (error) {
    problems.push(`invalid run record: ${error instanceof Error ? error.message : String(error)}`);
  }
  let wasm: WasmRecord | null = null;
  const wasmPath = join(runDir(root), "wasm.json");
  if (existsSync(wasmPath)) {
    const parsed = WasmRecord.safeParse(JSON.parse(readFileSync(wasmPath, "utf8")));
    if (!parsed.success) problems.push("invalid out/run/wasm.json");
    else if (parsed.data.run_id !== run?.run_id) problems.push(`out/run/wasm.json belongs to run ${parsed.data.run_id}`);
    else wasm = parsed.data;
  } else {
    problems.push("no recorded WASM hashes (out/run/wasm.json): run `tsx src/checks/run.ts wasm` after building");
  }

  const tree = treeState(root);
  let fixtures: Record<string, string> = {};
  try {
    fixtures = checkIntegrity(root).fixtures;
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  const specNow = existsSync(join(root, "SPEC.md")) ? sha256File(join(root, "SPEC.md")) : null;
  const fixtureNow = existsSync(join(root, "fixtures/manifest.json")) ? sha256File(join(root, "fixtures/manifest.json")) : null;
  if (run !== null) {
    if (tree.revision !== run.revision) problems.push(`HEAD is ${String(tree.revision)} but the run started at ${String(run.revision)}`);
    if (tree.dirty !== run.dirty) problems.push(`working tree changed during the run (dirty at start: ${String(run.dirty)}, now: ${String(tree.dirty)})`);
    if (specNow !== run.spec_sha256) problems.push("SPEC.md changed during the run");
    if (fixtureNow !== run.fixture_manifest_sha256) problems.push("fixtures/manifest.json changed during the run");
  }
  if (wasm !== null) {
    const built = currentWasm(root);
    for (const [stem, hash] of Object.entries(wasm.wasm_sha256)) {
      if (built[stem] !== hash) problems.push(`target/near ${stem}.wasm changed after it was recorded`);
    }
  }

  const known = new Set([...Object.entries(REQUIRED_CASES), ...Object.entries(SEPARATE_CASES)].flatMap(([g, cs]) => cs.map((c) => caseId(g, c))));
  const current = new Map<string, Found[]>();
  const others = new Map<string, Found[]>();
  const dir = reportsDir(root);
  for (const file of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (!file.endsWith(".json")) {
      ignored.push({ file, reason: "not a JSON report" });
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      ignored.push({ file, reason: "malformed JSON" });
      continue;
    }
    const parsed = GateReportV2.safeParse(raw);
    if (!parsed.success) {
      const legacy = typeof raw === "object" && raw !== null && "gate" in raw && !("schema" in raw);
      ignored.push({ file, reason: legacy ? "legacy v1 report: not counted under v2 rules" : `not a v2 gate report (${parsed.error.issues[0]?.path.join(".") ?? "?"}: ${parsed.error.issues[0]?.message ?? "invalid"})` });
      continue;
    }
    const report = parsed.data;
    const id = caseId(report.gate, report.case);
    if (!known.has(id)) {
      ignored.push({ file, reason: `unknown case ${id}` });
      continue;
    }
    const sameRun = run !== null && report.run_id === run.run_id;
    if (!sameRun) ignored.push({ file, reason: `report from another run (run_id ${String(report.run_id)})` });
    const into = sameRun ? current : others;
    into.set(id, [...(into.get(id) ?? []), { file, report }]);
  }

  const stems = fixtureStems(root);
  const evalAll = (registry: Record<string, readonly string[]>): CaseResult[] =>
    Object.entries(registry).flatMap(([gate, names]) =>
      names.map((name) => evaluateCase(gate, name, current.get(caseId(gate, name)) ?? [], others.get(caseId(gate, name)) ?? [], run, wasm, stems)),
    );
  const cases = evalAll(REQUIRED_CASES);
  const separate = evalAll(SEPARATE_CASES);

  let baseline: Acceptance["baseline"] = null;
  const t5 = cases.find((c) => c.id === "T5.baseline");
  const t5Report = current.get("T5.baseline")?.[0]?.report;
  if (t5 !== undefined && t5Report !== undefined && (t5.status === "passed" || t5.status === "failed")) {
    const data = T5Data.safeParse(t5Report.data);
    if (data.success) baseline = data.data;
    else Object.assign(t5, { status: "mismatched", reason: "report data is not T5 baseline data" });
  }

  const complete = problems.length === 0 && cases.every((c) => c.status === "passed");
  const dirty = run?.dirty ?? tree.dirty;
  return {
    schema: ACCEPTANCE_SCHEMA,
    run_id: run?.run_id ?? null,
    revision: run?.revision ?? tree.revision,
    dirty,
    certified: complete && !dirty && !tree.dirty,
    complete,
    started_at: run?.started_at ?? null,
    evaluated_at: now.toISOString(),
    hashes: { spec_sha256: run?.spec_sha256 ?? specNow, fixture_manifest_sha256: run?.fixture_manifest_sha256 ?? fixtureNow, fixtures, wasm: wasm?.wasm_sha256 ?? {} },
    environment: environment(root),
    commands: makeTestCommands(root),
    cases,
    separate,
    problems,
    ignored,
    baseline,
  };
}

export function writeAcceptance(root: string, acceptance: Acceptance): string {
  const path = acceptancePath(root);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(acceptance, null, 2)}\n`);
  return path;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const acceptance = evaluate(REPO_ROOT);
  const path = writeAcceptance(REPO_ROOT, acceptance);
  for (const c of [...acceptance.cases, ...acceptance.separate]) console.log(`${c.status.padEnd(10)} ${c.id}  ${c.reason}`);
  for (const i of acceptance.ignored) console.log(`ignored    ${i.file}  ${i.reason}`);
  for (const p of acceptance.problems) console.error(`problem: ${p}`);
  const verdict = acceptance.certified ? "CERTIFIED" : acceptance.complete ? "COMPLETE BUT UNCERTIFIED (dirty tree)" : "INCOMPLETE";
  console.log(`${verdict}: run ${String(acceptance.run_id)} -> ${path}`);
  if (!acceptance.complete) process.exitCode = 1;
}
