// SYNTHETIC presentation specimens only. Chromium checks actual 1080p frames; no chain is queried and no video is
// published. Temporary screenshots are removed after the test and never enter an evidence bundle.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bindDemo } from "../src/evidence/binding.js";
import { liveView } from "../src/page/mainnet.js";
import { mainnetCut, mainnetScenes, renderFrames, walkthroughPace, walkthroughScenes } from "../src/video/make.js";
import { mainnetRunEvidence, STORY, storyEvidence } from "./video-story-specimen.js";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser.close(); });

describe("video frame fit in Chromium (SYNTHETIC specimens)", () => {
  it("fits the expanded required-case inventory without clipping a row or overlapping its captions", async () => {
    const original = storyEvidence();
    const ev = { ...original, assertions: original.assertions.map((a) => a.id === "model-proposal-on-chain" ? { ...a, observed: { mode: "recorded-model", decision: { prompt_sha256: "SYNTHETIC", raw_output_sha256: "SYNTHETIC", adapter_verdict: { kind: "declined" } } } } : a) };
    const binding = bindDemo(ev, null);
    const steps = ["Grant and limits", "Mandate reviewed in the console", "Bounded agent proposal", "Filler fills", "Hostile requests refused", "Second signed order withheld", "Owner revokes", "Withheld order relayed", "Agent, oracle and MPC disabled", "Recovery to the owner", "Owner withdrawal"].map((title) => ({ title, lines: [] }));
    const scenes = walkthroughScenes(ev, null, binding, steps, {}, STORY.model).filter((s) => s.title.startsWith("Acceptance gates"));
    const dir = mkdtempSync(join(tmpdir(), "bm-SYNTHETIC-video-gates-"));
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      const frames = await renderFrames(page, { name: "walkthrough", mp4: join(dir, "unused.mp4"), srt: join(dir, "unused.srt"), framesDir: dir, scenes, pace: walkthroughPace, range: null }, binding);
      expect(new Set(frames.map((f) => f.title)).size).toBe(scenes.length);
      expect(frames.length).toBeGreaterThanOrEqual(scenes.length);
    } finally {
      await page.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fits the future mainnet transaction segment in both cuts using explicitly synthetic receipt data", async () => {
    const binding = bindDemo(storyEvidence(), null);
    const cut = mainnetCut(liveView(mainnetRunEvidence()));
    const dir = mkdtempSync(join(tmpdir(), "bm-SYNTHETIC-video-mainnet-"));
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    try {
      for (const form of ["short", "walkthrough"] as const) {
        const scenes = mainnetScenes(cut, form);
        const frames = await renderFrames(page, { name: form, mp4: join(dir, "unused.mp4"), srt: join(dir, "unused.srt"), framesDir: join(dir, form), scenes, pace: walkthroughPace, range: null }, binding);
        expect(new Set(frames.map((f) => f.title)).size).toBe(scenes.length);
      }
    } finally {
      await page.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
