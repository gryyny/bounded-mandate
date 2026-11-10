// The optional open-challenge panel: a separate grant whose agent key is meant to be published, read from the challenge record
// (src/live/challenge.ts). Shown apart from the completed run: its own heading and provenance label, never counted in
// the run's verdict, state strip or gates. An invalid record is not rendered. The record holds public keys only; the
// panel renders named fields, and the one free-form field (breaker) is shown without any secret-looking value.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ChallengeRecord, CHALLENGE_RECORD_SCHEMA } from "../live/challenge.js";
import { chip, escapeHtml, modeBadge, word } from "./html.js";
import { provenance } from "./landing.js";
import { units, usd, usdc, wnear } from "./story.js";

export { ChallengeRecord };

export const CHALLENGE_DIR = "out/challenge/evidence";

/** The mainnet record when present, else the sandbox one; raw JSON, validated by `challengeView`. */
export function loadChallenge(root: string): unknown {
  for (const network of ["mainnet", "sandbox"]) {
    const path = join(root, CHALLENGE_DIR, `challenge-${network}.json`);
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as unknown;
  }
  return null;
}

/** A valid record, or null (absent or invalid: no panel, and the rest of the page is unaffected). */
export function challengeView(raw: unknown): ChallengeRecord | null {
  if (raw === null || raw === undefined) return null;
  const parsed = ChallengeRecord.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const SECRET_NAME = /secret|private|seed|mnemonic|password/i;
/** An ed25519 secret key is 64 bytes: base58 of at least 80 characters. Public keys (32 bytes) are at most 44. */
const SECRET_VALUE = /(ed25519:)?[1-9A-HJ-NP-Za-km-z]{80,}/;

/** JSON of a free-form value with any secret-named field or secret-looking string replaced. */
export function withoutSecrets(value: unknown): unknown {
  if (typeof value === "string") return SECRET_VALUE.test(value) ? "[withheld: looks like a secret key]" : value;
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_NAME.test(k) ? "[withheld]" : withoutSecrets(v)]));
  }
  return value;
}

/** The status line follows the record: the grant's own status and whether a publication link is recorded. */
function statusLine(r: ChallengeRecord): [string, string] {
  if (r.status === "closed") return ["success", "closed: revoked, recovered and withdrawn by the owner"];
  if (r.status === "not-opened") return ["not-run", "not opened: no challenge grant was made"];
  const grant = r.grant === null ? "no grant in this record" : `grant ${r.grant.status}`;
  return ["inconclusive", r.agent_key.publication_url === null ? `open: ${grant}; no publication of the agent key is recorded` : `open: ${grant}; the agent key is published`];
}

const Balances = z.object({ usdc: z.string().regex(/^[0-9]+$/), wnear: z.string().regex(/^[0-9]+$/) });
const balances = (v: unknown): string | null => {
  const b = Balances.safeParse(v);
  return b.success ? `${usdc(b.data.usdc)} · ${wnear(b.data.wnear)}` : null;
};
/** A field the record schema may gain (src/live/challenge.ts); absent in records that predate it. */
const optional = (r: ChallengeRecord, names: readonly string[]): unknown => {
  const raw = r as unknown as Record<string, unknown>;
  return names.map((n) => raw[n]).find((v) => v !== undefined && v !== null);
};

const pct = (bps: number): string => `${(bps / 100).toFixed(2)}%`;

/**
 * The exposure in numbers, as arithmetic on the recorded policy (not a measured result): trading at the concession
 * bound on every order up to the turnover cap. The breaker is not a loss cap, and gas is bounded by the key's allowance.
 */
function exposure(r: ChallengeRecord): string {
  const g = r.grant;
  if (g === null) return "";
  const p = g.policy;
  const bound = `${pct(p.turnover_cap_bps)} turnover cap × ${pct(p.max_concession_bps)} concession bound`;
  const loss =
    g.initial_value !== null && /^[0-9]+$/.test(g.initial_value)
      ? `${bound} of the initial reference value ${usd(g.initial_value)} = ${usd(((BigInt(g.initial_value) * BigInt(p.turnover_cap_bps) * BigInt(p.max_concession_bps)) / 100_000_000n).toString())}`
      : `${bound} of the initial reference value (not recorded)`;
  const gas = r.agent_key.allowance_yocto === null ? "the agent key's allowance is not recorded (key absent or unlimited)" : `up to the agent key's remaining allowance, ${yocto(r.agent_key.allowance_yocto)}`;
  return `<h3>Exposure in numbers</h3><ul class="exposure"><li>Largest by-design trading loss against the reference prices: ${escapeHtml(loss)}. Arithmetic on the recorded policy, not a measured result.</li><li>The loss breaker (${escapeHtml(pct(p.breaker_drawdown_bps))} drawdown) stops new authorizations only. It is not a loss cap: market moves and orders already signed can lose more.</li><li>Gas: ${escapeHtml(gas)}.</li></ul>`;
}

const kv = (rows: readonly [string, string][]): string => `<dl class="kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
const code = (s: string): string => `<code>${escapeHtml(s)}</code>`;
const yocto = (s: string): string => `${units(s, 24, 6)} NEAR`;

export function challengeBody(r: ChallengeRecord): string {
  const [cls, text] = statusLine(r);
  const url = r.agent_key.publication_url;
  const published =
    url === null ? `<span class="muted">no publication recorded</span>` : /^https:\/\/[^\s"<>]+$/.test(url) ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a>` : code(url);
  const g = r.grant;
  const deposit = balances(optional(r, ["deposit", "challenge_deposit", "deposits"]));
  const grant =
    g === null
      ? `<p class="muted">No challenge grant in this record.</p>`
      : kv([
          ["Epoch and path", `${String(g.epoch)} · ${code(g.path)}`],
          ["Status", escapeHtml(g.status)],
          ["Grant key", `${g.public_key === null ? "none" : code(g.public_key)} · ${g.key_registered ? "registered at the verifier" : "not registered at the verifier"}`],
          ["Initial value", g.initial_value === null ? "not recorded" : code(g.initial_value)],
          ["Turnover used", code(g.turnover_used)],
          ["Outstanding", code(g.outstanding)],
          ["Proposal budget (upper bound)", String(g.proposal_budget_upper_bound)],
          ["Per-order cap · turnover cap · concession", escapeHtml(`${String(g.policy.per_order_cap_bps)} · ${String(g.policy.turnover_cap_bps)} · ${String(g.policy.max_concession_bps)} bps`)],
          ["Breaker", g.breaker === null ? "not tripped" : `<pre>${escapeHtml(JSON.stringify(withoutSecrets(g.breaker), null, 2))}</pre>`],
        ]);
  const states = Object.entries(r.challenge_orders.by_state);
  const orders = `<p><strong>${String(r.challenge_orders.total)}</strong> orders proposed under the challenge grant${states.length === 0 ? "" : `: ${states.map(([s, n]) => `${escapeHtml(s)} ${String(n)}`).join(" · ")}`}.</p>`;
  const earlier = r.earlier_unexecuted_orders.length === 0
    ? `<p class="muted">No signed order of an earlier grant is unexecuted in this record.</p>`
    : `<div class="scroll"><table><caption>Signed orders of earlier grants that never executed</caption><thead><tr><th scope="col">Order</th><th scope="col">Epoch</th><th scope="col">State</th><th scope="col">Deadline (ns)</th><th scope="col">Nonce used</th></tr></thead><tbody>${r.earlier_unexecuted_orders
        .map((o) => `<tr><td>${code(o.id)}</td><td>${String(o.epoch)}</td><td>${escapeHtml(o.state)}</td><td class="mono">${escapeHtml(o.deadline_ns ?? "not recorded")}</td><td>${o.nonce_used ? word("failure", "used") : "no"}</td></tr>`)
        .join("")}</tbody></table></div>`;
  const keys = r.earlier_grants.length === 0
    ? ""
    : `<div class="scroll"><table><caption>Earlier grants' signing keys at the verifier now</caption><thead><tr><th scope="col">Epoch</th><th scope="col">Derived key</th><th scope="col">Registered now</th></tr></thead><tbody>${r.earlier_grants
        .map((e) => `<tr><td>${String(e.epoch)}</td><td>${e.derived_public_key === null ? "not read" : code(e.derived_public_key)}</td><td>${e.registered === null ? "not read" : e.registered ? word("failure", "yes") : "no"}</td></tr>`)
        .join("")}</tbody></table></div>`;
  const close = r.close === null
    ? ""
    : `<h3>Close</h3><p>${word(r.close.exit_code === 0 ? "success" : "failure", `exit ${String(r.close.exit_code)}`)} ${escapeHtml(r.close.message)}</p><div class="scroll"><table><caption>Close transactions (${escapeHtml(r.mode)})</caption><thead><tr><th scope="col">Step</th><th scope="col">Transaction</th><th scope="col">Result</th></tr></thead><tbody>${r.close.receipts
        .map((x) => `<tr><td>${escapeHtml(x.label)}${x.method === null ? "" : ` ${code(x.method)}`}</td><td class="mono">${escapeHtml(x.tx_hash ?? "none")}</td><td>${word(x.outcome, x.outcome)}</td></tr>`)
        .join("")}</tbody></table></div>`;
  return `${provenance(`${r.mode} open-challenge record, separate from the completed run`)}
<p class="challenge-status">${modeBadge(r.mode)} ${word(cls, text)} ${chip("label", "not part of the completed run's verdict, state strip or gates")}</p>
<p class="source">Source: ${escapeHtml(CHALLENGE_DIR)}/challenge-${escapeHtml(r.mode)}.json (${escapeHtml(CHALLENGE_RECORD_SCHEMA)}) · generated ${escapeHtml(r.generated_at)} · read at block ${String(r.read_at.block_height)} on ${escapeHtml(r.network.chain_id)} · mandate ${code(r.accounts.mandate)}</p>
<div class="claims"><div class="card"><h3>What it shows</h3><p>${escapeHtml(r.shows)}</p></div><div class="card not"><h3>What it does not show</h3><ul>${r.does_not_show.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul></div></div>
<h3>Agent key</h3>${kv([
    ["Public key", code(r.agent_key.public_key)],
    ["Published at", published],
    ["Remaining allowance", r.agent_key.allowance_yocto === null ? "key absent or unlimited" : escapeHtml(yocto(r.agent_key.allowance_yocto))],
  ])}<p>${url === null ? "This record carries no publication link. " : ""}The record's fixed statement of how the key is published: “${escapeHtml(r.agent_key.publication)}”</p>
<h3>Challenge grant</h3>${grant}${orders}
<h3>Balances</h3>${kv([
    ...(deposit === null ? [] : [["Challenge deposit", escapeHtml(deposit)] as [string, string]]),
    ["Mandate's Intents balances at the read block", balances(r.mandate_balances) ?? "not recorded"],
  ])}${exposure(r)}
<h3>Earlier grants</h3>${earlier}${keys}${close}`;
}
