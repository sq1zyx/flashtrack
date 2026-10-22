import { z } from "zod";

// min/max are not part of the structured-outputs JSON Schema subset: the SDK strips them from
// the schema it sends and enforces them when it parses the response.
const Score = z.number().int().min(1).max(10);
const ClauseRef = z.string().describe("ID абзаца вида P-012");

export const Finding = z.object({
  id: z.string().describe("F-1, F-2, …"),
  category: z.enum([
    "penalties_liability",
    "termination_unilateral",
    "payment_pricing",
    "hidden_trap",
    "ambiguity",
    "dispute_resolution",
    "subject_performance",
    "acceptance",
    "ip_confidentiality",
    "consumer_rights",
    "other",
  ]),
  title: z.string(),
  clause_refs: z.array(ClauseRef),
  quote: z.string().describe("Дословная цитата из договора, до 300 символов"),
  risk_score: Score,
  legal_status: z.enum(["unfavorable", "potentially_void", "ambiguous"]),
  explanation: z.string().describe("Чем это грозит клиенту на практике, с примером сценария"),
  financial_impact: z.string().describe("Оценка суммы или формулы потерь; пустая строка, если неприменимо"),
  legal_basis: z.array(z.object({ source: z.string(), article: z.string(), note: z.string() })),
  recommendation: z.string(),
  suggested_wording: z.string(),
  negotiation_tip: z.string().describe("Как аргументировать правку контрагенту"),
});

const MissingClause = z.object({
  title: z.string(),
  why_important: z.string(),
  suggested_wording: z.string(),
  risk_score: Score,
});

const KeyDate = z.object({ event: z.string(), deadline: z.string(), clause_refs: z.array(ClauseRef) });

export const AuditSchema = z.object({
  document: z.object({
    contract_type: z.string(),
    title: z.string(),
    parties: z.array(z.object({ name: z.string(), role: z.string() })),
    client_party: z.string(),
    subject_summary: z.string().describe("Суть договора в 1–2 предложениях"),
    governing_law: z.string(),
  }),
  overall: z.object({
    risk_score: Score,
    verdict: z.enum(["sign", "sign_after_edits", "do_not_sign_without_major_changes"]),
    summary: z.string().describe("3–5 предложений: главное для клиента"),
    top_risks: z.array(z.string()).describe("До 3 самых важных рисков, по одной фразе"),
  }),
  findings: z.array(Finding),
  missing_clauses: z.array(MissingClause),
  key_dates: z.array(KeyDate),
  questions_to_counterparty: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  limitations: z.string(),
});
export type AuditResult = z.infer<typeof AuditSchema>;

/** Map step output: what can be judged from one part of a long contract. */
export const ChunkAuditSchema = z.object({
  findings: z.array(Finding),
  key_dates: z.array(KeyDate),
  /** Facts the merge step needs: parties, price, term, references to other sections, etc. */
  notes_for_merge: z.array(z.string()),
});
export type ChunkAuditResult = z.infer<typeof ChunkAuditSchema>;
