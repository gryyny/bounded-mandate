// SYNTHETIC open-challenge records only: every record below is built here to test the page's challenge panel; none was
// produced by a challenge run or read from any chain. The mainnet-shaped run evidence is SYNTHETIC as well.
import { describe, expect, it } from "vitest";
import { CHALLENGE_DOES_NOT_SHOW, CHALLENGE_SHOWS, ChallengeRecord, KEY_PUBLICATION } from "../src/live/challenge.js";
import { withoutSecrets } from "../src/page/challenge.js";
import { escapeHtml, renderHtml } from "../src/page/render.js";
import { usd, usdc, wnear } from "../src/page/story.js";
import { Evidence } from "../src/types.js";
import { AGENT_PUBLIC, SECRET_LOOKING, record } from "./page-challenge-specimen.js";
import { storyEvidence, txHash } from "./video-story-specimen.js";

const live = (): Evidence =>
  Evidence.parse({
    ...storyEvidence(),
    mode: "mainnet",
    command: "MANDATE_LIVE=1 make live (SYNTHETIC)",
    environment: { chain_id: "mainnet", label: "SYNTHETIC" },
    identifiers: { mandate: "mandate.synthetic.near", owner: "owner.synthetic.near" },
    receipts: [{ label: "owner revoke (SYNTHETIC)", tx_hash: txHash("revoke"), block_height: 2, outcome: "success", detail: { step: 6, signer_id: "owner.synthetic.near" } }],
    assertions: [{ id: "step-7-relay_withheld", gate: "LIVE", description: "relay_withheld (SYNTHETIC)", passed: true, observed: { classification: "rejected_revoked_key" } }],
    unknowns: [],
  });

const render = (challenge: unknown, liveEvidence: Evidence | null = null) => renderHtml(storyEvidence(), { acceptance: null, live: liveEvidence, challenge });
const at = (html: string, id: string): number => html.indexOf(`id="${id}"`);
const panel = (html: string): string => {
  const start = at(html, "challenge");
  return html.slice(start, html.indexOf("</section>", start));
};
const strip = (html: string): string => {
  const start = html.indexOf('<dl class="state-strip"');
  return html.slice(start, html.indexOf("</dl>", start));
};

describe("open-challenge panel (SYNTHETIC records)", () => {
  it("is absent without a record", () => {
    const h = render(null);
    expect(at(h, "challenge")).toBe(-1);
    expect(h).not.toContain("Open challenge");
  });

  it("open without a publication link: states shows and does-not-show verbatim, the public key, grant and orders, with its own label", () => {
    const p = panel(render(record("open")));
    expect(p).toContain('<h2 id="challenge-h">Open challenge: a separate grant, apart from the completed run</h2>');
    expect(p).toContain(`<p class="prov"><a href="#real">sandbox open-challenge record, separate from the completed run</a></p>`);
    expect(p).toContain(escapeHtml(CHALLENGE_SHOWS));
    for (const t of CHALLENGE_DOES_NOT_SHOW) expect(p).toContain(`<li>${escapeHtml(t)}</li>`);
    expect(p).toContain(`<code>${AGENT_PUBLIC}</code>`);
    // The status follows the record: this one carries no publication link, so the panel never calls the key public.
    expect(p).toContain('<span class="muted">no publication recorded</span>');
    expect(p).toContain('<span class="status inconclusive">open: grant active; no publication of the agent key is recorded</span>');
    const status = p.slice(p.indexOf('<p class="challenge-status">'), p.indexOf("</p>", p.indexOf('<p class="challenge-status">')));
    expect(status).not.toMatch(/key is (public|published)|grant is live/);
    // The record's fixed publication sentence (src/live/challenge.ts) is quoted as the record's statement, after saying no link is recorded.
    expect(p).toContain(`<p>This record carries no publication link. The record&#39;s fixed statement of how the key is published: “${escapeHtml(KEY_PUBLICATION)}”</p>`.replace("record&#39;s", "record's"));
    expect(p).toContain("<code>mandate/v1/3</code>");
    expect(p).toContain("registered at the verifier");
    expect(p).toContain("<strong>5</strong> orders proposed under the challenge grant: executed 2 · rejected:over_cap 3.");
    expect(p).toContain("<code>SYNTHETIC-withheld-9</code>");
    expect(p).toContain("released:key_removed");
    expect(p).toContain("not part of the completed run&#39;s verdict, state strip or gates");
  });

  it("open with a publication link: the status says the key is published, and the grant's own status", () => {
    const url = "https://example.invalid/SYNTHETIC-key-post";
    const open = record("open");
    const p = panel(render(record("open", { agent_key: { ...open.agent_key, publication_url: url } })));
    expect(p).toContain('<span class="status inconclusive">open: grant active; the agent key is published</span>');
    expect(p).toContain(`<a href="${url}" rel="noopener noreferrer">${url}</a>`);
    expect(p).not.toContain("no publication");
    if (open.grant === null) throw new Error("SYNTHETIC open record has a grant");
    const revoking = panel(render(record("open", { grant: { ...open.grant, status: "revoking" } })));
    expect(revoking).toContain("open: grant revoking; no publication of the agent key is recorded");
  });

  it("shows the record's balances and the exposure in numbers from its policy", () => {
    const r = record("open");
    const g = r.grant;
    if (g === null || g.initial_value === null) throw new Error("SYNTHETIC open record has a grant with an initial value");
    const p = panel(render(r));
    expect(p).toContain(`<dt>Mandate&#39;s Intents balances at the read block</dt><dd>${usdc(r.mandate_balances.usdc)} · ${wnear(r.mandate_balances.wnear)}</dd>`);
    expect(p).not.toContain("Challenge deposit");
    // Independent derivation: value × turnover cap × concession bound, in basis points of basis points.
    const loss = (BigInt(g.initial_value) * BigInt(g.policy.turnover_cap_bps) * BigInt(g.policy.max_concession_bps)) / 10_000n / 10_000n;
    expect(loss > 0n).toBe(true);
    expect(p).toContain(`Largest by-design trading loss against the reference prices: ${(g.policy.turnover_cap_bps / 100).toFixed(2)}% turnover cap × ${(g.policy.max_concession_bps / 100).toFixed(2)}% concession bound of the initial reference value ${usd(g.initial_value)} = ${usd(loss.toString())}. Arithmetic on the recorded policy, not a measured result.`);
    expect(p).toContain(`The loss breaker (${(g.policy.breaker_drawdown_bps / 100).toFixed(2)}% drawdown) stops new authorizations only. It is not a loss cap`);
    expect(p).toContain("Gas: up to the agent key&#39;s remaining allowance, 0.250000 NEAR.");
    // Absent fields are said to be absent, never assumed.
    const bare = panel(render(record("open", { grant: { ...g, initial_value: null }, agent_key: { ...r.agent_key, allowance_yocto: null } })));
    expect(bare).toContain("of the initial reference value (not recorded).");
    expect(bare).toContain("Gas: the agent key&#39;s allowance is not recorded (key absent or unlimited).");
    expect(panel(render(record("not-opened")))).not.toContain("Exposure in numbers");
  });

  it("closed: shows the close and its transactions; a published key URL becomes a link", () => {
    const url = "https://example.invalid/SYNTHETIC-key-post";
    const p = panel(render(record("closed", { agent_key: { public_key: AGENT_PUBLIC, allowance_yocto: null, nonce: null, publication: KEY_PUBLICATION, publication_url: url } })));
    expect(p).toContain('<span class="status success">closed: revoked, recovered and withdrawn by the owner</span>');
    expect(p).toContain(`<a href="${url}" rel="noopener noreferrer">${url}</a>`);
    expect(p).toContain("SYNTHETIC close completed");
    expect(p).toContain("SYNTHETICrevokeTx");
    expect(p).not.toContain("no publication recorded");
  });

  it("not-opened: says so and shows no grant", () => {
    const p = panel(render(record("not-opened")));
    expect(p).toContain('<span class="status not-run">not opened: no challenge grant was made</span>');
    expect(p).toContain("No challenge grant in this record.");
    expect(p).toContain("<strong>0</strong> orders proposed under the challenge grant.");
  });

  it("invalid: not rendered, and the rest of the page is byte-identical to the page without a record", () => {
    const valid = record("open");
    const invalid: unknown[] = [
      { ...valid, schema: "bounded-mandate/open-challenge@0" },
      { ...valid, shows: "SYNTHETIC rewritten claim" },
      { ...valid, does_not_show: CHALLENGE_DOES_NOT_SHOW.slice(1) },
      { ...valid, separate_from_completed_run: false },
      "not a record",
    ];
    const none = render(null);
    for (const r of invalid) expect(render(r)).toBe(none);
  });

  it("never shows a private key: an extra key field is rejected, and a secret-looking breaker value is withheld", () => {
    const valid = record("open");
    const withPrivate = { ...valid, agent_key: { ...valid.agent_key, private_key: SECRET_LOOKING } };
    expect(ChallengeRecord.safeParse(withPrivate).success).toBe(false);
    const h = render(withPrivate);
    expect(h).not.toContain(SECRET_LOOKING);
    expect(at(h, "challenge")).toBe(-1);
    const grant = valid.grant;
    if (grant === null) throw new Error("SYNTHETIC open record has a grant");
    const leaky = record("open", { grant: { ...grant, breaker: { observed_at_ns: "1", note: SECRET_LOOKING, secret_key: "anything", nested: [{ private: "x" }] } } });
    const p = panel(render(leaky));
    expect(p).not.toContain(SECRET_LOOKING);
    expect(p).not.toContain("anything");
    expect(p).toContain("[withheld: looks like a secret key]");
    expect(withoutSecrets({ public_key: AGENT_PUBLIC })).toEqual({ public_key: AGENT_PUBLIC });
  });

  it("mainnet layout: after the verification panel, before the sandbox journey; never in the run's verdict or strip", () => {
    const withRecord = render(record("open", { mode: "mainnet" }), live());
    const without = render(null, live());
    expect(at(withRecord, "verify")).toBeLessThan(at(withRecord, "challenge"));
    expect(at(withRecord, "challenge")).toBeLessThan(at(withRecord, "replay"));
    expect(panel(withRecord)).toContain("mainnet open-challenge record, separate from the completed run");
    expect(strip(withRecord)).toBe(strip(without));
    const verdict = (h: string) => h.slice(at(h, "mainnet"), at(h, "verify"));
    expect(verdict(withRecord)).toBe(verdict(without));
  });

  it("sandbox layout: at the end of the page, after provenance", () => {
    const h = render(record("closed"));
    expect(at(h, "provenance")).toBeLessThan(at(h, "challenge"));
    expect(h.indexOf("<footer>")).toBeGreaterThan(at(h, "challenge"));
    expect(strip(h)).toBe(strip(render(null)));
  });

  it("every in-page link still resolves with the panel present", () => {
    for (const h of [render(record("open")), render(record("closed", { mode: "mainnet" }), live())]) {
      const ids = new Set([...h.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
      expect([...h.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]).filter((f) => !ids.has(f))).toEqual([]);
    }
  });
});
