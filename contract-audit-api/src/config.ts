import "dotenv/config";

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Env ${name} must be a positive integer, got "${raw}"`);
  return n;
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

function effort(name: string, fallback: Effort): Effort {
  const raw = process.env[name] ?? fallback;
  if (!(EFFORTS as readonly string[]).includes(raw)) throw new Error(`Env ${name} must be one of ${EFFORTS.join(", ")}`);
  return raw as Effort;
}

const PROVIDERS = ["anthropic", "gigachat"] as const;
export type LlmProvider = (typeof PROVIDERS)[number];
const provider = (process.env.LLM_PROVIDER ?? "anthropic") as LlmProvider;
if (!PROVIDERS.includes(provider)) throw new Error(`Env LLM_PROVIDER must be one of ${PROVIDERS.join(", ")}`);
const giga = provider === "gigachat";

export const config = {
  port: int("PORT", 3000),
  llmProvider: provider,

  // --- GigaChat (LLM_PROVIDER=gigachat) ---
  // "Ключ авторизации" from developers.sber.ru — already base64, sent as "Authorization: Basic <key>".
  gigachatAuthKey: process.env.GIGACHAT_AUTH_KEY ?? "",
  // GIGACHAT_API_PERS — individuals; GIGACHAT_API_B2B / GIGACHAT_API_CORP — ИП and companies.
  gigachatScope: process.env.GIGACHAT_SCOPE ?? "GIGACHAT_API_PERS",
  gigachatModel: process.env.GIGACHAT_MODEL ?? "GigaChat-2",
  gigachatMaxTokens: int("GIGACHAT_MAX_TOKENS", 8_000),
  gigachatAuthUrl: process.env.GIGACHAT_AUTH_URL ?? "https://ngw.devices.sberbank.ru:9443/api/v2/oauth",
  gigachatApiUrl: process.env.GIGACHAT_API_URL ?? "https://gigachat.devices.sberbank.ru/api/v1",

  // --- Claude (LLM_PROVIDER=anthropic) ---
  model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  effort: effort("AUDIT_EFFORT", "medium"),
  deepEffort: effort("AUDIT_DEEP_EFFORT", "high"),
  // Server-side fallback when a safety classifier declines the request (Claude API only).
  useFallbacks: (process.env.ANTHROPIC_USE_FALLBACKS ?? "true") !== "false",
  maxOutputTokens: int("AUDIT_MAX_OUTPUT_TOKENS", 32_000),
  // The personal GigaChat tier allows one request at a time.
  mapConcurrency: int("AUDIT_MAP_CONCURRENCY", giga ? 1 : 3),

  // --- Chunking ---
  // Above this size the contract is audited section-by-section (map) and then merged (reduce).
  // Smaller models keep their attention better on shorter inputs, hence lower defaults for GigaChat.
  singlePassMaxTokens: int("SINGLE_PASS_MAX_TOKENS", giga ? 24_000 : 150_000),
  chunkTargetTokens: int("CHUNK_TARGET_TOKENS", giga ? 12_000 : 40_000),
  sharedContextMaxTokens: int("SHARED_CONTEXT_MAX_TOKENS", 6_000),

  // --- Upload / extraction limits ---
  maxFileBytes: int("MAX_FILE_MB", 20) * 1024 * 1024,
  maxPdfPages: int("MAX_PDF_PAGES", 300),
  maxOcrPages: int("MAX_OCR_PAGES", 40),
  // A PDF page with fewer non-whitespace characters than this is treated as a scan and OCR'd.
  minTextCharsPerPage: int("MIN_TEXT_CHARS_PER_PAGE", 40),

  // --- Service ---
  dataDir: process.env.DATA_DIR ?? "data",
  // Bearer token for /api/admin/*. Without it the admin API is disabled.
  adminToken: process.env.ADMIN_TOKEN ?? "",
  jobConcurrency: int("JOB_CONCURRENCY", giga ? 1 : 2),
  piiMasking: (process.env.PII_MASKING ?? "true") !== "false",
  // Reports contain the contract text: delete them after this many days (promised in the privacy policy).
  retentionDays: int("RETENTION_DAYS", 30),

  // --- OCR (tesseract.js) ---
  ocrLangs: process.env.OCR_LANGS ?? "rus+eng",
  // Where tesseract.js downloads/keeps *.traineddata. Set OCR_LANG_PATH to a local dir for offline servers.
  ocrLangPath: process.env.OCR_LANG_PATH || undefined,
  ocrCachePath: process.env.OCR_CACHE_PATH ?? ".ocr-cache",
};
