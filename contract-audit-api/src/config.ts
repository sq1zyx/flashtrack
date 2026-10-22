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

export const config = {
  port: int("PORT", 3000),

  // --- Claude ---
  model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5-5",
  effort: effort("AUDIT_EFFORT", "medium"),
  deepEffort: effort("AUDIT_DEEP_EFFORT", "high"),
  // Server-side fallback when a safety classifier declines the request (Claude API only).
  useFallbacks: (process.env.ANTHROPIC_USE_FALLBACKS ?? "true") !== "false",
  maxOutputTokens: int("AUDIT_MAX_OUTPUT_TOKENS", 32_000),
  mapConcurrency: int("AUDIT_MAP_CONCURRENCY", 3),

  // --- Chunking ---
  // Above this size the contract is audited section-by-section (map) and then merged (reduce).
  singlePassMaxTokens: int("SINGLE_PASS_MAX_TOKENS", 150_000),
  chunkTargetTokens: int("CHUNK_TARGET_TOKENS", 40_000),
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
  jobConcurrency: int("JOB_CONCURRENCY", 2),
  piiMasking: (process.env.PII_MASKING ?? "true") !== "false",

  // --- OCR (tesseract.js) ---
  ocrLangs: process.env.OCR_LANGS ?? "rus+eng",
  // Where tesseract.js downloads/keeps *.traineddata. Set OCR_LANG_PATH to a local dir for offline servers.
  ocrLangPath: process.env.OCR_LANG_PATH || undefined,
  ocrCachePath: process.env.OCR_CACHE_PATH ?? ".ocr-cache",
};
