// verify.mjs offline: the committed bundle, a SYNTHETIC certified repository and negative controls. No network.
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_CASES, SEPARATE_CASES } from "../src/evidence/required.js";
import { REPO_ROOT, SYNTHETIC_BUNDLE, copyRealRepo, runVerify, syntheticRepo, tempDir } from "./fixtures/verify/synthetic.js";

const dirs: string[] = [];
const temp = (): string => {
  const dir = tempDir("bm-verify-");
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const synthetic = async (): Promise<string> => {
  const dir = temp();
  syntheticRepo(dir);
  expect((await runVerify(["--root", dir, "--write-manifest", SYNTHETIC_BUNDLE])).code).toBe(0);
  return dir;
};
const editJson = (path: string, edit: (v: Record<string, unknown>) => void): void => {
  const v = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  edit(v);
  writeFileSync(path, `${JSON.stringify(v, null, 2)}\n`);
};
const lineOf = (out: string, gate: string): string => out.split("\n").find((l) => l.slice(13).startsWith(`${gate}  `)) ?? `(no line for ${gate})`;

describe("verify.mjs required cases", () => {
  it("lists exactly the cases of tools/src/evidence/required.ts", async () => {
    const r = await runVerify(["--print-required"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ required: REQUIRED_CASES, separate: SEPARATE_CASES });
  });
});

describe("verify.mjs against the committed certified bundle", () => {
  const index = JSON.parse(readFileSync(join(REPO_ROOT, "evidence/index.json"), "utf8")) as { bundles: { path: string; status: string }[] };
  const bundle = index.bundles.find((b) => b.status === "certified")?.path ?? "(none)";

  // The bundle's own SHA256SUMS is checked as committed; a bundle curated before verify.mjs gets one in a scratch copy.
  const copy = async (): Promise<string> => {
    const dir = temp();
    copyRealRepo(dir, bundle);
    if (!existsSync(join(dir, bundle, "SHA256SUMS"))) expect((await runVerify(["--root", dir, "--write-manifest", bundle])).code).toBe(0);
    return dir;
  };

  // The bundle was certified under the rules of its own revision; a gate required since then must show as failed.
  it("verifies the recorded evidence, one line per gate, under the current required cases", async () => {
    const dir = await copy();
    const r = await runVerify(["--root", dir, "--no-checkout"]);
    const listed = new Set((JSON.parse(readFileSync(join(dir, bundle, "acceptance.json"), "utf8")) as { cases: { id: string }[] }).cases.map((c) => c.id));
    const newer = Object.entries(REQUIRED_CASES).filter(([gate, cases]) => !cases.every((c) => listed.has(`${gate}.${c}`)));
    expect(r.out).toContain("It does not run the tests.");
    for (const gate of Object.keys(REQUIRED_CASES)) expect(lineOf(r.out, `gate ${gate}`)).toMatch(newer.some(([g]) => g === gate) ? /^FAIL / : /^PASS /);
    expect(lineOf(r.out, "bundle.files")).toMatch(/^PASS /);
    expect(lineOf(r.out, "bundle.index")).toMatch(/^PASS /);
    expect(lineOf(r.out, "acceptance.report")).toMatch(/^PASS /);
    expect(lineOf(r.out, "acceptance.cases")).toMatch(newer.length === 0 ? /^PASS / : /^FAIL /);
    expect(r.out).toMatch(newer.length === 0 ? /^VERIFIED: /m : /^NOT VERIFIED: /m);
    expect(r.code).toBe(newer.length === 0 ? 0 : 1);
  });

  it("verifies it under the list it records with --rules bundle, stating which list applied", async () => {
    const dir = await copy();
    const r = await runVerify(["--root", dir, "--no-checkout", "--rules", "bundle"]);
    expect(lineOf(r.out, "acceptance.rules")).toMatch(/^INFO .*judged under the bundle's own recorded list/);
    expect(r.out).not.toMatch(/^FAIL /m);
    const listed = new Set((JSON.parse(readFileSync(join(dir, bundle, "acceptance.json"), "utf8")) as { cases: { id: string }[] }).cases.map((c) => c.id));
    const current = Object.entries(REQUIRED_CASES).flatMap(([g, cs]) => cs.map((c) => `${g}.${c}`));
    expect(r.out).toMatch(new RegExp(`^VERIFIED under the bundle's own required list \\(${String(current.filter((id) => listed.has(id)).length)} of ${String(current.length)} current cases\\): `, "m"));
    expect(r.code).toBe(0);
  });

  it("fails on a single altered byte in any bundle file", async () => {
    const dir = await copy();
    const target = join(dir, bundle, "tests/DEPLOY.candidate.json");
    const bytes = readFileSync(target);
    bytes[10] = (bytes[10] ?? 0) ^ 1;
    writeFileSync(target, bytes);
    const r = await runVerify(["--root", dir, "--no-checkout"]);
    expect(r.code).toBe(1);
    expect(lineOf(r.out, "bundle.files")).toMatch(/^FAIL /);
    expect(r.out).toContain("tests/DEPLOY.candidate.json: sha256");
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
  });
});

describe("verify.mjs on a SYNTHETIC certified repository", () => {
  it("passes every gate, checkout included", async () => {
    const dir = await synthetic();
    const r = await runVerify(["--root", dir]);
    expect(r.out).not.toMatch(/^(FAIL|NOT VERIFIED) /m);
    for (const gate of ["checkout.spec", "checkout.fixtures", "checkout.deploy-candidate", ...Object.keys(REQUIRED_CASES).map((g) => `gate ${g}`)]) expect(lineOf(r.out, gate)).toMatch(/^PASS /);
    expect(lineOf(r.out, "mainnet")).toContain("records no mainnet run");
    expect(r.code).toBe(0);
  });

  it("fails without a file-hash manifest", async () => {
    const dir = await synthetic();
    rmSync(join(dir, SYNTHETIC_BUNDLE, "SHA256SUMS"));
    const r = await runVerify(["--root", dir]);
    expect(r.code).toBe(1);
    expect(lineOf(r.out, "bundle.files")).toContain("SHA256SUMS is missing");
  });

  it("fails on an added, a removed and a renamed bundle file", async () => {
    const dir = await synthetic();
    writeFileSync(join(dir, SYNTHETIC_BUNDLE, "extra.json"), "{}\n");
    rmSync(join(dir, SYNTHETIC_BUNDLE, "page/index.html"));
    const r = await runVerify(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("extra.json is not listed");
    expect(r.out).toContain("page/index.html is listed but missing");
  });

  it("fails when the checkout's SPEC.md differs from the certified one", async () => {
    const dir = await synthetic();
    appendFileSync(join(dir, "SPEC.md"), "edited\n");
    const r = await runVerify(["--root", dir]);
    expect(r.code).toBe(1);
    expect(lineOf(r.out, "checkout.spec")).toMatch(/^FAIL /);
    const skipped = await runVerify(["--root", dir, "--no-checkout"]);
    expect(lineOf(skipped.out, "checkout.spec")).toMatch(/^SKIP /);
    expect(skipped.code).toBe(0);
  });

  it("fails when the deployment candidate's bytes differ", async () => {
    const dir = await synthetic();
    appendFileSync(join(dir, "fixtures/deploy/candidate-synthetic.wasm"), Buffer.from([0]));
    const r = await runVerify(["--root", dir]);
    expect(r.code).toBe(1);
    expect(lineOf(r.out, "checkout.deploy-candidate")).toMatch(/^FAIL /);
    expect(lineOf(r.out, "checkout.fixtures")).toMatch(/^FAIL /);
  });

  // Each edit is re-hashed into SHA256SUMS, so only the semantic check can catch it.
  const semantic: [string, (dir: string) => void, string][] = [
    ["an uncertified report", (d) => { editJson(join(d, SYNTHETIC_BUNDLE, "acceptance.json"), (v) => { v.certified = false; }); }, "acceptance.report"],
    ["a missing required report", (d) => { rmSync(join(d, SYNTHETIC_BUNDLE, "tests/T3.breaker.json")); }, "gate T3"],
    ["a duplicate report", (d) => { writeFileSync(join(d, SYNTHETIC_BUNDLE, "tests/T3.breaker-copy.json"), readFileSync(join(d, SYNTHETIC_BUNDLE, "tests/T3.breaker.json"))); }, "gate T3"],
    ["a failed case", (d) => { editJson(join(d, SYNTHETIC_BUNDLE, "tests/T1.pending-sign.json"), (v) => { v.passed = false; }); }, "gate T1"],
    ["a report from another run", (d) => { editJson(join(d, SYNTHETIC_BUNDLE, "tests/WITHDRAW.both-assets.json"), (v) => { v.run_id = "other"; }); }, "gate WITHDRAW"],
    ["a report bound to other WASM", (d) => { editJson(join(d, SYNTHETIC_BUNDLE, "tests/LIVE.agent-template.json"), (v) => { v.wasm_sha256 = { bounded_mandate: "0".repeat(64) }; }); }, "gate LIVE"],
    ["a required case missing from the report", (d) => { editJson(join(d, SYNTHETIC_BUNDLE, "acceptance.json"), (v) => { v.cases = (v.cases as { id: string }[]).filter((c) => c.id !== "COMPARE.revocation-alternatives"); }); }, "acceptance.cases"],
    ["a superseded index entry", (d) => { editJson(join(d, "evidence/index.json"), (v) => { (v.bundles as { status: string }[]).forEach((b) => { b.status = "superseded"; }); }); }, "bundle.index"],
  ];
  it.each(semantic)("fails on %s", async (_name, edit, gate) => {
    const dir = await synthetic();
    edit(dir);
    expect((await runVerify(["--root", dir, "--write-manifest", SYNTHETIC_BUNDLE])).code).toBe(0);
    const r = await runVerify(["--root", dir, "--bundle", SYNTHETIC_BUNDLE]);
    expect(lineOf(r.out, gate)).toMatch(/^FAIL /);
    expect(r.code).toBe(1);
  });

  it("never passes a case required now that a bundle certified under an earlier list lacks", async () => {
    const dir = await synthetic();
    const [gate, cases] = Object.entries(REQUIRED_CASES).at(-1) ?? ["", []];
    const dropped = cases.map((c) => `${gate}.${c}`);
    editJson(join(dir, SYNTHETIC_BUNDLE, "acceptance.json"), (v) => {
      v.cases = (v.cases as { id: string }[]).filter((c) => !dropped.includes(c.id));
    });
    for (const id of dropped) rmSync(join(dir, SYNTHETIC_BUNDLE, `tests/${id}.json`));
    expect((await runVerify(["--root", dir, "--write-manifest", SYNTHETIC_BUNDLE])).code).toBe(0);

    const strict = await runVerify(["--root", dir]);
    expect(lineOf(strict.out, "acceptance.cases")).toMatch(/^FAIL /);
    expect(strict.out).toContain("certified under an earlier required list");
    expect(lineOf(strict.out, `gate ${gate}`)).toMatch(/^FAIL /);
    expect(strict.code).toBe(1);

    const own = await runVerify(["--root", dir, "--rules", "bundle"]);
    expect(lineOf(own.out, "acceptance.rules")).toContain(`required now but not by this bundle: ${dropped.join(", ")}`);
    expect(lineOf(own.out, `gate ${gate}`)).toMatch(/^SKIP /);
    expect(own.out).not.toMatch(new RegExp(`^PASS +gate ${gate} `, "m"));
    expect(own.code).toBe(0);
  });

  it("under --rules bundle, a gate the current list extends states the cases this bundle lacks", async () => {
    const dir = await synthetic();
    const [gate, cases] = Object.entries(REQUIRED_CASES).find(([, cs]) => cs.length > 1) ?? ["", []];
    const kept = cases.slice(0, 1);
    const dropped = cases.slice(1).map((c) => `${gate}.${c}`);
    editJson(join(dir, SYNTHETIC_BUNDLE, "acceptance.json"), (v) => {
      v.cases = (v.cases as { id: string }[]).filter((c) => !dropped.includes(c.id));
    });
    for (const id of dropped) rmSync(join(dir, SYNTHETIC_BUNDLE, `tests/${id}.json`));
    expect((await runVerify(["--root", dir, "--write-manifest", SYNTHETIC_BUNDLE])).code).toBe(0);
    const total = Object.values(REQUIRED_CASES).flat().length;

    const own = await runVerify(["--root", dir, "--rules", "bundle"]);
    expect(lineOf(own.out, `gate ${gate}`)).toMatch(new RegExp(`^PASS +gate ${gate} {2}1 of 1 under the bundle's list, .*: ${kept.join(", ")}; ${dropped.join(", ")} required now, not in this bundle$`));
    expect(own.out).toMatch(new RegExp(`^VERIFIED under the bundle's own required list \\(${String(total - dropped.length)} of ${String(total)} current cases\\): `, "m"));
    expect(own.code).toBe(0);

    // Default rules: unchanged wording, and the gate fails.
    const strict = await runVerify(["--root", dir]);
    expect(lineOf(strict.out, `gate ${gate}`)).toMatch(/^FAIL /);
    expect(strict.out).not.toContain("required now, not in this bundle");
    expect(strict.out).not.toContain("under the bundle's own required list");
    expect(strict.out).toMatch(/^NOT VERIFIED: /m);
  });

  it("refuses usage errors with exit 2", async () => {
    const dir = await synthetic();
    expect((await runVerify(["--root", dir, "--bogus"])).code).toBe(2);
    expect((await runVerify(["--root", dir, "--bundle", "evidence/nope"])).code).toBe(2);
    renameSync(join(dir, "evidence/index.json"), join(dir, "evidence/index.moved"));
    expect((await runVerify(["--root", dir])).code).toBe(2);
  });
});
