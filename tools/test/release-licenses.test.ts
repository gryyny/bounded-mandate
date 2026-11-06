// License classification and NOTICE coverage, on synthetic lockfiles, metadata and fixture trees.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cargoDependencies, classify, detectLicenseText, fixtureDisclosures, licenseReport, npmDependencies, type CargoMeta } from "../src/release/licenses.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tree = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), "bm-licenses-"));
  dirs.push(root);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), c);
  }
  return root;
};

describe("license classification", () => {
  it.each([
    ["MIT", "permissive"],
    ["MIT OR Apache-2.0", "permissive"],
    ["MIT/Apache-2.0", "permissive"],
    ["(MIT OR Apache-2.0) AND Unicode-3.0", "permissive"],
    ["MIT OR Apache-2.0 OR LGPL-2.1-or-later", "permissive"],
    ["Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT", "permissive"],
    ["MPL-2.0", "weak-copyleft"],
    ["MIT AND MPL-2.0", "weak-copyleft"],
    ["GPL-3.0-only", "strong-copyleft"],
    ["AGPL-3.0-or-later OR MPL-2.0", "weak-copyleft"],
    ["MIT AND (GPL-2.0-only OR LGPL-2.1-only)", "weak-copyleft"],
    ["UNLICENSED", "unknown"],
    ["SEE LICENSE IN LICENSE.md", "unknown"],
    ["Custom-1.0", "unknown"],
    ["", "unknown"],
  ])("%s is %s", (expr, cls) => {
    expect(classify(expr)).toBe(cls);
  });

  it("recognises common license texts", () => {
    expect(detectLicenseText("MIT License\n\nPermission is hereby granted, free of charge, to any person")).toBe("MIT");
    expect(detectLicenseText("Apache License\nVersion 2.0, January 2004")).toBe("Apache-2.0");
    expect(detectLicenseText("Redistribution and use in source and binary forms ... Neither the name")).toBe("BSD-3-Clause");
    expect(detectLicenseText("All rights reserved.")).toBeNull();
  });
});

describe("dependency enumeration", () => {
  it("reads npm licenses from the lockfile, then from the installed package", () => {
    const root = tree({
      "package-lock.json": JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": { name: "x" },
          "node_modules/a": { version: "1.0.0", license: "MIT" },
          "node_modules/b": { version: "2.0.0", dev: true },
          "node_modules/a/node_modules/@s/c": { version: "3.0.0", license: "GPL-3.0-only" },
          "node_modules/l": { version: "0.0.0", link: true },
        },
      }),
      "node_modules/b/package.json": JSON.stringify({ name: "b", license: "MPL-2.0" }),
    });
    const deps = npmDependencies(root);
    expect(deps.map((d) => [d.name, d.version, d.license, d.class, d.dev])).toEqual([
      ["a", "1.0.0", "MIT", "permissive", false],
      ["b", "2.0.0", "MPL-2.0", "weak-copyleft", true],
      ["@s/c", "3.0.0", "GPL-3.0-only", "strong-copyleft", false],
    ]);
  });

  it("marks cargo crates linked into the contract WASM and reads a missing license from the crate's LICENSE", () => {
    const root = tree({
      "git/checkouts/repo-1/abc/LICENSE": "Permission is hereby granted, free of charge, to any person",
      "git/checkouts/repo-1/abc/crates/core/Cargo.toml": "",
    });
    const pkg = (name: string, license: string | null, manifest = join(root, `reg/${name}/Cargo.toml`)) => ({
      id: `${name}-id`,
      name,
      version: "1.0.0",
      license,
      license_file: null,
      source: "registry",
      manifest_path: manifest,
    });
    const dep = (pkgId: string, kind: string | null) => ({ pkg: pkgId, dep_kinds: [{ kind, target: null }] });
    const meta: CargoMeta = {
      packages: [pkg("contract", "MIT"), pkg("sdk", "MIT OR Apache-2.0"), pkg("alloc", "MPL-2.0"), pkg("core", null, join(root, "git/checkouts/repo-1/abc/crates/core/Cargo.toml")), pkg("testlib", "GPL-3.0-only")],
      workspace_members: ["contract-id"],
      resolve: {
        nodes: [
          { id: "contract-id", deps: [dep("sdk-id", null), dep("core-id", "dev"), dep("testlib-id", "dev")] },
          { id: "sdk-id", deps: [dep("alloc-id", null)] },
          { id: "alloc-id", deps: [] },
          { id: "core-id", deps: [] },
          { id: "testlib-id", deps: [] },
        ],
      },
    };
    const deps = cargoDependencies(meta, new Set(["sdk 1.0.0", "alloc 1.0.0"]));
    expect(deps.map((d) => [d.name, d.license, d.class, d.dev, d.in_contract_wasm])).toEqual([
      ["sdk", "MIT OR Apache-2.0", "permissive", false, true],
      ["alloc", "MPL-2.0", "weak-copyleft", false, true],
      ["core", "MIT", "permissive", true, false],
      ["testlib", "GPL-3.0-only", "strong-copyleft", true, false],
    ]);
    // Strong copyleft used only in tests is listed, not a distribution problem.
    const files = tree({ "fixtures/manifest.json": JSON.stringify({ files: {} }), NOTICE: "" });
    const report = licenseReport(files, deps);
    expect(report.flagged.map((d) => d.name)).toEqual(["alloc", "testlib"]);
    expect(report.problems).toEqual([]);
    expect(report.contract_wasm.map((d) => d.name)).toEqual(["sdk", "alloc"]);
  });
});

describe("NOTICE coverage of fixtures", () => {
  it("requires every external fixture in NOTICE and every fixture in the manifest", () => {
    const root = tree({
      "fixtures/manifest.json": JSON.stringify({
        files: {
          "verifier/v.wasm": { kind: "external-binary" },
          "model/m.json": { kind: "recorded-genuine-model-interaction" },
          "vectors/own.json": { kind: "generated-vectors" },
          "x/x.provenance.json": { kind: "provenance-record" },
        },
      }),
      "fixtures/verifier/v.wasm": "w",
      "fixtures/model/m.json": "{}",
      "fixtures/vectors/own.json": "{}",
      "fixtures/x/x.provenance.json": "{}",
      "fixtures/new/unlisted.wasm": "w",
      NOTICE: "fixtures/verifier/v.wasm\n  MIT\n",
    });
    expect(fixtureDisclosures(root).map((f) => [f.path, f.external, f.in_notice, f.in_manifest])).toEqual([
      ["fixtures/model/m.json", true, false, true],
      ["fixtures/new/unlisted.wasm", true, false, false],
      ["fixtures/vectors/own.json", false, false, true],
      ["fixtures/verifier/v.wasm", true, true, true],
      ["fixtures/x/x.provenance.json", false, false, true],
    ]);
    expect(licenseReport(root, []).problems).toEqual([
      "fixtures/new/unlisted.wasm: not listed in fixtures/manifest.json (provenance and hash missing)",
      "fixtures/model/m.json: external fixture (recorded-genuine-model-interaction) not named in NOTICE",
      "fixtures/new/unlisted.wasm: external fixture (unlisted) not named in NOTICE",
    ]);
  });
});
