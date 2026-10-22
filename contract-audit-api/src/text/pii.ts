import type { NormalizedDoc } from "./normalize.js";

/**
 * Replaces personal data with placeholders ([ТЕЛЕФОН_1], [ПАСПОРТ_1], …) before the text leaves
 * the server. Only patterns that the audit doesn't need are masked: names of the parties and
 * company details (10-digit ИНН, ОГРН) stay, since the analysis refers to them.
 * Regex-based, so it is a safety net, not a guarantee — tell users so in the privacy policy.
 */
interface Rule {
  label: string;
  re: RegExp;
  /** Index of the capture group to mask; 0 = the whole match. */
  group?: number;
}

const RULES: Rule[] = [
  // Passport: "паспорт серии 45 12 № 345678", "паспорт 4512 345678"
  { label: "ПАСПОРТ", re: /(паспорт[^\n\d]{0,40})(\d{2}\s?\d{2}[\s№N]{0,4}\d{6})/giu, group: 2 },
  { label: "СНИЛС", re: /\b\d{3}-\d{3}-\d{3}[\s-]\d{2}\b/gu },
  // ИНН of a person/ИП is 12 digits (companies: 10 — those stay).
  { label: "ИНН", re: /(ИНН[\s:№]*)(\d{12})(?!\d)/giu, group: 2 },
  { label: "СЧЁТ", re: /(?<!\d)\d{20}(?!\d)/gu },
  { label: "КАРТА", re: /(?<!\d)(?:\d{4}[ -]?){3}\d{4}(?!\d)/gu },
  { label: "ТЕЛЕФОН", re: /(?<![\d\w])(?:\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}(?!\d)/gu },
  { label: "EMAIL", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu },
  { label: "ДАТА_РОЖДЕНИЯ", re: /((?:дата рождения|родил(?:ся|ась)|г\.\s?р\.)[\s:]*)(\d{2}\.\d{2}\.\d{4})/giu, group: 2 },
];

export interface MaskResult {
  doc: NormalizedDoc;
  /** How many values of each kind were masked (the values themselves are not kept). */
  counts: Record<string, number>;
}

export function maskPii(doc: NormalizedDoc): MaskResult {
  const counts: Record<string, number> = {};
  const seen = new Map<string, string>(); // same value → same placeholder across the document

  const paragraphs = doc.paragraphs.map((p) => {
    let text = p.text;
    for (const rule of RULES) {
      text = text.replace(rule.re, (...m: string[]) => {
        const target = m[rule.group ?? 0]!;
        let digits = target.replace(/\D/g, "");
        if (rule.label === "ТЕЛЕФОН") digits = digits.slice(-10); // +7 916… and 8 916… are the same number
        const key = `${rule.label}:${digits || target.toLowerCase()}`;
        let ph = seen.get(key);
        if (!ph) {
          counts[rule.label] = (counts[rule.label] ?? 0) + 1;
          ph = `[${rule.label}_${counts[rule.label]}]`;
          seen.set(key, ph);
        }
        return rule.group ? m[0]!.replace(target, ph) : ph;
      });
    }
    return { ...p, text };
  });

  const text = paragraphs.map((p) => `[${p.id}] ${p.text}`).join("\n");
  return { doc: { paragraphs, text, charCount: text.length }, counts };
}
