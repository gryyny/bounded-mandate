// LLM-to-proposal adapter: snapshot -> prompt -> model -> strict validation -> `propose_order` only.
import type { Account } from "near-api-js";
import { MAX_GAS, type NearClient, type Outcome } from "../near/client.js";
import type { Proposal } from "../types.js";
import { parseJsonText, sha256Hex, validateDecision, type AdapterVerdict } from "./decision.js";
import { buildPrompt, type BuiltPrompt } from "./prompt.js";
import type { ModelCall, ModelProvider } from "./providers.js";
import type { MarketSnapshot } from "./snapshot.js";

export interface AgentDecision {
  prompt: BuiltPrompt;
  call: ModelCall;
  verdict: AdapterVerdict;
}

export function judge(decisionText: string | null): AdapterVerdict {
  if (decisionText === null) return { kind: "rejected", boundary: "adapter-schema", errors: ["model produced no decision"] };
  const json = parseJsonText(decisionText);
  if (!json.ok) return { kind: "rejected", boundary: "adapter-schema", errors: [`not JSON: ${json.error}`] };
  return validateDecision(json.value);
}

export async function decide(provider: ModelProvider, snapshot: MarketSnapshot): Promise<AgentDecision> {
  const prompt = buildPrompt(snapshot);
  const call = await provider.decide(prompt);
  return { prompt, call, verdict: judge(call.decision_text) };
}

/** The adapter's only chain action. The agent account is expected to hold only a propose_order function-call key. */
export function submitProposal(
  client: NearClient,
  agent: Account,
  mandateId: string,
  proposal: Proposal,
  label = "agent propose_order",
): Promise<Outcome> {
  return client.call(label, agent, mandateId, "propose_order", { proposal }, { gas: MAX_GAS });
}

/** Evidence-ready summary of a decision; the full prompt and raw output live in the recording. */
export function decisionRecord(d: AgentDecision): Record<string, unknown> {
  return {
    provider: d.call.provider,
    requested_model: d.call.requested_model,
    model: d.call.model,
    started_at: d.call.started_at,
    finished_at: d.call.finished_at,
    prompt_version: d.prompt.version,
    prompt_sha256: d.prompt.sha256,
    raw_output_sha256: sha256Hex(d.call.raw_output),
    decision_text: d.call.decision_text,
    harness_note: d.call.harness_note,
    adapter_verdict: d.verdict,
  };
}
