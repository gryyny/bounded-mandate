// Both video cuts, from SYNTHETIC story evidence (see video-story-specimen.ts); no frames are rendered here.
import { describe, expect, it } from "vitest";
import { bindDemo } from "../src/evidence/binding.js";
import { revocationStory } from "../src/page/story.js";
import { type Evidence } from "../src/types.js";
import { SHORT_RANGE_S, chunks, type LogStep, shortPace, shortScenes, walkthroughScenes } from "../src/video/make.js";
import { ATTACKS, STORY, expiredStoryEvidence, storyEvidence } from "./video-story-specimen.js";

const STEPS: LogStep[] = [
  "Mandate reviewed in the console",
  "Grant and limits",
  "Bounded agent proposal",
  "Filler fills",
  "Second signed order withheld",
  "Hostile requests refused",
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
      ? { ...a, observed: { ...(a.observed as object), decision: { model: STORY.model, decision_text: JSON.stringify({ action: "propose", proposal: { sell: "usdc", sell_amount: STORY.sell.toString(), max_concession_bps: 40 }, reason: "SYNTHETIC reason: USDC is overweight" }), prompt_sha256: "SYNTHETIC", raw_output_sha256: "SYNTHETIC" } } }
      : a,
  ),
});
const walk = (ev: Evidence) => walkthroughScenes(withDecision(ev), null, bindDemo(ev, null), STEPS, {}, STORY.model);

const captions = (mainnet = false) => shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), mainnet).flatMap((s) => s.captions.flatMap(chunks));

describe("short video cut", () => {
  it("cold-opens on the rejected relay, then tells the nine stages in order, between the position and the paths", () => {
    const scenes = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false);
    expect(scenes.map((s) => s.title)).toEqual([
      "A withheld signed order, relayed after revocation",
      "Let an AI agent trade within limits a contract enforces",
      "1 · Reviewed in the console",
      "2 · Grant and limits",
      "3 · Bounded proposal and trade",
      "4 · Signed order withheld",
      "5 · Hostile requests",
      "6 · Owner revocation",
      "7 · Withheld order relayed",
      "8 · Recovery to the owner's Intents account",
      "9 · Owner withdrawal to NEAR",
      "Check it yourself",
    ]);
    expect(scenes[0]?.captions.flatMap(chunks)).toEqual(["A signed order is rejected 37 s before its deadline: the owner revoked the grant, and its signing key no longer exists."]);
  });

  it("puts the recorded chain state of each stage in the strip", () => {
    const scenes = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false);
    const strip = (title: string) => scenes.find((s) => s.title === title)?.strip;
    expect(strip("1 · Reviewed in the console")).toMatchObject({ grant_status: "none", key_present: null, open_orders: 0 });
    expect(strip("4 · Signed order withheld")).toMatchObject({ grant_status: "active", key_present: true, open_orders: 1 });
    expect(strip("6 · Owner revocation")).toMatchObject({ grant_status: "revoked", key_present: false, open_orders: 0 });
    const after = { usdc: (STORY.before.usdc - STORY.sell).toString(), wnear: (STORY.before.wnear + STORY.buy).toString() };
    expect(strip("8 · Recovery to the owner's Intents account")).toMatchObject({ owner_intents: after, owner_near: { usdc: "0", wnear: "0" } });
    expect(strip("9 · Owner withdrawal to NEAR")).toMatchObject({ owner_intents: { usdc: "0", wnear: "0" }, owner_near: after });
    expect(scenes.find((s) => s.title === "Check it yourself")?.strip).toBeUndefined();
  });

  it("omits the cold open when the rejection is not evidence of revocation", () => {
    const ev = expiredStoryEvidence();
    const scenes = shortScenes(ev, bindDemo(ev, null), false);
    expect(scenes[0]?.title).toBe("Let an AI agent trade within limits a contract enforces");
    expect(scenes.map((s) => s.title)).not.toContain("A withheld signed order, relayed after revocation");
  });

  it("captions carry the run's numbers, derived from the evidence", () => {
    const text = captions().join("\n");
    const layers = "local validation 1, agent key permission 1, contract method check 1, policy validation 1, verifier 1";
    for (const expected of [
      "2,000.00 USDC and 100.0000 wNEAR",
      "$2,300.00",
      "($460.00)",
      `A recorded ${STORY.model} proposal sells 12.34 USDC`,
      "5.0000 wNEAR for 14.99 USDC",
      `${String(ATTACKS.length)} of ${String(ATTACKS.length)} scripted hostile requests refused, nothing changed: ${layers}.`,
      "37 s before its deadline",
      "recovers 1,987.66 USDC and 104.0000 wNEAR into its Intents account",
      "Separately, outside recovery, the owner withdraws 1,987.66 USDC and 104.0000 wNEAR to its NEAR account",
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
    expect(text).toContain("In this run 1 of 9 story stages are not shown as evidence: Withheld order relayed (inconclusive).");
  });

  it("keeps acceptance certification and the demo's story outcome apart", () => {
    const ev = expiredStoryEvidence();
    const certified = { ...bindDemo(ev, null), certified: true, reasons: [] };
    const closing = shortScenes(ev, certified, false).at(-1);
    // Certification comes from the binding alone; it does not turn the failed stage into a pass.
    expect(closing?.body).toContain("Certified for this demo:");
    expect(closing?.captions.join(" ")).toContain("Withheld order relayed (inconclusive)");
    const clean = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false).at(-1);
    // And a fully held story does not make an uncertified run certified.
    expect(clean?.body).toContain("Not certified for this demo");
    expect(clean?.captions.join(" ")).not.toContain("not shown as evidence");
  });

  it("walkthrough narrates the expired relay's outcome instead of its rejection", () => {
    const expired = walk(expiredStoryEvidence());
    const relay = expired.find((sc) => sc.title.startsWith("7 ·"));
    expect(relay?.title).toBe("7 · The withheld order is relayed: inconclusive");
    expect(relay?.captions.join(" ")).toContain("relayed 4.5 s after its deadline");
    expect(expired.flatMap((sc) => sc.captions).join(" ")).not.toContain("The verifier rejects it");
    const held = walk(storyEvidence()).find((sc) => sc.title.startsWith("7 ·"));
    expect(held?.captions.join(" ")).toContain("Another account relays the withheld order 37 s before its deadline. The verifier rejects it");
  });

  it("walkthrough steps through the attack log by enforcement layer, from the recorded results", () => {
    const scenes = walk(storyEvidence()).filter((sc) => sc.title.includes("Attack log"));
    // One scene per layer the attacks actually reached, in the order they appear.
    expect(scenes.map((sc) => sc.title)).toEqual([
      "5a · Attack log: local validation, 1 of 1 refused",
      "5b · Attack log: agent key permission, 1 of 1 refused",
      "5c · Attack log: contract method check, 1 of 1 refused",
      "5d · Attack log: policy validation, 1 of 1 refused",
      "5e · Attack log: verifier, 1 of 1 refused",
    ]);
    expect(scenes[3]?.body).toContain("contract/src/lib.rs:905");
    expect(scenes[3]?.body).toContain("per-order cap exceeded");
    const total = scenes.flatMap((sc) => sc.captions.flatMap(chunks)).length;
    expect(total).toBe(scenes.length);
    // A request that reached a different boundary than expected is shown under that layer and not as refused.
    const ev = storyEvidence();
    const moved = { ...ev, assertions: ev.assertions.map((a) => (a.id === "attack-direct-over-cap" ? { ...a, passed: false, observed: { ...(a.observed as object), observed: "not-stopped", contained: false } } : a)) };
    const notStopped = walk(moved).find((sc) => sc.title.includes("not stopped"));
    expect(notStopped?.title).toBe("5d · Attack log: not stopped, 0 of 1 refused");
    expect(notStopped?.captions.join(" ")).toContain("were not refused at their expected layer");
    expect(notStopped?.body).toContain("NOT HELD");
  });

  it("walkthrough shows the withdrawal as the owner's action outside recovery, and narrates a failed withdrawal as failed", () => {
    const scene = walk(storyEvidence()).find((sc) => sc.title.startsWith("9 ·"));
    expect(scene?.title).toBe("9 · Owner withdrawal to its NEAR account");
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
    const failedScene = walk(failed).find((sc) => sc.title.startsWith("9 ·"));
    expect(failedScene?.title).toBe("9 · Owner withdrawal: not-held");
    const caption = failedScene?.captions.join(" ") ?? "";
    expect(caption).toContain("wNEAR withdrawal failed after 1 attempt (SYNTHETIC ft_transfer refunded); 104.0000 wNEAR stays in the owner's Intents account");
    expect(caption).not.toMatch(/withdraws .* to its NEAR account/);
  });

  it("states the agent's objective, the allocation outcome and the withheld order's identity", () => {
    const ev = storyEvidence();
    const short = shortScenes(ev, bindDemo(ev, null), false);
    expect(short[1]?.body).toContain("Agent's objective: keep the portfolio near 50% USDC / 50% wNEAR by USD value. An instruction to the agent, not a rule the contract enforces.");
    // Shares derived in the page test from the same SYNTHETIC inputs: 2,000 USDC + 100 wNEAR at $1 / $3, then the trade.
    expect(short.find((sc) => sc.title === "3 · Bounded proposal and trade")?.captions.join(" ")).toContain("A recorded synthetic-model-1 proposal sells 12.34 USDC for 4.0000 wNEAR, signed by the contract and filled exactly. USDC share: 86.96% to 86.43%, target 50%.");
    // The allocation sentence does not add a caption frame to the short cut.
    expect(short.find((sc) => sc.title === "3 · Bounded proposal and trade")?.captions.flatMap(chunks)).toHaveLength(1);
    const scenes = walk(ev);
    const withheld = scenes.find((sc) => sc.title.startsWith("4 ·"));
    expect(withheld?.captions.join(" ")).toContain("A scripted second order, 7, is signed and withheld. Before revocation the verifier's simulation accepts this exact bundle.");
    for (const text of ["SYNTHETICnonce", "9".repeat(64), "simulate_intents"]) expect(withheld?.body).toContain(text);
    expect(scenes.find((sc) => sc.title.startsWith("3b ·"))?.body).toContain("86.96% → 86.43% (agent&#39;s target 50%)");
    expect(scenes.find((sc) => sc.title.startsWith("3 ·"))?.body).toContain("SYNTHETIC reason: USDC is overweight");
  });

  it("follows the cold open with the README's plain claim in one caption frame", () => {
    const first = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false)[1];
    expect(first?.body).toContain("Once a revocation is confirmed, signed orders already issued fail too");
    expect(first?.body).not.toContain("Revoke the entire grant");
    expect(first?.captions.flatMap(chunks)).toHaveLength(1);
  });
});
