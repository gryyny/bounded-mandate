// Binds a demo run (demo.json) to an acceptance verdict (acceptance.json). The page and the video may call a
// run "certified", or show a gate as passed, only when this binding holds: a certified acceptance run that is
// the latest run, and a demo from the same clean revision with the same spec, fixtures and deployed WASMs.
import { readRun } from "../checks/run.js";
import type { Evidence } from "../types.js";
import type { Acceptance } from "./schema.js";

export interface DemoBinding {
  certified: boolean;
  /** Every reason the binding fails; empty when certified. */
  reasons: string[];
  inputs: {
    demo: { revision: string; dirty: boolean; spec_sha256: string; fixture_manifest_sha256: string | null; fixtures: Record<string, string>; wasm_sha256: Record<string, string> | null };
    acceptance: { run_id: string | null; revision: string | null; dirty: boolean; certified: boolean; complete: boolean; spec_sha256: string | null; fixture_manifest_sha256: string | null; fixtures: Record<string, string>; wasm_sha256: Record<string, string> } | null;
    latest_run_id: string | null;
  };
}

const diffMaps = (what: string, demo: Record<string, string>, acc: Record<string, string>, onlyDemoKeys: boolean): string[] => {
  const keys = onlyDemoKeys ? Object.keys(demo) : [...new Set([...Object.keys(demo), ...Object.keys(acc)])];
  return keys.sort().flatMap((k) => {
    if (acc[k] === undefined) return [`${what} ${k} is not in the acceptance run`];
    if (demo[k] === undefined) return [`${what} ${k} is not in the demo`];
    return demo[k] === acc[k] ? [] : [`${what} ${k} differs (demo ${demo[k].slice(0, 12)}, acceptance ${acc[k].slice(0, 12)})`];
  });
};

export function bindDemo(ev: Evidence, acc: Acceptance | null, latestRunId: string | null = null): DemoBinding {
  const s = ev.source;
  const demo = {
    revision: s.product_commit,
    dirty: s.dirty,
    spec_sha256: s.spec_sha256,
    fixture_manifest_sha256: s.fixture_manifest_sha256 ?? null,
    fixtures: s.fixtures,
    wasm_sha256: s.wasm_sha256 ?? null,
  };
  const inputs: DemoBinding["inputs"] = {
    demo,
    acceptance:
      acc === null
        ? null
        : {
            run_id: acc.run_id,
            revision: acc.revision,
            dirty: acc.dirty,
            certified: acc.certified,
            complete: acc.complete,
            spec_sha256: acc.hashes.spec_sha256,
            fixture_manifest_sha256: acc.hashes.fixture_manifest_sha256,
            fixtures: acc.hashes.fixtures,
            wasm_sha256: acc.hashes.wasm,
          },
    latest_run_id: latestRunId,
  };
  if (acc === null) return { certified: false, reasons: ["no acceptance run (out/evidence/acceptance.json absent)"], inputs };

  const reasons: string[] = [];
  if (latestRunId !== null && latestRunId !== acc.run_id) reasons.push(`acceptance.json is from run ${String(acc.run_id)}, but the latest run is ${latestRunId}`);
  if (!acc.certified) reasons.push(`the acceptance run is not certified${acc.complete ? "" : " (incomplete or failing cases)"}${acc.dirty ? " (dirty tree)" : ""}`);
  if (acc.dirty && acc.certified) reasons.push("the acceptance run is from a dirty tree");
  if (demo.dirty) reasons.push("the demo ran from a dirty tree");
  if (acc.revision !== demo.revision) reasons.push(`revision differs (demo ${demo.revision.slice(0, 12)}, acceptance ${String(acc.revision).slice(0, 12)})`);
  if (acc.hashes.spec_sha256 !== demo.spec_sha256) reasons.push("SPEC.md sha256 differs");
  if (demo.fixture_manifest_sha256 === null) reasons.push("demo.json records no fixture-manifest hash");
  else if (acc.hashes.fixture_manifest_sha256 !== demo.fixture_manifest_sha256) reasons.push("fixtures/manifest.json sha256 differs");
  reasons.push(...diffMaps("fixture", demo.fixtures, acc.hashes.fixtures, false));
  if (demo.wasm_sha256 === null || Object.keys(demo.wasm_sha256).length === 0) reasons.push("demo.json records no hashes of the WASMs it deployed");
  else reasons.push(...diffMaps("WASM", demo.wasm_sha256, acc.hashes.wasm, true));
  return { certified: reasons.length === 0, reasons, inputs };
}

/** The latest run id from out/run/run.json, or null when there is no readable run record. */
export function latestRunId(root: string): string | null {
  try {
    return readRun(root)?.run_id ?? null;
  } catch {
    return null;
  }
}
