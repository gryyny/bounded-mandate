// Builds a captioned demo video from the files of one actual run. Not part of make test, make demo or CI.
//
// Usage (from the repository root):
//   make demo 2>&1 | tee out/video/demo.log        # the demo log must come from the run that wrote demo.json
//   make test                                       # optional: out/evidence/acceptance.json (gate results)
//   cd tools && npx --no-install tsx src/video/make.ts [--log ../out/video/demo.log]
//
// Inputs: out/evidence/demo.json, out/evidence/acceptance.json (optional), out/page/index.html, the demo log,
// fixtures/model/normal.json. Outputs in out/video/: bounded-mandate-demo.mp4, captions.srt, video.json
// (source hashes, revision, frame list) and frames/*.png.
//
// Extra prerequisites (not npm dependencies of this package):
//   - ffmpeg and ffprobe on PATH (FFMPEG / FFPROBE override), e.g. Homebrew ffmpeg.
//   - Google Chrome (PW_CHANNEL override, default "chrome").
//   - playwright-core from the globally installed playwright-cli: $(npm root -g)/@playwright/cli/node_modules/playwright-core
//     (PLAYWRIGHT_CORE overrides the path).
//
// Every number shown is read from the input files; the script refuses a log that is not from the demo.json run.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { REPO_ROOT, treeState } from "../evidence/report.js";
import { REQUIRED_CASES } from "../evidence/required.js";
import type { Acceptance } from "../evidence/schema.js";
import { escapeHtml as esc, loadAcceptance } from "../page/render.js";
import { Evidence } from "../types.js";

const OUT = join(REPO_ROOT, "out/video");
const W = 1920;
const H = 1080;

// ---- inputs --------------------------------------------------------------------------------------

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const rel = (p: string): string => relative(REPO_ROOT, p);

interface LogStep {
  title: string;
  lines: { ok: boolean; gate: string; text: string }[];
}

function parseLog(text: string, ev: Evidence): { steps: LogStep[]; setupMs: number; storyMs: number } {
  const steps: LogStep[] = [];
  for (const line of text.split("\n")) {
    const head = /^== (.+)$/.exec(line);
    if (head?.[1] !== undefined) steps.push({ title: head[1], lines: [] });
    const check = /^ {2}(ok {2}|FAIL) \[([A-Za-z0-9]+)\] (.+)$/.exec(line);
    if (check?.[1] !== undefined && check[2] !== undefined && check[3] !== undefined) {
      steps.at(-1)?.lines.push({ ok: check[1].startsWith("ok"), gate: check[2], text: check[3] });
    }
  }
  const summary = /setup (\d+) ms \| story (\d+) ms \| (\d+)\/(\d+) assertions passed/.exec(text);
  if (summary === null) throw new Error("demo log has no summary line: capture the complete `make demo` output");
  const [setupMs, storyMs, passed, total] = summary.slice(1).map(Number) as [number, number, number, number];
  const evPassed = ev.assertions.filter((a) => a.passed).length;
  if (String(storyMs) !== ev.environment.story_ms || total !== ev.assertions.length || passed !== evPassed) {
    throw new Error("the demo log is not from the run that wrote out/evidence/demo.json (story time or assertion counts differ)");
  }
  return { steps, setupMs, storyMs };
}

// ---- formatting ----------------------------------------------------------------------------------

/** Decimal string of integer units with `decimals`, rounded down to `places`. */
function units(raw: string, decimals: number, places: number): string {
  const v = BigInt(raw);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const frac = ((abs % scale) * 10n ** BigInt(places)) / scale;
  const whole = (abs / scale).toLocaleString("en-US");
  return `${neg ? "-" : ""}${whole}${places > 0 ? `.${frac.toString().padStart(places, "0")}` : ""}`;
}
const usdc = (raw: string): string => `${units(raw, 6, 2)} USDC`;
const wnear = (raw: string): string => `${units(raw, 24, 4)} wNEAR`;
const short = (h: string): string => (h.length > 16 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h);

// ---- scenes --------------------------------------------------------------------------------------

type Kind = "sandbox" | "model" | "page" | "spec" | "summary";

const KIND_LABEL: Record<Kind, string[]> = {
  sandbox: ["Local NEAR sandbox", "Real Intents verifier WASM", "Test doubles: MPC signer, oracle, tokens", "No mainnet"],
  model: ["Local NEAR sandbox", "Recorded genuine model output", "Real Intents verifier WASM", "Test doubles: MPC, oracle, tokens", "No mainnet"],
  page: ["Evidence page rendered from run files", "Not an execution", "Sandbox results only", "No mainnet"],
  spec: ["Claim text (SPEC.md)", "Not an execution", "No mainnet"],
  summary: ["Summary of run files", "Sandbox results only", "No mainnet"],
};

interface Scene {
  kind: Kind;
  title: string;
  body: string;
  captions: string[];
}

const list = (items: string[]): string => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const kv = (rows: [string, string][]): string => `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
const img = (png: Buffer): string => `<img class="shot" src="data:image/png;base64,${png.toString("base64")}" alt="">`;

function acceptanceStatus(acc: Acceptance | null, ev: Evidence): { chip: string; sentence: string } {
  if (acc === null) return { chip: "No acceptance run", sentence: "No acceptance.json: this video shows no gate result; every gate counts as not run." };
  if (acc.revision !== ev.source.product_commit) return { chip: "Acceptance: other revision", sentence: "The acceptance run is for another revision, so its gate results do not count here." };
  if (!acc.certified) {
    const open = acc.cases.filter((c) => c.status !== "passed").length;
    const why = [acc.dirty ? "dirty working tree" : "", open > 0 ? `${String(open)} required cases not passed` : "", acc.problems.length > 0 ? "run problems" : ""];
    return { chip: "Acceptance: UNCERTIFIED", sentence: `The acceptance run is uncertified (${why.filter(Boolean).join(", ")}); no gate counts as passed.` };
  }
  return { chip: "Acceptance: certified", sentence: "The acceptance run is certified: clean tree, every required case present once, passed and hash-matched." };
}

function scenes(ev: Evidence, acc: Acceptance | null, steps: LogStep[], shots: Record<string, Buffer>, modelName: string): Scene[] {
  const A = new Map(ev.assertions.map((a) => [a.id, a]));
  const obs = (id: string): unknown => {
    const a = A.get(id);
    if (a === undefined) throw new Error(`demo.json lacks assertion ${id}`);
    return a.observed;
  };
  // Receipts carry no story step; each scene claims its receipts by label, and every receipt must be shown once.
  const shown = new Set<number>();
  const txs = (pattern: RegExp): string =>
    list(
      ev.receipts.flatMap((r, i) => {
        if (!pattern.test(r.label) || shown.has(i)) return [];
        shown.add(i);
        return [`<code>${esc(r.label)}</code> · ${esc(r.outcome)} · tx <code>${esc(short(r.tx_hash ?? "none"))}</code>`];
      }),
    );
  const stepOf = (prefix: string): LogStep => {
    const s = steps.find((x) => x.title.startsWith(prefix));
    if (s === undefined) throw new Error(`demo log lacks step "${prefix}"`);
    return s;
  };
  const checks = (s: LogStep): string => list(s.lines.map((l) => `<span class="${l.ok ? "ok" : "bad"}">${l.ok ? "ok" : "FAIL"}</span> <code>[${esc(l.gate)}]</code> ${esc(l.text)}`));
  const status = acceptanceStatus(acc, ev);
  const commit = `${ev.source.product_commit.slice(0, 10)}${ev.source.dirty ? " (dirty tree)" : ""}`;

  const roles = stepOf("Roles and limits");
  const initial = (obs("grant-initial-value") as { contract: string }).contract;
  const model = stepOf("Genuine model proposal");
  const decision = (obs("model-proposal-on-chain") as { decision: { decision_text: string; prompt_sha256: string; raw_output_sha256: string } }).decision;
  const proposal = (JSON.parse(decision.decision_text) as { proposal: { sell: string; sell_amount: string; max_concession_bps: number } }).proposal;
  const fill = stepOf("Filler fills");
  const trade = (obs("trade-executed") as { signed: { sell_amount: string; buy_amount: string }; before: Record<string, string>; after: Record<string, string> });
  const withheld = stepOf("Second signed order withheld");
  const attacks = stepOf("Malicious requests");
  const attackRows = ev.assertions.filter((a) => a.id.startsWith("attack-"));
  const byBoundary = new Map<string, number>();
  for (const a of attackRows) {
    const b = /stopped by ([a-z-]+)/.exec(a.description)?.[1] ?? "unclassified";
    byBoundary.set(b, (byBoundary.get(b) ?? 0) + 1);
  }
  const attacksStopped = attackRows.filter((a) => a.passed).length;
  const revoke = stepOf("Owner revokes");
  const relay = stepOf("Withheld order relayed");
  const rejected = (obs("withheld-rejected") as { error: string; relay_block_time_ns: string; order_deadline_ns: string; nonce_used: boolean });
  const secondsLeft = Number((BigInt(rejected.order_deadline_ns) - BigInt(rejected.relay_block_time_ns)) / 1_000_000_000n);
  const reason = /ExecutionError\\?":\\?"([^"\\]+)/.exec(rejected.error)?.[1] ?? rejected.error;
  const disabled = stepOf("Agent, oracle and MPC disabled");
  const recovery = stepOf("Recovery to the owner");
  const rec = (obs("recovered") as { recovered: { usdc: string; wnear: string }; mandate_final: { usdc: string; wnear: string } });

  const caseRows = acc === null
    ? Object.entries(REQUIRED_CASES).map(([g, cs]) => `<tr><th>${esc(g)}</th><td>${cs.map((c) => `<span class="pill none">${esc(c)}: not run</span>`).join(" ")}</td></tr>`).join("")
    : Object.keys(REQUIRED_CASES).map((g) => `<tr><th>${esc(g)}</th><td>${acc.cases.filter((c) => c.gate === g).map((c) => `<span class="pill ${c.status === "passed" && acc.certified ? "ok" : c.status === "passed" ? "warn" : "bad"}">${esc(c.case)}: ${esc(c.status === "passed" && !acc.certified ? "passed (uncertified)" : c.status)}</span>`).join(" ")}</td></tr>`).join("");
  const counted = acc?.cases.filter((c) => c.status === "passed").length ?? 0;
  const totalCases = Object.values(REQUIRED_CASES).flat().length;
  const t5 = acc?.baseline ?? null;

  const out: Scene[] = [
    {
      kind: "summary",
      title: "A bounded trading mandate on NEAR Intents",
      body: kv([
        ["Revision", commit],
        ["Demo run", ev.generated_at],
        ["Demo checks", `${String(ev.assertions.filter((a) => a.passed).length)}/${String(ev.assertions.length)} held`],
        ["Acceptance", status.chip],
        ["Execution", "local sandbox; MPC, oracle and tokens are test doubles; real verifier WASM; no mainnet"],
      ]),
      captions: [`Everything in this video is read from the files of one demo run at revision ${commit}.`, status.sentence],
    },
    {
      kind: "spec",
      title: "Claim and non-claims",
      body: img(shots.claim ?? Buffer.alloc(0)),
      captions: [
        "Claim: the mandate contract builds and signs every order itself; the agent can only propose within immutable limits.",
        "After confirmed key removal, withheld signed orders fail, and the owner recovers assets without agent, oracle or MPC.",
        "Not claimed: principal, profit, execution availability or a maximum total loss. The owner stays trusted.",
      ],
    },
    {
      kind: "sandbox",
      title: "1 · Grant and limits",
      body: txs(/grant/) + checks(roles),
      captions: [`The owner grants the mandate. Initial reference value: $${units(initial, 12, 2)}. Path ${ev.identifiers.grant_path ?? "?"}.`, "The agent's only key is a function-call key for propose_order; the mandate account has no key."],
    },
    {
      kind: "model",
      title: `2 · Recorded genuine model output, ${modelName}`,
      body: kv([
        ["Model", modelName],
        ["Proposal", `sell ${usdc(proposal.sell_amount)}, max concession ${String(proposal.max_concession_bps)} bps`],
        ["Prompt sha256", decision.prompt_sha256],
        ["Raw output sha256", decision.raw_output_sha256],
      ]) + txs(/propose_order \(order 1\)/) + checks(model),
      captions: [`Recorded genuine model output, ${modelName}: sell ${usdc(proposal.sell_amount)} for wNEAR, at most ${String(proposal.max_concession_bps)} bps concession.`, "The replay is hash-bound to the chain state; the proposal reached propose_order and the contract signed it."],
    },
    {
      kind: "sandbox",
      title: "3 · Fill on the real verifier WASM",
      body: kv([
        ["Signed sell", usdc(trade.signed.sell_amount)],
        ["Signed buy", wnear(trade.signed.buy_amount)],
        ["Mandate USDC", `${usdc(trade.before.usdc ?? "0")} → ${usdc(trade.after.usdc ?? "0")}`],
        ["Mandate wNEAR", `${wnear(trade.before.wnear ?? "0")} → ${wnear(trade.after.wnear ?? "0")}`],
      ]) + txs(/execute_intents order|settle_order/) + checks(fill),
      captions: [`Our filler fills the order on the pinned mainnet verifier WASM: the mandate pays ${usdc(trade.signed.sell_amount)} and receives ${wnear(trade.signed.buy_amount)}, exactly as signed.`],
    },
    {
      kind: "sandbox",
      title: "4 · A second signed order is withheld",
      body: txs(/scripted, withheld/) + checks(withheld),
      captions: ["A scripted second order is signed and withheld. Before revocation the verifier would still accept it."],
    },
    {
      kind: "sandbox",
      title: `5 · Scripted attacks: ${String(attacksStopped)} of ${String(attackRows.length)} stopped`,
      body: kv([...byBoundary.entries()].map(([b, n]): [string, string] => [b, `${String(n)} stopped`])) + list(attacks.lines.filter((l) => !l.text.includes("stopped by")).map((l) => esc(l.text))),
      captions: [`Scripted attacks: ${String(attackRows.length)} injected or direct malicious requests; ${String(attacksStopped)} were stopped at their expected boundary with no state change.`, "These are scripted requests, labelled separately from the model's own output."],
    },
    {
      kind: "sandbox",
      title: "6 · Owner revokes; key removal confirmed",
      body: txs(/^owner revoke/) + checks(revoke),
      captions: ["The owner revokes. The grant key is removed from the verifier, and only that confirmation releases the withheld order's reservation."],
    },
    {
      kind: "sandbox",
      title: "7 · The withheld order is relayed and rejected",
      body: kv([["Verifier error", reason], ["Time left before its deadline", `${String(secondsLeft)} s`], ["Nonce used", String(rejected.nonce_used)]]) + txs(/withheld order after revocation/) + checks(relay),
      captions: [`Another account relays the withheld order ${String(secondsLeft)} s before its deadline. The verifier rejects it: the key no longer exists. No balance changed.`],
    },
    {
      kind: "sandbox",
      title: "8 · Recovery with agent, oracle and MPC unavailable",
      body: kv([["Recovered", `${usdc(rec.recovered.usdc)} and ${wnear(rec.recovered.wnear)}`], ["Destination", `${ev.identifiers.owner ?? "owner"} (owner's Intents account)`], ["Mandate left", `${usdc(rec.mandate_final.usdc)}, ${wnear(rec.mandate_final.wnear)}`]]) + txs(/set_fail|set_mode|after revocation/) + txs(/recover/) + checks(disabled) + checks(recovery),
      captions: [`With the oracle failing and the MPC test double on hold, the owner recovers ${usdc(rec.recovered.usdc)} and ${wnear(rec.recovered.wnear)} to the owner's Intents account.`],
    },
    {
      kind: "summary",
      title: `Acceptance gates per case: ${String(counted)} of ${String(totalCases)} passed`,
      body: `<p class="chip-line">${esc(status.chip)}${acc === null ? "" : ` · run ${esc(String(acc.run_id))}`}</p><table class="cases">${caseRows}</table>`,
      captions: [acc === null ? status.sentence : `${String(counted)} of ${String(totalCases)} required cases passed in acceptance run ${String(acc.run_id)}. ${status.sentence}`],
    },
    {
      kind: "page",
      title: "Evidence page · acceptance gates",
      body: img(shots.gates ?? Buffer.alloc(0)),
      captions: ["The generated evidence page shows each required case, and never marks a gate from demo checks."],
    },
    {
      kind: "page",
      title: "Evidence page · T5, our re-implementation of Claw Guard",
      body: img(shots.baseline ?? Buffer.alloc(0)),
      captions: ["T5 applies the same threats to our own re-implementation of the pinned Claw Guard design, not to the deployed product."],
    },
    {
      kind: "page",
      title: "Evidence page · T5 threat cases",
      body: img(shots.baselineTable ?? Buffer.alloc(0)),
      captions: [
        t5 === null
          ? "This evidence has no T5 baseline report, so differentiation is unproven here."
          : `In that re-implementation, ${String(t5.cases.filter((c) => c.baseline_outcome === "attack_succeeded").length)} of ${String(t5.cases.length)} threat cases were executed as successful attacks; an increment counts only with a passing mandate gate in a certified run.`,
      ],
    },
    {
      kind: "summary",
      title: "Hashes and revision",
      body: kv([
        ["Revision", `${ev.source.product_commit}${ev.source.dirty ? " (dirty)" : ""}`],
        ["SPEC.md sha256", ev.source.spec_sha256],
        ["Mandate WASM sha256", ev.source.contract_wasm_sha256],
        ["Verifier WASM sha256", ev.source.fixtures["verifier/defuse-0.4.5.wasm"] ?? "unknown"],
        ["Model recording sha256", ev.source.fixtures["model/normal.json"] ?? "unknown"],
        ["Acceptance run", acc === null ? "none" : `${String(acc.run_id)} (certified: ${String(acc.certified)})`],
      ]),
      captions: ["Each result is bound to its source revision and to the spec, fixture and WASM hashes shown here."],
    },
    {
      kind: "summary",
      title: "Limits",
      body: list([...ev.unknowns, status.sentence].map(esc)),
      captions: ["Limits: sandbox only, with test doubles for MPC, oracle and tokens; no mainnet execution in this run; the model step is a replay.", status.sentence],
    },
  ];
  const hidden = ev.receipts.filter((_, i) => !shown.has(i)).map((r) => r.label);
  if (hidden.length > 0) throw new Error(`receipts not shown in any scene: ${hidden.join(", ")}`);
  return out;
}

// ---- rendering -----------------------------------------------------------------------------------

const CSS = `
* { box-sizing: border-box; } body { margin: 0; width: ${String(W)}px; height: ${String(H)}px; overflow: hidden; background: #10141a; color: #ece6d8;
  font: 30px/1.4 "Iowan Old Style", Palatino, Georgia, serif; }
.top { display: flex; gap: 12px; padding: 26px 48px 0; flex-wrap: wrap; align-items: center; }
.chip { font: 600 20px/1 "SF Mono", Menlo, monospace; letter-spacing: .06em; text-transform: uppercase; padding: 10px 14px; border: 2px solid #7fb6dc; color: #7fb6dc; border-radius: 4px; }
.chip.model { border-color: #e6b450; color: #e6b450; } .chip.acc { margin-left: auto; border-color: #e0866f; color: #e0866f; } .chip.acc.ok { border-color: #6fcf9f; color: #6fcf9f; }
h1 { font-size: 58px; line-height: 1.1; margin: 26px 48px 18px; }
.body { margin: 0 48px; height: 690px; overflow: hidden; font-size: 28px; }
.body ul { margin: 8px 0; padding-left: 28px; } .body li { margin: 6px 0; }
code { font: 22px "SF Mono", Menlo, monospace; color: #c9d6e3; }
.ok { color: #6fcf9f; font-weight: 700; } .bad { color: #ff8a7a; font-weight: 700; }
table.kv { border-collapse: collapse; margin-bottom: 14px; } table.kv th { text-align: left; color: #a39d8f; font-weight: 600; padding: 6px 28px 6px 0; vertical-align: top; white-space: nowrap; }
table.kv td { font: 24px/1.4 "SF Mono", Menlo, monospace; word-break: break-all; padding: 6px 0; }
table.cases th { text-align: left; padding: 8px 20px 8px 0; font: 700 24px "SF Mono", Menlo, monospace; vertical-align: top; }
.pill { display: inline-block; font: 600 19px "SF Mono", Menlo, monospace; padding: 6px 10px; margin: 3px; border-radius: 4px; border: 2px solid; }
.pill.ok { color: #6fcf9f; } .pill.warn { color: #e6b450; } .pill.bad { color: #ff8a7a; } .pill.none { color: #9a958a; border-style: dashed; }
.chip-line { font: 600 26px "SF Mono", Menlo, monospace; color: #e0866f; margin: 0 0 14px; }
img.shot { width: 100%; height: 690px; object-fit: contain; object-position: top center; border: 1px solid #2a3039; }
.caption { position: absolute; left: 0; right: 0; bottom: 0; min-height: 150px; padding: 24px 80px; background: rgba(0,0,0,.82); color: #fff;
  font: 500 36px/1.35 -apple-system, "Helvetica Neue", Arial, sans-serif; text-align: center; display: flex; align-items: center; justify-content: center; }
`;

function slideHtml(s: Scene, caption: string, accChip: string, certified: boolean): string {
  const chips = KIND_LABEL[s.kind].map((l) => `<span class="chip${s.kind === "model" && l.startsWith("Recorded") ? " model" : ""}">${esc(l)}</span>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="top">${chips}<span class="chip acc${certified ? " ok" : ""}">${esc(accChip)}</span></div>
<h1>${esc(s.title)}</h1><div class="body">${s.body}</div><div class="caption">${esc(caption)}</div></body></html>`;
}

interface PwPage {
  setContent(html: string): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(opts: { path?: string; clip?: { x: number; y: number; width: number; height: number }; fullPage?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}
interface PwBrowser {
  newPage(opts: { viewport: { width: number; height: number }; colorScheme?: "dark" | "light"; deviceScaleFactor?: number }): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwCore {
  chromium: { launch(opts: { channel?: string; headless: boolean }): Promise<PwBrowser> };
}

function loadPlaywright(): PwCore {
  const path = process.env.PLAYWRIGHT_CORE ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@playwright/cli/node_modules/playwright-core");
  return createRequire(import.meta.url)(path) as PwCore;
}

/** Viewport-sized crops of the evidence page, starting at the given CSS selectors. */
async function pageShots(browser: PwBrowser, pagePath: string): Promise<Record<string, Buffer>> {
  const page = await browser.newPage({ viewport: { width: 1240, height: 560 }, colorScheme: "dark", deviceScaleFactor: 2 });
  await page.goto(`file://${pagePath}`);
  const shots: Record<string, Buffer> = {};
  // Without a T5 report the baseline section has no table; its heading is shown instead.
  for (const [name, selector] of Object.entries({ claim: "#claim", gates: "#gates", baseline: "#baseline", baselineTable: "#baseline table, #baseline" })) {
    const top = Number(await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top + window.scrollY`));
    shots[name] = await page.screenshot({ fullPage: true, clip: { x: 0, y: Math.max(0, top - 16), width: 1240, height: 560 } });
  }
  await page.close();
  return shots;
}

/** Packs whole sentences into frames of at most 24 words, so each burned-in caption stays readable. */
const chunks = (caption: string): string[] => {
  const out: string[] = [];
  for (const sentence of caption.split(/(?<=[.!?:;])\s+(?=[A-Z0-9])/)) {
    const last = out.at(-1);
    const words = (t: string) => t.trim().split(/\s+/).length;
    if (last !== undefined && words(last) + words(sentence) <= 24) out[out.length - 1] = `${last} ${sentence.trim()}`;
    else out.push(sentence.trim());
  }
  return out;
};
const secondsFor = (text: string): number => Math.min(7, Math.max(4, text.split(" ").length / 3.2 + 1));

const srtTime = (s: number): string => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

async function main(): Promise<void> {
  const logArg = process.argv.indexOf("--log");
  const logPath = resolve(logArg > 0 ? (process.argv[logArg + 1] ?? "") : join(OUT, "demo.log"));
  const files = {
    demo: join(REPO_ROOT, "out/evidence/demo.json"),
    acceptance: join(REPO_ROOT, "out/evidence/acceptance.json"),
    page: join(REPO_ROOT, "out/page/index.html"),
    log: logPath,
    model: join(REPO_ROOT, "fixtures/model/normal.json"),
  };
  for (const [name, path] of Object.entries(files)) if (name !== "acceptance" && !existsSync(path)) throw new Error(`missing ${rel(path)}`);
  const ev = Evidence.parse(JSON.parse(readFileSync(files.demo, "utf8")));
  const acc = loadAcceptance(REPO_ROOT);
  const { steps, setupMs, storyMs } = parseLog(readFileSync(files.log, "utf8"), ev);
  const modelFixture = readFileSync(files.model);
  if (sha256(modelFixture) !== ev.source.fixtures["model/normal.json"]) throw new Error("fixtures/model/normal.json differs from the hash recorded in demo.json");
  const modelName = (JSON.parse(modelFixture.toString("utf8")) as { model: string }).model;

  rmSync(join(OUT, "frames"), { recursive: true, force: true });
  mkdirSync(join(OUT, "frames"), { recursive: true });
  const browser = await loadPlaywright().chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome", headless: true });
  const frames: { file: string; seconds: number; caption: string; title: string; kind: Kind }[] = [];
  try {
    const shots = await pageShots(browser, files.page);
    const status = acceptanceStatus(acc, ev);
    const certified = acc !== null && acc.certified && acc.revision === ev.source.product_commit;
    const slide = await browser.newPage({ viewport: { width: W, height: H } });
    for (const scene of scenes(ev, acc, steps, shots, modelName)) {
      for (const caption of scene.captions.flatMap(chunks)) {
        const file = join(OUT, "frames", `${String(frames.length + 1).padStart(3, "0")}.png`);
        await slide.setContent(slideHtml(scene, caption, status.chip, certified));
        await slide.screenshot({ path: file });
        frames.push({ file, seconds: secondsFor(caption), caption, title: scene.title, kind: scene.kind });
      }
    }
  } finally {
    await browser.close();
  }

  const last = frames.at(-1);
  if (last === undefined) throw new Error("no frames");
  const concat = [...frames.flatMap((f) => [`file '${f.file}'`, `duration ${f.seconds.toFixed(2)}`]), `file '${last.file}'`].join("\n");
  writeFileSync(join(OUT, "frames.txt"), concat);
  const mp4 = join(OUT, "bounded-mandate-demo.mp4");
  execFileSync(process.env.FFMPEG ?? "ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(OUT, "frames.txt"),
    "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", mp4]);
  const duration = Number(execFileSync(process.env.FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", mp4], { encoding: "utf8" }).trim());

  let t = 0;
  const srt = frames.map((f, i) => {
    const line = `${String(i + 1)}\n${srtTime(t)} --> ${srtTime(t + f.seconds)}\n${f.caption}\n`;
    t += f.seconds;
    return line;
  });
  writeFileSync(join(OUT, "captions.srt"), srt.join("\n"));

  const tree = treeState(REPO_ROOT);
  const hashOf = (p: string): string | null => (existsSync(p) ? sha256(readFileSync(p)) : null);
  const manifest = {
    schema: "bounded-mandate/video/1",
    generated_at: new Date().toISOString(),
    revision: tree.revision,
    dirty: tree.dirty,
    demo_revision: ev.source.product_commit,
    demo_dirty: ev.source.dirty,
    acceptance: acc === null ? null : { run_id: acc.run_id, revision: acc.revision, certified: acc.certified, complete: acc.complete },
    sources: Object.fromEntries(Object.entries(files).map(([k, p]) => [k, { path: rel(p), sha256: hashOf(p) }])),
    demo_timing_ms: { setup: setupMs, story: storyMs },
    output: { mp4: { path: rel(mp4), sha256: hashOf(mp4), bytes: readFileSync(mp4).length, duration_s: duration }, srt: { path: "out/video/captions.srt", sha256: hashOf(join(OUT, "captions.srt")) } },
    tools: { ffmpeg: execFileSync(process.env.FFMPEG ?? "ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0] ?? "unknown" },
    frames: frames.map((f) => ({ file: rel(f.file), seconds: f.seconds, kind: f.kind, title: f.title, caption: f.caption })),
  };
  writeFileSync(join(OUT, "video.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${rel(mp4)}: ${duration.toFixed(1)} s, ${String(manifest.output.mp4.bytes)} bytes, ${String(frames.length)} frames; ${acceptanceStatus(acc, ev).chip}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
