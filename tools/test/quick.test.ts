// make quick: the pinned prebuilt WASM set fails closed on any byte or pin mismatch, and its run is labelled and
// kept apart from the certified demo output.
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_RUN } from "../src/demo/main.js";
import { bindDemo } from "../src/evidence/binding.js";
import { wasmHashes } from "../src/evidence/report.js";
import { ACCEPTANCE_SCHEMA, type Acceptance } from "../src/evidence/schema.js";
import { QUICK_LABEL, labelHtml, quickProblems, quickRun } from "../src/quick/main.js";
import { CODE_PINS, PROVENANCE, QUICK_WASM, loadPrebuilt, pinHolds, type QuickRole } from "../src/quick/prebuilt.js";
import { Evidence } from "../src/types.js";

const root = resolve(import.meta.dirname, "../..");
const copies: string[] = [];
const sha256 = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");

const copyRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bm-quick-"));
  copies.push(dir);
  cpSync(join(root, "fixtures"), join(dir, "fixtures"), { recursive: true });
  return dir;
};

const flipByte = (path: string, at: number): void => {
  const bytes = readFileSync(path);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  writeFileSync(path, bytes);
};

type Files = Record<string, { sha256: string }>;
const editManifest = (dir: string, edit: (files: Files) => Files): void => {
  const path = join(dir, "fixtures/manifest.json");
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { files: Files };
  writeFileSync(path, JSON.stringify({ ...manifest, files: edit(manifest.files) }, null, 2));
};

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("make quick prebuilt pins", () => {
  it("loads the committed set: the deployment candidate, the pinned verifier and the prebuilt test doubles", () => {
    const set = loadPrebuilt(root);
    for (const [role, rel] of Object.entries(QUICK_WASM)) {
      const w = set.wasm[role as keyof typeof QUICK_WASM];
      expect(w.path).toBe(`fixtures/${rel}`);
      expect(w.sha256).toBe(sha256(join(root, "fixtures", rel)));
    }
    expect(set.provenance.reproducible).toBe(true);
    expect(set.provenance_sha256).toBe(sha256(join(root, "fixtures", PROVENANCE)));
    // Every prebuilt file is a stub crate's build output, named after the crate.
    for (const [name, f] of Object.entries(set.provenance.files)) {
      expect(name).toBe(`${f.crate.replaceAll("-", "_")}.wasm`);
      expect(f.manifest_path).toBe(`stubs/${f.crate}/Cargo.toml`);
      expect(f.bytes).toBe(readFileSync(join(root, "fixtures/prebuilt", name)).length);
    }
  });

  it("fails closed when a prebuilt test double's bytes differ from their pins (corrupted copy)", () => {
    const dir = copyRoot();
    flipByte(join(dir, "fixtures", QUICK_WASM.mpc), 100);
    expect(() => loadPrebuilt(dir)).toThrow(/fixtures\/prebuilt\/mock_mpc\.wasm: sha256 [0-9a-f]{64} != manifest/);
    expect(() => loadPrebuilt(dir)).toThrow(/fixtures\/prebuilt\/mock_mpc\.wasm: sha256 [0-9a-f]{64} != provenance/);
  });

  it("fails closed when the deployment candidate differs from its pin", () => {
    const dir = copyRoot();
    flipByte(join(dir, "fixtures", QUICK_WASM.mandate), 200);
    expect(() => loadPrebuilt(dir)).toThrow(/fixtures\/deploy\/bounded_mandate-163ccfa-reproducible\.wasm: sha256 [0-9a-f]{64} != manifest/);
  });

  it("fails closed when the manifest and the provenance agree with each other but not with the bytes", () => {
    const dir = copyRoot();
    const wasm = join(dir, "fixtures", QUICK_WASM.ft);
    flipByte(wasm, 64);
    // Re-pin the manifest to the corrupted bytes: the provenance record still disagrees.
    editManifest(dir, (files) => ({ ...files, [QUICK_WASM.ft]: { ...files[QUICK_WASM.ft], sha256: sha256(wasm) } }));
    expect(() => loadPrebuilt(dir)).toThrow(/mock_ft\.wasm: sha256 [0-9a-f]{64} != provenance/);
  });

  it("pins every deployed WASM in code, equal to the committed bytes and to the committed manifest", () => {
    const manifest = (JSON.parse(readFileSync(join(root, "fixtures/manifest.json"), "utf8")) as { files: Files }).files;
    expect(Object.keys(CODE_PINS).sort()).toEqual(Object.keys(QUICK_WASM).sort());
    for (const [role, rel] of Object.entries(QUICK_WASM) as [QuickRole, string][]) {
      expect(CODE_PINS[role], rel).toBe(sha256(join(root, "fixtures", rel)));
      expect(CODE_PINS[role], rel).toBe(manifest[rel]?.sha256);
    }
    const set = loadPrebuilt(root);
    expect(set.pins.map((p) => p.role).sort()).toEqual(Object.keys(QUICK_WASM).sort());
    for (const p of set.pins) {
      expect(pinHolds(p), p.path).toBe(true);
      expect(p.provenance === null).toBe(!p.path.startsWith("fixtures/prebuilt/"));
    }
  });

  it("refuses a coordinated re-pin: other bytes with the manifest and the provenance record re-pinned to them", () => {
    // Another mandate binary under the deployment candidate's name, with the manifest re-pinned to it.
    const mandate = copyRoot();
    const wasm = join(mandate, "fixtures", QUICK_WASM.mandate);
    flipByte(wasm, 200);
    editManifest(mandate, (files) => ({ ...files, [QUICK_WASM.mandate]: { ...files[QUICK_WASM.mandate], sha256: sha256(wasm) } }));
    expect(() => loadPrebuilt(mandate)).toThrow(new RegExp(`fixtures/deploy/bounded_mandate-163ccfa-reproducible\\.wasm: sha256 ${sha256(wasm)} != the pin in tools/src/quick/prebuilt\\.ts ${CODE_PINS.mandate}`));
    expect(() => loadPrebuilt(mandate)).not.toThrow(/!= manifest/);

    // Another test double, with its provenance entry, the provenance file's manifest pin and its own manifest pin all re-pinned.
    const double = copyRoot();
    const mpc = join(double, "fixtures", QUICK_WASM.mpc);
    flipByte(mpc, 100);
    const prov = join(double, "fixtures", PROVENANCE);
    const record = JSON.parse(readFileSync(prov, "utf8")) as { files: Record<string, { sha256: string }> };
    record.files["mock_mpc.wasm"] = { ...record.files["mock_mpc.wasm"], sha256: sha256(mpc) };
    writeFileSync(prov, JSON.stringify(record, null, 2));
    editManifest(double, (files) => ({ ...files, [QUICK_WASM.mpc]: { ...files[QUICK_WASM.mpc], sha256: sha256(mpc) }, [PROVENANCE]: { ...files[PROVENANCE], sha256: sha256(prov) } }));
    let message = "";
    try {
      loadPrebuilt(double);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // The pin in code is the only one left to disagree, and it does.
    expect(message.split("\n").slice(1)).toEqual([`fixtures/prebuilt/mock_mpc.wasm: sha256 ${sha256(mpc)} != the pin in tools/src/quick/prebuilt.ts ${CODE_PINS.mpc}`]);
  });

  it("fails closed when the provenance record is altered or a pin is missing", () => {
    const altered = copyRoot();
    const prov = join(altered, "fixtures", PROVENANCE);
    writeFileSync(prov, readFileSync(prov, "utf8").replace('"reproducible": true', '"reproducible": true '));
    expect(() => loadPrebuilt(altered)).toThrow(/fixtures\/prebuilt\/provenance\.json: sha256 [0-9a-f]{64} != manifest/);

    const unpinned = copyRoot();
    editManifest(unpinned, (files) => Object.fromEntries(Object.entries(files).filter(([path]) => path !== QUICK_WASM.oracle)));
    expect(() => loadPrebuilt(unpinned)).toThrow(/fixtures\/prebuilt\/mock_oracle\.wasm: not pinned in fixtures\/manifest\.json/);

    const missing = copyRoot();
    rmSync(join(missing, "fixtures", QUICK_WASM.verifier));
    expect(() => loadPrebuilt(missing)).toThrow(/fixtures\/verifier\/defuse-0\.4\.5\.wasm: missing/);
  });
});

describe("make quick run", () => {
  it("is labelled prebuilt and uncertified and never writes the certified demo output", () => {
    const run = quickRun(loadPrebuilt(root));
    expect(run.outRoot).not.toBe(DEMO_RUN.outRoot);
    expect(run.outRoot.startsWith(`${DEMO_RUN.outRoot}/`)).toBe(true);
    expect(["evidence", "page", "console", "demo"]).not.toContain(run.outRoot.split("/")[1]);
    expect(run.command).toContain("uncertified");
    expect(run.labels[0]?.startsWith(QUICK_LABEL)).toBe(true);
    expect(run.page.acceptance).toBeNull();
    expect(run.page.challenge).toBeNull();
    const html = run.decorate("<!doctype html><html><head></head><body class=x><h1>t</h1></body></html>");
    expect(html).toMatch(/<body class=x>\n<p role="note" id="quick-label"><strong>PREBUILT, UNCERTIFIED: make quick deployed the deployment candidate/);
    expect(() => labelHtml("<html></html>", "x")).toThrow();
  });

  it("records the pin check's real result: computed from the deployed bytes against each pin", () => {
    const set = loadPrebuilt(root);
    const pre = quickRun(set).preChecks;
    expect(pre.map((c) => c.id)).toEqual(["prebuilt-pins"]);
    expect(pre[0]?.passed).toBe(true);
    const observed = pre[0]?.observed as { wasm: Record<string, { sha256: string; pinned_in_code: string; pinned_in_manifest: string | null; pinned_in_provenance: string | null }> };
    for (const [role, rel] of Object.entries(QUICK_WASM)) {
      const file = sha256(join(root, "fixtures", rel));
      expect(observed.wasm[role]).toMatchObject({ sha256: file, pinned_in_code: file, pinned_in_manifest: file, pinned_in_provenance: rel.startsWith("prebuilt/") ? file : null });
    }
    // Not a constant: a set whose bytes disagree with any one pin, or that misses a file, records a failed check.
    const off = (edit: (p: (typeof set.pins)[number]) => (typeof set.pins)[number]): boolean | undefined =>
      quickRun({ ...set, pins: set.pins.map((p) => (p.role === "mpc" ? edit(p) : p)) }).preChecks[0]?.passed;
    expect(off((p) => ({ ...p, sha256: "0".repeat(64) }))).toBe(false);
    expect(off((p) => ({ ...p, code: "0".repeat(64) }))).toBe(false);
    expect(off((p) => ({ ...p, manifest: null }))).toBe(false);
    expect(off((p) => ({ ...p, provenance: null }))).toBe(false);
    expect(quickRun({ ...set, pins: set.pins.slice(1) }).preChecks[0]?.passed).toBe(false);
  });

  it("exits non-zero unless the evidence is the story's checks plus exactly the one pin check, all held", () => {
    const set = loadPrebuilt(root);
    const run = quickRun(set);
    const pre = run.preChecks.map((c) => c.id);
    const check = (id: string, passed = true) => ({ id, gate: "DEMO", description: "SYNTHETIC", passed, observed: null });
    const evidence = (assertions: ReturnType<typeof check>[], rev = "a".repeat(40), dirty = false): Evidence =>
      Evidence.parse({
        schema_version: 1,
        generated_at: "2026-11-09T00:00:00Z",
        mode: "sandbox",
        source: { product_commit: rev, dirty, spec_sha256: "b".repeat(64), spec_commit: "c".repeat(40), contract_wasm_sha256: set.wasm.mandate.sha256, fixtures: {}, fixture_manifest_sha256: "d".repeat(64), wasm_sha256: {} },
        environment: {},
        command: "SYNTHETIC",
        identifiers: {},
        receipts: [],
        assertions,
        unknowns: [],
      });
    const story = ["s1", "s2", "s3"].map((id) => check(id));
    const pin = check("prebuilt-pins");
    expect(quickProblems(evidence([pin, ...story]), pre, null)).toEqual([]);
    expect(quickProblems(evidence([pin, ...story]), pre, evidence(story))).toEqual([]);
    expect(quickProblems(evidence(story), pre, null)).toEqual(["prebuilt-pins is recorded 0 times, expected once", "3 assertions recorded, expected the story's 3 + 1"]);
    expect(quickProblems(evidence([pin, pin, ...story]), pre, null)).toEqual(["prebuilt-pins is recorded 2 times, expected once", "5 assertions recorded, expected the story's 3 + 1"]);
    expect(quickProblems(evidence([pin]), pre, null)).toEqual(["the story recorded no checks"]);
    expect(quickProblems(evidence([check("prebuilt-pins", false), ...story]), pre, null)).toEqual(["1 assertions did not hold: prebuilt-pins"]);
    expect(quickProblems(evidence([pin, check("s1", false), ...story.slice(1)]), pre, null)).toEqual(["1 assertions did not hold: s1"]);
    // Against make demo's saved evidence of the same clean revision, the story has the same number of checks.
    expect(quickProblems(evidence([pin, ...story]), pre, evidence(story.slice(1)))).toEqual(["the story recorded 3 checks; make demo at the same revision recorded 2"]);
    expect(quickProblems(evidence([pin, ...story]), pre, evidence(story.slice(1), "e".repeat(40)))).toEqual([]);
    expect(quickProblems(evidence([pin, ...story]), pre, evidence(story.slice(1), "a".repeat(40), true))).toEqual([]);
  });

  it("records no target/near WASM hash, so the demo binding can never certify a quick run", () => {
    const set = loadPrebuilt(root);
    const deployed = wasmHashes(Object.values(set.wasm));
    expect(deployed).toEqual({});
    const rev = "a".repeat(40);
    const fixtures = { [QUICK_WASM.verifier]: set.wasm.verifier.sha256 };
    const ev = Evidence.parse({
      schema_version: 1,
      generated_at: "2026-11-09T00:00:00Z",
      mode: "sandbox",
      source: { product_commit: rev, dirty: false, spec_sha256: "b".repeat(64), spec_commit: "c".repeat(40), contract_wasm_sha256: set.wasm.mandate.sha256, fixtures, fixture_manifest_sha256: "d".repeat(64), wasm_sha256: deployed },
      environment: {},
      command: quickRun(set).command,
      identifiers: {},
      receipts: [],
      assertions: [],
      unknowns: [],
    });
    // An acceptance run that agrees on every other input, and even lists the prebuilt bytes under the build stems.
    const acceptance: Acceptance = {
      schema: ACCEPTANCE_SCHEMA,
      run_id: "run-SYNTHETIC",
      revision: rev,
      dirty: false,
      certified: true,
      complete: true,
      started_at: null,
      evaluated_at: "2026-11-09T00:00:00Z",
      hashes: { spec_sha256: "b".repeat(64), fixture_manifest_sha256: "d".repeat(64), fixtures, wasm: { mock_ft: set.wasm.ft.sha256, mock_mpc: set.wasm.mpc.sha256, mock_oracle: set.wasm.oracle.sha256 } },
      environment: {},
      commands: [],
      cases: [],
      separate: [],
      problems: [],
      ignored: [],
      baseline: null,
    };
    const b = bindDemo(ev, acceptance, "run-SYNTHETIC");
    expect(b.certified).toBe(false);
    expect(b.reasons).toContain("demo.json records no hashes of the WASMs it deployed");
  });
});
