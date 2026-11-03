// Model providers. Each returns the exact raw output plus the decision text; validation happens in the adapter.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { DECISION_JSON_SCHEMA } from "./decision.js";
import type { BuiltPrompt } from "./prompt.js";

export type ProviderName = "anthropic" | "claude-cli" | "recorded";

export interface ModelCall {
  provider: ProviderName;
  requested_model: string;
  /** Model id reported by the provider response. */
  model: string;
  started_at: string;
  finished_at: string;
  /** Exact provider output (CLI stdout or API response JSON). */
  raw_output: string;
  /** The decision JSON text extracted from the raw output, or null if none was produced. */
  decision_text: string | null;
  /** What the provider may have added around our prompt that we cannot observe. */
  harness_note: string;
}

export interface ModelProvider {
  readonly name: ProviderName;
  decide(prompt: BuiltPrompt): Promise<ModelCall>;
}

// --- anthropic: Messages API with structured output ------------------------------------------------

export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic" as const;
  private readonly client: Anthropic;

  constructor(readonly model = process.env.MANDATE_ANTHROPIC_MODEL ?? "claude-opus-5-5") {
    if (process.env.ANTHROPIC_API_KEY === undefined || process.env.ANTHROPIC_API_KEY === "") {
      throw new Error("provider anthropic requires ANTHROPIC_API_KEY in the environment");
    }
    this.client = new Anthropic();
  }

  async decide(prompt: BuiltPrompt): Promise<ModelCall> {
    const started = new Date().toISOString();
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      output_config: { effort: "low", format: { type: "json_schema", schema: DECISION_JSON_SCHEMA } },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    const finished = new Date().toISOString();
    const text =
      response.stop_reason === "refusal"
        ? null
        : response.content
            .flatMap((b) => (b.type === "text" ? [b.text] : []))
            .join("")
            .trim() || null;
    return {
      provider: this.name,
      requested_model: this.model,
      model: response.model,
      started_at: started,
      finished_at: finished,
      raw_output: JSON.stringify(response),
      decision_text: text,
      harness_note: "Anthropic Messages API; system and user prompt sent verbatim; server-side fallback enabled.",
    };
  }
}

// --- claude-cli: headless Claude Code using the local user's existing login -------------------------

const CliResult = z
  .object({
    type: z.string(),
    subtype: z.string().optional(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
    structured_output: z.unknown().optional(),
    modelUsage: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

export function cliArgs(model: string, system: string): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--json-schema",
    JSON.stringify(DECISION_JSON_SCHEMA),
    "--system-prompt",
    system,
    "--tools",
    "",
    "--safe-mode",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--max-budget-usd",
    "0.50",
  ];
}

/** Extracts the decision text and reported model id from `claude -p --output-format json` stdout. */
export function parseCliOutput(stdout: string): { decision_text: string | null; model: string; error?: string } {
  let parsed: z.infer<typeof CliResult>;
  try {
    parsed = CliResult.parse(JSON.parse(stdout));
  } catch (error) {
    return { decision_text: null, model: "unknown", error: `unparseable CLI output: ${String(error)}` };
  }
  const models = Object.keys(parsed.modelUsage ?? {});
  const model = models.length > 0 ? models.join(",") : "unknown";
  if (parsed.is_error === true) return { decision_text: null, model, error: parsed.result ?? parsed.subtype ?? "error" };
  if (parsed.structured_output !== undefined && parsed.structured_output !== null) {
    return { decision_text: JSON.stringify(parsed.structured_output), model };
  }
  return { decision_text: parsed.result?.trim() ?? null, model };
}

export class ClaudeCliProvider implements ModelProvider {
  readonly name = "claude-cli" as const;

  constructor(
    readonly model = process.env.MANDATE_CLI_MODEL ?? "haiku",
    readonly bin = process.env.MANDATE_CLAUDE_BIN ?? "claude",
  ) {}

  async decide(prompt: BuiltPrompt): Promise<ModelCall> {
    const cwd = mkdtempSync(join(tmpdir(), "bm-agent-"));
    const env = { ...process.env };
    // Nested use from inside a Claude Code session: the child must not think it is a sub-process of it.
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    const started = new Date().toISOString();
    try {
      const { stdout, stderr, code } = await run(this.bin, cliArgs(this.model, prompt.system), prompt.user, cwd, env);
      const finished = new Date().toISOString();
      if (code !== 0 && stdout.trim() === "") throw new Error(`claude CLI exited ${code}: ${stderr.slice(0, 500)}`);
      const parsed = parseCliOutput(stdout);
      return {
        provider: this.name,
        requested_model: this.model,
        model: parsed.model,
        started_at: started,
        finished_at: finished,
        raw_output: stdout,
        decision_text: parsed.decision_text,
        harness_note:
          "Claude Code headless (-p, --safe-mode, no tools, custom --system-prompt, --json-schema). The CLI may add harness context we cannot observe.",
      };
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
}

function run(
  bin: string,
  args: string[],
  input: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}
