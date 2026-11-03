// Schemas and loader for per-gate test reports under out/evidence/tests/*.json.
// The envelope matches contract/tests/common/evidence.rs; T5 adds a typed `data` payload.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Assertion } from "../types.js";

export const GateReport = z.object({
  gate: z.string().min(1),
  part: z.string().nullable().optional(),
  /** The assertion outcome the test computed before writing; a report is never a pass by presence. */
  passed: z.boolean(),
  mode: z.string().min(1),
  source_revision: z.string().nullable().optional(),
  dirty: z.boolean().nullable().optional(),
  test_binary: z.string().nullable().optional(),
  generated_at_unix: z.number().int().nonnegative().optional(),
  data: z.unknown(),
});
export type GateReport = z.infer<typeof GateReport>;

/**
 * Baseline outcome of one threat case, classified by the test from executed chain state.
 * `unsupported_by_design` and `not_run` mean nothing was executed for that case.
 */
export const BaselineOutcome = z.enum([
  "attack_succeeded",
  "blocked",
  "unsupported_by_design",
  "executed",
  "failed",
  "not_run",
]);
export type BaselineOutcome = z.infer<typeof BaselineOutcome>;

export const BaselineCase = z.object({
  id: z.string().min(1),
  threat: z.string().min(1),
  compare_gate: z.string().min(1),
  baseline_outcome: BaselineOutcome,
  summary: z.string(),
  observed: z.unknown(),
  /** Optional id of the mandate-side assertion for a per-case join; otherwise the gate result is used. */
  mandate_assertion: z.string().optional(),
});
export type BaselineCase = z.infer<typeof BaselineCase>;

export const T5Data = z.object({
  command: z.string(),
  hashes: z.record(z.string(), z.string()),
  environment: z.record(z.string(), z.string()),
  baseline: z.object({
    name: z.string(),
    repository: z.string(),
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    license: z.string(),
    adaptations: z.array(z.string()),
  }),
  assertions: z.array(Assertion),
  cases: z.array(BaselineCase),
});
export type T5Data = z.infer<typeof T5Data>;

/** Reads and validates every report; throws on any malformed file instead of skipping it. */
export function loadGateReports(dir: string): GateReport[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const parsed = GateReport.safeParse(JSON.parse(readFileSync(join(dir, name), "utf8")));
      if (!parsed.success) throw new Error(`invalid gate report ${name}: ${z.prettifyError(parsed.error)}`);
      return parsed.data;
    });
}
