// Lab settings, labels and limits. Everything a deployment may change comes from the environment (LAB_*); nothing
// here names a public network, and the lab has no setting that could point it at one.
import { z } from "zod";
import type { Policy } from "../types.js";
import { DEMO_POLICY } from "../demo/market.js";

export const LAB_SERVICE = "bounded-mandate-lab";
export const LAB_MODE = "sandbox";
/** Stated on the page and in every API response. */
export const LAB_LABEL =
  "SANDBOX with TEST DOUBLES: a local sandbox chain running the mandate deployment candidate and the pinned Intents verifier; the MPC signer, the price oracle and the tokens are test doubles. Not mainnet, no real funds, no model call.";
export const TEST_DOUBLES = [
  { role: "MPC signer", wasm: "mpc", contract: "mock-mpc", note: "TEST DOUBLE: derives its keys from public inputs and signs whatever the mandate requests" },
  { role: "price oracle", wasm: "oracle", contract: "mock-oracle", note: "TEST DOUBLE: prices are posted by the lab, not by a market" },
  { role: "USDC and wNEAR tokens", wasm: "ft", contract: "mock-ft", note: "TEST DOUBLE: minted by the lab, worth nothing" },
] as const;

/**
 * Starting limits offered by the lab: the demonstration thresholds, except that orders live 120 s instead of 60 s
 * (and prices stay valid as long) so a person has time to revoke and retry a withheld order before it expires. The
 * lab never fast-forwards the chain: a deadline passes only when that much real time has passed.
 */
export const LAB_POLICY: Policy = { ...DEMO_POLICY, order_ttl_sec: 120, oracle_max_age_sec: 120 };

const int = (name: string, fallback: number, min: number, max: number) =>
  z.preprocess((v) => (v === undefined || v === "" ? fallback : Number(v)), z.number({ error: `${name} must be a number` }).int().min(min).max(max));

const Env = z.object({
  LAB_HOST: z.string().min(1).default("127.0.0.1"),
  LAB_PORT: int("LAB_PORT", 8791, 0, 65_535),
  /** The one origin allowed to read GET /api/health across origins (the evidence page's origin); unset: none. */
  LAB_ALLOWED_ORIGIN: z.union([z.literal(""), z.string().regex(/^https?:\/\/[^/\s]+$/, "LAB_ALLOWED_ORIGIN must be an origin like https://example.org")]).default(""),
  /** The origin visitors use, when a proxy in front rewrites the Host header (the page's own requests carry it). */
  LAB_PUBLIC_ORIGIN: z.union([z.literal(""), z.string().regex(/^https?:\/\/[^/\s]+$/, "LAB_PUBLIC_ORIGIN must be an origin like https://lab.example.org")]).default(""),
  /** Set to 1 only behind a reverse proxy that appends the client address to X-Forwarded-For: clients are then told apart by it. */
  LAB_TRUST_PROXY: z.enum(["", "0", "1"]).default(""),
  LAB_MAX_SESSIONS: int("LAB_MAX_SESSIONS", 6, 1, 64),
  LAB_MAX_SESSIONS_PER_CLIENT: int("LAB_MAX_SESSIONS_PER_CLIENT", 2, 1, 64),
  LAB_MAX_CONCURRENT_STARTS: int("LAB_MAX_CONCURRENT_STARTS", 2, 1, 16),
  LAB_SESSION_STARTS_PER_HOUR: int("LAB_SESSION_STARTS_PER_HOUR", 12, 1, 10_000),
  LAB_REQUESTS_PER_MINUTE: int("LAB_REQUESTS_PER_MINUTE", 240, 1, 100_000),
  LAB_SESSION_IDLE_SEC: int("LAB_SESSION_IDLE_SEC", 600, 1, 86_400),
  LAB_SESSION_MAX_SEC: int("LAB_SESSION_MAX_SEC", 1_800, 1, 86_400),
  LAB_MAX_ACTIONS: int("LAB_MAX_ACTIONS", 120, 1, 10_000),
  LAB_MAX_BODY_BYTES: int("LAB_MAX_BODY_BYTES", 4_096, 256, 1_048_576),
  LAB_RECYCLE_AFTER_SESSIONS: int("LAB_RECYCLE_AFTER_SESSIONS", 12, 1, 1_000),
});

export interface LabConfig {
  host: string;
  port: number;
  allowedOrigin: string | null;
  publicOrigin: string | null;
  trustProxy: boolean;
  /** Sessions alive at once, over all clients. */
  maxSessions: number;
  maxSessionsPerClient: number;
  /** Session worlds being built at once (a start or a reset), over all clients; one per client. */
  maxConcurrentStarts: number;
  /** Starts and resets one client may request per hour: each builds a complete world. */
  sessionStartsPerHour: number;
  requestsPerMinute: number;
  sessionIdleSec: number;
  sessionMaxSec: number;
  /** Actions one session world accepts before it must be reset. */
  maxActions: number;
  maxBodyBytes: number;
  /** A sandbox process is retired after serving this many session worlds (see pool.ts). */
  recycleAfterSessions: number;
}

export function configFromEnv(env: Readonly<Record<string, string | undefined>>): LabConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) throw new Error(`lab configuration:\n${z.prettifyError(parsed.error)}`);
  const e = parsed.data;
  return {
    host: e.LAB_HOST,
    port: e.LAB_PORT,
    allowedOrigin: e.LAB_ALLOWED_ORIGIN === "" ? null : e.LAB_ALLOWED_ORIGIN,
    publicOrigin: e.LAB_PUBLIC_ORIGIN === "" ? null : e.LAB_PUBLIC_ORIGIN,
    trustProxy: e.LAB_TRUST_PROXY === "1",
    maxSessions: e.LAB_MAX_SESSIONS,
    maxSessionsPerClient: e.LAB_MAX_SESSIONS_PER_CLIENT,
    maxConcurrentStarts: e.LAB_MAX_CONCURRENT_STARTS,
    sessionStartsPerHour: e.LAB_SESSION_STARTS_PER_HOUR,
    requestsPerMinute: e.LAB_REQUESTS_PER_MINUTE,
    sessionIdleSec: e.LAB_SESSION_IDLE_SEC,
    sessionMaxSec: e.LAB_SESSION_MAX_SEC,
    maxActions: e.LAB_MAX_ACTIONS,
    maxBodyBytes: e.LAB_MAX_BODY_BYTES,
    recycleAfterSessions: e.LAB_RECYCLE_AFTER_SESSIONS,
  };
}

export const DEFAULT_CONFIG: LabConfig = configFromEnv({});
