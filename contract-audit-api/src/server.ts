import express, { type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { config } from "./config.js";
import { AppError } from "./errors.js";
import { terminateOcr } from "./extract/ocr.js";
import { auditContract } from "./llm/audit.js";
import { prepareDocument } from "./pipeline.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileBytes, files: 1, fields: 10 },
});

export const app = express();
app.disable("x-powered-by");

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

function requireFile(req: Request): Express.Multer.File {
  if (!req.file) throw new AppError(400, "file_required", "Прикрепите файл в поле «file» (multipart/form-data).");
  // multer decodes the multipart filename as latin1; browsers send UTF-8.
  req.file.originalname = Buffer.from(req.file.originalname, "latin1").toString("utf8");
  return req.file;
}

/** Text extraction only (no Claude call): useful for showing "what we recognized" and for debugging. */
app.post("/api/extract", upload.single("file"), async (req, res) => {
  const file = requireFile(req);
  const { extraction, doc } = await prepareDocument(file.buffer, file.originalname);
  res.json({ file: { name: file.originalname, size: file.size }, extraction, paragraphs: doc.paragraphs });
});

/**
 * multipart/form-data:
 *   file          PDF | DOCX | JPG | PNG | TXT (required)
 *   client_party  whose interests to protect, e.g. "Арендатор" (required)
 *   jurisdiction  default "Российская Федерация"
 *   deep          "true" → higher effort
 *   include_text  "true" → return the paragraphs (for highlighting clause_refs in the UI)
 */
app.post("/api/audit", upload.single("file"), async (req, res) => {
  const file = requireFile(req);
  const clientParty = String(req.body?.client_party ?? "").trim();
  if (!clientParty) {
    throw new AppError(400, "client_party_required", "Укажите, чью сторону вы представляете (поле «client_party»), например «Арендатор».");
  }
  if (clientParty.length > 200) throw new AppError(400, "client_party_too_long", "Поле «client_party» слишком длинное.");
  const jurisdiction = String(req.body?.jurisdiction ?? "").trim().slice(0, 100) || "Российская Федерация";
  const deep = req.body?.deep === "true";

  const { extraction, doc } = await prepareDocument(file.buffer, file.originalname);
  const { audit, meta } = await auditContract(doc, { clientParty, jurisdiction, deep });

  res.json({
    file: { name: file.originalname, size: file.size },
    extraction: { ...extraction, paragraph_count: doc.paragraphs.length },
    audit,
    meta,
    ...(req.body?.include_text === "true" ? { paragraphs: doc.paragraphs } : {}),
  });
});

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
  console.error("[error] unhandled:", err);
  res.status(500).json({ error: { code: "internal", message: "Внутренняя ошибка сервера." } });
});

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.ts")) {
  const server = app.listen(config.port, () => console.log(`contract-audit-api listening on :${config.port}`));
  // A long contract takes minutes; don't let Node cut the connection.
  server.requestTimeout = 15 * 60 * 1000;
  server.headersTimeout = 60 * 1000;
  const shutdown = () => {
    server.close(() => terminateOcr().finally(() => process.exit(0)));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
