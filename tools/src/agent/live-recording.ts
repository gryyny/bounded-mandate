// Recording of one live agent decision (out/live/<manifest sha256>/decision-*.json) and its credential-free replay.
// The file is bound to the run ledger by its sha256; a replay rebuilds the prompt from the recorded inputs and
// returns the recorded output only for that exact prompt.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { sha256Hex } from "./decision.js";
import { PROMPT_VERSION, buildPrompt, type BuiltPrompt } from "./prompt.js";
import type { LiveModelCall, LiveModelProvider } from "./providers.js";
import { FreshObservations, RebalanceVerdict, decideRebalance, inputsFrom, type RebalanceDecision } from "./rebalance.js";
import { MarketSnapshot } from "./snapshot.js";

export const LiveDecisionRecording = z
  .object({
    schema_version: z.literal(1),
    kind: z.literal("live-decision"),
    /** Manifest step index (0-based) and the ledger sequence of its decision-request entry. */
    step: z.number().int(),
    request_seq: z.number().int(),
    /** "synthetic" marks a test double, never genuine model output. */
    provider: z.string(),
    requested_model: z.string().nullable(),
    model: z.string().nullable(),
    started_at: z.string(),
    finished_at: z.string(),
    duration_ms: z.number(),
    observations: FreshObservations,
    decimals: z.object({ usdc: z.number().int(), wnear: z.number().int() }).strict(),
    notes: z.array(z.string()),
    snapshot: MarketSnapshot,
    prompt: z.object({ version: z.string(), system: z.string(), user: z.string(), sha256: z.string() }).strict(),
    /** Exact HTTP request body (no headers, no credentials), when the provider is an HTTP API. */
    request_body: z.string().nullable(),
    /** null when the provider produced nothing (thrown error, timeout). */
    raw_output: z.string().nullable(),
    raw_output_sha256: z.string().nullable(),
    decision_text: z.string().nullable(),
    provider_error: z.string().nullable(),
    harness_note: z.string().nullable(),
    verdict: RebalanceVerdict,
  })
  .strict();
export type LiveDecisionRecording = z.infer<typeof LiveDecisionRecording>;

export const recordingName = (step: number, requestSeq: number): string => `decision-step-${step + 1}-request-${requestSeq}.json`;

export interface RecordingContext {
  step: number;
  requestSeq: number;
  provider: string;
  requestedModel: string | null;
  observations: FreshObservations;
  decimals: { usdc: number; wnear: number };
  notes: string[];
  requestBody: string | null;
}

export function toRecording(ctx: RecordingContext, d: RebalanceDecision): LiveDecisionRecording {
  if (d.assessment.kind !== "ask" || d.result === null) throw new Error("only a decision that called the model is recorded");
  const call = d.result.call;
  return {
    schema_version: 1,
    kind: "live-decision",
    step: ctx.step,
    request_seq: ctx.requestSeq,
    provider: call?.provider ?? ctx.provider,
    requested_model: call?.requested_model ?? ctx.requestedModel,
    model: call?.model ?? null,
    started_at: d.result.started_at,
    finished_at: d.result.finished_at,
    duration_ms: Date.parse(d.result.finished_at) - Date.parse(d.result.started_at),
    observations: ctx.observations,
    decimals: ctx.decimals,
    notes: ctx.notes,
    snapshot: d.assessment.snapshot,
    prompt: d.assessment.prompt,
    request_body: call?.request_body ?? ctx.requestBody,
    raw_output: call?.raw_output ?? null,
    raw_output_sha256: call === null ? null : sha256Hex(call.raw_output),
    decision_text: call?.decision_text ?? null,
    provider_error: d.result.error,
    harness_note: call?.harness_note ?? null,
    verdict: d.verdict,
  };
}

export function writeRecording(dir: string, rec: LiveDecisionRecording): { file: string; sha256: string } {
  const text = `${JSON.stringify(rec, null, 2)}\n`;
  const file = recordingName(rec.step, rec.request_seq);
  writeFileSync(join(dir, file), text, { flag: "wx" });
  return { file, sha256: sha256Hex(text) };
}

/** Loads a recording and checks its hash against the ledger, its raw output hash and its prompt. */
export function loadRecording(dir: string, file: string, sha256: string): LiveDecisionRecording {
  const bytes = readFileSync(join(dir, file));
  if (sha256Hex(bytes) !== sha256) throw new Error(`recording ${file}: sha256 ${sha256Hex(bytes)} != ledger ${sha256}`);
  const rec = LiveDecisionRecording.parse(JSON.parse(bytes.toString("utf8")));
  if (rec.raw_output !== null && sha256Hex(rec.raw_output) !== rec.raw_output_sha256) throw new Error(`recording ${file}: raw output hash mismatch`);
  if (rec.prompt.version !== PROMPT_VERSION) throw new Error(`recording ${file}: prompt version ${rec.prompt.version} != ${PROMPT_VERSION}`);
  const rebuilt = buildPrompt(rec.snapshot);
  if (rebuilt.sha256 !== rec.prompt.sha256 || rebuilt.user !== rec.prompt.user || rebuilt.system !== rec.prompt.system) {
    throw new Error(`recording ${file}: stored prompt does not match the prompt built from its snapshot`);
  }
  return rec;
}

/** Returns the recorded output, but only for the exact prompt it answered. No credentials, no network. */
export class LiveRecordingProvider implements LiveModelProvider {
  readonly name = "recorded" as const;
  constructor(readonly rec: LiveDecisionRecording) {}

  decide(prompt: BuiltPrompt): Promise<LiveModelCall> {
    const r = this.rec;
    if (prompt.sha256 !== r.prompt.sha256) return Promise.reject(new Error(`recorded provider: prompt ${prompt.sha256} differs from recorded prompt ${r.prompt.sha256}`));
    if (r.raw_output === null) return Promise.reject(new Error(r.provider_error ?? "recorded provider produced nothing"));
    return Promise.resolve({
      provider: "recorded",
      requested_model: r.requested_model ?? "unknown",
      model: r.model ?? "unknown",
      started_at: r.started_at,
      finished_at: r.finished_at,
      raw_output: r.raw_output,
      decision_text: r.decision_text,
      harness_note: `replay of ${recordingName(r.step, r.request_seq)}; ${r.harness_note ?? ""}`,
      ...(r.provider_error === null ? {} : { error: r.provider_error }),
    });
  }
}

/** Re-runs the decision from the recorded inputs through the adapter and objective guard. */
export async function replayRecording(rec: LiveDecisionRecording): Promise<RebalanceDecision> {
  const inputs = inputsFrom(rec.observations, rec.decimals);
  if (!inputs.ok) throw new Error(`recording inputs are not usable: ${inputs.problems.join("; ")}`);
  return decideRebalance(new LiveRecordingProvider(rec), inputs.inputs, rec.notes);
}
