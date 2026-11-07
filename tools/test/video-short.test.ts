// Both video cuts, from SYNTHETIC story evidence (see video-story-specimen.ts); no frames are rendered here.
import { describe, expect, it } from "vitest";
import { bindDemo } from "../src/evidence/binding.js";
import { revocationStory } from "../src/page/story.js";
import { type Evidence } from "../src/types.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { OWNER_CONTROLS_LABEL } from "../src/evidence/journey.js";
import { REPO_ROOT } from "../src/evidence/report.js";
import { SHORT_RANGE_S, chunks, consoleShots, type LogStep, shortPace, shortScenes, walkthroughScenes } from "../src/video/make.js";
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

const captions = (mainnet = false) => shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), mainnet).flatMap((s) => s.captions.flatMap(chunks));

describe("short video cut", () => {
  it("opens with the lead line, then tells the owner's eight journey steps in order, then the paths", () => {
    const scenes = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false);
    expect(scenes.map((s) => s.title)).toEqual([
      "Give an AI agent trading power. Keep the power to stop it.",
      "1 · Read the mandate and its limits",
      "2 · The agent makes a permitted trade",
      "3 · Hostile requests are refused",
      "4 · Spot the withheld signed order",
      "5 · Revoke with the owner controls",
      "6 · The same order is rejected",
      "7 · Recover without agent, oracle or MPC",
      "8 · Withdraw to the owner's NEAR account",
      "Check it yourself",
    ]);
    // The lead line is the first caption, verbatim and alone; the next states what the run is.
    expect(scenes[0]?.captions.flatMap(chunks)).toEqual([
      "Give an AI agent trading power. Keep the power to stop it.",
      "One local sandbox run with labelled test doubles and a replayed model recording, in eight steps.",
    ]);
    expect(scenes[0]?.labels).toEqual(["Local NEAR sandbox", "Real Intents verifier WASM", "Test doubles: MPC, oracle, tokens", "No mainnet"]);
    // Each step's status pill is its recorded outcome.
    for (const sc of scenes.slice(1, 9)) expect(sc.body).toMatch(/<span class="pill ok">/);
  });

  it("puts the recorded chain state of each step's last stage in the strip", () => {
    const scenes = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false);
    const strip = (n: string) => scenes.find((s) => s.title.startsWith(`${n} ·`))?.strip;
    expect(strip("1")).toMatchObject({ grant_status: "active", key_present: true, open_orders: 0 });
    expect(strip("3")).toMatchObject({ grant_status: "active", key_present: true, open_orders: 0 });
    expect(strip("4")).toMatchObject({ grant_status: "active", key_present: true, open_orders: 1 });
    expect(strip("5")).toMatchObject({ grant_status: "revoked", key_present: false, open_orders: 0 });
    const after = { usdc: (STORY.before.usdc - STORY.sell).toString(), wnear: (STORY.before.wnear + STORY.buy).toString() };
    expect(strip("7")).toMatchObject({ owner_intents: after, owner_near: { usdc: "0", wnear: "0" } });
    expect(strip("8")).toMatchObject({ owner_intents: { usdc: "0", wnear: "0" }, owner_near: after });
    expect(scenes.find((s) => s.title === "Check it yourself")?.strip).toBeUndefined();
  });

  it("shows no ok pill over a step whose outcome values are absent, and never calls a scripted proposal model output", () => {
    const ev = storyEvidence();
    const unbuilt = { ...ev, assertions: ev.assertions.map((a) => (a.id === "trade-executed" ? { ...a, observed: { ...(a.observed as object), signed: { ...(a.observed as { signed: object }).signed, buy_amount: null } } } : a)) };
    const two = shortScenes(unbuilt, bindDemo(unbuilt, null), false).find((s) => s.title.startsWith("2 ·"));
    expect(two?.title).toBe("2 · The agent's trade: not in this evidence");
    expect(two?.body).toContain('<span class="pill bad">not in this evidence</span>');
    expect(two?.body).not.toContain('<span class="pill ok">');

    const scripted = { ...ev, assertions: ev.assertions.map((a) => (a.id === "model-proposal-on-chain" ? { ...a, observed: { ...(a.observed as object), mode: "scripted", decision: null } } : a)) };
    const first = shortScenes(scripted, bindDemo(scripted, null), false)[0];
    expect(first?.captions[1]).toBe("One local sandbox run with labelled test doubles and a scripted proposal, not model output, in eight steps.");
    expect(first?.body).not.toContain("replayed model recording");
    expect(shortScenes(ev, bindDemo(ev, null), false)[0]?.captions[1]).toBe("One local sandbox run with labelled test doubles and a replayed model recording, in eight steps.");
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
    const short = shortScenes(ev, bindDemo(ev, null), false);
    expect(short[0]?.captions[1]).toBe("One local sandbox run with labelled test doubles and a scripted proposal, not model output, in eight steps.");
    expect(short.flatMap((s) => [s.body, ...s.captions]).join(" ")).not.toMatch(/replayed model recording|recorded genuine model output/i);
    const walked = walkthroughScenes(declined(withDecision(storyEvidence())), null, bindDemo(ev, null), STEPS, {}, STORY.model);
    const trade = walked.find((s) => s.title.startsWith("2a ·"));
    expect(trade?.title).toBe("2a · Scripted proposal, not model output");
    expect(trade?.captions.join(" ")).not.toMatch(/recorded genuine model output|replayed/i);
    expect(walked.flatMap((s) => s.captions).join(" ")).not.toMatch(/replayed with no provider call|the model step is a replay/);
  });

  it("never titles or narrates a step that is not evidence with its success wording", () => {
    const ev = expiredStoryEvidence();
    const scenes = shortScenes(ev, bindDemo(ev, null), false);
    expect(scenes[0]?.title).toBe("Give an AI agent trading power. Keep the power to stop it.");
    const six = scenes.find((s) => s.title.startsWith("6 ·"));
    expect(six?.title).toBe("6 · The withheld order relayed: inconclusive");
    expect(six?.body).toContain('<span class="pill warn">inconclusive</span>');
    expect(six?.body).not.toContain('<span class="pill ok">');
    expect(scenes.map((s) => s.title)).not.toContain("6 · The same order is rejected");
    const failed = { ...storyEvidence(), assertions: storyEvidence().assertions.map((a) => (a.id === "revoke-through-console" ? { ...a, passed: false } : a)) };
    const five = shortScenes(failed, bindDemo(failed, null), false).find((s) => s.title.startsWith("5 ·"));
    expect(five?.title).toBe("5 · Owner revocation: did not hold");
    expect(five?.body).toContain('<span class="pill bad">did not hold</span>');
    expect(five?.captions.join(" ")).not.toContain("Key removal is confirmed");
  });

  it("captions carry the run's numbers, derived from the evidence", () => {
    const text = captions().join("\n");
    const layers = "local validation 1, agent key permission 1, contract method check 1, policy validation 1, verifier 1";
    for (const expected of [
      `The owner console reads it back from the sandbox: grant ${CONSOLE_RENDERED.grant_status}, key registered on the verifier, limits as granted.`,
      "After an exact preview, the owner revokes in the console with the local sandbox test signer, not a wallet. Key removal is confirmed.",
      "$2,300.00",
      "($460.00)",
      `A recorded ${STORY.model} proposal, replayed, sells 12.34 USDC`,
      "5 wNEAR for 14.99 USDC",
      `${String(ATTACKS.length)} of ${String(ATTACKS.length)} scripted hostile requests refused, nothing changed: ${layers}.`,
      "37 s before its deadline",
      "the MPC test double on hold, the owner recovers 1,987.66 USDC and 104 wNEAR into its Intents account",
      "Separately, outside recovery, the owner withdraws 1,987.66 USDC and 104 wNEAR to its NEAR account",
      "Revocation is not instant; the claim starts at confirmed key removal.",
    ]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain("Mainnet run pending approval; no mainnet transaction executed.");
    expect(captions(true).join("\n")).not.toContain("no mainnet transaction executed");
  });

  it("fits the 45-90 s target", () => {
    const total = captions().reduce((t, c) => t + shortPace(c), 0);
    expect(total).toBeGreaterThanOrEqual(SHORT_RANGE_S[0]);
    expect(total).toBeLessThanOrEqual(SHORT_RANGE_S[1]);
  });

  it("refuses evidence missing a stage's assertion, or with a receipt no stage shows", () => {
    const ev = storyEvidence();
    const noRelay = { ...ev, assertions: ev.assertions.filter((a) => a.id !== "withheld-rejected") };
    expect(() => shortScenes(noRelay, bindDemo(noRelay, null), false)).toThrow(/Withheld order relayed: assertion withheld-rejected/);
    const noWithdrawal = { ...ev, assertions: ev.assertions.filter((a) => a.id !== "owner-withdrawal") };
    expect(() => shortScenes(noWithdrawal, bindDemo(noWithdrawal, null), false)).toThrow(/Owner withdrawal to NEAR: assertion owner-withdrawal/);
    const extra = { ...ev, receipts: [...ev.receipts, { label: "SYNTHETIC unrelated call", outcome: "success" as const, detail: {} }] };
    expect(() => shortScenes(extra, bindDemo(extra, null), false)).toThrow(/receipts not bound to any story stage: SYNTHETIC unrelated call/);
  });

  it("states the certification only from the binding", () => {
    const scenes = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false);
    const closing = scenes.at(-1)?.body ?? "";
    expect(closing).toContain("Not certified for this demo");
    expect(closing).not.toMatch(/Certified for this demo:/);
  });

  it("narrates an expired withheld order marked passed:false as inconclusive, not as rejected by revocation", () => {
    const ev = expiredStoryEvidence();
    const rejected = revocationStory(ev).find((st) => st.key === "rejected");
    expect(rejected?.outcome).toBe("inconclusive");
    const text = shortScenes(ev, bindDemo(ev, null), false).flatMap((sc) => sc.captions.flatMap(chunks)).join("\n");
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
    const clean = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false).at(-1);
    // And a fully held story does not make an uncertified run certified.
    expect(clean?.body).toContain("Not certified for this demo");
    expect(clean?.captions.join(" ")).not.toContain("not shown as evidence");
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
    expect(notStopped?.captions.join(" ")).toContain("were not refused at their expected layer");
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
    const short = shortScenes(ev, bindDemo(ev, null), false);
    expect(short[0]?.body).toContain("Agent's objective: keep the portfolio near 50% USDC / 50% wNEAR by USD value. An instruction to the agent, not a rule the contract enforces.");
    // Shares derived in the page test from the same SYNTHETIC inputs: 2,000 USDC + 100 wNEAR at $1 / $3, then the trade.
    const trade = short.find((sc) => sc.title === "2 · The agent makes a permitted trade");
    expect(trade?.captions.join(" ")).toContain("A recorded synthetic-model-1 proposal, replayed, sells 12.34 USDC for 4 wNEAR, filled exactly as signed. USDC share: 86.96% to 86.43%, target 50%.");
    // The allocation sentence does not add a caption frame to the short cut.
    expect(trade?.captions.flatMap(chunks)).toHaveLength(1);
    expect(trade?.labels).toContain("Recorded genuine model output");
    const scenes = walk(ev);
    const withheld = scenes.find((sc) => sc.title.startsWith("4 ·"));
    expect(withheld?.captions.join(" ")).toContain("A scripted second order (order id 7) is signed and withheld. Before revocation the verifier's simulation accepts this exact bundle.");
    for (const text of ["SYNTHETICnonce", "9".repeat(64), "simulate_intents"]) expect(withheld?.body).toContain(text);
    expect(scenes.find((sc) => sc.title.startsWith("2b ·"))?.body).toContain("86.96% → 86.43% (agent&#39;s target 50%)");
    expect(scenes.find((sc) => sc.title.startsWith("2a ·"))?.body).toContain("SYNTHETIC reason: USDC is overweight");
    expect(scenes.find((sc) => sc.title.startsWith("2a ·"))?.captions.join(" ")).toContain("replayed with no provider call");
  });

  it("opens both cuts with the README's lead line, verbatim, and the one-sentence claim", () => {
    const first = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false)[0];
    expect(first?.title).toBe("Give an AI agent trading power. Keep the power to stop it.");
    expect(first?.body).toContain("once the owner&#39;s revocation is confirmed, every outstanding order signed under that grant fails");
    expect(first?.body).not.toContain("Revoke the entire grant");
    const walkFirst = walk(storyEvidence())[0];
    expect(walkFirst?.title).toBe("Give an AI agent trading power. Keep the power to stop it.");
    expect(walkFirst?.captions[0]).toBe("Give an AI agent trading power. Keep the power to stop it.");
  });
});
