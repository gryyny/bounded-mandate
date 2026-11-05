// The short video cut, from SYNTHETIC story evidence (see video-story-specimen.ts); no frames are rendered here.
import { describe, expect, it } from "vitest";
import { bindDemo } from "../src/evidence/binding.js";
import { revocationStory } from "../src/page/story.js";
import { type Evidence } from "../src/types.js";
import { SHORT_RANGE_S, chunks, type LogStep, shortPace, shortScenes, walkthroughScenes } from "../src/video/make.js";
import { STORY, expiredStoryEvidence, storyEvidence } from "./video-story-specimen.js";

const captions = (mainnet = false) => shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), mainnet).flatMap((s) => s.captions.flatMap(chunks));

describe("short video cut", () => {
  it("tells the seven stages in order, between the position and the paths", () => {
    const scenes = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false);
    expect(scenes.map((s) => s.title)).toEqual([
      "Delegate trading within on‑chain limits",
      "1 · Balances",
      "2 · Trading limits",
      "3 · Successful trade",
      "4 · Signed pending order",
      "5 · Confirmed revocation",
      "6 · Rejected execution",
      "7 · Recovered balances",
      "Check it yourself",
    ]);
  });

  it("captions carry the run's numbers, derived from the evidence", () => {
    const text = captions().join("\n");
    for (const expected of ["2,000.00 USDC and 100.0000 wNEAR", "$2,300.00", "($460.00)", `A recorded ${STORY.model} proposal sells 12.34 USDC`, "5.0000 wNEAR for 14.99 USDC", "37 s before its deadline", "recovers 1,987.66 USDC and 104.0000 wNEAR"]) {
      expect(text).toContain(expected);
    }
    expect(text).toContain("Mainnet run pending approval; no mainnet transaction executed.");
    expect(captions(true).join("\n")).not.toContain("no mainnet transaction executed");
  });

  it("fits the 45-75 s target", () => {
    const total = captions().reduce((t, c) => t + shortPace(c), 0);
    expect(total).toBeGreaterThanOrEqual(SHORT_RANGE_S[0]);
    expect(total).toBeLessThanOrEqual(SHORT_RANGE_S[1]);
  });

  it("refuses evidence missing a stage's assertion, or with a receipt no stage shows", () => {
    const ev = storyEvidence();
    const noRelay = { ...ev, assertions: ev.assertions.filter((a) => a.id !== "withheld-rejected") };
    expect(() => shortScenes(noRelay, bindDemo(noRelay, null), false)).toThrow(/Rejected execution: assertion withheld-rejected/);
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
    expect(text).toContain("Rejected execution is inconclusive in this run: the withheld order was relayed 4.5 s after its deadline");
    expect(text).toContain("did not hold");
    expect(text).toContain("In this run 1 of 7 story stages are not shown as evidence: Rejected execution (inconclusive).");
  });

  it("keeps acceptance certification and the demo's story outcome apart", () => {
    const ev = expiredStoryEvidence();
    const certified = { ...bindDemo(ev, null), certified: true, reasons: [] };
    const closing = shortScenes(ev, certified, false).at(-1);
    // Certification comes from the binding alone; it does not turn the failed stage into a pass.
    expect(closing?.body).toContain("Certified for this demo:");
    expect(closing?.captions.join(" ")).toContain("Rejected execution (inconclusive)");
    const clean = shortScenes(storyEvidence(), bindDemo(storyEvidence(), null), false).at(-1);
    // And a fully held story does not make an uncertified run certified.
    expect(clean?.body).toContain("Not certified for this demo");
    expect(clean?.captions.join(" ")).not.toContain("not shown as evidence");
  });

  it("walkthrough narrates the expired relay's outcome instead of its rejection", () => {
    const withDecision = (ev: Evidence): Evidence => ({
      ...ev,
      assertions: ev.assertions.map((a) =>
        a.id === "model-proposal-on-chain"
          ? { ...a, observed: { ...(a.observed as object), decision: { model: STORY.model, decision_text: JSON.stringify({ proposal: { sell: "usdc", sell_amount: STORY.sell.toString(), max_concession_bps: 40 } }), prompt_sha256: "SYNTHETIC", raw_output_sha256: "SYNTHETIC" } } }
          : a,
      ),
    });
    const steps: LogStep[] = ["Roles and limits", "Genuine model proposal", "Filler fills", "Second signed order withheld", "Malicious requests", "Owner revokes", "Withheld order relayed", "Agent, oracle and MPC disabled", "Recovery to the owner"].map((title) => ({ title, lines: [] }));
    const scenes = (ev: Evidence) => walkthroughScenes(ev, null, bindDemo(ev, null), steps, {}, STORY.model);
    const expired = scenes(withDecision(expiredStoryEvidence()));
    const relay = expired.find((sc) => sc.title.startsWith("7 ·"));
    expect(relay?.title).toBe("7 · The withheld order is relayed: inconclusive");
    expect(relay?.captions.join(" ")).toContain("relayed 4.5 s after its deadline");
    expect(expired.flatMap((sc) => sc.captions).join(" ")).not.toContain("The verifier rejects it");
    const held = scenes(withDecision(storyEvidence())).find((sc) => sc.title.startsWith("7 ·"));
    expect(held?.captions.join(" ")).toContain("Another account relays the withheld order 37 s before its deadline. The verifier rejects it");
  });

  it("states the agent's objective, the allocation outcome and the withheld order's identity", () => {
    const ev = storyEvidence();
    const short = shortScenes(ev, bindDemo(ev, null), false);
    expect(short[0]?.body).toContain("Agent's objective: keep the portfolio near 50% USDC / 50% wNEAR by USD value. An instruction to the agent, not a rule the contract enforces.");
    // Shares derived in the page test from the same SYNTHETIC inputs: 2,000 USDC + 100 wNEAR at $1 / $3, then the trade.
    expect(short.find((sc) => sc.title === "3 · Successful trade")?.captions.join(" ")).toContain("A recorded synthetic-model-1 proposal sells 12.34 USDC for 4.0000 wNEAR, signed by the contract and filled exactly. USDC share: 86.96% to 86.43%, target 50%.");
    // The allocation sentence does not add a caption frame to the short cut.
    expect(short.find((sc) => sc.title === "3 · Successful trade")?.captions.flatMap(chunks)).toHaveLength(1);
    const steps: LogStep[] = ["Roles and limits", "Genuine model proposal", "Filler fills", "Second signed order withheld", "Malicious requests", "Owner revokes", "Withheld order relayed", "Agent, oracle and MPC disabled", "Recovery to the owner"].map((title) => ({ title, lines: [] }));
    const withDecision: Evidence = {
      ...ev,
      assertions: ev.assertions.map((a) =>
        a.id === "model-proposal-on-chain"
          ? { ...a, observed: { ...(a.observed as object), decision: { model: STORY.model, decision_text: JSON.stringify({ proposal: { sell: "usdc", sell_amount: STORY.sell.toString(), max_concession_bps: 40 } }), prompt_sha256: "SYNTHETIC", raw_output_sha256: "SYNTHETIC" } } }
          : a,
      ),
    };
    const walk = walkthroughScenes(withDecision, null, bindDemo(withDecision, null), steps, {}, STORY.model);
    const withheld = walk.find((sc) => sc.title.startsWith("4 ·"));
    expect(withheld?.captions.join(" ")).toContain("A scripted second order, 7, is signed and withheld. Before revocation the verifier's simulation accepts this exact bundle.");
    for (const text of ["SYNTHETICnonce", "9".repeat(64), "simulate_intents"]) expect(withheld?.body).toContain(text);
    expect(walk.find((sc) => sc.title.startsWith("3 ·"))?.body).toContain("86.96% → 86.43% (agent&#39;s target 50%)");
  });
});
