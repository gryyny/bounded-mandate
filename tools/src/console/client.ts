// The owner console's browser code. render.ts serializes every function in CONSOLE_FUNCTIONS with
// Function.prototype.toString into the page's single inline script (pinned by hash in the CSP), exactly like the
// evidence page's verification panel, whose RPC, receipt and canonical-JSON helpers are reused here by reference.
// So each function may use only browser globals and the other listed functions: no imports, no module-level values.
//
// What the browser does: reads live chain state only after the reader presses a button, and only after the RPC's
// chain id and genesis hash match the chosen network; checks the deployment (mandate account and code hash) and the
// connected signer against the contract's owner_id before enabling a control; previews each owner action exactly;
// hands it to a signing adapter outside the page (the owner's external wallet through NEAR Connect, a labelled local
// sandbox test signer, or the owner's own `near` CLI); then polls the transaction and the contract until final, and
// compares the transaction on chain with the preview field by field. It holds no private key and never resubmits
// anything: a pending action is persisted in localStorage, keyed by the intent's sha256, and after a reload only
// polling resumes.
import type * as Shared from "../page/verify-client.js";
import type { Call, FetchFn, FetchResponse } from "../page/verify-client.js";

// The evidence page's panel helpers, reused as they are: render.ts places the page's own functions ahead of these in
// the inline script. They are declared, not imported, because a bundler or test transform rewrites references to
// imported bindings, and these functions run only as serialized script text (Node never calls them).
declare const asObject: typeof Shared.asObject;
declare const asString: typeof Shared.asString;
declare const rpcCall: typeof Shared.rpcCall;
declare const rpcErrorText: typeof Shared.rpcErrorText;
declare const statusKind: typeof Shared.statusKind;
declare const receiptViews: typeof Shared.receiptViews;
declare const chainOutcome: typeof Shared.chainOutcome;
declare const canonicalJson: typeof Shared.canonicalJson;
declare const sha256Hex: typeof Shared.sha256Hex;

export type AssetKey = "usdc" | "wnear";
export type ActionKind = "revoke" | "recover" | "withdraw" | "register";

export interface Deployment {
  mandate_id: string;
  /** base58 sha256 of the expected mandate WASM, as NEAR reports code_hash. */
  code_hash: string;
  verifier_id: string;
  /** Where the expectation comes from (a build, a manifest); shown to the reader. */
  source: string;
}

export interface NetworkProfile {
  id: string;
  label: string;
  kind: "mainnet" | "sandbox";
  rpc_url: string;
  chain_id: string;
  genesis_hash: string;
  deployment: Deployment | null;
  /** `near` CLI network-config name for the manual handoff command. */
  cli_network: string;
  gas_tgas: Record<ActionKind, number>;
}

/** The wallets NEAR Connect may offer on one network: only these, never a remote manifest. */
export interface WalletProfile {
  /** NEAR Connect's network label: "mainnet", or "testnet" for a local sandbox (only the test wallet is listed). */
  network: "mainnet" | "testnet";
  manifest: { version: string; wallets: Record<string, unknown>[] };
  /** Per wallet id: the adapter's pinned commit, or null for the labelled sandbox test wallet. */
  pins: Record<string, { commit: string; age_rule_met: boolean } | null>;
  /** Per adapter URL: the sha256 its bytes must have before NEAR Connect runs it (null: not hash-checked). */
  hashes: Record<string, string | null>;
}

export interface ConsoleData {
  profiles: NetworkProfile[];
  /** Base URL of the local sandbox test signer, or null when this page was not served by it. */
  local_signer: string | null;
  timeout_ms: number;
  poll_ms: number;
  /** External wallets through NEAR Connect, by profile id; null when the page offers none. */
  wallets: { library_version: string; nonce: string; profiles: Record<string, WalletProfile> } | null;
}

/** One action in NEAR Connect's (wallet-selector) format. */
export interface WalletAction {
  type: "FunctionCall";
  params: { methodName: string; args: unknown; gas: string; deposit: string };
}

export interface WalletTxParams {
  signerId: string;
  receiverId: string;
  actions: WalletAction[];
  network: "mainnet" | "testnet";
}

/** The part of a NEAR Connect wallet the console uses. */
export interface WalletLike {
  manifest: { id: string; name: string; executor?: string; debug?: boolean };
  getAccounts(): Promise<{ accountId: string; publicKey?: string }[]>;
  signAndSendTransaction(params: WalletTxParams): Promise<unknown>;
}

/** NEAR Connect's storage interface; the console passes one that lives only in memory. */
export interface ConnectorStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface ConnectorOptions {
  network: "mainnet" | "testnet";
  storage: ConnectorStorage;
  manifest: WalletProfile["manifest"];
  features: { signAndSendTransaction: true };
  autoConnect: false;
  cspNonce: string;
  footerBranding: null;
  providers: { mainnet: string[]; testnet: string[] };
}

/** The part of NEAR Connect's NearConnector the console uses. */
export interface ConnectorLike {
  connect(): Promise<WalletLike>;
  disconnect(wallet?: WalletLike): Promise<void>;
  /**
   * What the wallet instance is: an adapter run in NEAR Connect's sandboxed frame ("sandbox"), a browser extension
   * announced by an event ("injected"), or anything else (a wallet announced by another frame or window).
   */
  kindOf(wallet: WalletLike): "sandbox" | "injected" | "other";
}

/** `pins`: adapter URL to its sha256, or null for the sandbox test wallet; the bundle runs no other adapter. */
export type ConnectorFactory = (options: ConnectorOptions, pins: Record<string, string | null>) => ConnectorLike;

export interface IntentAction {
  method: string;
  args: unknown;
  /** Decimal strings: gas units and yoctoNEAR. */
  gas: string;
  deposit: string;
}

/**
 * The transaction an owner action signs, in the console's own record (`bounded-mandate/console-intent@1`). A loaded
 * runner intent (`bounded-mandate/external-intent@1`, src/live/external.ts) is normalized to this shape for
 * comparison and polling; what is signed and hashed is always the exact record the signer receives.
 */
export interface Intent {
  schema: string;
  action: ActionKind;
  asset: AssetKey | null;
  network: { chain_id: string; genesis_hash: string };
  signer_id: string;
  public_key: string | null;
  receiver_id: string;
  actions: IntentAction[];
}

/** The runner's handoff record (src/live/external.ts ExternalHandoff): exactly these four fields. */
export interface Handoff {
  schema: "bounded-mandate/external-handoff@1";
  intent_sha256: string;
  tx_hash: string;
  signer_id: string;
}

/** What a review signs: the exact record handed to the signer and the console's view of it. */
export interface Signable {
  raw: unknown;
  view: Intent;
  source: "runner" | "console";
  stem: string | null;
}

/** A loaded runner intent: its exact record, its sha256 and the console's normalized view of it. */
export interface LoadedIntent {
  raw: Record<string, unknown>;
  sha: string;
  stem: string;
  view: Intent;
}

export interface TokenSide {
  token: string;
  decimals: number;
  mandate: string;
  owner_intents: string;
  owner_wallet: string | null;
  owner_registered: boolean | null;
  storage_min: string | null;
}

export interface LiveState {
  profile_id: string;
  rpc_url: string;
  chain: { ok: boolean; title: string; reasons: string[] };
  block: { height: number; hash: string; time_ns: string } | null;
  mandate_id: string;
  code_hash: string | null;
  config: Record<string, unknown> | null;
  grant: Record<string, unknown> | null;
  key_registered: boolean | null;
  orders: Record<string, unknown>[];
  recovery: Record<string, unknown>[];
  tokens: Partial<Record<AssetKey, TokenSide>>;
  errors: string[];
}

export type AdapterKind = "local" | "manual" | "wallet";

export interface SignerInfo {
  kind: AdapterKind;
  label: string;
  account_id: string;
  public_key: string | null;
  chain_id: string | null;
  genesis_hash: string | null;
}

export interface Baseline {
  epoch: number | null;
  attempts: number | null;
  recovered: string | null;
  intents: string | null;
  wallet: string | null;
  amount: string | null;
}

export type Phase = "awaiting-signature" | "submitted" | "final";

export interface PendingRecord {
  v: 1;
  intent_sha256: string;
  intent: Intent;
  /** "runner": the runner's persisted intent was signed; "console": the console's own record. */
  source: "runner" | "console";
  /** The runner's file stem (`<stem>.handoff.json`), or null for a console intent. */
  stem: string | null;
  adapter: AdapterKind;
  rpc_url: string;
  mandate_id: string;
  profile_id: string;
  phase: Phase;
  tx_hash: string | null;
  public_key: string | null;
  baseline: Baseline;
  started_at: string;
  note: string;
  outcome: "success" | "failure" | null;
  end_state: string | null;
  problems: string[];
}

export type SignResult =
  | { status: "submitted"; tx_hash: string; public_key: string | null }
  | { status: "cancelled"; reason: string }
  | { status: "rejected"; error: string }
  | { status: "refused"; error: string }
  | { status: "error"; error: string };

export interface El {
  textContent: string | null;
  className: string;
  hidden: boolean;
  disabled: boolean;
  value: string;
  id: string;
  append(...children: (El | string)[]): void;
  replaceChildren(...children: (El | string)[]): void;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, fn: () => void): void;
}

export interface Doc {
  getElementById(id: string): El | null;
  createElement(tag: string): El;
}

export interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  key(index: number): string | null;
  readonly length: number;
}

export interface LocalInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  credentials: "same-origin";
  referrerPolicy: "same-origin";
  cache: "no-store";
}
export type LocalFetch = (url: string, init: LocalInit) => Promise<FetchResponse>;

export interface Env {
  doc: Doc;
  rpcFetch: FetchFn;
  localFetch: LocalFetch;
  store: Store | null;
  now: () => string;
  later: (fn: () => void, ms: number) => void;
  download: (name: string, text: string) => void;
  /** NEAR Connect's NearConnector constructor (the inlined library), or null when the page has none. */
  connector: ConnectorFactory | null;
  /** True when another page frames this one: wallet connection is then refused. */
  framed: boolean;
}

// ------------------------------------------------------------------ formatting

/** Exact decimal rendering of an integer token amount; trailing fractional zeros dropped. */
export function fmtUnits(amount: string, decimals: number): string {
  if (!/^[0-9]+$/.test(amount)) return amount;
  const padded = amount.padStart(decimals + 1, "0");
  const whole = padded.slice(0, padded.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = padded.slice(padded.length - decimals).replace(/0+$/, "");
  return frac === "" ? whole : `${whole}.${frac}`;
}

/** Display form: at most `places` fractional digits, with "…" when digits were cut (never rounded up). */
export function fmtShort(amount: string, decimals: number, places: number): string {
  const full = fmtUnits(amount, decimals);
  const dot = full.indexOf(".");
  return dot === -1 || full.length - dot - 1 <= places ? full : `${full.slice(0, dot + 1 + places)}…`;
}

export function bpsText(bps: unknown): string {
  if (typeof bps !== "number") return "not recorded";
  const pct = bps / 100;
  return `${String(pct)}%`;
}

/** The grant's limits in plain words; values straight from the contract's policy, no interpretation. */
export function policyLines(policy: unknown): [string, string][] {
  if (typeof policy !== "object" || policy === null || Array.isArray(policy)) return [];
  const p = policy as Record<string, unknown>;
  const n = (k: string): unknown => p[k];
  const sec = (k: string): string => (typeof n(k) === "number" ? `${String(n(k))} s` : "not recorded");
  return [
    ["Largest single order", `${bpsText(n("per_order_cap_bps"))} of the grant's initial reference value`],
    ["All open orders together", `${bpsText(n("outstanding_cap_bps"))} of that value`],
    ["Total traded per grant", `${bpsText(n("turnover_cap_bps"))} of that value`],
    ["Every proposal uses at least", `${bpsText(n("proposal_charge_bps"))} of that turnover, even when refused`],
    ["Worst price the agent may concede", `${bpsText(n("max_concession_bps"))} against the oracle reference`],
    ["Oracle prices must be younger than", sec("oracle_max_age_sec")],
    ["Oracle confidence must be within", bpsText(n("max_confidence_bps"))],
    ["New orders stop at a drawdown of", `${bpsText(n("breaker_drawdown_bps"))} (loss breaker; not a total-loss cap)`],
    ["Signed orders expire after", sec("order_ttl_sec")],
  ];
}

export function grantStatusText(status: unknown): string {
  if (status === "activating") return "activating: the grant key is being registered on the verifier; no order can be signed yet";
  if (status === "active") return "active: the agent may propose orders within the limits";
  if (status === "revoking") return "revoking: new orders are stopped, but orders already signed may still execute until the key removal is confirmed";
  if (status === "revoked") return "revoked: the grant key's removal is confirmed; orders signed under it can no longer execute";
  return `unknown status ${JSON.stringify(status)}`;
}

export function shortHash(h: string): string {
  return h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
}

// ------------------------------------------------------------------ reading the chain

export async function checkNetwork(call: Call, expected: { chain_id: string; genesis_hash: string }): Promise<LiveState["chain"]> {
  const r = await call("status", []);
  if (!r.ok) return { ok: false, title: "Network check: the RPC did not answer; nothing is verified", reasons: [r.error] };
  const s = asObject(r.result);
  const chainId = asString(s?.chain_id);
  const genesis = asString(s?.genesis_hash);
  const reasons = [
    ...(chainId === expected.chain_id ? [] : [`chain id is ${JSON.stringify(chainId)}, expected ${JSON.stringify(expected.chain_id)}`]),
    ...(genesis === expected.genesis_hash ? [] : [`genesis hash is ${JSON.stringify(genesis)}, expected ${JSON.stringify(expected.genesis_hash)}`]),
  ];
  return reasons.length === 0
    ? { ok: true, title: `Network check passed: chain id ${expected.chain_id}, genesis ${expected.genesis_hash}`, reasons }
    : { ok: false, title: "Wrong chain: nothing on this RPC is read or verified", reasons };
}

export async function viewAt(call: Call, blockHash: string, account: string, method: string, args: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const r = await call("query", { request_type: "call_function", block_id: blockHash, account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) });
  if (!r.ok) return r;
  const bytes = asObject(r.result)?.result;
  if (!Array.isArray(bytes)) return { ok: false, error: `${method}: no result bytes` };
  try {
    const text = new TextDecoder().decode(Uint8Array.from(bytes as number[]));
    return { ok: true, value: text === "" ? null : (JSON.parse(text) as unknown) };
  } catch (e) {
    return { ok: false, error: `${method}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Every view at one final block, so the snapshot is consistent. Nothing is read when the network check fails. */
export async function readLive(call: Call, profile: NetworkProfile, rpcUrl: string, mandateId: string): Promise<LiveState> {
  const state: LiveState = {
    profile_id: profile.id,
    rpc_url: rpcUrl,
    chain: await checkNetwork(call, profile),
    block: null,
    mandate_id: mandateId,
    code_hash: null,
    config: null,
    grant: null,
    key_registered: null,
    orders: [],
    recovery: [],
    tokens: {},
    errors: [],
  };
  if (!state.chain.ok) return state;
  const b = await call("block", { finality: "final" });
  const header = b.ok ? asObject(asObject(b.result)?.header) : null;
  const hash = asString(header?.hash);
  if (!b.ok || header === null || hash === null) {
    state.errors.push(`final block: ${b.ok ? "no header" : b.error}`);
    return state;
  }
  state.block = { height: Number(header.height), hash, time_ns: String(header.timestamp_nanosec) };
  const acc = await call("query", { request_type: "view_account", block_id: hash, account_id: mandateId });
  if (acc.ok) state.code_hash = asString(asObject(acc.result)?.code_hash);
  else state.errors.push(`account ${mandateId}: ${acc.error}`);
  const view = async (account: string, method: string, args: unknown): Promise<unknown> => {
    const r = await viewAt(call, hash, account, method, args);
    if (r.ok) return r.value;
    state.errors.push(`${account}.${method}: ${r.error}`);
    return undefined;
  };
  state.config = asObject(await view(mandateId, "get_config", {}));
  if (state.config === null) return state;
  state.grant = asObject(await view(mandateId, "get_grant", {}));
  const verifier = asString(state.config.verifier_id) ?? "";
  const owner = asString(state.config.owner_id) ?? "";
  const key = asString(state.grant?.public_key);
  if (key !== null) {
    const has = await view(verifier, "has_public_key", { account_id: mandateId, public_key: key });
    state.key_registered = typeof has === "boolean" ? has : null;
  }
  const all: Record<string, unknown>[] = [];
  for (let from = 0; from < 100_000; from += 100) {
    const page = await view(mandateId, "list_orders", { from_index: String(from), limit: 100 });
    if (!Array.isArray(page)) break;
    for (const o of page as unknown[]) {
      const obj = asObject(o);
      if (obj !== null) all.push(obj);
    }
    if (page.length < 100) break;
  }
  state.orders = all;
  const rec = await view(mandateId, "get_recovery", {});
  state.recovery = Array.isArray(rec) ? (rec as unknown[]).map((x) => asObject(x)).filter((x): x is Record<string, unknown> => x !== null) : [];
  for (const asset of ["usdc", "wnear"] as const) {
    const cfg = asObject(state.config[asset]);
    const token = asString(cfg?.token);
    if (token === null) continue;
    const mt = async (account: string): Promise<string> => {
      const v = await view(verifier, "mt_balance_of", { account_id: account, token_id: `nep141:${token}` });
      return typeof v === "string" ? v : "unknown";
    };
    const wallet = await view(token, "ft_balance_of", { account_id: owner });
    const storage = await view(token, "storage_balance_of", { account_id: owner });
    const bounds = asObject(await view(token, "storage_balance_bounds", {}));
    state.tokens[asset] = {
      token,
      decimals: typeof cfg?.decimals === "number" ? cfg.decimals : 0,
      mandate: await mt(mandateId),
      owner_intents: await mt(owner),
      owner_wallet: typeof wallet === "string" ? wallet : null,
      owner_registered: storage === undefined ? null : storage !== null,
      storage_min: asString(bounds?.min),
    };
  }
  return state;
}

/** Why the read deployment is not the expected one; empty when it is. */
export function deploymentProblems(profile: NetworkProfile, live: LiveState): string[] {
  const d = profile.deployment;
  if (d === null) return [`no expected deployment is recorded for ${profile.label}`];
  return [
    ...(live.mandate_id === d.mandate_id ? [] : [`mandate account ${live.mandate_id} is not the expected ${d.mandate_id}`]),
    ...(live.code_hash === d.code_hash ? [] : [`mandate code hash ${live.code_hash ?? "unknown"} is not the expected ${d.code_hash} (${d.source})`]),
    ...(live.config === null || asString(live.config.verifier_id) === d.verifier_id ? [] : [`the contract's verifier ${asString(live.config.verifier_id) ?? "unknown"} is not the expected ${d.verifier_id}`]),
  ];
}

// ------------------------------------------------------------------ actions

export function actionKey(kind: ActionKind, asset: AssetKey | null): string {
  return asset === null ? kind : `${kind}:${asset}`;
}

export function actionTitle(kind: ActionKind, asset: AssetKey | null): string {
  const a = asset === "usdc" ? "USDC" : asset === "wnear" ? "wNEAR" : "";
  if (kind === "revoke") return "Revoke the grant";
  if (kind === "recover") return `Recover ${a} to the owner's Intents account`;
  if (kind === "withdraw") return `Withdraw ${a} from the owner's Intents account to the owner's NEAR account`;
  return `Register the owner on the ${a} token (storage deposit)`;
}

/** The exact transaction the console proposes, from live state only. Null when it cannot be built. */
export function buildIntent(kind: ActionKind, asset: AssetKey | null, profile: NetworkProfile, live: LiveState, signer: SignerInfo): Intent | null {
  const owner = asString(live.config?.owner_id);
  const verifier = asString(live.config?.verifier_id);
  if (owner === null || verifier === null) return null;
  const tgas = (k: ActionKind): string => (BigInt(profile.gas_tgas[k]) * 1000000000000n).toString();
  const side = asset === null ? undefined : live.tokens[asset];
  const base = { schema: "bounded-mandate/console-intent@1", action: kind, asset, network: { chain_id: profile.chain_id, genesis_hash: profile.genesis_hash }, signer_id: owner, public_key: signer.public_key };
  const call = (receiver: string, method: string, args: unknown, deposit: string): Intent => ({
    ...base,
    receiver_id: receiver,
    actions: [{ method, args, gas: tgas(kind), deposit }],
  });
  if (kind === "revoke") return call(live.mandate_id, "revoke", {}, "0");
  if (asset === null || side === undefined) return null;
  if (kind === "recover") return call(live.mandate_id, "recover", { asset }, "0");
  if (kind === "withdraw") {
    if (!/^(0|[1-9][0-9]*)$/.test(side.owner_intents)) throw new Error(`refusing to build a withdrawal of a non-integer amount ${JSON.stringify(side.owner_intents)}`);
    return call(verifier, "ft_withdraw", { token: side.token, receiver_id: owner, amount: side.owner_intents }, "1");
  }
  if (side.storage_min === null) return null;
  return call(side.token, "storage_deposit", { account_id: owner, registration_only: true }, side.storage_min);
}

/** The fields that define the transaction; differences are listed by path. */
export function intentDiff(expected: Intent, preview: Intent): string[] {
  const pick = (i: Intent) => ({ network: i.network, signer_id: i.signer_id, receiver_id: i.receiver_id, actions: i.actions });
  const a = asObject(JSON.parse(canonicalJson(pick(expected))));
  const b = asObject(JSON.parse(canonicalJson(pick(preview))));
  const out: string[] = [];
  const walk = (x: unknown, y: unknown, path: string): void => {
    const ox = asObject(x);
    const oy = asObject(y);
    if (ox !== null && oy !== null) {
      for (const k of [...new Set([...Object.keys(ox), ...Object.keys(oy)])].sort()) walk(ox[k], oy[k], `${path}.${k}`);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y) && x.length === y.length) {
      x.forEach((v: unknown, i) => {
        walk(v, (y as unknown[])[i], `${path}[${String(i)}]`);
      });
      return;
    }
    const show = (v: unknown): string => (v === undefined ? "absent" : canonicalJson(v));
    if (show(x) !== show(y)) out.push(`${path.slice(1)}: runner intent ${show(x)}, console preview ${show(y)}`);
  };
  walk(a, b, "");
  return out;
}

/** Reasons the owner controls are disabled; empty when owner, network and deployment all match. */
export function ownerGate(profile: NetworkProfile, live: LiveState | null, signer: SignerInfo | null): string[] {
  if (live?.profile_id !== profile.id) return ["read the live chain state of this network first"];
  if (!live.chain.ok) return [`network check failed: ${live.chain.reasons.join("; ")}`];
  if (live.config === null) return [`the mandate's configuration could not be read: ${live.errors.join("; ") || "no answer"}`];
  const out = deploymentProblems(profile, live).map((p) => `deployment check failed: ${p}`);
  if (signer === null) return [...out, "connect a signer (an external wallet, the local sandbox test signer or the manual CLI handoff)"];
  if (signer.genesis_hash !== null && signer.genesis_hash !== profile.genesis_hash) out.push(`the signer is on another chain (genesis ${signer.genesis_hash}, expected ${profile.genesis_hash})`);
  const owner = asString(live.config.owner_id);
  if (signer.account_id !== owner) out.push(`signer ${signer.account_id} is not the contract's owner ${owner ?? "unknown"}`);
  return out;
}

/** Action-specific reasons a control is unavailable, beyond the owner gate. Advisory notes never disable. */
export function actionGate(kind: ActionKind, asset: AssetKey | null, live: LiveState, records: PendingRecord[]): { reasons: string[]; notes: string[] } {
  const reasons: string[] = [];
  const notes: string[] = [];
  const key = actionKey(kind, asset);
  const open = records.find((r) => actionKey(r.intent.action, r.intent.asset) === key && r.phase !== "final");
  if (open !== undefined) reasons.push(`this action is pending${open.tx_hash === null ? "" : ` (transaction ${open.tx_hash})`}; nothing is resubmitted`);
  const side = asset === null ? undefined : live.tokens[asset];
  const status = asString(live.grant?.status);
  if (kind === "revoke") {
    if (live.grant === null) reasons.push("there is no grant to revoke");
    else if (status === "revoked") notes.push("the grant is already revoked; the contract refuses another revocation");
  }
  if (kind === "recover" && status !== null && status !== "revoked") notes.push(`recovery requires a revoked grant (now ${status}); the contract refuses it otherwise`);
  if (kind === "withdraw" && side !== undefined) {
    if (!/^(0|[1-9][0-9]*)$/.test(side.owner_intents)) reasons.push("the owner's Intents balance of this asset could not be read (unknown valuation is not zero)");
    else if (side.owner_intents === "0") reasons.push("the owner's Intents balance of this asset is 0");
    if (side.owner_registered === false) reasons.push("the owner is not registered on this token: register it first");
  }
  if (kind === "register" && side?.owner_registered !== false) reasons.push("the owner is already registered on this token");
  return { reasons, notes };
}

/** The exact `near` CLI (near-cli-rs) command for the owner to sign elsewhere. */
export function cliCommand(intent: Intent, profile: NetworkProfile): string {
  const a = intent.actions[0];
  if (a === undefined) return "";
  const gas = `${(BigInt(a.gas) / 1000000000000n).toString()} Tgas`;
  const deposit = a.deposit === "0" ? "0 NEAR" : `${a.deposit} yoctoNEAR`;
  return `near contract call-function as-transaction ${intent.receiver_id} ${a.method} json-args '${JSON.stringify(a.args)}' prepaid-gas '${gas}' attached-deposit '${deposit}' sign-as ${intent.signer_id} network-config ${profile.cli_network} sign-with-keychain send`;
}

/** The intent as NEAR Connect's signAndSendTransaction parameters: the same signer, receiver and actions. */
export function walletParams(intent: Intent, network: "mainnet" | "testnet"): WalletTxParams {
  return {
    signerId: intent.signer_id,
    receiverId: intent.receiver_id,
    actions: intent.actions.map((a) => ({ type: "FunctionCall", params: { methodName: a.method, args: a.args, gas: a.gas, deposit: a.deposit } })),
    network,
  };
}

/** The transaction hash in a wallet's answer (a final execution outcome), or null. */
export function walletTxHash(result: unknown): string | null {
  const o = asObject(result);
  const hash = asString(asObject(o?.transaction)?.hash) ?? asString(asObject(o?.transaction_outcome)?.id);
  return hash !== null && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash) ? hash : null;
}

export function adapterText(kind: AdapterKind, label: string | null): string {
  if (kind === "local") return "the local sandbox test signer";
  if (kind === "manual") return "the manual near CLI handoff";
  return label === null ? "an external wallet (NEAR Connect)" : `the external wallet ${label} (NEAR Connect)`;
}

/** Decoded actions of a fetched transaction compared with the intent; empty when they are identical. */
export function txProblems(tx: Record<string, unknown>, intent: Intent, hash: string): string[] {
  const t = asObject(tx.transaction);
  const out = [
    ...(asString(t?.hash) === hash ? [] : [`transaction hash ${JSON.stringify(t?.hash ?? null)} differs from ${hash}`]),
    ...(asString(t?.signer_id) === intent.signer_id ? [] : [`signer ${JSON.stringify(t?.signer_id ?? null)} is not ${intent.signer_id}`]),
    ...(asString(t?.receiver_id) === intent.receiver_id ? [] : [`receiver ${JSON.stringify(t?.receiver_id ?? null)} is not ${intent.receiver_id}`]),
    ...(intent.public_key === null || asString(t?.public_key) === intent.public_key ? [] : [`signed with key ${JSON.stringify(t?.public_key ?? null)}, intent names ${intent.public_key}`]),
  ];
  const acts = Array.isArray(t?.actions) ? (t.actions as unknown[]) : [];
  if (acts.length !== intent.actions.length) out.push(`${String(acts.length)} actions, intent has ${String(intent.actions.length)}`);
  intent.actions.forEach((want, i) => {
    const fc = asObject(asObject(acts[i])?.FunctionCall);
    if (fc === null) {
      out.push(`action ${String(i)} is not a function call`);
      return;
    }
    let args: unknown = null;
    try {
      args = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(asString(fc.args) ?? ""), (c) => c.charCodeAt(0))));
    } catch {
      out.push(`action ${String(i)}: arguments are not JSON`);
    }
    if (fc.method_name !== want.method) out.push(`action ${String(i)}: method ${JSON.stringify(fc.method_name)} is not ${want.method}`);
    if (canonicalJson(args) !== canonicalJson(want.args)) out.push(`action ${String(i)}: arguments ${canonicalJson(args)} differ from ${canonicalJson(want.args)}`);
    if (String(fc.gas) !== want.gas) out.push(`action ${String(i)}: gas ${String(fc.gas)} is not ${want.gas}`);
    if (String(fc.deposit) !== want.deposit) out.push(`action ${String(i)}: deposit ${String(fc.deposit)} is not ${want.deposit}`);
  });
  return out;
}

export function baselineOf(intent: Intent, live: LiveState): Baseline {
  const rec = live.recovery.find((r) => r.asset === intent.asset);
  const side = intent.asset === null ? undefined : live.tokens[intent.asset];
  const amount = asObject(intent.actions[0]?.args)?.amount;
  return {
    epoch: typeof live.grant?.epoch === "number" ? live.grant.epoch : null,
    attempts: typeof rec?.attempts === "number" ? rec.attempts : null,
    recovered: asString(rec?.recovered),
    intents: side?.owner_intents ?? null,
    wallet: side?.owner_wallet ?? null,
    amount: asString(amount),
  };
}

/** Whether the contract state shows the action's end state. `settled: false` keeps polling. Display only: the runner verifies. */
export function endState(r: PendingRecord, live: LiveState, outcome: "success" | "failure"): { settled: boolean; text: string } {
  const i = r.intent;
  const b = r.baseline;
  if (outcome === "failure") return { settled: true, text: "the transaction failed (a receipt in its tree failed); see the receipts" };
  if (i.action === "revoke") {
    const g = live.grant;
    if (g === null) return { settled: false, text: "grant not readable" };
    if (g.key_op_in_flight === true) return { settled: false, text: `${String(g.status)}: key removal in flight` };
    if (g.status === "revoked" && live.key_registered === false) return { settled: true, text: `revoked (epoch ${String(g.epoch)}): removal confirmed, the grant key is absent on the verifier` };
    if (g.status === "revoked" && live.key_registered === null) return { settled: false, text: `revoked (epoch ${String(g.epoch)}): key removal unknown, not verified (the verifier's key could not be read)` };
    return { settled: true, text: `${String(g.status)}: removal not confirmed; revoke again to retry the removal` };
  }
  const side = i.asset === null ? undefined : live.tokens[i.asset];
  const unit = i.asset === "usdc" ? " USDC" : i.asset === "wnear" ? " wNEAR" : "";
  if (i.action === "recover") {
    const rec = live.recovery.find((x) => x.asset === i.asset);
    if (rec === undefined) return { settled: false, text: "recovery state not readable" };
    if (rec.in_flight === true) return { settled: false, text: "recovery in flight" };
    const delta = BigInt(asString(rec.recovered) ?? "0") - BigInt(b.recovered ?? "0");
    return { settled: true, text: `recovery finished: ${fmtUnits(delta.toString(), side?.decimals ?? 0)}${unit} moved to the owner's Intents account; mandate balance now ${fmtUnits(side?.mandate ?? "?", side?.decimals ?? 0)}${unit}` };
  }
  if (side === undefined) return { settled: false, text: "token state not readable" };
  if (i.action === "withdraw") {
    const moved = side.owner_wallet !== null && b.wallet !== null && BigInt(side.owner_wallet) - BigInt(b.wallet) === BigInt(b.amount ?? "0");
    const left = b.intents !== null && BigInt(b.intents) - BigInt(side.owner_intents) === BigInt(b.amount ?? "0");
    if (moved && left) return { settled: true, text: `withdrawn: ${fmtUnits(b.amount ?? "0", side.decimals)}${unit} left the owner's Intents account and arrived in its NEAR account` };
    return { settled: true, text: `not withdrawn: Intents balance ${fmtUnits(side.owner_intents, side.decimals)}, NEAR-account balance ${fmtUnits(side.owner_wallet ?? "?", side.decimals)} (a refunded withdrawal leaves the Intents balance intact)` };
  }
  return side.owner_registered === true ? { settled: true, text: "registered on the token" } : { settled: false, text: "registration not visible yet" };
}

// ------------------------------------------------------------------ persistence (never required; never fatal)

export function storeKey(sha: string): string {
  return `bounded-mandate/console/pending/${sha}`;
}

export function loadRecords(store: Store | null): PendingRecord[] {
  const out: PendingRecord[] = [];
  if (store === null) return out;
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith("bounded-mandate/console/pending/") !== true) continue;
      const parsed = asObject(JSON.parse(store.getItem(k) ?? "null"));
      if (parsed?.v === 1 && typeof parsed.intent_sha256 === "string") out.push(parsed as unknown as PendingRecord);
    }
  } catch {
    return out;
  }
  return out.sort((a, b) => a.started_at.localeCompare(b.started_at));
}

export function saveRecord(store: Store | null, r: PendingRecord): boolean {
  if (store === null) return false;
  try {
    store.setItem(storeKey(r.intent_sha256), JSON.stringify(r));
    return true;
  } catch {
    return false;
  }
}

export function dropRecord(store: Store | null, sha: string): void {
  try {
    store?.removeItem(storeKey(sha));
  } catch {
    // Storage unavailable: the record was never persisted either.
  }
}

export function handoffOf(r: PendingRecord): Handoff | null {
  if (r.tx_hash === null) return null;
  return { schema: "bounded-mandate/external-handoff@1", intent_sha256: r.intent_sha256, tx_hash: r.tx_hash, signer_id: r.intent.signer_id };
}

/**
 * The console's view of a runner intent, or why it cannot be one. Only revoke, recover and withdraw are runner
 * actions; the asset is read from the arguments (recover) or matched by token (withdraw).
 */
export function fromRunner(o: Record<string, unknown>, live: LiveState | null): { view: Intent; stem: string } | { error: string } {
  const net = asObject(o.network);
  const acts = Array.isArray(o.actions) ? (o.actions as unknown[]).map((a) => asObject(a)) : [];
  const kind = o.kind === "revoke_external" ? "revoke" : o.kind === "recover_external" ? "recover" : o.kind === "withdraw_external" ? "withdraw" : null;
  if (o.schema !== "bounded-mandate/external-intent@1" || kind === null || net === null || acts.length === 0 || acts.some((a) => a === null)) return { error: "not a bounded-mandate/external-intent@1 record of an owner action" };
  if (typeof o.signer_id !== "string" || typeof o.receiver_id !== "string" || typeof o.public_key !== "string") return { error: "the intent lacks its signer, receiver or approved key" };
  const actions: IntentAction[] = acts.map((a) => ({ method: String(a?.method), args: a?.args, gas: String(a?.gas), deposit: String(a?.deposit) }));
  const args = asObject(actions[0]?.args);
  let asset: AssetKey | null = null;
  if (kind === "recover") asset = args?.asset === "usdc" || args?.asset === "wnear" ? args.asset : null;
  if (kind === "withdraw") {
    for (const k of ["usdc", "wnear"] as const) if (asString(asObject(live?.config?.[k])?.token) === asString(args?.token)) asset = k;
    if (live === null) return { error: "read the live chain state first: a withdrawal's asset is matched by its token" };
  }
  if (kind !== "revoke" && asset === null) return { error: "the intent's asset is not one of the mandate's two assets" };
  return {
    view: { schema: "bounded-mandate/external-intent@1", action: kind, asset, network: { chain_id: String(net.chain_id), genesis_hash: String(net.genesis_hash) }, signer_id: o.signer_id, public_key: o.public_key, receiver_id: o.receiver_id, actions },
    stem: `step-${String(o.step)}-${String(o.kind)}-attempt-${String(o.attempt)}`,
  };
}

// ------------------------------------------------------------------ signing adapters

export async function localRequest(fetchFn: LocalFetch, url: string, body: unknown, timeoutMs: number): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; error: string }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: ctrl.signal,
      credentials: "same-origin",
      referrerPolicy: "same-origin",
      cache: "no-store",
    });
    const value = asObject(await res.json());
    if (value === null) return { ok: false, error: `HTTP ${String(res.status)}: not a JSON object` };
    return { ok: true, value };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
  }
}

/** One sign-and-send request to the local sandbox test signer. Exactly one request per call; no retry. */
export async function localSign(fetchFn: LocalFetch, base: string, intent: unknown, sha: string, timeoutMs: number): Promise<SignResult> {
  const r = await localRequest(fetchFn, `${base}/signer/sign`, { intent, intent_sha256: sha }, timeoutMs);
  if (!r.ok) return { status: "error", error: `no answer from the local signer: ${r.error}` };
  const v = r.value;
  const status = asString(v.status);
  if (status === "submitted" && typeof v.tx_hash === "string") return { status, tx_hash: v.tx_hash, public_key: asString(v.public_key) };
  if (status === "cancelled") return { status, reason: asString(v.reason) ?? "cancelled in the signer" };
  if (status === "rejected" || status === "refused") return { status, error: asString(v.error) ?? status };
  return { status: "error", error: `unexpected signer answer ${JSON.stringify(v).slice(0, 200)}` };
}

// ------------------------------------------------------------------ DOM helpers

export function h(doc: Doc, tag: string, cls: string, ...children: (El | string | null)[]): El {
  const e = doc.createElement(tag);
  if (cls !== "") e.className = cls;
  for (const c of children) if (c !== null) e.append(c);
  return e;
}

export function kvList(doc: Doc, rows: [string, string][]): El {
  const dl = h(doc, "dl", "kv");
  for (const [k, v] of rows) dl.append(h(doc, "dt", "", k), h(doc, "dd", "", v));
  return dl;
}

export function pill(doc: Doc, cls: string, text: string): El {
  return h(doc, "span", `status ${cls}`, text);
}

export function liveBadge(doc: Doc, profile: NetworkProfile, live: LiveState): El {
  const where = live.block === null ? "no block read" : `final block #${String(live.block.height)}`;
  return h(doc, "span", `mode ${live.chain.ok ? "live" : "wrong-chain"}`, live.chain.ok ? `live · ${profile.label} · ${where}` : `not verified · ${profile.label}`);
}

/** The live, read-only state view. On a failed network check it shows the failure and nothing else. */
export function renderLive(doc: Doc, profile: NetworkProfile, live: LiveState): El {
  const root = h(doc, "div", "live-view");
  root.append(h(doc, "p", "chips", liveBadge(doc, profile, live)));
  root.append(h(doc, "p", `check ${live.chain.ok ? "ok" : "bad"}`, pill(doc, live.chain.ok ? "success" : "failure", live.chain.ok ? "chain verified" : "wrong chain"), ` ${live.chain.title}`));
  if (live.chain.reasons.length > 0) root.append(h(doc, "ul", "reasons", ...live.chain.reasons.map((r) => h(doc, "li", "", r))));
  if (!live.chain.ok) return root;
  const dep = deploymentProblems(profile, live);
  root.append(
    h(doc, "p", `check ${dep.length === 0 ? "ok" : "bad"}`, pill(doc, dep.length === 0 ? "success" : "failure", dep.length === 0 ? "deployment matches" : "deployment differs"), ` ${live.mandate_id}, code hash ${live.code_hash ?? "unknown"}`),
  );
  if (dep.length > 0) root.append(h(doc, "ul", "reasons", ...dep.map((r) => h(doc, "li", "", r))));
  if (live.errors.length > 0) root.append(h(doc, "ul", "reasons", ...live.errors.map((r) => h(doc, "li", "", `not read: ${r}`))));
  const c = live.config;
  if (c === null) return root;
  const grid = h(doc, "div", "cgrid");
  root.append(grid);
  const card = (title: string, ...body: (El | string)[]): El => {
    const span = title === "Balances" ? " wide" : title === "Open orders" ? " span2" : "";
    const e = h(doc, "section", `ccard${span}`, h(doc, "h3", "", title), ...body);
    grid.append(e);
    return e;
  };
  const g = live.grant;
  const status = asString(g?.status);
  card(
    "Grant",
    g === null
      ? h(doc, "p", "", "No grant: the agent has no authority.")
      : h(doc, "p", "grant-line", pill(doc, `grant-${status ?? "unknown"}`, status ?? "unknown"), ` epoch ${String(g.epoch)} · ${grantStatusText(status)}`),
    ...(g === null
      ? []
      : [
          kvList(doc, [
            ["Key operation in flight", g.key_op_in_flight === true ? "yes: a key registration or removal has not finished" : "no"],
            ["Grant key", asString(g.public_key) ?? "none yet"],
            ["Key on the verifier now", live.key_registered === null ? "not read" : live.key_registered ? `registered on ${asString(c.verifier_id) ?? "?"}` : `absent on ${asString(c.verifier_id) ?? "?"}`],
            ["Derivation path", asString(g.path) ?? "?"],
            ["Turnover used / outstanding", `${String(g.turnover_used)} / ${String(g.outstanding)} (reference value units)`],
            ["Loss breaker", g.breaker === null || g.breaker === undefined ? "not tripped" : `tripped: ${JSON.stringify(g.breaker)}`],
          ]),
        ]),
  );
  card("Limits of this grant", ...(g === null ? [h(doc, "p", "", "No grant, so no limits apply.")] : [kvList(doc, policyLines(g.policy))]));
  card(
    "Mandate",
    kvList(doc, [
      ["Owner", asString(c.owner_id) ?? "?"],
      ["Agent", asString(c.agent_id) ?? "?"],
      ["Intents verifier", asString(c.verifier_id) ?? "?"],
      ["MPC signer", asString(c.signer_id) ?? "?"],
      ["Price oracle", asString(c.oracle_id) ?? "?"],
    ]),
  );
  const balRows = h(doc, "tbody", "");
  for (const asset of ["usdc", "wnear"] as const) {
    const s = live.tokens[asset];
    if (s === undefined) continue;
    const label = asset === "usdc" ? "USDC" : "wNEAR";
    balRows.append(
      h(doc, "tr", "", h(doc, "th", "", label), h(doc, "td", "num", fmtShort(s.mandate, s.decimals, 6)), h(doc, "td", "num", fmtShort(s.owner_intents, s.decimals, 6)), h(doc, "td", "num", s.owner_wallet === null ? "not read" : fmtShort(s.owner_wallet, s.decimals, 6)), h(doc, "td", "", s.owner_registered === null ? "not read" : s.owner_registered ? "yes" : "no")),
    );
  }
  const thead = h(doc, "thead", "", h(doc, "tr", "", h(doc, "th", "", "Asset"), h(doc, "th", "num", "Mandate · Intents"), h(doc, "th", "num", "Owner · Intents"), h(doc, "th", "num", "Owner · NEAR account"), h(doc, "th", "", "Registered")));
  card("Balances", h(doc, "div", "scroll", h(doc, "table", "", thead, balRows)));
  const open = live.orders.filter((o) => ["pricing", "signing", "signed", "sign_unknown"].includes(String(asObject(o.state)?.state)));
  const orderRows = h(doc, "tbody", "");
  for (const o of open) {
    orderRows.append(
      h(doc, "tr", "", h(doc, "td", "", String(o.id)), h(doc, "td", "", `${String(o.sell_amount)} ${String(o.sell)} → ${asString(o.buy_amount) ?? "?"} ${String(o.buy)}`), h(doc, "td", "", String(asObject(o.state)?.state)), h(doc, "td", "num", String(o.reserved_value)), h(doc, "td", "", asString(o.deadline_ns) === null ? "not signed yet" : new Date(Number(BigInt(asString(o.deadline_ns) ?? "0") / 1000000n)).toISOString())),
    );
  }
  card(
    "Recovery",
    kvList(
      doc,
      live.recovery.map((r) => {
        const asset = r.asset === "usdc" || r.asset === "wnear" ? r.asset : null;
        const dec = asset === null ? 0 : (live.tokens[asset]?.decimals ?? 0);
        return [String(r.asset), `${r.in_flight === true ? "in flight" : "idle"} · ${String(r.attempts)} attempt${r.attempts === 1 ? "" : "s"} · ${fmtUnits(asString(r.recovered) ?? "0", dec)} recovered to the owner`];
      }),
    ),
  );
  card(
    "Open orders",
    h(doc, "p", "", `${String(open.length)} open (reserved against the caps) of ${String(live.orders.length)} recorded. Released orders keep no reservation.`),
    ...(open.length === 0
      ? []
      : [h(doc, "div", "scroll", h(doc, "table", "", h(doc, "thead", "", h(doc, "tr", "", h(doc, "th", "", "Order"), h(doc, "th", "", "Trade (units)"), h(doc, "th", "", "State"), h(doc, "th", "", "Reserved"), h(doc, "th", "", "Deadline"))), orderRows))]),
  );
  return root;
}

// ------------------------------------------------------------------ the page

/** Wires the console. Nothing is fetched until a button is pressed, except polling of pending actions found in storage. */
export function install(env: Env): void {
  const { doc } = env;
  const root = doc.getElementById("console-root");
  const raw = root?.getAttribute("data-console") ?? null;
  const get = (id: string): El => {
    const e = doc.getElementById(id);
    if (e === null) throw new Error(`console element #${id} missing`);
    return e;
  };
  if (raw === null) return;
  const data = JSON.parse(raw) as ConsoleData;
  const ui = {
    profile: get("net-profile"),
    rpc: get("net-rpc"),
    mandate: get("net-mandate"),
    read: get("live-read"),
    liveStatus: get("live-status"),
    live: get("live-body"),
    signerKind: get("signer-kind"),
    signerAccount: get("signer-account"),
    signerConnect: get("signer-connect"),
    signerStatus: get("signer-status"),
    intentText: get("intent-text"),
    intentLoad: get("intent-load"),
    intentClear: get("intent-clear"),
    intentStatus: get("intent-status"),
    actions: get("actions"),
    review: get("review"),
    activity: get("activity"),
    log: get("console-log"),
  };
  const memory = new Map<string, string>();
  // NEAR Connect's own state (selected wallet, debug wallets) lives only in this page's memory, never in the
  // origin's localStorage, which other pages on a shared hosting origin could write.
  const walletStorage: ConnectorStorage = {
    get: (k) => Promise.resolve(memory.get(k) ?? null),
    set: (k, v) => {
      memory.set(k, v);
      return Promise.resolve();
    },
    remove: (k) => {
      memory.delete(k);
      return Promise.resolve();
    },
  };
  const st: { live: LiveState | null; signer: SignerInfo | null; intent: LoadedIntent | null; polling: Set<string>; wallet: WalletLike | null; connectors: Record<string, ConnectorLike> } = {
    live: null,
    signer: null,
    intent: null,
    polling: new Set(),
    wallet: null,
    connectors: {},
  };
  const profileOf = (id: string): NetworkProfile => data.profiles.find((p) => p.id === id) ?? (data.profiles[0] as NetworkProfile);
  const current = (): NetworkProfile => profileOf(ui.profile.value);
  const say = (text: string): void => {
    ui.log.textContent = text;
  };
  const callFor = (url: string): Call => (method, params) => rpcCall(env.rpcFetch, url, method, params, data.timeout_ms);

  const applyProfile = (): void => {
    const p = current();
    ui.rpc.value = p.rpc_url;
    ui.mandate.value = p.deployment?.mandate_id ?? "";
    st.live = null;
    ui.live.replaceChildren(h(doc, "p", "muted", `Nothing read yet. Expected chain id ${p.chain_id}, genesis ${p.genesis_hash}.`));
    renderActions();
  };

  const refresh = async (): Promise<void> => {
    const p = current();
    const url = ui.rpc.value.trim();
    const mandate = ui.mandate.value.trim();
    if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?(\/|$))/.test(url)) {
      ui.liveStatus.textContent = "Enter an https RPC URL (or http on 127.0.0.1/localhost for a local sandbox).";
      return;
    }
    if (!/^[a-z0-9._-]{2,64}$/.test(mandate)) {
      ui.liveStatus.textContent = "Enter the mandate account id.";
      return;
    }
    ui.read.disabled = true;
    ui.liveStatus.textContent = `Reading ${url} …`;
    try {
      const live = await readLive(callFor(url), p, url, mandate);
      if (ui.profile.value !== p.id) return;
      st.live = live;
      ui.live.replaceChildren(renderLive(doc, p, live));
      ui.liveStatus.textContent = live.chain.ok ? `Read from ${url} at ${env.now()}. Live chain state, not recorded evidence.` : `Not verified: ${live.chain.reasons.join("; ")}`;
    } catch (e) {
      ui.liveStatus.textContent = `Read failed: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      ui.read.disabled = false;
      renderActions();
      renderActivity();
    }
  };

  const connectWallet = async (): Promise<void> => {
    const p = current();
    const cfg = data.wallets?.profiles[p.id];
    if (env.framed) {
      ui.signerStatus.textContent = "This page is framed by another page: wallet connection is disabled. Open the console in its own tab.";
      return;
    }
    if (env.connector === null || data.wallets === null || cfg === undefined) {
      ui.signerStatus.textContent = `No external wallet is offered for ${p.label} in this page.`;
      return;
    }
    const rpc = ui.rpc.value.trim();
    const slot = `${p.id} ${rpc}`;
    const connector =
      st.connectors[slot] ??
      env.connector(
        {
          network: cfg.network,
          storage: walletStorage,
          manifest: cfg.manifest,
        features: { signAndSendTransaction: true },
        autoConnect: false,
        cspNonce: data.wallets.nonce,
        footerBranding: null,
          providers: { mainnet: cfg.network === "mainnet" ? [rpc] : [], testnet: cfg.network === "testnet" ? [rpc] : [] },
        },
        cfg.hashes,
      );
    st.connectors[slot] = connector;
    ui.signerStatus.textContent = "Choose a wallet in the NEAR Connect window …";
    let wallet: WalletLike;
    let accounts: { accountId: string }[];
    try {
      wallet = await connector.connect();
      accounts = await wallet.getAccounts();
    } catch (e) {
      ui.signerStatus.textContent = `Not connected: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    const account = accounts[0]?.accountId ?? "";
    if (!/^[a-z0-9._-]{2,64}$/.test(account)) {
      ui.signerStatus.textContent = "Not connected: the wallet reported no account.";
      return;
    }
    const kind = connector.kindOf(wallet);
    const pin = cfg.pins[wallet.manifest.id];
    if (wallet.manifest.debug === true || kind === "other" || (kind === "sandbox" && pin === undefined)) {
      ui.signerStatus.textContent = `Not connected: ${wallet.manifest.name} is not a wallet this page offers (${wallet.manifest.debug === true ? "a manually added debug wallet" : kind === "other" ? "announced by another frame or window" : "not on the pinned list"}). Nothing is signed with it.`;
      return;
    }
    st.wallet = wallet;
    st.signer = { kind: "wallet", label: wallet.manifest.name, account_id: account, public_key: null, chain_id: null, genesis_hash: null };
    const pinned =
      kind === "injected" ? "a browser-extension wallet announced to this page, not on the pinned list" : pin === null || pin === undefined ? "the labelled sandbox test wallet, a test double" : `adapter pinned at commit ${pin.commit.slice(0, 12)} and checked against its sha256${pin.age_rule_met ? "" : " (younger than the 14-day age rule)"}`;
    ui.signerStatus.textContent = `Connected: ${account} via ${wallet.manifest.name} through NEAR Connect ${data.wallets.library_version} (${pinned}). The wallet signs; the page holds no key. Every returned transaction is checked on chain against the preview.`;
  };

  const connect = async (): Promise<void> => {
    st.signer = null;
    st.wallet = null;
    if (ui.signerKind.value === "wallet") {
      await connectWallet();
    } else if (ui.signerKind.value === "local") {
      if (data.local_signer === null) {
        ui.signerStatus.textContent = "No local sandbox test signer served this page.";
        return;
      }
      const r = await localRequest(env.localFetch, `${data.local_signer}/signer/info`, undefined, data.timeout_ms);
      const v = r.ok ? r.value : null;
      const account = asString(v?.account_id);
      if (v === null || account === null) {
        ui.signerStatus.textContent = `Local test signer unavailable: ${r.ok ? "no account" : r.error}`;
      } else {
        st.signer = { kind: "local", label: asString(v.label) ?? "local sandbox test signer", account_id: account, public_key: asString(v.public_key), chain_id: asString(v.chain_id), genesis_hash: asString(v.genesis_hash) };
        ui.signerStatus.textContent = `Connected: ${account} via the LOCAL SANDBOX TEST SIGNER (key held by a Node process on this machine; refuses non-sandbox chains). Not a wallet.`;
      }
    } else {
      const account = ui.signerAccount.value.trim();
      if (!/^[a-z0-9._-]{2,64}$/.test(account)) {
        ui.signerStatus.textContent = "Enter the owner account that will sign with the near CLI.";
      } else {
        st.signer = { kind: "manual", label: "manual near CLI handoff", account_id: account, public_key: null, chain_id: null, genesis_hash: null };
        ui.signerStatus.textContent = `Manual handoff as ${account}: the console shows the exact command; you sign outside this page and paste the transaction hash.`;
      }
    }
    renderActions();
  };

  const loadIntent = async (): Promise<void> => {
    st.intent = null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(ui.intentText.value);
    } catch {
      ui.intentStatus.textContent = "Not JSON.";
      renderActions();
      return;
    }
    const o = asObject(parsed);
    const v = o === null ? { error: "not a JSON object" } : fromRunner(o, st.live);
    if (o === null || "error" in v) {
      ui.intentStatus.textContent = `Not loaded: ${"error" in v ? v.error : "not a JSON object"}.`;
      renderActions();
      return;
    }
    const sha = await sha256Hex(canonicalJson(o));
    st.intent = { raw: o, sha, stem: v.stem, view: v.view };
    ui.intentStatus.textContent = `Runner intent loaded: ${actionTitle(v.view.action, v.view.asset)} (${v.stem}) · sha256 ${sha}. Only this action can be signed, and only if the console's own preview equals it.`;
    renderActions();
  };

  const records = (): PendingRecord[] => loadRecords(env.store);

  function renderActions(): void {
    const p = current();
    const gate = ownerGate(p, st.live, st.signer);
    const list = h(doc, "div", "actions");
    list.append(
      h(doc, "p", `check ${gate.length === 0 ? "ok" : "bad"}`, pill(doc, gate.length === 0 ? "success" : "not-run", gate.length === 0 ? "owner controls enabled" : "owner controls disabled"), gate.length === 0 ? ` signer ${st.signer?.account_id ?? ""} is the contract's owner on the expected deployment` : ""),
    );
    if (gate.length > 0) list.append(h(doc, "ul", "reasons gate-reasons", ...gate.map((r) => h(doc, "li", "", r))));
    const kinds: [ActionKind, AssetKey | null][] = [["revoke", null], ["recover", "usdc"], ["recover", "wnear"], ["register", "usdc"], ["withdraw", "usdc"], ["register", "wnear"], ["withdraw", "wnear"]];
    const recs = records();
    for (const [kind, asset] of kinds) {
      const key = actionKey(kind, asset);
      const live = st.live;
      const base = live === null || gate.length > 0 ? { reasons: [], notes: [] } : actionGate(kind, asset, live, recs);
      const loaded = st.intent?.view;
      const extra = loaded !== undefined && (loaded.action !== kind || loaded.asset !== asset) ? { ...base, reasons: [...base.reasons, "the loaded runner intent is for another action; clear it first"] } : base;
      if (kind === "register" && (live === null || asset === null || live.tokens[asset]?.owner_registered !== false)) continue;
      const reasons = [...gate, ...extra.reasons];
      const button = h(doc, "button", "act", "Review");
      button.setAttribute("type", "button");
      button.setAttribute("data-action", key);
      button.disabled = reasons.length > 0;
      button.addEventListener("click", () => {
        review(kind, asset);
      });
      const desc =
        kind === "revoke"
          ? "Stops new orders at once and removes the grant key from the verifier. Orders already signed fail once the removal is confirmed."
          : kind === "recover"
            ? "Moves the mandate's whole verifier balance of this asset to the owner's Intents account (mt_transfer). No agent, oracle or MPC involved."
            : kind === "withdraw"
              ? "The owner's own action outside the mandate and outside every recovery claim: ft_withdraw from the owner's Intents account to its NEAR account."
              : "Registers the owner on the token contract so a withdrawal can be received. Only shown when needed.";
      list.append(
        h(
          doc,
          "article",
          `action${reasons.length > 0 ? " off" : ""}`,
          h(doc, "h3", "", actionTitle(kind, asset)),
          h(doc, "p", "muted", desc),
          ...(reasons.length > 0 && gate.length === 0 ? [h(doc, "p", "why", `Disabled: ${extra.reasons.join("; ")}`)] : []),
          ...extra.notes.map((n) => h(doc, "p", "note", `Note: ${n}`)),
          button,
        ),
      );
    }
    ui.actions.replaceChildren(list);
  }

  const review = (kind: ActionKind, asset: AssetKey | null): void => {
    void (async () => {
      const p = current();
      const live = st.live;
      const signer = st.signer;
      const gate = live === null ? ["no live state"] : [...ownerGate(p, live, signer), ...actionGate(kind, asset, live, records()).reasons];
      if (live === null || signer === null || gate.length > 0) {
        say(`Refused: ${gate.join("; ")}`);
        return;
      }
      let preview: Intent | null;
      try {
        preview = buildIntent(kind, asset, p, live, signer);
      } catch (e) {
        say(`Refused: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      if (preview === null) {
        say("Refused: the action cannot be built from the live state.");
        return;
      }
      const loadedIntent = st.intent;
      let signed: Signable = { raw: preview, view: preview, source: "console", stem: null };
      let source = "console preview (no runner intent loaded)";
      if (loadedIntent !== null) {
        const loaded = loadedIntent.view;
        const problems =
          loaded.action !== kind || loaded.asset !== asset
            ? [`the loaded runner intent is for “${actionTitle(loaded.action, loaded.asset)}”, not this action`]
            : [...intentDiff(loaded, preview), ...(signer.public_key !== null && loaded.public_key !== signer.public_key ? [`public_key: runner intent ${String(loaded.public_key)}, the signer holds ${signer.public_key}`] : [])];
        if (problems.length > 0) {
          ui.review.replaceChildren(h(doc, "div", "refused", h(doc, "p", "", pill(doc, "failure", "refused"), " The console's preview does not equal the runner's persisted intent; nothing is signed."), h(doc, "ul", "reasons", ...problems.map((x) => h(doc, "li", "", x)))));
          say("Refused: the preview differs from the loaded runner intent.");
          return;
        }
        signed = { raw: loadedIntent.raw, view: loaded, source: "runner", stem: loadedIntent.stem };
        source = `runner intent ${loadedIntent.stem}, equal to the console's own preview`;
      }
      const sha = loadedIntent?.sha ?? (await sha256Hex(canonicalJson(signed.raw)));
      const existing = records().find((r) => r.intent_sha256 === sha);
      if (existing !== undefined) {
        say(`Refused: this exact intent was already handed to a signer (${existing.tx_hash ?? "no hash recorded"}); export or dismiss its record first. Nothing is resubmitted.`);
        return;
      }
      showReview(signed, sha, source, p, live, signer);
    })();
  };

  const showReview = (signed: Signable, sha: string, source: string, p: NetworkProfile, live: LiveState, signer: SignerInfo): void => {
    const intent = signed.view;
    const a = intent.actions[0];
    const confirm = h(doc, "button", "primary", signer.kind === "local" ? "Sign with the local sandbox test signer" : signer.kind === "wallet" ? `Sign in ${signer.label}` : "I will sign it with the near CLI");
    confirm.setAttribute("type", "button");
    confirm.setAttribute("id", "review-confirm");
    const cancel = h(doc, "button", "", "Cancel");
    cancel.setAttribute("type", "button");
    cancel.setAttribute("id", "review-cancel");
    const panel = h(
      doc,
      "div",
      "review",
      h(doc, "h3", "", `Review: ${actionTitle(intent.action, intent.asset)}`),
      kvList(doc, [
        ["Network", `${p.label} · chain id ${intent.network.chain_id} · genesis ${intent.network.genesis_hash}`],
        ["Signer", `${intent.signer_id}${intent.public_key === null ? "" : ` · key ${intent.public_key}`}`],
        ["Receiver", intent.receiver_id],
        ["Method", a?.method ?? "?"],
        ["Arguments", canonicalJson(a?.args)],
        ["Gas", `${a?.gas ?? "?"} (${a === undefined ? "?" : (BigInt(a.gas) / 1000000000000n).toString()} TGas)`],
        ["Deposit", `${a?.deposit ?? "?"} yoctoNEAR`],
        ["Intent sha256", sha],
        ["Source", source],
      ]),
      h(doc, "p", "muted", "This is the complete transaction: one function call. The page holds no key; the signer below signs outside it."),
      h(doc, "p", "buttons", confirm, " ", cancel),
    );
    ui.review.replaceChildren(panel);
    cancel.addEventListener("click", () => {
      ui.review.replaceChildren();
      say("Cancelled before signing: nothing was sent to any signer.");
    });
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      cancel.disabled = true;
      if (signer.kind === "manual") manualHandoff(signed, sha, p, live);
      else if (signer.kind === "wallet") void signWallet(signed, sha, p, live);
      else void signLocal(signed, sha, p, live);
    });
  };

  const newRecord = (signed: Signable, sha: string, adapter: AdapterKind, p: NetworkProfile, live: LiveState, phase: Phase, tx: string | null): PendingRecord => ({
    v: 1,
    intent_sha256: sha,
    intent: signed.view,
    source: signed.source,
    stem: signed.stem,
    adapter,
    rpc_url: live.rpc_url,
    mandate_id: live.mandate_id,
    profile_id: p.id,
    phase,
    tx_hash: tx,
    public_key: signed.view.public_key,
    baseline: baselineOf(signed.view, live),
    started_at: env.now(),
    note: "",
    outcome: null,
    end_state: null,
    problems: [],
  });

  const signLocal = async (signed: Signable, sha: string, p: NetworkProfile, live: LiveState): Promise<void> => {
    if (data.local_signer === null) return;
    const rec = newRecord(signed, sha, "local", p, live, "awaiting-signature", null);
    if (!saveRecord(env.store, rec)) say("Warning: this browser cannot persist the pending action; a reload would lose track of it (nothing would be resubmitted).");
    renderActivity();
    renderActions();
    const res = await localSign(env.localFetch, data.local_signer, signed.raw, sha, data.timeout_ms);
    ui.review.replaceChildren();
    if (res.status === "submitted") {
      saveRecord(env.store, { ...rec, phase: "submitted", tx_hash: res.tx_hash, public_key: res.public_key ?? rec.public_key });
      say(`Submitted ${res.tx_hash}; waiting for the final outcome. Nothing will be resubmitted.`);
      poll(sha);
    } else if (res.status === "error") {
      saveRecord(env.store, { ...rec, note: `the signer did not answer (${res.error}); the transaction may or may not have been sent. Not resubmitted: ask the signer for its record or paste the hash.` });
      say(`Outcome unknown: ${res.error}. Nothing is resubmitted.`);
    } else {
      dropRecord(env.store, sha);
      say(
        res.status === "cancelled"
          ? `Signature cancelled in the signer (${res.reason}): nothing was submitted.`
          : `${res.status === "rejected" ? "Rejected before inclusion" : "Refused by the signer"}: ${res.error}. Nothing was submitted; review again to retry deliberately.`,
      );
    }
    renderActivity();
    renderActions();
  };

  /** Exactly one signAndSendTransaction request to the connected wallet; never retried. */
  const signWallet = async (signed: Signable, sha: string, p: NetworkProfile, live: LiveState): Promise<void> => {
    const wallet = st.wallet;
    const cfg = data.wallets?.profiles[p.id];
    if (wallet === null || cfg === undefined) return;
    const rec = { ...newRecord(signed, sha, "wallet", p, live, "awaiting-signature", null), note: `asked ${wallet.manifest.name} to sign` };
    if (!saveRecord(env.store, rec)) say("Warning: this browser cannot persist the pending action; a reload would lose track of it (nothing would be resubmitted).");
    renderActivity();
    renderActions();
    let result: unknown;
    try {
      result = await wallet.signAndSendTransaction(walletParams(signed.view, cfg.network));
    } catch (e) {
      // A wallet's error does not show whether it sent anything (a closed prompt can follow an approval in the
      // wallet's own window), so the action stays pending until the owner pastes a hash or forgets the record.
      ui.review.replaceChildren();
      const text = e instanceof Error ? e.message : typeof e === "string" ? e : canonicalJson(e);
      saveRecord(env.store, { ...rec, note: `the wallet ended the request without a transaction hash (${text}). It may or may not have sent one. Nothing is resubmitted: if you rejected it in the wallet, forget this record; if a transaction was sent, paste its hash.` });
      say(`The wallet ended the request: ${text}. The action stays pending until you paste a hash or forget the record; nothing is resubmitted.`);
      renderActivity();
      renderActions();
      return;
    }
    ui.review.replaceChildren();
    const hash = walletTxHash(result);
    if (hash === null) {
      saveRecord(env.store, { ...rec, note: "the wallet answered without a transaction hash. Not resubmitted: paste the hash below if a transaction was sent, or forget this record." });
      say("The wallet returned no transaction hash. Nothing is resubmitted.");
    } else {
      saveRecord(env.store, { ...rec, phase: "submitted", tx_hash: hash, note: "" });
      say(`Submitted ${hash} from ${wallet.manifest.name}; waiting for the final outcome. Nothing will be resubmitted.`);
      poll(sha);
    }
    renderActivity();
    renderActions();
  };

  /** Starts tracking a hash the owner pastes for a record still awaiting its signature (wallet or interrupted). */
  const trackPasted = (r: PendingRecord, hash: string): void => {
    if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) {
      say("That is not a NEAR transaction hash.");
      return;
    }
    saveRecord(env.store, { ...r, phase: "submitted", tx_hash: hash, note: "hash pasted by the owner; the console checks that it is exactly this intent" });
    renderActivity();
    renderActions();
    poll(r.intent_sha256);
  };

  const manualHandoff = (signed: Signable, sha: string, p: NetworkProfile, live: LiveState): void => {
    const intent = signed.view;
    const input = h(doc, "input", "");
    input.setAttribute("id", "manual-hash");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("placeholder", "transaction hash (base58)");
    const track = h(doc, "button", "primary", "Track this transaction");
    track.setAttribute("type", "button");
    track.setAttribute("id", "manual-track");
    const close = h(doc, "button", "", "Close without tracking");
    close.setAttribute("type", "button");
    ui.review.replaceChildren(
      h(
        doc,
        "div",
        "review",
        h(doc, "h3", "", "Sign outside this page"),
        h(doc, "p", "", "Run this exact command where your owner key lives (near-cli-rs). Choose your own signing method instead of sign-with-keychain if needed; any other change to the command makes the transaction differ from this intent."),
        h(doc, "pre", "commands", cliCommand(intent, p)),
        h(doc, "p", "", `Intent sha256 ${sha}`),
        h(doc, "p", "verify-controls", input, " ", track, " ", close),
      ),
    );
    close.addEventListener("click", () => {
      ui.review.replaceChildren();
      say("Closed: nothing is tracked. If you signed, review again and paste the hash.");
    });
    track.addEventListener("click", () => {
      const hash = input.value.trim();
      if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) {
        say("That is not a NEAR transaction hash.");
        return;
      }
      saveRecord(env.store, newRecord(signed, sha, "manual", p, live, "submitted", hash));
      ui.review.replaceChildren();
      say(`Tracking ${hash}. The console checks that it is exactly this intent; nothing is submitted by the page.`);
      renderActivity();
      renderActions();
      poll(sha);
    });
  };

  /** Read-only: polls the transaction and the contract until the action is final. Never sends anything. */
  const poll = (sha: string): void => {
    if (st.polling.has(sha)) return;
    st.polling.add(sha);
    const step = async (): Promise<void> => {
      const r = records().find((x) => x.intent_sha256 === sha);
      if (r === undefined || r.phase === "final") {
        st.polling.delete(sha);
        return;
      }
      if (r.tx_hash === null) {
        st.polling.delete(sha);
        return;
      }
      const p = profileOf(r.profile_id);
      const call = callFor(r.rpc_url);
      const chain = await checkNetwork(call, r.intent.network);
      if (!chain.ok) {
        saveRecord(env.store, { ...r, note: `not polled: ${chain.reasons.join("; ")}` });
        renderActivity();
        env.later(() => void step(), data.poll_ms * 4);
        return;
      }
      const tx = await call("tx", { tx_hash: r.tx_hash, sender_account_id: r.intent.signer_id, wait_until: "NONE" });
      const txo = tx.ok ? asObject(tx.result) : null;
      const status = asString(txo?.final_execution_status);
      if (txo === null || status !== "FINAL") {
        saveRecord(env.store, { ...r, note: tx.ok ? `transaction ${status ?? "seen"}; waiting for FINAL` : `not seen by the RPC yet (${tx.error})` });
        renderActivity();
        env.later(() => void step(), data.poll_ms);
        return;
      }
      const outcome = chainOutcome(txo);
      const problems = txProblems(txo, r.intent, r.tx_hash);
      const live = await readLive(call, p, r.rpc_url, r.mandate_id);
      if (outcome === "unknown") {
        env.later(() => void step(), data.poll_ms);
        return;
      }
      const end = endState(r, live, outcome);
      if (!end.settled) {
        saveRecord(env.store, { ...r, note: `transaction final (${outcome}); contract: ${end.text}` });
        renderActivity();
        env.later(() => void step(), data.poll_ms);
        return;
      }
      saveRecord(env.store, { ...r, phase: "final", outcome, end_state: end.text, problems, public_key: r.public_key ?? asString(asObject(txo.transaction)?.public_key), note: `${receiptViews(txo).length.toString()} receipts, ${statusKind(txo.status)} at the top level` });
      st.polling.delete(sha);
      if (st.live?.profile_id === p.id) {
        st.live = live;
        ui.live.replaceChildren(renderLive(doc, p, live));
      }
      say(`Final: ${actionTitle(r.intent.action, r.intent.asset)} — ${outcome}. ${end.text}`);
      renderActivity();
      renderActions();
    };
    void step().catch((e: unknown) => {
      st.polling.delete(sha);
      say(`Polling stopped: ${rpcErrorText(e)}. Reload to resume polling; nothing is resubmitted.`);
    });
  };

  /** Asks the local signer for its record of an intent whose response was lost (read-only). */
  const recoverHash = async (r: PendingRecord): Promise<void> => {
    if (data.local_signer === null) return;
    const res = await localRequest(env.localFetch, `${data.local_signer}/signer/record?intent_sha256=${r.intent_sha256}`, undefined, data.timeout_ms);
    const found = res.ok ? res.value : null;
    const hash = asString(found?.tx_hash);
    if (found === null || hash === null) {
      saveRecord(env.store, { ...r, note: `unresolved, no transaction hash: ${res.ok ? (asString(res.value.error) ?? "the signer has no record") : res.error}. Nothing is resubmitted. If the signer was still asking for confirmation, ask it for its record again once it has answered; otherwise dismiss this record.` });
      renderActivity();
      return;
    }
    saveRecord(env.store, { ...r, phase: "submitted", tx_hash: hash, public_key: asString(found.public_key) ?? r.public_key, note: "hash recovered from the signer's record after an interrupted request" });
    renderActivity();
    poll(r.intent_sha256);
  };

  function renderActivity(): void {
    const recs = records();
    if (recs.length === 0) {
      ui.activity.replaceChildren(h(doc, "p", "muted", "No owner action in this browser yet."));
      return;
    }
    const list = h(doc, "ol", "vitems");
    for (const r of recs) {
      const cls = r.phase === "final" ? (r.outcome === "success" && r.problems.length === 0 ? "verified" : "failed") : "inconclusive";
      const badge = r.phase === "final" ? pill(doc, cls === "verified" ? "success" : "failure", `final · ${r.outcome ?? "?"}`) : pill(doc, "inconclusive", r.phase === "submitted" ? "pending" : "awaiting signature");
      const li = h(doc, "li", `vitem ${cls}`);
      li.setAttribute("data-record", r.intent_sha256);
      li.setAttribute("data-phase", r.phase);
      li.append(
        h(doc, "p", "", badge, ` ${actionTitle(r.intent.action, r.intent.asset)}`),
        kvList(doc, [
          ["Transaction", r.tx_hash ?? "no hash yet"],
          ["Signer", `${r.intent.signer_id} via ${adapterText(r.adapter, null)}`],
          ["Intent sha256", r.intent_sha256],
          ["Started", r.started_at],
          ...(r.end_state === null ? [] : ([["Contract state", r.end_state]] as [string, string][])),
          ...(r.note === "" ? [] : ([["Status", r.note]] as [string, string][])),
        ]),
      );
      if (r.problems.length > 0) li.append(h(doc, "p", "why", "The transaction does not match the intent:"), h(doc, "ul", "reasons", ...r.problems.map((x) => h(doc, "li", "", x))));
      const handoff = handoffOf(r);
      if (handoff !== null) {
        const text = JSON.stringify(handoff, null, 2);
        const pre = h(doc, "pre", "handoff", text);
        pre.setAttribute("data-handoff", r.intent_sha256);
        const dl = h(doc, "button", "", "Download handoff for the runner");
        dl.setAttribute("type", "button");
        dl.addEventListener("click", () => {
          env.download(`${r.stem ?? `console-${r.intent_sha256.slice(0, 12)}`}.handoff.json`, `${text}\n`);
        });
        li.append(h(doc, "p", "muted", r.stem === null ? "Handoff of a console intent: the runner refuses it unless it persisted this exact intent." : `Save as ${r.stem}.handoff.json next to the runner's intent file; the runner imports the transaction by hash and verifies it on chain.`), pre, dl);
      }
      if (r.phase === "awaiting-signature" && r.adapter === "local" && !st.polling.has(r.intent_sha256)) {
        const ask = h(doc, "button", "", "Ask the local signer for its record");
        ask.setAttribute("type", "button");
        ask.addEventListener("click", () => void recoverHash(r));
        li.append(ask);
      }
      if (r.phase === "awaiting-signature" && r.adapter === "wallet") {
        const input = h(doc, "input", "");
        input.setAttribute("data-paste", r.intent_sha256);
        input.setAttribute("spellcheck", "false");
        input.setAttribute("autocomplete", "off");
        input.setAttribute("placeholder", "transaction hash (base58), if the wallet sent it");
        const track = h(doc, "button", "", "Track this hash");
        track.setAttribute("type", "button");
        track.setAttribute("data-track", r.intent_sha256);
        track.addEventListener("click", () => {
          trackPasted(r, input.value.trim());
        });
        li.append(h(doc, "p", "verify-controls", input, " ", track));
      }
      const dismiss = h(doc, "button", "", r.phase === "final" ? "Dismiss" : r.adapter === "wallet" ? "I rejected it in the wallet: forget this record" : "Forget this pending record");
      dismiss.setAttribute("type", "button");
      dismiss.setAttribute("data-dismiss", r.intent_sha256);
      dismiss.addEventListener("click", () => {
        dropRecord(env.store, r.intent_sha256);
        st.polling.delete(r.intent_sha256);
        renderActivity();
        renderActions();
      });
      li.append(" ", dismiss);
      list.append(li);
    }
    ui.activity.replaceChildren(list);
  }

  ui.profile.addEventListener("change", applyProfile);
  ui.read.addEventListener("click", () => void refresh());
  ui.signerConnect.addEventListener("click", () => void connect());
  ui.intentLoad.addEventListener("click", () => void loadIntent());
  ui.intentClear.addEventListener("click", () => {
    st.intent = null;
    ui.intentText.value = "";
    ui.intentStatus.textContent = "No runner intent loaded: the console signs its own preview.";
    renderActions();
  });
  ui.signerKind.addEventListener("change", () => {
    ui.signerAccount.hidden = ui.signerKind.value !== "manual";
    st.signer = null;
    st.wallet = null;
    ui.signerStatus.textContent = "Not connected.";
    renderActions();
  });
  ui.signerAccount.hidden = ui.signerKind.value !== "manual";
  applyProfile();
  renderActivity();
  // A reload during a pending action resumes polling only; an interrupted signing request is resolved by asking
  // the signer for its record. Nothing is ever signed or sent again automatically.
  for (const r of records()) {
    if (r.phase === "submitted") poll(r.intent_sha256);
    else if (r.phase === "awaiting-signature" && r.adapter === "local") void recoverHash(r);
    else if (r.phase === "awaiting-signature" && r.adapter === "wallet") {
      saveRecord(env.store, { ...r, note: "interrupted while the wallet was asked to sign (reload). Nothing is resubmitted: paste the hash if the wallet sent it, or forget this record." });
    }
  }
  renderActivity();
}

/** The console's own functions in the inline script, after the shared page helpers (render.ts). */
export const CONSOLE_FUNCTIONS: readonly ((...args: never[]) => unknown)[] = [
  fmtUnits,
  fmtShort,
  bpsText,
  policyLines,
  grantStatusText,
  shortHash,
  checkNetwork,
  viewAt,
  readLive,
  deploymentProblems,
  actionKey,
  actionTitle,
  buildIntent,
  intentDiff,
  ownerGate,
  actionGate,
  cliCommand,
  walletParams,
  walletTxHash,
  adapterText,
  txProblems,
  baselineOf,
  endState,
  storeKey,
  loadRecords,
  saveRecord,
  dropRecord,
  handoffOf,
  fromRunner,
  localRequest,
  localSign,
  h,
  kvList,
  pill,
  liveBadge,
  renderLive,
  install,
];
