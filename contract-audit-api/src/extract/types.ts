export type SourceKind = "docx" | "pdf_text" | "pdf_scan" | "pdf_mixed" | "image" | "txt";

export interface ExtractionResult {
  sourceKind: SourceKind;
  /** Raw text per page (DOCX/TXT: a single "page"). Not yet normalized. */
  pages: string[];
  pageCount: number;
  /** 1-based page numbers that went through OCR. */
  ocrPages: number[];
  /** Mean tesseract confidence (0-100) over OCR'd pages, if any. */
  ocrConfidence?: number;
  warnings: string[];
}
