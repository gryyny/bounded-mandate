// The opt-in, read-only verification panel: (a) historical mainnet receipts, (b) current chain state, (c) the
// recorded sandbox evidence. The browser code is verify-client.ts, inlined as one script whose sha256 the page's
// Content-Security-Policy allows; no request is made before the reader clicks the button.
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Evidence } from "../types.js";
import { escapeHtml, modeBadge, word } from "./html.js";
import { PUBLIC_RPC, isTxHash, type LiveView } from "./mainnet.js";
import { revocationStory } from "./story.js";
import { CLIENT_FUNCTIONS, type ExpectedRelay, type ExpectedTx, type VerifyData } from "./verify-client.js";

/** NEAR mainnet genesis block hash, as `status` reports it; the chain id alone can be configured by anyone. */
export const MAINNET_GENESIS_HASH = "EPnLgE7iEq9s7yTkos96M3cWymH5avBAPm3qx3NXqR8H";
/** The mainnet account whose code the pinned verifier fixture was read from (fixtures/manifest.json). */
export const MAINNET_VERIFIER = "intents.near";
const VERIFIER_FIXTURE = "verifier/defuse-0.4.5.wasm";
const TIMEOUT_MS = 15_000;

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
/** base58 of the bytes of a hex string; NEAR's code_hash is base58(sha256(code)). */
export function hexToBase58(hex: string): string {
  if (!/^([0-9a-f]{2})+$/.test(hex)) throw new Error(`not a hex digest: ${hex}`);
  let n = BigInt(`0x${hex}`);
  let out = "";
  while (n > 0n) {
    out = `${B58.charAt(Number(n % 58n))}${out}`;
    n /= 58n;
  }
  const zeros = /^(00)*/.exec(hex)?.[0].length ?? 0;
  return `${"1".repeat(zeros / 2)}${out}`;
}

const Detail = z.object({ signer_id: z.string().optional(), withheld_relay: z.boolean().optional(), bundle_sha256: z.string().optional(), order_id: z.string().optional() });
const RelayObserved = z.object({ revoked_key: z.string(), deadline_ns: z.string().regex(/^[0-9]+$/), order_id: z.string() });

/** What the browser checks, from the evidence alone. Without mainnet evidence: no receipts, only the code hash. */
export function verifyData(demo: Evidence, live: LiveView): VerifyData {
  const fixture = demo.source.fixtures[VERIFIER_FIXTURE];
  const base = {
    rpc: PUBLIC_RPC,
    chain_id: "mainnet",
    genesis_hash: MAINNET_GENESIS_HASH,
    verifier: MAINNET_VERIFIER,
    verifier_code_hash: fixture === undefined ? "not recorded in this evidence" : hexToBase58(fixture),
    timeout_ms: TIMEOUT_MS,
  };
  if (live.kind !== "mainnet") return { ...base, receipts: [], unverifiable: [], relay: null, relay_problem: null, current: null };
  const ev = live.ev;
  const detail = (d: unknown) => {
    const p = Detail.safeParse(d);
    return p.success ? p.data : {};
  };
  const receipts: ExpectedTx[] = [];
  const unverifiable: VerifyData["unverifiable"] = [];
  for (const r of ev.receipts) {
    const d = detail(r.detail);
    if (d.withheld_relay === true) continue;
    const reasons = [
      ...(r.tx_hash === undefined || !isTxHash(r.tx_hash) ? ["no NEAR transaction hash is recorded"] : []),
      ...(d.signer_id === undefined ? ["its sender (signer_id) is not recorded, and the RPC needs it to look the transaction up"] : []),
    ];
    if (reasons.length > 0 || r.tx_hash === undefined || d.signer_id === undefined) unverifiable.push({ label: r.label, reason: reasons.join("; ") });
    else receipts.push({ label: r.label, tx_hash: r.tx_hash, sender: d.signer_id, outcome: r.outcome });
  }
  const relayReceipt = ev.receipts.find((r) => detail(r.detail).withheld_relay === true);
  const relayAssertion = ev.assertions.find((a) => /^step-\d+-relay_withheld$/.test(a.id));
  const observed = RelayObserved.safeParse(relayAssertion?.observed);
  const mandate = ev.identifiers.mandate;
  const verifier = ev.identifiers.verifier ?? MAINNET_VERIFIER;
  const rd = detail(relayReceipt?.detail);
  const problems = [
    ...(relayReceipt === undefined ? ["the evidence records no relay transaction of the withheld order"] : []),
    ...(relayReceipt !== undefined && (relayReceipt.tx_hash === undefined || !isTxHash(relayReceipt.tx_hash)) ? ["the relay has no NEAR transaction hash"] : []),
    ...(relayReceipt !== undefined && rd.signer_id === undefined ? ["the relay's sender is not recorded"] : []),
    ...(relayAssertion !== undefined && !observed.success ? ["the relay verification lacks the removed key, deadline or order id"] : []),
    ...(relayAssertion === undefined ? ["the evidence has no relay verification"] : []),
    ...(mandate === undefined ? ["the mandate account is not recorded"] : []),
  ];
  const relay: ExpectedRelay | null =
    problems.length === 0 && relayReceipt?.tx_hash !== undefined && rd.signer_id !== undefined && observed.success && mandate !== undefined
      ? {
          label: relayReceipt.label,
          tx_hash: relayReceipt.tx_hash,
          sender: rd.signer_id,
          verifier,
          mandate,
          revoked_key: observed.data.revoked_key,
          deadline_ns: observed.data.deadline_ns,
          order_id: observed.data.order_id,
          bundle_sha256: rd.bundle_sha256 ?? null,
        }
      : null;
  return {
    ...base,
    verifier,
    receipts,
    unverifiable,
    relay,
    relay_problem: problems.length === 0 ? null : problems.join("; "),
    current: mandate === undefined ? null : { mandate, grant_key: observed.success ? observed.data.revoked_key : null },
  };
}

/** The page's only script: the client functions, then the click wiring. Identical bytes are tested. */
export function clientScript(): string {
  const body = CLIENT_FUNCTIONS.map((f) => f.toString()).join("\n");
  // Transpilers may wrap names with a `__name` helper (esbuild keepNames); the script has no module scope for it.
  const script = `"use strict";\nconst __name = (f) => f;\n${body}\ninstall(document, (url, init) => fetch(url, init));\n`;
  if (/<\/script|<!--/i.test(script)) throw new Error("client script cannot be inlined: it contains a closing script tag or comment opener");
  return script;
}

export const scriptHash = (script: string): string => `sha256-${createHash("sha256").update(script, "utf8").digest("base64")}`;

const STATIC_STAGES = ["withheld", "revoked", "rejected", "recovered"] as const;

/** Part (c): the recorded sandbox evidence of the withheld order, static. */
function recordedPart(demo: Evidence): string {
  const stages = revocationStory(demo).filter((s) => (STATIC_STAGES as readonly string[]).includes(s.key));
  const rows = stages
    .map((s) => {
      const state = s.outcome === "held" ? word("success", "held") : word(s.outcome === "not-held" ? "failure" : s.outcome, s.outcome);
      const facts = s.facts.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
      return `<li class="vitem"><p>${state} <strong>${escapeHtml(s.title)}</strong> ${escapeHtml(s.headline ?? `not in this evidence: ${s.missing.join("; ")}`)}</p>${facts === "" ? "" : `<dl class="kv">${facts}</dl>`}</li>`;
    })
    .join("");
  return `<p>${modeBadge(demo.mode)} Recorded by <code>${escapeHtml(demo.command)}</code> at revision <code>${escapeHtml(demo.source.product_commit.slice(0, 12))}</code>. Static: these values come from out/evidence/demo.json, not from any network, and say nothing about mainnet.</p><ol class="vitems">${rows}</ol>`;
}

export function verifySection(demo: Evidence, data: VerifyData): string {
  const none = data.receipts.length === 0 && data.unverifiable.length === 0 && data.relay === null && data.relay_problem === null;
  const historical = none
    ? `<p class="pending-title">No mainnet receipts yet.</p><p>The approved mainnet run has not happened, so there is no historical receipt to verify. After it, this part fetches each recorded transaction by hash and sender at final finality and checks the withheld order's relay.</p>`
    : `<p>${String(data.receipts.length)} recorded transactions to check${data.unverifiable.length === 0 ? "" : `, ${String(data.unverifiable.length)} more that cannot be checked (shown as inconclusive)`}${
        data.relay === null ? `; the withheld-order relay cannot be checked: ${escapeHtml(data.relay_problem ?? "not recorded")}` : ", plus the withheld order's relay"
      }. Each transaction's outcome is computed over its whole receipt tree, as the runner records it. The relay passes only if the verifier's receipt failed because the signing key recorded for the withheld order was not registered, at a block time not after the order deadline, and the transaction hash, sender, receiver and bundle sha256 match the evidence; without a recorded bundle sha256 it is inconclusive. This shows the key was absent when the order was relayed, not that it was ever registered or that the order was executable before revocation.</p>`;
  return `<div id="verify-panel" data-verify="${escapeHtml(JSON.stringify(data))}">
<p>Optional and read-only. Nothing is requested until you press the button; then this page queries the RPC below directly from your browser. No wallet, key, account or funds. Each run first checks once that the RPC reports NEAR <code>${escapeHtml(data.chain_id)}</code> with genesis <code>${escapeHtml(data.genesis_hash)}</code>; on a wrong chain, an error or a timeout nothing is shown as verified, and recorded values are never substituted for a failed query.</p>
<p><strong>The RPC you choose is trusted for every answer it returns.</strong> The genesis check only catches a wrong network, not an RPC that returns false data. For an independent result, run the checks again against a second RPC.</p>
<p class="verify-controls"><label for="verify-rpc">Mainnet RPC (archival, so old receipts stay readable)</label> <input id="verify-rpc" type="url" value="${escapeHtml(data.rpc)}" spellcheck="false" autocomplete="off" size="44"> <button id="verify-run" type="button">Run read-only checks</button></p>
<p id="verify-status" class="source" role="status" aria-live="polite"></p>
<div id="verify-chain"></div>
<div class="vparts">
<div class="vpart"><h3>a. Historical mainnet receipts</h3>${historical}<div id="verify-historical"></div></div>
<div class="vpart"><h3>b. Current chain state</h3><p><strong>Current state, not history:</strong> it cannot prove that a historical order was rejected before its deadline. A key absent today says nothing about when it was removed.</p><p>Checks that <code>${escapeHtml(data.verifier)}</code> now runs the verifier WASM the tests ran (code hash <code>${escapeHtml(data.verifier_code_hash)}</code>)${data.current === null ? "" : `, and reads the grant key's registration and the grant of <code>${escapeHtml(data.current.mandate)}</code>`}.</p><div id="verify-current"></div></div>
<div class="vpart"><h3>c. Recorded sandbox evidence</h3>${recordedPart(demo)}</div>
</div></div>`;
}
