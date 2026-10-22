import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { z } from "zod";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { addUsage, emptyUsage, type StructuredCaller } from "./call.js";

/**
 * GigaChat API (Sber). Docs: https://developers.sber.ru/docs/ru/gigachat/api/overview
 * - OAuth: the "authorization key" is exchanged for a 30-minute access token.
 * - TLS: GigaChat's certificates chain to the Russian Trusted Root CA (Минцифры), which Node
 *   doesn't ship, so we add it — only for these requests, on top of the standard roots.
 * - No structured outputs: the JSON schema goes into the prompt, the answer is validated with zod,
 *   and validation errors are sent back for a correction (up to 3 attempts).
 */

const extraCa = [process.env.NODE_EXTRA_CA_CERTS].filter((p): p is string => !!p).map((p) => readFileSync(p, "utf8"));
const agent = new https.Agent({
  keepAlive: true,
  ca: [...tls.rootCertificates, ...extraCa, readFileSync(new URL("../../certs/russian_trusted_root_ca.pem", import.meta.url), "utf8")],
});

interface HttpResult {
  status: number;
  body: string;
}

function request(url: string, opts: { method: "GET" | "POST"; headers: Record<string, string>; body?: string; timeoutMs: number }): Promise<HttpResult> {
  const u = new URL(url);
  const lib = u.protocol === "http:" ? http : https; // http only for local tests
  return new Promise((resolve, reject) => {
    const req = lib.request(u, { method: opts.method, headers: opts.headers, ...(lib === https ? { agent } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(new Error(`timeout after ${opts.timeoutMs} ms`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const unavailable = () => new AppError(503, "llm_unavailable", "Сервис анализа временно недоступен. Повторите попытку позже.");
const misconfigured = (why: string) => {
  console.error("[gigachat] config error:", why);
  return new AppError(500, "llm_misconfigured", "Сервис анализа не настроен. Обратитесь в поддержку.");
};

// --- OAuth token -------------------------------------------------------------------------------

let token: { value: string; expiresAt: number } | undefined;

async function getToken(force = false): Promise<string> {
  if (!force && token && token.expiresAt - Date.now() > 60_000) return token.value;
  if (!config.gigachatAuthKey) throw misconfigured("GIGACHAT_AUTH_KEY is empty");

  let res: HttpResult;
  try {
    res = await request(config.gigachatAuthUrl, {
      method: "POST",
      headers: {
        Authorization: `Basic ${config.gigachatAuthKey.trim()}`,
        RqUID: randomUUID(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: `scope=${encodeURIComponent(config.gigachatScope)}`,
      timeoutMs: 30_000,
    });
  } catch (err) {
    console.error("[gigachat] oauth connection error:", (err as Error).message);
    throw unavailable();
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw misconfigured(`oauth ${res.status}: ${res.body.slice(0, 300)} — check GIGACHAT_AUTH_KEY and GIGACHAT_SCOPE`);
  }
  if (res.status !== 200) {
    console.error("[gigachat] oauth error:", res.status, res.body.slice(0, 300));
    throw unavailable();
  }
  const json = JSON.parse(res.body) as { access_token: string; expires_at: number };
  token = { value: json.access_token, expiresAt: json.expires_at };
  return token.value;
}

// --- Chat completions ----------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatResponse {
  choices: { message: { content: string }; finish_reason: string }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model?: string;
}

/** One chat call with token refresh and retries on 429/5xx/network errors. */
export async function gigachatChat(messages: ChatMessage[], maxTokens: number): Promise<ChatResponse> {
  const body = JSON.stringify({ model: config.gigachatModel, messages, max_tokens: maxTokens, temperature: 0.2 });
  const delays = [2_000, 5_000, 15_000];
  let refreshed = false;

  for (let attempt = 0; ; attempt++) {
    let res: HttpResult;
    try {
      res = await request(`${config.gigachatApiUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await getToken()}`, "Content-Type": "application/json", Accept: "application/json" },
        body,
        timeoutMs: 5 * 60_000,
      });
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (attempt < delays.length) { await sleep(delays[attempt]!); continue; }
      console.error("[gigachat] connection error:", (err as Error).message);
      throw unavailable();
    }

    if (res.status === 200) return JSON.parse(res.body) as ChatResponse;
    if (res.status === 401 && !refreshed) { refreshed = true; await getToken(true); continue; }
    if (res.status === 402) {
      console.error("[gigachat] 402: token quota is exhausted — top up the GigaChat package");
      throw new AppError(503, "llm_quota_exhausted", "Сервис анализа временно недоступен. Повторите попытку позже.");
    }
    if (res.status === 404) throw misconfigured(`model "${config.gigachatModel}" not found: ${res.body.slice(0, 300)}`);
    if ((res.status === 429 || res.status >= 500) && attempt < delays.length) { await sleep(delays[attempt]!); continue; }
    if (res.status === 429) throw new AppError(503, "llm_rate_limited", "Сервис анализа перегружен. Повторите попытку через минуту.");
    if (res.status >= 500) throw unavailable();
    console.error("[gigachat] api error:", res.status, res.body.slice(0, 500));
    throw new AppError(502, "llm_error", "Ошибка сервиса анализа.");
  }
}

// --- Structured output on top of plain chat ----------------------------------------------------

/** Pulls the JSON object out of a reply that may be wrapped in ```json fences or prose. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("в ответе нет JSON-объекта");
  return JSON.parse(fenced.slice(start, end + 1));
}

/** Weaker models often return numbers as strings ("8"); fix that before validation. */
function coerceNumbers(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(coerceNumbers);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, k.endsWith("score") && typeof x === "string" && /^\d+$/.test(x.trim()) ? Number(x) : coerceNumbers(x)]));
  }
  return v;
}

const schemaTextCache = new WeakMap<z.ZodType, string>();
function schemaText(schema: z.ZodType): string {
  let s = schemaTextCache.get(schema);
  if (!s) {
    s = JSON.stringify(z.toJSONSchema(schema));
    schemaTextCache.set(schema, s);
  }
  return s;
}

const formatInstructions = (schema: z.ZodType) => `

<output_format>
Верни ответ строго одним JSON-объектом, который соответствует этой JSON Schema (все поля обязательны; пустые списки — [], пустой текст — ""):
${schemaText(schema)}
Никакого текста до или после JSON, без Markdown и без \`\`\`.
</output_format>`;

export const callGigaChat: StructuredCaller = async (req, schema) => {
  const messages: ChatMessage[] = [
    { role: "system", content: req.system + formatInstructions(schema) },
    { role: "user", content: req.content.map((b) => (b.type === "text" ? b.text : "")).join("\n\n") },
  ];
  let usage = emptyUsage();
  let maxTokens = config.gigachatMaxTokens;
  let lastProblem = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await gigachatChat(messages, maxTokens);
    const choice = res.choices[0];
    usage = addUsage(usage, {
      ...emptyUsage(),
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      calls: 1,
    });
    console.info(`[gigachat] ${req.purpose} attempt=${attempt} finish=${choice?.finish_reason} in=${res.usage?.prompt_tokens} out=${res.usage?.completion_tokens}`);

    if (!choice) { lastProblem = "пустой ответ"; continue; }
    if (choice.finish_reason === "blacklist") {
      throw new AppError(422, "llm_refused", "Сервис анализа отказался обрабатывать этот документ.");
    }
    if (choice.finish_reason === "length") {
      lastProblem = "ответ обрезан по длине";
      maxTokens = Math.min(maxTokens * 2, 32_000);
      continue; // same messages, more room
    }

    let issue: string;
    try {
      const parsed = schema.safeParse(coerceNumbers(extractJson(choice.message.content)));
      if (parsed.success) return { data: parsed.data, usage, model: res.model ?? config.gigachatModel };
      issue = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(корень)"}: ${i.message}`).join("; ");
    } catch (err) {
      issue = `не удалось разобрать JSON (${(err as Error).message})`;
    }
    lastProblem = issue;
    // Show the model its own answer and what's wrong with it.
    messages.push(
      { role: "assistant", content: choice.message.content },
      { role: "user", content: `Ответ не соответствует схеме: ${issue}. Верни исправленный JSON целиком, без пояснений.` },
    );
  }

  throw new AppError(502, "llm_invalid_output", "Сервис анализа вернул некорректный результат. Повторите попытку.", lastProblem);
};

/** Quick connectivity check for the CLI: token, model list, a one-line answer. */
export async function gigachatSelfTest(): Promise<{ models: string[]; reply: string }> {
  const t = await getToken(true);
  const res = await request(`${config.gigachatApiUrl}/models`, { method: "GET", headers: { Authorization: `Bearer ${t}`, Accept: "application/json" }, timeoutMs: 30_000 });
  const models = res.status === 200 ? (JSON.parse(res.body) as { data: { id: string }[] }).data.map((m) => m.id) : [];
  const chat = await gigachatChat([{ role: "user", content: "Ответь одним словом: работает?" }], 20);
  return { models, reply: chat.choices[0]?.message.content ?? "" };
}
