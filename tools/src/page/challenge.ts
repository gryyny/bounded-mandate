// The optional open-challenge panel: a separate grant whose agent key is published, read from the challenge record
// (src/live/challenge.ts). Shown apart from the completed run: its own heading and provenance label, never counted in
// the run's verdict, state strip or gates. An invalid record is not rendered. The record holds public keys only; the
// panel renders named fields, and the one free-form field (breaker) is shown without any secret-looking value.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ChallengeRecord, CHALLENGE_RECORD_SCHEMA } from "../live/challenge.js";
import { chip, escapeHtml, modeBadge, word } from "./html.js";
import { provenance } from "./landing.js";
import { units } from "./story.js";

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

const STATUS: Record<ChallengeRecord["status"], [string, string]> = {
  open: ["inconclusive", "open: the agent key is public and the grant is live"],
  closed: ["success", "closed: revoked, recovered and withdrawn by the owner"],
  "not-opened": ["not-run", "not opened: no challenge grant was made"],
};

const kv = (rows: readonly [string, string][]): string => `<dl class="kv">${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
const code = (s: string): string => `<code>${escapeHtml(s)}</code>`;
const yocto = (s: string): string => `${units(s, 24, 6)} NEAR`;

export function challengeBody(r: ChallengeRecord): string {
  const [cls, text] = STATUS[r.status];
  const url = r.agent_key.publication_url;
  const published =
    url === null ? `<span class="muted">key not published</span>` : /^https:\/\/[^\s"<>]+$/.test(url) ? `<a href="${escapeHtml(url)}" rel="noopener noreferrer">${escapeHtml(url)}</a>` : code(url);
  const g = r.grant;
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
  ])}<p>${escapeHtml(r.agent_key.publication)}</p>
<h3>Challenge grant</h3>${grant}${orders}
<h3>Earlier grants</h3>${earlier}${keys}${close}`;
}
