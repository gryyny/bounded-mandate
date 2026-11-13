// The official NEAR Intents Agent API compared on one axis only: what a caller gets back from each route and what
// revoking or freezing can still reach. Documentation evidence, pinned and dated; nothing here was run against the
// Agent API. Sources render as text, never as links, so the page stays self-contained.
import { escapeHtml } from "./html.js";

/** The examples repository's native-accounts README, pinned to the commit we read. */
export const AGENT_API_EXAMPLES = {
  repository: "https://github.com/NEAR-Intents-Agent-API/examples",
  commit: "25528957276e18ec933eb7d6e8e5c59a5fe033c4",
  file: "07-native-accounts/README.md",
  lines: "L90-L116",
  read: "2026-11-06",
} as const;
export const AGENT_API_EXAMPLES_URL = `${AGENT_API_EXAMPLES.repository}/blob/${AGENT_API_EXAMPLES.commit}/${AGENT_API_EXAMPLES.file}#${AGENT_API_EXAMPLES.lines}`;

/** Hosted documentation for the ordinary action routes. */
export const AGENT_API_DOCS = {
  limitOrders: "https://docs.agentsonintents.com/integration/agent-api/limit-orders",
  executions: "https://docs.agentsonintents.com/integration/agent-api/executions",
  grants: "https://docs.agentsonintents.com/integration/agent-api/grants",
  read: "2026-11-13",
} as const;

/** One sentence of the pinned README (L114-L115), quoted verbatim. */
export const AGENT_API_QUOTE = "Freezing the account refuses new payloads but cannot recall one already signed.";

const code = (s: string): string => `<code>${escapeHtml(s)}</code>`;

const ROWS: readonly [route: string, receives: string, reach: string][] = [
  [
    `Hosted actions: ${code("POST /v1/agents/{agent_id}/swap")}, ${code("limit-orders")}, ${code("transfer")}, ${code("withdraw")}, ${code("shield")}, ${code("unshield")}`,
    "A status. The API and the agent's wallet execute the action; no signed order is returned to the caller.",
    `Revoking the grant stops an action that has not reached its dispatch commitment; after it, the docs say nothing can recall it, except that a resting limit order can still be cancelled (what revoking a grant does to one is not documented). Limit orders are priced within a policy bound (${code("limit_order.max_deviation_bps")}, 0 to 300 basis points, default 100); cancelling needs only a grant, works while the agent is frozen and refunds the unfilled part; a freeze makes the API cancel resting orders (best effort). Not described as handing out a signature.`,
  ],
  [
    `Native ${code("evm/sign-intent")} and ${code("solana/sign-intent")}, off until the owner sets ${code("evm.sign_intent")} or ${code("solana.sign_intent")}`,
    `A signed NEAR Intents payload (${code("transfer")} intents only, signed for that key's own Intents account), returned to the caller. Anyone holding it can publish it until its deadline.`,
    `Revoking or freezing refuses new payloads. The examples README: “${escapeHtml(AGENT_API_QUOTE)}” The policy's destinations, assets, limits, budget, timelock, schedule and approval do not apply; the owner's ${code("sign_intent")} rules do.`,
  ],
  [
    "Bounded mandate",
    `Nothing signable. The agent may only call ${code("propose_order")}; the contract signs each order itself.`,
    `Confirmed removal of the grant's key on ${code("intents.near")} fails every outstanding signed order of the grant, withheld ones included (sandbox gate T1).`,
  ],
];

/** Body of the page's Agent API comparison section. */
export function agentApiBody(): string {
  const rows = ROWS.map(([route, receives, reach]) => `<tr><td class="route">${route}</td><td>${receives}</td><td>${reach}</td></tr>`).join("");
  return `<p class="source">Sources: ${code(AGENT_API_EXAMPLES_URL)} (repository ${code(AGENT_API_EXAMPLES.repository)}, commit ${code(AGENT_API_EXAMPLES.commit)}), read ${AGENT_API_EXAMPLES.read}; ${code(AGENT_API_DOCS.limitOrders)}, ${code(AGENT_API_DOCS.executions)} and ${code(AGENT_API_DOCS.grants)}, read ${AGENT_API_DOCS.read}.</p>
<p>The official NEAR Intents Agent API is a hosted service and much broader than this project: many chains, assets and action types under one owner-signed policy. This compares only what each route hands its caller and what revocation can still reach.</p>
<div class="scroll"><table><caption>Signed authority per route</caption><thead><tr><th scope="col">Route</th><th scope="col">What the caller receives</th><th scope="col">What revoking or freezing reaches</th></tr></thead><tbody>${rows}</tbody></table></div>
<p><strong>Documentation evidence, not a tested weakness.</strong> We have not called the Agent API. The sign-intent behaviour is what the Agent API's own examples README documents and warns about; ordinary hosted execution is not described this way.</p>
<h3>Complementary, not competing</h3>
<ul><li>Agent API for breadth: chains, assets, action types, hosted execution, including limit orders with a policy price bound and cancellation.</li><li>Bounded mandate where trading limits and revocation must be verifiable on chain: a contract checks the limits before it signs, and revocation is a key removal anyone can check with a view call.</li><li>Any integration of the two is proposed, not built: it stays untested until caller identity (which account the mandate sees calling <code>propose_order</code>) and invocation compatibility are tested.</li></ul>`;
}
