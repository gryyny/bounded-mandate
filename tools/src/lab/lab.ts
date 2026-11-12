// The lab service without its transport: sessions, their worlds, limits and cleanup. A session is one visitor's
// sandbox treasury; its id is an unguessable token. Limits are per client and global, so one client can use up only
// its own allowance: a share of the session slots, one world under construction, a number of worlds per hour, a
// request rate, and one action in flight per session.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REPO_ROOT } from "../near/sandbox.js";
import { loadPrebuilt, type PrebuiltSet } from "../quick/prebuilt.js";
import { ACTIONS, ACTION_HELP, InputError, isAction, runAction, type ActionRecord } from "./actions.js";
import { LAB_LABEL, LAB_MODE, LAB_POLICY, LAB_SERVICE, TEST_DOUBLES, type LabConfig } from "./config.js";
import { LabUnavailable, SandboxPool, type PoolStats } from "./pool.js";
import { exportScenario, sourceRevision, type Scenario, type SourceRevision } from "./scenario.js";
import { LEASE_BUDGET_NEAR, WORLD_NEAR, createLabWorld, destroyLabWorld, labState, type LabState, type LabWorld } from "./world.js";

/** A refusal with its HTTP status and a stable code. */
export class LabError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

interface Session {
  id: string;
  client: string;
  createdAt: number;
  lastUsedAt: number;
  busy: boolean;
  lw: LabWorld;
  startingState: LabState;
  log: ActionRecord[];
  resets: number;
}

export interface SessionView {
  session_id: string;
  created_at: string;
  /** The session ends at this time at the latest, or earlier after `idle_sec` without a request. */
  ends_at: string;
  idle_sec: number;
  busy: boolean;
  resets: number;
  actions_used: number;
  actions_max: number;
  state: LabState;
}

export interface LabOptions {
  config: LabConfig;
  /** Repository root holding fixtures/ (the pinned WASM set). */
  root?: string;
  /** Revision a deployment without a git checkout declares (LAB_SOURCE_REVISION). */
  declaredRevision?: string;
  /** Longest an action may run before its session is ended; the default suits every listed action. */
  actionTimeoutMs?: number;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
/** Longest an action may run (the slowest, a comparison that waits for an expiry, takes about 15 s). */
const ACTION_TIMEOUT_MS = 120_000;

class ActionTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ActionTimeout());
    }, ms);
  });
  // Abandoned work may still fail later; that failure has no one left to report to.
  work.catch(() => undefined);
  return Promise.race([work, expired]).finally(() => {
    clearTimeout(timer);
  });
}

export class Lab {
  private readonly sessions = new Map<string, Session>();
  /** Worlds being built, by client. */
  private readonly starting = new Map<string, number>();
  private readonly starts = new Map<string, number[]>();
  private readonly requests = new Map<string, { windowStart: number; count: number }>();
  private readonly pool: SandboxPool;
  private readonly tmp: string;
  private readonly sweeper: NodeJS.Timeout;
  private closed = false;
  private readonly actionTimeoutMs: number;

  private constructor(
    readonly config: LabConfig,
    readonly prebuilt: PrebuiltSet,
    readonly source: SourceRevision,
    actionTimeoutMs: number,
  ) {
    this.actionTimeoutMs = actionTimeoutMs;
    this.pool = new SandboxPool(config.recycleAfterSessions, WORLD_NEAR, LEASE_BUDGET_NEAR);
    this.tmp = mkdtempSync(join(tmpdir(), "bm-lab-"));
    this.sweeper = setInterval(() => void this.sweep(), Math.min(5_000, config.sessionIdleSec * 250));
    this.sweeper.unref();
  }

  /** Loads the pinned binaries; throws, starting nothing, when any pin does not hold. */
  static start(options: LabOptions): Lab {
    const root = options.root ?? REPO_ROOT;
    return new Lab(options.config, loadPrebuilt(root), sourceRevision(root, options.declaredRevision), options.actionTimeoutMs ?? ACTION_TIMEOUT_MS);
  }

  // ---------------------------------------------------------------- limits

  /** Counts one request of `client` against its rate; throws when the rate is used up. */
  admit(client: string, now = Date.now()): void {
    const w = this.requests.get(client);
    if (w === undefined || now - w.windowStart >= MINUTE_MS) {
      this.requests.set(client, { windowStart: now, count: 1 });
      return;
    }
    w.count += 1;
    if (w.count > this.config.requestsPerMinute) {
      throw new LabError(429, "client_request_limit", `more than ${this.config.requestsPerMinute} requests in a minute from this client`, { retry_after_sec: Math.ceil((w.windowStart + MINUTE_MS - now) / 1_000) });
    }
  }

  private startingTotal(): number {
    let n = 0;
    for (const v of this.starting.values()) n += v;
    return n;
  }

  private sessionsOf(client: string): number {
    let n = 0;
    for (const s of this.sessions.values()) if (s.client === client) n += 1;
    return n;
  }

  /** Reserves the right to build one world for `client`; the returned function gives the reservation back. */
  private reserveStart(client: string, extraSession: boolean): () => void {
    if (this.closed) throw new LabError(503, "shutting_down", "the lab is shutting down");
    const now = Date.now();
    const recent = (this.starts.get(client) ?? []).filter((t) => now - t < HOUR_MS);
    if (recent.length >= this.config.sessionStartsPerHour) {
      throw new LabError(429, "client_start_limit", `this client has started or reset ${this.config.sessionStartsPerHour} sessions within an hour`);
    }
    if ((this.starting.get(client) ?? 0) > 0) throw new LabError(429, "client_start_in_flight", "this client is already starting a session");
    if (extraSession) {
      if (this.sessionsOf(client) >= this.config.maxSessionsPerClient) {
        throw new LabError(429, "client_session_limit", `this client already has ${this.config.maxSessionsPerClient} sessions; end one first`);
      }
      if (this.sessions.size + this.startingTotal() >= this.config.maxSessions) throw new LabError(503, "lab_full", "all session slots are in use; try again later");
    }
    if (this.startingTotal() >= this.config.maxConcurrentStarts) throw new LabError(503, "lab_busy", "other sessions are starting; try again in a few seconds", { retry_after_sec: 10 });
    this.starts.set(client, [...recent, now]);
    this.starting.set(client, (this.starting.get(client) ?? 0) + 1);
    return () => {
      const left = (this.starting.get(client) ?? 1) - 1;
      if (left <= 0) this.starting.delete(client);
      else this.starting.set(client, left);
    };
  }

  private async buildWorld(): Promise<{ lw: LabWorld; state: LabState }> {
    try {
      const lease = await this.pool.acquire();
      let lw: LabWorld;
      try {
        lw = await createLabWorld(lease, this.prebuilt.wasm, this.tmp);
      } catch (error) {
        await lease.release();
        throw error;
      }
      return { lw, state: await labState(lw) };
    } catch (error) {
      if (error instanceof LabUnavailable) throw new LabError(503, "sandbox_unavailable", error.message);
      throw new LabError(503, "world_failed", `the session world could not be built: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ---------------------------------------------------------------- sessions

  async createSession(client: string): Promise<SessionView> {
    const done = this.reserveStart(client, true);
    try {
      const { lw, state } = await this.buildWorld();
      const now = Date.now();
      const s: Session = { id: randomBytes(16).toString("hex"), client, createdAt: now, lastUsedAt: now, busy: false, lw, startingState: state, log: [], resets: 0 };
      this.sessions.set(s.id, s);
      return this.view(s, state);
    } finally {
      done();
    }
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (s === undefined) throw new LabError(404, "no_session", "no such session: it may have expired; start a new one");
    s.lastUsedAt = Date.now();
    return s;
  }

  private view(s: Session, state: LabState): SessionView {
    return {
      session_id: s.id,
      created_at: new Date(s.createdAt).toISOString(),
      ends_at: new Date(s.createdAt + this.config.sessionMaxSec * 1_000).toISOString(),
      idle_sec: this.config.sessionIdleSec,
      busy: s.busy,
      resets: s.resets,
      actions_used: s.log.length,
      actions_max: this.config.maxActions,
      state,
    };
  }

  async sessionView(id: string): Promise<SessionView> {
    const s = this.get(id);
    return this.view(s, await labState(s.lw));
  }

  log(id: string): ActionRecord[] {
    return this.get(id).log;
  }

  private begin(s: Session): void {
    if (s.busy) throw new LabError(409, "action_in_flight", "this session is still executing its previous action");
    s.busy = true;
  }

  async act(id: string, action: string, input: unknown): Promise<ActionRecord> {
    const s = this.get(id);
    if (!isAction(action)) throw new LabError(400, "unlisted_action", `"${action.slice(0, 40)}" is not a lab action`, { listed: ACTIONS });
    if (s.log.length >= this.config.maxActions) throw new LabError(429, "session_action_limit", `this session has used its ${this.config.maxActions} actions; reset it to continue`);
    this.begin(s);
    try {
      const record = await withTimeout(runAction(s.lw, s.log.length + 1, action, input), this.actionTimeoutMs);
      s.log.push(record);
      return record;
    } catch (error) {
      if (error instanceof InputError) throw new LabError(400, "invalid_input", error.message);
      if (error instanceof LabUnavailable) throw new LabError(503, "sandbox_unavailable", error.message);
      if (error instanceof ActionTimeout) {
        // What the world's transactions did is no longer known to the lab, so the session cannot go on.
        this.sessions.delete(s.id);
        await destroyLabWorld(s.lw).catch(() => undefined);
        throw new LabError(504, "action_timeout", "the action did not complete in time; the session has been ended, start a new one");
      }
      throw new LabError(502, "action_failed", `the action stopped before it completed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      s.busy = false;
      s.lastUsedAt = Date.now();
    }
  }

  /** Replaces the session's world with a new one: same binaries, balances and configuration, nothing carried over. */
  async reset(id: string): Promise<SessionView> {
    const s = this.get(id);
    this.begin(s);
    let done: () => void;
    try {
      done = this.reserveStart(s.client, false);
    } catch (error) {
      s.busy = false;
      throw error;
    }
    try {
      // The old world goes first, so a session never holds two worlds.
      await destroyLabWorld(s.lw);
      const { lw, state } = await this.buildWorld();
      s.lw = lw;
      s.startingState = state;
      s.log = [];
      s.resets += 1;
      s.busy = false;
      s.lastUsedAt = Date.now();
      return this.view(s, state);
    } catch (error) {
      this.sessions.delete(s.id);
      throw error;
    } finally {
      done();
    }
  }

  export(id: string): Scenario {
    const s = this.get(id);
    return exportScenario({ scope: s.lw.scope, neard: s.lw.lease.neardVersion, source: this.source, wasm: this.prebuilt.wasm, startingState: s.startingState, log: s.log });
  }

  async end(id: string): Promise<void> {
    const s = this.get(id);
    if (s.busy) throw new LabError(409, "action_in_flight", "this session is still executing an action");
    this.sessions.delete(id);
    await destroyLabWorld(s.lw);
  }

  /** Ends sessions that are idle or past their maximum age, and forgets old rate-limit entries. */
  async sweep(now = Date.now()): Promise<void> {
    for (const s of [...this.sessions.values()]) {
      const expired = now - s.lastUsedAt > this.config.sessionIdleSec * 1_000 || now - s.createdAt > this.config.sessionMaxSec * 1_000;
      if (!expired || s.busy) continue;
      this.sessions.delete(s.id);
      await destroyLabWorld(s.lw).catch(() => undefined);
    }
    for (const [client, w] of this.requests) if (now - w.windowStart >= MINUTE_MS) this.requests.delete(client);
    for (const [client, times] of this.starts) {
      const recent = times.filter((t) => now - t < HOUR_MS);
      if (recent.length === 0) this.starts.delete(client);
      else this.starts.set(client, recent);
    }
  }

  // ---------------------------------------------------------------- descriptions

  /** Stated with every API response. */
  readonly labels = { service: LAB_SERVICE, mode: LAB_MODE, label: LAB_LABEL } as const;

  health(): Record<string, unknown> {
    return {
      ok: !this.closed,
      sessions: { active: this.sessions.size, max: this.config.maxSessions },
      test_doubles: this.testDoubles(),
      source: this.source,
      wasm_sha256: Object.fromEntries(Object.entries(this.prebuilt.wasm).map(([role, w]) => [role, w.sha256])),
    };
  }

  testDoubles(): { role: string; contract: string; path: string; sha256: string; note: string }[] {
    return TEST_DOUBLES.map((d) => ({ role: d.role, contract: d.contract, path: this.prebuilt.wasm[d.wasm].path, sha256: this.prebuilt.wasm[d.wasm].sha256, note: d.note }));
  }

  describe(): Record<string, unknown> {
    const c = this.config;
    return {
      actions: ACTIONS.map((name) => ({ action: name, does: ACTION_HELP[name] })),
      default_policy: LAB_POLICY,
      limits: {
        sessions: c.maxSessions,
        sessions_per_client: c.maxSessionsPerClient,
        session_starts_per_hour: c.sessionStartsPerHour,
        requests_per_minute: c.requestsPerMinute,
        session_idle_sec: c.sessionIdleSec,
        session_max_sec: c.sessionMaxSec,
        actions_per_session: c.maxActions,
        request_body_bytes: c.maxBodyBytes,
      },
    };
  }

  /** For the operator and the tests; never served to a visitor. */
  stats(): { sessions: number; starting: number; pool: PoolStats; rpcUrls: string[] } {
    return { sessions: this.sessions.size, starting: this.startingTotal(), pool: this.pool.stats(), rpcUrls: this.pool.rpcUrls() };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.sweeper);
    const all = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(all.map((s) => destroyLabWorld(s.lw).catch(() => undefined)));
    await this.pool.close();
    rmSync(this.tmp, { recursive: true, force: true });
  }
}
