// `MANDATE_LIVE=1 make live`: executes an approved manifest against a configured RPC. It never funds an
// account, stops before any step that would exceed the manifest budget, and on an ambiguous outcome
// stops without submitting a substitute. The flag is not spending approval; for mainnet the manifest's
// exact sha256 must also be confirmed in MANDATE_LIVE_CONFIRM.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { decide, decisionRecord, submitProposal } from "../agent/adapter.js";
import { AnthropicProvider, ClaudeCliProvider, type ModelProvider } from "../agent/providers.js";
import { buildSnapshot } from "../agent/snapshot.js";
import { environment, sourceBinding } from "../evidence/source.js";
import { Filler, mandateLeg } from "../filler/filler.js";
import { payableFor } from "../filler/arithmetic.js";
import { NearClient, toEvidenceReceipt, type Outcome } from "../near/client.js";
import { MandateClient, VerifierClient, settledOrder, tokenId } from "../near/contracts.js";
import { loadCredential } from "../near/credentials.js";
import { REPO_ROOT } from "../near/sandbox.js";
import { Asset, Evidence, Policy, Proposal, type Assertion, type Receipt } from "../types.js";

const Units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const AccountId = z.string().regex(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/).min(2).max(64);

const Step = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("check") }).strict(),
  z.object({ kind: z.literal("grant"), policy: Policy.strict() }).strict(),
  z
    .object({
      kind: z.literal("propose"),
      source: z.discriminatedUnion("from", [
        z.object({ from: z.literal("manifest"), proposal: Proposal }).strict(),
        z.object({ from: z.literal("model"), provider: z.enum(["anthropic", "claude-cli"]), notes: z.array(z.string()) }).strict(),
      ]),
    })
    .strict(),
  z.object({ kind: z.literal("fill"), order_id: Units.optional() }).strict(),
  z.object({ kind: z.literal("settle"), order_id: Units.optional() }).strict(),
  z.object({ kind: z.literal("revoke") }).strict(),
  z.object({ kind: z.literal("recover"), asset: Asset }).strict(),
]);
type Step = z.infer<typeof Step>;

export const LiveManifest = z
  .object({
    schema_version: z.literal(1),
    network: z.enum(["mainnet", "sandbox"]),
    rpc_url: z.url(),
    approval: z.object({ approved_by: z.string().min(1), reference: z.string().min(1) }).strict(),
    accounts: z
      .object({ mandate: AccountId, owner: AccountId, agent: AccountId, filler: AccountId, verifier: AccountId })
      .strict(),
    /** base58 sha256 of the deployed mandate code, as reported by view_account. */
    mandate_code_hash: z.string().min(32),
    credentials: z.object({ owner: z.string(), agent: z.string(), filler: z.string() }).strict(),
    /** Filler's NEP-413 signing key file (account_id = filler), registered on the verifier beforehand. */
    filler_signing_credential: z.string(),
    /** Filler restart state; defaults to out/live/filler-<network>-<mandate>.json. */
    filler_state_file: z.string().optional(),
    budget: z
      .object({
        max_transactions: z.number().int().positive(),
        max_sell_units: z.object({ usdc: Units, wnear: Units }).strict(),
        max_filler_pay_units: z.object({ usdc: Units, wnear: Units }).strict(),
      })
      .strict(),
    steps: z.array(Step).min(1),
  })
  .strict();
export type LiveManifest = z.infer<typeof LiveManifest>;

export interface LiveResult {
  exitCode: number;
  message: string;
  evidence?: Evidence;
}

export class Refusal extends Error {}

export function loadManifest(env: NodeJS.ProcessEnv): { manifest: LiveManifest; sha256: string; path: string } {
  if (env.MANDATE_LIVE !== "1") throw new Refusal("live: set MANDATE_LIVE=1 and MANDATE_LIVE_MANIFEST=<approved manifest>; the flag is not spending approval");
  const path = env.MANDATE_LIVE_MANIFEST;
  if (path === undefined || path === "") throw new Refusal("live: MANDATE_LIVE_MANIFEST is not set");
  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch {
    throw new Refusal(`live: cannot read manifest ${path}`);
  }
  const sha256 = createHash("sha256").update(raw).digest("hex");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Refusal(`live: manifest ${path} is not JSON`);
  }
  const result = LiveManifest.safeParse(parsed);
  if (!result.success) throw new Refusal(`live: invalid manifest: ${result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  if (result.data.network === "mainnet" && env.MANDATE_LIVE_CONFIRM !== sha256) {
    throw new Refusal(`live: mainnet requires MANDATE_LIVE_CONFIRM=<sha256 of the approved manifest> (this manifest: ${sha256})`);
  }
  return { manifest: result.data, sha256, path };
}

class Budget {
  private tx = 0;
  private readonly sold: Record<Asset, bigint> = { usdc: 0n, wnear: 0n };
  private readonly paid: Record<Asset, bigint> = { usdc: 0n, wnear: 0n };
  constructor(private readonly b: LiveManifest["budget"]) {}

  /** Throws before a step that would exceed the budget. Charges only after the caller commits. */
  check(kind: "tx" | "sell" | "pay", asset?: Asset, units = 0n): void {
    if (this.tx + 1 > this.b.max_transactions) throw new Refusal(`budget: transaction ${this.tx + 1} exceeds max_transactions ${this.b.max_transactions}`);
    if (kind === "sell" && asset !== undefined && this.sold[asset] + units > BigInt(this.b.max_sell_units[asset])) {
      throw new Refusal(`budget: selling ${units} ${asset} would exceed max_sell_units ${this.b.max_sell_units[asset]}`);
    }
    if (kind === "pay" && asset !== undefined && this.paid[asset] + units > BigInt(this.b.max_filler_pay_units[asset])) {
      throw new Refusal(`budget: filler paying ${units} ${asset} would exceed max_filler_pay_units ${this.b.max_filler_pay_units[asset]}`);
    }
  }
  charge(kind: "tx" | "sell" | "pay", asset?: Asset, units = 0n): void {
    this.tx += 1;
    if (kind === "sell" && asset !== undefined) this.sold[asset] += units;
    if (kind === "pay" && asset !== undefined) this.paid[asset] += units;
  }
}

/** Runs the manifest. Returns instead of throwing so callers (and tests) see refusals as results. */
export async function runLive(env: NodeJS.ProcessEnv = process.env): Promise<LiveResult> {
  let loaded: ReturnType<typeof loadManifest>;
  try {
    loaded = loadManifest(env);
  } catch (error) {
    return { exitCode: 2, message: error instanceof Error ? error.message : String(error) };
  }
  const { manifest: m } = loaded;
  const receipts: Receipt[] = [];
  const assertions: Assertion[] = [];
  const unknowns: string[] = [];
  const client = new NearClient(m.rpc_url);
  const mandate = new MandateClient(client, m.accounts.mandate);
  const verifier = new VerifierClient(client, m.accounts.verifier);
  const budget = new Budget(m.budget);
  let stopped: string | null = null;
  let lastOrder: string | null = null;
  try {
    const owner = loadCredential(m.credentials.owner, m.accounts.owner);
    const agent = loadCredential(m.credentials.agent, m.accounts.agent);
    const filler = loadCredential(m.credentials.filler, m.accounts.filler);
    const fillerSigning = loadCredential(m.filler_signing_credential, m.accounts.filler);
    const account = await client.provider.viewAccount({ accountId: m.accounts.mandate, blockQuery: { finality: "final" } });
    if (account.code_hash !== m.mandate_code_hash) throw new Refusal(`mandate code hash ${account.code_hash} != manifest ${m.mandate_code_hash}`);
    const ownerAcct = client.account(owner.accountId, owner.key);
    const agentAcct = client.account(agent.accountId, agent.key);
    const fillerAcct = client.account(filler.accountId, filler.key);
    const config = await mandate.config();
    if (config.owner_id !== m.accounts.owner || config.agent_id !== m.accounts.agent || config.verifier_id !== m.accounts.verifier) {
      throw new Refusal("mandate config roles do not match the manifest");
    }
    const fill = new Filler({ client, mandate, verifier, account: fillerAcct, key: fillerSigning.key, statePath: m.filler_state_file ?? join(REPO_ROOT, "out/live", `filler-${m.network}-${m.accounts.mandate}.json`) });
    const record = (o: Outcome, detail: Record<string, unknown> = {}): Outcome => {
      receipts.push(toEvidenceReceipt(o, detail));
      return o;
    };
    const send = async (o: Promise<Outcome>, detail: Record<string, unknown> = {}): Promise<Outcome> => {
      const out = record(await o, detail);
      if (!out.submitted || !out.success) {
        throw new Refusal(`${out.label} not confirmed: ${out.error ?? "receipt failure"}; if this was a transport error the transaction may still execute; nothing was resubmitted`);
      }
      return out;
    };

    for (const [i, step] of m.steps.entries()) {
      const label = `step ${i + 1} ${step.kind}`;
      console.log(`== ${label}`);
      switch (step.kind) {
        case "check": {
          const grant = await mandate.grant();
          const bal = { usdc: (await verifier.balance(mandate.id, config.usdc.token)).toString(), wnear: (await verifier.balance(mandate.id, config.wnear.token)).toString() };
          assertions.push({ id: label, gate: "LIVE", description: "read-only state check", passed: true, observed: { grant, balances: bal, code_hash: account.code_hash } });
          break;
        }
        case "grant":
          budget.check("tx");
          budget.charge("tx");
          await send(mandate.grantPolicy(ownerAcct, step.policy));
          break;
        case "propose": {
          let proposal: Proposal;
          const source = step.source;
          let detail: Record<string, unknown> = { source: source.from };
          if (source.from === "manifest") {
            proposal = source.proposal;
          } else {
            const grant = await mandate.grant();
            if (grant?.initial_reference == null) throw new Refusal("no active grant to show the model");
            const provider: ModelProvider = source.provider === "anthropic" ? new AnthropicProvider() : new ClaudeCliProvider();
            const snapshot = buildSnapshot({
              grant,
              prices: { usdc: grant.initial_reference.usdc, wnear: grant.initial_reference.wnear },
              decimals: { usdc: config.usdc.decimals, wnear: config.wnear.decimals },
              balances: { usdc: await verifier.balance(mandate.id, config.usdc.token), wnear: await verifier.balance(mandate.id, config.wnear.token) },
              notes: source.notes,
            });
            const decision = await decide(provider, snapshot);
            detail = { source: "live-model", decision: decisionRecord(decision) };
            if (decision.verdict.kind !== "proposal") {
              assertions.push({ id: label, gate: "MODEL", description: "live model decision", passed: decision.verdict.kind === "decline", observed: detail });
              break;
            }
            proposal = decision.verdict.proposal;
          }
          budget.check("sell", proposal.sell, BigInt(proposal.sell_amount));
          budget.charge("sell", proposal.sell, BigInt(proposal.sell_amount));
          const out = await send(submitProposal(client, agentAcct, mandate.id, proposal), detail);
          lastOrder = z.string().parse(String(out.return_value));
          const order = await settledOrder(mandate, lastOrder, 180_000);
          assertions.push({ id: label, gate: "LIVE", description: "proposal reached propose_order", passed: order !== null, observed: { order_id: lastOrder, state: order?.state } });
          break;
        }
        case "fill": {
          const orderId = step.order_id ?? lastOrder;
          if (orderId === null) throw new Refusal("fill: no order id");
          const order = await mandate.order(orderId);
          if (order?.state.state !== "signed") throw new Refusal(`fill: order ${orderId} is not signed (${JSON.stringify(order?.state)})`);
          const signed = await fill.signedOrder(order);
          const leg = mandateLeg(signed, mandate.id, verifier.id, [tokenId(config.usdc.token), tokenId(config.wnear.token)]);
          const pips = await verifier.feePips();
          const payAsset: Asset = leg.buyToken === tokenId(config.usdc.token) ? "usdc" : "wnear";
          const pay = payableFor(leg.buyAmount, pips);
          budget.check("pay", payAsset, pay);
          budget.charge("pay", payAsset, pay);
          const res = await fill.fill(orderId, signed);
          if (res.outcome !== undefined) record(res.outcome, { filler_record: res.record });
          if (res.record.state !== "filled") {
            stopped = `fill ${orderId}: ${res.record.state} (${res.record.detail ?? ""}); no substitute order submitted`;
          }
          break;
        }
        case "settle": {
          const orderId = step.order_id ?? lastOrder;
          if (orderId === null) throw new Refusal("settle: no order id");
          budget.check("tx");
          budget.charge("tx");
          await send(mandate.settle(ownerAcct, orderId));
          break;
        }
        case "revoke":
          budget.check("tx");
          budget.charge("tx");
          await send(mandate.revoke(ownerAcct));
          break;
        case "recover":
          budget.check("tx");
          budget.charge("tx");
          await send(mandate.recover(ownerAcct, step.asset));
          break;
      }
      if (stopped !== null) break;
    }
  } catch (error) {
    stopped = error instanceof Error ? error.message : String(error);
  }
  if (stopped !== null) unknowns.push(`run stopped: ${stopped}`);
  const binding = sourceBinding(REPO_ROOT, "see mandate_code_hash");
  const evidence = Evidence.parse({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    mode: m.network === "mainnet" ? "mainnet" : "sandbox",
    source: binding.source,
    environment: environment(REPO_ROOT, { rpc_url: m.rpc_url, manifest_sha256: loaded.sha256 }),
    command: "MANDATE_LIVE=1 make live",
    identifiers: { ...m.accounts, mandate_code_hash: m.mandate_code_hash, approval: `${m.approval.approved_by}: ${m.approval.reference}` },
    receipts,
    assertions,
    unknowns,
  });
  const outDir = join(REPO_ROOT, "out/evidence");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `live-${m.network}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
  return { exitCode: stopped === null ? 0 : 1, message: stopped ?? "completed", evidence };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const result = await runLive();
  console.log(result.message);
  process.exitCode = result.exitCode;
}
