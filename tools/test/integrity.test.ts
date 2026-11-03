import { cpSync, mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkIntegrity } from "../src/checks/integrity.js";

const root = resolve(import.meta.dirname, "../..");
const copies: string[] = [];

const copyRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "bm-integrity-"));
  copies.push(dir);
  cpSync(join(root, "SPEC.md"), join(dir, "SPEC.md"));
  cpSync(join(root, "spec-source.json"), join(dir, "spec-source.json"));
  cpSync(join(root, "fixtures"), join(dir, "fixtures"), { recursive: true });
  return dir;
};

afterEach(() => {
  for (const dir of copies.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("spec and fixture integrity", () => {
  it("accepts the committed snapshot and fixtures", () => {
    const report = checkIntegrity(root);
    expect(report.fixtures["verifier/defuse-0.4.5.wasm"]).toBe(
      "a1afab98916d9f213746544dcf8e4e6bdb22c0be6bc5dfbd8ea8814c9922b547",
    );
  });

  it("rejects a changed spec snapshot", () => {
    const dir = copyRoot();
    appendFileSync(join(dir, "SPEC.md"), "\nedited\n");
    expect(() => checkIntegrity(dir)).toThrow(/SPEC\.md: sha256/);
  });

  it("rejects a changed fixture", () => {
    const dir = copyRoot();
    appendFileSync(join(dir, "fixtures/verifier/defuse-0.4.5.wasm"), Buffer.from([0]));
    expect(() => checkIntegrity(dir)).toThrow(/defuse-0\.4\.5\.wasm: sha256/);
  });

  it("rejects an unlisted fixture", () => {
    const dir = copyRoot();
    writeFileSync(join(dir, "fixtures/extra.json"), "{}");
    expect(() => checkIntegrity(dir)).toThrow(/extra\.json: not listed/);
  });
});
