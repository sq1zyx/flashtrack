import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { terminateOcr } from "./extract/ocr.js";
import { enqueueAudit, queueStats } from "./jobs.js";
import { auditContract } from "./llm/audit.js";
import { prepareDocument } from "./pipeline.js";
import {
  addCredits, createCode, createJob, getCode, getJob, listCodes, listJobs,
  normalizeCode, recoverInterruptedJobs, refundCredit, reserveCredit, type AccessCode,
} from "./store.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileBytes, files: 1, fields: 10 },
});

export const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));
app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { extensions: ["html"] }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, queue: queueStats() });
});

// --- Access codes ---------------------------------------------------------------------------
// A client buys N audits and gets a code like "K7F2-9QXA". The code is checked from the header
// *before* multer reads the upload, so strangers can't push 20 MB files through OCR.

function codeOf(req: Request): AccessCode {
  const raw = req.header("x-access-code") ?? "";
  if (!raw.trim()) throw new AppError(401, "access_code_required", "Введите код доступа.");
  const code = getCode(raw);
  if (!code || code.disabled) throw new AppError(401, "access_code_invalid", "Код доступа не найден. Проверьте, что он введён без ошибок.");
  return code;
}

const requireCode = (req: Request, res: Response, next: NextFunction) => {
  res.locals.code = codeOf(req);
  next();
};
const currentCode = (res: Response) => res.locals.code as AccessCode;

function charge(code: AccessCode): void {
  if (!reserveCredit(code.code)) {
    throw new AppError(402, "no_credits", "Проверки по этому коду закончились. Чтобы продолжить, пополните пакет.");
  }
}

const creditsLeft = (code: string) => {
  const c = getCode(code)!;
  return { credits_total: c.credits_total, credits_left: c.credits_total - c.credits_used };
};

function requireFile(req: Request): Express.Multer.File {
  if (!req.file) throw new AppError(400, "file_required", "Прикрепите файл в поле «file» (multipart/form-data).");
  // multer decodes the multipart filename as latin1; browsers send UTF-8.
  req.file.originalname = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  return req.file;
}

function auditFields(req: Request) {
  const clientParty = String(req.body?.client_party ?? "").trim();
  if (!clientParty) {
    throw new AppError(400, "client_party_required", "Укажите, чью сторону вы представляете (поле «client_party»), например «Арендатор».");
  }
  if (clientParty.length > 200) throw new AppError(400, "client_party_too_long", "Поле «client_party» слишком длинное.");
  const jurisdiction = String(req.body?.jurisdiction ?? "").trim().slice(0, 100) || "Российская Федерация";
  return { clientParty, jurisdiction, deep: req.body?.deep === "true" };
}

app.get("/api/me", requireCode, (req, res) => {
  res.json(creditsLeft(currentCode(res).code));
});

/** Starts an audit in the background: 202 + job id; poll GET /api/jobs/:id. Used by the web UI. */
app.post("/api/jobs", requireCode, upload.single("file"), (req, res) => {
  const code = currentCode(res);
  const file = requireFile(req);
  const opts = auditFields(req);
  charge(code);
  const job = createJob(code.code, file.originalname, opts.clientParty);
  enqueueAudit({ id: job.id, code: code.code, file: file.buffer, fileName: file.originalname, opts });
  res.status(202).json({ job_id: job.id, status: job.status, ...creditsLeft(code.code) });
});

app.get("/api/jobs/:id", requireCode, (req, res) => {
  const job = getJob(String(req.params.id));
  // Someone else's job looks exactly like a missing one.
  if (!job || job.code !== currentCode(res).code) throw new AppError(404, "job_not_found", "Проверка не найдена.");
  res.json({
    job_id: job.id,
    status: job.status,
    file_name: job.file_name,
    created_at: job.created_at,
    finished_at: job.finished_at,
    ...(job.result_json ? { result: JSON.parse(job.result_json) } : {}),
    ...(job.error_json ? { error: JSON.parse(job.error_json) } : {}),
  });
});

/** Synchronous variant for API clients and scripts: waits for the result (1–3 min). */
app.post("/api/audit", requireCode, upload.single("file"), async (req, res) => {
  const code = currentCode(res);
  const file = requireFile(req);
  const opts = auditFields(req);
  charge(code);
  try {
    const { extraction, doc } = await prepareDocument(file.buffer, file.originalname);
    const { audit, meta } = await auditContract(doc, opts);
    res.json({
      file: { name: file.originalname, size: file.size },
      extraction: { ...extraction, paragraph_count: doc.paragraphs.length },
      audit,
      meta,
      ...(req.body?.include_text === "true" ? { paragraphs: doc.paragraphs } : {}),
    });
  } catch (err) {
    refundCredit(code.code);
    throw err;
  }
});

/** Text extraction only (no Claude call, no credit charged): "what we recognized". */
app.post("/api/extract", requireCode, upload.single("file"), async (req, res) => {
  const file = requireFile(req);
  const { extraction, doc } = await prepareDocument(file.buffer, file.originalname);
  res.json({ file: { name: file.originalname, size: file.size }, extraction, paragraphs: doc.paragraphs });
});

// --- Admin: issue codes after a client pays --------------------------------------------------

function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const token = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const expected = config.adminToken;
  const ok = expected.length >= 16 && token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  if (!ok) throw new AppError(401, "admin_unauthorized", expected ? "Неверный токен администратора." : "ADMIN_TOKEN не задан (минимум 16 символов).");
  next();
}

app.post("/api/admin/codes", requireAdmin, (req, res) => {
  const credits = Number(req.body?.credits);
  if (!Number.isInteger(credits) || credits < 1 || credits > 10_000) throw new AppError(400, "bad_credits", "credits — целое число от 1 до 10000.");
  res.status(201).json(createCode(credits, String(req.body?.note ?? "").slice(0, 200)));
});

app.post("/api/admin/codes/:code/credits", requireAdmin, (req, res) => {
  const credits = Number(req.body?.credits);
  if (!Number.isInteger(credits) || credits < 1) throw new AppError(400, "bad_credits", "credits — целое положительное число.");
  const code = addCredits(normalizeCode(String(req.params.code)), credits);
  if (!code) throw new AppError(404, "code_not_found", "Код не найден.");
  res.json(code);
});

app.get("/api/admin/codes", requireAdmin, (_req, res) => {
  res.json(listCodes());
});

app.get("/api/admin/jobs", requireAdmin, (_req, res) => {
  const jobs = listJobs(200);
  const spent = jobs.reduce((s, j) => s + (j.cost_usd ?? 0), 0);
  res.json({ total_cost_usd_last_200: Math.round(spent * 100) / 100, jobs });
});

// --- Errors ----------------------------------------------------------------------------------

app.use((_req, _res, next) => next(new AppError(404, "not_found", "Маршрут не найден.")));

// Express 5 forwards rejected promises from async handlers here.
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof multer.MulterError) {
    const tooBig = err.code === "LIMIT_FILE_SIZE";
    res.status(tooBig ? 413 : 400).json({
      error: {
        code: tooBig ? "file_too_large" : "bad_upload",
        message: tooBig ? `Файл больше ${Math.round(config.maxFileBytes / 1024 / 1024)} МБ.` : `Ошибка загрузки: ${err.message}`,
      },
    });
    return;
  }
  if (err instanceof AppError) {
    if (err.status >= 500) console.error(`[error] ${err.code}: ${err.message}`, err.details ?? "");
    const retryAfter = (err.details as { retryAfter?: string } | undefined)?.retryAfter;
    if (retryAfter) res.setHeader("Retry-After", retryAfter);
    res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.status < 500 && err.details ? { details: err.details } : {}) } });
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: { code: "bad_json", message: "Некорректный JSON в теле запроса." } });
    return;
  }
  console.error("[error] unhandled:", err);
  res.status(500).json({ error: { code: "internal", message: "Внутренняя ошибка сервера." } });
});

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts")) {
  const recovered = recoverInterruptedJobs();
  if (recovered) console.warn(`[startup] ${recovered} interrupted job(s) failed and refunded`);
  if (!config.adminToken) console.warn("[startup] ADMIN_TOKEN is not set: you won't be able to issue access codes over HTTP (use the CLI: npm run code / node dist/cli.js)");
  const server = app.listen(config.port, () => console.log(`contract-audit-api listening on :${config.port}`));
  // The sync /api/audit endpoint can take minutes on a long contract.
  server.requestTimeout = 15 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  const shutdown = () => {
    server.close(() => terminateOcr().finally(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
