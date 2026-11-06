// gate: CONSOLE — the owner console's controls in a real headless Chromium against a local sandbox, through the
// LOCAL SANDBOX TEST SIGNER (not a wallet). Wrong owner, wrong network (genesis) and wrong deployment disable every
// control with its reason; a cancelled signature and a rejected transaction submit nothing and leave nothing pending;
// a reload during a pending action resumes polling and never resubmits (sign requests counted at the signer); a
// preview that differs from the loaded runner intent is refused. Chain state is asserted through RPC, not the UI.
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NetworkProfile } from "../src/console/client.js";
import type { LocalSandboxSigner } from "../src/console/signer.js";
import { grantDemo } from "../src/demo/story.js";
import { setupWorld, type World } from "../src/demo/world.js";
import { CaseRecorder, wasmHashes } from "../src/evidence/report.js";
import { ExternalIntent } from "../src/live/external.js";
import { sandboxKey } from "../src/near/keys.js";
import { LocalNetwork } from "../src/near/sandbox.js";
import { connectLocal, consoleLog, controls, launch, loadIntent, openConsole, readState, serveConsole, storedRecords, waitFinal, worldProfile } from "./console-helpers.js";

const evidence = new CaseRecorder("CONSOLE", "access-controls", [
  "wrong-network-disables",
  "wrong-deployment-disables",
  "wrong-owner-disables",
  "in-page-cancel-sends-nothing",
  "signer-cancel-submits-nothing",
  "rejected-transaction-submits-nothing",
  "intent-mismatch-refused",
  "reload-resumes-without-resubmit",
]);

let net: LocalNetwork | undefined;
let world: World;
let browser: Browser | undefined;
let profile: NetworkProfile;
let profiles: NetworkProfile[];
let owner: LocalSandboxSigner;
let started = false;
let decision: "approve" | "cancel" = "approve";
const helpers: LocalSandboxSigner[] = [];
const ACTIONS = ["revoke", "recover:usdc", "recover:wnear", "withdraw:usdc", "withdraw:wnear"];

const ownerKey = () => world.owner.key ?? sandboxKey(world.owner.id);
const ownerNonce = async () => world.client.accessKeyNonce(world.owner.id, ownerKey().getPublicKey().toString());
const grantStatus = async () => (await world.mandate.grant())?.status;

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  await grantDemo(world);
  profile = await worldProfile(world);
  profiles = [profile];
  owner = await serveConsole({ rpcUrl: world.client.rpcUrl, accountId: world.owner.id, key: ownerKey(), decide: () => decision }, () => profiles);
  helpers.push(owner);
  browser = await launch();
  started = true;
}, 300_000);

afterAll(async () => {
  const loaded = typeof world === "undefined" ? [] : Object.values(world.wasm);
  evidence.write("sandbox", wasmHashes(loaded), { signer: "local sandbox test signer (not a wallet)", browser: "chromium headless (playwright)", sign_requests: started ? owner.requests : [] });
  await browser?.close();
  for (const h of helpers) await h.stop();
  await net?.stop();
});

/** Opens the console on `signer`, reads state and connects; returns the page and its controls. */
async function session(signer: LocalSandboxSigner) {
  if (browser === undefined) throw new Error("no browser");
  const s = await openConsole(browser, signer.origin);
  await readState(s.page);
  await connectLocal(s.page);
  return { ...s, ...(await controls(s.page)) };
}

describe("controls stay disabled unless owner, network and deployment all match", () => {
  // gate: CONSOLE
  it("a wrong genesis disables every control and verifies nothing", () =>
    evidence.check("wrong-network-disables", async () => {
      profiles = [{ ...profile, genesis_hash: "11111111111111111111111111111111" }];
      try {
        const s = await session(owner);
        expect(Object.keys(s.enabled).sort()).toEqual([...ACTIONS].sort());
        expect(Object.values(s.enabled).every((v) => !v)).toBe(true);
        expect(s.reasons.join(" ")).toMatch(/^network check failed: genesis hash is "[^"]+", expected "11111111111111111111111111111111"/);
        const text = (await s.page.textContent("#live-body")) ?? "";
        expect(text).toContain("wrong chain");
        expect(text).not.toMatch(/chain verified|deployment matches/);
        expect(s.errors).toEqual([]);
        await s.ctx.close();
      } finally {
        profiles = [profile];
      }
      expect(owner.signRequests).toBe(0);
    }));

  // gate: CONSOLE
  it("a different mandate code hash disables every control", () =>
    evidence.check("wrong-deployment-disables", async () => {
      const d = profile.deployment;
      if (d === null) throw new Error("no deployment");
      profiles = [{ ...profile, deployment: { ...d, code_hash: "7dzGdFk3UaY9m3eQedMaiN2tjnxcp1awe1gdo5MH4ywV" } }];
      try {
        const s = await session(owner);
        expect(Object.values(s.enabled).some((v) => v)).toBe(false);
        expect(s.reasons).toEqual([`deployment check failed: mandate code hash ${d.code_hash} is not the expected 7dzGdFk3UaY9m3eQedMaiN2tjnxcp1awe1gdo5MH4ywV (${d.source})`]);
        await s.ctx.close();
      } finally {
        profiles = [profile];
      }
      expect(owner.signRequests).toBe(0);
    }));

  // gate: CONSOLE
  it("a signer that is not the contract's owner gets no control", () =>
    evidence.check("wrong-owner-disables", async () => {
      const attacker = await serveConsole({ rpcUrl: world.client.rpcUrl, accountId: world.attacker.id, key: world.attacker.key ?? sandboxKey(world.attacker.id) }, () => profiles);
      helpers.push(attacker);
      const s = await session(attacker);
      expect(Object.values(s.enabled).some((v) => v)).toBe(false);
      expect(s.reasons).toEqual([`signer ${world.attacker.id} is not the contract's owner ${world.owner.id}`]);
      expect(attacker.signRequests).toBe(0);
      await s.ctx.close();
    }));
});

describe("nothing is submitted without the owner's completed signature", () => {
  // gate: CONSOLE
  it("cancelling the review sends nothing to the signer", () =>
    evidence.check("in-page-cancel-sends-nothing", async () => {
      const nonce = await ownerNonce();
      const s = await session(owner);
      expect(s.reasons).toEqual([]);
      expect(s.enabled.revoke).toBe(true);
      await s.page.click('[data-action="revoke"]');
      await s.page.click("#review-cancel");
      expect(await consoleLog(s.page)).toBe("Cancelled before signing: nothing was sent to any signer.");
      expect(owner.signRequests).toBe(0);
      expect(await storedRecords(s.page)).toEqual([]);
      expect(await ownerNonce()).toBe(nonce);
      expect(await grantStatus()).toBe("active");
      await s.ctx.close();
    }));

  // gate: CONSOLE
  it("a signature cancelled in the signer submits nothing and leaves nothing pending", () =>
    evidence.check("signer-cancel-submits-nothing", async () => {
      const nonce = await ownerNonce();
      const before = owner.signRequests;
      decision = "cancel";
      try {
        const s = await session(owner);
        await s.page.click('[data-action="revoke"]');
        await s.page.click("#review-confirm");
        await s.page.locator("#console-log", { hasText: /^Signature cancelled/ }).waitFor();
        expect(owner.signRequests).toBe(before + 1);
        expect(owner.requests.at(-1)?.status).toBe("cancelled");
        expect(await storedRecords(s.page)).toEqual([]);
        expect((await controls(s.page)).enabled.revoke).toBe(true);
        await s.ctx.close();
      } finally {
        decision = "approve";
      }
      expect(await ownerNonce()).toBe(nonce);
      expect(await grantStatus()).toBe("active");
    }));

  // gate: CONSOLE
  it("a transaction the chain rejects submits nothing and leaves nothing pending", () =>
    evidence.check("rejected-transaction-submits-nothing", async () => {
      const nonce = await ownerNonce();
      // The owner account, but a key that is not one of its access keys: the chain refuses it before inclusion.
      const wrongKey = await serveConsole({ rpcUrl: world.client.rpcUrl, accountId: world.owner.id, key: sandboxKey("console-test/not-an-owner-key") }, () => profiles);
      helpers.push(wrongKey);
      const s = await session(wrongKey);
      await s.page.click('[data-action="revoke"]');
      await s.page.click("#review-confirm");
      await s.page.locator("#console-log", { hasText: /^Rejected before inclusion/ }).waitFor();
      expect(wrongKey.signRequests).toBe(1);
      expect(wrongKey.requests[0]?.status).toBe("rejected");
      expect(await storedRecords(s.page)).toEqual([]);
      expect(await ownerNonce()).toBe(nonce);
      expect(await grantStatus()).toBe("active");
      await s.ctx.close();
    }));

  // gate: CONSOLE
  it("a preview that differs from the loaded runner intent is refused before any signer is asked", () =>
    evidence.check("intent-mismatch-refused", async () => {
      const before = owner.signRequests;
      const s = await session(owner);
      const intent = ExternalIntent.parse({
        schema: "bounded-mandate/external-intent@1",
        manifest_sha256: "0".repeat(64),
        step: 2,
        kind: "revoke_external",
        attempt: 1,
        network: { name: "sandbox", chain_id: profile.chain_id, genesis_hash: profile.genesis_hash, rpc_url: profile.rpc_url },
        signer_id: world.owner.id,
        public_key: ownerKey().getPublicKey().toString(),
        receiver_id: world.mandate.id,
        // Differs from the console's own preview in the gas only.
        actions: [{ method: "revoke", args: {}, gas: "100000000000000", deposit: "0", gas_min: "100000000000000", gas_max: "120000000000000", deposit_min: "0", deposit_max: "0" }],
        expected: { summary: "test intent with altered gas", state: {} },
        created_at: new Date().toISOString(),
      });
      expect(await loadIntent(s.page, intent)).toMatch(/^Runner intent loaded: Revoke the grant/);
      await s.page.click('[data-action="revoke"]');
      await s.page.waitForSelector(".refused");
      expect(await s.page.textContent(".refused")).toContain('actions[0].gas: runner intent "100000000000000", console preview "150000000000000"');
      expect(await s.page.$("#review-confirm")).toBeNull();
      // Any other action is disabled while this intent is loaded.
      expect((await controls(s.page)).enabled["recover:usdc"]).toBe(false);
      expect(await s.page.textContent("#actions")).toContain("the loaded runner intent is for another action; clear it first");
      expect(owner.signRequests).toBe(before);
      expect(await storedRecords(s.page)).toEqual([]);
      await s.ctx.close();
    }));

  // gate: CONSOLE
  it("a reload while the action is pending resumes polling and never resubmits", () =>
    evidence.check("reload-resumes-without-resubmit", async () => {
      const nonce = await ownerNonce();
      if (nonce === null) throw new Error("owner key has no nonce");
      // The signer answers with the hash and broadcasts later, so the reload lands while the action is pending.
      const slow = await serveConsole({ rpcUrl: world.client.rpcUrl, accountId: world.owner.id, key: ownerKey(), broadcastDelayMs: 4_000 }, () => profiles);
      helpers.push(slow);
      const s = await session(slow);
      await s.page.click('[data-action="revoke"]');
      await s.page.click("#review-confirm");
      await s.page.locator("#console-log", { hasText: /^Submitted/ }).waitFor();
      const [pending] = await storedRecords(s.page);
      expect(pending?.phase).toBe("submitted");
      await s.page.reload();
      // Pending across the reload: nothing on chain yet, and the record survived.
      expect(await ownerNonce()).toBe(nonce);
      expect((await storedRecords(s.page)).map((r) => r.phase)).toEqual(["submitted"]);
      await s.page.waitForSelector('li[data-phase="submitted"]');
      expect(await s.page.textContent("#activity")).toContain("pending");
      await waitFinal(s.page, pending?.intent_sha256 ?? "");
      expect(slow.signRequests).toBe(1);
      expect(await ownerNonce()).toBe(nonce + 1n);
      const grant = await world.mandate.grant();
      expect(grant?.status).toBe("revoked");
      expect(grant?.key_op_in_flight).toBe(false);
      expect(await world.verifier.hasPublicKey(world.mandate.id, grant?.public_key ?? "")).toBe(false);
      expect(await s.page.textContent(`li[data-record="${pending?.intent_sha256 ?? ""}"]`)).toContain("removal confirmed");
      // The revoke control is not offered again for the same exact intent, and nothing was signed twice.
      expect(s.errors).toEqual([]);
      await s.ctx.close();
      expect(slow.requests.map((r) => r.status)).toEqual(["submitted"]);
    }));
});
