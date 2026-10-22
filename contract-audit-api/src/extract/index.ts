import { fileTypeFromBuffer } from "file-type";
import { AppError } from "../errors.js";
import { extractDocx } from "./docx.js";
import { ocrImage } from "./ocr.js";
import { extractPdf } from "./pdf.js";
import type { ExtractionResult } from "./types.js";

export type { ExtractionResult, SourceKind } from "./types.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const IMAGES = new Set(["image/png", "image/jpeg", "image/webp", "image/tiff", "image/bmp"]);

/** Detects the real type from magic bytes (the client-supplied extension/MIME is not trusted). */
export async function extractText(buf: Buffer, originalName = ""): Promise<ExtractionResult> {
  if (buf.length === 0) throw new AppError(400, "empty_file", "Файл пустой.");

  const ft = await fileTypeFromBuffer(buf);
  const mime = ft?.mime;

  if (mime === "application/pdf") return extractPdf(buf);
  if (mime === DOCX) return extractDocx(buf);
  if (mime && IMAGES.has(mime)) {
    const { text, confidence } = await ocrImage(buf);
    const warnings = confidence < 60
      ? [`Низкое качество распознавания (${Math.round(confidence)}%). Сфотографируйте документ ровно, при хорошем освещении.`]
      : [];
    return { sourceKind: "image", pages: [text], pageCount: 1, ocrPages: [1], ocrConfidence: confidence, warnings };
  }
  if (mime === "application/x-cfb" || /\.doc$/i.test(originalName)) {
    throw new AppError(415, "legacy_doc", "Формат .doc не поддерживается. Пересохраните документ в .docx или PDF.");
  }
  if (mime === "image/heic" || mime === "image/heif") {
    throw new AppError(415, "heic_unsupported", "Формат HEIC не поддерживается. Отправьте фото в JPG или PNG.");
  }
  if (mime === "application/zip" && /\.docx$/i.test(originalName)) {
    // A .docx whose OOXML parts are broken is detected as a plain zip.
    throw new AppError(422, "docx_corrupted", "DOCX повреждён или не является документом Word.");
  }
  if (!mime) {
    const text = decodeUtf8Strict(buf);
    if (text !== undefined) return { sourceKind: "txt", pages: [text], pageCount: 1, ocrPages: [], warnings: [] };
    if (/\.(pdf|docx|jpe?g|png)$/i.test(originalName)) {
      throw new AppError(422, "file_corrupted", "Файл повреждён: его содержимое не соответствует расширению.");
    }
  }
  throw new AppError(415, "unsupported_type", `Неподдерживаемый тип файла${mime ? ` (${mime})` : ""}. Загрузите PDF, DOCX, JPG или PNG.`);
}

function decodeUtf8Strict(buf: Buffer): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return undefined;
  }
}
