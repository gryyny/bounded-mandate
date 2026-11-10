// `make quick`: the demo story without Rust. It deploys the exact deployment candidate (fixtures/deploy), the pinned
// verifier and PREBUILT test doubles (fixtures/prebuilt), each checked against its pinned hash first. The run is
// prebuilt and uncertified: its output goes to out/quick/ (never out/evidence, out/page or out/console), its page is
// rendered with no acceptance run, and its evidence records no target/near WASM hash, so the page and video binding
// can never call it certified.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEMO_RUN, runDemo, type DemoRun } from "../demo/main.js";
import { REPO_ROOT } from "../near/sandbox.js";
import { Evidence } from "../types.js";
import { PROVENANCE, QUICK_WASM, loadPrebuilt, pinHolds, type PrebuiltSet } from "./prebuilt.js";

export const QUICK_LABEL = "PREBUILT, UNCERTIFIED";
export const QUICK_OUT = "out/quick";

const escapeHtml = (s: string): string => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

export function quickStatement(set: PrebuiltSet): string {
  const p = set.provenance;
  return `${QUICK_LABEL}: make quick deployed the deployment candidate fixtures/${QUICK_WASM.mandate} and prebuilt test doubles from fixtures/prebuilt (built by cargo-near reproducible-wasm in ${p.toolchain.host} at revision ${p.source.revision.slice(0, 12)}; make quick checks their pinned hashes and does not rebuild them). This run is not bound to any acceptance run and certifies nothing; make test and make demo are the certified path.`;
}

/** Adds a visible label right after <body> so a quick page or console cannot be mistaken for the certified demo. */
export function labelHtml(html: string, statement: string): string {
  const at = html.search(/<body[^>]*>/);
  if (at < 0) throw new Error("no <body> to label");
  const end = html.indexOf(">", at) + 1;
  return `${html.slice(0, end)}\n<p role="note" id="quick-label"><strong>${escapeHtml(statement)}</strong></p>\n${html.slice(end)}`;
}

export function quickRun(set: PrebuiltSet): DemoRun {
  const statement = quickStatement(set);
  return {
    command: `make quick (${QUICK_LABEL.toLowerCase()})`,
    banner: `bounded-mandate quick demo, ${QUICK_LABEL} (sandbox; deployment candidate + prebuilt test doubles; no Rust; no model-provider calls)`,
    outRoot: QUICK_OUT,
    wasm: set.wasm,
    wasmSource: `deployment candidate fixtures/${QUICK_WASM.mandate} (make quick, ${QUICK_LABEL.toLowerCase()})`,
    labels: [statement],
    environment: {
      wasm_source: `${QUICK_LABEL.toLowerCase()}: fixtures/${QUICK_WASM.mandate}, fixtures/${QUICK_WASM.verifier}, fixtures/prebuilt (see fixtures/${PROVENANCE})`,
      prebuilt_provenance_sha256: set.provenance_sha256,
      quick_wasm_sha256: JSON.stringify(Object.fromEntries(Object.entries(set.wasm).map(([role, w]) => [role, w.sha256]))),
    },
    preChecks: [
      {
        id: "prebuilt-pins",
        gate: "INTEGRITY",
        description: "every WASM make quick deploys matches its sha256 pinned in code (tools/src/quick/prebuilt.ts), in fixtures/manifest.json and, for the prebuilt doubles, in the provenance record",
        // The result of comparing the deployed bytes with each pin, not a constant.
        passed: set.pins.length === Object.keys(QUICK_WASM).length && set.pins.every((p) => pinHolds(p)),
        observed: { provenance: `fixtures/${PROVENANCE}`, provenance_sha256: set.provenance_sha256, wasm: Object.fromEntries(set.pins.map((p) => [p.role, { path: p.path, sha256: p.sha256, pinned_in_code: p.code, pinned_in_manifest: p.manifest, pinned_in_provenance: p.provenance }])) },
      },
    ],
    page: { acceptance: null, latestRunId: null, live: null, reports: [], challenge: null },
    decorate: (html) => labelHtml(html, statement),
  };
}

/**
 * Why a finished quick run's evidence is not "the demo story plus the pin check"; empty when it is. The run must
 * record the story's checks and exactly the one pin check, all passed. `demo` is the saved `make demo` evidence when
 * it is of the same clean revision: then the story must have the same number of checks.
 */
export function quickProblems(quick: Evidence, pre: readonly string[], demo: Evidence | null): string[] {
  const out: string[] = [];
  const story = quick.assertions.filter((a) => !pre.includes(a.id));
  for (const id of pre) {
    const found = quick.assertions.filter((a) => a.id === id);
    if (found.length !== 1) out.push(`${id} is recorded ${String(found.length)} times, expected once`);
  }
  if (quick.assertions.length !== story.length + 1) out.push(`${String(quick.assertions.length)} assertions recorded, expected the story's ${String(story.length)} + 1`);
  if (story.length === 0) out.push("the story recorded no checks");
  const failed = quick.assertions.filter((a) => !a.passed);
  if (failed.length > 0) out.push(`${String(failed.length)} assertions did not hold: ${failed.map((a) => a.id).join(", ")}`);
  if (demo !== null && !demo.source.dirty && !quick.source.dirty && demo.source.product_commit === quick.source.product_commit && demo.assertions.length !== story.length) {
    out.push(`the story recorded ${String(story.length)} checks; make demo at the same revision recorded ${String(demo.assertions.length)}`);
  }
  return out;
}

const readEvidence = (path: string): Evidence | null => (existsSync(path) ? Evidence.parse(JSON.parse(readFileSync(path, "utf8"))) : null);

async function main(): Promise<number> {
  let set: PrebuiltSet;
  try {
    set = loadPrebuilt(REPO_ROOT);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("make quick: refusing to run on unpinned bytes");
    return 1;
  }
  const run = quickRun(set);
  if (run.outRoot === DEMO_RUN.outRoot) throw new Error("make quick must not write the certified demo output");
  const code = await runDemo(run);
  const quick = readEvidence(join(REPO_ROOT, run.outRoot, "evidence/demo.json"));
  const problems = quick === null ? [`${run.outRoot}/evidence/demo.json was not written`] : quickProblems(quick, run.preChecks.map((c) => c.id), readEvidence(join(REPO_ROOT, DEMO_RUN.outRoot, "evidence/demo.json")));
  for (const p of problems) console.error(`make quick: ${p}`);
  return code !== 0 || problems.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main();
}
