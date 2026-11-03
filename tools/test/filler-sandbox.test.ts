// Filler against the pinned verifier: one fill, restart safety, and no replacement after an unresolved submission.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { grantDemo } from "../src/demo/story.js";
import { balances, fillerKey, postPrices, setupWorld, type World } from "../src/demo/world.js";
import { Filler } from "../src/filler/filler.js";
import { settledOrder } from "../src/near/contracts.js";
import { LocalNetwork, requireSuccess } from "../src/near/sandbox.js";

let net: LocalNetwork;
let world: World;
let dir: string;

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  await grantDemo(world);
  dir = mkdtempSync(join(tmpdir(), "bm-filler-"));
}, 180_000);

afterAll(async () => {
  await net.stop();
  rmSync(dir, { recursive: true, force: true });
});

const filler = (statePath: string) =>
  new Filler({ client: world.client, mandate: world.mandate, verifier: world.verifier, account: world.filler.account, key: fillerKey(world), statePath });

// Scripted test proposals (not model output).
const propose = async (proposal: { sell: "usdc" | "wnear"; sell_amount: string; max_concession_bps: number }): Promise<string> => {
  await postPrices(world);
  const out = requireSuccess(await world.mandate.propose(world.agent.account, proposal));
  const id = String(out.return_value);
  expect((await settledOrder(world.mandate, id))?.state.state).toBe("signed");
  return id;
};

describe("filler", () => {
  it("fills a signed order exactly and never resubmits after a restart", async () => {
    const id = await propose({ sell: "wnear", sell_amount: (5n * 10n ** 24n).toString(), max_concession_bps: 25 });
    const order = await world.mandate.order(id);
    const statePath = join(dir, "state-a.json");
    const before = await balances(world, world.mandate.id);
    const first = await filler(statePath).fill(id);
    expect(first.record.state).toBe("filled");
    const after = await balances(world, world.mandate.id);
    expect(before.wnear - after.wnear).toBe(BigInt(order?.sell_amount ?? "0"));
    expect(after.usdc - before.usdc).toBe(BigInt(order?.buy_amount ?? "0"));

    const fillerBefore = await balances(world, world.filler.id);
    const again = await filler(statePath).fill(id); // a fresh process reading the same state
    expect(again.outcome).toBeUndefined();
    expect(again.record.tx_hash).toBe(first.record.tx_hash);
    expect(await balances(world, world.filler.id)).toEqual(fillerBefore);
  });

  it("reports an unresolved submission from chain state and never constructs a replacement", async () => {
    const id = await propose({ sell: "usdc", sell_amount: "7000000", max_concession_bps: 10 });
    const statePath = join(dir, "state-b.json");
    const f = filler(statePath);
    const order = await world.mandate.order(id);
    if (order === null) throw new Error("order missing");
    const signed = await f.signedOrder(order);
    const prepared = await f.prepare(signed);
    if ("shortfall" in prepared) throw new Error(prepared.shortfall);
    // Simulate a crash after the write-ahead record and before (or during) the send.
    writeFileSync(
      statePath,
      JSON.stringify({
        version: 1,
        mandate: world.mandate.id,
        orders: { [id]: { order_id: id, state: "submitting", updated_at: "t", mandate_nonce: signed.payload.nonce, filler_nonce: prepared.own.payload.nonce } },
      }),
    );
    const fillerBefore = await balances(world, world.filler.id);
    const res = await filler(statePath).fill(id);
    expect(res.outcome).toBeUndefined();
    expect(res.record.state).toBe("ambiguous");
    expect(res.record.detail).toMatch(/mandate nonce used: false.*no replacement order constructed/);
    expect(await world.verifier.isNonceUsed(world.mandate.id, signed.payload.nonce)).toBe(false);
    expect(await balances(world, world.filler.id)).toEqual(fillerBefore);
    const later = await filler(statePath).fill(id);
    expect(later.outcome).toBeUndefined();
    expect(later.record.state).toBe("ambiguous");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toMatchObject({ orders: { [id]: { state: "ambiguous" } } });
  });
});
