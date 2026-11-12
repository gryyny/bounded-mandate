// gate: LAB — two simultaneous lab sessions share one sandbox process and nothing else; visitors reach only the
// listed actions and views; and one client's flood leaves the service usable for another. Runs on the exact
// deployment candidate, the pinned verifier and the hash-pinned prebuilt TEST DOUBLES (MPC signer, price oracle,
// tokens). Several clients are told apart by X-Forwarded-For, which these labs are configured to trust.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PRICES } from "../src/demo/market.js";
import { CaseRecorder } from "../src/evidence/report.js";
import { ACTIONS, type ActionRecord } from "../src/lab/actions.js";
import { LAB_POLICY } from "../src/lab/config.js";
import type { SessionView } from "../src/lab/lab.js";
import { STARTING_BALANCES } from "../src/lab/world.js";
import { act, labWasm, proposed, serve, startSession, view, type Reply, type Served } from "./lab-helpers.js";

const cases = {
  isolation: new CaseRecorder("LAB", "isolation", ["separate-worlds-one-process", "balances", "signer", "oracle", "authority", "no-shared-time-control"]),
  refusals: new CaseRecorder("LAB", "refusals", ["unlisted-action", "raw-rpc", "malformed-input-sends-nothing", "rpc-address-never-served", "health-and-cross-origin"]),
  flood: new CaseRecorder("LAB", "flood-limits", ["per-client-session-and-start-limits", "one-action-in-flight", "body-and-action-limits", "flood-leaves-others-served", "expiry-cleans-up-and-recycles", "stuck-action-frees-the-slot"]),
};

const A = "198.51.100.31";
const B = "198.51.100.32";
const ALLOWED_ORIGIN = "https://evidence.example";
const USDC_50 = (50n * 10n ** 6n).toString();
const propose50 = { sell: "usdc", sell_amount: USDC_50, max_concession_bps: 20 };

let lab: Served;
let a: SessionView;
let b: SessionView;
const bound: { wasm: Record<string, string>; data: Record<string, unknown> }[] = [];

beforeAll(async () => {
  lab = await serve({ allowedOrigin: ALLOWED_ORIGIN });
  bound.push(labWasm(lab.lab));
}, 60_000);

afterAll(async () => {
  for (const c of Object.values(cases)) c.write("sandbox", bound[0]?.wasm ?? {}, bound[0]?.data ?? {});
  await lab.close();
});

describe("two simultaneous sessions", () => {
  let wallStart = 0;
  let chainStart = 0n;

  // gate: LAB
  it("are two complete worlds under their own account names in one sandbox process", () => cases.isolation.check("separate-worlds-one-process", async () => {
    [a, b] = await Promise.all([startSession(lab, A), startSession(lab, B)]);
    expect(lab.lab.stats().pool).toMatchObject({ started: 1, running: 1, current: { served: 2, live: 2 } });
    const accountsA = Object.values(a.state.accounts);
    const accountsB = Object.values(b.state.accounts);
    expect(new Set([...accountsA, ...accountsB]).size).toBe(accountsA.length + accountsB.length);
    // Each world has its own mandate, verifier, oracle double, MPC double, tokens, owner, agent, filler and relayer.
    expect(Object.keys(a.state.accounts).sort()).toEqual(["agent", "filler", "mandate", "oracle_test_double", "owner", "relayer", "signer_test_double", "usdc_test_double", "verifier", "wnear_test_double"]);
    const scopeA = a.state.accounts.mandate.split(".")[1] ?? "";
    const scopeB = b.state.accounts.mandate.split(".")[1] ?? "";
    expect(scopeA).not.toBe(scopeB);
    for (const account of accountsA) expect(account.endsWith(`.${scopeA}.sandbox`)).toBe(true);
    for (const account of accountsB) expect(account.endsWith(`.${scopeB}.sandbox`)).toBe(true);
    wallStart = Date.now();
    chainStart = BigInt((await view(lab, b.session_id, B)).state.block_time_ns);
    const [ga, gb] = await Promise.all([act(lab, a.session_id, "grant", { policy: LAB_POLICY }, A), act(lab, b.session_id, "grant", { policy: LAB_POLICY }, B)]);
    expect([ga.state.grant?.status, gb.state.grant?.status]).toEqual(["active", "active"]);
    // Each grant's key is derived by that world's own MPC double for that world's own mandate.
    expect(ga.state.grant?.public_key).not.toBe(gb.state.grant?.public_key);
  }), 180_000);

  // gate: LAB
  it("a trade in one session leaves the other's balances and accounting untouched", () => cases.isolation.check("balances", async () => {
    const p = await act(lab, a.session_id, "propose", propose50, A);
    const filled = await act(lab, a.session_id, "fill", { order_id: proposed(p).id }, A);
    expect(filled.state.balances.mandate).not.toEqual(STARTING_BALANCES.mandate);
    expect(filled.state.balances.filler).not.toEqual(STARTING_BALANCES.filler);
    const other = await view(lab, b.session_id, B);
    expect(other.state.balances).toEqual(STARTING_BALANCES);
    expect(other.state.orders).toEqual([]);
    expect(other.state.grant?.turnover_used).toBe("0");
    expect(other.actions_used).toBe(1);
  }));

  // gate: LAB
  it("a failing signer double in one session does not stop the other's orders from being signed", () => cases.isolation.check("signer", async () => {
    await act(lab, a.session_id, "set_signer", { available: false }, A);
    const [pa, pb] = await Promise.all([act(lab, a.session_id, "propose", propose50, A), act(lab, b.session_id, "propose", propose50, B)]);
    expect(pa.state.signer_mode).toBe("immediate_error");
    expect(pb.state.signer_mode).toBe("immediate");
    expect(proposed(pa).state.state).toBe("sign_unknown");
    expect(proposed(pa).signature).toBeNull();
    expect(proposed(pb).state.state).toBe("signed");
    const back = await act(lab, a.session_id, "set_signer", { available: true }, A);
    expect(back.state.signer_mode).toBe("immediate");
  }));

  // gate: LAB
  it("another price, then a failing oracle double, in one session do not reach the other's prices", () => cases.isolation.check("oracle", async () => {
    // Half the wNEAR price in A only: A's treasury is then far below its starting value.
    const halved = (PRICES.wnear.price / 2n).toString();
    const moved = await act(lab, a.session_id, "set_oracle", { available: true, wnear_price: halved }, A);
    expect(moved.state.oracle).toMatchObject({ available: true, prices: { wnear: { price: halved } } });
    const [pa, pb] = await Promise.all([act(lab, a.session_id, "propose", propose50, A), act(lab, b.session_id, "propose", propose50, B)]);
    expect(proposed(pa).state).toEqual({ state: "rejected", reason: "loss breaker tripped" });
    expect(pa.state.grant?.breaker).not.toBeNull();
    expect(proposed(pb).state.state).toBe("signed");
    expect(proposed(pb).reference?.wnear.price).toBe(PRICES.wnear.price.toString());
    expect(pb.state.oracle).toMatchObject({ available: true, prices: { wnear: { price: PRICES.wnear.price.toString() } } });
    expect(pb.state.grant?.breaker).toBeNull();

    const failing = await act(lab, a.session_id, "set_oracle", { available: false }, A);
    expect(failing.state.oracle.available).toBe(false);
    const still = await act(lab, b.session_id, "propose", propose50, B);
    expect(still.state.oracle.available).toBe(true);
    expect(proposed(still).state.state).toBe("signed");
  }));

  // gate: LAB
  it("revoking in one session removes only that session's key: the other's withheld order still executes", () => cases.isolation.check("authority", async () => {
    const before = await view(lab, b.session_id, B);
    const open = before.state.orders.filter((o) => o.state.state === "signed");
    const target = open.at(-1);
    if (target === undefined) throw new Error("session B has no signed order");
    const held = await act(lab, b.session_id, "withhold", { order_id: target.id }, B);
    expect(held.result.executable_now).toBe(true);

    const revoked = await act(lab, a.session_id, "revoke", {}, A);
    expect(revoked.state.grant?.status).toBe("revoked");
    expect(revoked.state.key_on_verifier).toBe(false);

    const after = await view(lab, b.session_id, B);
    expect(after.state.grant?.status).toBe("active");
    expect(after.state.grant?.epoch).toBe(1);
    expect(after.state.key_on_verifier).toBe(true);
    const relayed = await act(lab, b.session_id, "relay", { order_id: target.id }, B);
    expect(relayed.result).toMatchObject({ executed: true, rejected_for_removed_key: false });
    expect(BigInt(relayed.state.balances.mandate.usdc)).toBe(BigInt(after.state.balances.mandate.usdc) - BigInt(target.sell_amount));
    expect(BigInt(relayed.state.balances.mandate.wnear)).toBe(BigInt(after.state.balances.mandate.wnear) + BigInt(target.buy_amount ?? "0"));

    // And the other way round: B's revocation changes nothing in A.
    const aBefore = await view(lab, a.session_id, A);
    const bRevoked = await act(lab, b.session_id, "revoke", {}, B);
    expect(bRevoked.state.grant?.status).toBe("revoked");
    const aAfter = await view(lab, a.session_id, A);
    expect({ ...aAfter.state, block_time_ns: "" }).toEqual({ ...aBefore.state, block_time_ns: "" });
  }));

  // gate: LAB
  it("no shared time control: the lab never moves the chain's clock, which ran at the wall clock's pace throughout", () => cases.isolation.check("no-shared-time-control", async () => {
    const chainNow = BigInt((await view(lab, b.session_id, B)).state.block_time_ns);
    const chainSec = Number((chainNow - chainStart) / 1_000_000n) / 1_000;
    const wallSec = (Date.now() - wallStart) / 1_000;
    // One fast-forwarded block interval would already be more than this.
    expect(Math.abs(chainSec - wallSec)).toBeLessThan(3);
    const dir = join(import.meta.dirname, "../src/lab");
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    expect(sources.length).toBeGreaterThan(5);
    for (const file of sources) expect(readFileSync(join(dir, file), "utf8"), file).not.toMatch(/fastForward|sandbox_fast_forward|sandbox_patch_state/);
    expect((await lab.api("POST", `/api/sessions/${a.session_id}/actions`, { action: "sandbox_fast_forward", input: { delta_height: 1000 } }, A)).status).toBe(400);
  }));
});

describe("only the listed actions and views", () => {
  const logLength = async (): Promise<number> => ((await lab.api("GET", `/api/sessions/${b.session_id}/log`, undefined, B)).body.log as ActionRecord[]).length;

  // gate: LAB
  it("refuses an action that is not listed", () => cases.refusals.check("unlisted-action", async () => {
    const before = await logLength();
    for (const action of ["fast_forward", "deploy", "rpc", "query", "constructor", "toString", "__proto__", "GRANT"]) {
      const r = await lab.api("POST", `/api/sessions/${b.session_id}/actions`, { action, input: {} }, B);
      expect([action, r.status, r.body.error]).toEqual([action, 400, "unlisted_action"]);
      expect(r.body.listed).toEqual(ACTIONS);
    }
    expect(((await lab.api("GET", "/api/actions")).body.actions as { action: string }[]).map((x) => x.action)).toEqual(ACTIONS);
    expect(await logLength()).toBe(before);
  }));

  // gate: LAB
  it("refuses a raw RPC request on every path", () => cases.refusals.check("raw-rpc", async () => {
    const before = await logLength();
    const status = { jsonrpc: "2.0", id: "1", method: "status", params: [] };
    const query = { jsonrpc: "2.0", id: "1", method: "query", params: { request_type: "view_account", finality: "optimistic", account_id: "sandbox" } };
    const fastForward = { jsonrpc: "2.0", id: "1", method: "sandbox_fast_forward", params: { delta_height: 100 } };
    for (const path of ["/", "/rpc", "/api", "/api/sessions", `/api/sessions/${b.session_id}/actions`, `/api/sessions/${b.session_id}`]) {
      for (const body of [status, query, fastForward, [status, query], { method: "status", params: [] }]) {
        const r = await lab.api("POST", path, body, B);
        expect([path, r.status, r.body.error]).toEqual([path, 400, "raw_rpc_refused"]);
        expect(r.body.result).toBeUndefined();
        expect(r.text).not.toContain("chain_id");
      }
    }
    // Wrapped in the lab's own envelope it is an unlisted action, refused as one.
    const wrapped = await lab.api("POST", `/api/sessions/${b.session_id}/actions`, { action: "query", input: query }, B);
    expect([wrapped.status, wrapped.body.error]).toEqual([400, "unlisted_action"]);
    for (const [method, path] of [["GET", "/status"], ["GET", "/rpc"], ["GET", "/api/sessions"], ["PUT", "/api/health"], ["GET", `/api/sessions/${"0".repeat(32)}`]] as const) {
      const r = await lab.api(method, path, undefined, B);
      expect([404, 405]).toContain(r.status);
    }
    expect(await logLength()).toBe(before);
  }));

  // gate: LAB
  it("refuses malformed requests before anything is sent", () => cases.refusals.check("malformed-input-sends-nothing", async () => {
    const before = await view(lab, b.session_id, B);
    const send = (body: unknown) => lab.api("POST", `/api/sessions/${b.session_id}/actions`, body, B);
    const bad: [unknown, string][] = [
      [{ action: "propose", input: { sell: "usdc", sell_amount: "-5", max_concession_bps: 20 } }, "invalid_input"],
      [{ action: "propose", input: { sell: "btc", sell_amount: "5", max_concession_bps: 20 } }, "invalid_input"],
      [{ action: "propose", input: { sell: "usdc", sell_amount: "5", max_concession_bps: 20, recipient: "evil.near" } }, "invalid_input"],
      [{ action: "propose", input: { sell: "usdc", sell_amount: "5", max_concession_bps: 70_000 } }, "invalid_input"],
      [{ action: "grant", input: { policy: { ...LAB_POLICY, per_order_cap_bps: 1.5 } } }, "invalid_input"],
      [{ action: "grant", input: { policy: { ...LAB_POLICY, owner_id: "evil.near" } } }, "invalid_input"],
      [{ action: "fill", input: { order_id: "0; drop" } }, "invalid_input"],
      [{ action: "revoke", input: { network: "mainnet" } }, "invalid_input"],
      [{ action: "revoke", input: {}, rpc_url: "https://rpc.mainnet.near.org" }, "invalid_request"],
      [{ input: {} }, "invalid_request"],
      ["{not json", "invalid_json"],
    ];
    for (const [body, error] of bad) {
      const r = await send(body);
      expect([JSON.stringify(body), r.status, r.body.error]).toEqual([JSON.stringify(body), 400, error]);
    }
    const after = await view(lab, b.session_id, B);
    expect(after.actions_used).toBe(before.actions_used);
    expect({ ...after.state, block_time_ns: "" }).toEqual({ ...before.state, block_time_ns: "" });
  }));

  // gate: LAB
  it("never tells a visitor where the sandbox RPC is", () => cases.refusals.check("rpc-address-never-served", async () => {
    const [rpcUrl] = lab.lab.stats().rpcUrls;
    if (rpcUrl === undefined) throw new Error("no sandbox process");
    const rpcPort = new URL(rpcUrl).port;
    expect(rpcPort).not.toBe(String(lab.server.port));
    const page = await (await fetch(`${lab.server.origin}/`)).text();
    const replies = [
      page,
      (await lab.api("GET", "/api/health")).text,
      (await lab.api("GET", "/api/actions")).text,
      (await lab.api("GET", `/api/sessions/${b.session_id}`, undefined, B)).text,
      (await lab.api("GET", `/api/sessions/${b.session_id}/log`, undefined, B)).text,
      (await lab.api("GET", `/api/sessions/${b.session_id}/export`, undefined, B)).text,
    ];
    for (const text of replies) {
      expect(text).not.toContain(`:${rpcPort}`);
      expect(text).not.toContain(rpcUrl);
    }
    // The sandbox node itself listens on loopback only.
    expect(new URL(rpcUrl).hostname).toBe("127.0.0.1");
  }));

  // gate: LAB
  it("health names the service and its mode, and is readable across origins only from the allowed origin", () => cases.refusals.check("health-and-cross-origin", async () => {
    const allowed = await lab.api("GET", "/api/health", undefined, B, { origin: ALLOWED_ORIGIN });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ service: "bounded-mandate-lab", mode: "sandbox", ok: true });
    expect((allowed.body.test_doubles as { role: string }[]).map((d) => d.role)).toEqual(["MPC signer", "price oracle", "USDC and wNEAR tokens"]);
    expect(allowed.headers.get("access-control-allow-origin")).toBe(ALLOWED_ORIGIN);
    expect(allowed.headers.get("vary")).toBe("Origin");
    const other = await lab.api("GET", "/api/health", undefined, B, { origin: "https://elsewhere.example" });
    expect(other.status).toBe(200);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    expect((await lab.api("GET", "/api/health", undefined, B)).headers.get("access-control-allow-origin")).toBeNull();
    // Everything else is for the lab's own page: another origin, the allowed one included, is refused before any effect.
    const before = await view(lab, b.session_id, B);
    for (const origin of [ALLOWED_ORIGIN, "https://elsewhere.example", "null"]) {
      for (const [method, path, body] of [
        ["GET", "/api/actions", undefined],
        ["GET", `/api/sessions/${b.session_id}`, undefined],
        ["POST", "/api/sessions", undefined],
        ["POST", `/api/sessions/${b.session_id}/actions`, { action: "set_signer", input: { available: false } }],
        ["POST", `/api/sessions/${b.session_id}/reset`, undefined],
        ["DELETE", `/api/sessions/${b.session_id}`, undefined],
      ] as const) {
        const r = await lab.api(method, path, body, B, { origin });
        expect([origin, method, path, r.status, r.body.error]).toEqual([origin, method, path, 403, "cross_origin_refused"]);
        expect(r.headers.get("access-control-allow-origin")).toBeNull();
      }
    }
    // The page's own requests carry the lab's origin and pass.
    const own = await lab.api("GET", `/api/sessions/${b.session_id}`, undefined, B, { origin: lab.server.origin });
    expect(own.status).toBe(200);
    expect({ ...(own.body.session as SessionView).state, block_time_ns: "" }).toEqual({ ...before.state, block_time_ns: "" });
    expect(lab.lab.stats().sessions).toBe(2);
  }));
});

describe("a flood from one client", () => {
  const X = "198.51.100.41";
  const Y = "198.51.100.42";
  const Z = "198.51.100.43";
  let small: Served;
  let x: SessionView;
  let y: SessionView;
  let firstRpc = "";

  beforeAll(async () => {
    small = await serve({
      maxSessions: 2,
      maxSessionsPerClient: 1,
      maxConcurrentStarts: 2,
      sessionStartsPerHour: 2,
      requestsPerMinute: 60,
      sessionIdleSec: 30,
      sessionMaxSec: 600,
      maxActions: 4,
      maxBodyBytes: 1_024,
      recycleAfterSessions: 2,
    });
  });

  afterAll(async () => {
    await small.close();
  });

  // gate: LAB
  it("gets one session and a bounded number of worlds, however many it asks for", () => cases.flood.check("per-client-session-and-start-limits", async () => {
    const burst = await Promise.all(Array.from({ length: 8 }, () => small.api("POST", "/api/sessions", undefined, X)));
    const created = burst.filter((r) => r.status === 201);
    expect(created).toHaveLength(1);
    for (const r of burst.filter((r) => r.status !== 201)) expect([r.status, r.body.error]).toEqual([429, "client_start_in_flight"]);
    x = created[0]?.body.session as SessionView;
    expect((await small.api("POST", "/api/sessions", undefined, X)).body.error).toBe("client_session_limit");
    [firstRpc = ""] = small.lab.stats().rpcUrls;
    // A reset builds a world too: the second start of the hour is allowed, the third is not.
    const reset = await small.api("POST", `/api/sessions/${x.session_id}/reset`, undefined, X);
    expect(reset.status, reset.text).toBe(200);
    const again = await small.api("POST", `/api/sessions/${x.session_id}/reset`, undefined, X);
    expect([again.status, again.body.error]).toEqual([429, "client_start_limit"]);
    expect(small.lab.stats()).toMatchObject({ sessions: 1, starting: 0 });
  }), 180_000);

  // gate: LAB
  it("runs one action at a time in a session", () => cases.flood.check("one-action-in-flight", async () => {
    const burst = await Promise.all(Array.from({ length: 5 }, () => small.api("POST", `/api/sessions/${x.session_id}/actions`, { action: "grant", input: { policy: LAB_POLICY } }, X)));
    expect(burst.filter((r) => r.status === 200)).toHaveLength(1);
    for (const r of burst.filter((r) => r.status !== 200)) expect([r.status, r.body.error]).toEqual([409, "action_in_flight"]);
    const after = await view(small, x.session_id, X);
    expect(after.actions_used).toBe(1);
    expect(after.state.grant?.epoch).toBe(1);
  }));

  // gate: LAB
  it("limits request bodies and the actions of one session", () => cases.flood.check("body-and-action-limits", async () => {
    const big = await fetch(`${small.server.origin}/api/sessions/${x.session_id}/actions`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": X }, body: JSON.stringify({ action: "revoke", input: {}, pad: "x".repeat(4_096) }) });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "body_too_large", mode: "sandbox" });
    for (let i = 0; i < 3; i += 1) await act(small, x.session_id, "set_signer", { available: i % 2 === 1 }, X);
    const over = await small.api("POST", `/api/sessions/${x.session_id}/actions`, { action: "revoke", input: {} }, X);
    expect([over.status, over.body.error]).toEqual([429, "session_action_limit"]);
    expect((await view(small, x.session_id, X)).state.grant?.status).toBe("active");
  }));

  // gate: LAB
  it("leaves another client served while it floods requests", () => cases.flood.check("flood-leaves-others-served", async () => {
    y = await startSession(small, Y);
    const flood = async (): Promise<{ statuses: number[]; last: Reply }> => {
      const statuses: number[] = [];
      for (let round = 0; round < 6; round += 1) {
        const replies = await Promise.all(Array.from({ length: 40 }, (_, i) => small.api(i % 2 === 0 ? "GET" : "POST", i % 2 === 0 ? `/api/sessions/${x.session_id}` : "/api/sessions", undefined, X)));
        statuses.push(...replies.map((r) => r.status));
      }
      return { statuses, last: await small.api("GET", "/api/health", undefined, X) };
    };
    const other = async (): Promise<ActionRecord> => {
      await act(small, y.session_id, "grant", { policy: LAB_POLICY }, Y);
      const p = await act(small, y.session_id, "propose", propose50, Y);
      return act(small, y.session_id, "fill", { order_id: proposed(p).id }, Y);
    };
    const [flooded, filled] = await Promise.all([flood(), other()]);
    // The flooding client is cut off at its request rate; none of its extra session requests succeeded.
    expect(flooded.statuses.filter((s) => s === 429).length).toBeGreaterThan(150);
    expect(flooded.statuses.filter((s) => s === 201)).toEqual([]);
    expect([flooded.last.status, flooded.last.body.error]).toEqual([429, "client_request_limit"]);
    expect(Number(flooded.last.headers.get("retry-after"))).toBeGreaterThan(0);
    // The other client's whole trade went through during the flood.
    expect(filled.transactions.map((t) => [t.method, t.success])).toEqual([["execute_intents", true], ["settle_order", true]]);
    expect(filled.state.balances.mandate).not.toEqual(STARTING_BALANCES.mandate);
    expect((await small.api("GET", "/api/health", undefined, Y)).status).toBe(200);
    // Both slots are taken: a third client is told so, and nothing is built for it.
    const full = await small.api("POST", "/api/sessions", undefined, Z);
    expect([full.status, full.body.error]).toEqual([503, "lab_full"]);
    const stats = small.lab.stats();
    expect(stats).toMatchObject({ sessions: 2, starting: 0 });
    // X's session and its reset used up the first process (two worlds); Y's world started the second.
    expect(stats.pool).toMatchObject({ started: 2, running: 2, draining: 1 });
  }), 180_000);

  // gate: LAB
  it("ends idle sessions, stops the used-up sandbox process and serves the next client from a fresh one", () => cases.flood.check("expiry-cleans-up-and-recycles", async () => {
    const deadline = Date.now() + 90_000;
    while (small.lab.stats().sessions > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 500));
    const stats = small.lab.stats();
    expect(stats.sessions).toBe(0);
    expect(stats.pool).toMatchObject({ started: 2, running: 1, draining: 0 });
    expect(stats.rpcUrls).not.toContain(firstRpc);
    // The first process is gone, not just forgotten.
    await expect(fetch(firstRpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "status", params: [] }) })).rejects.toThrow();
    for (const id of [x.session_id, y.session_id]) {
      const gone = await small.api("GET", `/api/sessions/${id}`, undefined, Z);
      expect([gone.status, gone.body.error]).toEqual([404, "no_session"]);
    }
    const z = await startSession(small, Z);
    expect(z.state.balances).toEqual(STARTING_BALANCES);
    expect(z.state.grant).toBeNull();
    expect(small.lab.stats().pool.running).toBeLessThanOrEqual(2);
  }), 180_000);

  // gate: LAB
  it("ends a session whose action does not complete in time, freeing its slot", () => cases.flood.check("stuck-action-frees-the-slot", async () => {
    // A lab whose time allowance no action can meet stands in for a stuck action.
    const strict = await serve({ maxSessions: 1 }, 50);
    try {
      const s = await startSession(strict, X);
      const r = await strict.api("POST", `/api/sessions/${s.session_id}/actions`, { action: "grant", input: { policy: LAB_POLICY } }, X);
      expect([r.status, r.body.error]).toEqual([504, "action_timeout"]);
      const gone = await strict.api("GET", `/api/sessions/${s.session_id}`, undefined, X);
      expect([gone.status, gone.body.error]).toEqual([404, "no_session"]);
      expect(strict.lab.stats()).toMatchObject({ sessions: 0, starting: 0, pool: { current: { live: 0 } } });
      // The single slot is free again for another client.
      const next = await startSession(strict, Y);
      expect(next.state.grant).toBeNull();
    } finally {
      await strict.close();
    }
  }), 180_000);
});
