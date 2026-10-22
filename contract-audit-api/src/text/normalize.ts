export interface Paragraph {
  id: string; // "P-001"
  text: string;
}

export interface NormalizedDoc {
  paragraphs: Paragraph[];
  /** What the model sees: one paragraph per line, prefixed with its ID: "[P-001] ...". */
  text: string;
  charCount: number;
}

// A line that starts a new clause/list item/heading and must never be glued to the previous line.
const BLOCK_START = /^(\d{1,3}(\.\d{1,3})*\.?\s|\d{1,3}(\.\d{1,3})*\)\s|[а-яёa-z]\)\s|[-–—•]\s|(статья|раздел|глава|приложение|пункт)\s)/iu;
const PAGE_NUMBER = /^[-–—\s]*((стр\.?|страница|page)\s*)?\d{1,4}(\s*(из|of|\/)\s*\d{1,4})?[-–—\s]*$/iu;
const TERMINAL = /[.;:!?»"]$/u;
const ABBREVIATION_END = /(^|[\s(])(ул|д|г|гг|п|пп|ч|ст|руб|коп|кв|корп|стр|оф|пр|просп|пер|обл|р-н|им|т\.е|т\.ч|т\.к|в т\.ч|др|тел|см|№)\.$/iu;

const isAllCaps = (s: string) => {
  const letters = s.replace(/[^\p{L}]/gu, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
};

function cleanChars(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[   \t]/g, " ")
    .replace(/[­​-‍﻿]/g, "");
}

/** Removes running headers/footers: short lines repeated at the top/bottom of most pages. */
function stripRunningLines(pages: string[][]): string[][] {
  if (pages.length < 3) return pages;
  const key = (l: string) => l.trim().replace(/\d+/g, "#").toLowerCase();
  const edge = (lines: string[]) => {
    const nonEmpty = lines.filter((l) => l.trim());
    return new Set([...nonEmpty.slice(0, 2), ...nonEmpty.slice(-2)].map(key));
  };
  const counts = new Map<string, number>();
  for (const p of pages) for (const k of edge(p)) counts.set(k, (counts.get(k) ?? 0) + 1);
  const threshold = Math.max(3, Math.ceil(pages.length * 0.6));
  const running = new Set([...counts].filter(([k, c]) => c >= threshold && k.length > 0 && k.length < 120).map(([k]) => k));
  return pages.map((lines) => lines.filter((l) => !running.has(key(l))));
}

/**
 * @param reflow  Re-join lines that a PDF/OCR layout wrapped mid-sentence. Off for DOCX/TXT,
 *                where every line already is a real paragraph.
 */
export function normalize(pages: string[], { reflow }: { reflow: boolean }): NormalizedDoc {
  const split = stripRunningLines(pages.map((p) => cleanChars(p).split("\n")));
  let joined = split.map((lines) => lines.filter((l) => !PAGE_NUMBER.test(l)).join("\n")).join("\n");
  if (reflow) joined = joined.replace(/(\p{L})-\n(\p{Ll})/gu, "$1$2"); // word hyphenation at line end

  const blocks: string[] = [];
  let current = "";
  for (const raw of joined.split("\n")) {
    const line = raw.replace(/ {2,}/g, " ").trim();
    if (!line) {
      if (current) blocks.push(current);
      current = "";
      continue;
    }
    if (current && reflow && shouldMerge(current, line)) {
      current += " " + line;
    } else {
      if (current) blocks.push(current);
      current = line;
    }
  }
  if (current) blocks.push(current);

  const width = blocks.length > 999 ? 4 : 3;
  const paragraphs = blocks.map((text, i) => ({ id: `P-${String(i + 1).padStart(width, "0")}`, text }));
  const text = paragraphs.map((p) => `[${p.id}] ${p.text}`).join("\n");
  return { paragraphs, text, charCount: text.length };
}

function shouldMerge(prev: string, next: string): boolean {
  if (BLOCK_START.test(next)) return false;
  if (isAllCaps(prev)) return false; // heading
  if (/^\p{Ll}/u.test(next)) return true; // continuation of a sentence
  // "ул.\nЛенина", "ст.\nГК РФ" — but not a date: "01 марта 2026 г." ends a line.
  if (ABBREVIATION_END.test(prev) && !/\d\s*гг?\.$/u.test(prev)) return true;
  // A long line without terminal punctuation was most likely wrapped by the layout.
  return !TERMINAL.test(prev) && prev.length >= 50;
}
