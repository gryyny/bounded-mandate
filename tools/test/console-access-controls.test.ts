// gate: CONSOLE — the owner console's controls in a real headless Chromium against a local sandbox, through the
// LOCAL SANDBOX TEST SIGNER (not a wallet). Wrong owner, wrong network (genesis) and wrong deployment disable every
// control with its reason; a cancelled signature and a rejected transaction submit nothing and leave nothing pending;
// a reload during a pending action (submitted, or still awaiting the signature) never resubmits (sign requests counted
// at the signer); a preview that differs from the loaded runner intent is refused. The test signer refuses any call
// whose receiver or beneficiary is not bound to the served deployment and the owner, and refuses to be framed. Chain
// state is asserted through RPC, not the UI.
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { NetworkProfile } from "../src/console/client.js";
import { CONSOLE_INTENT_SCHEMA, intentSha256 } from "../src/console/intent.js";
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
  "reload-awaiting-signature-without-resubmit",
  "signer-refuses-unbound-receivers",
  "signer-refuses-other-beneficiaries",
  "signer-refuses-framing",
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
const until = async (cond: () => boolean, what: string, timeoutMs = 30_000): Promise<void> => {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

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

  // gate: CONSOLE
  it("a reload while the signature is still awaited asks the signer for its record and never resubmits", () =>
    evidence.check("reload-awaiting-signature-without-resubmit", async () => {
      const nonce = await ownerNonce();
      if (nonce === null) throw new Error("owner key has no nonce");
      // The signer holds its confirmation open until released, so the reload lands before any hash exists.
      let release: (d: "approve") => void = () => undefined;
      let asked: () => void = () => undefined;
      const askedOnce = new Promise<void>((r) => {
        asked = r;
      });
      const held = await serveConsole(
        {
          rpcUrl: world.client.rpcUrl,
          accountId: world.owner.id,
          key: ownerKey(),
          decide: () => {
            asked();
            return new Promise<"approve">((r) => {
              release = r;
            });
          },
        },
        () => profiles,
      );
      helpers.push(held);
      const s = await session(held);
      expect(s.enabled["recover:usdc"]).toBe(true);
      await s.page.click('[data-action="recover:usdc"]');
      await s.page.click("#review-confirm");
      await askedOnce;
      const [pending] = await storedRecords(s.page);
      expect(pending).toMatchObject({ phase: "awaiting-signature", tx_hash: null });
      const sha = pending?.intent_sha256 ?? "";
      await s.page.reload();
      // The reloaded page asks the signer for its record (read-only), finds none yet and shows the record unresolved.
      const item = s.page.locator(`li[data-record="${sha}"][data-phase="awaiting-signature"]`);
      await item.filter({ hasText: "unresolved, no transaction hash" }).waitFor();
      expect(await item.textContent()).toContain("Nothing is resubmitted.");
      await readState(s.page);
      await connectLocal(s.page);
      expect((await controls(s.page)).enabled["recover:usdc"]).toBe(false);
      expect(await s.page.textContent("#actions")).toContain("this action is pending; nothing is resubmitted");
      expect(held.signRequests).toBe(1);
      expect(await ownerNonce()).toBe(nonce);
      // The signer's prompt is answered after the reload; the owner asks it for its record once more.
      release("approve");
      await until(() => held.requests[0]?.status === "submitted", "the held signature to be submitted");
      await item.getByRole("button", { name: "Ask the local signer for its record" }).click();
      await waitFinal(s.page, sha);
      const final = (await s.page.textContent(`li[data-record="${sha}"]`)) ?? "";
      expect(final).toContain("final · success");
      expect(final).toContain("recovery finished");
      expect(final).toContain(held.requests[0]?.tx_hash ?? "no hash");
      expect(held.requests.map((r) => [r.intent_sha256, r.status])).toEqual([[sha, "submitted"]]);
      expect(await ownerNonce()).toBe(nonce + 1n);
      const usdc = (await world.mandate.recoveryViews()).find((v) => v.asset === "usdc");
      expect(usdc?.in_flight).toBe(false);
      expect(BigInt(usdc?.recovered ?? "0") > 0n).toBe(true);
      // The browser logs the signer's 404 for "no record yet" as a resource error; nothing else may fail.
      expect(s.errors.filter((e) => !/status of 404/.test(e))).toEqual([]);
      await s.ctx.close();
    }));
});

describe("the local test signer signs only the console's calls on the served deployment, for the owner", () => {
  let bound: LocalSandboxSigner | undefined;
  let decided = 0;
  const signerOf = (): LocalSandboxSigner => {
    if (bound === undefined) throw new Error("no bound signer");
    return bound;
  };
  /** One raw sign request (as the page would send it, from the signer's own origin). */
  const ask = async (receiver: string, method: string, args: Record<string, unknown>, deposit = "0"): Promise<{ status?: string; error?: string }> => {
    const b = signerOf();
    const intent = {
      schema: CONSOLE_INTENT_SCHEMA,
      action: method === "ft_withdraw" ? "withdraw" : method === "storage_deposit" ? "register" : method === "recover" ? "recover" : "revoke",
      asset: method === "revoke" ? null : "usdc",
      network: { chain_id: profile.chain_id, genesis_hash: profile.genesis_hash },
      signer_id: world.owner.id,
      public_key: ownerKey().getPublicKey().toString(),
      receiver_id: receiver,
      actions: [{ method, args, gas: "30000000000000", deposit }],
    };
    const res = await fetch(`${b.origin}/signer/sign`, { method: "POST", headers: { "Content-Type": "application/json", Origin: b.origin }, body: JSON.stringify({ intent, intent_sha256: intentSha256(intent) }) });
    return (await res.json()) as { status?: string; error?: string };
  };

  beforeAll(async () => {
    bound = await serveConsole(
      {
        rpcUrl: world.client.rpcUrl,
        accountId: world.owner.id,
        key: ownerKey(),
        decide: () => {
          decided++;
          return "cancel";
        },
      },
      () => profiles,
    );
    helpers.push(bound);
  });

  // gate: CONSOLE
  it("refuses revoke and recover off the mandate, ft_withdraw off the verifier and storage_deposit off the two tokens", () =>
    evidence.check("signer-refuses-unbound-receivers", async () => {
      const nonce = await ownerNonce();
      const owner = world.owner.id;
      const cases: [string, string, Record<string, unknown>, string, RegExp][] = [
        [world.verifier.id, "revoke", {}, "0", new RegExp(`^revoke is signed only for the mandate ${world.mandate.id}, not ${world.verifier.id}$`)],
        [world.attacker.id, "recover", { asset: "usdc" }, "0", new RegExp(`^recover is signed only for the mandate ${world.mandate.id}, not ${world.attacker.id}$`)],
        [world.mandate.id, "ft_withdraw", { token: world.tokens.usdc, receiver_id: owner, amount: "1" }, "1", new RegExp(`^ft_withdraw is signed only for the verifier ${world.verifier.id}, not ${world.mandate.id}$`)],
        [world.verifier.id, "ft_withdraw", { token: world.mandate.id, receiver_id: owner, amount: "1" }, "1", /^ft_withdraw is signed only for the mandate's tokens /],
        [world.mandate.id, "storage_deposit", { account_id: owner, registration_only: true }, "1250000000000000000000", new RegExp(`^storage_deposit is signed only for the mandate's token contracts ${world.tokens.usdc}, ${world.tokens.wnear}, not ${world.mandate.id}$`)],
        [world.tokens.usdc, "ft_transfer", { receiver_id: world.attacker.id, amount: "1" }, "1", /^the test signer signs only revoke, recover, ft_withdraw and storage_deposit$/],
      ];
      for (const [receiver, method, args, deposit, want] of cases) {
        const r = await ask(receiver, method, args, deposit);
        expect({ method, receiver, status: r.status }).toEqual({ method, receiver, status: "refused" });
        expect(r.error).toMatch(want);
      }
      expect(signerOf().requests.map((r) => r.status)).toEqual(cases.map(() => "refused"));
      expect(decided).toBe(0);
      expect(await ownerNonce()).toBe(nonce);
    }));

  // gate: CONSOLE
  it("refuses ft_withdraw and storage_deposit that pay or register any account but the signer's own", () =>
    evidence.check("signer-refuses-other-beneficiaries", async () => {
      const nonce = await ownerNonce();
      const before = signerOf().signRequests;
      const owner = world.owner.id;
      const evil = world.attacker.id;
      const cases: [string, string, Record<string, unknown>, string, RegExp][] = [
        [world.verifier.id, "ft_withdraw", { token: world.tokens.usdc, receiver_id: evil, amount: "1" }, "1", new RegExp(`^ft_withdraw pays only this signer's account ${owner}, not "${evil}"$`)],
        [world.verifier.id, "ft_withdraw", { token: world.tokens.usdc, receiver_id: owner, account_id: evil, amount: "1" }, "1", new RegExp(`^ft_withdraw names account "${evil}", not this signer's account ${owner}$`)],
        [world.verifier.id, "ft_withdraw", { token: world.tokens.usdc, receiver_id: owner, amount: "unknown" }, "1", /^ft_withdraw amount "unknown" is not an integer$/],
        [world.tokens.usdc, "storage_deposit", { account_id: evil, registration_only: true }, "1250000000000000000000", new RegExp(`^storage_deposit registers only this signer's account ${owner}, not "${evil}"$`)],
      ];
      for (const [receiver, method, args, deposit, want] of cases) {
        const r = await ask(receiver, method, args, deposit);
        expect(r.status).toBe("refused");
        expect(r.error).toMatch(want);
      }
      expect(signerOf().requests.slice(before).map((r) => r.status)).toEqual(cases.map(() => "refused"));
      // Bound calls reach the confirmation step (declined here): the refusals above are the binding, not a blanket refusal.
      expect(await ask(world.tokens.wnear, "storage_deposit", { account_id: owner, registration_only: true }, "1250000000000000000000")).toMatchObject({ status: "cancelled" });
      expect(await ask(world.verifier.id, "ft_withdraw", { token: world.tokens.wnear, receiver_id: owner, amount: "1" }, "1")).toMatchObject({ status: "cancelled" });
      expect(decided).toBe(2);
      expect(await ownerNonce()).toBe(nonce);
    }));

  // gate: CONSOLE
  it("forbids framing of the page and of every signer answer", () =>
    evidence.check("signer-refuses-framing", async () => {
      const b = signerOf();
      const answers = [
        await fetch(`${b.origin}/`),
        await fetch(`${b.origin}/signer/info`),
        await fetch(`${b.origin}/signer/record?intent_sha256=${"0".repeat(64)}`),
        await fetch(`${b.origin}/signer/sign`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
        await fetch(`${b.origin}/nowhere`),
      ];
      for (const r of answers) {
        expect({ url: r.url, xfo: r.headers.get("x-frame-options"), csp: r.headers.get("content-security-policy") }).toEqual({ url: r.url, xfo: "DENY", csp: "frame-ancestors 'none'" });
      }
      // In the browser: a page on another origin that frames the console gets no console document.
      if (browser === undefined) throw new Error("no browser");
      const ctx = await browser.newContext();
      const framer = await ctx.newPage();
      await framer.setContent(`<iframe id="f" src="${b.origin}/"></iframe>`, { waitUntil: "load" });
      const frame = framer.frames().find((f) => f !== framer.mainFrame());
      expect(frame).toBeDefined();
      expect(await frame?.$("#live-read")).toBeNull();
      await ctx.close();
    }));
});
