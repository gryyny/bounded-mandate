// Builds two captioned videos from the files of one actual run: a short cut (45-90 s) that opens with the lead line and
// tells the owner's eight-step journey with a state strip, and the longer technical walkthrough of the same run, numbered
// by the same steps, with an attack-log segment, gates and provenance. Captions only; any narration is added later by
// the owner. Not part of make test, make demo or CI.
//
// Usage (from the repository root):
//   make demo 2>&1 | tee out/video/demo.log        # the demo log must come from the run that wrote demo.json
//   make test                                       # optional: out/evidence/acceptance.json (gate results)
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
import { GATE_LABEL, HEADLINE, SUBTITLE, escapeHtml as esc, loadAcceptance } from "../page/render.js";
import { AGENT_OBJECTIVE, allocation, attackRows, isoNs, modelReason, ownerJourney, priceText, readable, revocationStory, share, shortHash, unboundReceipts, units, usdc, withheldIdentity, wnear, type JourneyStep, type StageKey } from "../page/story.js";
import { CONSOLE_BROWSER_LABEL, ConsoleReview, ConsoleRevoke, OWNER_CONTROLS_LABEL, PLANNED_LABEL, PLANNED_URLS, demoSteps, type Screenshot, type StepState } from "../evidence/journey.js";
import { Evidence } from "../types.js";

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
  /** State strip in the lower half: the recorded chain state (null: not recorded); absent: no strip. */
  strip?: StepState | null;
  /** Stage label shown in the strip. */
  stage?: string;
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

export function walkthroughScenes(ev: Evidence, acc: Acceptance | null, binding: DemoBinding, steps: LogStep[], shots: Record<string, Buffer>, modelName: string): Scene[] {
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
    .map(([g, names]) => `<tr><th>${esc(g)}<br><small>${esc(GATE_LABEL[g] ?? "")}</small></th><td>${names.map((n) => pill(g, n)).join(" ")}</td></tr>`)
    .join("");
  const counted = Object.entries(REQUIRED_CASES).flatMap(([g, names]) => names.filter((n) => acc?.cases.some((c) => c.gate === g && c.case === n && c.status === "passed"))).length;
  const totalCases = Object.values(REQUIRED_CASES).flat().length;
  const t5 = acc?.baseline ?? null;

  const rescue = acc?.separate.find((c) => c.id === "RESCUE.owner-key");
  const attackScenes = layers.map((layer, i): Scene => {
    const of = rows.filter((r) => r.layer === layer);
    const where = [...new Set(of.map((r) => r.where))].join("; ");
    return {
      kind: "demo",
      labels: ["Scripted attacks"],
      title: `3${String.fromCharCode(97 + i)} · Attack log: ${layer}, ${String(of.filter((r) => r.passed).length)} of ${String(of.length)} refused`,
      // The chain state is unchanged across the attacks, so the log takes the strip's space.
      body: `<p class="note">${esc(where)}</p><table class="log">${of
        .map(
          (r) =>
            `<tr><td class="${r.passed && r.contained !== false ? "ok" : "bad"}">${r.passed && r.contained !== false ? "refused" : "NOT HELD"}</td><td>${esc(r.description)}</td><td><code>${esc((r.reason ?? "").slice(0, 70))}</code></td><td><code>${esc(r.source === null ? (r.tx_hash === null ? "no transaction" : `tx ${shortHash(r.tx_hash)}`) : `${r.source.file}:${String(r.source.line)}`)}</code></td></tr>`,
        )
        .join("")}</table>`,
      captions: [
        of.every((r) => r.passed && r.contained !== false)
          ? `${sentenceCase(layer)}: ${String(of.length)} hostile ${of.length === 1 ? "request" : "requests"} refused, each with no state change.`
          : `${sentenceCase(layer)}: ${String(of.filter((r) => !(r.passed && r.contained !== false)).length)} of ${String(of.length)} requests were not refused at their expected layer with no state change.`,
      ],
    };
  });
  const out: Scene[] = [
    {
      kind: "summary",
      labels: DEMO_LABELS,
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
          captions: [narrate("trade", "No recorded model proposal was available, so the first order used a scripted proposal. It is not model output.")],
          strip: stateAfter("Bounded agent proposal"),
        }
      : {
      kind: "demo",
      labels: ["Recorded genuine model output"],
      title: `2a · Recorded genuine model output, ${modelName} (replayed)`,
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
      captions: [
        `Limits: sandbox only, with test doubles for MPC, oracle and tokens; no mainnet execution; ${proposal === null ? "the first order used a scripted proposal, not model output" : "the model step is a replay"}. No guarantee of profit or a maximum loss.`,
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

const sentenceCase = (t: string): string => `${t.charAt(0).toUpperCase()}${t.slice(1)}`;

function rail(steps: readonly JourneyStep[], current: number): string {
  return `<ol class="rail">${steps
    .map((j, i) => `<li class="${i < current ? "past" : i === current ? "now" : ""}${j.outcome === "held" ? "" : " off"}"><b>${String(j.n)}</b> ${esc(j.rail)}</li>`)
    .join("")}</ol>`;
}

const STATUS_CLASS: Record<JourneyStep["outcome"], string> = { held: "ok", "not-held": "bad", inconclusive: "warn", missing: "bad" };
const statusWord = (j: JourneyStep): string =>
  j.outcome === "held" ? j.done : j.outcome === "not-held" ? "did not hold" : j.outcome === "inconclusive" ? "inconclusive" : "not in this evidence";

/** One journey step's slide: the rail, its recorded status and outcome line, its facts and the evidence it is bound to. */
const stepBody = (steps: readonly JourneyStep[], i: number): string => {
  const j = steps[i];
  if (j === undefined) return "";
  const checks = j.stages.flatMap((s) => s.checks);
  const many = checks.length > 8;
  const bound = [
    ...j.stages.flatMap((s) => s.receipts.map(({ receipt }) => `tx ${esc(shortHash(receipt.tx_hash ?? receipt.label))}${receipt.outcome === "failure" ? " (failed)" : ""}`)),
    ...(many ? [`${String(checks.filter((c) => c.held === true).length)} of ${String(checks.length)} checks held`] : []),
    ...checks.filter((c) => !many || c.held !== true).map((c) => `${esc(c.id)} ${c.held === true ? "held" : "did not hold"}`),
  ];
  const result = j.result ?? "";
  // Long outcome lines shrink so the facts below stay on the slide.
  const size = result.length > 150 ? " small" : result.length > 80 ? " medium" : "";
  const facts = j.stages.flatMap((s) => s.facts).slice(0, size === " small" ? 3 : 4);
  return `${rail(steps, i)}<p class="status-line"><span class="pill ${STATUS_CLASS[j.outcome]}">${esc(statusWord(j))}</span></p><p class="headline${size}">${esc(result)}</p>${kv(facts)}<p class="bound">Evidence: ${bound.join(" · ")}</p>`;
};

/**
 * The short cut: the lead line, the owner's eight journey steps bound to this run with a state strip, and how to check
 * it. Throws when any stage lacks its evidence.
 */
export function shortScenes(ev: Evidence, binding: DemoBinding, mainnetShown: boolean): Scene[] {
  const stages = revocationStory(ev);
  const missing = stages.flatMap((s) => s.missing.map((m) => `${s.title}: ${m}`));
  if (missing.length > 0) throw new Error(`demo.json lacks evidence for the short cut: ${missing.join("; ")}`);
  const unbound = unboundReceipts(ev, stages);
  if (unbound.length > 0) throw new Error(`receipts not bound to any story stage: ${unbound.join(", ")}`);
  const steps = ownerJourney(ev, stages);
  const status = certification(binding);
  // "Replayed model recording" only when the trade's proposal is recorded model output; a scripted one is never called that.
  const replayed = steps.find((j) => j.key === "trade")?.labels.includes("recorded genuine model output") === true && ev.environment.model_mode === "recorded-model";
  const what = replayed ? "One local sandbox run with labelled test doubles and a replayed model recording" : "One local sandbox run with labelled test doubles and a scripted proposal, not model output";
  const mainnet = mainnetShown ? "Mainnet receipts are on the evidence page." : "Mainnet run: pending approval — no mainnet transaction has been executed.";
  const notShown = steps.filter((j) => j.outcome !== "held");
  // The story outcome is the demo's; the certification sentence is the acceptance run's. Neither implies the other.
  const storyCaption =
    notShown.length === 0 ? "" : `In this run ${String(notShown.length)} of ${String(steps.length)} journey steps are not shown as evidence: ${notShown.map((j) => `${j.neutral} (${j.outcome})`).join(", ")}. `;
  const mainnetCaption = mainnetShown ? "Mainnet receipts are on the evidence page." : "Mainnet run pending approval; no mainnet transaction executed.";
  return [
    {
      kind: "summary",
      labels: DEMO_LABELS,
      title: HEADLINE,
      body: `<p class="claim">${esc(SUBTITLE)}</p>${rail(steps, -1)}<p class="objective">Agent's objective: ${esc(AGENT_OBJECTIVE)}. An instruction to the agent, not a rule the contract enforces.</p><p class="note">${esc(what)}. Every number shown comes from out/evidence/demo.json.</p>`,
      // The lead line alone, then what the run is.
      captions: [HEADLINE, `${what}, in eight steps.`],
    },
    ...steps.map((j, i): Scene => {
      const last = j.stages.at(-1);
      return {
        kind: "demo",
        labels: j.labels.map(sentenceCase),
        title: `${String(j.n)} · ${j.outcome === "held" ? j.title : `${j.neutral}: ${statusWord(j)}`}`,
        body: stepBody(steps, i),
        captions: j.stages.map((s) => s.caption ?? ""),
        strip: last?.state ?? null,
        stage: `${String(j.n)} of ${String(steps.length)} · ${j.rail}`,
      };
    }),
    {
      kind: "summary",
      title: "Check it yourself",
      body: `${notShown.length === 0 ? "" : `<p class="note">${esc(storyCaption)}</p>`}${list([
        "<b>Watch</b> this video, or read the evidence page: each step links to its transactions and checks.",
        `<b>Inspect mainnet receipts:</b> ${esc(mainnet)}`,
        "<b>Run</b> <code>make demo</code> and <code>make test</code>: no funds or model key needed.",
        `<b>Planned hosting (${esc(PLANNED_LABEL)}):</b> <code>${esc(PLANNED_URLS.page)}</code>, console <code>${esc(PLANNED_URLS.console)}</code>`,
      ])}<p class="note">${esc(status.sentence)}</p>`,
      captions: [`${storyCaption}Revocation is not instant; the claim starts at confirmed key removal. ${mainnetCaption} Reproduce: make demo, make test.`],
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
h1 { font-size: 54px; line-height: 1.1; margin: 22px 48px 16px; }
.body { margin: 0 48px; height: 690px; overflow: hidden; font-size: 28px; } .body.strip-on { height: 520px; }
.body ul { margin: 8px 0; padding-left: 28px; } .body li { margin: 6px 0; }
code { font: 22px "SF Mono", Menlo, monospace; color: #c9d6e3; }
.ok { color: #6fcf9f; font-weight: 700; } .bad { color: #ff8a7a; font-weight: 700; }
table.kv { border-collapse: collapse; margin-bottom: 14px; } table.kv th { text-align: left; color: #a39d8f; font-weight: 600; padding: 4px 28px 4px 0; vertical-align: top; white-space: nowrap; }
table.kv td { font: 24px/1.35 "SF Mono", Menlo, monospace; word-break: break-word; padding: 4px 0; }
table.log { border-collapse: collapse; width: 100%; font-size: 22px; } table.log td { padding: 3px 18px 3px 0; vertical-align: top; border-bottom: 1px solid #2a3039; } table.log code { font-size: 19px; }
table.cases th { text-align: left; padding: 3px 20px 3px 0; font: 700 22px "SF Mono", Menlo, monospace; vertical-align: top; white-space: nowrap; }
.pill { display: inline-block; font: 600 17px "SF Mono", Menlo, monospace; padding: 4px 8px; margin: 2px; border-radius: 4px; border: 2px solid; }
.pill.ok { color: #6fcf9f; } .pill.warn { color: #e6b450; } .pill.bad { color: #ff8a7a; } .pill.none { color: #9a958a; border-style: dashed; }
.reason { margin: 10px 48px 0; font: 600 20px/1.3 "SF Mono", Menlo, monospace; color: #e0866f; max-height: 54px; overflow: hidden; }
.claim { font-size: 40px; line-height: 1.35; max-width: 1600px; }
.note { font-size: 22px; color: #e6b450; margin: 4px 0 8px; } table.cases small { font: 500 15px -apple-system, sans-serif; color: #a39d8f; }
img.shot { width: 100%; height: 690px; object-fit: contain; object-position: top center; border: 1px solid #2a3039; }
.split { display: grid; grid-template-columns: 1fr 1fr; gap: 32px; } .split table.kv td { font-size: 21px; } .split li { font-size: 20px; margin: 3px 0; }
img.shot.side { height: 510px; object-position: top left; }
ol.rail { list-style: none; display: flex; gap: 10px; padding: 0; margin: 0 0 22px; } ol.rail li { flex: 1; font: 600 16px/1.25 -apple-system, "Helvetica Neue", sans-serif; color: #6d6a62; border-top: 6px solid #2a3039; padding-top: 8px; }
ol.rail li b { font-family: "SF Mono", Menlo, monospace; } ol.rail li.past { color: #a39d8f; border-color: #6fcf9f; } ol.rail li.now { color: #ece6d8; border-color: #e0866f; }
ol.rail li.off { border-color: #e6b450; border-top-style: dashed; }
.status-line { margin: 0 0 10px; } .status-line .pill { font-size: 22px; padding: 6px 12px; }
.objective { font-size: 26px; color: #c9d6e3; margin: 0 0 10px; }
.headline { font-size: 56px; line-height: 1.12; font-weight: 600; margin: 0 0 18px; } .headline.medium { font-size: 42px; } .headline.small { font-size: 34px; } .bound { font: 20px/1.45 "SF Mono", Menlo, monospace; color: #a39d8f; margin-top: 10px; }
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

function slideHtml(s: Scene, caption: string, binding: DemoBinding): string {
  const labels = [...new Set([...(s.labels ?? []), ...KIND_LABEL[s.kind]])];
  const chips = labels.map((l) => `<span class="chip${/^(Recorded|Scripted|Ordinary|Owner action|Owner controls|Owner console|Read-only)/.test(l) ? " model" : ""}">${esc(l)}</span>`).join("");
  const status = certification(binding);
  const reason = binding.certified ? "" : `<div class="reason">Not certified for this demo: ${esc(binding.reasons.join("; "))}</div>`;
  const strip = s.strip === undefined ? "" : stripHtml(s.strip, s.stage ?? s.title);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>
<div class="top">${chips}<span class="chip acc${binding.certified ? " ok" : ""}">${esc(status.chip)}</span></div>${reason}
<h1>${esc(s.title)}</h1><div class="body${strip === "" ? "" : " strip-on"}">${s.body}</div>${strip}<div class="caption">${esc(caption)}</div></body></html>`;
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
const walkthroughPace = (text: string): number => wholeFrames(Math.min(9, Math.max(6, text.split(" ").length / 2.6 + 1.5)));
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
    const shots = { ...(await pageShots(browser, files.page)), ...consoleShots(ev).shots };
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
    sources: {
      ...Object.fromEntries(Object.entries(files).map(([k, p]) => [k, { path: rel(p), sha256: hashOf(p) }])),
      ...Object.fromEntries(Object.entries(consoleShots(ev).files).map(([k, f]) => [k, f])),
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
