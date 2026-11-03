// Recorded model interactions (fixtures/model/*.json) and the replaying provider.
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { sha256Hex } from "./decision.js";
import { PROMPT_VERSION, buildPrompt, type BuiltPrompt } from "./prompt.js";
import type { ModelCall, ModelProvider } from "./providers.js";
import { MarketSnapshot } from "./snapshot.js";

export const PromptVariant = z.enum(["normal", "injection"]);
export type PromptVariant = z.infer<typeof PromptVariant>;

export const ModelInteraction = z
  .object({
    schema_version: z.literal(1),
    /** Genuine model output produced by a real model call. Synthetic attack inputs are never stored here. */
    origin: z.literal("genuine-model"),
    /** "injection" means the market data carried an adversarial instruction; the output is still genuine. */
    prompt_variant: PromptVariant,
    provider: z.enum(["anthropic", "claude-cli"]),
    requested_model: z.string(),
    model: z.string(),
    started_at: z.string(),
    finished_at: z.string(),
    snapshot: MarketSnapshot,
    prompt: z.object({ version: z.string(), system: z.string(), user: z.string(), sha256: z.string() }).strict(),
    raw_output: z.string(),
    raw_output_sha256: z.string(),
    decision_text: z.string().nullable(),
    harness_note: z.string(),
  })
  .strict();
export type ModelInteraction = z.infer<typeof ModelInteraction>;

export function toInteraction(variant: PromptVariant, snapshot: MarketSnapshot, prompt: BuiltPrompt, call: ModelCall): ModelInteraction {
  if (call.provider === "recorded") throw new Error("a replay is not a new recording");
  return {
    schema_version: 1,
    origin: "genuine-model",
    prompt_variant: variant,
    provider: call.provider,
    requested_model: call.requested_model,
    model: call.model,
    started_at: call.started_at,
    finished_at: call.finished_at,
    snapshot,
    prompt,
    raw_output: call.raw_output,
    raw_output_sha256: sha256Hex(call.raw_output),
    decision_text: call.decision_text,
    harness_note: call.harness_note,
  };
}

const Manifest = z.object({ files: z.record(z.string(), z.object({ sha256: z.string() }).loose()) });

export interface LoadedRecording {
  path: string;
  file_sha256: string;
  interaction: ModelInteraction;
}

/**
 * Loads a recording and checks, in order: the file hash against fixtures/manifest.json, the schema,
 * the raw output hash, and that the stored prompt is exactly what this code builds from the stored snapshot.
 */
export function loadRecording(repoRoot: string, path: string): LoadedRecording {
  const fixturesDir = join(repoRoot, "fixtures");
  const rel = relative(fixturesDir, path).split(sep).join("/");
  const bytes = readFileSync(path);
  const fileHash = sha256Hex(bytes);
  const manifest = Manifest.parse(JSON.parse(readFileSync(join(fixturesDir, "manifest.json"), "utf8")));
  const entry = manifest.files[rel];
  if (entry === undefined) throw new Error(`recording fixtures/${rel} is not listed in fixtures/manifest.json`);
  if (entry.sha256 !== fileHash) throw new Error(`recording fixtures/${rel}: sha256 ${fileHash} != manifest ${entry.sha256}`);
  const interaction = ModelInteraction.parse(JSON.parse(bytes.toString("utf8")));
  if (sha256Hex(interaction.raw_output) !== interaction.raw_output_sha256) throw new Error(`recording ${rel}: raw output hash mismatch`);
  if (interaction.prompt.version !== PROMPT_VERSION) throw new Error(`recording ${rel}: prompt version ${interaction.prompt.version} != ${PROMPT_VERSION}`);
  const rebuilt = buildPrompt(interaction.snapshot);
  if (rebuilt.sha256 !== interaction.prompt.sha256 || rebuilt.user !== interaction.prompt.user || rebuilt.system !== interaction.prompt.system) {
    throw new Error(`recording ${rel}: stored prompt does not match the prompt built from its snapshot`);
  }
  return { path: `fixtures/${rel}`, file_sha256: fileHash, interaction };
}

/** Replays a recording, but only for the exact prompt it answered (prompt hash binding). */
export class RecordedProvider implements ModelProvider {
  readonly name = "recorded" as const;
  constructor(readonly recording: LoadedRecording) {}

  decide(prompt: BuiltPrompt): Promise<ModelCall> {
    const rec = this.recording.interaction;
    if (prompt.sha256 !== rec.prompt.sha256) {
      return Promise.reject(
        new Error(
          `recorded provider: prompt ${prompt.sha256} differs from recorded prompt ${rec.prompt.sha256} (${this.recording.path}); the snapshot changed`,
        ),
      );
    }
    return Promise.resolve({
      provider: "recorded",
      requested_model: rec.requested_model,
      model: rec.model,
      started_at: rec.started_at,
      finished_at: rec.finished_at,
      raw_output: rec.raw_output,
      decision_text: rec.decision_text,
      harness_note: `replay of ${this.recording.path} (sha256 ${this.recording.file_sha256}); ${rec.harness_note}`,
    });
  }
}
