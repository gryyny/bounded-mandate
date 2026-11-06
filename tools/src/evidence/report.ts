// Envelope v2 writer for vitest gate cases, plus a recorder that derives `passed` from the
// case's own checks: every expected check must have run and passed, so filtered or skipped
// checks can never produce a passing report.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { sha256File } from "../checks/integrity.js";
import { REPORT_SCHEMA, type GateReportV2 } from "./schema.js";

export const REPO_ROOT = resolve(import.meta.dirname, "../../..");

export const git = (root: string, args: string[]): string | null => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/** The command with machine-local paths removed: an absolute argument inside the repository is shown relative to it, any other by its file name. */
export const portableCommand = (argv: readonly string[], root: string): string =>
  argv
    .map((a) => {
      if (!isAbsolute(a)) return a;
      const rel = relative(resolve(root), a);
      return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel : basename(a);
    })
    .join(" ");

export function treeState(root: string): { revision: string | null; dirty: boolean } {
  const revision = git(root, ["rev-parse", "HEAD"]);
  const status = git(root, ["status", "--porcelain"]);
  return { revision, dirty: status === null || status !== "" };
}

export const reportsDir = (root: string): string => join(root, "out/evidence/tests");

/** WASMs a test loaded from target/near, keyed by file stem; fixtures are covered by the manifest hash. */
export function wasmHashes(loaded: readonly { path: string; sha256: string }[]): Record<string, string> {
  return Object.fromEntries(
    loaded.filter((w) => w.path.replaceAll("\\", "/").startsWith("target/near/")).map((w) => [basename(w.path, ".wasm"), w.sha256]),
  );
}

export interface ReportInput {
  gate: string;
  case: string;
  passed: boolean;
  mode: GateReportV2["mode"];
  wasm: Record<string, string>;
  data: unknown;
  root?: string;
}

/** Writes `<gate>.<case>.json`; a second write in one run goes to a distinct file so acceptance sees the duplicate. */
export function writeGateReport(input: ReportInput): string {
  const root = input.root ?? REPO_ROOT;
  const { revision, dirty } = treeState(root);
  const report: GateReportV2 = {
    schema: REPORT_SCHEMA,
    gate: input.gate,
    case: input.case,
    passed: input.passed,
    mode: input.mode,
    run_id: process.env.MANDATE_RUN_ID ?? null,
    source: { revision: revision ?? "unknown", dirty },
    spec_sha256: sha256File(join(root, "SPEC.md")),
    fixture_manifest_sha256: sha256File(join(root, "fixtures/manifest.json")),
    wasm_sha256: input.wasm,
    command: portableCommand(process.argv, root),
    generated_at_unix: Math.floor(Date.now() / 1000),
    data: input.data,
  };
  const dir = reportsDir(root);
  mkdirSync(dir, { recursive: true });
  let path = join(dir, `${input.gate}.${input.case}.json`);
  for (let n = 2; existsSync(path); n += 1) path = join(dir, `${input.gate}.${input.case}.duplicate-${String(n)}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  return path;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  error: string | null;
}

export class CaseRecorder {
  readonly results: CheckResult[] = [];

  constructor(
    readonly gate: string,
    readonly name: string,
    readonly expectedChecks: readonly string[],
  ) {}

  /** Runs one check, records its outcome and rethrows so the test runner still fails. */
  async check(name: string, fn: () => unknown): Promise<void> {
    if (!this.expectedChecks.includes(name)) throw new Error(`unexpected check ${name} for ${this.gate}.${this.name}`);
    try {
      await fn();
      this.results.push({ name, passed: true, error: null });
    } catch (error) {
      this.results.push({ name, passed: false, error: error instanceof Error ? error.message.slice(0, 2000) : String(error) });
      throw error;
    }
  }

  passed(): boolean {
    return this.expectedChecks.every((name) => {
      const runs = this.results.filter((r) => r.name === name);
      return runs.length > 0 && runs.every((r) => r.passed);
    });
  }

  write(mode: GateReportV2["mode"], wasm: Record<string, string>, data: Record<string, unknown> = {}, root?: string): string {
    const missing = this.expectedChecks.filter((name) => !this.results.some((r) => r.name === name));
    return writeGateReport({
      gate: this.gate,
      case: this.name,
      passed: this.passed(),
      mode,
      wasm,
      data: { checks: this.results, missing_checks: missing, ...data },
      ...(root === undefined ? {} : { root }),
    });
  }
}
