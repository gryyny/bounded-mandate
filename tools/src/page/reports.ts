// Legacy (envelope v1) gate reports, as kept in historical bundles such as evidence/426914d/tests.
// They are rendered only in a "legacy, uncertified by v2 rules" section and never mark a gate.
// Current gate status comes exclusively from out/evidence/acceptance.json (see src/checks/acceptance.ts).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const LegacyGateReport = z.object({
  gate: z.string().min(1),
  part: z.string().nullable().optional(),
  passed: z.boolean(),
  mode: z.string().min(1),
  source_revision: z.string().nullable().optional(),
  dirty: z.boolean().nullable().optional(),
  generated_at_unix: z.number().int().nonnegative().optional(),
  data: z.unknown(),
});
export type LegacyGateReport = z.infer<typeof LegacyGateReport>;

/** @deprecated Kept for callers not yet migrated; the result does not affect gate status. */
export type GateReport = LegacyGateReport;

/** Reads `*.json` in `dir` as raw values; the renderer validates them. Missing directory: none. */
export function loadGateReports(dir: string): unknown[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown);
}
