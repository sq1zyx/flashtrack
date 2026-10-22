import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config, type Effort } from "../config.js";
import { AppError, fromAnthropicError } from "../errors.js";

let client: Anthropic | undefined;
// Created lazily so the server (and /api/extract) starts without credentials.
function anthropic(): Anthropic {
  client ??= new Anthropic({
    maxRetries: 3, // SDK retries 408/409/429/5xx and connection errors with backoff
    timeout: 10 * 60 * 1000,
  });
  return client;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation_1h_tokens: number;
  calls: number;
}

export const emptyUsage = (): Usage => ({
  input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0, cache_creation_1h_tokens: 0, calls: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_creation_1h_tokens: a.cache_creation_1h_tokens + b.cache_creation_1h_tokens,
    calls: a.calls + b.calls,
  };
}

export interface StructuredRequest {
  purpose: string;
  /** Static system prompt; always cached. */
  system: string;
  /** User content. Put cache_control on the last stable block yourself. */
  content: Anthropic.Beta.BetaContentBlockParam[];
  effort: Effort;
}

export interface StructuredResponse<T> {
  data: T;
  usage: Usage;
  model: string;
}

/** Abstraction over the Claude call so the pipeline can be tested without the network. */
export type StructuredCaller = <T>(req: StructuredRequest, schema: z.ZodType<T>) => Promise<StructuredResponse<T>>;

// Converting the zod schema is deterministic, but cache it anyway: the schema is part of the
// prompt prefix, and a byte-identical schema keeps the prompt cache warm.
const schemaCache = new WeakMap<z.ZodType, Record<string, unknown>>();
function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  let s = schemaCache.get(schema);
  if (!s) {
    s = zodOutputFormat(schema).schema as Record<string, unknown>;
    schemaCache.set(schema, s);
  }
  return s;
}

export const callClaude: StructuredCaller = async <T>(req: StructuredRequest, schema: z.ZodType<T>) => {
  let usage = emptyUsage();
  let maxTokens = config.maxOutputTokens;
  let lastProblem = "";

  // Structured outputs guarantee valid JSON for the schema; the retry covers truncation
  // (max_tokens) and the client-side constraints (min/max) the API doesn't enforce.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let msg: Anthropic.Beta.BetaMessage;
    try {
      const stream = anthropic().beta.messages.stream({
        model: config.model,
        max_tokens: maxTokens,
        ...(config.useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        output_config: { effort: req.effort, format: { type: "json_schema", schema: jsonSchemaFor(schema) } },
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: req.content }],
      });
      msg = await stream.finalMessage();
    } catch (err) {
      if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError)) {
        // Client-side failure before any request, e.g. no API key configured.
        console.error("[anthropic] client error:", err.message);
        throw new AppError(500, "llm_misconfigured", "Сервис анализа не настроен. Обратитесь в поддержку.");
      }
      throw fromAnthropicError(err) ?? err;
    }

    usage = addUsage(usage, toUsage(msg.usage));
    console.info(`[claude] ${req.purpose} attempt=${attempt} model=${msg.model} stop=${msg.stop_reason} ` +
      `in=${msg.usage.input_tokens} out=${msg.usage.output_tokens} cache_read=${msg.usage.cache_read_input_tokens ?? 0}`);

    if (msg.stop_reason === "refusal") {
      throw new AppError(422, "llm_refused", "Сервис анализа отказался обрабатывать этот документ.", msg.stop_details ?? undefined);
    }
    if (msg.stop_reason === "max_tokens") {
      lastProblem = "ответ обрезан по max_tokens";
      maxTokens = Math.min(maxTokens * 2, 128_000);
      continue;
    }

    const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      lastProblem = "ответ не является JSON";
      continue;
    }
    const parsed = schema.safeParse(json);
    if (parsed.success) return { data: parsed.data, usage, model: msg.model };
    lastProblem = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }

  throw new AppError(502, "llm_invalid_output", "Сервис анализа вернул некорректный результат. Повторите попытку.", lastProblem);
};

function toUsage(u: Anthropic.Beta.BetaUsage): Usage {
  return {
    input_tokens: u.input_tokens,
    output_tokens: u.output_tokens,
    cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
    cache_creation_1h_tokens: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
    calls: 1,
  };
}

/** Exact token count for routing (single pass vs. map-reduce). Falls back to an estimate on failure. */
export async function countTokens(system: string, text: string, estimate: number): Promise<{ tokens: number; exact: boolean }> {
  try {
    const res = await anthropic().beta.messages.countTokens({
      model: config.model,
      system,
      messages: [{ role: "user", content: text }],
    });
    return { tokens: res.input_tokens, exact: true };
  } catch (err) {
    console.warn("[claude] count_tokens failed, using estimate:", (err as Error).message);
    return { tokens: estimate, exact: false };
  }
}

// $ per 1M tokens. Check https://platform.claude.com/docs/en/about-claude/pricing before relying on it.
const PRICES: Record<string, { in: number; out: number; read: number; w5m: number; w1h: number }> = {
  "claude-sonnet-5-5": { in: 2, out: 10, read: 0.2, w5m: 2.5, w1h: 4 },
  "claude-opus-5-5": { in: 4, out: 20, read: 0.2, w5m: 5, w1h: 8 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, read: 0.01, w5m: 0.125, w1h: 0.2 },
};

export function costUsd(model: string, u: Usage): number | null {
  const p = PRICES[model];
  if (!p) return null;
  const w1h = u.cache_creation_1h_tokens;
  const w5m = u.cache_creation_input_tokens - w1h;
  const usd = (u.input_tokens * p.in + u.output_tokens * p.out + u.cache_read_input_tokens * p.read + w5m * p.w5m + w1h * p.w1h) / 1e6;
  return Math.round(usd * 1e5) / 1e5;
}
