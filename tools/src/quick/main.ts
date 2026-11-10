// `make quick`: the demo story without Rust. It deploys the exact deployment candidate (fixtures/deploy), the pinned
// verifier and PREBUILT test doubles (fixtures/prebuilt), each checked against its pinned hash first. The run is
// prebuilt and uncertified: its output goes to out/quick/ (never out/evidence, out/page or out/console), its page is
// rendered with no acceptance run, and its evidence records no target/near WASM hash, so the page and video binding
// can never call it certified.
import { resolve } from "node:path";
import { DEMO_RUN, runDemo, type DemoRun } from "../demo/main.js";
import { REPO_ROOT } from "../near/sandbox.js";
import { PROVENANCE, QUICK_WASM, loadPrebuilt, type PrebuiltSet } from "./prebuilt.js";

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
        description: "every WASM make quick deploys matches its pinned sha256 (fixtures/manifest.json and the prebuilt provenance)",
        passed: true,
        observed: { provenance: `fixtures/${PROVENANCE}`, provenance_sha256: set.provenance_sha256, wasm: Object.fromEntries(Object.entries(set.wasm).map(([role, w]) => [role, { path: w.path, sha256: w.sha256 }])) },
      },
    ],
    page: { acceptance: null, latestRunId: null, live: null, reports: [], challenge: null },
    decorate: (html) => labelHtml(html, statement),
  };
}

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
  return runDemo(run);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  process.exitCode = await main();
}
