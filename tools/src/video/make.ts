// Builds two captioned videos from the files of one actual run: a short cut (45-75 s) telling the revocation story
// in seven stages, and the longer technical walkthrough. Not part of make test, make demo or CI.
//
// Usage (from the repository root):
//   make demo 2>&1 | tee out/video/demo.log        # the demo log must come from the run that wrote demo.json
//   make test                                       # optional: out/evidence/acceptance.json (gate results)
//   cd tools && npx --no-install tsx src/video/make.ts [--log ../out/video/demo.log]
//
// Inputs: out/evidence/demo.json, out/evidence/acceptance.json (optional), out/page/index.html, the demo log,
// fixtures/model/normal.json. Outputs in out/video/: bounded-mandate-short.mp4 with captions-short.srt and
// frames-short/*.png; bounded-mandate-demo.mp4 (walkthrough) with captions.srt and frames/*.png; video.json
// (source hashes, revision, certification, and per cut its output hashes, duration and frame list).
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
import { bindDemo, latestRunId, type DemoBinding } from "../evidence/binding.js";
import type { Acceptance } from "../evidence/schema.js";
import { liveView, loadLive } from "../page/mainnet.js";
import { GATE_LABEL, escapeHtml as esc, loadAcceptance } from "../page/render.js";
import { revocationStory, shortHash, unboundReceipts, units, usdc, wnear, type Stage } from "../page/story.js";
import { Evidence } from "../types.js";

const OUT = join(REPO_ROOT, "out/video");
const W = 1920;
const H = 1080;
const FPS = 30;

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

// ---- scenes --------------------------------------------------------------------------------------

type Kind = "demo" | "page" | "summary";

const DEMO_LABELS = ["Local NEAR sandbox", "Real Intents verifier WASM", "Test doubles: MPC, oracle, tokens", "No mainnet"];
const KIND_LABEL: Record<Kind, string[]> = {
  demo: DEMO_LABELS,
  page: ["Evidence page rendered from run files", "Not an execution", "Sandbox results only", "No mainnet"],
  summary: ["Summary of run files", "Sandbox results only", "No mainnet"],
};

interface Scene {
  kind: Kind;
  /** Extra execution labels for this scene, e.g. recorded genuine model output or scripted attacks. */
  labels?: string[];
  title: string;
  body: string;
  captions: string[];
}

const list = (items: string[]): string => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const kv = (rows: [string, string][]): string => `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
const img = (png: Buffer): string => `<img class="shot" src="data:image/png;base64,${png.toString("base64")}" alt="">`;

/** The only place the video may say "certified": a certified acceptance run bound to this demo. */
function certification(binding: DemoBinding): { chip: string; sentence: string } {
  return binding.certified
    ? { chip: "Certified for this demo", sentence: "Certified for this demo: the latest certified acceptance run binds to this demo's clean revision, spec, fixtures and every deployed WASM." }
    : { chip: "Not certified for this demo", sentence: `Not certified for this demo: ${binding.reasons.join("; ")}. No gate counts as passed.` };
}

function walkthroughScenes(ev: Evidence, acc: Acceptance | null, binding: DemoBinding, steps: LogStep[], shots: Record<string, Buffer>, modelName: string): Scene[] {
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
        return [`<code>${esc(r.label)}</code> · ${esc(r.outcome)} · tx <code>${esc(shortHash(r.tx_hash ?? "none"))}</code>`];
      }),
    );
  const stepOf = (prefix: string): LogStep => {
    const s = steps.find((x) => x.title.startsWith(prefix));
    if (s === undefined) throw new Error(`demo log lacks step "${prefix}"`);
    return s;
  };
  const checks = (s: LogStep): string => list(s.lines.map((l) => `<span class="${l.ok ? "ok" : "bad"}">${l.ok ? "ok" : "FAIL"}</span> <code>[${esc(l.gate)}]</code> ${esc(l.text)}`));
  const status = certification(binding);

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

  // One pill per required case; a case the acceptance run did not evaluate (e.g. added later) is shown as such.
  const pill = (g: string, name: string): string => {
    const c = acc?.cases.find((x) => x.gate === g && x.case === name);
    if (c === undefined) return `<span class="pill none">${esc(name)}: ${acc === null ? "not run" : "not in this acceptance run"}</span>`;
    const cls = c.status === "passed" ? (binding.certified ? "ok" : "warn") : "bad";
    return `<span class="pill ${cls}">${esc(name)}: ${esc(c.status)}</span>`;
  };
  const caseRows = Object.entries(REQUIRED_CASES)
    .map(([g, names]) => `<tr><th>${esc(g)}<br><small>${esc(GATE_LABEL[g] ?? "")}</small></th><td>${names.map((n) => pill(g, n)).join(" ")}</td></tr>`)
    .join("");
  const counted = Object.entries(REQUIRED_CASES).flatMap(([g, names]) => names.filter((n) => acc?.cases.some((c) => c.gate === g && c.case === n && c.status === "passed"))).length;
  const totalCases = Object.values(REQUIRED_CASES).flat().length;
  const t5 = acc?.baseline ?? null;

  const rescue = acc?.separate.find((c) => c.id === "RESCUE.owner-key");
  const out: Scene[] = [
    {
      kind: "summary",
      labels: DEMO_LABELS,
      title: "A bounded trading mandate on NEAR Intents",
      body: `<p class="claim">The mandate contract builds and signs every trade itself; the agent can only propose within immutable limits. After the owner's confirmed key removal, withheld signed orders fail, and the owner recovers assets without the agent, oracle or signer.</p>`,
      captions: ["Claim: the contract builds and signs every trade; after confirmed key removal, withheld orders fail and the owner recovers without agent, oracle or signer.", status.sentence],
    },
    {
      kind: "demo",
      title: "1 · Grant and limits",
      body: txs(/grant/) + checks(roles),
      captions: [`The owner grants the mandate. Initial reference value: $${units(initial, 12, 2)}. The agent's only key can call propose_order.`],
    },
    {
      kind: "demo",
      labels: ["Recorded genuine model output"],
      title: `2 · Recorded genuine model output, ${modelName}`,
      body: kv([
        ["Model", modelName],
        ["Proposal", `sell ${usdc(proposal.sell_amount)}, max concession ${String(proposal.max_concession_bps)} bps`],
        ["Prompt sha256", decision.prompt_sha256],
        ["Raw output sha256", decision.raw_output_sha256],
      ]) + txs(/propose_order \(order 1\)/) + checks(model),
      captions: [`Recorded genuine model output, ${modelName}: sell ${usdc(proposal.sell_amount)} for wNEAR, at most ${String(proposal.max_concession_bps)} bps concession. The contract signs it.`],
    },
    {
      kind: "demo",
      title: "3 · Trade on the real verifier WASM",
      body: kv([
        ["Signed sell", usdc(trade.signed.sell_amount)],
        ["Signed buy", wnear(trade.signed.buy_amount)],
        ["Mandate USDC", `${usdc(trade.before.usdc ?? "0")} → ${usdc(trade.after.usdc ?? "0")}`],
        ["Mandate wNEAR", `${wnear(trade.before.wnear ?? "0")} → ${wnear(trade.after.wnear ?? "0")}`],
      ]) + txs(/execute_intents order|settle_order/) + checks(fill),
      captions: [`Our filler fills it on the pinned mainnet verifier WASM: the mandate pays ${usdc(trade.signed.sell_amount)} and receives ${wnear(trade.signed.buy_amount)}, exactly as signed.`],
    },
    {
      kind: "demo",
      labels: ["Scripted proposal"],
      title: "4 · A second signed order is withheld",
      body: txs(/scripted, withheld/) + checks(withheld),
      captions: ["A scripted second order is signed and withheld. Before revocation the verifier would still accept it."],
    },
    {
      kind: "demo",
      labels: ["Scripted attacks"],
      title: `5 · Scripted attacks: ${String(attacksStopped)} of ${String(attackRows.length)} stopped`,
      body: kv([...byBoundary.entries()].map(([b, n]): [string, string] => [b, `${String(n)} stopped`])) + list(attacks.lines.filter((l) => !l.text.includes("stopped by")).map((l) => esc(l.text))),
      captions: [`Scripted attacks: ${String(attacksStopped)} of ${String(attackRows.length)} injected or direct malicious requests stopped at their expected boundary, with no state change.`],
    },
    {
      kind: "demo",
      title: "6 · Owner revokes; key removal confirmed",
      body: txs(/^owner revoke/) + checks(revoke),
      captions: ["The owner revokes. The verifier confirms the grant key is removed; only then is the withheld order's reservation released."],
    },
    {
      kind: "demo",
      title: "7 · The withheld order is relayed and rejected",
      body: kv([["Verifier error", reason], ["Time left before its deadline", `${String(secondsLeft)} s`], ["Nonce used", String(rejected.nonce_used)]]) + txs(/withheld order after revocation/) + checks(relay),
      captions: [`Another account relays the withheld order ${String(secondsLeft)} s before its deadline. The verifier rejects it: the key no longer exists.`],
    },
    {
      kind: "demo",
      labels: ["Ordinary recovery (not the owner-key rescue)"],
      title: "8 · Ordinary recovery with agent, oracle and MPC unavailable",
      body: kv([["Recovered", `${usdc(rec.recovered.usdc)} and ${wnear(rec.recovered.wnear)}`], ["Destination", `${ev.identifiers.owner ?? "owner"} (owner's Intents account)`], ["Mandate left", `${usdc(rec.mandate_final.usdc)}, ${wnear(rec.mandate_final.wnear)}`]]) + txs(/set_fail|set_mode|after revocation/) + txs(/recover/) + checks(disabled) + checks(recovery),
      captions: [`With the oracle failing and the MPC test double on hold, the owner recovers ${usdc(rec.recovered.usdc)} and ${wnear(rec.recovered.wnear)} through ordinary recovery.`],
    },
    {
      kind: "summary",
      title: `Acceptance gates per case: ${String(counted)} of ${String(totalCases)} passed`,
      body: `${binding.certified ? "" : `<p class="note">Amber: passed in the acceptance run, but not certified for this demo.</p>`}<table class="cases">${caseRows}</table><p class="note">Emergency owner-key rescue, reported separately and never counted toward T4: ${esc(rescue === undefined ? "not reported" : rescue.status)}.</p>`,
      captions: [binding.certified ? `${String(counted)} of ${String(totalCases)} required cases passed, certified for this demo.` : `${String(counted)} of ${String(totalCases)} required cases passed, but this run is not certified for this demo.`, "The emergency owner-key rescue is reported separately; it never counts as ordinary recovery."],
    },
    {
      kind: "page",
      title: "T5 · our re-implementation of the Claw Guard design",
      body: img(shots.baselineTable ?? Buffer.alloc(0)),
      captions: [
        t5 === null
          ? "T5 compares against our own re-implementation of the pinned Claw Guard design; this evidence has no T5 report, so differentiation is unproven."
          : `T5 runs the same threats against our own re-implementation of the pinned Claw Guard design, not the deployed product: ${String(t5.cases.filter((c) => c.baseline_outcome === "attack_succeeded").length)} of ${String(t5.cases.length)} cases executed as successful attacks.`,
      ],
    },
    {
      kind: "summary",
      title: "Limits",
      body: list([...ev.unknowns, status.sentence].map(esc)),
      captions: ["Limits: sandbox only, with test doubles for MPC, oracle and tokens; no mainnet execution; the model step is a replay. No guarantee of profit or a maximum loss."],
    },
    {
      kind: "summary",
      title: "Provenance",
      body: kv([
        ["Demo revision", `${ev.source.product_commit}${ev.source.dirty ? " (dirty)" : ""}`],
        ["Acceptance run", acc === null ? "none" : `${String(acc.run_id)} at ${String(acc.revision)}${acc.dirty ? " (dirty)" : ""}`],
        ["Latest run", binding.inputs.latest_run_id ?? "unknown"],
        ["SPEC.md sha256", ev.source.spec_sha256],
        ["Fixture manifest sha256", ev.source.fixture_manifest_sha256 ?? "not recorded by the demo"],
        ["Mandate WASM sha256", ev.source.contract_wasm_sha256],
        ["Verifier WASM sha256", ev.source.fixtures["verifier/defuse-0.4.5.wasm"] ?? "unknown"],
        ["Certification", binding.certified ? "certified for this demo" : `not certified for this demo: ${binding.reasons.join("; ")}`],
      ]),
      captions: [status.sentence],
    },
  ];
  const hidden = ev.receipts.filter((_, i) => !shown.has(i)).map((r) => r.label);
  if (hidden.length > 0) throw new Error(`receipts not shown in any scene: ${hidden.join(", ")}`);
  return out;
}

const sentenceCase = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

function rail(stages: readonly Stage[], current: number): string {
  return `<ol class="rail">${stages.map((s, i) => `<li class="${i < current ? "past" : i === current ? "now" : ""}"><b>${String(i + 1)}</b> ${esc(s.title)}</li>`).join("")}</ol>`;
}

/** The short cut: position, the seven bound stages, and how to check. Throws when any stage lacks its evidence. */
export function shortScenes(ev: Evidence, binding: DemoBinding, mainnetShown: boolean): Scene[] {
  const stages = revocationStory(ev);
  const missing = stages.flatMap((s) => s.missing.map((m) => `${s.title}: ${m}`));
  if (missing.length > 0) throw new Error(`demo.json lacks evidence for the short cut: ${missing.join("; ")}`);
  const unbound = unboundReceipts(ev, stages);
  if (unbound.length > 0) throw new Error(`receipts not bound to any story stage: ${unbound.join(", ")}`);
  const status = certification(binding);
  const mainnet = mainnetShown ? "Mainnet receipts are on the evidence page." : "Mainnet run: pending approval — no mainnet transaction has been executed.";
  const mainnetCaption = mainnetShown ? "Mainnet receipts are on the evidence page." : "Mainnet run pending approval; no mainnet transaction executed.";
  return [
    {
      kind: "summary",
      labels: DEMO_LABELS,
      title: "Delegate trading within on\u2011chain limits",
      body: `<p class="claim">Revoke the entire grant—including outstanding signed orders—and recover the remaining assets.</p>${rail(stages, -1)}<p class="note">One sandbox run. Every number shown comes from out/evidence/demo.json.</p>`,
      captions: ["Delegate trading within on-chain limits. Revoke the entire grant, including outstanding signed orders, and recover the remaining assets."],
    },
    ...stages.map((s, i): Scene => ({
      kind: "demo",
      labels: s.labels.map(sentenceCase),
      title: `${String(i + 1)} · ${s.title}`,
      body: `${rail(stages, i)}<p class="headline">${esc(s.headline ?? "")}</p>${kv(s.facts)}<p class="bound">Evidence: ${[
        ...s.receipts.map(({ receipt }) => `tx ${esc(shortHash(receipt.tx_hash ?? receipt.label))}${receipt.outcome === "failure" ? " (failed)" : ""}`),
        ...s.checks.map((c) => `${esc(c.id)} ${c.held === true ? "held" : "did not hold"}`),
      ].join(" · ")}</p>`,
      captions: [s.caption ?? ""],
    })),
    {
      kind: "summary",
      title: "Check it yourself",
      body: `${list([
        "<b>Watch</b> this video, or read the evidence page: each stage links to its transactions and checks.",
        `<b>Inspect mainnet receipts:</b> ${esc(mainnet)}`,
        "<b>Run</b> <code>make demo</code> and <code>make test</code>: no funds or model key needed.",
      ])}<p class="note">${esc(status.sentence)}</p>`,
      captions: [`Sandbox run with labelled test doubles. ${mainnetCaption} Reproduce it with make demo and make test.`],
    },
  ];
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
table.cases th { text-align: left; padding: 3px 20px 3px 0; font: 700 22px "SF Mono", Menlo, monospace; vertical-align: top; white-space: nowrap; }
.pill { display: inline-block; font: 600 17px "SF Mono", Menlo, monospace; padding: 4px 8px; margin: 2px; border-radius: 4px; border: 2px solid; }
.pill.ok { color: #6fcf9f; } .pill.warn { color: #e6b450; } .pill.bad { color: #ff8a7a; } .pill.none { color: #9a958a; border-style: dashed; }
.chip-line { font: 600 26px "SF Mono", Menlo, monospace; color: #e0866f; margin: 0 0 14px; }
.reason { margin: 10px 48px 0; font: 600 20px/1.3 "SF Mono", Menlo, monospace; color: #e0866f; max-height: 54px; overflow: hidden; }
.claim { font-size: 40px; line-height: 1.35; max-width: 1600px; }
.note { font-size: 22px; color: #e6b450; margin: 4px 0 8px; } table.cases small { font: 500 15px -apple-system, sans-serif; color: #a39d8f; }
img.shot { width: 100%; height: 690px; object-fit: contain; object-position: top center; border: 1px solid #2a3039; }
ol.rail { list-style: none; display: flex; gap: 10px; padding: 0; margin: 0 0 26px; } ol.rail li { flex: 1; font: 600 18px/1.25 -apple-system, "Helvetica Neue", sans-serif; color: #6d6a62; border-top: 6px solid #2a3039; padding-top: 8px; }
ol.rail li b { font-family: "SF Mono", Menlo, monospace; } ol.rail li.past { color: #a39d8f; border-color: #6fcf9f; } ol.rail li.now { color: #ece6d8; border-color: #e0866f; }
.headline { font-size: 64px; line-height: 1.12; font-weight: 600; margin: 0 0 22px; } .bound { font: 20px/1.45 "SF Mono", Menlo, monospace; color: #a39d8f; margin-top: 12px; }
.caption { position: absolute; left: 0; right: 0; bottom: 0; min-height: 150px; padding: 24px 80px; background: rgba(0,0,0,.82); color: #fff;
  font: 500 36px/1.35 -apple-system, "Helvetica Neue", Arial, sans-serif; text-align: center; display: flex; align-items: center; justify-content: center; }
`;

function slideHtml(s: Scene, caption: string, binding: DemoBinding): string {
  const labels = [...new Set([...(s.labels ?? []), ...KIND_LABEL[s.kind]])];
  const chips = labels.map((l) => `<span class="chip${/^(Recorded|Scripted|Ordinary)/.test(l) ? " model" : ""}">${esc(l)}</span>`).join("");
  const status = certification(binding);
  const reason = binding.certified ? "" : `<div class="reason">Not certified for this demo: ${esc(binding.reasons.join("; "))}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="top">${chips}<span class="chip acc${binding.certified ? " ok" : ""}">${esc(status.chip)}</span></div>${reason}
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
  for (const [name, selector] of Object.entries({ baselineTable: "#baseline table, #baseline" })) {
    const top = Number(await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top + window.scrollY`));
    shots[name] = await page.screenshot({ fullPage: true, clip: { x: 0, y: Math.max(0, top - 16), width: 1240, height: 560 } });
  }
  await page.close();
  return shots;
}

/** Packs whole sentences into frames of at most 24 words, so each burned-in caption stays readable. */
export const chunks = (caption: string): string[] => {
  const out: string[] = [];
  for (const sentence of caption.split(/(?<=[.!?:;])\s+(?=[A-Z0-9])/)) {
    const last = out.at(-1);
    const words = (t: string) => t.trim().split(/\s+/).length;
    if (last !== undefined && words(last) + words(sentence) <= 24) out[out.length - 1] = `${last} ${sentence.trim()}`;
    else out.push(sentence.trim());
  }
  return out;
};
/** Seconds on screen for a caption, in whole video frames; the short cut reads at about 3 words per second. */
const wholeFrames = (s: number): number => Math.round(s * FPS) / FPS;
const walkthroughPace = (text: string): number => wholeFrames(Math.min(9, Math.max(6, text.split(" ").length / 2.6 + 1.5)));
export const shortPace = (text: string): number => wholeFrames(Math.min(7.5, Math.max(5, text.split(" ").length / 3 + 0.8)));
export const SHORT_RANGE_S: readonly [number, number] = [45, 75];

const srtTime = (s: number): string => {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
};

interface Frame {
  file: string;
  seconds: number;
  caption: string;
  title: string;
  kind: Kind;
}

interface Cut {
  name: "short" | "walkthrough";
  mp4: string;
  srt: string;
  framesDir: string;
  scenes: Scene[];
  pace: (caption: string) => number;
  /** Allowed duration in seconds; the build fails outside it. */
  range: readonly [number, number] | null;
}

async function renderFrames(slide: PwPage, cut: Cut, binding: DemoBinding): Promise<Frame[]> {
  rmSync(cut.framesDir, { recursive: true, force: true });
  mkdirSync(cut.framesDir, { recursive: true });
  const frames: Frame[] = [];
  for (const scene of cut.scenes) {
    for (const caption of scene.captions.flatMap(chunks)) {
      const file = join(cut.framesDir, `${String(frames.length + 1).padStart(3, "0")}.png`);
      await slide.setContent(slideHtml(scene, caption, binding));
      await slide.screenshot({ path: file });
      frames.push({ file, seconds: cut.pace(caption), caption, title: scene.title, kind: scene.kind });
    }
  }
  return frames;
}

const hashOf = (p: string): string | null => (existsSync(p) ? sha256(readFileSync(p)) : null);

interface CutOutput {
  mp4: { path: string; sha256: string | null; bytes: number; duration_s: number };
  srt: { path: string; sha256: string | null };
  frames: { file: string; seconds: number; kind: Kind; title: string; caption: string }[];
}

function encode(cut: Cut, frames: readonly Frame[]): CutOutput {
  if (frames.length === 0) throw new Error(`${cut.name}: no frames`);
  // One looped input per frame, each exactly its caption's length, so the SRT timings match the video.
  const inputs = frames.flatMap((f) => ["-loop", "1", "-framerate", String(FPS), "-t", f.seconds.toFixed(4), "-i", f.file]);
  const filter = `${frames.map((_, i) => `[${String(i)}:v]`).join("")}concat=n=${String(frames.length)}:v=1:a=0,format=yuv420p[v]`;
  execFileSync(process.env.FFMPEG ?? "ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", filter, "-map", "[v]",
    "-r", String(FPS), "-c:v", "libx264", "-crf", "20", "-movflags", "+faststart", cut.mp4]);
  const duration = Number(execFileSync(process.env.FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", cut.mp4], { encoding: "utf8" }).trim());
  if (cut.range !== null && (duration < cut.range[0] || duration > cut.range[1])) {
    throw new Error(`${cut.name} cut is ${duration.toFixed(1)} s, outside ${String(cut.range[0])}-${String(cut.range[1])} s`);
  }
  let t = 0;
  const srt = frames.map((f, i) => {
    const line = `${String(i + 1)}\n${srtTime(t)} --> ${srtTime(t + f.seconds)}\n${f.caption}\n`;
    t += f.seconds;
    return line;
  });
  writeFileSync(cut.srt, srt.join("\n"));
  return {
    mp4: { path: rel(cut.mp4), sha256: hashOf(cut.mp4), bytes: readFileSync(cut.mp4).length, duration_s: duration },
    srt: { path: rel(cut.srt), sha256: hashOf(cut.srt) },
    frames: frames.map((f) => ({ file: rel(f.file), seconds: f.seconds, kind: f.kind, title: f.title, caption: f.caption })),
  };
}

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
  const binding = bindDemo(ev, acc, latestRunId(REPO_ROOT));
  const { steps, setupMs, storyMs } = parseLog(readFileSync(files.log, "utf8"), ev);
  const modelFixture = readFileSync(files.model);
  if (sha256(modelFixture) !== ev.source.fixtures["model/normal.json"]) throw new Error("fixtures/model/normal.json differs from the hash recorded in demo.json");
  const modelName = (JSON.parse(modelFixture.toString("utf8")) as { model: string }).model;
  const mainnetShown = liveView(loadLive(REPO_ROOT)).kind === "mainnet";

  const browser = await loadPlaywright().chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome", headless: true });
  const outputs: Partial<Record<Cut["name"], CutOutput>> = {};
  try {
    const shots = await pageShots(browser, files.page);
    const slide = await browser.newPage({ viewport: { width: W, height: H } });
    const cuts: Cut[] = [
      { name: "short", mp4: join(OUT, "bounded-mandate-short.mp4"), srt: join(OUT, "captions-short.srt"), framesDir: join(OUT, "frames-short"), scenes: shortScenes(ev, binding, mainnetShown), pace: shortPace, range: SHORT_RANGE_S },
      { name: "walkthrough", mp4: join(OUT, "bounded-mandate-demo.mp4"), srt: join(OUT, "captions.srt"), framesDir: join(OUT, "frames"), scenes: walkthroughScenes(ev, acc, binding, steps, shots, modelName), pace: walkthroughPace, range: null },
    ];
    for (const cut of cuts) outputs[cut.name] = encode(cut, await renderFrames(slide, cut, binding));
  } finally {
    await browser.close();
  }

  const tree = treeState(REPO_ROOT);
  const manifest = {
    schema: "bounded-mandate/video/2",
    generated_at: new Date().toISOString(),
    revision: tree.revision,
    dirty: tree.dirty,
    demo_revision: ev.source.product_commit,
    demo_dirty: ev.source.dirty,
    acceptance: acc === null ? null : { run_id: acc.run_id, revision: acc.revision, certified: acc.certified, complete: acc.complete },
    certification: { certified_for_this_demo: binding.certified, reasons: binding.reasons, inputs: binding.inputs },
    mainnet_receipts_shown: mainnetShown,
    sources: Object.fromEntries(Object.entries(files).map(([k, p]) => [k, { path: rel(p), sha256: hashOf(p) }])),
    demo_timing_ms: { setup: setupMs, story: storyMs },
    tools: { ffmpeg: execFileSync(process.env.FFMPEG ?? "ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0] ?? "unknown" },
    cuts: outputs,
  };
  writeFileSync(join(OUT, "video.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, o] of Object.entries(outputs)) console.log(`${name}: ${o.mp4.path} ${o.mp4.duration_s.toFixed(1)} s, ${String(o.mp4.bytes)} bytes, sha256 ${o.mp4.sha256 ?? "?"}`);
  console.log(`${certification(binding).chip}${binding.certified ? "" : `: ${binding.reasons.join("; ")}`}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
