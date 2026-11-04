// Schemas for gate report envelope v2, the run record and acceptance.json.
// The envelope is a shared interface (coordinator-owned): Rust writer contract/tests/common/evidence.rs,
// baseline/claw-guard-adapted/tests/t5_baseline.rs and tools/src/evidence/report.ts emit exactly this.
import { z } from "zod";
import { Assertion } from "../types.js";

export const REPORT_SCHEMA = "bounded-mandate/gate-report/2";
export const ACCEPTANCE_SCHEMA = "bounded-mandate/acceptance/1";
export const RUN_SCHEMA = "bounded-mandate/run/1";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const revision = z.string().regex(/^[0-9a-f]{40}$/);

export const GateReportV2 = z.object({
  schema: z.literal(REPORT_SCHEMA),
  gate: z.string().min(1),
  case: z.string().min(1),
  /** Computed from the test's own assertions before writing. */
  passed: z.boolean(),
  mode: z.enum(["sandbox", "unit-vm"]),
  run_id: z.string().min(1).nullable(),
  source: z.object({ revision: z.string().min(1), dirty: z.boolean() }),
  spec_sha256: sha256,
  fixture_manifest_sha256: sha256,
  wasm_sha256: z.record(z.string().min(1), sha256),
  command: z.string(),
  generated_at_unix: z.number().int().nonnegative(),
  data: z.unknown(),
});
export type GateReportV2 = z.infer<typeof GateReportV2>;

export const RunRecord = z.object({
  schema: z.literal(RUN_SCHEMA),
  run_id: z.string().min(1),
  revision: z.string().min(1).nullable(),
  dirty: z.boolean(),
  spec_sha256: sha256,
  fixture_manifest_sha256: sha256,
  started_at: z.string(),
});
export type RunRecord = z.infer<typeof RunRecord>;

export const WasmRecord = z.object({
  run_id: z.string().min(1),
  recorded_at: z.string(),
  wasm_sha256: z.record(z.string().min(1), sha256),
});
export type WasmRecord = z.infer<typeof WasmRecord>;

/**
 * Baseline outcome of one T5 threat case, classified by the test from executed chain state.
 * `unsupported_by_design` and `not_run` mean nothing was executed for that case.
 */
export const BaselineOutcome = z.enum(["attack_succeeded", "blocked", "unsupported_by_design", "executed", "failed", "not_run"]);
export type BaselineOutcome = z.infer<typeof BaselineOutcome>;

export const BaselineCase = z.object({
  id: z.string().min(1),
  threat: z.string().min(1),
  compare_gate: z.string().min(1),
  baseline_outcome: BaselineOutcome,
  summary: z.string(),
  observed: z.unknown(),
});
export type BaselineCase = z.infer<typeof BaselineCase>;

export const T5Data = z.object({
  command: z.string(),
  hashes: z.record(z.string(), z.string()),
  environment: z.record(z.string(), z.string()),
  baseline: z.object({
    name: z.string(),
    repository: z.string(),
    commit: revision,
    license: z.string(),
    adaptations: z.array(z.string()),
  }),
  assertions: z.array(Assertion),
  cases: z.array(BaselineCase),
});
export type T5Data = z.infer<typeof T5Data>;

export const CaseStatus = z.enum(["passed", "failed", "missing", "mismatched", "duplicate", "stale"]);
export type CaseStatus = z.infer<typeof CaseStatus>;

export const CaseResult = z.object({
  id: z.string(),
  gate: z.string(),
  case: z.string(),
  status: CaseStatus,
  reason: z.string(),
  files: z.array(z.string()),
  mode: z.string().nullable(),
});
export type CaseResult = z.infer<typeof CaseResult>;

export const Acceptance = z.object({
  schema: z.literal(ACCEPTANCE_SCHEMA),
  run_id: z.string().nullable(),
  revision: z.string().nullable(),
  dirty: z.boolean(),
  /** Clean tree, unchanged during the run, integrity intact, every required case passed and matched. */
  certified: z.boolean(),
  /** Every required case passed and matched this run (dirty runs can be complete but never certified). */
  complete: z.boolean(),
  started_at: z.string().nullable(),
  evaluated_at: z.string(),
  hashes: z.object({
    spec_sha256: z.string().nullable(),
    fixture_manifest_sha256: z.string().nullable(),
    fixtures: z.record(z.string(), z.string()),
    wasm: z.record(z.string(), z.string()),
  }),
  environment: z.record(z.string(), z.string()),
  commands: z.array(z.string()),
  cases: z.array(CaseResult),
  separate: z.array(CaseResult),
  /** Run-level problems (missing run record, tree changed, integrity failure). */
  problems: z.array(z.string()),
  /** Files never counted: other runs, legacy v1, malformed or unknown cases. */
  ignored: z.array(z.object({ file: z.string(), reason: z.string() })),
  /** Data of this run's T5.baseline report, when present and schema-valid. */
  baseline: T5Data.nullable(),
});
export type Acceptance = z.infer<typeof Acceptance>;
