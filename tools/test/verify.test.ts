// verify.mjs offline: the committed bundle, a SYNTHETIC certified repository and negative controls. No network.
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { REQUIRED_CASES, SEPARATE_CASES } from "../src/evidence/required.js";
import { REPO_ROOT, SYNTHETIC_BUNDLE, copyRealRepo, runVerify, syntheticLiveEvidence, syntheticRepo, tempDir } from "./fixtures/verify/synthetic.js";

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
    const covered = current.filter((id) => listed.has(id)).length;
    const lacks = covered === current.length ? "it lacks none of the currently required cases" : `it lacks ${String(current.length - covered)} of the currently required cases`;
    expect(r.out).toMatch(new RegExp(`^VERIFIED under the bundle's own required list \\(${String(covered)} of ${String(current.length)} current cases; ${lacks}\\): `, "m"));
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
    ["a report relabelled to a mode the certifier does not accept", (d) => { editJson(join(d, SYNTHETIC_BUNDLE, "tests/T3.breaker.json"), (v) => { v.mode = "mainnet"; }); }, "gate T3"],
    ["a sandbox report relabelled as unit, which needs no WASM binding", (d) => { editJson(join(d, SYNTHETIC_BUNDLE, "tests/T3.breaker.json"), (v) => { v.mode = "unit"; v.wasm_sha256 = {}; }); }, "gate T3"],
    ["a sandbox report that binds no WASM", (d) => { editJson(join(d, SYNTHETIC_BUNDLE, "tests/T3.breaker.json"), (v) => { v.wasm_sha256 = {}; }); }, "gate T3"],
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

  it("accepts each mode the certifier accepts when acceptance.json records the same one", async () => {
    const dir = await synthetic();
    for (const [id, mode] of [["T3.breaker", "unit-vm"], ["T3.concession", "unit"]] as const) {
      editJson(join(dir, SYNTHETIC_BUNDLE, `tests/${id}.json`), (v) => { v.mode = mode; v.wasm_sha256 = {}; });
      editJson(join(dir, SYNTHETIC_BUNDLE, "acceptance.json"), (v) => { (v.cases as { id: string; mode: string }[]).filter((c) => c.id === id).forEach((c) => { c.mode = mode; }); });
    }
    expect((await runVerify(["--root", dir, "--write-manifest", SYNTHETIC_BUNDLE])).code).toBe(0);
    const r = await runVerify(["--root", dir]);
    expect(lineOf(r.out, "gate T3")).toMatch(/^PASS /);
    expect(r.code).toBe(0);
  });

  it("does not skip a directory named like an ignored file", async () => {
    const dir = await synthetic();
    mkdirSync(join(dir, SYNTHETIC_BUNDLE, ".DS_Store"));
    writeFileSync(join(dir, SYNTHETIC_BUNDLE, ".DS_Store/hidden.json"), "{}\n");
    writeFileSync(join(dir, SYNTHETIC_BUNDLE, "page/.DS_Store"), "ignored regular file\n");
    const r = await runVerify(["--root", dir]);
    expect(lineOf(r.out, "bundle.files")).toMatch(/^FAIL /);
    expect(r.out).toContain(".DS_Store/hidden.json is not listed");
    expect(r.out).not.toContain("page/.DS_Store");
    expect(r.code).toBe(1);
  });

  it.each([["cases"], ["separate"]])("fails with a normal summary on a malformed %s entry", async (list) => {
    const dir = await synthetic();
    editJson(join(dir, SYNTHETIC_BUNDLE, "acceptance.json"), (v) => { (v[list] as unknown[]).push(null); });
    expect((await runVerify(["--root", dir, "--write-manifest", SYNTHETIC_BUNDLE])).code).toBe(0);
    const r = await runVerify(["--root", dir]);
    expect(r.out).not.toContain("TypeError");
    expect(lineOf(r.out, "acceptance.cases")).toMatch(/^FAIL /);
    expect(r.out).toContain(`acceptance.json ${list}[${String(list === "cases" ? Object.values(REQUIRED_CASES).flat().length : Object.values(SEPARATE_CASES).flat().length)}] is null, not a case entry`);
    expect(r.out).toMatch(/^NOT VERIFIED: .* failed, /m);
    expect(r.code).toBe(1);
  });

  it("states what the check does not prove, in the output and in --help", async () => {
    const sentence = "What this does not prove: SHA256SUMS is unsigned, so this check detects accidental or partial change, not a self-consistent rewritten bundle. Trust comes from the commit history and from rerunning `make test`.";
    const dir = await synthetic();
    const r = await runVerify(["--root", dir]);
    expect(r.out.trimEnd().split("\n").at(-2)).toBe(sentence);
    expect(r.out.trimEnd().split("\n").at(-1)).toMatch(/^VERIFIED: /);
    expect((await runVerify(["--help"])).out).toContain(sentence);
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
    expect(own.out).toMatch(new RegExp(`^VERIFIED under the bundle's own required list \\(${String(total - dropped.length)} of ${String(total)} current cases; it lacks ${String(dropped.length)} of the currently required cases\\): `, "m"));
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

describe("verify.mjs on a SYNTHETIC mainnet-run record bundle", () => {
  const RUN_BUNDLE = "evidence/mainnet/attempt-1/5e5e5e5";
  interface IndexEntry {
    path: string;
    revision: string;
    status: string;
    run: string;
    certified_bundle?: string;
    manifest_sha256?: string;
  }
  const bundlesOf = (v: Record<string, unknown>): IndexEntry[] => v.bundles as IndexEntry[];

  /** The synthetic certified repository plus a mainnet-run bundle that copies its run.json, acceptance.json and tests/. */
  const withRunBundle = async (): Promise<string> => {
    const dir = await synthetic();
    for (const part of ["run.json", "acceptance.json", "tests"]) cpSync(join(dir, SYNTHETIC_BUNDLE, part), join(dir, RUN_BUNDLE, part), { recursive: true });
    writeFileSync(join(dir, RUN_BUNDLE, "live-mainnet.json"), `${JSON.stringify(syntheticLiveEvidence(), null, 2)}\n`);
    expect((await runVerify(["--root", dir, "--write-manifest", RUN_BUNDLE])).code).toBe(0);
    const certified = bundlesOf(JSON.parse(readFileSync(join(dir, "evidence/index.json"), "utf8")) as Record<string, unknown>)[0];
    editJson(join(dir, "evidence/index.json"), (v) => {
      bundlesOf(v).push({
        path: RUN_BUNDLE,
        revision: certified?.revision ?? "",
        status: "mainnet-run",
        run: `${RUN_BUNDLE}/run.json`,
        certified_bundle: SYNTHETIC_BUNDLE,
        manifest_sha256: createHash("sha256").update(readFileSync(join(dir, RUN_BUNDLE, "SHA256SUMS"))).digest("hex"),
      });
    });
    return dir;
  };
  const editRunEntry = (dir: string, edit: (e: IndexEntry) => void): void => {
    editJson(join(dir, "evidence/index.json"), (v) => {
      bundlesOf(v).filter((b) => b.path === RUN_BUNDLE).forEach(edit);
    });
  };
  const verifyRun = (dir: string): Promise<{ code: number; out: string }> => runVerify(["--root", dir, "--bundle", RUN_BUNDLE]);

  it("passes bundle.index for a mainnet-run entry bound to the certified bundle of its revision", async () => {
    const dir = await withRunBundle();
    const r = await verifyRun(dir);
    expect(lineOf(r.out, "bundle.index")).toMatch(new RegExp(`^PASS +bundle\\.index {2}${RUN_BUNDLE} is a mainnet run record of revision 5e5e5e5\\w+, bound to the certified bundle ${SYNTHETIC_BUNDLE} \\(run\\.json and acceptance\\.json byte-identical\\)$`));
    expect(lineOf(r.out, "bundle.files")).toMatch(/^PASS /);
    expect(lineOf(r.out, "acceptance.report")).toMatch(/^PASS /);
  });

  it("is never selected by default", async () => {
    const dir = await withRunBundle();
    const r = await runVerify(["--root", dir]);
    expect(r.out).toContain(`Checking the committed evidence bundle ${SYNTHETIC_BUNDLE} `);
    expect(r.out).not.toContain(RUN_BUNDLE);
    expect(r.code).toBe(0);
    // Without a certified entry there is no default, even though a mainnet-run entry exists.
    editJson(join(dir, "evidence/index.json"), (v) => { v.bundles = bundlesOf(v).filter((b) => b.status !== "certified"); });
    const none = await runVerify(["--root", dir]);
    expect(none.out).toContain("lists 0 certified bundles; pass --bundle <path>");
    expect(none.code).toBe(2);
  });

  const failures: [string, (dir: string) => void, string][] = [
    ["no certified_bundle", (d) => { editRunEntry(d, (e) => { delete e.certified_bundle; }); }, `a mainnet-run entry must name its certified_bundle; ${RUN_BUNDLE} names null`],
    ["a certified_bundle without an index entry", (d) => { editRunEntry(d, (e) => { e.certified_bundle = "evidence/nope"; }); }, "certified_bundle evidence/nope has no entry in evidence/index.json"],
    ["a certified_bundle that is not certified", (d) => { editJson(join(d, "evidence/index.json"), (v) => { bundlesOf(v).filter((b) => b.path === SYNTHETIC_BUNDLE).forEach((b) => { b.status = "superseded"; }); }); }, `certified_bundle ${SYNTHETIC_BUNDLE} has status "superseded", not "certified"`],
    ["a certified_bundle naming itself", (d) => { editRunEntry(d, (e) => { e.certified_bundle = RUN_BUNDLE; }); }, `certified_bundle ${RUN_BUNDLE} has status "mainnet-run", not "certified"`],
    ["a certified_bundle of another revision", (d) => { editJson(join(d, "evidence/index.json"), (v) => { bundlesOf(v).filter((b) => b.path === SYNTHETIC_BUNDLE).forEach((b) => { b.revision = "5e5e5e5000000000000000000000000000000000"; }); }); }, `certified_bundle ${SYNTHETIC_BUNDLE} has revision 5e5e5e5000000000000000000000000000000000, not 5e5e5e5`],
    ["run.json bytes that differ from the certified bundle", (d) => { appendFileSync(join(d, RUN_BUNDLE, "run.json"), "\n"); }, `${RUN_BUNDLE}/run.json sha256 `],
    ["acceptance.json bytes that differ from the certified bundle", (d) => { appendFileSync(join(d, RUN_BUNDLE, "acceptance.json"), " "); }, `${RUN_BUNDLE}/acceptance.json sha256 `],
    ["a missing manifest_sha256", (d) => { editRunEntry(d, (e) => { delete e.manifest_sha256; }); }, "index manifest_sha256 null is not 64 lowercase hex characters"],
    ["an uppercase manifest_sha256", (d) => { editRunEntry(d, (e) => { e.manifest_sha256 = "A".repeat(64); }); }, `index manifest_sha256 "${"A".repeat(64)}" is not 64 lowercase hex characters`],
    ["a short manifest_sha256", (d) => { editRunEntry(d, (e) => { e.manifest_sha256 = "a".repeat(63); }); }, "is not 64 lowercase hex characters"],
    ["no live-mainnet.json", (d) => { rmSync(join(d, RUN_BUNDLE, "live-mainnet.json")); }, `a mainnet-run bundle must contain live-mainnet.json; ${RUN_BUNDLE}/live-mainnet.json is missing`],
  ];
  it.each(failures)("fails bundle.index on %s", async (_name, edit, reason) => {
    const dir = await withRunBundle();
    edit(dir);
    expect((await runVerify(["--root", dir, "--write-manifest", RUN_BUNDLE])).code).toBe(0);
    const r = await verifyRun(dir);
    expect(lineOf(r.out, "bundle.index")).toMatch(/^FAIL /);
    expect(r.out).toContain(reason);
    expect(r.out).toMatch(/^NOT VERIFIED: /m);
    expect(r.code).toBe(1);
  });

  it("still fails any other status for a selected bundle", async () => {
    const dir = await withRunBundle();
    editRunEntry(dir, (e) => { e.status = "mainnet"; });
    const r = await verifyRun(dir);
    expect(lineOf(r.out, "bundle.index")).toMatch(/^FAIL /);
    expect(r.out).toContain('index status is "mainnet", not "certified"');
    expect(r.code).toBe(1);
  });
});
