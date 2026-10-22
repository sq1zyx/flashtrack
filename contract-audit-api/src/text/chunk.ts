import type { NormalizedDoc, Paragraph } from "./normalize.js";

/**
 * Cheap token estimate for packing chunks. Cyrillic text runs ~2.5 chars/token on current
 * Claude tokenizers; the single-pass vs. map-reduce decision uses the exact count_tokens API.
 */
export const estimateTokens = (s: string) => Math.ceil(s.length / 2.5);

export interface Section {
  title: string;
  paragraphs: Paragraph[];
}

export interface Chunk {
  index: number;
  /** Section titles covered by the chunk. */
  titles: string[];
  firstId: string;
  lastId: string;
  text: string;
  estTokens: number;
}

export interface ChunkPlan {
  /** Preamble (parties, subject) + definitions section: sent with every chunk so terms keep their meaning. */
  sharedContext: string;
  /** Table of contents with paragraph ranges: lets the model resolve "see section 7" across chunks. */
  toc: string;
  chunks: Chunk[];
}

const NUMBERED_HEADING = /^(\d{1,2})\.?\s+\S/u; // "1. ПРЕДМЕТ ДОГОВОРА", "2 Права сторон" (but not "2.1. ...")
const NAMED_HEADING = /^(статья|раздел|глава)\s+[\dIVXLC]+|^приложение(\s|$)/iu;
const DEFINITIONS = /термин|определени|понятия/iu;

function isHeading(text: string): boolean {
  if (text.length > 120) return false;
  if (NAMED_HEADING.test(text)) return true;
  if (NUMBERED_HEADING.test(text) && !/^\d+\.\d/.test(text) && !/[.;:]$/.test(text) && text.length <= 90) return true;
  const letters = text.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters.length <= 80 && letters === letters.toUpperCase();
}

export function splitSections(paragraphs: Paragraph[]): Section[] {
  const sections: Section[] = [];
  let current: Section = { title: "Преамбула", paragraphs: [] };
  for (const p of paragraphs) {
    if (isHeading(p.text) && current.paragraphs.length > 0) {
      sections.push(current);
      current = { title: p.text, paragraphs: [p] };
    } else {
      if (isHeading(p.text) && current.paragraphs.length === 0) current.title = p.text;
      current.paragraphs.push(p);
    }
  }
  if (current.paragraphs.length) sections.push(current);
  return sections;
}

const render = (ps: Paragraph[]) => ps.map((p) => `[${p.id}] ${p.text}`).join("\n");

function truncateToTokens(s: string, maxTokens: number): string {
  const maxChars = Math.floor(maxTokens * 2.5);
  return s.length <= maxChars ? s : s.slice(0, maxChars) + "\n…[сокращено]";
}

/** Splits a paragraph that alone exceeds the budget (e.g. OCR text without line breaks) at sentence ends. */
function splitHugeParagraph(p: Paragraph, maxTokens: number): Paragraph[] {
  if (estimateTokens(p.text) <= maxTokens) return [p];
  const maxChars = Math.floor(maxTokens * 2.5);
  const sentences = p.text.match(/[^.!?;]+[.!?;]*\s*/gu) ?? [p.text];
  const parts: Paragraph[] = [];
  let buf = "";
  // A single "sentence" longer than the budget is hard-cut into budget-sized pieces.
  const pieces = sentences.flatMap((s) => Array.from({ length: Math.ceil(s.length / maxChars) }, (_, i) => s.slice(i * maxChars, (i + 1) * maxChars)));
  for (const piece of pieces) {
    if (buf && buf.length + piece.length > maxChars) {
      parts.push({ id: p.id, text: buf.trim() });
      buf = "";
    }
    buf += piece;
  }
  if (buf.trim()) parts.push({ id: p.id, text: buf.trim() });
  return parts;
}

interface Unit {
  title: string;
  paragraphs: Paragraph[];
  tokens: number;
}

/**
 * Packs whole sections into chunks of ~targetTokens. A section that is bigger than the target
 * is split by paragraphs with a small overlap, so a clause is never cut in half and the
 * model sees where the previous part ended.
 */
export function planChunks(
  doc: NormalizedDoc,
  { targetTokens, sharedMaxTokens, overlapParagraphs = 2 }: { targetTokens: number; sharedMaxTokens: number; overlapParagraphs?: number },
): ChunkPlan {
  const sections = splitSections(doc.paragraphs);

  const preamble = sections[0]?.title === "Преамбула" || sections.length === 1 ? sections[0] : undefined;
  const definitions = sections.filter((s) => DEFINITIONS.test(s.title));
  const sharedContext = truncateToTokens(
    [preamble, ...definitions].filter((s): s is Section => !!s).map((s) => render(s.paragraphs)).join("\n"),
    sharedMaxTokens,
  );
  const toc = sections
    .map((s) => `${s.title} [${s.paragraphs[0]!.id}–${s.paragraphs.at(-1)!.id}]`)
    .join("\n");

  const units: Unit[] = [];
  for (const s of sections) {
    const ps = s.paragraphs.flatMap((p) => splitHugeParagraph(p, targetTokens));
    const tokens = estimateTokens(render(ps));
    if (tokens <= targetTokens) {
      units.push({ title: s.title, paragraphs: ps, tokens });
      continue;
    }
    let part = 1;
    let buf: Paragraph[] = [];
    let bufTokens = 0;
    for (const p of ps) {
      const t = estimateTokens(`[${p.id}] ${p.text}\n`);
      if (buf.length > overlapParagraphs && bufTokens + t > targetTokens) {
        units.push({ title: `${s.title} (часть ${part++})`, paragraphs: buf, tokens: bufTokens });
        buf = buf.slice(-overlapParagraphs);
        bufTokens = estimateTokens(render(buf));
      }
      buf.push(p);
      bufTokens += t;
    }
    if (buf.length) units.push({ title: `${s.title} (часть ${part})`, paragraphs: buf, tokens: bufTokens });
  }

  const chunks: Chunk[] = [];
  let acc: Unit[] = [];
  let accTokens = 0;
  const flush = () => {
    if (!acc.length) return;
    const ps = acc.flatMap((u) => u.paragraphs);
    const text = render(ps);
    chunks.push({
      index: chunks.length,
      titles: acc.map((u) => u.title),
      firstId: ps[0]!.id,
      lastId: ps.at(-1)!.id,
      text,
      estTokens: estimateTokens(text),
    });
    acc = [];
    accTokens = 0;
  };
  for (const u of units) {
    if (acc.length && accTokens + u.tokens > targetTokens) flush();
    acc.push(u);
    accTokens += u.tokens;
  }
  flush();

  return { sharedContext, toc, chunks };
}
