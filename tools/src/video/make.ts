// Builds two captioned videos from the files of one actual run: a short cut (45-90 s) that states the problem in one line,
// then tells the run in four scenes with one provenance label each and a state strip (the agent trades; hostile requests
// are refused and one signed order is held back; the owner revokes and the verifier rejects that order; the funds
// return) and ends with where to verify; and the longer technical walkthrough of the same run, numbered by the owner's
// eight steps, with an attack-log segment, gates and provenance. Every frame is checked to fit before it is captured.
// When out/evidence/live-mainnet.json records a completed mainnet run, both cuts carry a mainnet segment built from it
// (the trade, the confirmed key removal, the rejection of the withheld order and the recovery, each with its
// transaction); without one, each cut states what it does not show (mainnetCut).
// Captions only; any narration is added later by the owner. Not part of make test, make demo or CI.
//
// Usage (from the repository root):
//   make test                                      # required for certified gate results; optional for a demo-only cut
//   mkdir -p out/video
//   set -o pipefail; make demo 2>&1 | tee out/video/demo.log  # must be the run that wrote demo.json
//   cd tools && npx --no-install tsx src/video/make.ts [--log ../out/video/demo.log]
//
// Inputs: out/evidence/demo.json, out/evidence/acceptance.json (optional), out/page/index.html, the demo log,
// fixtures/model/normal.json, and the console screenshots demo.json records (out/console/screens/demo-*.png, by sha256). Outputs in out/video/: bounded-mandate-short.mp4 with captions-short.srt and
// frames-short/*.png; bounded-mandate-demo.mp4 (walkthrough) with captions.srt and frames/*.png; video.json
// (source hashes, revision, certification, and per cut its output hashes, duration and frame list).
//
// Extra prerequisites (not npm dependencies of this package):
//   - ffmpeg and ffprobe on PATH (FFMPEG / FFPROBE override), e.g. Homebrew ffmpeg.
//   - Google Chrome (PW_CHANNEL override, default "chrome").
//   - playwright-core from the globally installed playwright-cli: $(npm root -g)/@playwright/cli/node_modules/playwright-core
//     (PLAYWRIGHT_CORE overrides the path).
//
// Every number shown is read from the input files; the script refuses a log that is not from the demo.json run. The
// short cut names `make verify` and `make quick` only when the Makefile has those targets.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { REPO_ROOT, reportsDir, treeState } from "../evidence/report.js";
import { REQUIRED_CASES } from "../evidence/required.js";
import { bindDemo, latestRunId, type DemoBinding } from "../evidence/binding.js";
import type { Acceptance } from "../evidence/schema.js";
import { z } from "zod";
import { EXPLORER_TX, LIVE_MAINNET_PATH, RELAY_STEP_ONLY, isTxHash, liveView, loadLive, runVerdict, type LiveView } from "../page/mainnet.js";
import { loadReportFiles } from "../page/casefiles.js";
import { GATE_LABEL, HEADLINE, POSITION, escapeHtml as esc, loadAcceptance } from "../page/render.js";
import { sandboxResults } from "../page/results.js";
import { AGENT_OBJECTIVE, allocation, attackRows, isoNs, modelReason, ownerJourney, priceText, readable, revocationStory, share, shortHash, unboundReceipts, units, usdc, withheldIdentity, wnear, type JourneyStep, type StageKey } from "../page/story.js";
import { CONSOLE_BROWSER_LABEL, ConsoleReview, ConsoleRevoke, OWNER_CONTROLS_LABEL, PLANNED_LABEL, PLANNED_URLS, REPO_URL, demoSteps, type Screenshot, type StepState } from "../evidence/journey.js";
import { Evidence, type Assertion, type Receipt } from "../types.js";

const OUT = join(REPO_ROOT, "out/video");
const W = 1920;
const H = 1080;
const FPS = 30;

// ---- inputs --------------------------------------------------------------------------------------

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
const rel = (p: string): string => relative(REPO_ROOT, p);

export interface LogStep {
  title: string;
  lines: { ok: boolean; gate: string; text: string }[];
}

export function parseLog(text: string, ev: Evidence): { steps: LogStep[]; setupMs: number; storyMs: number } {
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

type Kind = "demo" | "summary";

const DEMO_LABELS = ["Local NEAR sandbox", "Real Intents verifier WASM", "Test doubles: MPC, oracle, tokens", "No mainnet"];
const KIND_LABEL: Record<Kind, string[]> = {
  demo: DEMO_LABELS,
  summary: ["Summary of run files", "Sandbox results only", "No mainnet"],
};

interface Scene {
  kind: Kind;
  /** Extra execution labels for this scene, e.g. recorded genuine model output or scripted attacks. */
  labels?: string[];
  /** The scene's single provenance label; when set, it replaces the labels and the kind's labels on the slide. */
  provenance?: string;
  title: string;
  body: string;
  captions: string[];
  /** State strip in the lower half: the recorded chain state (null: not recorded); absent: no strip. */
  strip?: StepState | null;
  /** Stage label shown in the strip. */
  stage?: string;
  /** A scene of the mainnet segment: the slide names the run's revision where sandbox scenes show the demo's certification. */
  mainnet?: { revision: string };
}

const list = (items: string[]): string => `<ul>${items.map((i) => `<li>${i}</li>`).join("")}</ul>`;
const kv = (rows: [string, string][]): string => `<table class="kv">${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
const img = (png: Buffer, cls = ""): string => `<img class="shot${cls === "" ? "" : ` ${cls}`}" src="data:image/png;base64,${png.toString("base64")}" alt="">`;

/** The only place the video may say "certified": a certified acceptance run bound to this demo. */
function certification(binding: DemoBinding): { chip: string; sentence: string } {
  return binding.certified
    ? { chip: "Certified for this demo", sentence: "Certified for this demo: the latest certified acceptance run binds to this demo's clean revision, spec, fixtures and every deployed WASM." }
    : { chip: "Not certified for this demo", sentence: `Not certified for this demo: ${binding.reasons.join("; ")}. No gate counts as passed.` };
}

export function walkthroughScenes(ev: Evidence, acc: Acceptance | null, binding: DemoBinding, steps: LogStep[], shots: Record<string, Buffer>, modelName: string, results?: ReturnType<typeof sandboxResults>, mainnet: MainnetCut = mainnetCut({ kind: "absent" })): Scene[] {
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
  const recorded = demoSteps(ev.environment) ?? [];
  /** Chain state recorded at the end of the demo step with this title prefix. */
  const stateAfter = (prefix: string): StepState | null => recorded.find((s) => s.step.startsWith(prefix))?.state ?? null;
  const checks = (s: LogStep): string => list(s.lines.map((l) => `<span class="${l.ok ? "ok" : "bad"}">${l.ok ? "ok" : "FAIL"}</span> <code>[${esc(l.gate)}]</code> ${esc(l.text)}`));
  const status = certification(binding);
  // A scene narrates success only when its story stage held; otherwise it narrates the stage's outcome.
  const story = new Map(revocationStory(ev).map((s) => [s.key, s]));
  const held = (key: StageKey): boolean => story.get(key)?.outcome === "held";
  const narrate = (key: StageKey, success: string): string => (held(key) ? success : (story.get(key)?.caption ?? `${key}: not in this evidence.`));
  /** The success title only when the stage held; otherwise a neutral title with the stage's outcome. */
  const outcomeTitle = (key: StageKey, n: string, success: string, neutral: string): string => (held(key) ? `${n} · ${success}` : `${n} · ${neutral}: ${story.get(key)?.outcome ?? "missing"}`);

  const consoleStep = stepOf("Mandate reviewed in the console");
  const review = ConsoleReview.safeParse(obs("console-review"));
  const grantStep = stepOf("Grant and limits");
  const initial = (obs("grant-initial-value") as { contract: string }).contract;
  const model = stepOf("Bounded agent proposal");
  const modelObs = obs("model-proposal-on-chain") as {
    mode?: string;
    order?: { sell_amount: string; concession_bps: number } | null;
    decision: { prompt_sha256: string; raw_output_sha256: string; adapter_verdict?: { kind: string; proposal?: { sell: string; sell_amount: string; max_concession_bps: number } } } | null;
  };
  const decision = modelObs.decision;
  const verdict = decision?.adapter_verdict;
  // The trade is model output only when the replayed verdict was a proposal; otherwise the demo used a scripted one.
  const proposal = modelObs.mode === "recorded-model" && verdict?.kind === "proposal" && verdict.proposal !== undefined ? verdict.proposal : null;
  const reason = modelReason(ev);
  const fill = stepOf("Filler fills");
  const trade = (obs("trade-executed") as { signed: { sell_amount: string; buy_amount: string }; before: Record<string, string>; after: Record<string, string> });
  const alloc = allocation(ev);
  const allocRows: [string, string][] = alloc.ok
    ? [
        ["USDC share of value", `${share(alloc.value.before.usdcShare)} → ${share(alloc.value.after.usdcShare)} (agent's target 50%)`],
        ["Reference prices", `${priceText(alloc.value.reference)} (grant's initial reference, sandbox test double)`],
      ]
    : [];
  const withheld = stepOf("Second signed order withheld");
  const identity = withheldIdentity(ev);
  const identityRows: [string, string][] =
    identity === null
      ? []
      : [
          ["Order", `${identity.order_id} (epoch ${String(identity.epoch)})`],
          ["Mandate nonce", identity.mandate_nonce],
          ...(identity.deadline_ns === null ? [] : [["Deadline", isoNs(identity.deadline_ns)] as [string, string]]),
          ["Signing key", identity.signing_public_key],
          ["Bundle sha256", identity.bundle_sha256],
          ["simulate_intents", identity.simulation],
        ];
  const rows = attackRows(ev);
  const layers = [...new Set(rows.map((r) => r.layer))];
  const revoke = stepOf("Owner revokes");
  const relay = stepOf("Withheld order relayed");
  const rejected = (obs("withheld-rejected") as { error: string; relay_block_time_ns: string; order_deadline_ns: string; nonce_used: boolean; verifier_receipt?: { block_time_ns: string } | null });
  // The failed verifier receipt's block time when recorded, as on the page.
  const rejectedAt = rejected.verifier_receipt?.block_time_ns ?? rejected.relay_block_time_ns;
  const secondsLeft = Number((BigInt(rejected.order_deadline_ns) - BigInt(rejectedAt)) / 1_000_000_000n);
  const atBroadcast = units((BigInt(rejected.order_deadline_ns) - BigInt(rejected.relay_block_time_ns)).toString(), 9, 1);
  const rejectReason = /ExecutionError\\?":\\?"([^"\\]+)/.exec(rejected.error)?.[1] ?? rejected.error;
  const disabled = stepOf("Agent, oracle and MPC disabled");
  const recovery = stepOf("Recovery to the owner");
  const rec = (obs("recovered") as { recovered: { usdc: string; wnear: string }; mandate_final: { usdc: string; wnear: string } });
  const withdrawalStep = stepOf("Owner withdrawal");
  const withdrawal = story.get("withdrawn");

  // One pill per required case; a case the acceptance run did not evaluate (e.g. added later) is shown as such.
  const pill = (g: string, name: string): string => {
    const c = acc?.cases.find((x) => x.gate === g && x.case === name);
    if (c === undefined) return `<span class="pill none">${esc(name)}: ${acc === null ? "not run" : "not in this acceptance run"}</span>`;
    const cls = c.status === "passed" ? (binding.certified ? "ok" : "warn") : "bad";
    return `<span class="pill ${cls}">${esc(name)}: ${esc(c.status)}</span>`;
  };
  const caseRows = Object.entries(REQUIRED_CASES)
    .map(([g, names]) => `<tr><th>${esc(g)}<br><small>${esc(GATE_LABEL[g] ?? "")}</small></th><td>${names.map((n) => pill(g, n)).join(" ")}</td></tr>`);
  // Keep the expanded gate inventory readable at 1080p rather than shrinking or clipping its rows.
  const gatePages = Array.from({ length: Math.ceil(caseRows.length / 10) }, (_, i) => caseRows.slice(i * 10, (i + 1) * 10));
  const counted = Object.entries(REQUIRED_CASES).flatMap(([g, names]) => names.filter((n) => acc?.cases.some((c) => c.gate === g && c.case === n && c.status === "passed"))).length;
  const totalCases = Object.values(REQUIRED_CASES).flat().length;
  const t5 = acc?.baseline ?? null;

  const rescue = acc?.separate.find((c) => c.id === "RESCUE.owner-key");
  const attackScenes = layers.map((layer, i): Scene => {
    const of = rows.filter((r) => r.layer === layer);
    const where = [...new Set(of.map((r) => r.where))].join("; ");
    const confirmed = of.filter((r) => r.passed && r.contained === true).length;
    return {
      kind: "demo",
      labels: ["Scripted attacks"],
      title: `3${String.fromCharCode(97 + i)} · Attack log: ${layer}, ${String(confirmed)} of ${String(of.length)} refused`,
      // The chain state is unchanged across the attacks, so the log takes the strip's space.
      body: `<p class="note">${esc(where)}</p><table class="log">${of
        .map(
          (r) =>
            `<tr><td class="${r.passed && r.contained === true ? "ok" : "bad"}">${r.passed && r.contained === true ? "refused" : r.passed && r.contained === null ? "unverified" : "NOT HELD"}</td><td>${esc(r.description)}</td><td><code>${esc((r.reason ?? "").slice(0, 70))}</code></td><td><code>${esc(r.source === null ? (r.tx_hash === null ? "no transaction" : `tx ${shortHash(r.tx_hash)}`) : `${r.source.file}:${String(r.source.line)}`)}</code></td></tr>`,
        )
        .join("")}</table>`,
      captions: [
        confirmed === of.length
          ? `${sentenceCase(layer)}: ${String(of.length)} hostile ${of.length === 1 ? "request" : "requests"} refused, each with no state change.`
          : `${sentenceCase(layer)}: refusal at the expected layer with no state change was confirmed for ${String(confirmed)} of ${String(of.length)} requests.`,
      ],
    };
  });
  const out: Scene[] = [
    {
      kind: "summary",
      // The sandbox labels end in "No mainnet"; with a recorded mainnet run the opening says instead what follows.
      ...(mainnet.kind === "complete"
        ? { provenance: "Summary · one local sandbox run with test doubles, then one NEAR mainnet run" }
        : mainnet.kind === "incomplete"
          ? { provenance: "Summary · one local sandbox run with test doubles" }
          : { labels: DEMO_LABELS }),
      title: HEADLINE,
      body: `<p class="claim">The mandate contract builds and signs every trade itself; the agent can only propose within immutable limits. After the owner's confirmed key removal, withheld signed orders fail, and the owner recovers assets without the agent, oracle or signer.</p>${rail(ownerJourney(ev, [...story.values()]), -1)}`,
      captions: [HEADLINE, "Claim: the contract builds and signs every trade; after confirmed key removal, withheld orders fail and the owner recovers without agent, oracle or signer.", status.sentence],
    },
    {
      kind: "demo",
      title: outcomeTitle("limits", "1a", "Grant and limits", "Grant and limits"),
      body: txs(/grant/) + checks(grantStep),
      captions: [narrate("limits", `The owner grants the mandate. Initial reference value: $${units(initial, 12, 2)}. Limits are fixed for the grant; the agent cannot change them.`)],
      strip: stateAfter("Grant and limits"),
    },
    {
      kind: "demo",
      labels: [sentenceCase(CONSOLE_BROWSER_LABEL)],
      title: outcomeTitle("console", "1b", "Mandate reviewed in the console", "Console review"),
      body: (() => {
        const shown = review.success ? review.data.rendered : undefined;
        const rows: [string, string][] =
          shown === undefined
            ? review.success
              ? [["Console", "this evidence records no values read from the rendered console"]]
              : []
            : [
                ["Console read", `${/final block #[0-9]+/.exec(shown.badge)?.[0] ?? "block not shown"} of the sandbox`],
                ["Grant", `${shown.grant_status} · key ${shown.key_on_verifier}`],
                ["Largest order", shown.limits.find(([k]) => k === "Largest single order")?.[1] ?? "not shown"],
                ["Mandate holds", `${shown.mandate_balances.USDC ?? "?"} USDC, ${shown.mandate_balances.wNEAR ?? "?"} wNEAR`],
                ["Signer", OWNER_CONTROLS_LABEL],
              ];
        const shot = shots.consoleReview;
        return shot === undefined ? kv(rows) + checks(consoleStep) : `<div class="split"><div>${kv(rows)}${checks(consoleStep)}</div>${img(shot, "side")}</div>`;
      })(),
      captions: [narrate("console", story.get("console")?.caption ?? "")],
      strip: stateAfter("Mandate reviewed in the console"),
    },
    proposal === null || decision === null
      ? {
          kind: "demo",
          labels: ["Scripted proposal"],
          title: "2a · Scripted proposal, not model output",
          body:
            kv([
              ["Proposal", modelObs.order == null ? "not in this evidence" : `sell ${usdc(modelObs.order.sell_amount)}, concession ${String(modelObs.order.concession_bps)} bps`],
              ["Recorded model verdict", verdict === undefined ? "none" : verdict.kind],
            ]) +
            txs(/propose_order \((order 1|first order)\)/) +
            checks(model),
          captions: [
            "The first proposal was scripted.",
            ...(held("trade") ? [] : [narrate("trade", "")]),
          ],
          strip: stateAfter("Bounded agent proposal"),
        }
      : {
      kind: "demo",
      labels: ["Recorded genuine model output"],
      title: A.get("model-proposal-on-chain")?.passed === true
        ? `2a · Recorded genuine model output, ${modelName} (replayed)`
        : "2a · Recorded proposal: on-chain check did not hold",
      body: kv([
        ["Model", modelName],
        ["Proposal", `sell ${usdc(proposal.sell_amount)}, max concession ${String(proposal.max_concession_bps)} bps`],
        ...(reason === null ? [] : [["Reason (recorded)", reason.length > 260 ? `${reason.slice(0, 257)}…` : reason] as [string, string]]),
        ["Prompt sha256", decision.prompt_sha256],
        ["Raw output sha256", decision.raw_output_sha256],
      ]) + txs(/propose_order \((order 1|first order)\)/) + checks(model),
      captions: [narrate("trade", `Recorded genuine model output, ${modelName}, replayed with no provider call: sell ${usdc(proposal.sell_amount)} for wNEAR, at most ${String(proposal.max_concession_bps)} bps concession. The contract signs it.`)],
      strip: stateAfter("Bounded agent proposal"),
    },
    {
      kind: "demo",
      title: outcomeTitle("trade", "2b", "Trade on the real verifier WASM", "Trade"),
      body: kv([
        ["Signed sell", usdc(trade.signed.sell_amount)],
        ["Signed buy", wnear(trade.signed.buy_amount)],
        ["Mandate USDC", `${usdc(trade.before.usdc ?? "0")} → ${usdc(trade.after.usdc ?? "0")}`],
        ["Mandate wNEAR", `${wnear(trade.before.wnear ?? "0")} → ${wnear(trade.after.wnear ?? "0")}`],
        ...allocRows,
      ]) + txs(/execute_intents order|settle_order/) + checks(fill),
      captions: [narrate("trade", `Our filler fills it on the pinned mainnet verifier WASM, running in the sandbox: the mandate pays ${readable("usdc", trade.signed.sell_amount)} and receives ${readable("wnear", trade.signed.buy_amount)}, exactly as signed.`)],
      strip: stateAfter("Filler fills"),
    },
    ...attackScenes,
    {
      kind: "demo",
      labels: ["Scripted proposal"],
      title: outcomeTitle("withheld", "4", "A second signed order is withheld", "Withheld order"),
      body: kv(identityRows) + txs(/scripted, withheld/) + checks(withheld),
      captions: [
        narrate(
          "withheld",
          identity === null
            ? "A scripted second order is signed and withheld. Before revocation the verifier would still accept it."
            : `A scripted second order (order id ${identity.order_id}) is signed and withheld. Before revocation the verifier's simulation accepts this exact bundle.`,
        ),
      ],
      strip: stateAfter("Second signed order withheld"),
    },
    {
      kind: "demo",
      labels: story.get("revoked")?.labels.map(sentenceCase) ?? [],
      title: outcomeTitle("revoked", "5", "Owner revokes in the console; key removal confirmed", "Owner revokes"),
      body: (() => {
        const facts = kv((story.get("revoked")?.facts ?? []).filter(([k]) => ["Through", "Preview", "Sign requests"].includes(k)));
        const shot = shots.revokePreview;
        return shot === undefined ? facts + txs(/^owner revoke/) + checks(revoke) : `<div class="split"><div>${facts}${txs(/^owner revoke/)}${checks(revoke)}</div>${img(shot, "side")}</div>`;
      })(),
      captions: [narrate("revoked", story.get("revoked")?.caption ?? "The owner revokes.")],
      strip: stateAfter("Owner revokes"),
    },
    {
      kind: "demo",
      title: outcomeTitle("rejected", "6", "The withheld order is relayed and rejected", "The withheld order is relayed"),
      body:
        kv([["Verifier error", rejectReason], ["Lifetime left at broadcast", `${atBroadcast} s`], ["Time left at rejection", `${String(secondsLeft)} s`], ["Nonce used", String(rejected.nonce_used)]]) +
        txs(/withheld order after revocation/) +
        checks(relay),
      captions: [narrate("rejected", `Another account relays the withheld order ${String(secondsLeft)} s before its deadline. The verifier rejects it: the key no longer exists.`)],
      strip: stateAfter("Withheld order relayed"),
    },
    {
      kind: "demo",
      labels: ["Ordinary recovery (not the owner-key rescue)"],
      title: outcomeTitle("recovered", "7", "Ordinary recovery with agent, oracle and MPC unavailable", "Recovery"),
      body: kv([["Recovered", `${usdc(rec.recovered.usdc)} and ${wnear(rec.recovered.wnear)}`], ["Destination", `${ev.identifiers.owner ?? "owner"} (owner's Intents account)`], ["Mandate left", `${usdc(rec.mandate_final.usdc)}, ${wnear(rec.mandate_final.wnear)}`]]) + txs(/set_fail|set_mode|after revocation/) + txs(/^owner recover/) + checks(disabled) + checks(recovery),
      captions: [narrate("recovered", `With the oracle failing and the MPC test double on hold, the owner recovers ${usdc(rec.recovered.usdc)} and ${wnear(rec.recovered.wnear)} into its Intents account through ordinary recovery.`)],
      strip: stateAfter("Recovery to the owner"),
    },
    {
      kind: "demo",
      labels: ["Owner action, outside recovery claims"],
      title: outcomeTitle("withdrawn", "8", "Owner withdrawal to its NEAR account", "Owner withdrawal"),
      body: kv(withdrawal?.facts ?? []) + txs(/^owner storage_deposit|^owner ft_withdraw/) + checks(withdrawalStep),
      captions: [withdrawal?.caption ?? "Owner withdrawal: not in this evidence."],
      strip: stateAfter("Owner withdrawal"),
    },
    ...mainnetScenes(mainnet, "walkthrough"),
    ...gatePages.map((rows, i): Scene => ({
      kind: "summary",
      title: `Acceptance gates: ${String(counted)} of ${String(totalCases)} passed · ${String(i + 1)}/${String(gatePages.length)}`,
      body: `${binding.certified ? "" : `<p class="note">Amber: passed in the acceptance run, but not certified for this demo.</p>`}<div class="split"><table class="cases">${rows.slice(0, Math.ceil(rows.length / 2)).join("")}</table><table class="cases">${rows.slice(Math.ceil(rows.length / 2)).join("")}</table></div><p class="note">Emergency owner-key rescue, reported separately and never counted toward T4: ${esc(rescue === undefined ? "not reported" : rescue.status)}.</p>`,
      captions: [i === 0 ? (binding.certified ? `${String(counted)} of ${String(totalCases)} required cases passed, certified for this demo.` : `${String(counted)} of ${String(totalCases)} required cases passed, but this run is not certified for this demo.`) : "The remaining required cases, including the historical replay, sandbox lab and independent client example.", ...(i === gatePages.length - 1 ? ["The emergency owner-key rescue is reported separately; it never counts as ordinary recovery."] : [])],
    })),
    ...(results?.trades == null || results.alternatives == null ? [] : [proofScene(results.trades.data, results.alternatives.data)]),
    {
      kind: "summary",
      title: "T5 · our re-implementation of the Claw Guard design",
      body: t5 === null
        ? '<p class="note">No T5 report in this acceptance run.</p>'
        : `<table class="log baseline"><thead><tr><th>Threat or control</th><th>Re-implemented baseline</th><th>Mandate gate</th></tr></thead><tbody>${t5.cases.map((c) => `<tr><td>${esc(c.threat)}</td><td>${esc(c.baseline_outcome.replaceAll("_", " "))}</td><td><code>${esc(c.compare_gate)}</code></td></tr>`).join("")}</tbody></table><p class="note">The comparison used the same sandbox verifier and authority in both systems.</p>`,
      captions: [
        t5 === null
          ? "T5 compares against our own re-implementation of the pinned Claw Guard design; this evidence has no T5 report, so differentiation is unproven."
          : `T5 runs the same threats against our own re-implementation of the pinned Claw Guard design, not the deployed product: ${String(t5.cases.filter((c) => c.baseline_outcome === "attack_succeeded").length)} of ${String(t5.cases.length)} cases executed as successful attacks.`,
      ],
    },
    {
      kind: "summary",
      title: "Limits",
      body: list([...ev.unknowns, status.sentence, ...(mainnet.kind === "none" ? [] : [mainnet.statement])].map(esc)),
      captions: [
        `Limits: ${
          mainnet.kind === "complete"
            ? "the sandbox scenes use test doubles for MPC, oracle and tokens, and the mainnet segment is one approved run"
            : mainnet.kind === "none"
              ? "sandbox only, with test doubles for MPC, oracle and tokens; no mainnet execution"
              : "the scenes are sandbox only, with test doubles for MPC, oracle and tokens"
        }; ${proposal === null ? "the first order used a scripted proposal, not model output" : "the model step is a replay"}. No guarantee of profit or a maximum loss.`,
        ...(mainnet.kind === "incomplete" || mainnet.kind === "not-evidence" ? [mainnet.statement] : []),
        "Revocation is not instant: signed orders can still execute while it is pending. The claim covers orders after confirmed key removal.",
      ],
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
        [`Page and console (${PLANNED_LABEL})`, `${PLANNED_URLS.page} · ${PLANNED_URLS.console}`],
      ]),
      captions: [status.sentence],
    },
  ];
  const hidden = ev.receipts.filter((_, i) => !shown.has(i)).map((r) => r.label);
  if (hidden.length > 0) throw new Error(`receipts not shown in any scene: ${hidden.join(", ")}`);
  return out;
}

function proofScene(trades: NonNullable<ReturnType<typeof sandboxResults>["trades"]>["data"], alternatives: NonNullable<ReturnType<typeof sandboxResults>["alternatives"]>["data"]): Scene {
  const executed = (relays: readonly { executed: boolean }[]) => `${String(relays.filter((r) => r.executed).length)}/${String(relays.length)}`;
  const rows: [string, string][] = alternatives.strategies.map((s) => [s.strategy,
    `${s.resume.while_removed === undefined ? "" : `${executed(s.resume.while_removed)} while absent → `}${executed(s.withheld_relays_after_action)} executed · ${String(s.account_key_signatures_for_the_action)} order-key signatures`,
  ]);
  return {
    kind: "summary",
    title: "Useful trades and matched revocation controls",
    body: kv([
      ["Legitimate scripted trades", `${String(trades.completed)}/${String(trades.attempted)} settled · ${String(trades.authorization_refused)} authorization refusals`],
      ...rows,
    ]) + '<p class="note">Selected cases on the pinned verifier. Nonce cancellation needs the list and an available signer. Removal covers the key after confirmation.</p>',
    captions: [
      `${String(trades.completed)} of ${String(trades.attempted)} selected legitimate sandbox trades executed and settled, with ${String(trades.authorization_refused)} authorization refusals.`,
      "Complete-list nonce cancellation works with the signer. Confirmed removal covers outstanding orders even when the owner lacks their nonces. Keep the old key retired when trading resumes.",
    ],
  };
}

const sentenceCase = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

function rail(steps: readonly JourneyStep[], current: number): string {
  return `<ol class="rail">${steps
    .map((j, i) => `<li class="${i < current ? "past" : i === current ? "now" : ""}${j.outcome === "held" ? "" : " off"}"><b>${String(j.n)}</b> ${esc(j.rail)}</li>`)
    .join("")}</ol>`;
}

const STATUS_CLASS: Record<JourneyStep["outcome"], string> = { held: "ok", "not-held": "bad", inconclusive: "warn", missing: "bad" };
const statusWord = (j: JourneyStep): string =>
  j.outcome === "held" ? j.done : j.outcome === "not-held" ? "did not hold" : j.outcome === "inconclusive" ? "inconclusive" : "not in this evidence";

/** The evidence a journey step is bound to: its transactions and its checks, condensed when there are many. */
const boundOf = (j: JourneyStep): string[] => {
  const checks = j.stages.flatMap((s) => s.checks);
  const many = checks.length > 8;
  return [
    ...j.stages.flatMap((s) => s.receipts.map(({ receipt }) => `tx ${esc(shortHash(receipt.tx_hash ?? receipt.label))}${receipt.outcome === "failure" ? " (failed)" : ""}`)),
    ...(many ? [`${String(checks.filter((c) => c.held === true).length)} of ${String(checks.length)} checks held`] : []),
    ...checks.filter((c) => !many || c.held !== true).map((c) => `${esc(c.id)} ${c.held === true ? "held" : "did not hold"}`),
  ];
};

/** One short-cut scene's slide: the rail, then each of its journey steps with its recorded status and outcome line. */
const beatsBody = (steps: readonly JourneyStep[], of: readonly number[]): string => {
  const beats = of.flatMap((i) => {
    const j = steps[i];
    if (j === undefined) return [];
    const facts = j.key === "attacks" ? `<dl class="attack-facts">${j.stages.flatMap((s) => s.facts).map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>` : "";
    return [`<div class="beat"><p class="status-line"><span class="pill ${STATUS_CLASS[j.outcome]}">${esc(statusWord(j))}</span> <b>${String(j.n)} · ${esc(j.outcome === "held" ? j.title : j.neutral)}</b></p><p class="beat-line">${esc(j.result ?? "")}</p>${facts}</div>`];
  });
  const bound = of.flatMap((i) => (steps[i] === undefined ? [] : boundOf(steps[i])));
  return `${rail(steps, of.at(-1) ?? -1)}${beats.join("")}<p class="bound">Evidence: ${bound.join(" · ")}</p>`;
};

// ---- mainnet segment -----------------------------------------------------------------------------

export interface MainnetTx {
  label: string;
  outcome: Receipt["outcome"];
  hash: string;
  /** The transaction on the explorer the evidence page links. */
  url: string;
}

export type MainnetPartKey = "trade" | "removal" | "rejection" | "recovery";

export interface MainnetPart {
  key: MainnetPartKey;
  title: string;
  /** What the run's own step verification recorded, as one or two sentences; also the part's caption. */
  line: string;
  txs: MainnetTx[];
}

/**
 * What a cut may show of mainnet. "complete": a recorded mainnet run that holds as a whole (runVerdict) and whose
 * trade, removal, rejection and recovery each have a verified step and a transaction; only then are there parts.
 * "incomplete": a mainnet run is recorded but is not shown as a completed run. "not-evidence": a live file exists but
 * is not mainnet evidence. "none": no run. Outside "complete" the cut has no mainnet scene and says `statement`.
 */
export interface MainnetCut {
  kind: "none" | "not-evidence" | "incomplete" | "complete";
  /** Mainnet transactions the evidence page presents (0 without a recorded mainnet run). */
  transactions: number;
  /** On the closing slide, and narrated in the walkthrough: the whole reason. */
  statement: string;
  /** In the short cut's closing caption: brief enough to share one frame with the sentence before it, so the cut keeps its length. */
  caption: string;
  /** Source revision the run was made from; null without a recorded mainnet run. */
  revision: string | null;
  parts: MainnetPart[];
}

const LIVE_STEP = /^step-([1-9][0-9]*)-([a-z_]+)(?:-attempt-([1-9][0-9]*))?$/;
const Digits = z.string().regex(/^[0-9]+$/);
const Balances = z.object({ usdc: Digits, wnear: Digits });
const LiveDetail = z.object({ step: z.union([z.number(), z.string()]).optional(), order_id: z.union([z.number(), z.string()]).optional() });
const FillObserved = z.object({ mandate_before: Balances, mandate_after: Balances });
const ProposeObserved = z.object({ order_id: z.union([z.number(), z.string()]) });
const RevokeObserved = z.object({ status: z.literal("revoked"), key_absent: z.literal(true) });
const RelayObserved = z.object({ classification: z.literal("rejected_revoked_key"), executed_at_ns: Digits, deadline_ns: Digits });
const RecoverObserved = z.object({ asset: z.enum(["usdc", "wnear"]), gained: Digits });

/** Mainnet amounts are small: wNEAR to six places, and never a non-zero amount written as zero. */
const liveAmount = (asset: "usdc" | "wnear", raw: string): string => {
  const text = asset === "usdc" ? units(raw, 6, 2) : units(raw, 24, 6).replace(/0+$/, "").replace(/\.$/, "");
  return BigInt(raw) !== 0n && /^[0.]+$/.test(text) ? `${raw} base units of ${asset === "usdc" ? "USDC" : "wNEAR"}` : `${text} ${asset === "usdc" ? "USDC" : "wNEAR"}`;
};

/**
 * The mainnet segment, from the live evidence alone. A part is built only from a step verification that held and names
 * what it claims: the removal needs the key recorded absent, the rejection the removed-key classification before the
 * order's deadline. Anything less leaves the cut without a segment and with a sentence saying why.
 */
export function mainnetCut(live: LiveView): MainnetCut {
  if (live.kind === "absent") {
    return { kind: "none", transactions: 0, statement: "Mainnet run: pending approval — no mainnet transaction has been executed.", caption: "Mainnet run pending approval; no mainnet transaction executed.", revision: null, parts: [] };
  }
  if (live.kind === "rejected") {
    return {
      kind: "not-evidence",
      transactions: 0,
      statement: `No mainnet run is shown: ${LIVE_MAINNET_PATH} is not mainnet evidence (${live.reasons.join("; ")}).`,
      caption: "No mainnet run is shown: the live evidence file is not mainnet evidence.",
      revision: null,
      parts: [],
    };
  }
  const ev = live.ev;
  const verdict = runVerdict(ev);
  const count = ev.receipts.length;
  const revision = ev.source.product_commit;
  const notShown = (why: string, brief: string): MainnetCut => ({
    kind: "incomplete",
    transactions: count,
    statement: `A mainnet run is recorded (${String(count)} transactions, on the evidence page) but is not shown here as a completed run: ${why}. This cut has no mainnet segment.`,
    caption: `A mainnet run is recorded but not shown as complete: ${brief}.`,
    revision,
    parts: [],
  });
  if (verdict.revocation.cls !== "success") {
    const brief = { failure: "its revocation test failed", inconclusive: "its revocation test is inconclusive", "not-run": "no withheld order was relayed" }[verdict.revocation.cls];
    return notShown(`its revocation test is not a pass (${verdict.revocation.text})`, brief);
  }
  if (!verdict.holds) {
    const shortfalls = [
      ...(verdict.failedSteps > 0 ? [`${String(verdict.failedSteps)} of ${String(verdict.steps)} step verifications did not hold`] : []),
      ...(verdict.failedPreflight > 0 ? [`${String(verdict.failedPreflight)} preflight checks did not hold`] : []),
      ...(verdict.stopped ? ["the run stopped"] : []),
      ...verdict.missing,
    ];
    return notShown(`the ${RELAY_STEP_ONLY}, and ${shortfalls.join("; ")}`, verdict.cls === "failure" ? "the run did not hold" : "the run is incomplete");
  }

  // Each step's latest attempt; in a run that holds, every one of them held.
  const latest = new Map<number, { kind: string; attempt: number; assertion: Assertion }>();
  for (const assertion of ev.assertions) {
    const m = LIVE_STEP.exec(assertion.id);
    if (m === null) continue;
    const step = Number(m[1]);
    const attempt = m[3] === undefined ? 1 : Number(m[3]);
    if ((latest.get(step)?.attempt ?? 0) < attempt) latest.set(step, { kind: m[2] ?? "", attempt, assertion });
  }
  const stepsOf = (...kinds: string[]): { step: number; observed: unknown }[] =>
    [...latest.entries()].filter(([, s]) => kinds.includes(s.kind) && s.assertion.passed).sort(([a], [b]) => a - b).map(([step, s]) => ({ step, observed: s.assertion.observed }));
  const detail = (r: Receipt) => LiveDetail.safeParse(r.detail).data ?? {};
  const txsOf = (step: number): MainnetTx[] =>
    ev.receipts.flatMap((r) => (r.tx_hash !== undefined && isTxHash(r.tx_hash) && String(detail(r).step) === String(step) ? [{ label: r.label, outcome: r.outcome, hash: r.tx_hash, url: `${EXPLORER_TX}${r.tx_hash}` }] : []));

  const fills = stepsOf("fill");
  const fill = fills[0];
  // The proposal behind the trade, when the fill's receipt and a proposal's verification name the same order.
  const filledOrder = fill === undefined ? undefined : ev.receipts.map(detail).find((d) => String(d.step) === String(fill.step))?.order_id;
  const proposal = filledOrder === undefined ? undefined : stepsOf("propose").find((p) => String(ProposeObserved.safeParse(p.observed).data?.order_id) === String(filledOrder));
  const moved = FillObserved.safeParse(fill?.observed).data;
  const delta = (asset: "usdc" | "wnear"): bigint => (moved === undefined ? 0n : BigInt(moved.mandate_after[asset]) - BigInt(moved.mandate_before[asset]));
  const [paid, received] = delta("usdc") < 0n ? (["usdc", "wnear"] as const) : (["wnear", "usdc"] as const);
  const tradeLine =
    moved !== undefined && delta(paid) < 0n && delta(received) > 0n
      ? `The mandate's order is filled: it pays ${liveAmount(paid, (-delta(paid)).toString())} and receives ${liveAmount(received, delta(received).toString())}.`
      : "The mandate's order is filled.";

  const revokes = stepsOf("revoke", "revoke_external");
  const relays = stepsOf("relay_withheld");
  const relay = RelayObserved.safeParse(relays[0]?.observed).data;
  const recovers = stepsOf("recover", "recover_external");
  const gained = new Map(recovers.flatMap((r) => { const o = RecoverObserved.safeParse(r.observed).data; return o === undefined ? [] : [[o.asset, o.gained] as const]; }));
  const usdcBack = gained.get("usdc");
  const wnearBack = gained.get("wnear");

  const parts: MainnetPart[] = [
    { key: "trade", title: "The trade", line: tradeLine, txs: [...(proposal === undefined ? [] : txsOf(proposal.step)), ...fills.flatMap((f) => txsOf(f.step))] },
    { key: "removal", title: "Key removal, confirmed", line: "The owner revokes. The grant key's removal from the Intents verifier is confirmed.", txs: revokes.flatMap((r) => txsOf(r.step)) },
    {
      key: "rejection",
      title: "The withheld order, rejected",
      line: relay === undefined ? "" : `The run's withheld order is relayed ${String((BigInt(relay.deadline_ns) - BigInt(relay.executed_at_ns)) / 1_000_000_000n)} s before its deadline. The verifier rejects it: the signing key no longer exists.`,
      txs: relays.flatMap((r) => txsOf(r.step)),
    },
    {
      key: "recovery",
      title: "Recovery",
      line: usdcBack === undefined || wnearBack === undefined ? "Recovery returns both assets to the owner's Intents account." : `Recovery returns ${liveAmount("usdc", usdcBack)} and ${liveAmount("wnear", wnearBack)} to the owner's Intents account.`,
      txs: recovers.flatMap((r) => txsOf(r.step)),
    },
  ];
  const lacking = [
    ...parts.filter((p) => p.txs.length === 0).map((p) => `no transaction of a verified step is recorded for ${p.key}`),
    ...(revokes.length > 0 && !revokes.every((r) => RevokeObserved.safeParse(r.observed).success) ? ["the revoke verification does not record the grant revoked with its key absent from the verifier"] : []),
    ...(relays.length > 0 && (relay === undefined || BigInt(relay.executed_at_ns) > BigInt(relay.deadline_ns)) ? ["the relay verification does not record a rejection before the order's deadline"] : []),
  ];
  if (lacking.length > 0) return notShown(`the run holds, but this cut cannot bind every part to its evidence: ${lacking.join("; ")}`, "its evidence is incomplete");
  const shown = parts.reduce((n, p) => n + p.txs.length, 0);
  return {
    kind: "complete",
    transactions: count,
    statement: `The mainnet segment shows ${String(shown)} of the run's ${String(count)} transactions; all ${String(count)} are listed on the evidence page with explorer links.`,
    caption: "Mainnet receipts are on the evidence page.",
    revision,
    parts,
  };
}

export const MAINNET_PROVENANCE = "NEAR mainnet · one approved run · recorded receipts";
const MAINNET_INTRO = "Separately, on NEAR mainnet, in one approved run.";

const partHtml = (p: MainnetPart): string =>
  `<div class="beat"><p class="status-line"><span class="pill ok">held on mainnet</span> <b>${esc(p.title)}</b></p><p class="beat-line">${esc(p.line)}</p>${p.txs
    .map((t) => `<p class="tx">${esc(t.label)}${t.outcome === "failure" ? (p.key === "rejection" ? " · failed, as the rejection requires" : " · failed") : ""}<br><code>${esc(t.url.replace(/^https:\/\//, ""))}</code></p>`)
    .join("")}</div>`;

/**
 * The mainnet segment's scenes; none unless the cut is complete. The short cut tells the four parts in two scenes, the
 * walkthrough one part per scene. Every sentence is the part's line, which mainnetCut built from the run's evidence.
 */
export function mainnetScenes(cut: MainnetCut, form: "short" | "walkthrough"): Scene[] {
  if (cut.kind !== "complete" || cut.revision === null) return [];
  const part = (key: MainnetPartKey): MainnetPart[] => cut.parts.filter((p) => p.key === key);
  const base = { kind: "demo" as const, provenance: MAINNET_PROVENANCE, mainnet: { revision: cut.revision } };
  if (form === "walkthrough") {
    return cut.parts.map((p, i): Scene => ({ ...base, title: `M${String(i + 1)} · Mainnet: ${p.title.charAt(0).toLowerCase()}${p.title.slice(1)}`, body: partHtml(p), captions: [i === 0 ? `${MAINNET_INTRO} ${p.line}` : p.line] }));
  }
  const pair = (title: string, keys: readonly [MainnetPartKey, MainnetPartKey], intro: string): Scene => {
    const ps = keys.flatMap(part);
    return { ...base, title, body: ps.map(partHtml).join(""), captions: ps.map((p, i) => (i === 0 && intro !== "" ? `${intro} ${p.line}` : p.line)) };
  };
  return [
    pair("On NEAR mainnet: a trade, then the owner removes the key", ["trade", "removal"], MAINNET_INTRO),
    pair("On NEAR mainnet: the withheld order is rejected; the assets return", ["rejection", "recovery"], ""),
  ];
}

/** The problem the short cut opens with, in one line. */
export const PROBLEM = "An agent holding a trading key can exceed your limits, and orders it already signed can outlive your decision to stop it.";
/** The product in two sentences: the page's, so the cut and the page cannot drift apart. */
export const LEAD = POSITION;
/** The source repository's URL, shown as text: the cut never says whether a URL is published. */
export const PLANNED_REPO = REPO_URL;

/** Reproduction paths the product actually ships, read from its Makefile. */
export interface Repro {
  /** The toolchain-free evidence check: "make verify", plus its direct node command when the recipe names one. */
  verify: string | null;
  /** Whether `make quick` (prebuilt, uncertified quick demo) exists. */
  quick: boolean;
}

export function reproFromMakefile(makefile: string): Repro {
  const recipe = (target: string): string[] | null => {
    const lines = makefile.split("\n");
    const at = lines.findIndex((l) => new RegExp(`^${target}:`).test(l));
    if (at < 0) return null;
    const body: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (!l.startsWith("\t")) break;
      body.push(l.trim());
    }
    return body;
  };
  const verify = recipe("verify");
  const script = verify?.map((l) => /\bnode (\S+\.mjs)/.exec(l)?.[1]).find((m) => m !== undefined);
  return { verify: verify === null ? null : script === undefined ? "make verify" : `make verify, or node ${script} with no install`, quick: recipe("quick") !== null };
}

/** The short cut's scenes: which journey steps each tells, in the order the cut tells them. */
type Beat = "trade" | "hostile" | "revoke" | "return";
const SHORT_BEATS: readonly { key: Beat; title: string; steps: readonly JourneyStep["key"][] }[] = [
  { key: "trade", title: "The agent trades inside fixed limits", steps: ["mandate", "trade"] },
  { key: "hostile", title: "Hostile requests are refused; one signed order is held back", steps: ["attacks", "withheld"] },
  { key: "revoke", title: "The owner revokes; the verifier rejects the held order", steps: ["revoked", "rejected"] },
  { key: "return", title: "The funds return to the owner", steps: ["recovered", "withdrawn"] },
];

/**
 * The short cut: the problem in one line, then the agent trades, hostile requests are refused while one signed order is
 * held back, the owner revokes and the verifier rejects that order, the funds return, and where to verify. One
 * provenance label per scene. Throws when any stage lacks its evidence.
 *
 * With a completed mainnet run the mainnet segment takes the place of the sandbox revocation and return scenes, which
 * the walkthrough still shows: both would not fit SHORT_RANGE_S, and the opening slide says which run tells which steps.
 */
export function shortScenes(ev: Evidence, binding: DemoBinding, mainnet: MainnetCut, repro: Repro = { verify: null, quick: false }): Scene[] {
  const stages = revocationStory(ev);
  const missing = stages.flatMap((s) => s.missing.map((m) => `${s.title}: ${m}`));
  if (missing.length > 0) throw new Error(`demo.json lacks evidence for the short cut: ${missing.join("; ")}`);
  const unbound = unboundReceipts(ev, stages);
  if (unbound.length > 0) throw new Error(`receipts not bound to any story stage: ${unbound.join(", ")}`);
  const steps = ownerJourney(ev, stages);
  const status = certification(binding);
  const step = (key: JourneyStep["key"]): JourneyStep | undefined => steps.find((j) => j.key === key);
  const labelled = (key: JourneyStep["key"], label: string): boolean => step(key)?.labels.includes(label) === true;
  // "Replayed model recording" only when the trade's proposal is recorded model output; a scripted one is never called that.
  const replayed = labelled("trade", "recorded genuine model output") && ev.environment.model_mode === "recorded-model";
  const segment = mainnetScenes(mainnet, "short");
  const sandbox = replayed ? "One local sandbox run with labelled test doubles and a replayed model recording" : "One local sandbox run with labelled test doubles and a scripted proposal, not model output";
  const what = segment.length === 0 ? sandbox : `${sandbox}, then one approved NEAR mainnet run`;
  // A recorded mainnet run, complete or not, is on the evidence page: the sandbox summary no longer says "no mainnet".
  const recorded = mainnet.kind === "complete" || mainnet.kind === "incomplete";
  const notShown = steps.filter((j) => j.outcome !== "held");
  // The story outcome is the demo's; the certification sentence is the acceptance run's. Neither implies the other.
  const storyCaption =
    notShown.length === 0 ? "" : `In this run ${String(notShown.length)} of ${String(steps.length)} journey steps are not shown as evidence: ${notShown.map((j) => `${j.neutral} (${j.outcome})`).join(", ")}. `;
  // The recovery scene says a double was off only when a successful receipt switching it off precedes the owner's first
  // recover receipt; whether recovery itself held is the scene's title, not this label.
  const recovery = stages.find((s) => s.key === "recovered");
  const firstRecover = Math.min(...(recovery?.receipts.filter((r) => /^owner recover/.test(r.receipt.label)).map((r) => r.index) ?? []));
  const offBefore = (label: string): boolean =>
    recovery?.receipts.some((r) => r.receipt.label === label && r.receipt.outcome === "success" && r.index < firstRecover) === true;
  const switchedOff = [...(offBefore("oracle set_fail(true)") ? ["oracle"] : []), ...(offBefore("mpc set_mode(hold)") ? ["MPC"] : [])];
  const returnLabel =
    switchedOff.length === 2
      ? "Local sandbox · oracle and MPC test doubles switched off"
      : switchedOff.length === 1
        ? `Local sandbox · ${switchedOff[0] ?? ""} test double switched off; ${switchedOff[0] === "oracle" ? "MPC" : "oracle"} not shown switched off`
        : "Local sandbox · oracle and MPC switch-off not shown";
  // One provenance label per scene, from the labels its stages carry.
  const provenance: Record<Beat, string> = {
    trade: `Local sandbox, test doubles · ${replayed ? "recorded model output, replayed" : "scripted proposal, not model output"}`,
    hostile: `Local sandbox · scripted attacks and order${labelled("attacks", "recorded genuine model output") ? ", one replayed model recording" : ""}`,
    revoke: `Local sandbox · ${labelled("revoked", OWNER_CONTROLS_LABEL) ? "owner console, test signer, not a wallet" : "direct owner call"}`,
    return: returnLabel,
  };
  const repro_ = [
    ...(repro.verify === null ? [] : [`Verify the evidence: ${repro.verify}.`]),
    ...(repro.quick ? ["Prebuilt, uncertified demo: make quick."] : ["Demo: make demo."]),
    "Certified path: make test && make demo.",
  ].join(" ");
  return [
    {
      kind: "summary",
      provenance: segment.length > 0 ? "Summary of one local sandbox run and one NEAR mainnet run" : `Summary of one local sandbox run${recorded ? "" : " · no mainnet"}`,
      title: HEADLINE,
      body: `<p class="claim problem">${esc(PROBLEM)}</p><p class="claim">${esc(LEAD)}</p>${rail(steps, -1)}<p class="objective">Agent's objective: ${esc(AGENT_OBJECTIVE)}. An instruction to the agent, not a rule the contract enforces.</p><p class="note">${esc(what)}. ${
        segment.length === 0
          ? "Every number shown comes from out/evidence/demo.json."
          : esc(`Sandbox numbers come from out/evidence/demo.json, mainnet ones from ${LIVE_MAINNET_PATH}. Revocation, rejection and recovery are told from the mainnet run; their sandbox recording and the owner's withdrawal are in the walkthrough.`)
      }</p>`,
      // The problem alone, then what the run is.
      captions: [PROBLEM, `${what}.`],
    },
    ...SHORT_BEATS.filter((beat) => segment.length === 0 || beat.key === "trade" || beat.key === "hostile").map((beat, b): Scene => {
      const of = beat.steps.flatMap((k) => { const i = steps.findIndex((j) => j.key === k); return i < 0 ? [] : [i]; });
      const js = of.flatMap((i) => (steps[i] === undefined ? [] : [steps[i]]));
      const off = js.filter((j) => j.outcome !== "held");
      const last = js.at(-1)?.stages.at(-1);
      return {
        kind: "demo",
        provenance: provenance[beat.key],
        title: off.length === 0 ? beat.title : off.map((j) => `${j.neutral}: ${statusWord(j)}`).join("; "),
        body: beatsBody(steps, of),
        // The console read-back is on the slide; its caption is narrated only when it did not hold.
        captions: js.flatMap((j) => j.stages.filter((s) => s.key !== "console" || s.outcome !== "held").map((s) => s.caption ?? "")),
        strip: last?.state ?? null,
        stage: `${String(b + 1)} of ${String(SHORT_BEATS.length)} · ${js.map((j) => j.rail).join(", ")}`,
      };
    }),
    ...segment,
    {
      kind: "summary",
      provenance: "Commands and URLs",
      title: "Where to verify",
      body: `${notShown.length === 0 ? "" : `<p class="note">${esc(storyCaption)}</p>`}${list([
        ...(repro.verify === null ? [] : [`<b>Check the committed evidence, no toolchain:</b> <code>${esc(repro.verify)}</code>. It checks the evidence bundle, not that the tests ran.`]),
        ...(repro.quick ? ["<b>Quick demo:</b> <code>make quick</code> (prebuilt WASM, uncertified)."] : ["<b>Demo:</b> <code>make demo</code>."]),
        "<b>Certified path:</b> <code>make test &amp;&amp; make demo</code>. No funds or model key needed.",
        `<b>Mainnet:</b> ${esc(mainnet.statement)}`,
        `<b>Repository and evidence page (${esc(PLANNED_LABEL)}):</b> <code>${esc(PLANNED_REPO)}</code>, <code>${esc(PLANNED_URLS.page)}</code>`,
      ])}<p class="note">${esc(status.sentence)}</p>`,
      captions: [`${storyCaption}Signed orders can still execute before confirmed key removal. ${mainnet.caption}`, repro_],
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
.chip.mainnet { border-color: #ece6d8; background: #ece6d8; color: #10141a; } .chip.acc.run { border-color: #ece6d8; color: #ece6d8; }
.tx { font-size: 24px; line-height: 1.3; margin: 0 0 6px; color: #c9d6e3; } .tx code { font-size: 22px; }
h1 { font-size: 54px; line-height: 1.1; margin: 22px 48px 16px; } h1.long { font-size: 42px; line-height: 1.2; margin-bottom: 25px; white-space: nowrap; }
.body { margin: 0 48px; height: 690px; overflow: hidden; font-size: 28px; } .body.strip-on { height: 535px; }
.body ul { margin: 8px 0; padding-left: 28px; } .body li { margin: 6px 0; }
code { font: 22px "SF Mono", Menlo, monospace; color: #c9d6e3; }
.ok { color: #6fcf9f; font-weight: 700; } .bad { color: #ff8a7a; font-weight: 700; }
table.kv { border-collapse: collapse; margin-bottom: 14px; } table.kv th { text-align: left; color: #a39d8f; font-weight: 600; padding: 4px 28px 4px 0; vertical-align: top; white-space: nowrap; }
table.kv td { font: 24px/1.35 "SF Mono", Menlo, monospace; word-break: break-word; padding: 4px 0; }
table.log { border-collapse: collapse; width: 100%; font-size: 22px; } table.log td { padding: 3px 18px 3px 0; vertical-align: top; border-bottom: 1px solid #2a3039; } table.log code { font-size: 19px; }
table.baseline th { text-align: left; color: #a39d8f; } table.baseline td { padding-block: 4px; }
table.cases { align-self: start; border-collapse: collapse; line-height: 1.2; }
table.cases th { text-align: left; padding: 2px 12px 2px 0; font: 700 19px/1.15 "SF Mono", Menlo, monospace; vertical-align: top; }
.pill { display: inline-block; font: 600 17px "SF Mono", Menlo, monospace; padding: 4px 8px; margin: 2px; border-radius: 4px; border: 2px solid; }
.pill.ok { color: #6fcf9f; } .pill.warn { color: #e6b450; } .pill.bad { color: #ff8a7a; } .pill.none { color: #9a958a; border-style: dashed; }
table.cases .pill { font-size: 16px; padding: 2px 5px; margin: 1px; }
.reason { margin: 10px 48px 0; font: 600 20px/1.3 "SF Mono", Menlo, monospace; color: #e0866f; max-height: 54px; overflow: hidden; }
.claim { font-size: 40px; line-height: 1.35; max-width: 1600px; } .claim.problem { color: #e0866f; margin-bottom: 0; }
.beat { margin: 0 0 12px; } .beat .status-line { margin: 0 0 4px; font-size: 30px; } .beat-line { font-size: 30px; line-height: 1.25; margin: 0 0 6px; }
.beat .attack-facts { gap: 6px 14px; } .beat .attack-facts > div { padding: 5px 12px; } .beat .attack-facts dt, .beat .attack-facts dd { font-size: 20px; }
.note { font-size: 22px; color: #e6b450; margin: 4px 0 8px; } table.cases small { font: 500 15px -apple-system, sans-serif; color: #a39d8f; }
img.shot { width: 100%; height: 690px; object-fit: contain; object-position: top center; border: 1px solid #2a3039; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; } .split table.kv td { font-size: 21px; } .split li { font-size: 20px; margin: 3px 0; }
img.shot.side { height: 510px; object-position: top left; }
ol.rail { list-style: none; display: flex; gap: 10px; padding: 0; margin: 0 0 22px; } ol.rail li { flex: 1; font: 600 16px/1.25 -apple-system, "Helvetica Neue", sans-serif; color: #6d6a62; border-top: 6px solid #2a3039; padding-top: 8px; }
ol.rail li b { font-family: "SF Mono", Menlo, monospace; } ol.rail li.past { color: #a39d8f; border-color: #6fcf9f; } ol.rail li.now { color: #ece6d8; border-color: #e0866f; }
ol.rail li.off { border-color: #e6b450; border-top-style: dashed; }
.status-line { margin: 0 0 10px; } .status-line .pill { font-size: 22px; padding: 6px 12px; }
.objective { font-size: 26px; color: #c9d6e3; margin: 0 0 10px; }
.headline { font-size: 56px; line-height: 1.12; font-weight: 600; margin: 0 0 18px; } .headline.medium { font-size: 42px; } .headline.small { font-size: 34px; } .bound { font: 20px/1.45 "SF Mono", Menlo, monospace; color: #a39d8f; margin: 10px 0 0; }
.attack-facts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 18px; margin: 0; }
.attack-facts > div { background: #151a20; padding: 8px 14px; }
.attack-facts dt { font: 600 22px/1.2 -apple-system, sans-serif; color: #a39d8f; }
.attack-facts dd { font: 22px/1.3 "SF Mono", Menlo, monospace; margin: 3px 0 0; }
.strip { position: absolute; left: 48px; right: 48px; bottom: 166px; height: 150px; display: grid; grid-template-columns: 1.3fr .8fr .8fr .6fr 1.2fr 1.2fr 1.2fr; gap: 0;
  border: 2px solid #3d4552; background: #151a20; font: 600 18px/1.3 -apple-system, "Helvetica Neue", sans-serif; }
.strip > div { padding: 12px 14px; border-right: 1px solid #3d4552; overflow: hidden; } .strip > div:last-child { border-right: 0; }
.strip .k { display: block; font: 700 14px/1.2 "SF Mono", Menlo, monospace; letter-spacing: .08em; text-transform: uppercase; color: #a39d8f; margin-bottom: 8px; }
.strip .v { font: 600 22px/1.3 "SF Mono", Menlo, monospace; color: #ece6d8; } .strip .v.small { font-size: 19px; }
.strip .stage .v { font: 600 21px/1.25 -apple-system, "Helvetica Neue", sans-serif; color: #e0866f; }
.strip .yes { color: #6fcf9f; } .strip .no { color: #ff8a7a; } .strip .none { color: #9a958a; }
.caption { position: absolute; left: 0; right: 0; bottom: 0; min-height: 150px; padding: 24px 80px; background: rgba(0,0,0,.82); color: #fff;
  font: 500 36px/1.35 -apple-system, "Helvetica Neue", Arial, sans-serif; text-align: center; display: flex; align-items: center; justify-content: center; }
`;

/** The state strip: stage, grant status, key, open orders and balances, all from the recorded step state. */
function stripHtml(st: StepState | null, stage: string): string {
  const cell = (k: string, v: string, cls = ""): string => `<div class="${cls}"><span class="k">${esc(k)}</span><span class="v${v.length > 18 ? " small" : ""}">${v}</span></div>`;
  const two = (p: { usdc: string; wnear: string }): string => `${esc(units(p.usdc, 6, 2))} USDC<br>${esc(units(p.wnear, 24, 4))} wNEAR`;
  if (st === null) return `<div class="strip">${cell("Stage", esc(stage), "stage")}<div><span class="k">State</span><span class="v small none">not recorded in this evidence</span></div></div>`;
  const key = st.key_present === null ? `<span class="none">none</span>` : st.key_present ? `<span class="yes">registered</span>` : `<span class="no">removed</span>`;
  return `<div class="strip">${cell("Stage", esc(stage), "stage")}${cell("Grant", esc(st.grant_status))}${cell("Grant key", key)}${cell("Open orders", String(st.open_orders))}${cell("Mandate (Intents)", two(st.mandate))}${cell("Owner (Intents)", two(st.owner_intents))}${cell("Owner (NEAR)", two(st.owner_near))}</div>`;
}

/** Longest title the full-size heading holds on one line; a longer one is set smaller, since a second line would push the fixed-height body into the caption. */
const TITLE_ONE_LINE = 60;

function slideHtml(s: Scene, caption: string, binding: DemoBinding): string {
  const labels = s.provenance === undefined ? [...new Set([...(s.labels ?? []), ...KIND_LABEL[s.kind]])] : [s.provenance];
  const chips = labels.map((l) => `<span class="chip${s.mainnet !== undefined ? " mainnet" : /^(Recorded|Scripted|Ordinary|Owner action|Owner controls|Owner console|Read-only)|·/.test(l) ? " model" : ""}">${esc(l)}</span>`).join("");
  const status = certification(binding);
  // The demo's certification says nothing about the mainnet run, which was made from its own revision.
  const corner = s.mainnet === undefined ? `<span class="chip acc${binding.certified ? " ok" : ""}">${esc(status.chip)}</span>` : `<span class="chip acc run">Mainnet run at revision ${esc(s.mainnet.revision.slice(0, 7))}</span>`;
  const reason = binding.certified || s.mainnet !== undefined ? "" : `<div class="reason">Not certified for this demo: ${esc(binding.reasons.join("; "))}</div>`;
  const strip = s.strip === undefined ? "" : stripHtml(s.strip, s.stage ?? s.title);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="top">${chips}${corner}</div>${reason}
<h1${s.title.length > TITLE_ONE_LINE ? ' class="long"' : ""}>${esc(s.title)}</h1><div class="body${strip === "" ? "" : " strip-on"}">${s.body}</div>${strip}<div class="caption">${esc(caption)}</div></body></html>`;
}

interface PwPage {
  setContent(html: string): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  screenshot(opts: { path?: string; clip?: { x: number; y: number; width: number; height: number }; fullPage?: boolean }): Promise<Buffer>;
}
interface PwBrowser {
  newPage(opts: { viewport: { width: number; height: number }; colorScheme?: "dark" | "light"; deviceScaleFactor?: number }): Promise<PwPage>;
  close(): Promise<void>;
}
interface PwCore {
  chromium: { launch(opts: { channel?: string; headless: boolean }): Promise<PwBrowser> };
}

export function loadPlaywright(): PwCore {
  const path = process.env.PLAYWRIGHT_CORE ?? join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@playwright/cli/node_modules/playwright-core");
  return createRequire(import.meta.url)(path) as PwCore;
}

/** The console screenshots the demo recorded, each refused unless its bytes match the sha256 in demo.json. */
export function consoleShots(ev: Evidence): { shots: Record<string, Buffer>; files: Record<string, Screenshot> } {
  const review = ConsoleReview.safeParse(ev.assertions.find((a) => a.id === "console-review")?.observed);
  const revoke = ConsoleRevoke.safeParse(ev.assertions.find((a) => a.id === "revoke-through-console")?.observed);
  const files: Record<string, Screenshot> = {};
  if (review.success && review.data.rendered !== undefined) files.consoleReview = review.data.rendered.screenshot;
  if (revoke.success && revoke.data.screenshot !== null) files.revokePreview = revoke.data.screenshot;
  const shots: Record<string, Buffer> = {};
  for (const [name, f] of Object.entries(files)) {
    const path = join(REPO_ROOT, f.path);
    if (!existsSync(path)) throw new Error(`missing ${f.path}, recorded by the demo run`);
    const bytes = readFileSync(path);
    if (sha256(bytes) !== f.sha256) throw new Error(`${f.path} is not the screenshot of the demo.json run (sha256 differs)`);
    shots[name] = bytes;
  }
  return { shots, files };
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
export const walkthroughPace = (text: string): number => wholeFrames(Math.min(9, Math.max(6, text.split(" ").length / 2.6 + 1.5)));
export const shortPace = (text: string): number => wholeFrames(Math.min(7.5, Math.max(5, text.split(" ").length / 3 + 0.8)));
export const SHORT_RANGE_S: readonly [number, number] = [45, 90];

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

export interface Cut {
  name: "short" | "walkthrough";
  mp4: string;
  srt: string;
  framesDir: string;
  scenes: Scene[];
  pace: (caption: string) => number;
  /** Allowed duration in seconds; the build fails outside it. */
  range: readonly [number, number] | null;
}

/**
 * Evaluated in the slide (tools/ has no DOM types, hence a string): what does not fit. Content clipped inside the body, a
 * state-strip cell or the reason line, or regions that overlap (chips and title pushing the body into the strip, or a
 * long caption rising over either).
 */
export const FRAME_MISFIT = `(() => {
  const out = [];
  const q = (sel) => Array.from(document.querySelectorAll(sel));
  const box = (sel) => q(sel)[0]?.getBoundingClientRect();
  for (const [sel, name] of [[".body", "slide body"], [".strip > div", "state strip cell"], [".reason", "certification reason"]]) {
    for (const el of q(sel)) if (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1) out.push(name + " clipped (" + el.scrollHeight + " > " + el.clientHeight + " px)");
  }
  const body = box(".body"), strip = box(".strip"), caption = box(".caption");
  if (body && strip && body.bottom > strip.top + 1) out.push("slide body overlaps the state strip");
  if (body && caption && body.bottom > caption.top + 1) out.push("slide body overlaps the caption");
  if (strip && caption && strip.bottom > caption.top + 1) out.push("caption overlaps the state strip");
  if (caption && caption.bottom > window.innerHeight + 1) out.push("caption runs off the frame");
  return out;
})()`;

export async function renderFrames(slide: PwPage, cut: Cut, binding: DemoBinding): Promise<Frame[]> {
  rmSync(cut.framesDir, { recursive: true, force: true });
  mkdirSync(cut.framesDir, { recursive: true });
  const frames: Frame[] = [];
  for (const scene of cut.scenes) {
    for (const caption of scene.captions.flatMap(chunks)) {
      const file = join(cut.framesDir, `${String(frames.length + 1).padStart(3, "0")}.png`);
      await slide.setContent(slideHtml(scene, caption, binding));
      const misfit = (await slide.evaluate(FRAME_MISFIT)) as string[];
      if (misfit.length > 0) throw new Error(`${cut.name} frame ${String(frames.length + 1)} ("${scene.title}") does not fit: ${misfit.join("; ")}`);
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

export function encode(cut: Cut, frames: readonly Frame[]): CutOutput {
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
  const reportDir = reportsDir(REPO_ROOT);
  const results = sandboxResults(acc, binding, loadReportFiles(reportDir));
  const { steps, setupMs, storyMs } = parseLog(readFileSync(files.log, "utf8"), ev);
  const modelFixture = readFileSync(files.model);
  if (sha256(modelFixture) !== ev.source.fixtures["model/normal.json"]) throw new Error("fixtures/model/normal.json differs from the hash recorded in demo.json");
  const modelName = (JSON.parse(modelFixture.toString("utf8")) as { model: string }).model;
  const live = liveView(loadLive(REPO_ROOT));
  const mainnet = mainnetCut(live);
  const repro = reproFromMakefile(readFileSync(join(REPO_ROOT, "Makefile"), "utf8"));

  const browser = await loadPlaywright().chromium.launch({ channel: process.env.PW_CHANNEL ?? "chrome", headless: true });
  const outputs: Partial<Record<Cut["name"], CutOutput>> = {};
  try {
    const { shots } = consoleShots(ev);
    const slide = await browser.newPage({ viewport: { width: W, height: H } });
    const cuts: Cut[] = [
      { name: "short", mp4: join(OUT, "bounded-mandate-short.mp4"), srt: join(OUT, "captions-short.srt"), framesDir: join(OUT, "frames-short"), scenes: shortScenes(ev, binding, mainnet, repro), pace: shortPace, range: SHORT_RANGE_S },
      { name: "walkthrough", mp4: join(OUT, "bounded-mandate-demo.mp4"), srt: join(OUT, "captions.srt"), framesDir: join(OUT, "frames"), scenes: walkthroughScenes(ev, acc, binding, steps, shots, modelName, results, mainnet), pace: walkthroughPace, range: null },
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
    mainnet_receipts_shown: live.kind === "mainnet",
    mainnet_segment: {
      state: mainnet.kind,
      statement: mainnet.statement,
      run_revision: mainnet.revision,
      transactions: mainnet.parts.flatMap((p) => p.txs.map((t) => ({ part: p.key, label: t.label, outcome: t.outcome, tx_hash: t.hash, url: t.url }))),
    },
    repro_paths_shown: repro,
    sources: {
      ...Object.fromEntries(Object.entries(files).map(([k, p]) => [k, { path: rel(p), sha256: hashOf(p) }])),
      ...Object.fromEntries(Object.entries(consoleShots(ev).files).map(([k, f]) => [k, f])),
      ...(results.trades === null || results.alternatives === null ? {} : Object.fromEntries([results.trades.report, results.alternatives.report].map((report) => [report.file, { path: rel(join(reportDir, report.file)), sha256: sha256(report.text) }]))),
    },
    demo_timing_ms: { setup: setupMs, story: storyMs, browser_start: ev.environment.browser_start_ms === undefined ? null : Number(ev.environment.browser_start_ms) },
    tools: { ffmpeg: execFileSync(process.env.FFMPEG ?? "ffmpeg", ["-version"], { encoding: "utf8" }).split("\n")[0] ?? "unknown" },
    cuts: outputs,
  };
  writeFileSync(join(OUT, "video.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const [name, o] of Object.entries(outputs)) console.log(`${name}: ${o.mp4.path} ${o.mp4.duration_s.toFixed(1)} s, ${String(o.mp4.bytes)} bytes, sha256 ${o.mp4.sha256 ?? "?"}`);
  console.log(`${certification(binding).chip}${binding.certified ? "" : `: ${binding.reasons.join("; ")}`}`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) await main();
