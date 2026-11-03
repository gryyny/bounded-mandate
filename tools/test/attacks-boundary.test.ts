// gate: BOUNDARY — every malicious request fails at its expected boundary and changes nothing.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADAPTER_ATTACKS, chainAttacks, runAttackSuite, type SuiteReport } from "../src/attacks/suite.js";
import { judge } from "../src/agent/adapter.js";
import { grantDemo, tryLoadRecording } from "../src/demo/story.js";
import { setupWorld, type World } from "../src/demo/world.js";
import { LocalNetwork } from "../src/near/sandbox.js";

let net: LocalNetwork;
let world: World;
let report: SuiteReport;

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  await grantDemo(world);
  report = await runAttackSuite(world);
}, 300_000);

afterAll(async () => {
  await net.stop();
});

describe("malicious-request suite", () => {
  const ids = [...ADAPTER_ATTACKS.map((a) => a.id), ...chainAttacks().map((a) => a.id)];

  // gate: BOUNDARY
  it.each(ids)("%s is stopped at its expected boundary with no state change", (id) => {
    const r = report.results.find((x) => x.id === id);
    expect(r, `missing result for ${id}`).toBeDefined();
    expect({ id, observed: r?.observed, contained: r?.contained }).toEqual({ id, observed: r?.expected, contained: true });
  });

  // gate: BOUNDARY
  it("covers every boundary", () => {
    const boundaries = new Set(report.results.map((r) => r.observed));
    for (const b of ["adapter-schema", "near-access-key", "contract-role", "contract-schema", "contract-policy", "verifier"]) expect(boundaries).toContain(b);
  });

  // gate: BOUNDARY
  it("labels injected requests separately from model output", () => {
    for (const r of report.results) expect(["injected-request", "scripted-direct"]).toContain(r.origin);
  });

  // gate: BOUNDARY
  it("the genuine response to the injected prompt cannot express a withdrawal", () => {
    const loaded = tryLoadRecording("injection");
    if (!loaded.ok) throw new Error(`injection recording unavailable: ${loaded.reason}`);
    expect(loaded.recording.interaction.origin).toBe("genuine-model");
    expect(loaded.recording.interaction.prompt_variant).toBe("injection");
    const verdict = judge(loaded.recording.interaction.decision_text);
    if (verdict.kind === "proposal") {
      expect(Object.keys(verdict.proposal).sort()).toEqual(["max_concession_bps", "sell", "sell_amount"]);
    }
  });
});
