// Binding between a demo run and an acceptance verdict, on SYNTHETIC specimens built here.
import { describe, expect, it } from "vitest";
import { bindDemo } from "../src/evidence/binding.js";
import { ACCEPTANCE_SCHEMA, type Acceptance } from "../src/evidence/schema.js";
import { Evidence } from "../src/types.js";

const REV = "a".repeat(40);
const FIXTURES = { "verifier/defuse-0.4.5.wasm": "e".repeat(64), "model/normal.json": "f".repeat(64) };
const WASM = { bounded_mandate: "1".repeat(64), mock_mpc: "2".repeat(64) };

const boundEvidence = (source: Partial<Evidence["source"]> = {}): Evidence =>
  Evidence.parse({
    schema_version: 1,
    generated_at: "2026-11-04T00:00:00Z",
    mode: "sandbox",
    source: {
      product_commit: REV,
      dirty: false,
      spec_sha256: "b".repeat(64),
      spec_commit: "c".repeat(40),
      contract_wasm_sha256: WASM.bounded_mandate,
      fixtures: FIXTURES,
      fixture_manifest_sha256: "d".repeat(64),
      wasm_sha256: WASM,
      ...source,
    },
    environment: { label: "SYNTHETIC" },
    command: "SYNTHETIC",
    identifiers: {},
    receipts: [],
    assertions: [],
    unknowns: [],
  });

const boundAcceptance = (over: Partial<Acceptance> = {}, hashes: Partial<Acceptance["hashes"]> = {}): Acceptance => ({
  schema: ACCEPTANCE_SCHEMA,
  run_id: "run-SYNTHETIC",
  revision: REV,
  dirty: false,
  certified: true,
  complete: true,
  started_at: null,
  evaluated_at: "2026-11-04T00:00:00Z",
  hashes: { spec_sha256: "b".repeat(64), fixture_manifest_sha256: "d".repeat(64), fixtures: FIXTURES, wasm: { ...WASM, mock_ft: "3".repeat(64) }, ...hashes },
  environment: {},
  commands: [],
  cases: [],
  separate: [],
  problems: [],
  ignored: [],
  baseline: null,
  ...over,
});

describe("demo-to-acceptance binding", () => {
  it("certifies a demo bound to the latest certified run on every input", () => {
    const b = bindDemo(boundEvidence(), boundAcceptance(), "run-SYNTHETIC");
    expect(b.reasons).toEqual([]);
    expect(b.certified).toBe(true);
  });

  const cases: [string, Evidence, Acceptance | null, string | null, RegExp][] = [
    ["no acceptance", boundEvidence(), null, null, /no acceptance run/],
    ["revision", boundEvidence({ product_commit: "0".repeat(40) }), boundAcceptance(), null, /revision differs/],
    ["dirty demo", boundEvidence({ dirty: true }), boundAcceptance(), null, /demo ran from a dirty tree/],
    ["dirty acceptance", boundEvidence(), boundAcceptance({ dirty: true, certified: false }), null, /not certified.*dirty tree/],
    ["uncertified acceptance", boundEvidence(), boundAcceptance({ certified: false, complete: false }), null, /not certified \(incomplete/],
    ["spec", boundEvidence({ spec_sha256: "9".repeat(64) }), boundAcceptance(), null, /SPEC\.md sha256 differs/],
    ["fixture manifest", boundEvidence({ fixture_manifest_sha256: "9".repeat(64) }), boundAcceptance(), null, /manifest\.json sha256 differs/],
    ["missing fixture manifest", boundEvidence({ fixture_manifest_sha256: undefined }), boundAcceptance(), null, /no fixture-manifest hash/],
    ["fixture file", boundEvidence({ fixtures: { ...FIXTURES, "model/normal.json": "9".repeat(64) } }), boundAcceptance(), null, /fixture model\/normal\.json differs/],
    ["extra fixture", boundEvidence({ fixtures: { ...FIXTURES, "extra.json": "9".repeat(64) } }), boundAcceptance(), null, /fixture extra\.json is not in the acceptance run/],
    ["WASM", boundEvidence({ wasm_sha256: { ...WASM, mock_mpc: "9".repeat(64) } }), boundAcceptance(), null, /WASM mock_mpc differs/],
    ["unrecorded WASM", boundEvidence({ wasm_sha256: { ...WASM, other: "9".repeat(64) } }), boundAcceptance(), null, /WASM other is not in the acceptance run/],
    ["no WASM hashes", boundEvidence({ wasm_sha256: undefined }), boundAcceptance(), null, /records no hashes of the WASMs/],
    ["acceptance from another run", boundEvidence(), boundAcceptance(), "run-LATER", /acceptance\.json is from run run-SYNTHETIC, but the latest run is run-LATER/],
  ];

  it.each(cases)("refuses certification on a mismatched %s", (_what, ev, acc, latest, reason) => {
    const b = bindDemo(ev, acc, latest);
    expect(b.certified).toBe(false);
    expect(b.reasons.join("\n")).toMatch(reason);
  });

  it("records the inputs it compared", () => {
    const b = bindDemo(boundEvidence(), boundAcceptance(), "run-SYNTHETIC");
    expect(b.inputs.demo.wasm_sha256).toEqual(WASM);
    expect(b.inputs.acceptance?.run_id).toBe("run-SYNTHETIC");
    expect(b.inputs.latest_run_id).toBe("run-SYNTHETIC");
  });
});
