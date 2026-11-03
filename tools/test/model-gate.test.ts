// gate: MODEL — a recorded genuine model interaction, hash-checked, reaches propose_order on a sandbox mandate.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decide, submitProposal } from "../src/agent/adapter.js";
import { demoSnapshot } from "../src/agent/record.js";
import { RecordedProvider } from "../src/agent/recording.js";
import { BENIGN_NOTES } from "../src/demo/market.js";
import { chainSnapshot, grantDemo, tryLoadRecording } from "../src/demo/story.js";
import { setupWorld, type World } from "../src/demo/world.js";
import { settledOrder } from "../src/near/contracts.js";
import { LocalNetwork } from "../src/near/sandbox.js";

let net: LocalNetwork;
let world: World;

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  await grantDemo(world);
}, 180_000);

afterAll(async () => {
  await net.stop();
});

const requireRecording = () => {
  const loaded = tryLoadRecording("normal");
  if (!loaded.ok) {
    throw new Error(
      `MODEL gate cannot pass: ${loaded.reason}. Record a genuine interaction with \`cd tools && npx tsx src/agent/record.ts --variant normal --call-model\` (requires a logged-in claude CLI), then list it in fixtures/manifest.json.`,
    );
  }
  return loaded.recording;
};

describe("recorded genuine model proposal", () => {
  // gate: MODEL
  it("is genuine, untampered and bound to the demo market", () => {
    const rec = requireRecording();
    expect(rec.interaction.origin).toBe("genuine-model");
    expect(rec.interaction.prompt_variant).toBe("normal");
    expect(rec.interaction.snapshot).toEqual(demoSnapshot("normal"));
  });

  // gate: MODEL
  it("goes through the adapter into propose_order and the order exists on-chain", async () => {
    const rec = requireRecording();
    const snapshot = await chainSnapshot(world, BENIGN_NOTES);
    // The recorded provider refuses unless the prompt rebuilt from chain state hashes to the recorded prompt.
    const decision = await decide(new RecordedProvider(rec), snapshot);
    expect(decision.prompt.sha256).toBe(rec.interaction.prompt.sha256);
    if (decision.verdict.kind !== "proposal") throw new Error(`recorded decision is not a proposal: ${JSON.stringify(decision.verdict)}`);
    const proposal = decision.verdict.proposal;
    const outcome = await submitProposal(world.client, world.agent.account, world.mandate.id, proposal);
    expect(outcome.success).toBe(true);
    const order = await settledOrder(world.mandate, String(outcome.return_value));
    expect(order).not.toBeNull();
    expect({ sell: order?.sell, sell_amount: order?.sell_amount, concession_bps: order?.concession_bps }).toEqual({
      sell: proposal.sell,
      sell_amount: proposal.sell_amount,
      concession_bps: proposal.max_concession_bps,
    });
    expect(order?.state.state).toBe("signed");
  });
});
