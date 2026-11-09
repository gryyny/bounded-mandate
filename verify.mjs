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
  LIVE: ["agent-template"],
  CONSOLE: ["browser-sandbox", "access-controls", "wallet-sandbox"],
  COMPARE: ["revocation-alternatives"],
  SIGNER: ["conformance"],
};
export const SEPARATE_CASES = { RESCUE: ["owner-key"] };

const MANIFEST = "SHA256SUMS";
const LIVE_FILE = "live-mainnet.json";
const DEFAULT_RPC = "https://archival-rpc.mainnet.fastnear.com";
const MAINNET_GENESIS = "EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H";
// Token accounts pinned in tools/src/live/manifest.live-agent.example.json; used only when the evidence names none.
const MAINNET_TOKENS = { usdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", wnear: "wrap.near" };
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

function listFiles(dir) {
  return readdirSync(dir)
    .filter((name) => !IGNORED_NAMES.has(name))
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? listFiles(path) : [path];
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
  const certified = (index.bundles ?? []).filter((b) => b.status === "certified");
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
  for (const file of readdirSync(testsDir).filter((f) => !IGNORED_NAMES.has(f)).sort()) {
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

function reportProblems({ file, report }, run, acc, fixtureStems) {
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
  const wasm = isObject(report.wasm_sha256) ? report.wasm_sha256 : {};
  if (report.mode === "sandbox" && Object.keys(wasm).length === 0) out.push(`${id}: sandbox report binds no WASM hash`);
  for (const [stem, hash] of Object.entries(wasm)) {
    const recorded = acc.hashes?.wasm?.[stem] ?? fixtureStems[stem];
    if (recorded === undefined) out.push(`${id}: wasm ${stem} is not recorded for this run`);
    else if (recorded !== hash) out.push(`${id}: wasm ${stem} ${hash} != recorded ${recorded}`);
  }
  return out;
}

/** The bundle's own required list, from the cases its acceptance report lists, grouped by gate. */
function recordedRegistry(acc) {
  const out = {};
  for (const c of Array.isArray(acc.cases) ? acc.cases : []) {
    if (typeof c?.gate !== "string" || typeof c?.case !== "string") continue;
    out[c.gate] = [...new Set([...(out[c.gate] ?? []), c.case])];
  }
  return out;
}

function checkEvidence(r, root, bundleDir, bundle, rules) {
  const problems = [];
  const run = loadJson(join(bundleDir, "run.json"), problems, "run.json");
  const acc = loadJson(join(bundleDir, "acceptance.json"), problems, "acceptance.json");
  const index = loadJson(join(root, "evidence/index.json"), problems, "evidence/index.json");
  if (run === null || acc === null) {
    r.line("FAIL", "acceptance.report", "cannot be checked", problems);
    return null;
  }

  const entry = (index?.bundles ?? []).find((b) => b.path === bundle);
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
  const statusOf = new Map((Array.isArray(acc.cases) ? acc.cases : []).map((c) => [c.id, c]));
  const listedIds = (Array.isArray(acc.cases) ? acc.cases : []).map((c) => c.id);
  const missingFromAcc = required.filter((id) => !listedIds.includes(id));
  const extraInAcc = listedIds.filter((id) => !required.includes(id));
  const dupInAcc = listedIds.filter((id, i) => listedIds.indexOf(id) !== i);
  const notNow = caseIds(recorded).filter((id) => !current.includes(id));
  const earlier = missingFromAcc.length > 0 && extraInAcc.length === 0 && dupInAcc.length === 0 && rules === "current";
  const listProblems = [
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
        else problems.push(...reportProblems(found[0], run, acc, fixtureStems));
        const stated = statusList.get(id);
        if (stated?.status !== "passed") problems.push(`${id}: acceptance.json states ${JSON.stringify(stated?.status ?? "nothing")}`);
      }
      r.check(`${label} ${gate}`, problems, `${names.length} of ${names.length} present once, passed, bound to run ${run.run_id}: ${names.join(", ")}`);
    }
  };
  caseLines(registry, "gate", statusOf);
  caseLines(SEPARATE_CASES, "separate", new Map((Array.isArray(acc.separate) ? acc.separate : []).map((c) => [c.id, c])));
  return { run, acc, byId };
}

function checkCheckout(r, root, ev, skip) {
  const gates = ["checkout.spec", "checkout.fixtures", "checkout.deploy-candidate"];
  if (skip) {
    for (const g of gates) r.line("SKIP", g, "not checked (--no-checkout): this checkout is not compared with the bundle");
    return;
  }
  if (ev === null) {
    for (const g of gates) r.line("FAIL", g, "not checked: the bundle's run record is unreadable");
    return;
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
  const manifest = manifestHash === null ? { files: {} } : readJson(manifestPath);
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
  const candidates = Object.entries(manifest.files ?? {}).filter(([, e]) => e.kind === "deployment-candidate");
  if (candidates.length !== 1) candProblems.push(`fixtures/manifest.json lists ${candidates.length} deployment candidates, expected 1`);
  let candidateText = "";
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
    candidateText = `fixtures/${file} sha256 ${hash}, NEAR code hash ${codeHash}, deployed in sandbox by DEPLOY.candidate`;
  }
  r.check("checkout.deploy-candidate", candProblems, candidateText, "the deployment candidate does not match");

  const built = Object.keys(acc.hashes?.wasm ?? {});
  r.line("INFO", "wasm.local-builds", `not recomputed: ${built.join(", ")} were built by the run with the Rust toolchain; reports are checked only for consistency with those recorded hashes`);
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
    return { id: o.id, executor_id: o.outcome?.executor_id, block_hash: o.block_hash, kind, error: kind === "failure" ? JSON.stringify(o.outcome.status.Failure) : null };
  });
  const top = statusKind(tx.status);
  const outcome = top === "unknown" || receipts.some((x) => x.kind === "unknown") ? "unknown" : top === "success" && !receipts.some((x) => x.kind === "failure") ? "success" : "failure";
  const call = (tx.transaction?.actions ?? []).map((a) => a?.FunctionCall).find(isObject);
  return { receipts, outcome, method: call?.method_name ?? null, t: tx.transaction ?? {} };
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

async function checkMainnet(r, bundleDir, bundle, rpc, livePath) {
  const path = livePath ?? join(bundleDir, LIVE_FILE);
  if (!existsSync(path)) {
    r.line("NOT VERIFIED", "mainnet", `no mainnet receipts: ${livePath ?? `${bundle}/${LIVE_FILE}`} does not exist. No mainnet run is recorded in this bundle, so nothing on mainnet is verified.`);
    return;
  }
  let ev;
  try {
    ev = readJson(path);
  } catch {
    r.line("FAIL", "mainnet.evidence", `${path} is not valid JSON`);
    return;
  }
  const receipts = Array.isArray(ev.receipts) ? ev.receipts : [];
  const assertions = Array.isArray(ev.assertions) ? ev.assertions : [];
  const ids = isObject(ev.identifiers) ? ev.identifiers : {};
  const evProblems = [];
  if (ev.mode !== "mainnet") evProblems.push(`evidence mode is ${JSON.stringify(ev.mode)}, not "mainnet"`);
  if (ev.environment?.chain_id !== "mainnet") evProblems.push(`evidence chain id is ${JSON.stringify(ev.environment?.chain_id)}, not "mainnet"`);
  if (receipts.length === 0) evProblems.push("evidence has no receipts");
  for (const rc of receipts) {
    if (typeof rc.tx_hash !== "string" || typeof rc.detail?.signer_id !== "string") evProblems.push(`receipt ${JSON.stringify(rc.label)} has no transaction hash or signer`);
  }
  if (typeof ids.mandate !== "string" || typeof ids.verifier !== "string") evProblems.push("evidence names no mandate or verifier account");
  if (!r.check("mainnet.evidence", evProblems, `${receipts.length} receipts recorded in mode mainnet (${livePath ?? `${bundle}/${LIVE_FILE}`})`, "not mainnet evidence")) return;

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

  // Each recorded transaction: final, same signer, receiver, method, block and outcome, and the same receipt tree.
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
    if (v.outcome === "unknown") p.push("a status on chain is neither success nor failure");
    else if (v.outcome !== rc.outcome) p.push(`chain outcome ${v.outcome} != recorded ${rc.outcome}`);
    if (Array.isArray(d.receipts)) {
      const chainIds = v.receipts.map((x) => `${x.id}@${x.executor_id}:${x.kind}`).sort();
      const recIds = d.receipts.map((x) => `${x.id}@${x.executor_id}:${x.success ? "success" : "failure"}`).sort();
      if (chainIds.join() !== recIds.join()) p.push(`receipt tree differs from the recorded one (${recIds.length} recorded, ${chainIds.length} on chain)`);
    }
    const h = await rpc.height(t.result.transaction_outcome?.block_hash);
    if (!h.ok) {
      r.line("NOT VERIFIED", gate, `${rc.tx_hash}: inclusion block could not be read`, [h.error, ...p]);
      continue;
    }
    if (rc.block_height !== undefined && h.value !== rc.block_height) p.push(`included in block ${h.value}, recorded ${rc.block_height}`);
    fetched.push({ rc, v, height: h.value });
    r.check(gate, p, `${rc.tx_hash} final, ${v.outcome}${d.expected_error !== undefined || d.withheld_relay === true ? " (expected failure)" : ""}, ${d.signer_id} -> ${d.receiver_id}.${d.method}, block ${h.value}`, `${rc.tx_hash} does not match the evidence`);
  }
  if (fetched.length !== receipts.length) {
    r.line("NOT VERIFIED", "mainnet.state", "not checked: not every recorded transaction could be read");
    return;
  }

  // The run's final block: the highest block holding any receipt of its last transaction.
  const last = fetched.reduce((a, b) => (b.height > a.height ? b : a));
  let finalBlock = last.height;
  for (const x of last.v.receipts) {
    const h = await rpc.height(x.block_hash);
    if (!h.ok) {
      r.line("NOT VERIFIED", "mainnet.state", "the run's final block could not be determined", [h.error]);
      return;
    }
    finalBlock = Math.max(finalBlock, h.value);
  }
  r.line("INFO", "mainnet.final-block", `${finalBlock}: last receipt of ${last.rc.label} (${last.rc.tx_hash}); end state is read at this block, so later activity (an open challenge grant or deposit) is not compared`);

  // Grant keys: registered before revocation, removed by the run's final block, absent now.
  const grants = fetched.filter((x) => x.rc.detail?.method === "grant" && x.rc.outcome === "success").sort((a, b) => a.height - b.height);
  const revokes = fetched.filter((x) => x.rc.detail?.method === "revoke").sort((a, b) => a.height - b.height);
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
    const at = async (block) => rpc.view(ids.verifier, "has_public_key", { account_id: ids.mandate, public_key: key }, block);
    const before = await at(revoke.height);
    const after = await at(finalBlock);
    const now = await at("final");
    const errors = [before, after, now].filter((x) => !x.ok).map((x) => x.error);
    if (errors.length > 0) {
      r.line("NOT VERIFIED", gate, "key registration could not be read", errors);
      continue;
    }
    const p = [];
    if (before.value !== true) p.push(`not registered on ${ids.verifier} at block ${revoke.height} (revoke transaction included)`);
    if (after.value !== false) p.push(`still registered at the run's final block ${finalBlock}`);
    if (now.value !== false) p.push("registered now");
    r.check(gate, p, `registered on ${ids.verifier} for ${ids.mandate} at block ${revoke.height}, removed by block ${finalBlock}, absent now`);
  }

  // The withheld order's relay failed on the verifier because the revoked key did not exist.
  for (const x of fetched.filter((f) => f.rc.detail?.withheld_relay === true)) {
    const relay = assertions.find((a) => /-relay_withheld(-attempt-\d+)?$/.test(a.id));
    const key = relay?.observed?.revoked_key ?? grantKeys[0];
    const expected = `public key '${key}' doesn't exist for account '${ids.mandate}'`;
    const failure = x.v.receipts.find((y) => y.executor_id === ids.verifier && y.kind === "failure");
    const p = [];
    if (failure === undefined) p.push(`no failed receipt on ${ids.verifier}`);
    else if (!failure.error.includes(expected)) p.push(`verifier error is not the removed-key rejection (${expected})`);
    if (x.v.receipts.some((y) => y.kind === "failure" && y.executor_id !== ids.verifier)) p.push("a receipt outside the verifier failed");
    r.check(`mainnet.relay ${x.rc.label}`, p, `${x.rc.tx_hash} rejected by ${ids.verifier}: removed key ${key}`);
  }

  // End balances at the run's final block, against the last balances the run recorded.
  const exp = expectedBalances(assertions);
  const tokens = { ...MAINNET_TOKENS, ...exp.tokens };
  const checks = [];
  if (isObject(exp.mandate)) for (const [asset, v] of Object.entries(exp.mandate)) checks.push({ what: `${ids.mandate} Intents ${asset}`, account: ids.verifier, method: "mt_balance_of", args: { account_id: ids.mandate, token_id: `nep141:${tokens[asset]}` }, want: v });
  if (isObject(exp.ownerIntents) && typeof ids.owner === "string") for (const [asset, v] of Object.entries(exp.ownerIntents)) checks.push({ what: `${ids.owner} Intents ${asset}`, account: ids.verifier, method: "mt_balance_of", args: { account_id: ids.owner, token_id: `nep141:${tokens[asset]}` }, want: v });
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
  --mainnet              also read every recorded mainnet transaction from a public archival RPC (read-only)
  --rpc <url>            RPC URL (default $MANDATE_VERIFY_RPC or ${DEFAULT_RPC})
  --live <file>          mainnet evidence file (default <bundle>/${LIVE_FILE})
  --write-manifest <dir> write <dir>/${MANIFEST} for a curated bundle and exit
Exit status: 0 every check passed; 1 a check failed or could not be verified; 2 usage error.`;

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
  checkFiles(r, bundleDir, bundle);
  const ev = checkEvidence(r, opts.root, bundleDir, bundle, opts.rules);
  checkCheckout(r, opts.root, ev, !opts.checkout);
  if (opts.mainnet) await checkMainnet(r, bundleDir, bundle, new Rpc(opts.rpc, opts.timeoutMs), opts.live);
  else {
    const hasLive = existsSync(join(bundleDir, LIVE_FILE));
    r.line("SKIP", "mainnet", hasLive ? `not checked offline; run node verify.mjs --mainnet to read the recorded transactions from ${opts.rpc}` : "this bundle records no mainnet run (sandbox evidence only); nothing on mainnet is claimed or checked");
  }
  const c = r.counts;
  const summary = `${c.PASS} passed, ${c.FAIL} failed, ${c["NOT VERIFIED"]} not verified, ${c.SKIP} skipped`;
  out(r.bad === 0 ? `VERIFIED: ${bundle} (${summary}). Recorded evidence only; the tests were not rerun.` : `NOT VERIFIED: ${bundle} (${summary}).`);
  return r.bad === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
