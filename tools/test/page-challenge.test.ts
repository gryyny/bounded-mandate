// SYNTHETIC open-challenge records only: every record below is built here to test the page's challenge panel; none was
// produced by a challenge run or read from any chain. The mainnet-shaped run evidence is SYNTHETIC as well.
import { describe, expect, it } from "vitest";
import { CHALLENGE_DOES_NOT_SHOW, CHALLENGE_SHOWS, ChallengeRecord, KEY_PUBLICATION } from "../src/live/challenge.js";
import { withoutSecrets } from "../src/page/challenge.js";
import { escapeHtml, renderHtml } from "../src/page/render.js";
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

  it("open: states shows and does-not-show verbatim, the public key, 'key not published', grant and orders, with its own label", () => {
    const p = panel(render(record("open")));
    expect(p).toContain('<h2 id="challenge-h">Open challenge: a separate grant whose agent key is public</h2>');
    expect(p).toContain(`<p class="prov"><a href="#real">sandbox open-challenge record, separate from the completed run</a></p>`);
    expect(p).toContain(escapeHtml(CHALLENGE_SHOWS));
    for (const t of CHALLENGE_DOES_NOT_SHOW) expect(p).toContain(`<li>${escapeHtml(t)}</li>`);
    expect(p).toContain(`<code>${AGENT_PUBLIC}</code>`);
    expect(p).toContain('<span class="muted">key not published</span>');
    expect(p).toContain('<span class="status inconclusive">open: the agent key is public and the grant is live</span>');
    expect(p).toContain("<code>mandate/v1/3</code>");
    expect(p).toContain("registered at the verifier");
    expect(p).toContain("<strong>5</strong> orders proposed under the challenge grant: executed 2 · rejected:over_cap 3.");
    expect(p).toContain("<code>SYNTHETIC-withheld-9</code>");
    expect(p).toContain("released:key_removed");
    expect(p).toContain("not part of the completed run&#39;s verdict, state strip or gates");
  });

  it("closed: shows the close and its transactions; a published key URL becomes a link", () => {
    const url = "https://example.invalid/SYNTHETIC-key-post";
    const p = panel(render(record("closed", { agent_key: { public_key: AGENT_PUBLIC, allowance_yocto: null, nonce: null, publication: KEY_PUBLICATION, publication_url: url } })));
    expect(p).toContain('<span class="status success">closed: revoked, recovered and withdrawn by the owner</span>');
    expect(p).toContain(`<a href="${url}" rel="noopener noreferrer">${url}</a>`);
    expect(p).toContain("SYNTHETIC close completed");
    expect(p).toContain("SYNTHETICrevokeTx");
    expect(p).not.toContain("key not published");
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
