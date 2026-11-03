// Source binding for evidence: revision, dirty state, spec/fixture/WASM hashes and environment.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkIntegrity, sha256File } from "../checks/integrity.js";
import type { Evidence } from "../types.js";

const git = (root: string, args: string[]): string | null => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

export interface SourceBinding {
  source: Evidence["source"];
  integrity_error: string | null;
}

export function sourceBinding(root: string, contractWasmSha256: string): SourceBinding {
  const commit = git(root, ["rev-parse", "HEAD"]) ?? "unknown";
  const status = git(root, ["status", "--porcelain"]);
  let integrityError: string | null = null;
  let specSha = sha256File(join(root, "SPEC.md"));
  let specCommit = "unknown";
  let fixtures: Record<string, string> = {};
  try {
    const report = checkIntegrity(root);
    specSha = report.spec.sha256;
    specCommit = report.spec.commit;
    fixtures = report.fixtures;
  } catch (error) {
    integrityError = error instanceof Error ? error.message : String(error);
  }
  return {
    source: {
      product_commit: commit,
      dirty: status === null ? true : status !== "",
      spec_sha256: specSha,
      spec_commit: specCommit,
      contract_wasm_sha256: contractWasmSha256,
      fixtures,
    },
    integrity_error: integrityError,
  };
}

const packageVersion = (root: string, name: string): string => {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "tools/node_modules", name, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
};

export function environment(root: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    "near-api-js": packageVersion(root, "near-api-js"),
    "near-sandbox (npm)": packageVersion(root, "near-sandbox"),
    ...extra,
  };
}
