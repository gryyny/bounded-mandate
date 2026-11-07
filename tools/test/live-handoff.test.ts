// gate: HANDOFF, WITHDRAW, LIVE — the live runner's external owner actions, owner withdrawals and the primary template,
// against a local sandbox only (never a public network). Mandates are the exact deployment binary from fixtures/deploy.
// Owner transactions "signed outside the runner" are signed here by a SANDBOX LOCAL SIGNING ADAPTER (a test double
// with TEST keys standing in for the console's wallet); this establishes nothing about any external wallet. Forged
// transactions are deliberately wrong test inputs. Model answers are SYNTHETIC (written by the test). Token contracts
// are the mock-ft test double; a refunded withdrawal receipt is produced with a SANDBOX DOUBLE (an RPC view that
// misreports the owner's registration) and a failed verifier receipt with deliberately low prepaid gas; neither is
// presented as a mainnet result. Stray owner transactions, added keys, and an RPC status reporting another chain are
// injected by SANDBOX DOUBLE transports at labelled points.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, KeyPair, actions, type Account, type Action } from "near-api-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_POLICY } from "../src/demo/market.js";
import { AGENT_ALLOWANCE, balances, mintAndDeposit, postPrices, setupWorld, type World } from "../src/demo/world.js";
import { CaseRecorder, wasmHashes } from "../src/evidence/report.js";
import { totals } from "../src/live/budget.js";
import { ExternalIntent, handoffOf, intentSha256, type ExternalHandoff } from "../src/live/external.js";
import { Ledger } from "../src/live/ledger.js";
import { runLive, type LiveDeps, type LiveResult } from "../src/live/main.js";
import { LiveManifest } from "../src/live/manifest.js";
import { ownerKeySnapshot } from "../src/live/preflight.js";
import { NEAR, NearClient, TGAS } from "../src/near/client.js";
import { MandateClient, TokenClient } from "../src/near/contracts.js";
import { sandboxKey } from "../src/near/keys.js";
import { LocalNetwork, REPO_ROOT, requireSuccess, type SandboxAccount } from "../src/near/sandbox.js";
import type { Asset } from "../src/types.js";
import { SyntheticProvider, proposeJson } from "./agent-live-helpers.js";
import { hash58, recordRpc, sandboxManifest, writeCredential, writeJson } from "./live-helpers.js";

const FIXTURE = "fixtures/deploy/bounded_mandate-163ccfa-reproducible.wasm";
const USDC = 10n ** 6n;
const WNEAR = 10n ** 24n;

let net: LocalNetwork;
let world: World;
let dir: string;
let base: LiveManifest;
let candidate: Uint8Array;
let finalClient: NearClient;

// Required cases (provisional ids; each passes only if all its checks ran and passed in this run).
const cases = {
  imported: new CaseRecorder("HANDOFF", "import-verified", ["revoke-and-recoveries-imported", "end-state-verified", "fee-and-nonce-accounted", "intent-files-match-ledger"]),
  refusals: new CaseRecorder("HANDOFF", "import-refusals", [
    "wrong-chain",
    "wrong-signer",
    "wrong-key",
    "wrong-receiver",
    "wrong-method",
    "altered-args",
    "gas-below-bounds",
    "gas-above-bounds",
    "deposit-out-of-bounds",
    "extra-action",
    "wrong-chain-status",
    "duplicate-hash",
    "second-hash-for-satisfied-intent",
  ]),
  lost: new CaseRecorder("HANDOFF", "lost-response-resume", ["import-lookup-lost", "import-crash-after-handoff", "runner-withdrawal-lost"]),
  unrecorded: new CaseRecorder("HANDOFF", "unrecorded-owner-tx", ["during-import", "while-awaiting-then-resume", "stray-then-runner-owner-step", "extra-owner-key-stray", "owner-key-added", "stray-after-last-step"]),
  both: new CaseRecorder("WITHDRAW", "both-assets", ["registered-owner-runner-signed"]),
  unregistered: new CaseRecorder("WITHDRAW", "unregistered-owner", ["registers-only-where-needed", "external-withdrawal-unregistered-owner"]),
  retry: new CaseRecorder("WITHDRAW", "failed-receipt-retry", ["partial-failure-recorded", "retry-without-double-count", "external-refund-retried-and-imported", "verifier-failure-classified-failed"]),
  template: new CaseRecorder("LIVE", "agent-template", ["primary-template-sequence"]),
};

/** Which path each import-refusal case took (written into the HANDOFF.import-refusals report). */
const refusalPaths: Record<string, Record<string, unknown>> = {};

const deps = (extra: Partial<LiveDeps> = {}): LiveDeps => ({ outRoot: join(dir, "live"), timeoutMs: 60_000, pollMs: 300, ...extra });
let counter = 0;
const pathOf = (m: LiveManifest, name: string): string => writeJson(dir, `${name}-${counter++}.json`, { ...m, approval: { ...m.approval, reference: `${name} ${counter}` } });
const live = (path: string, extra: Partial<LiveDeps> = {}, env: Record<string, string> = {}): Promise<LiveResult> => runLive({ MANDATE_LIVE: "1", MANDATE_LIVE_MANIFEST: path, ...env }, deps(extra));
const resume = (path: string, extra: Partial<LiveDeps> = {}, env: Record<string, string> = {}): Promise<LiveResult> => live(path, extra, { MANDATE_LIVE_RESUME: "1", ...env });
const ledgerOf = (path: string): Ledger => {
  const sha = createHash("sha256").update(readFileSync(path)).digest("hex");
  return Ledger.load(Ledger.dirFor(join(dir, "live"), sha), sha);
};
async function settleFinal(): Promise<void> {
  const target = (await world.client.provider.viewBlock({ finality: "optimistic" })).header.height;
  while ((await world.client.provider.viewBlock({ finality: "final" })).header.height < target) await new Promise((r) => setTimeout(r, 200));
}
const tokens = (asset: Asset) => new TokenClient(world.client, world.tokens[asset]);
const ownerNonce = (account: string, key: KeyPair) => world.client.accessKeyNonce(account, key.getPublicKey().toString());

/** SANDBOX LOCAL SIGNING ADAPTER (test double): signs the intent's exact actions, or `mutate`d ones, with `account`. */
async function sign(intent: ExternalIntent, account: Account, mutate: (a: Action[]) => Action[] = (a) => a, receiver = intent.receiver_id, client = finalClient): Promise<string> {
  const acts = intent.actions.map((a) => actions.functionCall(a.method, a.args, BigInt(a.gas), BigInt(a.deposit)));
  const outcome = await client.send(`SANDBOX signing adapter: ${intent.kind}`, account, receiver, mutate(acts), intent.actions[0]?.method ?? "-");
  if (outcome.tx_hash === undefined) throw new Error(`signing adapter: no transaction hash (${outcome.error ?? ""})`);
  return outcome.tx_hash;
}
const handoff = async (intent: ExternalIntent, hash: string, signer = intent.signer_id): Promise<ExternalHandoff> => handoffOf(await intentSha256(intent), hash, signer);
/** Handoff supplier that signs every intent exactly, as the console would after the owner approves. */
const adapter = (account: Account) => async (intent: ExternalIntent) => handoff(intent, await sign(intent, account));

interface Mandate {
  id: string;
  owner: SandboxAccount & { key: KeyPair };
  manifest: LiveManifest;
}

/** Deploys the deployment binary as `<name>` with its own agent key and `owner` as the fixed owner. */
async function deployMandate(name: string, owner: SandboxAccount): Promise<Mandate> {
  const root = net.root.id;
  const id = `${name}.${root}`;
  const config = { ...base.mandate_config, owner_id: owner.id, agent_id: `${name}-agent.${root}` };
  await net.createAccount(name, { balanceNear: 30n, wasm: candidate, init: { method: "new", args: { config } }, key: "none" });
  const agent = await net.createAccount(`${name}-agent`, { balanceNear: 5n, key: { receiver: id, methods: ["propose_order"], allowance: AGENT_ALLOWANCE } });
  if (agent.key === null || owner.key === null) throw new Error("missing key");
  const manifest: LiveManifest = {
    ...base,
    accounts: { ...base.accounts, mandate: id, owner: owner.id, agent: agent.id },
    // Independently hashed from the fixture file, then checked against the chain by preflight.
    code_hashes: { ...base.code_hashes, mandate: hash58(candidate) },
    mandate_config: config,
    keys: { ...base.keys, owner: { public_key: owner.key.getPublicKey().toString() }, agent: { public_key: agent.key.getPublicKey().toString(), max_allowance_yocto: AGENT_ALLOWANCE.toString() } },
    credentials: { ...base.credentials, owner: writeCredential(dir, `${name}-owner.json`, owner.id, owner.key), agent: writeCredential(dir, `${name}-agent.json`, agent.id, agent.key) },
  };
  // The runner reads at final finality; setup writes are optimistic.
  await settleFinal();
  return { id, owner: { ...owner, key: owner.key }, manifest };
}

const fund = async (mandate: string, usdc: bigint, wnear: bigint): Promise<void> => {
  if (usdc > 0n) await mintAndDeposit(world, world.owner, "usdc", usdc, mandate);
  if (wnear > 0n) await mintAndDeposit(world, world.owner, "wnear", wnear, mandate);
  await postPrices(world);
  await settleFinal();
};

const kinds = (l: Ledger, kind: "tx-intent" | "external-intent" | "external-handoff" | "external-refused") => l.ofKind(kind).map((e) => e.data.kind ?? e.data.step);
/** tokens_burnt summed over a transaction's outcome and every receipt, read from the raw RPC response (independent of the runner's parsing). */
async function burnt(hash: string, signer: string): Promise<bigint> {
  const raw = (await world.client.provider.viewTransactionStatusWithReceipts({ txHash: hash, accountId: signer, waitUntil: "FINAL" })) as unknown as {
    transaction_outcome: { outcome: { tokens_burnt: string } };
    receipts_outcome: { outcome: { tokens_burnt: string } }[];
  };
  return [raw.transaction_outcome, ...raw.receipts_outcome].reduce((sum, o) => sum + BigInt(o.outcome.tokens_burnt), 0n);
}
/** The single external-refused entry's recorded fee fields. */
const refusedFee = (l: Ledger) => {
  const e = l.ofKind("external-refused").at(-1);
  return { tx_hash: String(e?.data.tx_hash), fee_yocto: e?.data.fee_yocto ?? null, payer: e?.data.payer ?? null, charged: e?.data.charged, fee_note: String(e?.data.fee_note) };
};

/** Sum of the actual fees of every executed or imported transaction: what the budget must equal once all settled. */
const actualFees = (l: Ledger): bigint => {
  const seen = new Map<string, bigint>();
  for (const e of l.entries) if ((e.kind === "tx-result" || e.kind === "reconciled") && e.data.status === "executed") seen.set(String(e.data.tx_hash), BigInt(String(e.data.fee_yocto)));
  return [...seen.values()].reduce((a, b) => a + b, 0n);
};

beforeAll(async () => {
  net = await LocalNetwork.start();
  world = await setupWorld(net);
  await settleFinal();
  dir = mkdtempSync(join(tmpdir(), "bm-live-handoff-"));
  base = await sandboxManifest(world, dir);
  candidate = readFileSync(join(REPO_ROOT, FIXTURE));
  finalClient = world.client.final();
}, 180_000);

afterAll(async () => {
  const wasm = { ...wasmHashes(typeof world === "undefined" ? [] : Object.values(world.wasm)), "bounded_mandate-163ccfa-reproducible": createHash("sha256").update(readFileSync(join(REPO_ROOT, FIXTURE))).digest("hex") };
  for (const c of Object.values(cases)) {
    const extra = c === cases.refusals ? { refusal_paths: refusalPaths } : {};
    c.write("sandbox", wasm, { deployment_binary: FIXTURE, signing: "SANDBOX LOCAL SIGNING ADAPTER (test double)", tokens: "mock-ft test double", ...extra });
  }
  await net.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe("external owner actions: import by hash", () => {
  // gate: HANDOFF
  it("imports an external revoke and both recoveries, verifies their end state, accounts fees and nonces, refuses duplicates", async () => {
    const ownerV = await net.createAccount("ownerv");
    const mv = await deployMandate("mv", ownerV);
    await fund(mv.id, 5n * USDC, 2n * WNEAR);
    const ownerBefore = await balances(world, ownerV.id);
    const nonceBefore = await ownerNonce(ownerV.id, mv.owner.key);
    const m: LiveManifest = { ...mv.manifest, steps: [{ kind: "grant", policy: DEMO_POLICY }, { kind: "revoke_external" }, { kind: "recover_external", asset: "usdc" }, { kind: "recover_external", asset: "wnear" }] };
    const path = pathOf(m, "import-verified");
    const r = await live(path, { handoff: adapter(mv.owner.account) });
    await cases.imported.check("revoke-and-recoveries-imported", () => {
      expect(r.message).toBe("completed");
      expect(r.exitCode).toBe(0);
      const l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual(["grant"]);
      expect(kinds(l, "external-intent")).toEqual(["revoke_external", "recover_external", "recover_external"]);
      expect(kinds(l, "external-handoff")).toEqual(["revoke_external", "recover_external", "recover_external"]);
      const imported = l.ofKind("tx-result").filter((e) => e.data.imported === true);
      expect(imported.map((e) => [e.data.step, e.data.status, e.data.success])).toEqual([
        [1, "executed", true],
        [2, "executed", true],
        [3, "executed", true],
      ]);
      expect(l.ofKind("external-refused")).toEqual([]);
      const steps = r.evidence?.assertions.filter((a) => a.id.startsWith("step-")) ?? [];
      expect(steps.map((a) => [a.id, a.passed])).toEqual([
        ["step-1-grant", true],
        ["step-2-revoke_external", true],
        ["step-3-recover_external", true],
        ["step-4-recover_external", true],
      ]);
      expect(steps.slice(1).every((a) => a.description.includes("imported owner transaction"))).toBe(true);
    });
    await cases.imported.check("end-state-verified", async () => {
      const grant = await new MandateClient(world.client, mv.id).grant();
      expect(grant?.status).toBe("revoked");
      expect(await world.verifier.publicKeysOf(mv.id)).toEqual([]);
      expect(await balances(world, mv.id)).toEqual({ usdc: 0n, wnear: 0n });
      const after = await balances(world, ownerV.id);
      expect(after.usdc - ownerBefore.usdc).toBe(5n * USDC);
      expect(after.wnear - ownerBefore.wnear).toBe(2n * WNEAR);
    });
    await cases.imported.check("fee-and-nonce-accounted", async () => {
      const l = ledgerOf(path);
      const t = totals(l);
      expect(t.transactions).toBe(4);
      expect(t.fee_yocto).toBe(actualFees(l));
      // grant (runner) and three imports, each on the owner key: the nonce expectation advanced with every import.
      expect(await ownerNonce(ownerV.id, mv.owner.key)).toBe((nonceBefore ?? 0n) + 4n);
      const again = await resume(path);
      expect(again.message).toBe("completed");
      expect(again.exitCode).toBe(0);
    });
    await cases.imported.check("intent-files-match-ledger", async () => {
      const l = ledgerOf(path);
      for (const e of l.ofKind("external-intent")) {
        const file = join(l.dir, String(e.data.intent_file));
        const intent = ExternalIntent.parse(JSON.parse(readFileSync(file, "utf8")));
        expect(await intentSha256(intent)).toBe(e.data.intent_sha256);
        expect(intent.public_key).toBe(mv.owner.key.getPublicKey().toString());
        // Persisted before the owner signed: the intent precedes its handoff in the hash-chained ledger.
        const h = l.ofKind("external-handoff").find((x) => x.data.intent_sha256 === e.data.intent_sha256);
        expect(h !== undefined && h.seq > e.seq).toBe(true);
      }
    });

    // Duplicates on the finished ledger: the same hash again, then a second signed transaction for a satisfied intent.
    const l = ledgerOf(path);
    const recUsdc = l.ofKind("external-intent").find((e) => e.data.kind === "recover_external" && (e.data.intent as { actions: { args: { asset: string } }[] }).actions[0]?.args.asset === "usdc");
    const imported = l.ofKind("external-handoff").find((e) => e.data.intent_sha256 === recUsdc?.data.intent_sha256);
    await cases.refusals.check("duplicate-hash", async () => {
      const dup = writeJson(dir, "dup-handoff.json", handoffOf(String(recUsdc?.data.intent_sha256), String(imported?.data.tx_hash), ownerV.id));
      const r2 = await resume(path, {}, { MANDATE_LIVE_HANDOFF: dup });
      expect(r2.exitCode).toBe(1);
      expect(r2.message).toMatch(/refused: duplicate: transaction \S+ is already in the ledger/);
      const after = ledgerOf(path);
      expect(after.ofKind("external-refused").length).toBe(1);
      expect(after.ofKind("tx-result").length).toBe(l.ofKind("tx-result").length);
      // Its fee is the imported transaction's, already counted once: not charged again.
      const f = refusedFee(after);
      expect([f.charged, f.fee_yocto]).toEqual([false, null]);
      expect(f.fee_note).toMatch(/already in the ledger/);
      expect(totals(after).fee_yocto).toBe(actualFees(after));
      refusalPaths["duplicate-hash"] = { path: "screened before any lookup (MANDATE_LIVE_HANDOFF on resume): the hash is already in the ledger; recorded as external-refused", message: r2.message, ...f };
    });
    await cases.refusals.check("second-hash-for-satisfied-intent", async () => {
      const intent = ExternalIntent.parse(recUsdc?.data.intent);
      // Harmless on chain (the mandate holds no USDC); a second owner transaction for an intent already satisfied.
      const second = await sign(intent, mv.owner.account);
      const file = writeJson(dir, "second-handoff.json", await handoff(intent, second));
      const r3 = await resume(path, {}, { MANDATE_LIVE_HANDOFF: file });
      expect(r3.exitCode).toBe(1);
      expect(r3.message).toMatch(/refused: duplicate: intent [0-9a-f]{64} was already handed off as/);
      const after = ledgerOf(path);
      expect(after.ofKind("external-refused").map((e) => e.data.tx_hash)).toContain(second);
      expect(after.ofKind("external-handoff").length).toBe(3);
      // The owner paid for the refused transaction: its actual fee is recorded and charged once against the cap.
      const fee = await burnt(second, ownerV.id);
      const f = refusedFee(after);
      expect([f.tx_hash, f.payer, f.charged, f.fee_yocto]).toEqual([second, ownerV.id, true, fee.toString()]);
      expect(totals(after).refused_fee_yocto).toBe(fee);
      expect(totals(after).fee_yocto).toBe(actualFees(after) + fee);
      refusalPaths["second-hash-for-satisfied-intent"] = { path: "screened before the import (MANDATE_LIVE_HANDOFF on resume): the intent was already handed off; looked up for its fee, recorded as external-refused", message: r3.message, ...f };
      // Presented again: refused as a duplicate hash, its fee not charged twice.
      const again = await resume(path, {}, { MANDATE_LIVE_HANDOFF: file });
      expect(again.exitCode).toBe(1);
      expect(again.message).toMatch(/refused: duplicate: transaction \S+ is already in the ledger/);
      expect(totals(ledgerOf(path)).fee_yocto).toBe(actualFees(after) + fee);
      // That transaction is not in the ledger as imported, so the owner key's nonce now stops any further resume.
      const r4 = await resume(path);
      expect(r4.exitCode).toBe(2);
      expect(r4.message).toMatch(/owner key nonce on chain/);
    });
  }, 300_000);

  // gate: HANDOFF
  it("refuses wrong chain, signer, key, receiver, method, arguments, bounds and extra actions; nothing is recorded as success", async () => {
    const ownerR = await net.createAccount("ownerr");
    const mr = await deployMandate("mr", ownerR);
    // A second full-access key of the owner account, never approved for imports.
    const k2 = KeyPair.fromRandom("ed25519");
    requireSuccess(await finalClient.send("add unapproved owner key", mr.owner.account, ownerR.id, [actions.addFullAccessKey(k2.getPublicKey())], "add_key"));
    const unapproved = finalClient.account(ownerR.id, k2);
    // The mandate was never granted and holds nothing: an exact recover_external would change nothing but counters.
    const m: LiveManifest = { ...mr.manifest, steps: [{ kind: "recover_external", asset: "usdc" }] };
    const other = await LocalNetwork.start();
    try {
      // The same account id and deterministic TEST key on a second local chain.
      const otherOwner = await other.createAccount("ownerr");
      if (otherOwner.key === null) throw new Error("missing key");
      const otherClient = other.client.final();
      type Forge = (intent: ExternalIntent) => Promise<ExternalHandoff>;
      // SANDBOX DOUBLE: an RPC whose status reports another chain once armed (after preflight, when the owner signs).
      const lying = new OtherChainStatus({ url: world.client.rpcUrl });
      const statusHandoff: { h: ExternalHandoff | null } = { h: null };
      const cases_: [keyof typeof refusalTags, Forge, NearClient?][] = [
        ["wrong-chain", async (i) => handoff(i, await sign(i, otherClient.account(ownerR.id, otherOwner.key ?? undefined), undefined, undefined, otherClient))],
        // The handoff claims the owner, but another account signed.
        ["wrong-signer", async (i) => handoff(i, await sign(i, finalClient.account(world.relayer.id, world.relayer.key ?? undefined)), ownerR.id)],
        ["wrong-key", async (i) => handoff(i, await sign(i, unapproved))],
        ["wrong-receiver", async (i) => handoff(i, await sign(i, mr.owner.account, undefined, world.relayer.id))],
        ["wrong-method", async (i) => handoff(i, await sign(i, mr.owner.account, () => [actions.functionCall("get_recovery", i.actions[0]?.args ?? {}, BigInt(i.actions[0]?.gas ?? "0"), 0n)]))],
        ["altered-args", async (i) => handoff(i, await sign(i, mr.owner.account, () => [actions.functionCall("recover", { asset: "usdc", gas_tgas: 60 }, BigInt(i.actions[0]?.gas ?? "0"), 0n)]))],
        ["gas-below-bounds", async (i) => handoff(i, await sign(i, mr.owner.account, () => [actions.functionCall("recover", { asset: "usdc" }, 20n * TGAS, 0n)]))],
        ["gas-above-bounds", async (i) => handoff(i, await sign(i, mr.owner.account, () => [actions.functionCall("recover", { asset: "usdc" }, 300n * TGAS, 0n)]))],
        ["deposit-out-of-bounds", async (i) => handoff(i, await sign(i, mr.owner.account, (a) => [actions.functionCall("recover", { asset: "usdc" }, BigInt(i.actions[0]?.gas ?? "0"), 1n), ...a.slice(1)]))],
        ["extra-action", async (i) => handoff(i, await sign(i, mr.owner.account, (a) => [...a, actions.transfer(1n)]))],
        [
          "wrong-chain-status",
          async (i) => {
            lying.armed = true;
            statusHandoff.h = await handoff(i, await sign(i, mr.owner.account));
            return statusHandoff.h;
          },
          new NearClient(world.client.rpcUrl, lying),
        ],
      ];
      for (const [name, forge, client] of cases_) {
        await cases.refusals.check(name, async () => {
          await settleFinal();
          const path = pathOf(m, `refusal-${name}`);
          const r = await live(path, { handoff: forge, ...(client === undefined ? {} : { client }) });
          expect(r.exitCode).toBe(1);
          expect(r.message).toMatch(refusalTags[name]);
          const l = ledgerOf(path);
          // Nothing imported, nothing verified, the step not done; a refusal is recorded only once the transaction was found.
          expect(l.ofKind("external-handoff")).toEqual([]);
          expect(l.ofKind("tx-result")).toEqual([]);
          expect(l.ofKind("step-done")).toEqual([]);
          if (name === "wrong-chain" || name === "wrong-chain-status") {
            expect(l.ofKind("external-refused")).toEqual([]);
            const lookedUp = !/wrong chain: the RPC serves/.test(r.message);
            refusalPaths[name] = {
              path: lookedUp ? "looked up on this chain: not found final; stopped, nothing recorded" : "RPC status reports another chain: stopped before any lookup, nothing recorded",
              message: r.message,
              fee: lookedUp
                ? "none on this chain (the transaction exists only on the other chain)"
                : "not recorded at the refusal (nothing is looked up through an RPC that reports another chain); the same handoff then imports against the intent's chain and its fee is charged once there",
            };
          } else {
            const refused = l.ofKind("external-refused");
            expect(refused.length).toBe(1);
            expect((refused[0]?.data.problems as string[]).join("; ")).toMatch(refusalTags[name]);
            // A found transaction's actual fee is recorded; charged only when the owner paid it.
            const f = refusedFee(l);
            const payer = name === "wrong-signer" ? world.relayer.id : ownerR.id;
            const fee = await burnt(f.tx_hash, payer);
            expect([f.payer, f.charged, f.fee_yocto]).toEqual([payer, payer === ownerR.id, fee.toString()]);
            expect(totals(l).refused_fee_yocto).toBe(payer === ownerR.id ? fee : 0n);
            refusalPaths[name] = { path: "looked up and found final on this chain, then refused by the transaction check; recorded as external-refused", problems: refused[0]?.data.problems, message: r.message, ...f };
          }
          expect(r.evidence?.assertions.some((a) => a.id.startsWith("step-1") && a.passed)).toBe(false);
          if (name === "wrong-chain-status") {
            lying.armed = false;
            // Nothing was recorded, so the same handoff imports once the runner reads the intent's chain.
            const file = writeJson(dir, "status-handoff.json", statusHandoff.h);
            const again = await resume(path, {}, { MANDATE_LIVE_HANDOFF: file });
            expect([again.exitCode, again.message]).toEqual([0, "completed"]);
            expect(ledgerOf(path).ofKind("external-handoff").length).toBe(1);
          }
        });
      }
    } finally {
      await other.stop();
    }
  }, 600_000);
});

/** SANDBOX DOUBLE: while armed, `status` reports another chain id and genesis hash. */
class OtherChainStatus extends JsonRpcProvider {
  armed = false;
  override async viewNodeStatus(): ReturnType<JsonRpcProvider["viewNodeStatus"]> {
    const status = await super.viewNodeStatus();
    return this.armed ? { ...status, chain_id: "other-chain", genesis_hash: "11111111111111111111111111111111" } : status;
  }
}

/** The specific reason each refusal must report (pinned: a refusal for another reason does not count). */
const refusalTags = {
  "wrong-chain": /not found final/,
  "wrong-chain-status": /wrong chain: the RPC serves other-chain\/1{32}, the intent is for .*nothing recorded/,
  "wrong-signer": /wrong signer/,
  "wrong-key": /wrong key/,
  "wrong-receiver": /wrong receiver/,
  "wrong-method": /wrong method/,
  "altered-args": /altered args/,
  "gas-below-bounds": /gas out of bounds/,
  "gas-above-bounds": /gas out of bounds/,
  "deposit-out-of-bounds": /deposit out of bounds/,
  "extra-action": /extra or missing action/,
} as const;

/** Transport that loses the next transaction lookup (the import's or the reconcile's). */
class BlindLookup extends JsonRpcProvider {
  blindNext = false;
  override async viewTransactionStatusWithReceipts(params: Parameters<JsonRpcProvider["viewTransactionStatusWithReceipts"]>[0]): ReturnType<JsonRpcProvider["viewTransactionStatusWithReceipts"]> {
    if (this.blindNext) {
      this.blindNext = false;
      throw new Error("request timed out (simulated lost response)");
    }
    return super.viewTransactionStatusWithReceipts(params);
  }
}

/** Transport that crashes the first balance read after a transaction lookup: a crash inside an import's verification. */
class CrashAfterLookup extends JsonRpcProvider {
  armed = false;
  private looked = false;
  override async viewTransactionStatusWithReceipts(params: Parameters<JsonRpcProvider["viewTransactionStatusWithReceipts"]>[0]): ReturnType<JsonRpcProvider["viewTransactionStatusWithReceipts"]> {
    const r = await super.viewTransactionStatusWithReceipts(params);
    if (this.armed) this.looked = true;
    return r;
  }
  override async callFunctionRaw(params: Parameters<JsonRpcProvider["callFunctionRaw"]>[0]): ReturnType<JsonRpcProvider["callFunctionRaw"]> {
    if (this.looked && (params as { method?: string }).method === "mt_balance_of") {
      this.armed = false;
      this.looked = false;
      throw new Error("simulated crash during import verification");
    }
    return super.callFunctionRaw(params);
  }
}

/** Transport that drops the response of the n-th sent transaction (it still executes) and cannot look it up once. */
class DropSend extends JsonRpcProvider {
  dropAt: number | null = null;
  private sends = 0;
  private blind = false;
  override async sendTransactionUntil(...args: Parameters<JsonRpcProvider["sendTransactionUntil"]>): ReturnType<JsonRpcProvider["sendTransactionUntil"]> {
    this.sends += 1;
    if (this.sends === this.dropAt) {
      this.blind = true;
      await super.sendTransactionAsync(args[0]);
      throw new Error("socket hang up (simulated transport loss)");
    }
    return super.sendTransactionUntil(...args);
  }
  override async viewTransactionStatusWithReceipts(params: Parameters<JsonRpcProvider["viewTransactionStatusWithReceipts"]>[0]): ReturnType<JsonRpcProvider["viewTransactionStatusWithReceipts"]> {
    if (this.blind) throw new Error("request timed out (simulated)");
    return super.viewTransactionStatusWithReceipts(params);
  }
}

describe("resume and unrecorded owner transactions", () => {
  // gate: HANDOFF
  it("a lost import lookup and a crash inside an import resume without a second signature, import or fee", async () => {
    const ownerL = await net.createAccount("ownerl");
    const ml = await deployMandate("ml", ownerL);
    await fund(ml.id, 3n * USDC, 1n * WNEAR);
    const nonceBefore = (await ownerNonce(ownerL.id, ml.owner.key)) ?? 0n;
    const m: LiveManifest = { ...ml.manifest, steps: [{ kind: "recover_external", asset: "usdc" }, { kind: "recover_external", asset: "wnear" }] };
    const path = pathOf(m, "lost-import");
    let signatures = 0;
    const counting = async (intent: ExternalIntent) => {
      signatures += 1;
      return handoff(intent, await sign(intent, ml.owner.account));
    };
    await cases.lost.check("import-lookup-lost", async () => {
      const blind = new BlindLookup({ url: world.client.rpcUrl });
      blind.blindNext = true;
      const got: { first: ExternalHandoff | null } = { first: null };
      const r = await live(path, { client: new NearClient(world.client.rpcUrl, blind), handoff: async (i) => (got.first = await counting(i)) });
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(/step 1 recover_external: transaction \S+ is not found final .*nothing recorded/);
      const l = ledgerOf(path);
      expect([l.ofKind("external-handoff").length, l.ofKind("tx-result").length, l.ofKind("external-refused").length]).toEqual([0, 0, 0]);
      // The console writes the handoff file next to the intent; the resume imports it without asking the owner again.
      const rec = l.ofKind("external-intent")[0];
      if (got.first === null || rec === undefined) throw new Error("no handoff");
      writeFileSync(join(l.dir, String(rec.data.handoff_file)), JSON.stringify(got.first));
      const crash = new CrashAfterLookup({ url: world.client.rpcUrl });
      crash.armed = true;
      const r2 = await resume(path, { client: new NearClient(world.client.rpcUrl, crash), handoff: counting });
      expect(r2.exitCode).toBe(1);
      expect(r2.message).toMatch(/simulated crash during import verification/);
      expect(signatures).toBe(1);
    });
    await cases.lost.check("import-crash-after-handoff", async () => {
      const mid = ledgerOf(path);
      // Accepted and charged once, not yet verified.
      expect(mid.ofKind("external-handoff").length).toBe(1);
      expect(mid.ofKind("tx-result").filter((e) => e.data.imported === true).length).toBe(1);
      expect(mid.ofKind("step-done")).toEqual([]);
      const r3 = await resume(path, { handoff: counting });
      expect(r3.message).toBe("completed");
      expect(r3.exitCode).toBe(0);
      const l = ledgerOf(path);
      expect(signatures).toBe(2); // one per intent
      expect(kinds(l, "external-handoff")).toEqual(["recover_external", "recover_external"]);
      // The reconciled import reused its recorded result: one tx-result per hash, no reconciled duplicate.
      const hashes = l.entries.filter((e) => e.kind === "tx-result" || e.kind === "reconciled").map((e) => e.data.tx_hash);
      expect(new Set(hashes).size).toBe(hashes.length);
      const t = totals(l);
      expect(t.transactions).toBe(2);
      expect(t.fee_yocto).toBe(actualFees(l));
      expect(await balances(world, ml.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(await ownerNonce(ownerL.id, ml.owner.key)).toBe(nonceBefore + 2n);
    });
  }, 300_000);

  // gate: HANDOFF
  it("an owner transaction the ledger does not record stops the import and the resume", async () => {
    const ownerU = await net.createAccount("owneru");
    const mu = await deployMandate("mu", ownerU);
    const m: LiveManifest = { ...mu.manifest, steps: [{ kind: "recover_external", asset: "usdc" }] };
    const stray = () => finalClient.send("unrelated owner transaction (TEST)", mu.owner.account, world.relayer.id, [actions.transfer(1n)], "transfer");
    await cases.unrecorded.check("during-import", async () => {
      const path = pathOf(m, "unrecorded-during");
      const r = await live(path, {
        handoff: async (intent) => {
          requireSuccess(await stray());
          return handoff(intent, await sign(intent, mu.owner.account));
        },
      });
      expect([r.exitCode, r.message, (r.preflight ?? []).filter((c) => !c.passed)]).toEqual([1, expect.stringMatching(/refused: unrecorded owner transaction/), []]);
      const l = ledgerOf(path);
      expect([l.ofKind("external-handoff").length, l.ofKind("tx-result").length, l.ofKind("step-done").length, l.ofKind("external-refused").length]).toEqual([0, 0, 0, 1]);
    });
    await cases.unrecorded.check("while-awaiting-then-resume", async () => {
      await settleFinal();
      const path = pathOf(m, "unrecorded-awaiting");
      const r = await live(path);
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(/awaiting the owner's signature/);
      const awaiting = r.awaiting;
      if (awaiting === undefined) throw new Error("not awaiting");
      expect(existsSync(awaiting.intent_path)).toBe(true);
      const intent = ExternalIntent.parse(JSON.parse(readFileSync(awaiting.intent_path, "utf8")));
      expect(await intentSha256(intent)).toBe(awaiting.intent_sha256);
      requireSuccess(await stray());
      writeFileSync(awaiting.handoff_path, JSON.stringify(await handoff(intent, await sign(intent, mu.owner.account))));
      // The resume imports the waiting handoff first: its nonce shows the stray transaction, so it is refused.
      const r2 = await resume(path);
      expect(r2.exitCode).toBe(1);
      expect(r2.message).toMatch(/refused: unrecorded owner transaction/);
      expect(ledgerOf(path).ofKind("external-handoff")).toEqual([]);
      // Any further resume stops at the nonce check: two owner transactions exist that the ledger does not record.
      const r3 = await resume(path);
      expect(r3.exitCode).toBe(2);
      expect(r3.message).toMatch(/owner key nonce on chain is \d+, ledger expects \d+; transactions exist that the ledger does not record/);
      expect(ledgerOf(path).ofKind("external-handoff")).toEqual([]);
    });
  }, 300_000);
});

/**
 * SANDBOX DOUBLE transport: once armed, runs `before` ahead of the first read of `account`'s Intents balances, i.e. while
 * the runner plans a recovery step, after preflight and before that step's transaction is signed.
 */
class BeforeBalanceRead extends JsonRpcProvider {
  before: (() => Promise<void>) | null = null;
  constructor(
    url: string,
    private readonly account: string,
  ) {
    super({ url });
  }
  override async callFunctionRaw(params: Parameters<JsonRpcProvider["callFunctionRaw"]>[0]): ReturnType<JsonRpcProvider["callFunctionRaw"]> {
    const p = params as { method?: string; args?: { account_id?: string } };
    const run = this.before;
    if (run !== null && p.method === "mt_balance_of" && p.args?.account_id === this.account) {
      this.before = null;
      await run();
    }
    return super.callFunctionRaw(params);
  }
}

const sends = (calls: { method: string }[]) => calls.filter((c) => ["send_tx", "broadcast_tx_async", "broadcast_tx_commit"].includes(c.method));

describe("owner transactions the ledger does not record, by any key of the owner account", () => {
  // gate: HANDOFF
  it("a stray owner transaction before a runner-signed owner step stops the run before it signs; the import never happens", async () => {
    const ownerS = await net.createAccount("owners");
    const ms = await deployMandate("ms", ownerS);
    const m: LiveManifest = { ...ms.manifest, steps: [{ kind: "recover", asset: "usdc" }, { kind: "recover_external", asset: "wnear" }] };
    const path = pathOf(m, "stray-runner-step");
    const hook = new BeforeBalanceRead(world.client.rpcUrl, ownerS.id);
    const rpc = recordRpc(hook);
    hook.before = async () => {
      requireSuccess(await finalClient.send("stray owner transaction (TEST)", ms.owner.account, world.relayer.id, [actions.transfer(1n)], "transfer"));
    };
    let signatures = 0;
    const r = await live(path, {
      client: new NearClient(world.client.rpcUrl, hook),
      handoff: async (intent) => {
        signatures += 1;
        return handoff(intent, await sign(intent, ms.owner.account));
      },
    });
    await cases.unrecorded.check("stray-then-runner-owner-step", async () => {
      expect(hook.before).toBeNull();
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(/^step 1 recover: unrecorded owner transaction: owner key nonce on chain is \d+, ledger expects \d+; nothing was sent$/);
      const l = ledgerOf(path);
      expect([l.ofKind("tx-intent").length, l.ofKind("external-intent").length, l.ofKind("external-handoff").length, l.ofKind("step-done").length]).toEqual([0, 0, 0, 0]);
      expect(sends(rpc)).toEqual([]);
      expect(signatures).toBe(0);
      const again = await resume(path);
      expect(again.exitCode).toBe(2);
      expect(again.message).toMatch(/cannot resume: owner key nonce on chain is \d+, ledger expects \d+/);
    });
  }, 300_000);

  // gate: HANDOFF
  it("a stray transaction by another full-access key of the owner stops the import; an added key stops the runner's send, the resume and a fresh start", async () => {
    const ownerK = await net.createAccount("ownerk");
    const mk = await deployMandate("mk", ownerK);
    // A second full-access key of the owner account: listed in the snapshot, never tracked by the ledger.
    const k2 = KeyPair.fromRandom("ed25519");
    requireSuccess(await finalClient.send("add second owner key (TEST)", mk.owner.account, ownerK.id, [actions.addFullAccessKey(k2.getPublicKey())], "add_key"));
    const second = finalClient.account(ownerK.id, k2);
    const k2Nonce = async () => (await ownerNonce(ownerK.id, k2)) ?? -1n;

    await cases.unrecorded.check("extra-owner-key-stray", async () => {
      await settleFinal();
      const path = pathOf({ ...mk.manifest, steps: [{ kind: "recover_external", asset: "usdc" }] }, "extra-key-stray");
      const before = await k2Nonce();
      let signed = "";
      const r = await live(path, {
        handoff: async (intent) => {
          signed = await sign(intent, mk.owner.account);
          requireSuccess(await finalClient.send("stray transaction by the second owner key (TEST)", second, world.relayer.id, [actions.transfer(1n)], "transfer"));
          return handoff(intent, signed);
        },
      });
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(new RegExp(`refused: unrecorded owner transaction: nonce of ${k2.getPublicKey().toString()}, a key the ledger does not track, changed from ${before} to ${before + 1n}`));
      const l = ledgerOf(path);
      expect([l.ofKind("external-handoff").length, l.ofKind("tx-result").length, l.ofKind("step-done").length, l.ofKind("external-refused").length]).toEqual([0, 0, 0, 1]);
      // The refused transaction was the owner's: its fee is charged once.
      const f = refusedFee(l);
      expect([f.tx_hash, f.charged, f.fee_yocto]).toEqual([signed, true, (await burnt(signed, ownerK.id)).toString()]);
      const again = await resume(path);
      expect(again.exitCode).toBe(2);
    });

    await cases.unrecorded.check("owner-key-added", async () => {
      await settleFinal();
      const path = pathOf({ ...mk.manifest, steps: [{ kind: "recover", asset: "usdc" }] }, "key-added");
      const approved = ownerKeySnapshot(await finalClient.accessKeys(ownerK.id));
      const k3 = KeyPair.fromRandom("ed25519");
      const hook = new BeforeBalanceRead(world.client.rpcUrl, ownerK.id);
      const rpc = recordRpc(hook);
      hook.before = async () => {
        requireSuccess(await finalClient.send("add a key with the second owner key (TEST)", second, ownerK.id, [actions.addFullAccessKey(k3.getPublicKey())], "add_key"));
      };
      const r = await live(path, { client: new NearClient(world.client.rpcUrl, hook) });
      expect(hook.before).toBeNull();
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(new RegExp(`^step 1 recover: unrecorded owner transaction: key added: ${k3.getPublicKey().toString()} .*; nonce of ${k2.getPublicKey().toString()}, a key the ledger does not track, changed`));
      expect(sends(rpc)).toEqual([]);
      expect(ledgerOf(path).ofKind("tx-intent")).toEqual([]);
      const again = await resume(path);
      expect(again.exitCode).toBe(2);
      expect(again.message).toMatch(new RegExp(`cannot resume: the owner account's access keys differ from the run's start snapshot \\(key added: ${k3.getPublicKey().toString()}`));
      // A fresh start against the approval-time list refuses at preflight; against the current list it passes.
      await settleFinal();
      const fresh = await live(pathOf({ ...mk.manifest, expected_owner_keys: approved, steps: [{ kind: "check" }] }, "key-added-fresh"));
      expect(fresh.exitCode).toBe(2);
      expect((fresh.preflight ?? []).filter((c) => !c.passed).map((c) => c.id)).toEqual(["keys.owner_key_set_since_approval"]);
      const current = ownerKeySnapshot(await finalClient.accessKeys(ownerK.id));
      const ok = await live(pathOf({ ...mk.manifest, expected_owner_keys: current, steps: [{ kind: "check" }] }, "key-current-fresh"));
      expect([ok.exitCode, ok.message]).toEqual([0, "completed"]);
    });
  }, 300_000);
});

/**
 * SANDBOX DOUBLE transport: runs `stray` once, ahead of the first view query after the provider's first broadcast, i.e.
 * while the runner verifies the last step of a one-transaction run, after which it sends nothing.
 */
function strayAfterFirstSend(provider: object, stray: () => Promise<void>): { fired: boolean } {
  const state = { sent: false, fired: false };
  const target = provider as unknown as { sendJsonRpc: (method: string, params: unknown) => Promise<unknown> };
  const original = target.sendJsonRpc.bind(provider);
  target.sendJsonRpc = async (method: string, params: unknown) => {
    if (["send_tx", "broadcast_tx_async", "broadcast_tx_commit"].includes(method)) state.sent = true;
    else if (state.sent && !state.fired && method === "query") {
      state.fired = true;
      await stray();
    }
    return original(method, params);
  };
  return state;
}

describe("an owner transaction after the last step", () => {
  // gate: HANDOFF
  it("is found by the closing check: the run stops with a finding instead of reporting completed", async () => {
    const ownerZ = await net.createAccount("ownerz");
    const mz = await deployMandate("mz", ownerZ);
    await fund(mz.id, 1n * USDC, 0n);
    const path = pathOf({ ...mz.manifest, steps: [{ kind: "recover", asset: "usdc" }] }, "stray-after-last");
    const provider = new JsonRpcProvider({ url: world.client.rpcUrl });
    const rpc = recordRpc(provider);
    const hook = strayAfterFirstSend(provider, async () => {
      requireSuccess(await finalClient.send("stray owner transaction after the last send (TEST)", mz.owner.account, world.relayer.id, [actions.transfer(1n)], "transfer"));
    });
    const r = await live(path, { client: new NearClient(world.client.rpcUrl, provider) });
    await cases.unrecorded.check("stray-after-last-step", () => {
      expect(hook.fired).toBe(true);
      // The last step itself ran and verified: only the closing check can see the stray transaction.
      expect(sends(rpc).length).toBe(1);
      const l = ledgerOf(path);
      expect(l.ofKind("step-done").map((e) => [e.data.step, e.data.kind, e.data.finding ?? null])).toEqual([[0, "recover", null]]);
      expect(r.exitCode).toBe(1);
      expect(r.message).not.toMatch(/completed/);
      expect(r.message).toMatch(/^unrecorded owner transaction after the last step: owner key nonce on chain is (\d+), ledger expects (\d+); transactions exist that the ledger does not record$/);
      const [, chain, want] = /nonce on chain is (\d+), ledger expects (\d+)/.exec(r.message) ?? [];
      expect(BigInt(chain ?? "0") - BigInt(want ?? "0")).toBe(1n);
      expect(l.entries.at(-1)?.kind).toBe("stopped");
      expect(l.entries.at(-1)?.data.reason).toBe(r.message);
      expect(r.evidence?.unknowns).toEqual([`run stopped: ${r.message}`]);
    });
  }, 300_000);
});

/** SANDBOX DOUBLE: while armed, storage_balance_of reports `owner` registered on `token` although it is not. */
class LieRegistered extends JsonRpcProvider {
  armed = true;
  constructor(
    url: string,
    private readonly token: string,
    private readonly owner: string,
  ) {
    super({ url });
  }
  override async callFunctionRaw(params: Parameters<JsonRpcProvider["callFunctionRaw"]>[0]): ReturnType<JsonRpcProvider["callFunctionRaw"]> {
    const p = params as { contractId?: string; method?: string; args?: { account_id?: string } };
    const raw = await super.callFunctionRaw(params);
    if (this.armed && p.contractId === this.token && p.method === "storage_balance_of" && p.args?.account_id === this.owner) {
      return { ...raw, result: [...Buffer.from(JSON.stringify({ total: "1250000000000000000000", available: "0" }))] };
    }
    return raw;
  }
}

describe("owner withdrawals (runner-signed)", () => {
  const steps: LiveManifest["steps"] = [
    { kind: "recover", asset: "usdc" },
    { kind: "recover", asset: "wnear" },
    { kind: "register_storage", asset: "usdc" },
    { kind: "register_storage", asset: "wnear" },
    { kind: "withdraw", asset: "usdc" },
    { kind: "withdraw", asset: "wnear" },
  ];
  const nearSide = async (owner: string) => ({ usdc: await tokens("usdc").balance(owner), wnear: await tokens("wnear").balance(owner) });
  const doneOf = (l: Ledger, step: number) => l.ofKind("step-done").filter((e) => e.data.step === step);

  // gate: WITHDRAW
  it("withdraws both assets to a registered owner's NEAR account; registration is skipped where present", async () => {
    const mw = await deployMandate("mw", world.owner);
    await fund(mw.id, 4n * USDC, 3n * WNEAR);
    const tokenBefore = await nearSide(world.owner.id);
    const intentsBefore = await balances(world, world.owner.id);
    const path = pathOf({ ...mw.manifest, steps }, "withdraw-registered");
    const r = await live(path);
    await cases.both.check("registered-owner-runner-signed", async () => {
      expect(r.message).toBe("completed");
      const l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual(["recover", "recover", "withdraw", "withdraw"]);
      for (const s of [2, 3]) expect(doneOf(l, s)[0]?.data).toMatchObject({ skipped: true, reason: expect.stringMatching(/already registered/) as unknown });
      const tokenAfter = await nearSide(world.owner.id);
      expect([tokenAfter.usdc - tokenBefore.usdc, tokenAfter.wnear - tokenBefore.wnear]).toEqual([4n * USDC, 3n * WNEAR]);
      // Recovered into the owner's Intents account, then withdrawn out of it: the Intents balance is back where it was.
      expect(await balances(world, world.owner.id)).toEqual(intentsBefore);
      for (const s of [4, 5]) expect(doneOf(l, s)[0]?.data).toMatchObject({ classification: "withdrawn" });
      expect(doneOf(l, 4)[0]?.data.withdrawn).toBe((4n * USDC).toString());
      expect(totals(l).fee_yocto).toBe(actualFees(l));
      expect(totals(l).deposit_yocto).toBe(2n);
    });
  }, 300_000);

  // gate: WITHDRAW
  it("registers an unregistered owner on each token first, with the minimum storage deposit, then withdraws", async () => {
    const ownerN = await net.createAccount("ownern");
    const mn = await deployMandate("mn", ownerN);
    await fund(mn.id, 2n * USDC, 1n * WNEAR);
    expect([await tokens("usdc").isRegistered(ownerN.id), await tokens("wnear").isRegistered(ownerN.id)]).toEqual([false, false]);
    const path = pathOf({ ...mn.manifest, steps }, "withdraw-unregistered");
    const r = await live(path);
    await cases.unregistered.check("registers-only-where-needed", async () => {
      expect(r.message).toBe("completed");
      const l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual(["recover", "recover", "register_storage", "register_storage", "withdraw", "withdraw"]);
      const min = await tokens("usdc").storageMin();
      for (const e of l.ofKind("tx-intent").filter((x) => x.data.kind === "register_storage")) expect((e.data.detail as { deposit_yocto: string }).deposit_yocto).toBe(min.toString());
      expect([await tokens("usdc").isRegistered(ownerN.id), await tokens("wnear").isRegistered(ownerN.id)]).toEqual([true, true]);
      expect(await nearSide(ownerN.id)).toEqual({ usdc: 2n * USDC, wnear: 1n * WNEAR });
      expect(await balances(world, ownerN.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(totals(l).deposit_yocto).toBe(2n * min + 2n);
    });
  }, 300_000);

  // gate: WITHDRAW
  it("a refunded withdrawal leaves the Intents balance intact; the other asset completes; the resume retries it once without double counting", async () => {
    const ownerF = await net.createAccount("ownerf");
    const mf = await deployMandate("mf", ownerF);
    await fund(mf.id, 2n * USDC, 1n * WNEAR);
    const path = pathOf({ ...mf.manifest, steps }, "withdraw-refund");
    const lie = new LieRegistered(world.client.rpcUrl, world.tokens.usdc, ownerF.id);
    const r = await live(path, { client: new NearClient(world.client.rpcUrl, lie) });
    await cases.retry.check("partial-failure-recorded", async () => {
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(/completed with findings: step 5 withdraw: the token transfer failed and the verifier refunded 2000000 usdc; the Intents balance is intact/);
      const l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual(["recover", "recover", "register_storage", "withdraw", "withdraw"]);
      expect(doneOf(l, 4)[0]?.data).toMatchObject({ classification: "refunded", retryable: true, withdrawn: "0" });
      expect(doneOf(l, 5)[0]?.data).toMatchObject({ classification: "withdrawn" });
      // The failed receipt is the token's; the verifier refunded: Intents USDC intact, nothing arrived.
      const refunded = r.evidence?.receipts.find((x) => (x.detail as { method?: string; asset?: string }).method === "ft_withdraw" && (x.detail as { asset?: string }).asset === "usdc");
      expect(refunded?.outcome).toBe("failure");
      expect((refunded?.detail as { receipts: { executor_id: string; success: boolean }[] }).receipts.filter((x) => !x.success).map((x) => x.executor_id)).toEqual([world.tokens.usdc]);
      expect(await balances(world, ownerF.id)).toEqual({ usdc: 2n * USDC, wnear: 0n });
      expect(await nearSide(ownerF.id)).toEqual({ usdc: 0n, wnear: 1n * WNEAR });
    });
    await cases.retry.check("retry-without-double-count", async () => {
      const r2 = await resume(path);
      expect(r2.message).toBe("completed");
      expect(r2.exitCode).toBe(0);
      const l = ledgerOf(path);
      // Retry: the USDC registration (now honestly missing) and the USDC withdrawal; wNEAR is not repeated.
      expect(kinds(l, "tx-intent")).toEqual(["recover", "recover", "register_storage", "withdraw", "withdraw", "register_storage", "withdraw"]);
      expect(l.ofKind("tx-intent").at(-1)?.data).toMatchObject({ step: 4, attempt: 2 });
      expect(doneOf(l, 4).map((e) => [e.data.classification, e.data.withdrawn])).toEqual([
        ["refunded", "0"],
        ["withdrawn", (2n * USDC).toString()],
      ]);
      expect(doneOf(l, 5).length).toBe(1);
      expect(await nearSide(ownerF.id)).toEqual({ usdc: 2n * USDC, wnear: 1n * WNEAR });
      expect(await balances(world, ownerF.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(totals(l).fee_yocto).toBe(actualFees(l));
      const ids = r2.evidence?.assertions.filter((a) => a.id.startsWith("step-5-withdraw")).map((a) => [a.id, a.passed]);
      expect(ids).toEqual([
        ["step-5-withdraw", false],
        ["step-5-withdraw-attempt-2", true],
      ]);
      // A further resume finds nothing to retry and sends nothing.
      const r3 = await resume(path);
      expect(r3.exitCode).toBe(0);
      expect(ledgerOf(path).ofKind("tx-intent").length).toBe(7);
    });
  }, 300_000);

  // gate: HANDOFF
  it("a lost runner-signed withdrawal response is reconciled on resume: no second withdrawal, no double fee", async () => {
    const mw2 = await deployMandate("mw2", world.owner);
    await fund(mw2.id, 3n * USDC, 2n * WNEAR);
    const tokenBefore = await nearSide(world.owner.id);
    const drop = new DropSend({ url: world.client.rpcUrl });
    drop.dropAt = 3; // recover, recover, withdraw usdc (registrations are skipped for this owner)
    const path = pathOf({ ...mw2.manifest, steps }, "withdraw-lost");
    const rpc = recordRpc(drop);
    const r = await live(path, { client: new NearClient(world.client.rpcUrl, drop) });
    await cases.lost.check("runner-withdrawal-lost", async () => {
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(/step 5 withdraw: ambiguous outcome/);
      const resumed = await resume(path);
      expect(resumed.message).toBe("completed");
      const l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual(["recover", "recover", "withdraw", "withdraw"]);
      expect(l.ofKind("reconciled").map((e) => e.data.step)).toEqual([4]);
      expect(rpc.filter((c) => c.method === "send_tx" || c.method === "broadcast_tx_async").length).toBe(3);
      const tokenAfter = await nearSide(world.owner.id);
      expect([tokenAfter.usdc - tokenBefore.usdc, tokenAfter.wnear - tokenBefore.wnear]).toEqual([3n * USDC, 2n * WNEAR]);
      expect(totals(l).transactions).toBe(4);
      expect(totals(l).fee_yocto).toBe(actualFees(l));
    });
  }, 300_000);
});

describe("owner withdrawals signed outside the runner (withdraw_external)", () => {
  const nearSide = async (owner: string) => ({ usdc: await tokens("usdc").balance(owner), wnear: await tokens("wnear").balance(owner) });
  const doneOf = (l: Ledger, step: number) => l.ofKind("step-done").filter((e) => e.data.step === step);
  const register = async (owner: string, asset: Asset) => {
    // Setup outside the runner, paid by another account: not an owner transaction.
    requireSuccess(await finalClient.call(`setup: register ${owner} on ${asset}`, world.owner.account, world.tokens[asset], "storage_deposit", { account_id: owner, registration_only: true }, { gas: 30n * TGAS, deposit: NEAR / 100n }));
  };

  // gate: WITHDRAW
  it("an unregistered owner: registered where a step asks for it, otherwise nothing is signed until a resume finds it registered", async () => {
    const ownerE = await net.createAccount("ownere");
    const me = await deployMandate("me", ownerE);
    await fund(me.id, 2n * USDC, 1n * WNEAR);
    const steps: LiveManifest["steps"] = [
      { kind: "recover", asset: "usdc" },
      { kind: "recover", asset: "wnear" },
      { kind: "register_storage", asset: "usdc" },
      { kind: "withdraw_external", asset: "usdc" },
      { kind: "withdraw_external", asset: "wnear" },
    ];
    const path = pathOf({ ...me.manifest, steps }, "external-unregistered");
    let signatures = 0;
    const counting = async (intent: ExternalIntent) => {
      signatures += 1;
      return handoff(intent, await sign(intent, me.owner.account));
    };
    await cases.unregistered.check("external-withdrawal-unregistered-owner", async () => {
      expect([await tokens("usdc").isRegistered(ownerE.id), await tokens("wnear").isRegistered(ownerE.id)]).toEqual([false, false]);
      const r = await live(path, { handoff: counting });
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(new RegExp(`completed with findings: step 5 withdraw_external: ${ownerE.id} is not registered on ${world.tokens.wnear}; the transfer would be refunded, nothing sent`));
      let l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual(["recover", "recover", "register_storage"]);
      // USDC: registered by step 3, then signed outside the runner and imported. wNEAR: no intent, nothing signed.
      expect(l.ofKind("external-intent").map((e) => [e.data.step, e.data.attempt])).toEqual([[3, 1]]);
      expect(signatures).toBe(1);
      expect(doneOf(l, 3)[0]?.data).toMatchObject({ imported: true, classification: "withdrawn", withdrawn: (2n * USDC).toString() });
      expect(doneOf(l, 4)[0]?.data).toMatchObject({ skipped: true, retryable: true, withdrawn: "0" });
      expect(await nearSide(ownerE.id)).toEqual({ usdc: 2n * USDC, wnear: 0n });
      expect(await balances(world, ownerE.id)).toEqual({ usdc: 0n, wnear: 1n * WNEAR });
      // The owner registers on wNEAR outside the run; the resume retries the withdrawal as attempt 2.
      await register(ownerE.id, "wnear");
      await settleFinal();
      const r2 = await resume(path, { handoff: counting });
      expect([r2.exitCode, r2.message]).toEqual([0, "completed"]);
      l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual(["recover", "recover", "register_storage"]);
      expect(l.ofKind("external-intent").map((e) => [e.data.step, e.data.attempt])).toEqual([
        [3, 1],
        [4, 2],
      ]);
      expect(signatures).toBe(2);
      expect(doneOf(l, 4).map((e) => [e.data.attempt, e.data.withdrawn])).toEqual([
        [1, "0"],
        [2, (1n * WNEAR).toString()],
      ]);
      expect(await nearSide(ownerE.id)).toEqual({ usdc: 2n * USDC, wnear: 1n * WNEAR });
      expect(await balances(world, ownerE.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(totals(l).fee_yocto).toBe(actualFees(l));
    });
  }, 300_000);

  // gate: WITHDRAW
  it("a refunded external withdrawal: the resume re-registers, writes an attempt-2 intent, keeps it while awaiting, then imports its handoff file", async () => {
    const ownerG = await net.createAccount("ownerg");
    const mg = await deployMandate("mg", ownerG);
    await fund(mg.id, 2n * USDC, 1n * WNEAR);
    const steps: LiveManifest["steps"] = [
      { kind: "recover", asset: "usdc" },
      { kind: "recover", asset: "wnear" },
      { kind: "register_storage", asset: "usdc" },
      { kind: "register_storage", asset: "wnear" },
      { kind: "withdraw_external", asset: "usdc" },
      { kind: "withdraw_external", asset: "wnear" },
    ];
    const path = pathOf({ ...mg.manifest, steps }, "external-refund");
    // SANDBOX DOUBLE: the USDC registration is misreported in the first session, so its transfer is refunded.
    const lie = new LieRegistered(world.client.rpcUrl, world.tokens.usdc, ownerG.id);
    const r = await live(path, { client: new NearClient(world.client.rpcUrl, lie), handoff: adapter(mg.owner.account) });
    await cases.retry.check("external-refund-retried-and-imported", async () => {
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(/completed with findings: step 5 withdraw_external: the token transfer failed and the verifier refunded 2000000 usdc; the Intents balance is intact/);
      let l = ledgerOf(path);
      expect(doneOf(l, 4)[0]?.data).toMatchObject({ imported: true, classification: "refunded", retryable: true, withdrawn: "0", attempt: 1 });
      expect(doneOf(l, 5)[0]?.data).toMatchObject({ imported: true, classification: "withdrawn" });
      expect(await balances(world, ownerG.id)).toEqual({ usdc: 2n * USDC, wnear: 0n });
      const firstSession = kinds(l, "tx-intent");
      expect(firstSession).toEqual(["recover", "recover", "register_storage"]);

      // Resume 1 (honest views, no signer): the USDC registration runs first, then the attempt-2 intent is written.
      const r2 = await resume(path);
      expect(r2.exitCode).toBe(1);
      expect(r2.awaiting).toMatchObject({ step: 5, kind: "withdraw_external", attempt: 2 });
      l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual([...firstSession, "register_storage"]);
      expect(l.ofKind("tx-intent").at(-1)?.data).toMatchObject({ step: 2, attempt: 2 });
      expect(l.ofKind("external-intent").filter((e) => e.data.step === 4).map((e) => e.data.attempt)).toEqual([1, 2]);

      // Resume 2, still unsigned: the pending attempt-2 intent is kept; registration is not run or charged again.
      const r3 = await resume(path);
      expect(r3.exitCode).toBe(1);
      expect(r3.awaiting).toEqual(r2.awaiting);
      const mid = ledgerOf(path);
      expect([mid.ofKind("tx-intent").length, mid.ofKind("external-intent").length]).toEqual([l.ofKind("tx-intent").length, l.ofKind("external-intent").length]);

      // The console signs attempt 2 and writes the handoff file next to the intent; resume 3 imports it before the
      // nonce check (importAvailable): an unimported owner transaction would otherwise refuse the resume.
      const awaiting = r2.awaiting;
      if (awaiting === undefined) throw new Error("not awaiting");
      const intent = ExternalIntent.parse(JSON.parse(readFileSync(awaiting.intent_path, "utf8")));
      writeFileSync(awaiting.handoff_path, JSON.stringify(await handoff(intent, await sign(intent, mg.owner.account))));
      const r4 = await resume(path);
      expect([r4.exitCode, r4.message]).toEqual([0, "completed"]);
      l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual([...firstSession, "register_storage"]);
      expect(doneOf(l, 4).map((e) => [e.data.attempt, e.data.classification, e.data.withdrawn])).toEqual([
        [1, "refunded", "0"],
        [2, "withdrawn", (2n * USDC).toString()],
      ]);
      expect(doneOf(l, 5).length).toBe(1);
      expect(await nearSide(ownerG.id)).toEqual({ usdc: 2n * USDC, wnear: 1n * WNEAR });
      expect(await balances(world, ownerG.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(totals(l).fee_yocto).toBe(actualFees(l));
      const ids = r4.evidence?.assertions.filter((a) => a.id.startsWith("step-5-withdraw_external")).map((a) => [a.id, a.passed]);
      expect(ids).toEqual([
        ["step-5-withdraw_external", false],
        ["step-5-withdraw_external-attempt-2", true],
      ]);
    });
  }, 300_000);

  // gate: WITHDRAW
  it("a verifier-side failure (prepaid gas too low for ft_withdraw) is classified failed, not refunded; the retry at the intent's gas bound withdraws once", async () => {
    const ownerH = await net.createAccount("ownerh");
    const mh = await deployMandate("mh", ownerH);
    await fund(mh.id, 1n * USDC, 0n);
    await register(ownerH.id, "usdc");
    await settleFinal();
    // The approved gas for ft_withdraw is deliberately too low; the intent still allows up to 20 TGas more.
    const m: LiveManifest = { ...mh.manifest, gas_tgas: { ...mh.manifest.gas_tgas, withdraw: LOW_WITHDRAW_TGAS }, steps: [{ kind: "recover", asset: "usdc" }, { kind: "withdraw_external", asset: "usdc" }] };
    const path = pathOf(m, "external-failed");
    const atBound = (bound: "gas" | "gas_max") => async (intent: ExternalIntent) =>
      handoff(intent, await sign(intent, mh.owner.account, (a) => a.map(() => actions.functionCall(intent.actions[0]?.method ?? "-", intent.actions[0]?.args ?? {}, BigInt(intent.actions[0]?.[bound] ?? "0"), BigInt(intent.actions[0]?.deposit ?? "0")))));
    const r = await live(path, { handoff: atBound("gas") });
    await cases.retry.check("verifier-failure-classified-failed", async () => {
      expect(r.exitCode).toBe(1);
      expect(r.message).toMatch(/completed with findings: step 2 withdraw_external: ft_withdraw failed on the verifier: .*; the Intents balance is intact/);
      let l = ledgerOf(path);
      const first = doneOf(l, 1)[0];
      expect(first?.data).toMatchObject({ imported: true, classification: "failed", retryable: true, withdrawn: "0" });
      const failed = (first?.data.verification as { failed_receipts: { executor_id: string }[] }).failed_receipts.map((x) => x.executor_id);
      expect(failed).toEqual([world.verifier.id]);
      expect(await balances(world, ownerH.id)).toEqual({ usdc: 1n * USDC, wnear: 0n });
      expect(await nearSide(ownerH.id)).toEqual({ usdc: 0n, wnear: 0n });
      const r2 = await resume(path, { handoff: atBound("gas_max") });
      expect([r2.exitCode, r2.message]).toEqual([0, "completed"]);
      l = ledgerOf(path);
      expect(doneOf(l, 1).map((e) => [e.data.attempt, e.data.classification, e.data.withdrawn])).toEqual([
        [1, "failed", "0"],
        [2, "withdrawn", (1n * USDC).toString()],
      ]);
      expect(await nearSide(ownerH.id)).toEqual({ usdc: 1n * USDC, wnear: 0n });
      expect(await balances(world, ownerH.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(totals(l).fee_yocto).toBe(actualFees(l));
    });
  }, 300_000);
});

/** Prepaid gas (TGas) too low for the pinned verifier's ft_withdraw in sandbox (fails at <= 35, succeeds at >= 40 when measured); 50 with the slack. */
const LOW_WITHDRAW_TGAS = 30;

describe("primary template (live agent, console-signed owner actions, withdrawals) on the exact deployment binary", () => {
  // gate: LIVE
  it("runs the whole sequence: refused and agent proposals, trade, withheld order rejected while unexpired after confirmed removal, recovery and withdrawals", async () => {
    const tpl = JSON.parse(readFileSync(join(import.meta.dirname, "../src/live/manifest.live-agent.example.json"), "utf8")) as { budget: LiveManifest["budget"]; gas_tgas: LiveManifest["gas_tgas"]; steps: unknown[] };
    const steps = LiveManifest.shape.steps.parse(tpl.steps).map((s) => (s.kind === "propose" && s.source.from === "model" ? { ...s, source: { ...s.source, model: "synthetic-never-called" } } : s));
    const ownerT = await net.createAccount("ownert");
    const mt = await deployMandate("mt", ownerT);
    // The owner signs console actions with its own key, distinct from the runner's owner key (keys.owner_external).
    const ext = sandboxKey(`${ownerT.id}/console`);
    requireSuccess(await finalClient.send("add console owner key (TEST)", mt.owner.account, ownerT.id, [actions.addFullAccessKey(ext.getPublicKey())], "add_key"));
    // Setup (outside the runner, as in the approval package): the owner is registered on both tokens.
    for (const asset of ["usdc", "wnear"] as const) {
      requireSuccess(await finalClient.call(`setup: register ${ownerT.id} on ${asset}`, world.owner.account, world.tokens[asset], "storage_deposit", { account_id: ownerT.id, registration_only: true }, { gas: 30n * TGAS, deposit: NEAR / 100n }));
    }
    await fund(mt.id, 5n * USDC, 1n * WNEAR); // ~62.5% USDC at the oracle stub's 0.9998 / 3.00
    const m: LiveManifest = {
      ...mt.manifest,
      keys: { ...mt.manifest.keys, owner_external: { public_key: ext.getPublicKey().toString() } },
      gas_tgas: tpl.gas_tgas,
      // The template's caps, except the filler's wNEAR cap: sandbox prices wNEAR at $3, not the mainnet price.
      budget: { ...tpl.budget, filler_spend_max: { usdc: "0", wnear: (10n ** 24n).toString() } },
      steps,
    };
    const provider = new SyntheticProvider(proposeJson("usdc", 500_000n));
    const path = pathOf(m, "agent-template");
    const consoleAccount = finalClient.account(ownerT.id, ext);
    const r = await live(path, { modelProvider: provider, handoff: adapter(consoleAccount) });
    await cases.template.check("primary-template-sequence", async () => {
      expect(r.message).toBe("completed");
      expect(r.exitCode).toBe(0);
      const ids = (r.evidence?.assertions ?? []).filter((a) => a.id.startsWith("step-"));
      expect(ids.map((a) => a.id)).toEqual(steps.map((s, i) => `step-${i + 1}-${s.kind}`));
      expect(ids.every((a) => a.passed)).toBe(true);
      expect(provider.calls).toBe(1);
      const l = ledgerOf(path);
      expect(kinds(l, "tx-intent")).toEqual(["grant", "refused_proposal", "propose", "fill", "settle", "propose", "relay_withheld"]);
      for (const step of [12, 13]) expect(l.ofKind("step-done").find((e) => e.data.step === step)?.data).toMatchObject({ kind: "register_storage", skipped: true });
      expect(kinds(l, "external-intent")).toEqual(["revoke_external", "recover_external", "recover_external", "withdraw_external", "withdraw_external"]);
      expect(l.ofKind("external-handoff").every((e) => e.data.public_key === ext.getPublicKey().toString())).toBe(true);
      expect(l.ofKind("external-refused")).toEqual([]);
      // The withheld order: rejected for the removed key, before its deadline, with lifetime left at the broadcast.
      const relay = ids.find((a) => a.id.endsWith("relay_withheld"))?.observed as { classification: string; timing: { phases: { phase: string; remaining_ms: number | null }[] } };
      expect(relay.classification).toBe("rejected_revoked_key");
      const broadcast = relay.timing.phases.find((p) => p.phase === "relay broadcast");
      expect(broadcast?.remaining_ms ?? 0).toBeGreaterThan(0);
      expect(relay.timing.phases.map((p) => p.phase)).toContain("revoke intent written (owner signs outside the runner)");
      // What revocation bought, by chain time, recomputed from the recorded timestamps and the order's own view.
      const windowOf = (relay.timing as unknown as { revocation_window: Record<string, string | number | null> }).revocation_window;
      const withheldOrder = (await new MandateClient(world.client, mt.id).allOrders()).find((o) => o.id === windowOf.order_id);
      expect(windowOf).toMatchObject({ deadline_ns: withheldOrder?.deadline_ns, signed_at_ns: withheldOrder?.signed_at_ns, sign_requested_at_ns: withheldOrder?.sign_requested_at_ns, expired_when_read: false });
      const nsToMs = (later: unknown, earlier: unknown) => Number((BigInt(String(later)) - BigInt(String(earlier))) / 1_000_000n);
      expect(windowOf.remaining_after_confirmed_removal_ms).toBe(nsToMs(windowOf.deadline_ns, windowOf.read_after_confirmed_removal_ns));
      expect(windowOf.remaining_after_confirmed_removal_ns).toBe((BigInt(String(windowOf.deadline_ns)) - BigInt(String(windowOf.read_after_confirmed_removal_ns))).toString());
      expect(windowOf.sign_request_to_signed_ms).toBe(nsToMs(windowOf.signed_at_ns, windowOf.sign_requested_at_ns));
      expect(windowOf.signed_to_deadline_ms).toBe(nsToMs(windowOf.deadline_ns, windowOf.signed_at_ns));
      expect(Number(windowOf.remaining_after_confirmed_removal_ms)).toBeGreaterThan((broadcast?.remaining_ms ?? 0) - 1);
      expect(Number(windowOf.remaining_after_confirmed_removal_ms)).toBeLessThan(Number(windowOf.signed_to_deadline_ms));
      // Agent trade made and settled: one released:settled order besides the refused proposal's absence and the withheld order.
      const orders = await new MandateClient(world.client, mt.id).allOrders();
      expect(orders.map((o) => o.state)).toEqual([
        { state: "released", reason: "settled" },
        { state: "released", reason: "key_removed" },
      ]);
      // Recovery, then registration and withdrawal of both assets to the owner's NEAR account.
      expect(await balances(world, mt.id)).toEqual({ usdc: 0n, wnear: 0n });
      expect(await balances(world, ownerT.id)).toEqual({ usdc: 0n, wnear: 0n });
      const recovered = (asset: Asset) =>
        l.ofKind("step-done").filter((e) => e.data.kind === "recover_external").map((e) => e.data.verification as { asset: string; gained: string }).find((v) => v.asset === asset)?.gained;
      expect(await tokens("usdc").balance(ownerT.id)).toBe(BigInt(recovered("usdc") ?? "-1"));
      expect(await tokens("wnear").balance(ownerT.id)).toBe(BigInt(recovered("wnear") ?? "-1"));
      // The agent's 0.5 USDC sale executed; the withheld 0.5 USDC order never did.
      expect(BigInt(recovered("usdc") ?? "0")).toBe(5n * USDC - 500_000n);
      const t = totals(l);
      expect(t.transactions).toBe(12);
      expect(t.deposit_yocto).toBe(2n);
      expect(t.fee_yocto).toBe(actualFees(l));
      expect(t.fee_yocto <= BigInt(m.budget.max_fee_yocto) && t.deposit_yocto <= BigInt(m.budget.max_deposit_yocto)).toBe(true);
      // A resume of the finished run checks both owner keys' nonces against runner-signed and imported transactions.
      const again = await resume(path, { modelProvider: provider });
      expect(again.message).toBe("completed");
    });
  }, 600_000);
});
