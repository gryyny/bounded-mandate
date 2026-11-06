// The vitest envelope-v2 writer, exercised on a SYNTHETIC repository copy.
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CaseRecorder, portableCommand, wasmHashes, writeGateReport } from "../src/evidence/report.js";
import { GateReportV2 } from "../src/evidence/schema.js";

const repo = resolve(import.meta.dirname, "../..");
const roots: string[] = [];
const savedRunId = process.env.MANDATE_RUN_ID;
afterEach(() => {
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true });
  if (savedRunId === undefined) delete process.env.MANDATE_RUN_ID;
  else process.env.MANDATE_RUN_ID = savedRunId;
});

const tempRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), "bm-report-"));
  roots.push(root);
  cpSync(join(repo, "SPEC.md"), join(root, "SPEC.md"));
  cpSync(join(repo, "fixtures"), join(root, "fixtures"), { recursive: true });
  return root;
};

const read = (path: string): GateReportV2 => GateReportV2.parse(JSON.parse(readFileSync(path, "utf8")));

describe("gate report writer", () => {
  it("writes envelope v2 bound to the run id and the hashes it read", () => {
    const root = tempRoot();
    process.env.MANDATE_RUN_ID = "run-synthetic";
    const path = writeGateReport({ gate: "MODEL", case: "recorded-proposal", passed: true, mode: "sandbox", wasm: { x: "a".repeat(64) }, data: { synthetic: true }, root });
    expect(path).toBe(join(root, "out/evidence/tests/MODEL.recorded-proposal.json"));
    const r = read(path);
    expect(r.run_id).toBe("run-synthetic");
    expect(r.source.dirty).toBe(true); // not a git repository: never claimed clean
    expect(r.spec_sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("records a null run id outside a run and never overwrites an earlier report", () => {
    const root = tempRoot();
    delete process.env.MANDATE_RUN_ID;
    const first = writeGateReport({ gate: "T1", case: "pending-sign", passed: true, mode: "unit-vm", wasm: {}, data: null, root });
    const second = writeGateReport({ gate: "T1", case: "pending-sign", passed: false, mode: "unit-vm", wasm: {}, data: null, root });
    expect(read(first).run_id).toBeNull();
    expect(second).not.toBe(first);
    expect(readdirSync(join(root, "out/evidence/tests")).sort()).toEqual(["T1.pending-sign.duplicate-2.json", "T1.pending-sign.json"]);
  });

  it("keeps only target/near WASMs, keyed by stem", () => {
    expect(
      wasmHashes([
        { path: "target/near/bounded_mandate/bounded_mandate.wasm", sha256: "1".repeat(64) },
        { path: "fixtures/verifier/defuse-0.4.5.wasm", sha256: "2".repeat(64) },
      ]),
    ).toEqual({ bounded_mandate: "1".repeat(64) });
  });
});

describe("recorded command", () => {
  it("keeps no machine-local path: repository paths become relative, other absolute paths their file name", () => {
    const root = "/home/someone/clone";
    expect(portableCommand(["/opt/node/bin/node", "/home/someone/clone/tools/node_modules/vitest/vitest.mjs", "run", "test/x.test.ts"], root)).toBe(
      "node tools/node_modules/vitest/vitest.mjs run test/x.test.ts",
    );
    expect(portableCommand(["/home/someone/clone-other/a.js", "/home/someone/clone"], root)).toBe("a.js clone");
  });

  it("records the writer's own command without the checkout's absolute path", () => {
    const report = read(writeGateReport({ root: tempRoot(), gate: "T1", case: "portable", passed: true, mode: "unit", wasm: {}, data: {} }));
    expect(report.command).not.toContain(repo);
    expect(report.command.split(" ").filter((a) => a.startsWith("/"))).toEqual([]);
  });
});

describe("case recorder", () => {
  it("passes only when every expected check ran and passed", async () => {
    const root = tempRoot();
    const rec = new CaseRecorder("BOUNDARY", "attacks", ["a", "b"]);
    await rec.check("a", () => undefined);
    expect(rec.passed()).toBe(false); // "b" never ran (filtered or skipped)
    await expect(rec.check("b", () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(rec.passed()).toBe(false);
    const r = read(rec.write("sandbox", {}, {}, root));
    expect(r.passed).toBe(false);
    expect(r.data).toMatchObject({ missing_checks: [], checks: [{ name: "a", passed: true }, { name: "b", passed: false, error: "boom" }] });
  });

  it("refuses checks it does not know", async () => {
    const rec = new CaseRecorder("MODEL", "recorded-proposal", ["x"]);
    await expect(rec.check("y", () => undefined)).rejects.toThrow(/unexpected check/);
    await rec.check("x", () => undefined);
    expect(rec.passed()).toBe(true);
  });
});
