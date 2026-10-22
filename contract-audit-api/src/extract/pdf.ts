import { InvalidPDFException, PasswordException, FormatError, PDFParse } from "pdf-parse";
import { config } from "../config.js";
import { AppError } from "../errors.js";
import { ocrImage } from "./ocr.js";
import type { ExtractionResult } from "./types.js";

const visibleChars = (s: string) => s.replace(/\s+/g, "").length;

function pdfError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof PasswordException) {
    return new AppError(422, "pdf_encrypted", "PDF защищён паролем. Снимите защиту и загрузите файл снова.");
  }
  if (err instanceof InvalidPDFException || err instanceof FormatError) {
    return new AppError(422, "pdf_corrupted", "PDF повреждён или не является корректным PDF-файлом.", (err as Error).message);
  }
  return new AppError(422, "pdf_unreadable", "Не удалось прочитать PDF.", String((err as Error)?.message ?? err));
}

/**
 * Text-layer PDFs are read directly. Pages without a text layer (scans) are rendered to PNG
 * and OCR'd page by page, so a contract with a scanned signature page or appendix still works.
 */
export async function extractPdf(buf: Buffer): Promise<ExtractionResult> {
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const textResult = await parser.getText().catch((e) => { throw pdfError(e); });
    const pageCount = textResult.total;
    if (pageCount === 0) throw new AppError(422, "pdf_empty", "PDF не содержит страниц.");
    if (pageCount > config.maxPdfPages) {
      throw new AppError(413, "too_many_pages", `Документ слишком длинный: ${pageCount} стр. (максимум ${config.maxPdfPages}).`);
    }

    const pages = textResult.pages.map((p) => p.text);
    const scanned = textResult.pages
      .filter((p) => visibleChars(p.text) < config.minTextCharsPerPage)
      .map((p) => p.num);

    const warnings: string[] = [];
    if (scanned.length === 0) return { sourceKind: "pdf_text", pages, pageCount, ocrPages: [], warnings };

    if (scanned.length > config.maxOcrPages) {
      throw new AppError(413, "too_many_scanned_pages",
        `Слишком много сканированных страниц для распознавания: ${scanned.length} (максимум ${config.maxOcrPages}).`);
    }

    // Render only the pages that need OCR. desiredWidth ~2500px ≈ 300 DPI for A4.
    const shots = await parser
      .getScreenshot({ partial: scanned, desiredWidth: 2500, imageBuffer: true, imageDataUrl: false })
      .catch((e) => { throw pdfError(e); });

    const confidences: number[] = [];
    for (const shot of shots.pages) {
      const { text, confidence } = await ocrImage(shot.data);
      pages[shot.pageNumber - 1] = text;
      confidences.push(confidence);
    }
    const ocrConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
    if (ocrConfidence < 60) warnings.push(`Низкое качество распознавания (${Math.round(ocrConfidence)}%). Проверьте текст или загрузите скан лучшего качества.`);

    return {
      sourceKind: scanned.length === pageCount ? "pdf_scan" : "pdf_mixed",
      pages,
      pageCount,
      ocrPages: scanned,
      ocrConfidence,
      warnings,
    };
  } finally {
    await parser.destroy().catch(() => {});
  }
}
