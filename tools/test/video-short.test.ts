// The short video cut, from SYNTHETIC story evidence (see video-story-specimen.ts); no frames are rendered here.
import { describe, expect, it } from "vitest";
import { bindDemo } from "../src/evidence/binding.js";
import { SHORT_RANGE_S, chunks, shortPace, shortScenes } from "../src/video/make.js";
import { STORY, storyEvidence } from "./video-story-specimen.js";

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
});
