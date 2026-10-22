import type { Paragraph } from "../text/normalize.js";
import type { AuditResult } from "./schema.js";

export type VerifiedFinding = AuditResult["findings"][number] & {
  /** The quote was found in the contract text (exactly or ≥80% of its fragments). */
  quote_verified: boolean;
};
export type VerifiedAudit = Omit<AuditResult, "findings"> & { findings: VerifiedFinding[] };

const norm = (s: string) =>
  s.toLowerCase()
    .replace(/\[p-\d+\]/g, " ")
    .replace(/[«»"“”„'’`]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/ё/g, "е")
    .replace(/\s+/g, " ")
    .trim();

function quoteFound(quote: string, haystack: string): boolean {
  const q = norm(quote).replace(/^\.{3}|…|\.{3}$/g, "").trim(); // the model may elide with "…"
  if (!q) return false;
  if (haystack.includes(q)) return true;
  const size = 40;
  if (q.length <= size) return false;
  const pieces = Array.from({ length: Math.ceil(q.length / size) }, (_, i) => q.slice(i * size, (i + 1) * size)).filter((p) => p.length >= 15);
  return pieces.filter((p) => haystack.includes(p)).length / pieces.length >= 0.8;
}

/**
 * Anti-hallucination pass: checks every quote against the source text and drops clause_refs
 * that don't exist. Unverified findings are kept but flagged, so the UI can mark them.
 */
export function verifyAudit(audit: AuditResult, paragraphs: Paragraph[]): VerifiedAudit {
  const known = new Map(paragraphs.map((p) => [p.id, p.text]));
  const whole = norm(paragraphs.map((p) => p.text).join(" "));

  const findings = audit.findings
    .map((f) => {
      const refs = [...new Set(f.clause_refs.map((r) => r.trim().toUpperCase().replace(/^\[|\]$/g, "")))].filter((r) => known.has(r));
      const local = norm(refs.map((r) => known.get(r)!).join(" "));
      const quote_verified = (local !== "" && quoteFound(f.quote, local)) || quoteFound(f.quote, whole);
      return { ...f, clause_refs: refs, quote_verified };
    })
    .sort((a, b) => b.risk_score - a.risk_score);

  const keyDates = audit.key_dates.map((d) => ({ ...d, clause_refs: d.clause_refs.filter((r) => known.has(r)) }));
  return { ...audit, findings, key_dates: keyDates };
}
