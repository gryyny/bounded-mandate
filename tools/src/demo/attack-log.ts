// Attack log entries for the demo evidence: for each executed attack, the enforcement layer of the boundary the suite
// observed, the failure text that layer produced, and the source line that produced it, located at demo time by
// searching this checkout for that text. Nothing is assumed: an attack that was not stopped, or whose text matches no
// source line, is recorded as such.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { AttackResult } from "../attacks/suite.js";
import { enforcementLayer, type AttackLogFields, type SourceRef } from "../evidence/journey.js";

/** Production contract sources; tests and the fault-injection module are not enforcement code. */
function contractFiles(root: string): string[] {
  const dir = join(root, "contract/src");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".rs") && f !== "tests.rs" && f !== "fault.rs")
    .sort((a, b) => (a === "lib.rs" ? -1 : b === "lib.rs" ? 1 : a.localeCompare(b)))
    .map((f) => `contract/src/${f}`);
}

function findLine(root: string, files: readonly string[], match: (line: string, lines: readonly string[], i: number) => boolean): SourceRef | null {
  for (const file of files) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const lines = readFileSync(path, "utf8").split("\n");
    const i = lines.findIndex((l, n) => match(l, lines, n));
    if (i >= 0) return { file, line: i + 1, excerpt: (lines[i] ?? "").trim() };
  }
  return null;
}

const panicText = (error: string): string | null => /Smart contract panicked: ([^"\\]+)/.exec(error)?.[1]?.trim() ?? null;

/** The failure text the stopping layer produced: the chain error, or the adapter's rejection reasons. */
export function attackReason(r: AttackResult): string {
  const error = typeof r.detail.error === "string" ? r.detail.error : "";
  if (error !== "") return panicText(error) ?? error;
  const verdict = r.detail.verdict;
  if (typeof verdict === "object" && verdict !== null && "errors" in verdict && Array.isArray(verdict.errors)) return verdict.errors.map(String).join("; ");
  return "";
}

/** Source line of the check that produced the observed failure, or null when none can be located. */
export function locateEnforcement(root: string, r: AttackResult): SourceRef | null {
  const reason = attackReason(r);
  const contract = contractFiles(root);
  const literal = (text: string) => findLine(root, contract, (l) => l.includes(`"${text}"`));
  switch (r.observed) {
    case "adapter-schema":
      return /^not JSON/.test(reason)
        ? findLine(root, ["tools/src/agent/decision.ts", "tools/src/agent/adapter.ts"], (l) => l.includes("not JSON:"))
        : findLine(root, ["tools/src/agent/decision.ts"], (l) => l.includes("export function validateDecision"));
    case "near-access-key":
      // The protocol enforces the key's permission; the line is where the demo creates that key.
      return findLine(root, ["tools/src/demo/world.ts"], (l) => l.includes('methods: ["propose_order"]'));
    case "contract-role": {
      const priv = /Method (\w+) is private/.exec(reason)?.[1];
      if (priv !== undefined) return findLine(root, contract, (l, lines, i) => l.trim() === "#[private]" && (lines[i + 1] ?? "").includes(`pub fn ${priv}(`));
      return literal(reason);
    }
    case "contract-schema": {
      const struct = (name: string) => (l: string, lines: readonly string[], i: number) => l.includes("deny_unknown_fields") && lines.slice(i + 1, i + 4).some((x) => x.includes(`pub struct ${name}`));
      if (/unknown field/.test(reason)) return findLine(root, contract, struct("Proposal"));
      if (/unknown variant/.test(reason)) return findLine(root, contract, (l) => l.includes("pub enum Asset"));
      if (/invalid digit|number too large/.test(reason)) return findLine(root, contract, (l) => l.includes("pub sell_amount: U128"));
      return null;
    }
    case "contract-policy":
      return reason === "" ? null : literal(reason);
    default:
      // The verifier is the pinned external WASM: its receipt is the evidence, not a line in this checkout.
      return null;
  }
}

/** The attack log fields recorded in an attack-* assertion's observed value. */
export function attackLogFields(root: string, r: AttackResult): AttackLogFields {
  const detail = r.detail;
  return {
    observed: r.observed,
    contained: r.contained,
    origin: r.origin,
    layer: enforcementLayer(r.observed).layer,
    reason: attackReason(r).slice(0, 300),
    source: locateEnforcement(root, r),
    ...(typeof detail.submitted === "boolean" ? { submitted: detail.submitted } : {}),
    ...(typeof detail.tx_hash === "string" ? { tx_hash: detail.tx_hash } : {}),
    ...(typeof detail.model_output === "string" ? { model_output: detail.model_output } : {}),
  };
}
