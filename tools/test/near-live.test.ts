// `make live` refusal paths, and one run of the live orchestrator against a local sandbox (never a public network).
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { baseEncode, type KeyPair } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_POLICY } from "../src/demo/market.js";
import { fillerKey, postPrices, setupWorld, type World } from "../src/demo/world.js";
import { runLive, type LiveManifest } from "../src/live/main.js";
import { LocalNetwork } from "../src/near/sandbox.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "bm-live-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const writeJson = (name: string, value: unknown, mode = 0o600): string => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(value));
  chmodSync(path, mode);
  return path;
};

const baseManifest = (over: Partial<LiveManifest> = {}): LiveManifest => ({
  schema_version: 1,
  network: "sandbox",
  rpc_url: "http://127.0.0.1:9",
  approval: { approved_by: "test", reference: "unit test" },
  accounts: { mandate: "mandate.sandbox", owner: "owner.sandbox", agent: "agent.sandbox", filler: "filler.sandbox", verifier: "intents.sandbox" },
  mandate_code_hash: "11111111111111111111111111111111",
  credentials: { owner: "/nonexistent", agent: "/nonexistent", filler: "/nonexistent" },
  filler_signing_credential: "/nonexistent",
  budget: { max_transactions: 10, max_sell_units: { usdc: "0", wnear: "0" }, max_filler_pay_units: { usdc: "0", wnear: "0" } },
  steps: [{ kind: "check" }],
  ...over,
});

describe("live refusals", () => {
  it("refuses without the flag", async () => {
    const r = await runLive({ MANDATE_LIVE_MANIFEST: writeJson("m0.json", baseManifest()) });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/MANDATE_LIVE=1/);
  });

  it("refuses without a manifest", async () => {
    expect((await runLive({ MANDATE_LIVE: "1" })).message).toMatch(/MANDATE_LIVE_MANIFEST is not set/);
  });

  it("refuses an invalid manifest, including unknown fields and funding steps", async () => {
    const r1 = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson("m1.json", { ...baseManifest(), fund: true }) });
    expect(r1.exitCode).toBe(2);
    const r2 = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: writeJson("m2.json", { ...baseManifest(), steps: [{ kind: "deposit", amount: "1" }] }) });
    expect(r2.exitCode).toBe(2);
    expect(r2.message).toMatch(/invalid manifest/);
  });

  it("refuses mainnet unless the exact manifest hash is confirmed", async () => {
    const path = writeJson("m3.json", baseManifest({ network: "mainnet" }));
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path, MANDATE_LIVE_CONFIRM: "0".repeat(64) });
    expect(r.exitCode).toBe(2);
    expect(r.message).toMatch(/MANDATE_LIVE_CONFIRM/);
  });
});

describe("live orchestrator on a local sandbox", () => {
  let net: LocalNetwork;
  let world: World;

  beforeAll(async () => {
    net = await LocalNetwork.start();
    world = await setupWorld(net);
  }, 180_000);
  afterAll(async () => {
    await net.stop();
  });

  const cred = (name: string, accountId: string, key: KeyPair | null): string => {
    if (key === null) throw new Error(`${accountId} has no key`);
    return writeJson(name, { account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() });
  };

  const manifestFor = (steps: LiveManifest["steps"], budget: Partial<LiveManifest["budget"]> = {}, name = "live.json"): string => {
    const codeHash = baseEncode(createHash("sha256").update(world.wasm.mandate.bytes).digest());
    return writeJson(
      name,
      baseManifest({
        rpc_url: world.client.rpcUrl,
        accounts: { mandate: world.mandate.id, owner: world.owner.id, agent: world.agent.id, filler: world.filler.id, verifier: world.verifier.id },
        mandate_code_hash: codeHash,
        credentials: {
          owner: cred("owner.json", world.owner.id, world.owner.key),
          agent: cred("agent.json", world.agent.id, world.agent.key),
          filler: cred("filler.json", world.filler.id, world.filler.key),
        },
        filler_signing_credential: cred("filler-signing.json", world.filler.id, fillerKey(world)),
        filler_state_file: join(dir, `${name}.filler-state.json`),
        budget: { max_transactions: 10, max_sell_units: { usdc: "20000000", wnear: "0" }, max_filler_pay_units: { usdc: "0", wnear: (10n * 10n ** 24n).toString() }, ...budget },
        steps,
      }),
    );
  };

  it("stops before a proposal that exceeds the budget and submits nothing", async () => {
    await postPrices(world);
    const before = await world.mandate.listOrders();
    const path = manifestFor([{ kind: "grant", policy: DEMO_POLICY }, { kind: "propose", source: { from: "manifest", proposal: { sell: "usdc", sell_amount: "20000001", max_concession_bps: 10 } } }], {}, "over.json");
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path });
    expect(r.exitCode).toBe(1);
    expect(r.message).toMatch(/budget: selling 20000001 usdc/);
    expect(await world.mandate.listOrders()).toEqual(before);
  });

  it("runs propose, fill, settle, revoke and recovery within budget", async () => {
    await postPrices(world);
    const path = manifestFor([
      { kind: "check" },
      { kind: "propose", source: { from: "manifest", proposal: { sell: "usdc", sell_amount: "15000000", max_concession_bps: 10 } } },
      { kind: "fill" },
      { kind: "settle" },
      { kind: "revoke" },
      { kind: "recover", asset: "usdc" },
      { kind: "recover", asset: "wnear" },
    ]);
    const r = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path });
    expect(r.message).toBe("completed");
    expect(r.exitCode).toBe(0);
    expect(r.evidence?.mode).toBe("sandbox");
    expect(r.evidence?.receipts.every((x) => x.outcome === "success")).toBe(true);
    expect(await world.verifier.balance(world.mandate.id, world.tokens.usdc)).toBe(0n);
    expect((await world.mandate.grant())?.status).toBe("revoked");
  });
});
