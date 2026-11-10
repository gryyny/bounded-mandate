#!/usr/bin/env node
// Checks a committed evidence bundle without a toolchain: Node 20 or later, built-ins only, no install.
// It checks recorded evidence; it does not run the tests. Offline by default; --mainnet adds read-only public RPC
// reads of the run's recorded transactions. Usage: node verify.mjs --help
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Must equal REQUIRED_CASES / SEPARATE_CASES in tools/src/evidence/required.ts (tools/test/verify.test.ts checks it).
export const REQUIRED_CASES = {
  T1: ["withheld-regrant", "pending-sign", "revoke-during-activation", "failed-removal-retry"],
  T2: ["unit-interleavings", "sandbox-interleavings"],
  T2b: ["disclosed-relay", "callback-failed-after-disclosure"],
  T3: ["concession", "feeds-timing", "breaker"],
  T4: ["dependency-failure", "record-bound", "open-order-limit", "registration-reconcile"],
  T5: ["baseline"],
  BOUNDARY: ["contract", "attacks"],
  MODEL: ["recorded-proposal"],
  DEPLOY: ["candidate"],
  DAO: ["sputnik-owner"],
  AGENT: ["budget-bounds", "rehearsal"],
  HANDOFF: ["import-verified", "import-refusals", "lost-response-resume", "unrecorded-owner-tx"],
  WITHDRAW: ["both-assets", "unregistered-owner", "failed-receipt-retry"],
  LIVE: ["agent-template", "open-challenge"],
  CONSOLE: ["browser-sandbox", "access-controls", "wallet-sandbox"],
  COMPARE: ["revocation-alternatives"],
  SIGNER: ["conformance"],
};
export const SEPARATE_CASES = { RESCUE: ["owner-key"] };

const MANIFEST = "SHA256SUMS";
const LIVE_FILE = "live-mainnet.json";
const DEFAULT_RPC = "https://archival-rpc.mainnet.fastnear.com";
const MAINNET_GENESIS = "EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H";
// Mainnet accounts pinned here, equal to MAINNET in tools/src/live/network.ts. Evidence cannot override them: a mainnet
// record naming another verifier, signer or token contract fails.
const MAINNET_ACCOUNTS = { verifier: "intents.near", signer: "v1.signer" };
const MAINNET_TOKENS = { usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", wnear: "wrap.near" };
// The contract method each step kind of the live runner calls (tools/src/live/main.ts), and the receiver of each method.
const STEP_METHOD = {
  grant: "grant",
  propose: "propose_order",
  refused_proposal: "propose_order",
  fill: "execute_intents",
  relay_withheld: "execute_intents",
  settle: "settle_order",
  revoke: "revoke",
  revoke_external: "revoke",
  reconcile_registration: "reconcile_registration",
  recover: "recover",
  recover_external: "recover",
  withdraw: "ft_withdraw",
  withdraw_external: "ft_withdraw",
  register_storage: "storage_deposit",
};
// Pinned here, not read from the record. Steps that read state and send nothing; the step kinds whose transaction must
// fail on chain (every other transaction step must succeed); the only kinds the runner retries after a failed
// transaction (a failed attempt of any other kind stops the run for good); and the field of a step's assertion with
// which the runner records that a step of that kind legitimately sent nothing.
const READ_STEPS = ["check", "withhold"];
const FAILURE_STEPS = ["refused_proposal", "relay_withheld"];
const RETRIED_STEPS = ["withdraw", "withdraw_external"];
const NOTHING_SENT = { propose: "no_action", fill: "skipped", settle: "skipped", register_storage: "skipped", withdraw: "skipped", withdraw_external: "skipped" };
const MANDATE_METHODS = ["grant", "propose_order", "settle_order", "revoke", "reconcile_registration", "recover"];
const VERIFIER_METHODS = ["execute_intents", "ft_withdraw"];
const MODES = ["sandbox", "unit-vm", "unit"];
const NOT_PROVED = "What this does not prove: SHA256SUMS is unsigned, so this check detects accidental or partial change, not a self-consistent rewritten bundle. Trust comes from the commit history and from rerunning `make test`.";
const IGNORED_NAMES = new Set([".DS_Store"]);
const HEX64 = /^[0-9a-f]{64}$/;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sha256File = (path) => sha256(readFileSync(path));
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const caseIds = (registry) => Object.entries(registry).flatMap(([g, cs]) => cs.map((c) => `${g}.${c}`));

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = "";
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = `1${out}`;
  }
  return out;
}

/** Every file under dir. Only a regular file with an ignored name is left out, never a directory of that name. */
function listFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) return listFiles(path);
    return stat.isFile() && IGNORED_NAMES.has(name) ? [] : [path];
  });
}

/** Lines "<sha256>  <path>" sorted by path, paths relative to the bundle, readable by `shasum -a 256 -c`. */
export function manifestText(bundleDir) {
  const files = listFiles(bundleDir)
    .map((p) => relative(bundleDir, p).split(sep).join("/"))
    .filter((p) => p !== MANIFEST)
    .sort();
  return files.map((p) => `${sha256File(join(bundleDir, p))}  ${p}\n`).join("");
}

class Report {
  constructor(out) {
    this.out = out;
    this.counts = { PASS: 0, FAIL: 0, "NOT VERIFIED": 0, SKIP: 0, INFO: 0 };
  }
  line(status, gate, text, reasons = []) {
    this.counts[status] += 1;
    this.out(`${status.padEnd(12)} ${gate}  ${text}`);
    for (const r of reasons.slice(0, 20)) this.out(`${" ".repeat(13)}- ${r}`);
    if (reasons.length > 20) this.out(`${" ".repeat(13)}- ... ${reasons.length - 20} more`);
  }
  check(gate, problems, okText, failText = "does not match") {
    if (problems.length === 0) this.line("PASS", gate, okText);
    else this.line("FAIL", gate, failText, problems);
    return problems.length === 0;
  }
  get bad() {
    return this.counts.FAIL + this.counts["NOT VERIFIED"];
  }
}

function defaultBundle(root) {
  const index = readJson(join(root, "evidence/index.json"));
  const certified = (Array.isArray(index?.bundles) ? index.bundles : []).filter((b) => isObject(b) && b.status === "certified");
  if (certified.length !== 1) throw new Error(`evidence/index.json lists ${certified.length} certified bundles; pass --bundle <path>`);
  return certified[0].path;
}

function loadJson(path, problems, label) {
  if (!existsSync(path)) {
    problems.push(`${label} is missing`);
    return null;
  }
  try {
    return readJson(path);
  } catch {
    problems.push(`${label} is not valid JSON`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------- offline checks

function checkFiles(r, bundleDir, bundle) {
  const path = join(bundleDir, MANIFEST);
  if (!existsSync(path)) {
    r.line("FAIL", "bundle.files", `${bundle}/${MANIFEST} is missing, so no file of the bundle can be checked`, [`create it with: node verify.mjs --write-manifest ${bundle}`]);
    return;
  }
  const problems = [];
  const listed = new Map();
  for (const [i, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (line === "") continue;
    const m = /^([0-9a-f]{64}) {2}(\S(?:.*\S)?)$/.exec(line);
    if (m === null) {
      problems.push(`${MANIFEST} line ${i + 1} is malformed`);
      continue;
    }
    const [, hash, file] = m;
    if (file.split("/").some((part) => part === ".." || part === "") || file === MANIFEST) problems.push(`${MANIFEST} line ${i + 1} names an invalid path ${file}`);
    else if (listed.has(file)) problems.push(`${file} is listed twice`);
    else listed.set(file, hash);
  }
  const present = listFiles(bundleDir)
    .map((p) => relative(bundleDir, p).split(sep).join("/"))
    .filter((p) => p !== MANIFEST);
  for (const file of present) {
    const hash = listed.get(file);
    if (hash === undefined) problems.push(`${file} is not listed in ${MANIFEST}`);
    else if (sha256File(join(bundleDir, file)) !== hash) problems.push(`${file}: sha256 ${sha256File(join(bundleDir, file))} != listed ${hash}`);
  }
  for (const file of listed.keys()) if (!present.includes(file)) problems.push(`${file} is listed but missing`);
  r.check("bundle.files", problems, `${listed.size} files match ${bundle}/${MANIFEST} (sha256 ${sha256File(path).slice(0, 16)}...)`, "bundle bytes differ from the manifest");
}

/** A gate report found in the bundle's tests/ directory. */
function readReports(testsDir, problems) {
  const reports = [];
  if (!existsSync(testsDir)) {
    problems.push("tests/ is missing");
    return reports;
  }
  for (const file of readdirSync(testsDir).sort()) {
    const stat = statSync(join(testsDir, file));
    if (stat.isFile() && IGNORED_NAMES.has(file)) continue;
    if (!stat.isFile()) {
      problems.push(`tests/${file} is not a regular file`);
      continue;
    }
    let report;
    try {
      report = readJson(join(testsDir, file));
    } catch {
      problems.push(`tests/${file} is not valid JSON`);
      continue;
    }
    if (!isObject(report) || report.schema !== "bounded-mandate/gate-report/2") {
      problems.push(`tests/${file} is not a gate-report/2 report`);
      continue;
    }
    reports.push({ file, report });
  }
  return reports;
}

function reportProblems({ file, report }, run, acc, fixtureStems, statedMode) {
  const out = [];
  const id = `${report.gate}.${report.case}`;
  if (file !== `${id}.json`) out.push(`${file}: file name is not ${id}.json`);
  if (report.passed !== true) out.push(`${id}: the test's own assertions failed (passed=${JSON.stringify(report.passed)})`);
  if (report.run_id !== run.run_id) out.push(`${id}: run_id ${report.run_id} != run ${run.run_id}`);
  if (report.source?.revision !== run.revision) out.push(`${id}: revision ${report.source?.revision} != run ${run.revision}`);
  if (report.source?.dirty !== false) out.push(`${id}: written from a dirty tree`);
  if (report.spec_sha256 !== run.spec_sha256) out.push(`${id}: spec_sha256 differs from the run`);
  if (report.fixture_manifest_sha256 !== run.fixture_manifest_sha256) out.push(`${id}: fixture_manifest_sha256 differs from the run`);
  if (typeof report.command !== "string" || report.command.split(" ").some((a) => a.startsWith("/"))) out.push(`${id}: command records a machine-local path`);
  // The modes the certifier accepts (GateReportV2 in tools/src/evidence/schema.ts); sandbox execution must bind its WASM.
  if (!MODES.includes(report.mode)) out.push(`${id}: mode ${JSON.stringify(report.mode ?? null)} is not one of ${MODES.join(", ")}`);
  if (statedMode !== report.mode) out.push(`${id}: acceptance.json records mode ${JSON.stringify(statedMode ?? null)}, the report says ${JSON.stringify(report.mode ?? null)}`);
  if (!isObject(report.wasm_sha256)) out.push(`${id}: wasm_sha256 is not an object`);
  const wasm = isObject(report.wasm_sha256) ? report.wasm_sha256 : {};
  if (report.mode === "sandbox" && Object.keys(wasm).length === 0) out.push(`${id}: sandbox report binds no WASM hash`);
  for (const [stem, hash] of Object.entries(wasm)) {
    const recorded = acc.hashes?.wasm?.[stem] ?? fixtureStems[stem];
    if (recorded === undefined) out.push(`${id}: wasm ${stem} is not recorded for this run`);
    else if (recorded !== hash) out.push(`${id}: wasm ${stem} ${hash} != recorded ${recorded}`);
  }
  return out;
}

/** The object entries of a list in the evidence; anything else in it is reported by malformed(). */
const entries = (list) => (Array.isArray(list) ? list.filter(isObject) : []);
const malformed = (list, name) => (Array.isArray(list) ? list.flatMap((c, i) => (isObject(c) ? [] : [`${name}[${i}] is ${JSON.stringify(c)}, not a case entry`])) : [`${name} is not a list`]);

/** The bundle's own required list, from the cases its acceptance report lists, grouped by gate. */
function recordedRegistry(acc) {
  const out = {};
  for (const c of entries(acc.cases)) {
    if (typeof c.gate !== "string" || typeof c.case !== "string") continue;
    out[c.gate] = [...new Set([...(out[c.gate] ?? []), c.case])];
  }
  return out;
}

function checkEvidence(r, root, bundleDir, bundle, rules) {
  const problems = [];
  const run = loadJson(join(bundleDir, "run.json"), problems, "run.json");
  const acc = loadJson(join(bundleDir, "acceptance.json"), problems, "acceptance.json");
  const index = loadJson(join(root, "evidence/index.json"), problems, "evidence/index.json");
  if (!isObject(run) || !isObject(acc)) {
    if (problems.length === 0) problems.push("run.json or acceptance.json is not a JSON object");
    r.line("FAIL", "acceptance.report", "cannot be checked", problems);
    return null;
  }

  const entry = (Array.isArray(index?.bundles) ? index.bundles : []).find((b) => isObject(b) && b.path === bundle);
  const indexProblems = [];
  if (entry === undefined) indexProblems.push(`evidence/index.json has no entry for ${bundle}`);
  else {
    if (entry.revision !== run.revision) indexProblems.push(`index revision ${entry.revision} != run.json ${run.revision}`);
    if (entry.run !== `${bundle}/run.json`) indexProblems.push(`index run ${entry.run} != ${bundle}/run.json`);
    if (entry.status !== "certified") indexProblems.push(`index status is ${JSON.stringify(entry.status)}, not "certified"`);
  }
  if (typeof run.revision !== "string" || !run.revision.startsWith(basename(bundle))) indexProblems.push(`directory ${basename(bundle)} is not a prefix of revision ${run.revision}`);
  r.check("bundle.index", indexProblems, `${bundle} is the certified entry for revision ${run.revision}`);

  const accProblems = [];
  if (run.schema !== "bounded-mandate/run/1") accProblems.push(`run.json schema ${JSON.stringify(run.schema)}`);
  if (acc.schema !== "bounded-mandate/acceptance/1") accProblems.push(`acceptance.json schema ${JSON.stringify(acc.schema)}`);
  if (acc.certified !== true) accProblems.push("not certified");
  if (acc.complete !== true) accProblems.push("not complete");
  if (acc.dirty !== false || run.dirty !== false) accProblems.push("recorded from a dirty tree");
  if (!Array.isArray(acc.problems) || acc.problems.length > 0) accProblems.push(`records problems: ${JSON.stringify(acc.problems)}`);
  if (acc.run_id !== run.run_id) accProblems.push(`run_id ${acc.run_id} != run.json ${run.run_id}`);
  if (acc.revision !== run.revision) accProblems.push(`revision ${acc.revision} != run.json ${run.revision}`);
  if (acc.hashes?.spec_sha256 !== run.spec_sha256 || !HEX64.test(String(run.spec_sha256))) accProblems.push("spec_sha256 differs from run.json or is malformed");
  if (acc.hashes?.fixture_manifest_sha256 !== run.fixture_manifest_sha256 || !HEX64.test(String(run.fixture_manifest_sha256))) accProblems.push("fixture_manifest_sha256 differs from run.json or is malformed");
  r.check("acceptance.report", accProblems, `certified and complete: run ${run.run_id}, revision ${run.revision}, clean tree`);

  // Re-evaluate every case from the bundled gate reports rather than trusting the report's own statuses.
  const reportsProblems = [];
  const reports = readReports(join(bundleDir, "tests"), reportsProblems);
  const fixtureStems = Object.fromEntries(Object.entries(acc.hashes?.fixtures ?? {}).map(([f, h]) => [basename(f).replace(/\.[^.]+$/, ""), h]));
  const byId = new Map();
  for (const found of reports) {
    const id = `${found.report.gate}.${found.report.case}`;
    byId.set(id, [...(byId.get(id) ?? []), found]);
  }
  // Default: the checkout's current required list. --rules bundle: the list the bundle records it was certified under,
  // stated as such; a case required now but not then is never shown as passed.
  const recorded = recordedRegistry(acc);
  const registry = rules === "bundle" ? recorded : REQUIRED_CASES;
  const required = caseIds(registry);
  const current = caseIds(REQUIRED_CASES);
  const known = new Set([...required, ...current, ...caseIds(SEPARATE_CASES)]);
  for (const id of byId.keys()) if (!known.has(id)) reportsProblems.push(`tests/ holds a report for unknown case ${id}`);
  const statusOf = new Map(entries(acc.cases).map((c) => [c.id, c]));
  const listedIds = entries(acc.cases).map((c) => c.id);
  const missingFromAcc = required.filter((id) => !listedIds.includes(id));
  const extraInAcc = listedIds.filter((id) => !required.includes(id));
  const dupInAcc = listedIds.filter((id, i) => listedIds.indexOf(id) !== i);
  const notNow = caseIds(recorded).filter((id) => !current.includes(id));
  const earlier = missingFromAcc.length > 0 && extraInAcc.length === 0 && dupInAcc.length === 0 && rules === "current";
  const listProblems = [
    ...malformed(acc.cases, "acceptance.json cases"),
    ...malformed(acc.separate ?? [], "acceptance.json separate"),
    ...(required.length === 0 ? ["no required case to judge: the report lists none"] : []),
    ...(earlier ? [`certified under an earlier required list: it lists ${listedIds.length} cases, the current list has ${current.length}; judge it under its own list with --rules bundle`] : []),
    ...missingFromAcc.map((id) => `acceptance.json does not list required case ${id}`),
    ...extraInAcc.map((id) => `acceptance.json lists ${id}, which is not a required case`),
    ...dupInAcc.map((id) => `acceptance.json lists ${id} twice`),
  ];
  if (rules === "bundle") {
    const behind = current.filter((id) => !required.includes(id));
    r.line("INFO", "acceptance.rules", `judged under the bundle's own recorded list of ${required.length} cases, not the checkout's current ${current.length}${behind.length > 0 ? `; required now but not by this bundle: ${behind.join(", ")}` : ""}${notNow.length > 0 ? `; recorded but no longer required: ${notNow.join(", ")}` : ""}`);
  }
  r.check("acceptance.cases", [...listProblems, ...reportsProblems], `the report lists exactly the ${required.length} required cases${rules === "bundle" ? " it records" : ""}`);

  const caseLines = (registry, label, statusList) => {
    if (label === "gate" && rules === "bundle") {
      for (const gate of Object.keys(REQUIRED_CASES).filter((g) => !(g in registry))) r.line("SKIP", `gate ${gate}`, "required by the current list, not by the list this bundle was certified under (--rules bundle)");
    }
    for (const [gate, names] of Object.entries(registry)) {
      const problems = [];
      for (const name of names) {
        const id = `${gate}.${name}`;
        const found = byId.get(id) ?? [];
        if (found.length === 0) problems.push(`${id}: no report in tests/`);
        else if (found.length > 1) problems.push(`${id}: ${found.length} reports (${found.map((f) => f.file).join(", ")})`);
        const stated = statusList.get(id);
        if (found.length === 1) problems.push(...reportProblems(found[0], run, acc, fixtureStems, stated?.mode));
        if (stated?.status !== "passed") problems.push(`${id}: acceptance.json states ${JSON.stringify(stated?.status ?? "nothing")}`);
      }
      // Under --rules bundle a gate the current list extends must not read as fully covered.
      const later = label === "gate" && rules === "bundle" ? (REQUIRED_CASES[gate] ?? []).filter((c) => !names.includes(c)).map((c) => `${gate}.${c}`) : [];
      const note = later.length > 0 ? `; ${later.join(", ")} required now, not in this bundle` : "";
      const under = later.length > 0 ? " under the bundle's list," : "";
      r.check(`${label} ${gate}`, problems, `${names.length} of ${names.length}${under} present once, passed, bound to run ${run.run_id}: ${names.join(", ")}${note}`, `does not match${note}`);
    }
  };
  caseLines(registry, "gate", statusOf);
  caseLines(SEPARATE_CASES, "separate", new Map(entries(acc.separate).map((c) => [c.id, c])));
  return { run, acc, byId, coverage: { covered: current.filter((id) => required.includes(id)).length, current: current.length } };
}

function checkCheckout(r, root, ev, skip) {
  const gates = ["checkout.spec", "checkout.fixtures", "checkout.deploy-candidate"];
  if (skip) {
    for (const g of gates) r.line("SKIP", g, "not checked (--no-checkout): this checkout is not compared with the bundle");
    return null;
  }
  if (ev === null) {
    for (const g of gates) r.line("FAIL", g, "not checked: the bundle's run record is unreadable");
    return null;
  }
  const { run, acc, byId } = ev;
  const specPath = join(root, "SPEC.md");
  const spec = existsSync(specPath) ? sha256File(specPath) : null;
  r.check("checkout.spec", spec === run.spec_sha256 ? [] : [`SPEC.md sha256 ${spec ?? "(missing)"} != certified ${run.spec_sha256}`], `SPEC.md sha256 ${spec} equals the certified run's`, "this checkout's SPEC.md is not the one the bundle was certified against");

  const fixProblems = [];
  const manifestPath = join(root, "fixtures/manifest.json");
  const manifestHash = existsSync(manifestPath) ? sha256File(manifestPath) : null;
  if (manifestHash !== run.fixture_manifest_sha256) fixProblems.push(`fixtures/manifest.json sha256 ${manifestHash ?? "(missing)"} != certified ${run.fixture_manifest_sha256}`);
  const recorded = isObject(acc.hashes?.fixtures) ? acc.hashes.fixtures : {};
  let manifest = { files: {} };
  try {
    if (manifestHash !== null) manifest = readJson(manifestPath);
  } catch {
    fixProblems.push("fixtures/manifest.json is not valid JSON");
  }
  if (!isObject(manifest) || !isObject(manifest.files)) manifest = { files: {} };
  for (const [file, hash] of Object.entries(recorded)) {
    const path = join(root, "fixtures", file);
    const actual = existsSync(path) ? sha256File(path) : null;
    if (actual !== hash) fixProblems.push(`fixtures/${file}: sha256 ${actual ?? "(missing)"} != certified ${hash}`);
    if (manifest.files?.[file]?.sha256 !== hash) fixProblems.push(`fixtures/manifest.json records ${manifest.files?.[file]?.sha256 ?? "nothing"} for ${file}`);
  }
  for (const file of Object.keys(manifest.files ?? {})) if (!(file in recorded)) fixProblems.push(`fixtures/${file} is in this checkout but not in the certified run`);
  r.check("checkout.fixtures", fixProblems, `fixtures/manifest.json and ${Object.keys(recorded).length} fixture files equal the certified run's`, "this checkout's fixtures are not the ones the bundle was certified against");

  // The deployment candidate is a committed fixture, so its hash is recomputable here; locally built WASM is not.
  const candProblems = [];
  const candidates = Object.entries(manifest.files ?? {}).filter(([, e]) => e?.kind === "deployment-candidate");
  if (candidates.length !== 1) candProblems.push(`fixtures/manifest.json lists ${candidates.length} deployment candidates, expected 1`);
  let candidateText = "";
  let candidate = null;
  for (const [file, entry] of candidates) {
    const path = join(root, "fixtures", file);
    if (!existsSync(path)) {
      candProblems.push(`fixtures/${file} is missing`);
      continue;
    }
    const bytes = readFileSync(path);
    const hash = sha256(bytes);
    const codeHash = base58(createHash("sha256").update(bytes).digest());
    const stem = basename(file).replace(/\.[^.]+$/, "");
    if (hash !== entry.sha256) candProblems.push(`fixtures/${file}: sha256 ${hash} != manifest ${entry.sha256}`);
    if (recorded[file] !== hash) candProblems.push(`fixtures/${file}: sha256 ${hash} != certified ${recorded[file] ?? "(not recorded)"}`);
    const deploy = byId.get("DEPLOY.candidate")?.[0]?.report;
    if (deploy === undefined) candProblems.push("no DEPLOY.candidate report binds the candidate");
    else {
      if (deploy.wasm_sha256?.[stem] !== hash) candProblems.push(`DEPLOY.candidate ran ${stem} ${deploy.wasm_sha256?.[stem] ?? "(none)"}, not ${hash}`);
      if (deploy.data?.candidate_sha256 !== undefined && deploy.data.candidate_sha256 !== hash) candProblems.push(`DEPLOY.candidate records candidate_sha256 ${deploy.data.candidate_sha256}`);
      if (deploy.data?.deployed_code_hash !== undefined && deploy.data.deployed_code_hash !== codeHash) candProblems.push(`DEPLOY.candidate records code hash ${deploy.data.deployed_code_hash}, the file's is ${codeHash}`);
    }
    candidate = { file, sha256: hash, codeHash };
    candidateText = `fixtures/${file} sha256 ${hash}, NEAR code hash ${codeHash}, deployed in sandbox by DEPLOY.candidate`;
  }
  const candidateOk = r.check("checkout.deploy-candidate", candProblems, candidateText, "the deployment candidate does not match");

  const built = Object.keys(acc.hashes?.wasm ?? {});
  r.line("INFO", "wasm.local-builds", `not recomputed: ${built.join(", ")} were built by the run with the Rust toolchain; reports are checked only for consistency with those recorded hashes`);
  // The deployment candidate of this checkout, for the mainnet code-hash checks; null when it does not match.
  return candidateOk ? candidate : null;
}

// ---------------------------------------------------------------------------------------------- mainnet checks

class Rpc {
  constructor(url, timeoutMs) {
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
  /** Returns { ok, result } or { ok: false, error }; never throws. */
  async call(method, params) {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "verify", method, params }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const body = await res.json();
      if (!isObject(body)) return { ok: false, error: "response is not a JSON-RPC object" };
      if (body.error !== undefined && body.error !== null) return { ok: false, error: JSON.stringify(body.error).slice(0, 300) };
      if (body.result === undefined || body.result === null) return { ok: false, error: "response has no result" };
      return { ok: true, result: body.result };
    } catch (e) {
      const name = e?.name === "TimeoutError" ? `timed out after ${this.timeoutMs} ms` : `request failed: ${e?.cause?.code ?? e?.message ?? String(e)}`;
      return { ok: false, error: name };
    }
  }
  async view(account, method, args, block) {
    const at = block === "final" ? { finality: "final" } : { block_id: block };
    const r = await this.call("query", { request_type: "call_function", account_id: account, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString("base64"), ...at });
    if (!r.ok) return r;
    try {
      return { ok: true, value: JSON.parse(Buffer.from(r.result.result).toString("utf8")) };
    } catch {
      return { ok: false, error: `${method} returned no JSON result` };
    }
  }
  async codeHash(account, block) {
    const at = block === "final" ? { finality: "final" } : { block_id: block };
    const r = await this.call("query", { request_type: "view_account", account_id: account, ...at });
    if (!r.ok) return r;
    return typeof r.result.code_hash === "string" ? { ok: true, value: r.result.code_hash } : { ok: false, error: "view_account returned no code_hash" };
  }
  async height(blockHash) {
    const r = await this.call("block", { block_id: blockHash });
    const h = r.ok ? r.result?.header?.height : undefined;
    return typeof h === "number" ? { ok: true, value: h } : { ok: false, error: r.ok ? "block has no height" : r.error };
  }
}

const statusKind = (s) => (!isObject(s) ? "unknown" : "Failure" in s ? "failure" : "SuccessValue" in s || "SuccessReceiptId" in s ? "success" : "unknown");

/** The chain's transaction as toEvidenceReceipt (tools/src/near/client.ts) would record it. */
function chainView(tx) {
  const all = [tx.transaction_outcome, ...(Array.isArray(tx.receipts_outcome) ? tx.receipts_outcome : [])].filter(isObject);
  const receipts = all.map((o) => {
    const kind = statusKind(o.outcome?.status);
    const logs = Array.isArray(o.outcome?.logs) ? o.outcome.logs.filter((l) => typeof l === "string") : [];
    return { id: o.id, executor_id: o.outcome?.executor_id, block_hash: o.block_hash, kind, error: kind === "failure" ? JSON.stringify(o.outcome.status.Failure) : null, logs };
  });
  const top = statusKind(tx.status);
  const outcome = top === "unknown" || receipts.some((x) => x.kind === "unknown") ? "unknown" : top === "success" && !receipts.some((x) => x.kind === "failure") ? "success" : "failure";
  const call = (tx.transaction?.actions ?? []).map((a) => a?.FunctionCall).find(isObject);
  let args = null;
  try {
    args = JSON.parse(Buffer.from(String(call?.args), "base64").toString("utf8"));
  } catch {
    // Not JSON arguments: nothing is read from them.
  }
  return { receipts, outcome, method: call?.method_name ?? null, args: isObject(args) ? args : {}, t: tx.transaction ?? {} };
}

/** The orders the mandate signed in a transaction: the `multi_payload` of each order_signed event it logged there. */
function signedOrders(v, mandate) {
  const out = [];
  for (const x of v.receipts.filter((y) => y.executor_id === mandate && y.kind === "success")) {
    for (const log of x.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(log.slice("EVENT_JSON:".length));
        if (e?.standard !== "bounded_mandate" || e?.event !== "order_signed") continue;
        const mp = typeof e.data?.multi_payload === "string" ? JSON.parse(e.data.multi_payload) : e.data?.multi_payload;
        if (isObject(mp) && isObject(mp.payload)) out.push(mp);
      } catch {
        // Not an event of the mandate: nothing is read from it.
      }
    }
  }
  return out;
}

const messageOf = (entry) => {
  try {
    const m = JSON.parse(entry?.payload?.message);
    return isObject(m) ? m : null;
  } catch {
    return null;
  }
};

const sameSigned = (a, b) =>
  a.standard === b.standard && a.public_key === b.public_key && a.signature === b.signature && a.payload.message === b.payload.message && a.payload.nonce === b.payload.nonce && a.payload.recipient === b.payload.recipient;

/**
 * Whether a fill executed the mandate's proposed order, from the chain's own transactions (RPC `tx` results): the
 * bundle passed to execute_intents carries exactly one payload signed for the mandate, that payload is, field for
 * field, one the mandate logged as signed (order_signed) in one of the successful proposal transactions, and it is one
 * token_diff that sells a nonzero amount of one of `tokenIds` for a nonzero amount of the other. An empty bundle or a
 * bundle of other accounts' intents has no such payload. Returns the problems and, without any, the order's trade.
 */
export function fillBinding(fillTx, proposalTxs, mandate, verifier, tokenIds) {
  const signed = chainView(fillTx).args.signed;
  if (!Array.isArray(signed) || signed.length === 0) return { problems: ["the execute_intents call carries no signed intents (an empty bundle executes nothing)"], trade: null };
  const mine = signed.filter((e) => isObject(e) && isObject(e.payload) && messageOf(e)?.signer_id === mandate);
  if (mine.length !== 1) return { problems: [`the bundle of ${signed.length} signed intents carries ${mine.length} signed for ${mandate}, expected exactly one`], trade: null };
  const [entry] = mine;
  const p = [];
  const proposed = proposalTxs.flatMap((tx) => signedOrders(chainView(tx), mandate));
  if (!proposed.some((o) => sameSigned(o, entry))) p.push(`the bundle's payload for ${mandate} is not an order the mandate logged as signed in a successful proposal transaction of the run (${proposed.length} such orders)`);
  if (entry.standard !== "nep413") p.push(`the payload's standard is ${JSON.stringify(entry.standard ?? null)}, expected nep413`);
  if (entry.payload.recipient !== verifier) p.push(`the payload's recipient is ${JSON.stringify(entry.payload.recipient ?? null)}, not ${verifier}`);
  const intents = messageOf(entry).intents;
  const diff = Array.isArray(intents) && intents.length === 1 && intents[0]?.intent === "token_diff" && isObject(intents[0].diff) ? intents[0].diff : null;
  const deltas = diff === null ? [] : Object.entries(diff);
  let trade = null;
  if (diff === null) p.push("the payload is not exactly one token_diff intent");
  else if (deltas.length !== 2 || deltas.some(([token, d]) => !tokenIds.includes(token) || typeof d !== "string" || !/^-?[0-9]+$/.test(d))) p.push(`the token_diff is not over exactly the two tokens ${tokenIds.join(" and ")}`);
  else {
    const sell = deltas.find(([, d]) => BigInt(d) < 0n);
    const buy = deltas.find(([, d]) => BigInt(d) > 0n);
    if (sell === undefined || buy === undefined) p.push("the token_diff does not sell a nonzero amount of one token for a nonzero amount of the other");
    else trade = { nonce: entry.payload.nonce, publicKey: entry.public_key, diff: Object.fromEntries(deltas.map(([token, d]) => [token, BigInt(d)])) };
  }
  return { problems: p, trade: p.length === 0 ? trade : null };
}

const stepOf = (id) => {
  const m = /^step-(\d+)-.*?(?:-attempt-(\d+))?$/.exec(id);
  return m === null ? null : [Number(m[1]), Number(m[2] ?? 1)];
};

/** The last recorded end balances, in step order: mandate and owner Intents balances, owner token balances. */
function expectedBalances(assertions) {
  const steps = assertions
    .map((a) => ({ a, k: stepOf(a.id) }))
    .filter((x) => x.k !== null && isObject(x.a.observed))
    .sort((x, y) => x.k[0] - y.k[0] || x.k[1] - y.k[1])
    .map((x) => x.a);
  const out = { mandate: null, ownerIntents: null, ownerTokens: {}, tokens: {} };
  for (const a of steps) {
    const o = a.observed;
    if (isObject(o.mandate_after)) out.mandate = o.mandate_after;
    if (isObject(o.owner_after)) out.ownerIntents = o.owner_after;
    if (isObject(o.intents_after)) out.ownerIntents = o.intents_after;
    if (typeof o.asset === "string" && typeof o.token === "string") out.tokens[o.asset] = o.token;
    if (typeof o.asset === "string" && typeof o.token_after === "string") out.ownerTokens[o.asset] = o.token_after;
  }
  return out;
}

/**
 * The step kind a receipt label of the live runner names ("step 3 revoke", "import step 3 revoke_external",
 * "reconcile revoke", "reconcile import revoke_external").
 */
const kindOf = (label) => /(?:^|\s)(?:step \d+|reconcile|reconcile import) ([a-z_]+)$/.exec(String(label))?.[1] ?? null;

/** The 1-based manifest step a receipt belongs to, from its label or its detail; null when the runner recorded none (a reconciled transaction). */
function stepNumberOf(rc) {
  const m = /(?:^|\s)step (\d+) [a-z_]+$/.exec(String(rc.label));
  if (m !== null) return Number(m[1]);
  return Number.isInteger(rc.detail?.step) ? rc.detail.step : null;
}

/**
 * The record against the manifest's step list (environment.manifest_steps, element i is step i+1), without the network:
 * every listed step has a passed latest-attempt assertion, and every transaction step has its transaction among the
 * receipts unless its assertion records that nothing was sent (only for the kinds in NOTHING_SENT).
 */
function manifestBinding(live, receipts, assertions, latest) {
  const raw = live.environment?.manifest_steps;
  if (typeof raw !== "string" || raw === "") return { problems: ["environment.manifest_steps is missing, so the record cannot be shown to cover the manifest's steps"], text: "" };
  const steps = raw.split(",");
  const p = [];
  steps.forEach((kind, i) => {
    if (!(kind in STEP_METHOD) && !READ_STEPS.includes(kind)) p.push(`manifest step ${i + 1} is ${JSON.stringify(kind)}, not a step kind of the live runner`);
  });
  const numbered = new Set();
  const unnumbered = {};
  for (const rc of receipts) {
    const kind = kindOf(rc.label);
    const n = stepNumberOf(rc);
    if (kind === null) p.push(`receipt ${JSON.stringify(rc.label)} names no step kind`);
    else if (Number.isInteger(rc.detail?.step) && rc.detail.step !== n) p.push(`receipt ${JSON.stringify(rc.label)} records step ${rc.detail.step} in its detail`);
    else if (n === null && !steps.includes(kind)) p.push(`receipt ${JSON.stringify(rc.label)}: the manifest lists no ${kind} step`);
    else if (n === null) unnumbered[kind] = (unnumbered[kind] ?? 0) + 1;
    else if (steps[n - 1] !== kind) p.push(`receipt ${JSON.stringify(rc.label)}: the manifest's step ${n} is ${steps[n - 1] ?? "not listed"}`);
    else numbered.add(n);
  }
  for (const a of assertions) {
    const m = /^step-(\d+)-([a-z_]+)(?:-attempt-\d+)?$/.exec(String(a.id));
    if (m !== null && steps[Number(m[1]) - 1] !== m[2]) p.push(`assertion ${a.id}: the manifest's step ${m[1]} is ${steps[Number(m[1]) - 1] ?? "not listed"}`);
  }
  const idle = [];
  const need = {};
  steps.forEach((kind, i) => {
    const name = `step ${i + 1} ${kind}`;
    const got = latest.get(`step-${i + 1}-${kind}`)?.a;
    if (got === undefined) p.push(`${name}: the record has no assertion for this manifest step`);
    else if (got.passed !== true) p.push(`${name}: its latest attempt ${got.id} passed ${JSON.stringify(got.passed ?? null)}`);
    if (!(kind in STEP_METHOD) || numbered.has(i + 1)) return;
    if (got?.passed === true && kind in NOTHING_SENT && got.observed?.[NOTHING_SENT[kind]] === true) idle.push(name);
    else need[kind] = [...(need[kind] ?? []), name];
  });
  // A reconciled transaction carries its kind but no step number: it can stand for one step of that kind.
  for (const [kind, names] of Object.entries(need)) {
    const lacking = names.length - (unnumbered[kind] ?? 0);
    if (lacking > 0) p.push(`${names.join(", ")}: ${lacking} of ${names.length} without a transaction among the receipts`);
  }
  const sent = steps.filter((k) => k in STEP_METHOD).length - idle.length;
  const text = `environment.manifest_steps lists ${steps.length} steps (${steps.join(", ")}): each has a passed latest-attempt assertion and ${sent} transaction steps have their transaction among the receipts${idle.length > 0 ? `; recorded as sending nothing: ${idle.join(", ")}` : ""}`;
  return { problems: p, text };
}

/** Each assertion's latest attempt, keyed by its id without the `-attempt-N` suffix. */
function latestAttempts(assertions) {
  const latest = new Map();
  for (const a of assertions) {
    const id = String(a.id);
    const m = /^(.*)-attempt-(\d+)$/.exec(id);
    const [base, attempt] = m === null ? [id, 1] : [m[1], Number(m[2])];
    if (!latest.has(base) || latest.get(base).attempt <= attempt) latest.set(base, { a, attempt });
  }
  return latest;
}

/**
 * The mainnet.manifest check on one evidence object, whatever its mode: the problems that keep the record from
 * covering its manifest's steps. The live runner's sandbox tests apply it to real runner output.
 */
export function manifestCoverageProblems(live) {
  const receipts = Array.isArray(live?.receipts) ? live.receipts.filter(isObject) : [];
  const assertions = Array.isArray(live?.assertions) ? live.assertions.filter(isObject) : [];
  return manifestBinding(live, receipts, assertions, latestAttempts(assertions)).problems;
}

/** Problems with where a transaction went, judged from the chain's own receiver and method and the pinned accounts. */
function targetProblems(label, v, mandate) {
  const p = [];
  const actions = Array.isArray(v.t.actions) ? v.t.actions : [];
  if (actions.length !== 1 || v.method === null) p.push(`carries ${actions.length} actions, expected one function call`);
  const kind = kindOf(label);
  if (kind !== null && !(kind in STEP_METHOD)) p.push(`step kind ${kind} is not a transaction step of the live runner`);
  else if (kind !== null && v.method !== STEP_METHOD[kind]) p.push(`a ${kind} step calls ${STEP_METHOD[kind]}, the chain shows ${v.method}`);
  const receivers = MANDATE_METHODS.includes(v.method) ? [mandate] : VERIFIER_METHODS.includes(v.method) ? [MAINNET_ACCOUNTS.verifier] : v.method === "storage_deposit" ? Object.values(MAINNET_TOKENS) : null;
  if (receivers === null) p.push(`method ${v.method} is not one the live runner calls`);
  else if (!receivers.includes(v.t.receiver_id)) p.push(`${v.method} must be called on ${receivers.join(" or ")}, the chain shows receiver ${v.t.receiver_id}`);
  return p;
}

/**
 * The recorded mainnet run, judged without the network: the file's place in the hashed bundle, the pinned accounts,
 * its source binding and its own verdict. Returns null when there is nothing a chain read could be compared with.
 */
function checkRecordedRun(r, bundleDir, bundle, livePath, ev, candidate, mainnet) {
  const own = join(bundleDir, LIVE_FILE);
  const path = livePath ?? own;
  const shown = livePath ?? `${bundle}/${LIVE_FILE}`;
  if (!existsSync(path)) return null;
  if (resolve(path) !== resolve(own)) r.line("NOT VERIFIED", "mainnet.evidence-file", `${shown} is not ${bundle}/${LIVE_FILE}: it is outside the hashed bundle, so its bytes are bound to nothing. Its checks below are informative only.`);
  let live;
  try {
    live = readJson(path);
  } catch {
    r.line("FAIL", "mainnet.evidence", `${shown} is not valid JSON`);
    return { usable: false };
  }
  if (!isObject(live)) {
    r.line("FAIL", "mainnet.evidence", `${shown} is not a JSON object`);
    return { usable: false };
  }
  const receipts = Array.isArray(live.receipts) ? live.receipts.filter(isObject) : [];
  const assertions = Array.isArray(live.assertions) ? live.assertions.filter(isObject) : [];
  const ids = isObject(live.identifiers) ? live.identifiers : {};
  const evProblems = [];
  if (live.mode !== "mainnet") evProblems.push(`evidence mode is ${JSON.stringify(live.mode)}, not "mainnet"`);
  if (live.environment?.chain_id !== "mainnet") evProblems.push(`evidence chain id is ${JSON.stringify(live.environment?.chain_id)}, not "mainnet"`);
  if (receipts.length === 0) evProblems.push("evidence has no receipts");
  if (Array.isArray(live.receipts) && receipts.length !== live.receipts.length) evProblems.push("a receipt entry is not an object");
  if (Array.isArray(live.assertions) && assertions.length !== live.assertions.length) evProblems.push("an assertion entry is not an object");
  for (const rc of receipts) {
    if (typeof rc.tx_hash !== "string" || typeof rc.detail?.signer_id !== "string") evProblems.push(`receipt ${JSON.stringify(rc.label)} has no transaction hash or signer`);
  }
  if (typeof ids.mandate !== "string") evProblems.push("evidence names no mandate account");
  let usable = r.check("mainnet.evidence", evProblems, `${receipts.length} receipts recorded in mode mainnet (${shown})`, "not mainnet evidence");
  if (!usable) return { usable };

  // Pinned accounts: the evidence may not choose the verifier, the signer or a token contract.
  const pinProblems = [];
  for (const [role, pinned] of Object.entries(MAINNET_ACCOUNTS)) if (ids[role] !== pinned) pinProblems.push(`evidence names ${role} ${JSON.stringify(ids[role] ?? null)}; on mainnet it is ${pinned}`);
  const exp = expectedBalances(assertions);
  for (const [asset, token] of Object.entries(exp.tokens)) {
    if (!(asset in MAINNET_TOKENS)) pinProblems.push(`evidence names an unknown asset ${asset}`);
    else if (token !== MAINNET_TOKENS[asset]) pinProblems.push(`evidence names token ${token} for ${asset}; on mainnet it is ${MAINNET_TOKENS[asset]}`);
  }
  for (const side of [exp.mandate, exp.ownerIntents, exp.ownerTokens]) for (const asset of Object.keys(side ?? {})) if (!(asset in MAINNET_TOKENS)) pinProblems.push(`evidence records a balance of an unknown asset ${asset}`);
  usable = r.check("mainnet.pinned", [...new Set(pinProblems)], `verifier ${MAINNET_ACCOUNTS.verifier}, signer ${MAINNET_ACCOUNTS.signer}, USDC ${MAINNET_TOKENS.usdc} and wNEAR ${MAINNET_TOKENS.wnear} are the constants pinned in this script`, "the evidence names accounts other than the pinned mainnet ones; nothing on chain is read");

  // Source binding: the run was made from the bundle's revision and names the deployment candidate.
  const src = isObject(live.source) ? live.source : {};
  if (ev === null) r.line("FAIL", "mainnet.source", "not checked: the bundle's run record is unreadable");
  else {
    const p = [];
    if (src.product_commit !== ev.run.revision) p.push(`source.product_commit ${JSON.stringify(src.product_commit ?? null)} != bundle revision ${ev.run.revision}`);
    if (src.dirty !== false) p.push("recorded from a dirty tree");
    if (src.spec_sha256 !== ev.run.spec_sha256) p.push(`source.spec_sha256 ${JSON.stringify(src.spec_sha256 ?? null)} != the certified run's ${ev.run.spec_sha256}`);
    if (src.fixture_manifest_sha256 !== undefined && src.fixture_manifest_sha256 !== ev.run.fixture_manifest_sha256) p.push(`source.fixture_manifest_sha256 ${JSON.stringify(src.fixture_manifest_sha256)} != the certified run's ${ev.run.fixture_manifest_sha256}`);
    r.check("mainnet.source", p, `recorded at the bundle's revision ${ev.run.revision}, clean tree, same SPEC.md hash`, "the mainnet run is not bound to this bundle");
  }
  // The live runner writes the mandate's NEAR code hash into source.contract_wasm_sha256; a hex sha256 is accepted too.
  if (candidate === null) r.line(mainnet ? "NOT VERIFIED" : "SKIP", "mainnet.candidate", "the recorded mandate code hash is not compared with the deployment candidate: this checkout's candidate was not read (--no-checkout or a failed checkout check)");
  else {
    const p = [];
    const named = src.contract_wasm_sha256;
    if (named !== candidate.sha256 && named !== candidate.codeHash) p.push(`source.contract_wasm_sha256 ${JSON.stringify(named ?? null)} is neither the candidate's sha256 ${candidate.sha256} nor its code hash ${candidate.codeHash}`);
    if (ids.mandate_code_hash !== undefined && ids.mandate_code_hash !== candidate.codeHash) p.push(`identifiers.mandate_code_hash ${JSON.stringify(ids.mandate_code_hash)} != the candidate's code hash ${candidate.codeHash}`);
    r.check("mainnet.candidate", p, `the run records the deployment candidate fixtures/${candidate.file} (code hash ${candidate.codeHash})`, "the run does not record this checkout's deployment candidate");
  }

  // The run's own record of completion. A failure the evidence itself states is a FAIL, not NOT VERIFIED: the record
  // already says the run did not succeed. Only the latest attempt of a step counts, since a retried attempt
  // (`-attempt-N`) supersedes the one before it; the same id twice is ambiguous and fails.
  const runProblems = [];
  if (!Array.isArray(live.unknowns)) runProblems.push("evidence has no unknowns list");
  else for (const u of live.unknowns) runProblems.push(`unknown: ${typeof u === "string" ? u : JSON.stringify(u)}`);
  if (assertions.length === 0) runProblems.push("evidence has no assertions");
  const idList = assertions.map((a) => String(a.id));
  for (const id of new Set(idList.filter((id, i) => idList.indexOf(id) !== i))) runProblems.push(`assertion id ${id} appears ${idList.filter((x) => x === id).length} times`);
  const latest = latestAttempts(assertions);
  for (const { a } of latest.values()) if (a.passed !== true) runProblems.push(`assertion ${a.id} passed ${JSON.stringify(a.passed ?? null)}: ${a.description ?? ""}`);
  const complete = r.check("mainnet.run", runProblems, `the run records no unknowns and ${latest.size} of ${latest.size} assertions passed`, "the evidence records an incomplete or failed run");
  const bind = manifestBinding(live, receipts, assertions, latest);
  const bound = r.check("mainnet.manifest", bind.problems, bind.text, "the record does not cover the steps of the run's manifest");
  return { usable, complete: complete && bound, receipts, assertions, ids, exp };
}

async function checkMainnet(r, rec, rpc, candidate) {
  const { receipts, assertions, ids, exp } = rec;
  const verifier = MAINNET_ACCOUNTS.verifier;
  r.out(`             querying ${rpc.url} (read-only; nothing is signed or sent)`);
  const status = await rpc.call("status", []);
  if (!status.ok) {
    r.line("NOT VERIFIED", "mainnet.chain", "the RPC did not answer; nothing on chain was checked", [status.error]);
    return;
  }
  const chainProblems = [];
  if (status.result.chain_id !== "mainnet") chainProblems.push(`RPC chain id is ${JSON.stringify(status.result.chain_id)}, expected "mainnet"`);
  if (status.result.genesis_hash !== MAINNET_GENESIS) chainProblems.push(`RPC genesis hash is ${JSON.stringify(status.result.genesis_hash)}, expected ${MAINNET_GENESIS}`);
  if (!r.check("mainnet.chain", chainProblems, `RPC serves NEAR mainnet (genesis ${MAINNET_GENESIS})`, "wrong chain; nothing else is checked")) return;

  // Each recorded transaction: final, same signer, block and outcome, the same receipt tree, and the receiver and
  // method its step is supposed to call (from the pinned accounts and the mandate id, not the evidence's receiver field).
  const fetched = [];
  for (const rc of receipts) {
    const gate = `mainnet.tx ${rc.label}`;
    const d = isObject(rc.detail) ? rc.detail : {};
    const t = await rpc.call("tx", { tx_hash: rc.tx_hash, sender_account_id: d.signer_id, wait_until: "FINAL" });
    if (!t.ok) {
      r.line("NOT VERIFIED", gate, `${rc.tx_hash} could not be read`, [t.error]);
      continue;
    }
    const v = chainView(t.result);
    const p = [];
    if (t.result.final_execution_status !== "FINAL") p.push(`not final (${JSON.stringify(t.result.final_execution_status ?? null)})`);
    if (v.t.hash !== rc.tx_hash) p.push(`hash ${v.t.hash} != recorded ${rc.tx_hash}`);
    if (v.t.signer_id !== d.signer_id) p.push(`signer ${v.t.signer_id} != recorded ${d.signer_id}`);
    if (v.t.receiver_id !== d.receiver_id) p.push(`receiver ${v.t.receiver_id} != recorded ${d.receiver_id}`);
    if (v.method !== d.method) p.push(`method ${v.method} != recorded ${d.method}`);
    p.push(...targetProblems(rc.label, v, ids.mandate));
    if (d.withheld_relay === true && v.method !== "execute_intents") p.push(`marked as the withheld-order relay but calls ${v.method}`);
    if (v.outcome === "unknown") p.push("a status on chain is neither success nor failure");
    else if (v.outcome !== rc.outcome) p.push(`chain outcome ${v.outcome} != recorded ${rc.outcome}`);
    if (Array.isArray(d.receipts)) {
      const chainIds = v.receipts.map((x) => `${x.id}@${x.executor_id}:${x.kind}`).sort();
      const recIds = d.receipts.map((x) => `${x?.id}@${x?.executor_id}:${x?.success ? "success" : "failure"}`).sort();
      if (chainIds.join() !== recIds.join()) p.push(`receipt tree differs from the recorded one (${recIds.length} recorded, ${chainIds.length} on chain)`);
    }
    const h = await rpc.height(t.result.transaction_outcome?.block_hash);
    if (!h.ok) {
      r.line("NOT VERIFIED", gate, `${rc.tx_hash}: inclusion block could not be read`, [h.error, ...p]);
      continue;
    }
    if (rc.block_height !== undefined && h.value !== rc.block_height) p.push(`included in block ${h.value}, recorded ${rc.block_height}`);
    fetched.push({ rc, v, tx: t.result, height: h.value, kind: kindOf(rc.label), step: stepNumberOf(rc) });
    r.check(gate, p, `${rc.tx_hash} final, ${v.outcome}${FAILURE_STEPS.includes(kindOf(rc.label)) ? " (a step that must fail)" : ""}, ${v.t.signer_id} -> ${v.t.receiver_id}.${v.method}, block ${h.value}`, `${rc.tx_hash} does not match the evidence or its step`);
  }
  if (fetched.length !== receipts.length) {
    r.line("NOT VERIFIED", "mainnet.state", "not checked: not every recorded transaction could be read");
    return;
  }

  // Outcomes by step kind, whatever the record says: a refused proposal and the withheld relay must have failed, every
  // other transaction must have succeeded. The one exception follows the runner: only a withdrawal is ever retried
  // after a failed transaction (on resume), so a failed withdrawal is superseded by a later successful transaction of
  // the same step: the same step number where both labels carry one, and the same signer, receiver, method, token
  // and recipient on chain (a reconciled attempt's label carries no step number).
  const sameCall = (a, b) =>
    a.kind === b.kind && (a.step === null || b.step === null || a.step === b.step) && a.v.method === b.v.method && a.v.t.signer_id === b.v.t.signer_id && a.v.t.receiver_id === b.v.t.receiver_id && a.v.args.token === b.v.args.token && a.v.args.receiver_id === b.v.args.receiver_id;
  const outcomeProblems = [];
  let superseded = 0;
  for (const f of fetched) {
    const what = `${f.rc.label} (${f.rc.tx_hash})`;
    if (f.kind === null || !(f.kind in STEP_METHOD)) outcomeProblems.push(`${what}: its label names no transaction step of the live runner, so its required outcome is unknown`);
    else if (f.v.outcome === "unknown") outcomeProblems.push(`${what}: a status on chain is neither success nor failure`);
    else if (FAILURE_STEPS.includes(f.kind)) {
      if (f.v.outcome !== "failure") outcomeProblems.push(`${what}: a ${f.kind} step must fail on chain, it shows ${f.v.outcome}`);
    } else if (f.v.outcome !== "success") {
      const later = RETRIED_STEPS.includes(f.kind) && fetched.some((g) => g !== f && g.v.outcome === "success" && g.height > f.height && sameCall(f, g));
      if (later) superseded += 1;
      else outcomeProblems.push(`${what}: a ${f.kind} step must succeed on chain, it shows ${f.v.outcome}${RETRIED_STEPS.includes(f.kind) ? " and no later successful attempt of the same step" : `; the runner never retries a failed ${f.kind}`}`);
    }
  }
  const mustFail = fetched.filter((f) => FAILURE_STEPS.includes(f.kind)).length;
  r.check("mainnet.outcomes", outcomeProblems, `judged by step kind, not by the record: ${mustFail} ${FAILURE_STEPS.join("/")} transactions failed, ${fetched.length - mustFail - superseded} others succeeded${superseded > 0 ? `, ${superseded} failed withdrawal attempts superseded by a later successful attempt of the same step` : ""}`, "a transaction's outcome on chain is not the one its step kind requires");

  // The block of every receipt, read once per block hash.
  const heights = new Map();
  const heightOf = async (hash) => {
    if (!heights.has(hash)) heights.set(hash, await rpc.height(hash));
    return heights.get(hash);
  };

  // The run's final block: the highest block holding any receipt of its last transaction.
  const last = fetched.reduce((a, b) => (b.height > a.height ? b : a));
  let finalBlock = last.height;
  for (const x of last.v.receipts) {
    const h = await heightOf(x.block_hash);
    if (!h.ok) {
      r.line("NOT VERIFIED", "mainnet.state", "the run's final block could not be determined", [h.error]);
      return;
    }
    finalBlock = Math.max(finalBlock, h.value);
  }
  r.line("INFO", "mainnet.final-block", `${finalBlock}: last receipt of ${last.rc.label} (${last.rc.tx_hash}); end state is read at this block, so later activity (an open challenge grant or deposit) is not compared`);

  // The mandate account runs the deployment candidate of this checkout: at the block of every receipt of the run it
  // executed and at the block before it (the state the receipt started from and the state it left), at the run's final
  // block and now. Each block is read once.
  if (candidate === null) r.line("NOT VERIFIED", "mainnet.code", `the code of ${ids.mandate} is not compared with the deployment candidate: this checkout's candidate was not read (--no-checkout or a failed checkout check)`);
  else {
    const errors = [];
    const p = [];
    const blocks = new Set();
    let executed = 0;
    for (const f of fetched) {
      for (const x of f.v.receipts.filter((y) => y.executor_id === ids.mandate)) {
        const h = await heightOf(x.block_hash);
        if (!h.ok) {
          errors.push(`block of receipt ${x.id} (${f.rc.label}): ${h.error}`);
          continue;
        }
        executed += 1;
        blocks.add(h.value - 1).add(h.value);
      }
    }
    if (executed === 0) p.push(`no recorded transaction has a receipt executed by ${ids.mandate}, so the code it ran during the run is not shown`);
    const during = blocks.size;
    for (const block of [finalBlock, ...[...blocks].filter((b) => b !== finalBlock).sort((a, b) => a - b), "final"]) {
      const got = await rpc.codeHash(ids.mandate, block);
      const when = block === "final" ? "now" : `at block ${block}`;
      if (!got.ok) errors.push(`code hash ${when}: ${got.error}`);
      else if (got.value !== candidate.codeHash) p.push(`code hash ${when} is ${got.value}, the candidate's is ${candidate.codeHash}`);
    }
    if (errors.length > 0) r.line("NOT VERIFIED", "mainnet.code", `the code hash of ${ids.mandate} could not be read at every block`, [...errors, ...p]);
    else
      r.check(
        "mainnet.code",
        p,
        `${ids.mandate} has code hash ${candidate.codeHash} (fixtures/${candidate.file} of this checkout) at the block of each of the ${executed} receipts it executed in the run and at the block before each (${during} blocks), at the run's final block ${finalBlock} and now. Not excluded: a deploy and redeploy inside one block, which state reads at block boundaries cannot show`,
        `${ids.mandate} does not run this checkout's deployment candidate throughout the run`,
      );
  }

  // Grant keys: registered before a successful revoke that removed them on the verifier, gone by the run's final block,
  // absent now. `revoked` collects the keys the chain shows through that whole lifecycle, with the revoke's block.
  const revoked = new Map();
  const grants = fetched.filter((x) => x.v.method === "grant" && x.v.outcome === "success").sort((a, b) => a.height - b.height);
  const revokes = fetched.filter((x) => x.v.method === "revoke").sort((a, b) => a.height - b.height);
  const grantKeys = assertions
    .filter((a) => /^step-\d+-grant(-attempt-\d+)?$/.test(a.id) && a.passed === true && typeof a.observed?.public_key === "string")
    .sort((a, b) => stepOf(a.id)[0] - stepOf(b.id)[0])
    .map((a) => a.observed.public_key);
  if (grants.length === 0 || grantKeys.length === 0) r.line("NOT VERIFIED", "mainnet.grant-key", "the evidence records no grant transaction or grant key");
  else if (grants.length !== grantKeys.length) r.line("NOT VERIFIED", "mainnet.grant-key", `${grants.length} successful grant transactions but ${grantKeys.length} verified grant keys`);
  for (const [i, key] of (grants.length === grantKeys.length ? grantKeys : []).entries()) {
    const gate = `mainnet.grant-key ${key}`;
    const grant = grants[i];
    const revoke = revokes.find((x) => x.height > grant.height);
    if (revoke === undefined) {
      r.line("NOT VERIFIED", gate, "the evidence records no revoke transaction after the grant");
      continue;
    }
    const at = async (block) => rpc.view(verifier, "has_public_key", { account_id: ids.mandate, public_key: key }, block);
    const before = await at(revoke.height);
    const after = await at(finalBlock);
    const now = await at("final");
    const full = await rpc.call("EXPERIMENTAL_tx_status", { tx_hash: revoke.rc.tx_hash, sender_account_id: revoke.v.t.signer_id, wait_until: "FINAL" });
    const errors = [before, after, now, full].filter((x) => !x.ok).map((x) => x.error);
    if (errors.length > 0) {
      r.line("NOT VERIFIED", gate, "key registration or the revoke transaction's receipts could not be read", errors);
      continue;
    }
    const p = [];
    if (revoke.v.outcome !== "success") p.push(`the revoke transaction ${revoke.rc.tx_hash} did not succeed on chain (${revoke.v.outcome})`);
    // The removal itself: a receipt from the mandate to the pinned verifier calling remove_public_key for this key.
    const removal = (Array.isArray(full.result.receipts) ? full.result.receipts : []).find((x) => {
      const call = (x?.receipt?.Action?.actions ?? []).map((a) => a?.FunctionCall).find(isObject);
      if (x?.predecessor_id !== ids.mandate || x?.receiver_id !== verifier || call?.method_name !== "remove_public_key") return false;
      try {
        return JSON.parse(Buffer.from(String(call.args), "base64").toString("utf8")).public_key === key;
      } catch {
        return false;
      }
    });
    if (removal === undefined) p.push(`the revoke transaction has no receipt ${ids.mandate} -> ${verifier}.remove_public_key for this key`);
    else if (revoke.v.receipts.find((x) => x.id === removal.receipt_id)?.kind !== "success") p.push(`the ${verifier}.remove_public_key receipt ${removal.receipt_id} did not succeed`);
    if (before.value !== true) p.push(`not registered on ${verifier} at block ${revoke.height} (revoke transaction included)`);
    if (after.value !== false) p.push(`still registered at the run's final block ${finalBlock}`);
    if (now.value !== false) p.push("registered now");
    if (r.check(gate, p, `registered on ${verifier} for ${ids.mandate} at block ${revoke.height}, removed by ${verifier}.remove_public_key in the successful revoke ${revoke.rc.tx_hash}, gone by block ${finalBlock}, absent now`)) revoked.set(key, revoke.height);
  }

  // The withheld order's relay failed on the verifier because a key of that lifecycle did not exist. The key is read
  // from the chain's own error, and must be a grant key shown above as registered before its revoke and absent after.
  const relays = fetched.filter((f) => f.kind === "relay_withheld" || f.rc.detail?.withheld_relay === true);
  let rejectedRelays = 0;
  if (relays.length === 0) r.line("NOT VERIFIED", "mainnet.relay", "the evidence records no withheld-order relay transaction, so rejection of a signed order after revocation is not shown");
  const relayAssertions = assertions.filter((a) => /-relay_withheld(-attempt-\d+)?$/.test(a.id));
  for (const x of relays) {
    const failure = x.v.receipts.find((y) => y.executor_id === verifier && y.kind === "failure");
    const m = failure === undefined ? null : /public key '([^'\\]+)' doesn't exist for account '([^'\\]+)'/.exec(failure.error);
    const p = [];
    if (failure === undefined) p.push(`no failed receipt on ${verifier}`);
    else if (m === null || m[2] !== ids.mandate) p.push(`verifier error is not the removed-key rejection for ${ids.mandate}`);
    else {
      const key = m[1];
      if (!revoked.has(key)) p.push(`the rejected key ${key} is not a grant key the chain shows registered before its revoke and absent after`);
      else if (x.height <= revoked.get(key)) p.push(`relayed in block ${x.height}, not after the revoke in block ${revoked.get(key)}`);
      for (const a of relayAssertions) if (a.observed?.revoked_key !== undefined && a.observed.revoked_key !== key) p.push(`evidence ${a.id} names revoked key ${a.observed.revoked_key}, the chain rejected ${key}`);
    }
    if (x.v.receipts.some((y) => y.kind === "failure" && y.executor_id !== verifier)) p.push("a receipt outside the verifier failed");
    if (r.check(`mainnet.relay ${x.rc.label}`, p, `${x.rc.tx_hash} rejected by ${verifier} after the revoke: removed grant key ${m?.[1]}`)) rejectedRelays += 1;
  }

  // A fill counts as a trade only if it executed the mandate's proposed order and moved tokens: the bundle on chain is
  // bound to an order the mandate logged as signed, and the mandate's Intents balances and the order's nonce are read
  // on both sides of the blocks in which the verifier executed the fill.
  const traded = new Set();
  const tokenIds = Object.values(MAINNET_TOKENS).map((t) => `nep141:${t}`);
  const proposals = fetched.filter((f) => f.kind === "propose" && f.v.outcome === "success" && targetProblems(f.rc.label, f.v, ids.mandate).length === 0);
  for (const f of fetched.filter((x) => x.kind === "fill" && x.v.outcome === "success")) {
    const gate = `mainnet.trade ${f.rc.label}`;
    const bound = fillBinding(f.tx, proposals.map((x) => x.tx), ids.mandate, verifier, tokenIds);
    if (bound.trade === null) {
      r.check(gate, bound.problems, "", `${f.rc.tx_hash} is not shown to have executed the mandate's proposed order`);
      continue;
    }
    const errors = [];
    const at = [];
    for (const x of f.v.receipts.filter((y) => y.executor_id === verifier)) {
      const h = await heightOf(x.block_hash);
      if (h.ok) at.push(h.value);
      else errors.push(`block of receipt ${x.id}: ${h.error}`);
    }
    const p = [];
    const moved = [];
    const [before, after] = [Math.min(...at) - 1, Math.max(...at) + 1];
    if (at.length === 0) p.push(`no receipt of the transaction was executed by ${verifier}`);
    else if (errors.length === 0) {
      for (const [token, delta] of Object.entries(bound.trade.diff)) {
        const a = await rpc.view(verifier, "mt_balance_of", { account_id: ids.mandate, token_id: token }, before);
        const b = await rpc.view(verifier, "mt_balance_of", { account_id: ids.mandate, token_id: token }, after);
        if (!a.ok || !b.ok) errors.push(`${token}: ${a.ok ? b.error : a.error}`);
        else if (!/^[0-9]+$/.test(String(a.value)) || !/^[0-9]+$/.test(String(b.value))) errors.push(`${token}: balance is not a decimal amount`);
        else if (BigInt(b.value) - BigInt(a.value) !== delta) p.push(`${ids.mandate} ${token} changed by ${BigInt(b.value) - BigInt(a.value)} between blocks ${before} and ${after}, the signed order moves ${delta}`);
        else moved.push(`${token} ${delta > 0n ? "+" : ""}${delta}`);
      }
      const nonce = { account_id: ids.mandate, nonce: bound.trade.nonce };
      const unused = await rpc.view(verifier, "is_nonce_used", nonce, before);
      const used = await rpc.view(verifier, "is_nonce_used", nonce, after);
      if (!unused.ok || !used.ok) errors.push(`order nonce: ${unused.ok ? used.error : unused.error}`);
      else {
        if (unused.value !== false) p.push(`the order's nonce was already used at block ${before}, before the fill`);
        if (used.value !== true) p.push(`the order's nonce is not used at block ${after}, after the fill`);
      }
    }
    if (errors.length > 0) r.line("NOT VERIFIED", gate, "the token movement of the fill could not be read", [...errors, ...p]);
    else if (
      r.check(
        gate,
        p,
        `${f.rc.tx_hash} executed the order the mandate signed with ${bound.trade.publicKey} in a proposal of the run; between blocks ${before} and ${after} the mandate's balances on ${verifier} moved by exactly the signed amounts (${moved.join(", ")}) and the order's nonce became used. Any other movement of these tokens in those blocks would fail this check`,
        `${f.rc.tx_hash} did not move the signed order's amounts`,
      )
    )
      traded.add(f);
  }

  // Completeness, pinned here: a whole-run pass needs each of these shown on chain, whatever the manifest or the record
  // lists. A transaction counts only if it succeeded and went to the receiver and method its step kind calls.
  const done = (kinds, also = () => true) => fetched.some((f) => kinds.includes(f.kind) && f.v.outcome === "success" && targetProblems(f.rc.label, f.v, ids.mandate).length === 0 && also(f));
  const missing = [];
  if (!done(["grant"])) missing.push("no successful grant transaction");
  if (!done(["propose"])) missing.push("no successful propose transaction (a signed proposal)");
  if (!done(["fill"], (f) => traded.has(f))) missing.push("no successful fill transaction that executed the mandate's proposed order and moved its amounts");
  if (!done(["revoke", "revoke_external"])) missing.push("no successful revoke transaction");
  if (rejectedRelays === 0) missing.push("no withheld-order relay shown rejected after the revoke");
  for (const asset of Object.keys(MAINNET_TOKENS)) if (!done(["recover", "recover_external"], (f) => f.v.args.asset === asset)) missing.push(`no successful recover transaction for ${asset}`);
  r.check("mainnet.complete", missing, `the chain shows a successful grant, proposal, fill and revoke, ${rejectedRelays} rejected withheld relay${rejectedRelays === 1 ? "" : "s"} and a successful recovery of ${Object.keys(MAINNET_TOKENS).join(" and ")}`, "the chain does not show a complete run");

  // Postcondition read from the chain alone: after recovery the mandate holds nothing of either pinned token.
  {
    const errors = [];
    const p = [];
    for (const [asset, token] of Object.entries(MAINNET_TOKENS)) {
      const got = await rpc.view(verifier, "mt_balance_of", { account_id: ids.mandate, token_id: `nep141:${token}` }, finalBlock);
      if (!got.ok) errors.push(`${asset}: ${got.error}`);
      else if (String(got.value) !== "0") p.push(`${ids.mandate} still holds ${got.value} ${asset} on ${verifier} at block ${finalBlock}`);
    }
    if (errors.length > 0) r.line("NOT VERIFIED", "mainnet.recovered", `the Intents balances of ${ids.mandate} could not be read`, [...errors, ...p]);
    else r.check("mainnet.recovered", p, `${ids.mandate} holds 0 ${Object.keys(MAINNET_TOKENS).join(" and 0 ")} on ${verifier} at the run's final block ${finalBlock}, read from the chain independently of the record`, "assets remain in the mandate at the run's final block");
  }

  // End balances at the run's final block, against the last balances the run recorded. Token ids are the pinned ones.
  const tokens = MAINNET_TOKENS;
  const checks = [];
  if (isObject(exp.mandate)) for (const [asset, v] of Object.entries(exp.mandate)) checks.push({ what: `${ids.mandate} Intents ${asset}`, account: verifier, method: "mt_balance_of", args: { account_id: ids.mandate, token_id: `nep141:${tokens[asset]}` }, want: v });
  if (isObject(exp.ownerIntents) && typeof ids.owner === "string") for (const [asset, v] of Object.entries(exp.ownerIntents)) checks.push({ what: `${ids.owner} Intents ${asset}`, account: verifier, method: "mt_balance_of", args: { account_id: ids.owner, token_id: `nep141:${tokens[asset]}` }, want: v });
  for (const [asset, v] of Object.entries(exp.ownerTokens)) if (typeof ids.owner === "string") checks.push({ what: `${ids.owner} ${tokens[asset]} ${asset}`, account: tokens[asset], method: "ft_balance_of", args: { account_id: ids.owner }, want: v });
  if (checks.length === 0) {
    r.line("NOT VERIFIED", "mainnet.balances", "the evidence records no end balances");
    return;
  }
  const p = [];
  const errors = [];
  const seen = [];
  for (const c of checks) {
    const got = await rpc.view(c.account, c.method, c.args, finalBlock);
    if (!got.ok) errors.push(`${c.what}: ${got.error}`);
    else if (String(got.value) !== String(c.want)) p.push(`${c.what}: ${got.value} at block ${finalBlock}, recorded ${c.want}`);
    else seen.push(`${c.what} ${c.want}`);
  }
  if (errors.length > 0) r.line("NOT VERIFIED", "mainnet.balances", "balances could not be read", [...errors, ...p]);
  else r.check("mainnet.balances", p, `at block ${finalBlock}: ${seen.join("; ")}`);
}

// ---------------------------------------------------------------------------------------------- main

const USAGE = `Usage: node verify.mjs [--bundle evidence/<rev>] [--root <dir>] [--no-checkout] [--rules current|bundle]
       node verify.mjs --mainnet [--rpc <url>] [--live <file>] [--timeout-ms <n>]
       node verify.mjs --write-manifest evidence/<rev>
       node verify.mjs --print-required

Checks a committed evidence bundle (default: the certified entry in evidence/index.json). It checks recorded
evidence; it does not run the tests. Offline unless --mainnet.
  --bundle <path>        bundle directory relative to the root
  --no-checkout          do not compare SPEC.md, fixtures and the deployment candidate in this checkout
  --rules current        judge the cases against this checkout's required list (default)
  --rules bundle         judge them against the list the bundle records it was certified under, stated as such
  --mainnet              also read every recorded mainnet transaction from a public archival RPC (read-only); the
                         verifier (${MAINNET_ACCOUNTS.verifier}), signer (${MAINNET_ACCOUNTS.signer}) and token contracts are pinned in this script
  --rpc <url>            RPC URL (default $MANDATE_VERIFY_RPC or ${DEFAULT_RPC})
  --live <file>          mainnet evidence file (default <bundle>/${LIVE_FILE}); any other file is outside the hashed
                         bundle, so the result is NOT VERIFIED whatever its checks say
  --write-manifest <dir> write <dir>/${MANIFEST} for a curated bundle and exit
Exit status: 0 every check passed; 1 a check failed or could not be verified; 2 usage error.
${NOT_PROVED}`;

function parseArgs(argv) {
  const opts = { root: dirname(fileURLToPath(import.meta.url)), bundle: null, checkout: true, rules: "current", mainnet: false, rpc: process.env.MANDATE_VERIFY_RPC || DEFAULT_RPC, live: null, timeoutMs: 20_000, writeManifest: null, printRequired: false, help: false };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--no-checkout") opts.checkout = false;
    else if (a === "--mainnet") opts.mainnet = true;
    else if (a === "--print-required") opts.printRequired = true;
    else if (a === "--root") opts.root = resolve(value(i++, a));
    else if (a === "--bundle") opts.bundle = value(i++, a);
    else if (a === "--rules") opts.rules = value(i++, a);
    else if (a === "--rpc") opts.rpc = value(i++, a);
    else if (a === "--live") opts.live = resolve(value(i++, a));
    else if (a === "--timeout-ms") opts.timeoutMs = Number(value(i++, a));
    else if (a === "--write-manifest") opts.writeManifest = value(i++, a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (opts.rules !== "current" && opts.rules !== "bundle") throw new Error("--rules must be current or bundle");
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs <= 0) throw new Error("--timeout-ms must be a positive integer");
  if (!/^https?:\/\/\S+$/.test(opts.rpc)) throw new Error("--rpc must be an http(s) URL");
  return opts;
}

export async function main(argv, out = console.log) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    out(`verify: ${e.message}\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    out(USAGE);
    return 0;
  }
  if (opts.printRequired) {
    out(JSON.stringify({ required: REQUIRED_CASES, separate: SEPARATE_CASES }));
    return 0;
  }
  if (opts.writeManifest !== null) {
    const dir = resolve(opts.root, opts.writeManifest);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      out(`verify: ${opts.writeManifest} is not a directory`);
      return 2;
    }
    const text = manifestText(dir);
    writeFileSync(join(dir, MANIFEST), text);
    out(`wrote ${join(opts.writeManifest, MANIFEST)}: ${text.split("\n").length - 1} files`);
    return 0;
  }

  let bundle;
  try {
    bundle = (opts.bundle ?? defaultBundle(opts.root)).replace(/\/+$/, "");
  } catch (e) {
    out(`verify: ${e.message}`);
    return 2;
  }
  const bundleDir = resolve(opts.root, bundle);
  if (!existsSync(bundleDir)) {
    out(`verify: bundle ${bundle} does not exist`);
    return 2;
  }
  const r = new Report(out);
  out(`Checking the committed evidence bundle ${bundle}${opts.checkout ? " against this checkout" : ""}.`);
  out("This checks recorded evidence: file hashes, the certified acceptance report and its gate reports. It does not run the tests.");
  let ev = null;
  // "": no mainnet run is recorded. Otherwise the sentence the summary ends with, so it never reads as mainnet verified
  // unless the chain was read.
  let mainnetNote = "";
  try {
    checkFiles(r, bundleDir, bundle);
    ev = checkEvidence(r, opts.root, bundleDir, bundle, opts.rules);
    const candidate = checkCheckout(r, opts.root, ev, !opts.checkout);
    const rec = checkRecordedRun(r, bundleDir, bundle, opts.live, ev, candidate, opts.mainnet);
    if (rec === null) {
      if (opts.mainnet) r.line("NOT VERIFIED", "mainnet", `no mainnet receipts: ${opts.live ?? `${bundle}/${LIVE_FILE}`} does not exist. No mainnet run is recorded in this bundle, so nothing on mainnet is verified.`);
      else r.line("SKIP", "mainnet", "this bundle records no mainnet run (sandbox evidence only); nothing on mainnet is claimed or checked");
    } else if (opts.mainnet) {
      mainnetNote = ` Mainnet transactions and state were read from ${opts.rpc}${opts.rpc === DEFAULT_RPC ? "" : " (not this script's default RPC; the result is only as good as that endpoint)"}.`;
      if (rec.usable) await checkMainnet(r, rec, new Rpc(opts.rpc, opts.timeoutMs), candidate);
    } else {
      // Offline, a recorded run is judged by its own record only. A complete record is a SKIP, not NOT VERIFIED: the
      // offline run claims nothing about mainnet and says so in its summary, and the build's offline gate must not
      // need a network. A failed or incomplete record is already a FAIL above.
      mainnetNote = " Mainnet: NOT CHECKED. The bundle records a mainnet run, but the chain was not consulted; run node verify.mjs --mainnet.";
      if (rec.usable && rec.complete) r.line("SKIP", "mainnet", `the bundle records a mainnet run whose own record is complete, but the chain was not consulted, so nothing on mainnet is verified here; run node verify.mjs --mainnet to read the recorded transactions from ${opts.rpc}`);
      else r.line("NOT VERIFIED", "mainnet", "the bundle records a mainnet run that its own record shows failed, incomplete or inconsistent (see the mainnet lines above); the chain was not consulted");
    }
  } catch (e) {
    r.line("FAIL", "internal", `the check stopped on unexpected evidence content: ${e?.message ?? String(e)}`);
  }
  const c = r.counts;
  const summary = `${c.PASS} passed, ${c.FAIL} failed, ${c["NOT VERIFIED"]} not verified, ${c.SKIP} skipped`;
  const cov = ev?.coverage;
  const lacks = cov === undefined ? 0 : cov.current - cov.covered;
  const rules = opts.rules === "bundle" ? ` under the bundle's own required list${cov === undefined ? "" : ` (${cov.covered} of ${cov.current} current cases; ${lacks === 0 ? "it lacks none of the currently required cases" : `it lacks ${lacks} of the currently required cases`})`}` : "";
  out(NOT_PROVED);
  out(r.bad === 0 ? `VERIFIED${rules}: ${bundle} (${summary}). Recorded evidence only; the tests were not rerun.${mainnetNote}` : `NOT VERIFIED${rules}: ${bundle} (${summary}).${mainnetNote}`);
  return r.bad === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
