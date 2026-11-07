// The owner console's static rendering and browser logic, without a network. The browser code is exercised as the
// page inlines it: consoleScript() is evaluated and its functions are called with a SYNTHETIC RPC answering from
// fixtures written below. The export format is checked against the runner's own schema and digest (src/live/external.ts).
import { describe, expect, it } from "vitest";
import type { ActionKind, ConsoleData, Doc, El, Handoff, Intent, LiveState, NetworkProfile, PendingRecord, SignerInfo } from "../src/console/client.js";
import { signableOf } from "../src/console/intent.js";
import { nearConnectBundle, scriptHash } from "../src/console/connector.js";
import { consoleScript, consoleScriptHash, mainnetProfile, renderConsoleHtml, sandboxProfile } from "../src/console/render.js";
import { ExternalHandoff, ExternalIntent, intentSha256 } from "../src/live/external.js";
import type { FetchFn } from "../src/page/verify-client.js";
import { MAINNET_GENESIS_HASH } from "../src/page/verify.js";
import { storyEvidence, txHash } from "./video-story-specimen.js";

type Call = (method: string, params: unknown) => Promise<{ ok: true; result: unknown } | { ok: false; error: string }>;
interface Client {
  readLive(call: Call, profile: NetworkProfile, rpcUrl: string, mandateId: string): Promise<LiveState>;
  renderLive(doc: Doc, profile: NetworkProfile, live: LiveState): El;
  ownerGate(profile: NetworkProfile, live: LiveState | null, signer: SignerInfo | null): string[];
  buildIntent(kind: ActionKind, asset: "usdc" | "wnear" | null, profile: NetworkProfile, live: LiveState, signer: SignerInfo): Intent | null;
  actionGate(kind: ActionKind, asset: "usdc" | "wnear" | null, live: LiveState, records: PendingRecord[]): { reasons: string[]; notes: string[] };
  endState(r: PendingRecord, live: LiveState, outcome: "success" | "failure"): { settled: boolean; text: string };
  fromRunner(o: Record<string, unknown>, live: LiveState | null): { view: Intent; stem: string } | { error: string };
  intentDiff(a: Intent, b: Intent): string[];
  cliCommand(intent: Intent, profile: NetworkProfile): string;
  txProblems(tx: Record<string, unknown>, intent: Intent, hash: string): string[];
  handoffOf(r: PendingRecord): Handoff | null;
  sha256Hex(text: string): Promise<string>;
  canonicalJson(v: unknown): string;
  fmtUnits(a: string, d: number | null): string;
  fmtShort(a: string, d: number, p: number): string;
  fmtUsd(units: unknown): string;
  deadlineText(deadlineNs: string | null, blockNs: string | null): string;
  nextStep(action: ActionKind, outcome: "success" | "failure", endText: string): string;
  loadRecords(store: unknown): PendingRecord[];
  saveRecord(store: unknown, r: PendingRecord): boolean;
  rpcCall(f: FetchFn, url: string, method: string, params: unknown, timeoutMs: number): ReturnType<Call>;
}

/** The exact inline script of the page, evaluated with no document elements, so its bootstrap wires nothing. */
function client(): Client {
  const emptyDoc = { getElementById: () => null, createElement: () => null };
  const names = ["readLive", "renderLive", "ownerGate", "buildIntent", "actionGate", "endState", "fromRunner", "intentDiff", "cliCommand", "txProblems", "handoffOf", "sha256Hex", "canonicalJson", "fmtUnits", "fmtShort", "fmtUsd", "deadlineText", "nextStep", "loadRecords", "saveRecord", "rpcCall"];
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const factory = new Function("document", "fetch", "window", `${consoleScript()}\nreturn { ${names.join(", ")} };`) as (d: unknown, f: unknown, w: unknown) => Client;
  return factory(emptyDoc, () => {
    throw new Error("the bootstrap must not fetch");
  }, {});
}

/** Minimal DOM: text content is the concatenation of descendants' text. */
class FakeEl implements El {
  className = "";
  hidden = false;
  disabled = false;
  value = "";
  id = "";
  children: (FakeEl | string)[] = [];
  attrs = new Map<string, string>();
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.children.map((c) => (typeof c === "string" ? c : c.textContent)).join("");
  }
  set textContent(v: string | null) {
    this.children = v === null ? [] : [v];
  }
  append(...c: (El | string)[]): void {
    this.children.push(...(c as (FakeEl | string)[]));
  }
  replaceChildren(...c: (El | string)[]): void {
    this.children = [...(c as (FakeEl | string)[])];
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.get(n) ?? null;
  }
  addEventListener(): void {
    // not needed by these tests
  }
}
const fakeDoc: Doc = { getElementById: () => null, createElement: (tag: string) => new FakeEl(tag) };

const SYN = "SYNTHETIC";
const GENESIS = "SyntheticGenesis1111111111111111111111111111";
const CODE = "SyntheticCode11111111111111111111111111111111";
const profile = sandboxProfile({ rpc_url: "http://127.0.0.1:1", chain_id: "test-chain-synthetic", genesis_hash: GENESIS, mandate_id: "mandate.synthetic", code_hash: CODE, verifier_id: "intents.synthetic", source: SYN });
const OWNER_KEY = "ed25519:8CHpRmN5DDGgpudfmx781SZcNYHF8XxxMBd8VbEchMct";
const signer: SignerInfo = { kind: "local", label: SYN, account_id: "owner.synthetic", public_key: OWNER_KEY, chain_id: "test-chain-synthetic", genesis_hash: GENESIS };

const bytes = (v: unknown) => [...Buffer.from(JSON.stringify(v))];
/** SYNTHETIC chain: answers status with `genesis`, and every view the console reads. */
function synthCall(genesis: string, over: Record<string, unknown> = {}): { call: Call; methods: string[] } {
  const methods: string[] = [];
  const views: Record<string, unknown> = {
    get_config: { owner_id: "owner.synthetic", agent_id: "agent.synthetic", verifier_id: "intents.synthetic", signer_id: "mpc.synthetic", oracle_id: "oracle.synthetic", usdc: { token: "usdc.synthetic", decimals: 6, price_id: "x" }, wnear: { token: "wnear.synthetic", decimals: 24, price_id: "y" } },
    get_grant: { epoch: 1, path: "mandate/v1/1", public_key: "ed25519:GrantKey", status: "revoked", policy: { per_order_cap_bps: 2000, outstanding_cap_bps: 2000, max_concession_bps: 50, oracle_max_age_sec: 60, max_confidence_bps: 50, breaker_drawdown_bps: 200, turnover_cap_bps: 10000, order_ttl_sec: 60, min_remaining_sec: 10, max_pricing_delay_sec: 30, proposal_charge_bps: 50 }, turnover_used: "0", outstanding: "0", breaker: null, key_op_in_flight: false },
    has_public_key: false,
    list_orders: [],
    get_recovery: [{ asset: "usdc", in_flight: false, attempts: 1, recovered: "5" }, { asset: "wnear", in_flight: false, attempts: 0, recovered: "0" }],
    mt_balance_of: "1234500",
    ft_balance_of: "0",
    storage_balance_of: { total: "1", available: "0" },
    storage_balance_bounds: { min: "1250000000000000000000", max: "1250000000000000000000" },
    ...over,
  };
  const call: Call = (method, params) => {
    const p = params as Record<string, unknown>;
    methods.push(method === "query" ? String(p.method_name ?? p.request_type) : method);
    if (method === "status") return Promise.resolve({ ok: true, result: { chain_id: "test-chain-synthetic", genesis_hash: genesis } });
    if (method === "block") return Promise.resolve({ ok: true, result: { header: { height: 7, hash: "SynthBlock", timestamp_nanosec: "1" } } });
    if (p.request_type === "view_account") return Promise.resolve({ ok: true, result: { code_hash: CODE } });
    const m = String(p.method_name);
    return Promise.resolve(m in views ? { ok: true, result: { result: bytes(views[m]) } } : { ok: false, error: `${SYN}: no ${m}` });
  };
  return { call, methods };
}

const c = client();

describe("static rendering", () => {
  const html = renderConsoleHtml(storyEvidence(), { profiles: [profile, mainnetProfile()], localSigner: "" });

  it("pins its two inline scripts (the console and the NEAR Connect library) by hash in the CSP and holds no key material", () => {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(scripts).toEqual([nearConnectBundle(), consoleScript()]);
    const nonce = /'nonce-([0-9a-f]{32})'/.exec(html)?.[1];
    expect(html).toContain(`script-src '${consoleScriptHash(consoleScript())}' '${scriptHash(nearConnectBundle())}' 'nonce-${nonce ?? ""}'`);
    // The library's own source mentions "<script" in strings (the adapter frame it builds); outside it, two tags.
    expect(html.replace(nearConnectBundle(), "").match(/<script/g)).toHaveLength(2);
    expect(html).not.toMatch(/ed25519:[1-9A-HJ-NP-Za-km-z]{60,}/); // no secret key (64-byte) anywhere
    expect(html).not.toMatch(/private_key|secret/i);
    // Without wallets the page has only the console script, pinned alone, and no nonce.
    const bare = renderConsoleHtml(storyEvidence(), { profiles: [profile], wallets: false });
    expect(bare.match(/<script/g)).toHaveLength(1);
    expect(bare).toContain(`script-src '${consoleScriptHash(consoleScript())}'; connect-src`);
    expect(bare).not.toContain("nonce-");
  });

  it("labels recorded evidence as sandbox and recorded, separately from the live view", () => {
    const recorded = html.slice(html.indexOf('id="recorded"'), html.indexOf('id="about"'));
    expect(recorded).toContain('<span class="mode sandbox"');
    expect(recorded).toContain("recorded evidence · not live");
    expect(recorded).not.toContain("mode live");
    const live = html.slice(html.indexOf('id="live"'), html.indexOf('id="owner"'));
    expect(live).not.toContain("mode sandbox");
    expect(live).not.toContain('class="mode live"');
    expect(live).not.toContain("chain verified");
  });

  it("states that no real wallet provider is verified and that the test signer and test wallet are not wallets", () => {
    expect(html).toContain("not a wallet and proves no wallet compatibility");
    expect(html).toContain("On a local sandbox the only wallet offered is the labelled SANDBOX TEST WALLET, a test double");
    const about = html.slice(html.indexOf('id="about"'));
    expect(about).toContain("The local sandbox test signer is a local sandbox adapter, not a wallet.");
    expect(about).toContain("tested end to end in a local sandbox with the labelled SANDBOX TEST WALLET only. No real wallet provider has signed through this console yet");
    expect(about).not.toMatch(/wallet-compatible|compatible with (your|any) wallet/i);
  });

  it("leads with the journey and says where each step happens, with the console acting only in steps 5, 7 and 8", () => {
    expect(html).toContain('<p class="lead">Give an AI agent trading power. Keep the power to stop it.</p>');
    const guide = html.slice(html.indexOf('<ol class="cjourney"'), html.indexOf("</ol>", html.indexOf('<ol class="cjourney"')));
    expect([...guide.matchAll(/<li( class="act")?><b><span>([1-8])<\/span>/g)].map((m) => `${m[2] ?? ""}${m[1] === undefined ? "" : " act"}`)).toEqual(["1", "2", "3", "4", "5 act", "6", "7 act", "8 act"]);
    expect(guide).toContain("Not instant: until key removal is confirmed, signed orders may still execute.");
    expect(guide).toContain("This page never relays orders");
    expect(guide).toContain("outside recovery claims");
    expect(html.indexOf('<ol class="cjourney"')).toBeLessThan(html.indexOf('id="live"'));
    expect(html).toContain("<h3>C · Owner actions, in journey order</h3>");
  });

  it("offers the local test signer only when served by it", () => {
    expect(html).toContain('<option value="local">');
    expect(renderConsoleHtml(storyEvidence())).not.toContain('<option value="local">');
  });

  it("refuses evidence that fails its schema", () => {
    expect(() => renderConsoleHtml({ mode: "mainnet" })).toThrow(/schema validation/);
  });
});

describe("live view", () => {
  it("on a wrong chain reads nothing else and shows nothing as verified", async () => {
    const { call, methods } = synthCall("OtherGenesis111111111111111111111111111111111");
    const live = await c.readLive(call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    expect(live.chain.ok).toBe(false);
    expect(methods).toEqual(["status"]);
    const text = c.renderLive(fakeDoc, profile, live).textContent ?? "";
    expect(text).toContain("wrong chain");
    expect(text).toContain("not verified");
    expect(text).not.toMatch(/chain verified|deployment matches|Limits/);
    expect(c.ownerGate(profile, live, signer).join(" ")).toMatch(/^network check failed: genesis hash/);
  });

  it("on the expected chain labels the view live, at one final block, and enables controls only for the owner", async () => {
    const { call } = synthCall(GENESIS);
    const live = await c.readLive(call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    const text = c.renderLive(fakeDoc, profile, live).textContent ?? "";
    expect(text).toContain(`live · ${profile.label} · final block #7`);
    expect(text).toContain("chain verified");
    expect(text).toContain("revoked: the grant key's removal is confirmed");
    expect(text).toContain("absent on intents.synthetic");
    expect(text).toContain("1.2345"); // 1234500 units at 6 decimals
    expect(c.ownerGate(profile, live, signer)).toEqual([]);
    expect(c.ownerGate(profile, live, { ...signer, account_id: "attacker.synthetic" })).toEqual(["signer attacker.synthetic is not the contract's owner owner.synthetic"]);
    expect(c.ownerGate(profile, live, null).join()).toMatch(/connect a signer/);
    const d = profile.deployment;
    if (d === null) throw new Error("no deployment");
    expect(c.ownerGate({ ...profile, deployment: { ...d, code_hash: "Other" } }, live, signer).join()).toMatch(/deployment check failed: mandate code hash/);
    expect(c.ownerGate(mainnetProfile(), live, signer)).toEqual(["read the live chain state of this network first"]);
  });

  it("shows an open signed order, turnover and reservations in readable units next to the raw ones", async () => {
    // SYNTHETIC: one signed order of 20 wNEAR for 59.831967 USDC, reserved at $60 (value units are 10^-12 USD).
    const order = { id: "1", sell: "wnear", sell_amount: "20000000000000000000000000", buy: "usdc", buy_amount: "59831967", state: { state: "signed" }, reserved_value: "60000000000000", deadline_ns: "61000000000" };
    const { call } = synthCall(GENESIS, {
      list_orders: [order],
      get_grant: { epoch: 1, path: "mandate/v1/1", public_key: "ed25519:GrantKey", status: "active", policy: { per_order_cap_bps: 2000 }, turnover_used: "69500000000000", outstanding: "60000000000000", breaker: null, key_op_in_flight: false },
      has_public_key: true,
    });
    const live = await c.readLive(call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    const text = c.renderLive(fakeDoc, profile, { ...live, block: { height: 7, hash: "SynthBlock", time_ns: "23000000000" } }).textContent ?? "";
    expect(text).toContain("$69.50 / $60.00 at the grant's reference prices (69500000000000 / 60000000000000 value units)");
    expect(text).toContain("20 wNEAR → 59.831967 USDC");
    expect(text).toContain("units: 20000000000000000000000000 wnear → 59831967 usdc");
    expect(text).toContain("$60.00");
    expect(text).toContain("1970-01-01 00:01:01 UTC (38 s left at the block read)");
    expect(text).toContain("including one that was signed and held back (step 4). Revoking (step 5) stops it once the key removal is confirmed.");
    expect(c.deadlineText("61000000000", "61000000000")).toBe("1970-01-01 00:01:01 UTC (passed at the block read)");
    // Less than a second left is still before the deadline.
    expect(c.deadlineText("61000000000", "60500000000")).toBe("1970-01-01 00:01:01 UTC (0 s left at the block read)");
    expect(c.fmtUsd("1899800000000000")).toBe("$1,899.80");
    expect(c.fmtUsd("not a number")).toBe("not read");
  });

  it("shows raw units, never whole tokens, when the contract's configuration does not state an asset's decimals", async () => {
    // SYNTHETIC: a configuration without USDC decimals; an open order selling 1234500 USDC units.
    const order = { id: "3", sell: "usdc", sell_amount: "1234500", buy: "wnear", buy_amount: "1000000000000000000000000", state: { state: "signed" }, reserved_value: "1234000000000000", deadline_ns: null };
    const { call } = synthCall(GENESIS, {
      get_config: { owner_id: "owner.synthetic", agent_id: "agent.synthetic", verifier_id: "intents.synthetic", signer_id: "mpc.synthetic", oracle_id: "oracle.synthetic", usdc: { token: "usdc.synthetic", price_id: "x" }, wnear: { token: "wnear.synthetic", decimals: 24, price_id: "y" } },
      list_orders: [order],
      get_grant: { epoch: 1, path: "mandate/v1/1", public_key: "ed25519:GrantKey", status: "active", policy: {}, turnover_used: "0", outstanding: "0", breaker: null, key_op_in_flight: false },
    });
    const live = await c.readLive(call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    expect(live.tokens.usdc?.decimals).toBeNull();
    const text = c.renderLive(fakeDoc, profile, live).textContent ?? "";
    expect(text).toContain("1234500 usdc (units) → 1 wNEAR");
    expect(text).toContain("1234500 (units)");
    expect(text).not.toContain("1,234,500 USDC");
    expect(c.fmtUnits("1234500", null)).toBe("1234500 (units)");
  });

  it("states the next owner step after a final action, and never claims a removal that is not confirmed", () => {
    expect(c.nextStep("revoke", "success", "revoked (epoch 1): removal confirmed, the grant key is absent on the verifier")).toContain("orders signed under this grant now fail");
    const unconfirmed = c.nextStep("revoke", "success", "revoking: removal not confirmed; revoke again to retry the removal");
    expect(unconfirmed).toContain("signed orders may still execute");
    expect(unconfirmed).not.toContain("now fail");
    expect(c.nextStep("recover", "failure", "the transaction failed")).toBe("Nothing is retried automatically: read the chain state, then review the action again to retry it deliberately.");
    expect(c.nextStep("withdraw", "success", "not withdrawn: Intents balance 1")).toContain("stays in the owner's Intents account");
    expect(c.nextStep("recover", "success", "recovery finished")).toContain("outside recovery claims");
  });

  it("notes, without disabling, a recovery that would move nothing", async () => {
    const { call } = synthCall(GENESIS, { mt_balance_of: "0" });
    const live = await c.readLive(call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    const gate = c.actionGate("recover", "usdc", live, []);
    expect(gate.reasons).toEqual([]);
    expect(gate.notes).toContain("the mandate holds none of this asset now; a recovery would move nothing");
  });

  it("formats integer units exactly; display truncation is marked", () => {
    expect(c.fmtUnits("316546856633333333333333334", 24)).toBe("316.546856633333333333333334");
    expect(c.fmtUnits("1000000000", 6)).toBe("1,000");
    expect(c.fmtShort("316546856633333333333333334", 24, 6)).toBe("316.546856…");
    expect(c.fmtShort("950100000", 6, 6)).toBe("950.1");
  });
});

describe("runner intents and the handoff export", () => {
  const runnerIntent = (over: Record<string, unknown> = {}, action: Record<string, unknown> = {}) =>
    ExternalIntent.parse({
      schema: "bounded-mandate/external-intent@1",
      manifest_sha256: "a".repeat(64),
      step: 3,
      kind: "recover_external",
      attempt: 1,
      network: { name: "sandbox", chain_id: "test-chain-synthetic", genesis_hash: GENESIS, rpc_url: "http://127.0.0.1:1" },
      signer_id: "owner.synthetic",
      public_key: OWNER_KEY,
      receiver_id: "mandate.synthetic",
      actions: [{ method: "recover", args: { asset: "usdc" }, gas: "80000000000000", deposit: "0", gas_min: "80000000000000", gas_max: "100000000000000", deposit_min: "0", deposit_max: "0", ...action }],
      expected: { summary: SYN, state: {} },
      created_at: "2026-11-06T00:00:00Z",
      ...over,
    });

  it("hashes a runner intent exactly as the runner does", async () => {
    const intent = runnerIntent();
    const browser = await c.sha256Hex(c.canonicalJson(intent));
    expect(browser).toBe(await intentSha256(intent));
    const signable = signableOf(intent);
    expect("error" in signable ? signable.error : signable.sha256).toBe(browser);
  });

  it("accepts a runner intent equal to the console preview, and lists every difference otherwise", async () => {
    const live = await c.readLive(synthCall(GENESIS).call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    const preview = c.buildIntent("recover", "usdc", profile, live, signer);
    expect(preview).not.toBeNull();
    const ok = c.fromRunner(runnerIntent(), live);
    if ("error" in ok || preview === null) throw new Error("expected a view");
    expect(ok.stem).toBe("step-3-recover_external-attempt-1");
    expect(c.intentDiff(ok.view, preview)).toEqual([]);
    const altered = c.fromRunner(runnerIntent({}, { args: { asset: "wnear" }, gas: "90000000000000" }), live);
    if ("error" in altered) throw new Error("expected a view");
    const wantPreview = c.buildIntent("recover", "wnear", profile, live, signer);
    if (wantPreview === null) throw new Error("no preview");
    expect(c.intentDiff(altered.view, wantPreview)).toEqual(["actions[0].gas: runner intent \"90000000000000\", console preview \"80000000000000\""]);
    expect(c.intentDiff(altered.view, preview)).toEqual(expect.arrayContaining([expect.stringContaining("actions[0].args.asset")]));
    expect(c.fromRunner({ schema: "other" }, live)).toEqual({ error: "not a bounded-mandate/external-intent@1 record of an owner action" });
  });

  it("exports exactly the runner's handoff record", async () => {
    const intent = runnerIntent();
    const sha = await intentSha256(intent);
    const view = c.fromRunner(intent, null);
    if ("error" in view) throw new Error(view.error);
    const hash = txHash(`${SYN} recover`);
    const rec: PendingRecord = { v: 1, intent_sha256: sha, intent: view.view, source: "runner", stem: view.stem, adapter: "local", rpc_url: "", mandate_id: "mandate.synthetic", profile_id: profile.id, phase: "submitted", tx_hash: hash, public_key: OWNER_KEY, baseline: { epoch: 1, attempts: 0, recovered: "0", intents: null, wallet: null, amount: null }, started_at: "", note: "", outcome: null, end_state: null, problems: [] };
    const h = c.handoffOf(rec);
    expect(ExternalHandoff.parse(h)).toEqual({ schema: "bounded-mandate/external-handoff@1", intent_sha256: sha, tx_hash: hash, signer_id: "owner.synthetic" });
    expect(c.handoffOf({ ...rec, tx_hash: null })).toBeNull();
  });

  it("shows the exact near CLI command and checks a fetched transaction against the intent", async () => {
    const live = await c.readLive(synthCall(GENESIS).call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    const w = c.buildIntent("withdraw", "usdc", profile, live, signer);
    if (w === null) throw new Error("no withdraw preview");
    expect(c.cliCommand(w, profile)).toBe(
      `near contract call-function as-transaction intents.synthetic ft_withdraw json-args '{"token":"usdc.synthetic","receiver_id":"owner.synthetic","amount":"1234500"}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' sign-as owner.synthetic network-config sandbox sign-with-keychain send`,
    );
    const hash = txHash(`${SYN} withdraw`);
    const args = Buffer.from(JSON.stringify({ token: "usdc.synthetic", receiver_id: "owner.synthetic", amount: "1234500" })).toString("base64");
    const tx = { transaction: { hash, signer_id: "owner.synthetic", receiver_id: "intents.synthetic", public_key: OWNER_KEY, actions: [{ FunctionCall: { method_name: "ft_withdraw", args, gas: 100_000_000_000_000, deposit: "1" } }] } };
    expect(c.txProblems(tx, w, hash)).toEqual([]);
    const evil = Buffer.from(JSON.stringify({ token: "usdc.synthetic", receiver_id: "evil.synthetic", amount: "1234500" })).toString("base64");
    const bad = { transaction: { ...tx.transaction, actions: [{ FunctionCall: { method_name: "ft_withdraw", args: evil, gas: 100_000_000_000_000, deposit: "2" } }] } };
    expect(c.txProblems(bad, w, hash)).toEqual([expect.stringContaining("action 0: arguments"), "action 0: deposit 2 is not 1"]);
  });

  it("disables a withdrawal whose balance read failed and never builds a non-integer amount", async () => {
    const live = await c.readLive(synthCall(GENESIS).call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    const usdc = live.tokens.usdc;
    if (usdc === undefined) throw new Error("no usdc state");
    expect(c.actionGate("withdraw", "usdc", live, []).reasons).toEqual([]);
    // mt_balance_of failed: readLive reports "unknown", which is not a zero balance and not an amount.
    const unread: LiveState = { ...live, tokens: { ...live.tokens, usdc: { ...usdc, owner_intents: "unknown" } } };
    expect(c.actionGate("withdraw", "usdc", unread, []).reasons).toEqual(["the owner's Intents balance of this asset could not be read (unknown valuation is not zero)"]);
    expect(() => c.buildIntent("withdraw", "usdc", profile, unread, signer)).toThrow(/non-integer amount "unknown"/);
    const zero: LiveState = { ...live, tokens: { ...live.tokens, usdc: { ...usdc, owner_intents: "0" } } };
    expect(c.actionGate("withdraw", "usdc", zero, []).reasons).toEqual(["the owner's Intents balance of this asset is 0"]);
  });

  it("confirms a revocation only when the verifier read shows the key absent", async () => {
    const live = await c.readLive(synthCall(GENESIS).call, profile, "http://127.0.0.1:1", "mandate.synthetic");
    const intent = c.buildIntent("revoke", null, profile, live, signer);
    if (intent === null) throw new Error("no revoke preview");
    const rec: PendingRecord = { v: 1, intent_sha256: "e".repeat(64), intent, source: "console", stem: null, adapter: "local", rpc_url: "", mandate_id: "mandate.synthetic", profile_id: profile.id, phase: "submitted", tx_hash: txHash(`${SYN} revoke`), public_key: OWNER_KEY, baseline: { epoch: 1, attempts: null, recovered: null, intents: null, wallet: null, amount: null }, started_at: "", note: "", outcome: null, end_state: null, problems: [] };
    expect(live.key_registered).toBe(false);
    expect(c.endState(rec, live, "success")).toEqual({ settled: true, text: "revoked (epoch 1): removal confirmed, the grant key is absent on the verifier" });
    const unread = c.endState(rec, { ...live, key_registered: null }, "success");
    expect(unread).toEqual({ settled: false, text: "revoked (epoch 1): key removal unknown, not verified (the verifier's key could not be read)" });
    expect(unread.text).not.toContain("confirmed");
    expect(c.endState(rec, { ...live, key_registered: true }, "success").text).toContain("removal not confirmed");
  });

  it("persists pending records keyed by intent sha256, and survives a broken storage", () => {
    const map = new Map<string, string>();
    const store = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => map.set(k, v), removeItem: (k: string) => map.delete(k), key: (i: number) => [...map.keys()][i] ?? null, get length() { return map.size; } };
    const rec = { v: 1, intent_sha256: "f".repeat(64), started_at: "x" } as unknown as PendingRecord;
    expect(c.saveRecord(store, rec)).toBe(true);
    expect([...map.keys()]).toEqual([`bounded-mandate/console/pending/${"f".repeat(64)}`]);
    expect(c.loadRecords(store)).toHaveLength(1);
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("quota"); }, removeItem: () => undefined, key: () => "bounded-mandate/console/pending/x", length: 1 };
    expect(c.saveRecord(broken, rec)).toBe(false);
    expect(c.loadRecords(broken)).toEqual([]);
    expect(c.loadRecords(null)).toEqual([]);
  });
});

describe("profiles", () => {
  it("pins mainnet to the page panel's genesis hash and records no mainnet deployment yet", () => {
    const m = mainnetProfile();
    expect(m.genesis_hash).toBe(MAINNET_GENESIS_HASH);
    expect(m.deployment).toBeNull();
    const data = JSON.parse(
      (/data-console="([^"]*)"/.exec(renderConsoleHtml(storyEvidence()))?.[1] ?? "{}").replaceAll("&quot;", '"').replaceAll("&amp;", "&"),
    ) as ConsoleData;
    expect(data.profiles.map((p) => p.id)).toEqual(["mainnet"]);
    expect(data.local_signer).toBeNull();
  });
});
