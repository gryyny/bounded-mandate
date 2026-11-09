// Both video cuts, from SYNTHETIC story evidence (see video-story-specimen.ts); no frames are rendered here.
import { describe, expect, it } from "vitest";
import { bindDemo } from "../src/evidence/binding.js";
import { attackRows, layerCounts, revocationStory } from "../src/page/story.js";
import { type Evidence } from "../src/types.js";
import { escapeHtml as esc } from "../src/page/html.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { OWNER_CONTROLS_LABEL } from "../src/evidence/journey.js";
import { REPO_ROOT } from "../src/evidence/report.js";
import { LEAD, PLANNED_REPO, PROBLEM, SHORT_RANGE_S, chunks, consoleShots, type LogStep, reproFromMakefile, shortPace, shortScenes, walkthroughScenes } from "../src/video/make.js";
import { ATTACKS, CONSOLE_RENDERED, STORY, expiredStoryEvidence, olderStoryEvidence, storyEvidence } from "./video-story-specimen.js";

const STEPS: LogStep[] = [
  "Grant and limits",
  "Mandate reviewed in the console",
  "Bounded agent proposal",
  "Filler fills",
  "Hostile requests refused",
  "Second signed order withheld",
  "Owner revokes",
  "Withheld order relayed",
  "Agent, oracle and MPC disabled",
  "Recovery to the owner",
  "Owner withdrawal",
].map((title) => ({ title, lines: [] }));

/** SYNTHETIC: the model decision text the walkthrough reads. */
const withDecision = (ev: Evidence): Evidence => ({
  ...ev,
  assertions: ev.assertions.map((a) =>
    a.id === "model-proposal-on-chain"
      ? { ...a, observed: { ...(a.observed as object), decision: { model: STORY.model, decision_text: JSON.stringify({ action: "propose", proposal: { sell: "usdc", sell_amount: STORY.sell.toString(), max_concession_bps: 40 }, reason: "SYNTHETIC reason: USDC is overweight" }), prompt_sha256: "SYNTHETIC", raw_output_sha256: "SYNTHETIC", adapter_verdict: { kind: "proposal", proposal: { sell: "usdc", sell_amount: STORY.sell.toString(), max_concession_bps: 40 } } } } }
      : a,
  ),
});
const walk = (ev: Evidence) => walkthroughScenes(withDecision(ev), null, bindDemo(ev, null), STEPS, {}, STORY.model);

const short = (ev: Evidence = storyEvidence(), mainnet = false) => shortScenes(ev, bindDemo(ev, null), mainnet);
const captions = (mainnet = false) => short(storyEvidence(), mainnet).flatMap((s) => s.captions.flatMap(chunks));
const scene = (ev: Evidence, prefix: string) => short(ev).find((s) => s.title.startsWith(prefix));
const TITLES = [
  "Give an AI agent trading power. Keep the power to stop it.",
  "The agent trades inside fixed limits",
  "Hostile requests are refused; one signed order is held back",
  "The owner revokes; the verifier rejects the held order",
  "The funds return to the owner",
  "Where to verify",
];

describe("short video cut", () => {
  it("states the problem, then trades, refusals and the held order, revocation and rejection, the funds' return, and where to verify", () => {
    const scenes = short();
    expect(scenes.map((s) => s.title)).toEqual(TITLES);
    // The problem is the first caption, alone; the next states what the run is.
    expect(scenes[0]?.captions.flatMap(chunks)).toEqual([PROBLEM, "One local sandbox run with labelled test doubles and a replayed model recording."]);
    expect(scenes[0]?.body).toContain(esc(LEAD));
    // Each told step's status pill is its recorded outcome, under its journey number.
    for (const [i, sc] of scenes.slice(1, 5).entries()) {
      expect(sc.body.match(/<span class="pill ok">/g)).toHaveLength(2);
      for (const n of [2 * i + 1, 2 * i + 2]) expect(sc.body).toContain(`<b>${String(n)} · `);
    }
  });

  it("gives every scene exactly one provenance label, derived from its stages", () => {
    const scenes = short();
    for (const sc of scenes) {
      expect(sc.provenance).toBeTruthy();
      expect(sc.labels).toBeUndefined();
    }
    expect(scenes.map((s) => s.provenance)).toEqual([
      "Summary of one local sandbox run · no mainnet",
      "Local sandbox, test doubles · recorded model output, replayed",
      "Local sandbox · scripted attacks and order, one replayed model recording",
      "Local sandbox · owner console, test signer, not a wallet",
      "Local sandbox · oracle and MPC test doubles switched off",
      "Commands · URLs planned, unpublished",
    ]);
    expect(short(storyEvidence(), true)[0]?.provenance).toBe("Summary of one local sandbox run");
    // A revocation by direct owner call is not labelled as the console.
    expect(scene(olderStoryEvidence(), "The owner revokes")?.provenance ?? scene(olderStoryEvidence(), "Owner revocation")?.provenance).toBe("Local sandbox · direct owner call");
  });

  it("puts the recorded chain state of each scene's last stage in the strip", () => {
    const strip = (i: number) => short()[i]?.strip;
    expect(strip(1)).toMatchObject({ grant_status: "active", key_present: true, open_orders: 0 });
    expect(strip(2)).toMatchObject({ grant_status: "active", key_present: true, open_orders: 1 });
    expect(strip(3)).toMatchObject({ grant_status: "revoked", key_present: false, open_orders: 0 });
    const after = { usdc: (STORY.before.usdc - STORY.sell).toString(), wnear: (STORY.before.wnear + STORY.buy).toString() };
    expect(strip(4)).toMatchObject({ owner_intents: { usdc: "0", wnear: "0" }, owner_near: after });
    expect(short()[0]?.strip).toBeUndefined();
    expect(short().at(-1)?.strip).toBeUndefined();
  });

  it("shows no ok pill over a step whose outcome values are absent, and never calls a scripted proposal model output", () => {
    const ev = storyEvidence();
    const unbuilt = { ...ev, assertions: ev.assertions.map((a) => (a.id === "trade-executed" ? { ...a, observed: { ...(a.observed as object), signed: { ...(a.observed as { signed: object }).signed, buy_amount: null } } } : a)) };
    const trade = short(unbuilt)[1];
    expect(trade?.title).toBe("The agent's trade: not in this evidence");
    expect(trade?.body).toContain('<span class="pill bad">not in this evidence</span> <b>2 · The agent&#39;s trade</b>');
    expect(trade?.body.match(/<span class="pill ok">/g)).toHaveLength(1);

    const scripted = { ...ev, assertions: ev.assertions.map((a) => (a.id === "model-proposal-on-chain" ? { ...a, observed: { ...(a.observed as object), mode: "scripted", decision: null } } : a)) };
    const s = short(scripted);
    expect(s[0]?.captions[1]).toBe("One local sandbox run with labelled test doubles and a scripted proposal, not model output.");
    expect(s[0]?.body).not.toContain("replayed model recording");
    expect(s[1]?.provenance).toBe("Local sandbox, test doubles · scripted proposal, not model output");
  });

  it("calls the trade scripted when the replayed model declined, in both cuts", () => {
    // The demo still records mode "recorded-model" and a decision after a decline, then trades a scripted proposal.
    const declined = (ev: Evidence): Evidence => ({
      ...ev,
      assertions: ev.assertions.map((a) =>
        a.id === "model-proposal-on-chain" ? { ...a, passed: false, observed: { ...(a.observed as object), decision: { ...((a.observed as { decision: object }).decision), adapter_verdict: { kind: "decline", reason: "SYNTHETIC decline" } } } } : a,
      ),
    });
    const ev = declined(storyEvidence());
    const s = short(ev);
    expect(s[0]?.captions[1]).toBe("One local sandbox run with labelled test doubles and a scripted proposal, not model output.");
    // The hostile scene may still carry the injected-prompt recording; the trade itself is never called model output.
    expect(s.flatMap((x) => [x.body, ...x.captions]).join(" ")).not.toMatch(/replayed model recording|recorded genuine model output|recorded model output/i);
    expect(s[1]?.provenance).toBe("Local sandbox, test doubles · scripted proposal, not model output");
    const walked = walkthroughScenes(declined(withDecision(storyEvidence())), null, bindDemo(ev, null), STEPS, {}, STORY.model);
    const trade = walked.find((sc) => sc.title.startsWith("2a ·"));
    expect(trade?.title).toBe("2a · Scripted proposal, not model output");
    expect(trade?.captions.join(" ")).not.toMatch(/recorded genuine model output|replayed/i);
    expect(walked.flatMap((sc) => sc.captions).join(" ")).not.toMatch(/replayed with no provider call|the model step is a replay/);
  });

  it("never titles or narrates a step that is not evidence with its success wording", () => {
    const ev = expiredStoryEvidence();
    const scenes = short(ev);
    expect(scenes[0]?.title).toBe("Give an AI agent trading power. Keep the power to stop it.");
    expect(scenes[3]?.title).toBe("The withheld order relayed: inconclusive");
    expect(scenes[3]?.body).toContain('<span class="pill warn">inconclusive</span>');
    expect(scenes.map((s) => s.title)).not.toContain("The owner revokes; the verifier rejects the held order");
    const failed = { ...storyEvidence(), assertions: storyEvidence().assertions.map((a) => (a.id === "revoke-through-console" ? { ...a, passed: false } : a)) };
    const revoke = short(failed)[3];
    expect(revoke?.title).toBe("Owner revocation: did not hold");
    expect(revoke?.body).toContain('<span class="pill bad">did not hold</span>');
    expect(revoke?.captions.join(" ")).not.toContain("Key removal is confirmed");
  });

  it("captions carry the run's numbers, derived from the evidence", () => {
    const text = captions().join("\n");
    const layers = "local validation 1, agent key permission 1, contract method check 1, policy validation 1, verifier 1";
    for (const expected of [
      "After an exact preview, the owner revokes in the console with the local sandbox test signer, not a wallet. Key removal is confirmed.",
      "$2,300.00",
      "($460.00)",
      `A recorded ${STORY.model} proposal, replayed, sells 12.34 USDC`,
      "5 wNEAR for 14.99 USDC",
      `${String(ATTACKS.length)} of ${String(ATTACKS.length)} scripted hostile requests refused, nothing changed: ${layers}.`,
      "37 s before its deadline",
      "the MPC test double on hold, the owner recovers 1,987.66 USDC and 104 wNEAR into its Intents account",
      "Separately, outside recovery, the owner withdraws 1,987.66 USDC and 104 wNEAR to its NEAR account",
      "Signed orders can still execute before confirmed key removal.",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain("Mainnet run pending approval; no mainnet transaction executed.");
    expect(captions(true).join("\n")).not.toContain("no mainnet transaction executed");
  });

  it("shows the console read-back on the slide, and narrates it only when it did not hold", () => {
    const read = `read in the owner console: grant ${CONSOLE_RENDERED.grant_status}, key registered, limits as granted`;
    expect(short()[1]?.body).toContain(read);
    expect(captions().join(" ")).not.toContain("The owner console reads it back");
    const inconclusive = short(olderStoryEvidence())[1];
    expect(inconclusive?.title).toBe("The mandate and its limits: inconclusive");
    expect(inconclusive?.captions.length).toBe(3);
  });

  it("keeps every enforcement layer in the short slide and its caption", () => {
    const ev = storyEvidence();
    const attack = short(ev)[2];
    const counts = layerCounts(attackRows(ev));
    expect(counts).toHaveLength(5);
    for (const [layer, count] of counts) {
      expect(attack?.body).toContain(`<dt>${layer.charAt(0).toUpperCase()}${layer.slice(1)}</dt><dd>${String(count)} refused</dd>`);
      expect(attack?.captions.join(" ")).toContain(`${layer} ${String(count)}`);
    }
    expect(attack?.body).toContain("<dt>Injected prompt</dt>");
  });

  it("fits the 45-90 s target, with every reproduction path shown", () => {
    for (const repro of [{ verify: null, quick: false }, { verify: "make verify, or node verify.mjs with no install", quick: true }]) {
      const total = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false, repro).flatMap((s) => s.captions.flatMap(chunks)).reduce((t, c) => t + shortPace(c), 0);
      expect(total).toBeGreaterThanOrEqual(SHORT_RANGE_S[0]);
      expect(total).toBeLessThanOrEqual(SHORT_RANGE_S[1]);
    }
    expect(SHORT_RANGE_S[1]).toBeLessThanOrEqual(90);
  });

  it("refuses evidence missing a stage's assertion, or with a receipt no stage shows", () => {
    const ev = storyEvidence();
    const noRelay = { ...ev, assertions: ev.assertions.filter((a) => a.id !== "withheld-rejected") };
    expect(() => short(noRelay)).toThrow(/Withheld order relayed: assertion withheld-rejected/);
    const noWithdrawal = { ...ev, assertions: ev.assertions.filter((a) => a.id !== "owner-withdrawal") };
    expect(() => short(noWithdrawal)).toThrow(/Owner withdrawal to NEAR: assertion owner-withdrawal/);
    const extra = { ...ev, receipts: [...ev.receipts, { label: "SYNTHETIC unrelated call", outcome: "success" as const, detail: {} }] };
    expect(() => short(extra)).toThrow(/receipts not bound to any story stage: SYNTHETIC unrelated call/);
  });

  it("states the certification only from the binding", () => {
    const closing = short().at(-1)?.body ?? "";
    expect(closing).toContain("Not certified for this demo");
    expect(closing).not.toMatch(/Certified for this demo:/);
  });

  it("names only the reproduction paths the Makefile ships, and the repository as planned", () => {
    const ev = storyEvidence();
    const none = shortScenes(ev, bindDemo(ev, null), false).at(-1);
    expect(none?.captions.at(-1)).toBe("Demo: make demo. Full proof: make test && make demo.");
    expect(none?.body).not.toMatch(/make verify|make quick/);
    expect(none?.body).toContain(`<b>Repository and evidence page (planned, unpublished):</b> <code>${PLANNED_REPO}</code>`);
    const all = shortScenes(ev, bindDemo(ev, null), false, { verify: "make verify, or node verify.mjs with no install", quick: true }).at(-1);
    expect(all?.captions.at(-1)).toBe("Verify the evidence: make verify, or node verify.mjs with no install. Quick demo: make quick. Full proof: make test && make demo.");
    expect(all?.captions.flatMap(chunks)).toHaveLength(2);
    expect(all?.body).toContain("It checks the evidence bundle, not that the tests ran.");
    expect(all?.body).toContain("<code>make quick</code> (prebuilt WASM, uncertified)");

    const makefile = "test:\n\tcargo test\n\nverify:\n\tnode verify.mjs\n\nquick:\n\t$(TSX) src/quick/main.ts\n";
    expect(reproFromMakefile(makefile)).toEqual({ verify: "make verify, or node verify.mjs with no install", quick: true });
    expect(reproFromMakefile("verify:\n\t$(NODE) x\n")).toEqual({ verify: "make verify", quick: false });
    expect(reproFromMakefile("test:\n\tnode verify.mjs\n")).toEqual({ verify: null, quick: false });
  });

  it("narrates an expired withheld order marked passed:false as inconclusive, not as rejected by revocation", () => {
    const ev = expiredStoryEvidence();
    const rejected = revocationStory(ev).find((st) => st.key === "rejected");
    expect(rejected?.outcome).toBe("inconclusive");
    const text = short(ev).flatMap((sc) => sc.captions.flatMap(chunks)).join("\n");
    expect(text).not.toContain("before its deadline");
    expect(text).not.toContain("the signing key no longer exists");
    expect(text).toContain("Withheld order relayed is inconclusive in this run: the withheld order was relayed 4.5 s after its deadline");
    expect(text).toContain("did not hold");
    expect(text).toContain("In this run 1 of 8 journey steps are not shown as evidence: The withheld order relayed (inconclusive).");
  });

  it("keeps acceptance certification and the demo's story outcome apart", () => {
    const ev = expiredStoryEvidence();
    const certified = { ...bindDemo(ev, null), certified: true, reasons: [] };
    const closing = shortScenes(ev, certified, false).at(-1);
    // Certification comes from the binding alone; it does not turn the failed stage into a pass.
    expect(closing?.body).toContain("Certified for this demo:");
    expect(closing?.captions.join(" ")).toContain("The withheld order relayed (inconclusive)");
    const clean = short().at(-1);
    // And a fully held story does not make an uncertified run certified.
    expect(clean?.body).toContain("Not certified for this demo");
    expect(clean?.captions.join(" ")).not.toContain("not shown as evidence");
  });

  it("never says instant or first, nor only in its own titles, labels and lead", () => {
    const text = short().flatMap((s) => [s.title, s.body, s.provenance ?? "", ...s.captions]).join(" ");
    expect(text).not.toMatch(/\binstant(ly)?\b|\bfirst\b/i);
    expect([PROBLEM, LEAD, ...short().flatMap((s) => [s.title, s.provenance ?? ""])].join(" ")).not.toMatch(/\bonly\b/i);
  });

  it("walkthrough narrates the expired relay's outcome instead of its rejection", () => {
    const expired = walk(expiredStoryEvidence());
    const relay = expired.find((sc) => sc.title.startsWith("6 ·"));
    expect(relay?.title).toBe("6 · The withheld order is relayed: inconclusive");
    expect(relay?.captions.join(" ")).toContain("relayed 4.5 s after its deadline");
    expect(expired.flatMap((sc) => sc.captions).join(" ")).not.toContain("The verifier rejects it");
    const held = walk(storyEvidence()).find((sc) => sc.title.startsWith("6 ·"));
    expect(held?.captions.join(" ")).toContain("Another account relays the withheld order 37 s before its deadline. The verifier rejects it");
  });

  it("walkthrough shows the console review and the console revocation with their screenshots and labels", () => {
    const png = Buffer.from("SYNTHETIC png bytes");
    const scenes = walkthroughScenes(withDecision(storyEvidence()), null, bindDemo(storyEvidence(), null), STEPS, { consoleReview: png, revokePreview: png }, STORY.model);
    const review = scenes.find((sc) => sc.title.startsWith("1b ·"));
    expect(review?.title).toBe("1b · Mandate reviewed in the console");
    expect(review?.labels).toEqual(["Owner console in headless Chromium"]);
    expect(review?.body).toContain(`data:image/png;base64,${png.toString("base64")}`);
    expect(review?.body).toContain("final block #42 of the sandbox");
    expect(review?.body).not.toMatch(/\blive\b/);
    const revoke = scenes.find((sc) => sc.title.startsWith("5 ·"));
    expect(revoke?.title).toBe("5 · Owner revokes in the console; key removal confirmed");
    expect(revoke?.labels).toEqual([OWNER_CONTROLS_LABEL.charAt(0).toUpperCase() + OWNER_CONTROLS_LABEL.slice(1)]);
    expect(revoke?.body).toContain("exact: receiver, method, arguments, gas and deposit as derived");
    // An older demo revoked with a direct call: no console label, and the caption says so.
    const older = walk(olderStoryEvidence()).find((sc) => sc.title.startsWith("5 ·"));
    expect(older?.labels).toEqual([]);
    expect(older?.captions.join(" ")).toContain("The owner revokes the grant with a direct owner call.");
    expect(walk(olderStoryEvidence()).find((sc) => sc.title.startsWith("1b ·"))?.title).toBe("1b · Console review: inconclusive");
  });

  it("embeds a console screenshot only when its bytes match the sha256 the demo recorded", () => {
    const dir = mkdtempSync(join(tmpdir(), "bm-shots-"));
    try {
      const file = join(dir, "review.png");
      writeFileSync(file, "SYNTHETIC png bytes");
      const path = relative(REPO_ROOT, file);
      const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
      const withShot = (sha256: string): Evidence => {
        const ev = storyEvidence();
        return {
          ...ev,
          assertions: ev.assertions
            .filter((a) => a.id !== "revoke-through-console")
            .map((a) => (a.id === "console-review" ? { ...a, observed: { ...(a.observed as object), rendered: { ...CONSOLE_RENDERED, screenshot: { path, sha256 } } } } : a)),
        };
      };
      expect(consoleShots(withShot(sha)).shots.consoleReview?.toString()).toBe("SYNTHETIC png bytes");
      expect(() => consoleShots(withShot("0".repeat(64)))).toThrow(/is not the screenshot of the demo.json run/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("walkthrough steps through the attack log by enforcement layer, from the recorded results", () => {
    const scenes = walk(storyEvidence()).filter((sc) => sc.title.includes("Attack log"));
    // One scene per layer the attacks actually reached, in the order they appear.
    expect(scenes.map((sc) => sc.title)).toEqual([
      "3a · Attack log: local validation, 1 of 1 refused",
      "3b · Attack log: agent key permission, 1 of 1 refused",
      "3c · Attack log: contract method check, 1 of 1 refused",
      "3d · Attack log: policy validation, 1 of 1 refused",
      "3e · Attack log: verifier, 1 of 1 refused",
    ]);
    // Journey order: the attack log comes before the withheld order and after the trade.
    const titles = walk(storyEvidence()).map((sc) => sc.title);
    expect(titles.findIndex((t) => t.startsWith("2b ·"))).toBeLessThan(titles.findIndex((t) => t.startsWith("3a ·")));
    expect(titles.findIndex((t) => t.startsWith("3e ·"))).toBeLessThan(titles.findIndex((t) => t.startsWith("4 ·")));
    expect(scenes[3]?.body).toContain("contract/src/lib.rs:905");
    expect(scenes[3]?.body).toContain("per-order cap exceeded");
    const total = scenes.flatMap((sc) => sc.captions.flatMap(chunks)).length;
    expect(total).toBe(scenes.length);
    // A request that reached a different boundary than expected is shown under that layer and not as refused.
    const ev = storyEvidence();
    const moved = { ...ev, assertions: ev.assertions.map((a) => (a.id === "attack-direct-over-cap" ? { ...a, passed: false, observed: { ...(a.observed as object), observed: "not-stopped", contained: false } } : a)) };
    const notStopped = walk(moved).find((sc) => sc.title.includes("not stopped"));
    expect(notStopped?.title).toBe("3d · Attack log: not stopped, 0 of 1 refused");
    expect(notStopped?.captions.join(" ")).toContain("was confirmed for 0 of 1 requests");
    expect(notStopped?.body).toContain("NOT HELD");
  });

  it("walkthrough shows the withdrawal as the owner's action outside recovery, and narrates a failed withdrawal as failed", () => {
    const scene = walk(storyEvidence()).find((sc) => sc.title.startsWith("8 ·"));
    expect(scene?.title).toBe("8 · Owner withdrawal to its NEAR account");
    expect(scene?.labels).toContain("Owner action, outside recovery claims");
    const ev = storyEvidence();
    const failed: Evidence = {
      ...ev,
      assertions: ev.assertions.map((a) => {
        if (a.id !== "owner-withdrawal") return a;
        const o = a.observed as { assets: Record<string, unknown>[] };
        const wnearFailed = { ...o.assets[1], attempts: [{ tx_hash: "SYNTHETICfail", success: false, returned: "0", intents_after: (STORY.before.wnear + STORY.buy).toString(), near_after: "0", error: "SYNTHETIC ft_transfer refunded" }], outcome: "failed" };
        return { ...a, passed: false, observed: { ...o, assets: [o.assets[0], wnearFailed] } };
      }),
    };
    const failedScene = walk(failed).find((sc) => sc.title.startsWith("8 ·"));
    expect(failedScene?.title).toBe("8 · Owner withdrawal: not-held");
    const caption = failedScene?.captions.join(" ") ?? "";
    expect(caption).toContain("wNEAR withdrawal failed after 1 attempt (SYNTHETIC ft_transfer refunded); 104.0000 wNEAR stays in the owner's Intents account");
    expect(caption).not.toMatch(/withdraws .* to its NEAR account/);
  });

  it("states the agent's objective, the allocation outcome and the withheld order's identity", () => {
    const ev = storyEvidence();
    const s = short(ev);
    expect(s[0]?.body).toContain("Agent's objective: keep the portfolio near 50% USDC / 50% wNEAR by USD value. An instruction to the agent, not a rule the contract enforces.");
    // Shares derived in the page test from the same SYNTHETIC inputs: 2,000 USDC + 100 wNEAR at $1 / $3, then the trade.
    const trade = s[1];
    const tradeCaption = trade?.captions.find((c) => c.startsWith("A recorded"));
    expect(tradeCaption).toContain("A recorded synthetic-model-1 proposal, replayed, sells 12.34 USDC for 4 wNEAR, filled exactly as signed. USDC share: 86.96% to 86.43%, target 50%.");
    // The allocation sentence does not add a caption frame to the short cut.
    expect(chunks(tradeCaption ?? "")).toHaveLength(1);
    const scenes = walk(ev);
    const withheld = scenes.find((sc) => sc.title.startsWith("4 ·"));
    expect(withheld?.captions.join(" ")).toContain("A scripted second order (order id 7) is signed and withheld. Before revocation the verifier's simulation accepts this exact bundle.");
    for (const text of ["SYNTHETICnonce", "9".repeat(64), "simulate_intents"]) expect(withheld?.body).toContain(text);
    expect(scenes.find((sc) => sc.title.startsWith("2b ·"))?.body).toContain("86.96% → 86.43% (agent&#39;s target 50%)");
    expect(scenes.find((sc) => sc.title.startsWith("2a ·"))?.body).toContain("SYNTHETIC reason: USDC is overweight");
    expect(scenes.find((sc) => sc.title.startsWith("2a ·"))?.captions.join(" ")).toContain("replayed with no provider call");
  });

  it("opens the short cut with the problem and the walkthrough with the README's lead line", () => {
    const first = short()[0];
    expect(first?.title).toBe("Give an AI agent trading power. Keep the power to stop it.");
    expect(first?.captions[0]).toBe(PROBLEM);
    // The two sentences keep revocation and recovery apart and claim no key-free agent.
    expect(LEAD).toBe("An AI agent trades your treasury on NEAR Intents without holding a signing key. A contract signs each order inside your limits; one owner call voids every signed order that has not executed, and recovery returns the funds without the agent.");
    expect(first?.body).not.toMatch(/voids everything|never holds a key/);
    const walkFirst = walk(storyEvidence())[0];
    expect(walkFirst?.title).toBe("Give an AI agent trading power. Keep the power to stop it.");
    expect(walkFirst?.captions[0]).toBe("Give an AI agent trading power. Keep the power to stop it.");
  });
});
