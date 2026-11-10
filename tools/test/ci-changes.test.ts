// gate: RELEASE — the CI rule that skips the heavy gates for an evidence-only push, run as GitHub runs it
// (bash -eo pipefail) on real git histories. No network.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const WORKFLOW = readFileSync(join(import.meta.dirname, "../../.github/workflows/ci.yml"), "utf8");

/** The `run` script of the changes job's diff step, as written in the workflow. */
function diffScript(): string {
  const lines = WORKFLOW.split("\n");
  const start = lines.findIndex((l, i) => l.trim() === "run: |" && lines.slice(0, i).some((x) => x.trim() === "- id: diff"));
  const body: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.trim() !== "" && !l.startsWith("          ")) break;
    body.push(l.slice(10));
  }
  return body.join("\n");
}

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A repository with one base commit and one commit adding `paths`; returns evidence_only as the script writes it. */
function evidenceOnly(paths: string[], event = "push"): string {
  const dir = mkdtempSync(join(tmpdir(), "bm-ci-changes-"));
  dirs.push(dir);
  const git = (...args: string[]): string => execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q");
  writeFileSync(join(dir, "base"), "base\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const before = git("rev-parse", "HEAD");
  for (const p of paths) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), `${p}\n`);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "change");
  const output = join(dir, ".git", "github-output");
  writeFileSync(output, "");
  execFileSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", diffScript()], { cwd: dir, env: { PATH: process.env.PATH ?? "", EVENT: event, BEFORE: before, AFTER: git("rev-parse", "HEAD"), GITHUB_OUTPUT: output }, stdio: ["ignore", "ignore", "pipe"] });
  return readFileSync(output, "utf8").trim();
}

const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `docs/long-name-for-ci-path-check-${String(i).padStart(5, "0")}.md`);

describe("ci.yml: evidence-only pushes", () => {
  // gate: RELEASE
  it("the script under test is the workflow's own", () => {
    expect(diffScript()).toContain('echo "evidence_only=$only"');
    expect(diffScript()).not.toMatch(/\|\s*grep/);
  });

  // gate: RELEASE
  // The reviewer's counterexample: a list long enough that a grep -q on a pipe ends before the writer does.
  it("a source change is never evidence-only, however long the list of other changed files", () => {
    expect(evidenceOnly(["contract/src/lib.rs", ...many(4000), "evidence/review/SHA256SUMS"])).toBe("evidence_only=false");
    expect(evidenceOnly([...many(4000), "evidence/review/SHA256SUMS", "verify.mjs"])).toBe("evidence_only=false");
    expect(evidenceOnly(["contract/src/lib.rs", "evidence/review/SHA256SUMS"])).toBe("evidence_only=false");
  });

  // gate: RELEASE
  it("control: evidence with docs and the README is evidence-only, short or long; docs alone are not", () => {
    expect(evidenceOnly(["evidence/review/SHA256SUMS", "docs/a.md", "README.md"])).toBe("evidence_only=true");
    expect(evidenceOnly([...many(4000), "evidence/review/SHA256SUMS"])).toBe("evidence_only=true");
    expect(evidenceOnly(["docs/a.md"])).toBe("evidence_only=false");
  });

  // gate: RELEASE
  it("anything but a push runs every gate", () => {
    expect(evidenceOnly(["evidence/review/SHA256SUMS"], "pull_request")).toBe("evidence_only=false");
  });
});
