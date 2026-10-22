import { config } from "./config.js";
import { AppError } from "./errors.js";
import { extractText, type ExtractionResult } from "./extract/index.js";
import { normalize, type NormalizedDoc } from "./text/normalize.js";
import { maskPii } from "./text/pii.js";

export interface PreparedDocument {
  extraction: Omit<ExtractionResult, "pages"> & { pii_masked: Record<string, number> | null };
  doc: NormalizedDoc;
}

/** Upload → text: format detection, extraction/OCR, cleanup, paragraph IDs, PII masking. */
export async function prepareDocument(buf: Buffer, originalName: string): Promise<PreparedDocument> {
  const extraction = await extractText(buf, originalName);
  const reflow = extraction.sourceKind !== "docx" && extraction.sourceKind !== "txt";
  let doc = normalize(extraction.pages, { reflow });

  const letters = doc.paragraphs.reduce((n, p) => n + (p.text.match(/\p{L}/gu)?.length ?? 0), 0);
  if (letters < 200) {
    throw new AppError(422, "no_text", "В документе не найден текст договора. Проверьте файл или загрузите скан лучшего качества.", {
      sourceKind: extraction.sourceKind,
      letters,
    });
  }

  let piiCounts: Record<string, number> | null = null;
  if (config.piiMasking) {
    const masked = maskPii(doc);
    doc = masked.doc;
    piiCounts = masked.counts;
  }

  const { pages: _pages, ...meta } = extraction;
  return { extraction: { ...meta, pii_masked: piiCounts }, doc };
}
