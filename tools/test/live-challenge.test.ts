// gate: LIVE — the optional open challenge (SPEC.md "Open challenge grant (optional)") against a local sandbox only
// (never a public network), on the exact deployment binary from fixtures/deploy. After a completed run of the primary
// live-agent template, a new owner deposit and a fresh grant through the challenge template; then an ADVERSARY SCRIPT
// that holds only the agent's key (handed over as a credential file in a temp dir, like the published key) and its own
// account tries every withdrawal, transfer, key and policy route, trades at the limits as its own counterparty, relays
// the completed run's withheld order, and exhausts the proposal budget and the agent's allowance. The owner then closes
// the challenge through the close template. Owner console signatures come from the SANDBOX LOCAL SIGNING ADAPTER (a
// test double); model answers are SYNTHETIC; token contracts, oracle and MPC signer are labelled test doubles; price
// moves are posted by the test as the oracle keeper. The agent key is generated per run and never written to the
// repository; evidence records only its public key.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeyPair, actions, type Account, type Action } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chainAttacks, classify, type Boundary, type Observed } from "../src/attacks/suite.js";
import { DECIMALS, PRICES } from "../src/demo/market.js";
import { balances, mintAndDeposit, postPrices, setupWorld, type World } from "../src/demo/world.js";
import { CaseRecorder, wasmHashes } from "../src/evidence/report.js";
import { Filler } from "../src/filler/filler.js";
import { rfc3339FromNs, signNep413, versionedNonce } from "../src/filler/nep413.js";
import { CHALLENGE_DOES_NOT_SHOW, ChallengeRecord, runChallenge, type ChallengeResult } from "../src/live/challenge.js";
import { handoffOf, intentSha256, type ExternalIntent } from "../src/live/external.js";
import { Ledger } from "../src/live/ledger.js";
import { runLive, type LiveDeps } from "../src/live/main.js";
import { LiveManifest } from "../src/live/manifest.js";
import { MAX_GAS, NEAR, NearClient, ONE_YOCTO, TGAS, type Outcome } from "../src/near/client.js";
import { MandateClient, TokenClient, settledOrder } from "../src/near/contracts.js";
import { loadCredential } from "../src/near/credentials.js";
import { sandboxKey } from "../src/near/keys.js";
import { LocalNetwork, REPO_ROOT, requireSuccess } from "../src/near/sandbox.js";
import type { Asset, OrderView, PriceObservation, SignedNep413 } from "../src/types.js";
import { SyntheticProvider, proposeJson } from "./agent-live-helpers.js";
import { hash58, sandboxManifest, writeCredential, writeJson } from "./live-helpers.js";

const FIXTURE = "fixtures/deploy/bounded_mandate-163ccfa-reproducible.wasm";
const USDC = 10n ** 6n;
const WNEAR = 10n ** 24n;
const TEMPLATES = join(import.meta.dirname, "../src/live");

let net: LocalNetwork;
let world: World;
let dir: string;
let keysDir: string;
let base: LiveManifest;
let candidate: Uint8Array;
let finalClient: NearClient;

const challengeCase = new CaseRecorder("LIVE", "open-challenge", [
  "primary-run-completed",
  "fresh-grant-opened",
  "forbidden-attempts-fail",
  "permitted-trades-bounded",
  "withheld-order-still-rejected",
  "proposal-budget-and-breaker",
  "allowance-exhausted",
  "owner-close-after-exhaustion",
  "evidence-separate-and-keyless",
]);
/** Each adversary attempt with its expected and observed boundary (written into the case report). */
const attempts: { id: string; expected: Boundary; observed: Observed; contained: boolean; error: string }[] = [];
const trades: Record<string, unknown>[] = [];
const notes: Record<string, unknown> = {};

const deps = (extra: Partial<LiveDeps> = {}): LiveDeps => ({ outRoot: join(dir, "live"), timeoutMs: 60_000, pollMs: 300, ...extra });
const challengeDeps = (extra: Partial<LiveDeps> = {}): LiveDeps => deps({ outRoot: join(dir, "challenge", "live"), ...extra });
let counter = 0;
const pathOf = (m: LiveManifest, name: string): string => writeJson(dir, `${name}-${counter++}.json`, m);
const shaOf = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
const ledgerOf = (root: string, path: string): Ledger => Ledger.load(Ledger.dirFor(root, shaOf(path)), shaOf(path));
async function settleFinal(): Promise<void> {
  const target = (await world.client.provider.viewBlock({ finality: "optimistic" })).header.height;
  while ((await world.client.provider.viewBlock({ finality: "final" })).header.height < target) await new Promise((r) => setTimeout(r, 200));
}
const template = (name: string) => JSON.parse(readFileSync(join(TEMPLATES, name), "utf8")) as Record<string, unknown> & { budget: LiveManifest["budget"]; gas_tgas: LiveManifest["gas_tgas"]; storage: LiveManifest["storage"]; steps: unknown[] };

/** SANDBOX LOCAL SIGNING ADAPTER (test double): signs each intent's exact actions with `account`. */
const adapter = (account: Account) => async (intent: ExternalIntent) => {
  const acts: Action[] = intent.actions.map((a) => actions.functionCall(a.method, a.args, BigInt(a.gas), BigInt(a.deposit)));
  const outcome = await finalClient.send(`SANDBOX signing adapter: ${intent.kind}`, account, intent.receiver_id, acts, intent.actions[0]?.method ?? "-");
  if (outcome.tx_hash === undefined) throw new Error(`signing adapter: no transaction hash (${outcome.error ?? ""})`);
  return handoffOf(await intentSha256(intent), outcome.tx_hash, intent.signer_id);
};

/** USD value of `amount` base units at a price observation, on a common integer scale (independent of the contract). */
const usd = (amount: bigint, decimals: number, p: Pick<PriceObservation, "price" | "expo">): bigint => {
  const shift = 40 + p.expo - decimals;
  if (shift < 0) throw new Error("scale too small");
  return amount * BigInt(p.price) * 10n ** BigInt(shift);
};

function filesUnder(root: string): string[] {
  return readdirSync(root).flatMap((n) => {
    const p = join(root, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  await settleFinal();
  dir = mkdtempSync(join(tmpdir(), "bm-live-challenge-"));
  keysDir = mkdtempSync(join(tmpdir(), "bm-live-challenge-keys-"));
  base = await sandboxManifest(world, dir);
  candidate = readFileSync(join(REPO_ROOT, FIXTURE));
  finalClient = world.client.final();
}, 180_000);

afterAll(async () => {
  const wasm = { ...wasmHashes(typeof world === "undefined" ? [] : Object.values(world.wasm)), "bounded_mandate-163ccfa-reproducible": createHash("sha256").update(readFileSync(join(REPO_ROOT, FIXTURE))).digest("hex") };
  challengeCase.write("sandbox", wasm, {
    deployment_binary: FIXTURE,
    signing: "SANDBOX LOCAL SIGNING ADAPTER (test double)",
    tokens: "mock-ft test double",
    model: "SYNTHETIC provider answers",
    adversary: "scripted adversary holding only the agent key and its own account (sandbox)",
    attempts,
    trades,
    ...notes,
  });
  await net.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(keysDir, { recursive: true, force: true });
});

describe("open challenge on the exact deployment binary", () => {
  // gate: LIVE
  it("after a completed run: fresh grant, adversary with the agent key contained, budget and allowance exhausted, owner closes", async () => {
    const root = net.root.id;
    const gasPrice = await world.client.gasPrice();
    // Room for the run's proposals at the sandbox's gas price; the adversary exhausts the rest below.
    const allowance = gasPrice * MAX_GAS * 30n;
    notes.sandbox_gas_price = gasPrice.toString();
    notes.agent_allowance_yocto = allowance.toString();

    // Setup outside the runner: owner, the agent account whose only key is a freshly generated function-call key, the
    // mandate deployed from the fixture binary, owner registration on both tokens and the first deposit.
    const owner = await net.createAccount("ownerc");
    if (owner.key === null) throw new Error("missing owner key");
    const mandateId = `cm.${root}`;
    const agentId = `cagent.${root}`;
    const agentKey = KeyPair.fromRandom("ed25519");
    const agentSecret = agentKey.toString();
    requireSuccess(
      await world.client.send("create challenge agent (TEST key)", net.root.account, agentId, [actions.createAccount(), actions.transfer(5n * NEAR), actions.addFunctionCallAccessKey(agentKey.getPublicKey(), mandateId, ["propose_order"], allowance)], "create_account"),
    );
    const config = { ...base.mandate_config, owner_id: owner.id, agent_id: agentId };
    await net.createAccount("cm", { balanceNear: 30n, wasm: candidate, init: { method: "new", args: { config } }, key: "none" });
    const ext = sandboxKey(`${owner.id}/console`);
    requireSuccess(await finalClient.send("add console owner key (TEST)", owner.account, owner.id, [actions.addFullAccessKey(ext.getPublicKey())], "add_key"));
    for (const asset of ["usdc", "wnear"] as const) {
      requireSuccess(await finalClient.call(`setup: register ${owner.id} on ${asset}`, world.owner.account, world.tokens[asset], "storage_deposit", { account_id: owner.id, registration_only: true }, { gas: 30n * TGAS, deposit: NEAR / 100n }));
    }
    const agentCredential = writeCredential(keysDir, "agent.json", agentId, agentKey);
    const ownerCredential = writeCredential(keysDir, "owner.json", owner.id, owner.key);
    const consoleAccount = finalClient.account(owner.id, ext);
    const identity: LiveManifest = {
      ...base,
      accounts: { ...base.accounts, mandate: mandateId, owner: owner.id, agent: agentId },
      code_hashes: { ...base.code_hashes, mandate: hash58(candidate) },
      mandate_config: config,
      keys: {
        ...base.keys,
        owner: { public_key: owner.key.getPublicKey().toString() },
        owner_external: { public_key: ext.getPublicKey().toString() },
        agent: { public_key: agentKey.getPublicKey().toString(), max_allowance_yocto: allowance.toString() },
      },
      credentials: { ...base.credentials, owner: ownerCredential, agent: agentCredential },
    };
    const mandate = new MandateClient(world.client, mandateId);
    const fund = async (usdc: bigint, wnear: bigint) => {
      await mintAndDeposit(world, world.owner, "usdc", usdc, mandateId);
      await mintAndDeposit(world, world.owner, "wnear", wnear, mandateId);
      await postPrices(world);
      await settleFinal();
    };

    // 1. The completed primary run: the primary template's whole sequence. Sandbox deviation: the grant's order lifetime
    // and oracle age are 1800 s, so the withheld order is still unexpired while the challenge grant is live and its
    // rejection there is attributable to key removal, not to expiry.
    const primary = template("manifest.live-agent.example.json");
    const primarySteps = LiveManifest.shape.steps.parse(primary.steps).map((s) => {
      if (s.kind === "grant") return { ...s, policy: { ...s.policy, order_ttl_sec: 1800, oracle_max_age_sec: 1800 } };
      if (s.kind === "propose" && s.source.from === "model") return { ...s, source: { ...s.source, model: "synthetic-never-called" } };
      return s;
    });
    await fund(5n * USDC, 1n * WNEAR);
    const m1: LiveManifest = { ...identity, gas_tgas: primary.gas_tgas, budget: { ...primary.budget, filler_spend_max: { usdc: "0", wnear: WNEAR.toString() } }, steps: primarySteps };
    const p1 = pathOf(m1, "primary");
    const r1 = await runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: p1 }, deps({ modelProvider: new SyntheticProvider(proposeJson("usdc", 500_000n)), handoff: adapter(consoleAccount) }));
    const primaryEvidence = join(dir, "evidence", "live-sandbox.json");
    let withheld: { order_id: string; signing_key: string; deadline_ns: string; mandate_nonce: string; bundle: SignedNep413[] } | undefined;
    let primaryEpoch = 0;
    let primaryEvidenceSha = "";
    await challengeCase.check("primary-run-completed", async () => {
      expect([r1.exitCode, r1.message]).toEqual([0, "completed"]);
      const relay = r1.evidence?.assertions.find((a) => a.id.endsWith("relay_withheld"))?.observed as { classification: string };
      expect(relay.classification).toBe("rejected_revoked_key");
      const w = ledgerOf(join(dir, "live"), p1).ofKind("step-done").find((e) => e.data.kind === "withhold")?.data.withheld as typeof withheld;
      expect(w?.bundle.length).toBe(2);
      withheld = w;
      const g = await mandate.grant();
      expect(g?.status).toBe("revoked");
      primaryEpoch = g?.epoch ?? 0;
      expect(await balances(world, mandateId)).toEqual({ usdc: 0n, wnear: 0n });
      primaryEvidenceSha = shaOf(primaryEvidence);
    });
    if (withheld === undefined) throw new Error("no withheld order");
    const old = withheld;

    // 2. The challenge opens: a new owner deposit (outside the runner), then the open template through the challenge runner.
    const openTpl = template("manifest.open-challenge.example.json");
    const challengeIdentity: LiveManifest = { ...identity, agent_key_published: true, gas_tgas: openTpl.gas_tgas, storage: openTpl.storage };
    const deposit = { usdc: 5n * USDC, wnear: 1n * WNEAR };
    await fund(deposit.usdc, deposit.wnear);
    const mOpen: LiveManifest = { ...challengeIdentity, budget: openTpl.budget, expect_existing_grant: false, steps: LiveManifest.shape.steps.parse(openTpl.steps) };
    const pOpen = pathOf(mOpen, "challenge-open");
    const env = (path: string, extra: Record<string, string> = {}) => ({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path, ...extra });
    const rOpen: ChallengeResult = await runChallenge(env(pOpen), challengeDeps());
    let newKey = "";
    await challengeCase.check("fresh-grant-opened", async () => {
      expect([rOpen.exitCode, rOpen.message]).toEqual([0, "completed"]);
      const g = await mandate.grant();
      expect(g?.status).toBe("active");
      expect(g?.epoch).toBe(primaryEpoch + 1);
      expect(g?.path).toBe(`mandate/v1/${primaryEpoch + 1}`);
      expect(g?.public_key).not.toBeNull();
      expect(g?.public_key).not.toBe(old.signing_key);
      newKey = g?.public_key ?? "";
      expect(await world.verifier.hasPublicKey(mandateId, newKey)).toBe(true);
      expect(await world.verifier.hasPublicKey(mandateId, old.signing_key)).toBe(false);
      expect(await world.verifier.publicKeysOf(mandateId)).toEqual([newKey]);
      expect(await balances(world, mandateId)).toEqual(deposit);
      const rec = ChallengeRecord.parse(rOpen.record);
      expect(rec.status).toBe("open");
      expect(rec.grant?.public_key).toBe(newKey);
      expect(rec.agent_key.public_key).toBe(agentKey.getPublicKey().toString());
      // The record's earlier-grant key comes from the signer's view; it must be the key that signed the withheld order.
      expect(rec.earlier_grants.find((e) => e.epoch === primaryEpoch)).toMatchObject({ derived_public_key: old.signing_key, registered: false });
      expect(rec.earlier_unexecuted_orders.find((o) => o.id === old.order_id)).toMatchObject({ nonce_used: false, state: "released:key_removed" });
      expect(rec.opened?.tx_hash).toMatch(/.+/);
    });

    // The adversary: only the agent key (read from the handed-over credential file) and its own account.
    const published = loadCredential(agentCredential, agentId);
    const agent = { id: agentId, key: published.key, account: world.client.account(agentId, published.key) };
    const stranger = world.attacker;
    const view: World = { ...world, mandate, agent, owner };
    const snapshot = async () => {
      const g = await mandate.grant();
      const bal = async (id: string) => Object.values(await balances(world, id)).map(String).join("/");
      return JSON.stringify({
        grant: g,
        orders: await mandate.listOrders(),
        mandate: await bal(mandateId),
        owner: await bal(owner.id),
        newKey: await world.verifier.hasPublicKey(mandateId, newKey),
        oldKey: await world.verifier.hasPublicKey(mandateId, old.signing_key),
        mandateKeys: await world.verifier.publicKeysOf(mandateId),
        agentKeys: (await world.client.accessKeys(agentId)).map((k) => [k.public_key, k.permission.kind]),
      });
    };
    const forgedWithAgentKey = async (): Promise<Outcome> => {
      const now = await world.client.blockTimestampNs();
      const deadline = now + 60_000_000_000n;
      const forged = signNep413(published.key, {
        message: JSON.stringify({ signer_id: mandateId, deadline: rfc3339FromNs(deadline), intents: [{ intent: "transfer", receiver_id: stranger.id, tokens: { [`nep141:${world.tokens.usdc}`]: "1000000" } }] }),
        nonce: versionedNonce(await world.verifier.currentSalt(), deadline),
        recipient: world.verifier.id,
      });
      return world.verifier.execute(stranger.account, [forged], "adversary: intent signed with the published agent key");
    };
    const agentCall = (receiver: string, method: string, args: Record<string, unknown>, deposit = 0n) => () => world.client.call(`adversary ${method}`, agent.account, receiver, method, args, { gas: MAX_GAS, deposit });
    const extras: { id: string; expected: Boundary; attempt: () => Promise<Outcome> }[] = [
      { id: "agent-ft-withdraw", expected: "near-access-key", attempt: agentCall(world.verifier.id, "ft_withdraw", { token: world.tokens.usdc, receiver_id: stranger.id, amount: "1" }, ONE_YOCTO) },
      { id: "agent-token-transfer", expected: "near-access-key", attempt: agentCall(world.tokens.usdc, "ft_transfer", { receiver_id: stranger.id, amount: "1" }, ONE_YOCTO) },
      { id: "agent-remove-grant-key", expected: "near-access-key", attempt: agentCall(world.verifier.id, "remove_public_key", { public_key: newKey }, ONE_YOCTO) },
      { id: "agent-reconcile-registration", expected: "near-access-key", attempt: agentCall(mandateId, "reconcile_registration", {}) },
      { id: "agent-delete-own-key", expected: "near-access-key", attempt: () => world.client.send("adversary delete_key", agent.account, agentId, [actions.deleteKey(published.key.getPublicKey())], "delete_key") },
      { id: "agent-key-signs-transfer-intent", expected: "verifier", attempt: forgedWithAgentKey },
    ];
    const all = [...chainAttacks().map((a) => ({ id: a.id, expected: a.expected, attempt: () => a.attempt(view) })), ...extras];
    for (const a of all) {
      const before = await snapshot();
      const outcome = await a.attempt();
      const after = await snapshot();
      attempts.push({ id: a.id, expected: a.expected, observed: classify(outcome), contained: before === after, error: (outcome.error ?? outcome.receipts.find((r) => !r.success)?.error ?? "").slice(0, 300) });
    }
    await challengeCase.check("forbidden-attempts-fail", () => {
      expect(attempts.length).toBe(all.length);
      for (const a of attempts) expect({ id: a.id, observed: a.observed, contained: a.contained }).toEqual({ id: a.id, observed: a.expected, contained: true });
      for (const b of ["near-access-key", "contract-role", "contract-schema", "contract-policy", "verifier"]) expect(attempts.map((a) => a.observed)).toContain(b);
    });

    // 3. Permitted trades: the adversary proposes at the policy's concession and fills its own orders.
    const strangerKey = KeyPair.fromRandom("ed25519");
    requireSuccess(await world.verifier.addPublicKey(stranger.account, strangerKey.getPublicKey().toString()));
    await mintAndDeposit(world, stranger, "usdc", 20n * USDC, stranger.id);
    await mintAndDeposit(world, stranger, "wnear", 10n * WNEAR, stranger.id);
    const strangerFiller = new Filler({ client: world.client, mandate, verifier: world.verifier, account: stranger.account, key: strangerKey, statePath: join(dir, "stranger-filler.json") });
    const propose = (sell: Asset, units: bigint, bps: number) => mandate.propose(agent.account, { sell, sell_amount: units.toString(), max_concession_bps: bps }, "adversary propose_order");
    const orderIdOf = (o: Outcome): string => {
      requireSuccess(o);
      return String(o.return_value);
    };
    const priced = async (id: string): Promise<OrderView> => {
      const o = await settledOrder(mandate, id, 30_000);
      if (o === null) throw new Error(`order ${id} missing`);
      return o;
    };
    const grant0 = await mandate.grant();
    if (grant0?.initial_reference == null || grant0.initial_value === null) throw new Error("no initial reference");
    const ref0 = grant0.initial_reference;
    // Independent valuation of the deposit at the grant's initial reference.
    const initialUsd = usd(deposit.usdc, DECIMALS.usdc, ref0.usdc) + usd(deposit.wnear, DECIMALS.wnear, ref0.wnear);
    const policy = grant0.policy;
    const trade = async (sell: Asset, units: bigint) => {
      await postPrices(world);
      const id = orderIdOf(await propose(sell, units, policy.max_concession_bps));
      const o = await priced(id);
      const before = await balances(world, mandateId);
      const fill = await strangerFiller.fill(id);
      const after = await balances(world, mandateId);
      const settled = requireSuccess(await mandate.settle(stranger.account, id));
      const buy: Asset = sell === "usdc" ? "wnear" : "usdc";
      trades.push({ order_id: id, sell, sell_amount: o.sell_amount, buy_amount: o.buy_amount, concession_bps: o.concession_bps, fill: fill.record.state, settle_tx: settled.tx_hash ?? null });
      return { o, fill, delta: { sold: before[sell] - after[sell], bought: after[buy] - before[buy] }, buy };
    };
    await challengeCase.check("permitted-trades-bounded", async () => {
      for (const [sell, units] of [["usdc", 1_500_000n], ["wnear", 5n * 10n ** 23n]] as const) {
        const { o, fill, delta, buy } = await trade(sell, units);
        expect(o.state.state).toBe("signed");
        expect(fill.record.state).toBe("filled");
        // Executed exactly at the signed amounts.
        expect(delta).toEqual({ sold: BigInt(o.sell_amount), bought: BigInt(o.buy_amount ?? "-1") });
        // Concession bound against the order's authorization reference, independently valued.
        if (o.reference === null) throw new Error("no reference");
        const sellUsd = usd(BigInt(o.sell_amount), DECIMALS[sell], o.reference[sell]);
        const buyUsd = usd(BigInt(o.buy_amount ?? "0"), DECIMALS[buy], o.reference[buy]);
        expect(buyUsd * 10_000n >= sellUsd * BigInt(10_000 - policy.max_concession_bps)).toBe(true);
        // Within the per-order cap of the initial value.
        expect(usd(units, DECIMALS[sell], ref0[sell]) * 10_000n <= initialUsd * BigInt(policy.per_order_cap_bps)).toBe(true);
        expect((await mandate.order(o.id))?.state).toEqual({ state: "released", reason: "settled" });
      }
      // Above the per-order cap (independently valued above it): refused at proposal.
      const over = 1_700_000n;
      expect(usd(over, DECIMALS.usdc, ref0.usdc) * 10_000n > initialUsd * BigInt(policy.per_order_cap_bps)).toBe(true);
      const rOver = await propose("usdc", over, 0);
      expect(rOver.success).toBe(false);
      expect(rOver.error ?? "").toMatch(/per-order cap exceeded/);
      // Two orders each within the per-order cap whose sum exceeds the outstanding cap: the second is refused.
      await postPrices(world);
      const a = await priced(orderIdOf(await propose("usdc", 1_000_000n, 0)));
      expect(a.state.state).toBe("signed");
      const b = 210_000_000_000_000_000_000_000n;
      expect((usd(1_000_000n, DECIMALS.usdc, ref0.usdc) + usd(b, DECIMALS.wnear, ref0.wnear)) * 10_000n > initialUsd * BigInt(policy.outstanding_cap_bps)).toBe(true);
      const rB = await propose("wnear", b, 0);
      expect(rB.error ?? "").toMatch(/outstanding cap exceeded/);
      expect((await strangerFiller.fill(a.id)).record.state).toBe("filled");
      requireSuccess(await mandate.settle(stranger.account, a.id));
      // Above the concession bound: refused.
      expect((await propose("usdc", 100_000n, policy.max_concession_bps + 1)).error ?? "").toMatch(/concession above policy maximum/);
    });

    // 4. The completed run's withheld order, relayed with a fresh counter-signature while the challenge grant is live.
    await challengeCase.check("withheld-order-still-rejected", async () => {
      const signed = old.bundle[0];
      if (signed === undefined) throw new Error("no withheld payload");
      const prepared = await strangerFiller.prepare(signed);
      if ("shortfall" in prepared) throw new Error(prepared.shortfall);
      const before = { mandate: await balances(world, mandateId), stranger: await balances(world, stranger.id) };
      const nowNs = await world.client.blockTimestampNs();
      expect(BigInt(old.deadline_ns) > nowNs).toBe(true);
      expect((await mandate.grant())?.status).toBe("active");
      const relay = await world.verifier.execute(stranger.account, prepared.bundle, "adversary relays the completed run's withheld order");
      const error = relay.error ?? relay.receipts.find((r) => !r.success)?.error ?? "";
      notes.withheld_relay = { order_id: old.order_id, remaining_ms: ((BigInt(old.deadline_ns) - nowNs) / 1_000_000n).toString(), tx_hash: relay.tx_hash ?? null, error: error.slice(0, 300) };
      expect(relay.success && !relay.any_receipt_failed).toBe(false);
      expect(classify(relay)).toBe("verifier");
      expect(error).toContain(old.signing_key);
      expect(await world.verifier.isNonceUsed(mandateId, old.mandate_nonce)).toBe(false);
      expect({ mandate: await balances(world, mandateId), stranger: await balances(world, stranger.id) }).toEqual(before);
    });

    // 5. The proposal budget, then the loss breaker on the last proposal it allows.
    await challengeCase.check("proposal-budget-and-breaker", async () => {
      const initial = BigInt(grant0.initial_value ?? "0");
      const floor = (initial * BigInt(policy.proposal_charge_bps) + 9_999n) / 10_000n;
      const cap = (initial * BigInt(policy.turnover_cap_bps)) / 10_000n;
      const perOrder = (initial * BigInt(policy.per_order_cap_bps)) / 10_000n;
      const used = async () => BigInt((await mandate.grant())?.turnover_used ?? "0");
      let tiny = 0;
      await postPrices(world);
      while (cap - (await used()) >= 2n * floor) {
        await priced(orderIdOf(await propose("usdc", 1n, 0)));
        tiny += 1;
        expect(tiny).toBeLessThan(Math.floor(policy.turnover_cap_bps / policy.proposal_charge_bps) + 1);
      }
      const remaining = cap - (await used());
      expect(remaining >= floor && remaining < 2n * floor).toBe(true);
      // A proposal valued between the remaining turnover and the per-order cap: refused for turnover.
      expect(remaining < perOrder).toBe(true);
      const target = (remaining + perOrder) / 2n;
      const unitValue = usd(1n, DECIMALS.usdc, ref0.usdc);
      const units = (target * initialUsd) / (initial * unitValue) + 1n;
      const rT = await propose("usdc", units, 0);
      expect(rT.error ?? "").toMatch(/turnover cap exceeded/);
      // A market drop posted by the oracle keeper: the last allowed proposal trips the breaker at pricing.
      const shock = { price: (PRICES.wnear.price * 3n) / 4n, conf: (PRICES.wnear.conf * 3n) / 4n, expo: PRICES.wnear.expo };
      await postPrices(world, { wnear: shock });
      const last = await priced(orderIdOf(await propose("usdc", 1n, 0)));
      expect(last.state).toEqual({ state: "rejected", reason: "loss breaker tripped" });
      const g = await mandate.grant();
      expect(g?.breaker).not.toBeNull();
      expect(cap - BigInt(g?.turnover_used ?? "0") < floor).toBe(true);
      await postPrices(world);
      expect((await propose("usdc", 1n, 0)).error ?? "").toMatch(/loss breaker tripped/);
      notes.budget = { tiny_proposals: tiny, floor: floor.toString(), turnover_cap: cap.toString(), turnover_used: g?.turnover_used, breaker: g?.breaker };
    });

    // 6. The close: the runner stops awaiting the owner's console revocation; meanwhile the adversary burns the agent's
    // allowance; the resume imports the owner's signatures and completes.
    const closeTpl = template("manifest.open-challenge-close.example.json");
    const mClose: LiveManifest = { ...challengeIdentity, budget: closeTpl.budget, gas_tgas: closeTpl.gas_tgas, expect_existing_grant: true, steps: LiveManifest.shape.steps.parse(closeTpl.steps) };
    const pClose = pathOf(mClose, "challenge-close");
    const rAwait = await runChallenge(env(pClose), challengeDeps());
    expect(rAwait.awaiting?.kind).toBe("revoke_external");
    await challengeCase.check("allowance-exhausted", async () => {
      const nonceBefore = await world.client.accessKeyNonce(agentId, agent.key.getPublicKey().toString());
      const allowanceNow = async () => {
        const k = (await world.client.accessKeys(agentId))[0];
        return k?.permission.kind === "function_call" ? (k.permission.allowance ?? -1n) : -1n;
      };
      // Each call's unused prepaid gas returns to the allowance, so the adversary burns the most per call it can: the
      // largest argument payload a transaction carries (propose_order with a padding field; the mandate refuses it).
      const tinyProposal = { sell: "usdc", sell_amount: "1", max_concession_bps: 0 };
      const call = (gas: bigint, pad: boolean) => world.client.call("adversary burns allowance", agent.account, mandateId, "propose_order", pad ? { proposal: tinyProposal, pad: "x".repeat(1_000_000) } : { proposal: tinyProposal }, { gas });
      /** Sends until the key refuses a call (allowance); every included call must fail. */
      const burnUntilRefused = async (gas: bigint, pad: boolean, max: number): Promise<{ calls: number; refusal: Outcome | null }> => {
        for (let calls = 1; calls <= max; calls++) {
          const o = await call(gas, pad);
          if (!o.submitted) return { calls, refusal: o };
          expect(o.success).toBe(false);
        }
        return { calls: max, refusal: null };
      };
      const a0 = await allowanceNow();
      const first = await call(MAX_GAS, true);
      expect(first.submitted && !first.success).toBe(true);
      const perCall = a0 - (await allowanceNow());
      expect(perCall > 0n).toBe(true);
      // Later calls can burn less than the first; a multiple of the first call's estimate bounds each loop.
      const bound = 3 * Number(a0 / perCall) + 50;
      expect(bound).toBeLessThan(600);
      const atMax = await burnUntilRefused(MAX_GAS, true, bound);
      expect(atMax.refusal).not.toBeNull();
      // The smallest gas propose_order accepts, found by execution: below it the mandate panics on gas, at it on the breaker.
      let lo = 1n;
      let hi = 300n;
      while (lo < hi) {
        const mid = (lo + hi) / 2n;
        const o = await call(mid * TGAS, false);
        if (o.submitted && /insufficient gas attached/.test(o.error ?? "")) lo = mid + 1n;
        else hi = mid;
      }
      const minGas = lo * TGAS;
      // At that gas: padded calls, then plain proposals, until the key refuses even a plain minimum-gas proposal.
      const padded = await burnUntilRefused(minGas, true, bound);
      // Refunds of unused gas reach the allowance in later blocks; a refusal counts only once it holds after they landed.
      const settleRefunds = async () => {
        const target = (await world.client.provider.viewBlock({ finality: "optimistic" })).header.height + 5;
        while ((await world.client.provider.viewBlock({ finality: "final" })).header.height < target) await new Promise((r) => setTimeout(r, 200));
      };
      let plain = await burnUntilRefused(minGas, false, 10 * bound);
      let rounds = 1;
      for (; rounds < 20 && plain.refusal !== null; rounds++) {
        await settleRefunds();
        const again = await burnUntilRefused(minGas, false, 10 * bound);
        if (again.calls === 1 && again.refusal !== null) break;
        plain = { calls: plain.calls + again.calls, refusal: again.refusal };
      }
      notes.allowance = {
        first_call_burn: perCall.toString(),
        calls_at_max_gas: atMax.calls,
        min_propose_tgas_found: lo.toString(),
        padded_calls_at_min_gas: padded.calls,
        plain_calls_at_min_gas: plain.calls,
        refusal_rounds_until_stable: rounds,
        remaining: (await allowanceNow()).toString(),
        refusal: (plain.refusal?.error ?? "").slice(0, 300),
      };
      const refusal = plain.refusal;
      expect(refusal).not.toBeNull();
      if (refusal === null) return;
      expect(classify(refusal)).toBe("near-access-key");
      expect(refusal.error ?? "").toMatch(/allowance/i);
      // Any larger gas is refused too: the key can no longer carry a proposal the mandate would accept.
      expect((await call(minGas + TGAS, false)).submitted).toBe(false);
      const nonceAfter = await world.client.accessKeyNonce(agentId, agent.key.getPublicKey().toString());
      expect((nonceAfter ?? 0n) > (nonceBefore ?? 0n)).toBe(true);
    });
    const ownerNearBefore = { usdc: await new TokenClient(world.client, world.tokens.usdc).balance(owner.id), wnear: await new TokenClient(world.client, world.tokens.wnear).balance(owner.id) };
    const mandateBefore = await balances(world, mandateId);
    const rClose = await runChallenge(env(pClose, { MANDATE_LIVE_RESUME: "1" }), challengeDeps({ handoff: adapter(consoleAccount) }));
    await challengeCase.check("owner-close-after-exhaustion", async () => {
      expect([rClose.exitCode, rClose.message]).toEqual([0, "completed"]);
      const l = ledgerOf(join(dir, "challenge", "live"), pClose);
      expect(l.ofKind("external-handoff").map((e) => e.data.kind)).toEqual(["revoke_external", "recover_external", "recover_external", "withdraw_external", "withdraw_external"]);
      expect(l.ofKind("tx-intent")).toEqual([]);
      const g = await mandate.grant();
      expect(g?.status).toBe("revoked");
      expect(await world.verifier.publicKeysOf(mandateId)).toEqual([]);
      const orders = (await mandate.allOrders()).filter((o) => o.epoch === g?.epoch);
      expect(orders.filter((o) => ["pricing", "signing", "signed", "sign_unknown"].includes(o.state.state))).toEqual([]);
      expect(await balances(world, mandateId)).toEqual({ usdc: 0n, wnear: 0n });
      expect(await balances(world, owner.id)).toEqual({ usdc: 0n, wnear: 0n });
      for (const asset of ["usdc", "wnear"] as const) {
        expect((await new TokenClient(world.client, world.tokens[asset]).balance(owner.id)) - ownerNearBefore[asset]).toBe(mandateBefore[asset]);
      }
      expect(ChallengeRecord.parse(rClose.record).status).toBe("closed");
    });

    await challengeCase.check("evidence-separate-and-keyless", () => {
      // The completed run's evidence is untouched; the challenge writes only under its own root.
      expect(shaOf(primaryEvidence)).toBe(primaryEvidenceSha);
      const challengeFiles = filesUnder(join(dir, "challenge", "evidence")).map((p) => p.slice(join(dir, "challenge", "evidence").length + 1)).sort();
      expect(challengeFiles).toEqual(["challenge-sandbox.json", "live-sandbox.json"]);
      const rec = ChallengeRecord.parse(JSON.parse(readFileSync(join(dir, "challenge", "evidence", "challenge-sandbox.json"), "utf8")));
      expect(rec.status).toBe("closed");
      expect(rec.separate_from_completed_run).toBe(true);
      expect(rec.does_not_show).toEqual([...CHALLENGE_DOES_NOT_SHOW]);
      expect(rec.agent_key.public_key).toBe(agentKey.getPublicKey().toString());
      expect(rec.grant?.breaker).not.toBeNull();
      // No file the runs wrote (ledgers, intents, evidence, records, manifests) holds the agent's private key.
      const secretPart = agentSecret.replace(/^ed25519:/, "");
      const files = filesUnder(dir);
      expect(files.length).toBeGreaterThan(10);
      for (const f of files) expect(readFileSync(f, "utf8").includes(secretPart), f).toBe(false);
      notes.challenge_record = rec;
    });
  }, 1_800_000);
});
