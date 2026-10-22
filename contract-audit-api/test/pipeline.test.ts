import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { terminateOcr } from "../src/extract/ocr.js";
import { auditContract, type Deps } from "../src/llm/audit.js";
import type { StructuredCaller, StructuredRequest } from "../src/llm/call.js";
import { AuditSchema, ChunkAuditSchema, type AuditResult } from "../src/llm/schema.js";
import { verifyAudit } from "../src/llm/verify.js";
import { prepareDocument } from "../src/pipeline.js";
import { app } from "../src/server.js";
import { planChunks } from "../src/text/chunk.js";
import { normalize } from "../src/text/normalize.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

afterAll(() => terminateOcr());

describe("extraction", () => {
  it("DOCX keeps Word auto-numbering", async () => {
    const { extraction, doc } = await prepareDocument(fixture("lease.docx"), "lease.docx");
    expect(extraction.sourceKind).toBe("docx");
    expect(doc.text).toContain("[P-012] 3.2. Арендодатель вправе в одностороннем порядке изменять размер арендной платы");
  });

  it("PDF with a text layer is read without OCR and wrapped lines are re-joined", async () => {
    const { extraction, doc } = await prepareDocument(fixture("lease.pdf"), "lease.pdf");
    expect(extraction).toMatchObject({ sourceKind: "pdf_text", ocrPages: [] });
    expect(doc.paragraphs.some((p) => p.text.includes("ул. Ленина, д. 1."))).toBe(true);
    expect(doc.paragraphs[0]!.text).toBe("ДОГОВОР АРЕНДЫ НЕЖИЛОГО ПОМЕЩЕНИЯ № 17/24");
  });

  it("photo is OCR'd with tesseract", { timeout: 120_000 }, async () => {
    const { extraction, doc } = await prepareDocument(fixture("lease-photo.jpg"), "photo.jpg");
    expect(extraction.sourceKind).toBe("image");
    expect(extraction.ocrConfidence).toBeGreaterThan(70);
    expect(doc.text).toMatch(/Обеспечительный платеж в размере 300 000 рублей/);
  });

  it("scanned PDF (no text layer) is rendered and OCR'd", { timeout: 120_000 }, async () => {
    const { extraction, doc } = await prepareDocument(fixture("lease-scan.pdf"), "scan.pdf");
    expect(extraction).toMatchObject({ sourceKind: "pdf_scan", ocrPages: [1] });
    expect(doc.text).toMatch(/Арбитражном суде города Владивостока/);
  });

  it.each([
    ["broken.pdf", 422, "pdf_corrupted"],
    ["broken.docx", 422, "docx_corrupted"],
  ])("rejects corrupted %s", async (name, status, code) => {
    await expect(prepareDocument(fixture(name), name)).rejects.toMatchObject({ status, code });
  });

  it("rejects legacy .doc and empty files", async () => {
    await expect(prepareDocument(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, ...new Array(600).fill(0)]), "a.doc"))
      .rejects.toMatchObject({ status: 415, code: "legacy_doc" });
    await expect(prepareDocument(Buffer.alloc(0), "a.pdf")).rejects.toMatchObject({ status: 400, code: "empty_file" });
  });
});

describe("normalize", () => {
  it("strips running headers/page numbers and fixes hyphenation", () => {
    const page = (n: number, body: string) => `ООО «Ромашка» — Договор аренды\n${body}\nСтраница ${n} из 3`;
    const doc = normalize([
      page(1, "1.1. Арендатор обязуется вносить пла-\nтежи вовремя."),
      page(2, "2.1. Срок аренды 11 месяцев."),
      page(3, "3.1. Споры решаются в суде."),
    ], { reflow: true });
    expect(doc.paragraphs.map((p) => p.text)).toEqual([
      "1.1. Арендатор обязуется вносить платежи вовремя.",
      "2.1. Срок аренды 11 месяцев.",
      "3.1. Споры решаются в суде.",
    ]);
  });
});

describe("chunking", () => {
  it("packs whole sections, carries definitions + TOC, never cuts a paragraph", () => {
    const lines = ["Преамбула: ООО «А» и ООО «Б» заключили договор.", "1. ТЕРМИНЫ И ОПРЕДЕЛЕНИЯ", "1.1. «Товар» — продукция по Спецификации."];
    for (let s = 2; s <= 9; s++) {
      lines.push(`${s}. РАЗДЕЛ НОМЕР ${s}`);
      for (let i = 1; i <= 30; i++) lines.push(`${s}.${i}. ${"Условие раздела с достаточно длинным текстом. ".repeat(4)}`);
    }
    const doc = normalize([lines.join("\n")], { reflow: false });
    const plan = planChunks(doc, { targetTokens: 3_000, sharedMaxTokens: 500 });

    expect(plan.chunks.length).toBeGreaterThan(3);
    expect(plan.sharedContext).toContain("«Товар» — продукция по Спецификации");
    expect(plan.toc).toContain("5. РАЗДЕЛ НОМЕР 5 [");
    // Every paragraph appears in some chunk, whole.
    for (const p of doc.paragraphs) {
      expect(plan.chunks.some((c) => c.text.includes(`[${p.id}] ${p.text}`))).toBe(true);
    }
    // Chunks start at section boundaries unless a section had to be split.
    for (const c of plan.chunks) expect(c.titles[0]).toMatch(/РАЗДЕЛ|ТЕРМИНЫ|Преамбула|часть/);
  });
});

// --- Audit with a fake Claude ---------------------------------------------------------------

function fakeAudit(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    document: { contract_type: "аренда", title: "Договор аренды", parties: [], client_party: "Арендатор", subject_summary: "", governing_law: "РФ" },
    overall: { risk_score: 9, verdict: "do_not_sign_without_major_changes", summary: "", top_risks: [] },
    findings: [
      {
        id: "F-1", category: "termination_unilateral", title: "Односторонний отказ", clause_refs: ["P-018", "P-999"],
        quote: "Арендодатель вправе отказаться от договора в одностороннем порядке без объяснения причин",
        risk_score: 8, legal_status: "unfavorable", explanation: "", financial_impact: "", legal_basis: [],
        recommendation: "", suggested_wording: "", negotiation_tip: "",
      },
      {
        id: "F-2", category: "hidden_trap", title: "Выдуманная цитата", clause_refs: ["P-001"],
        quote: "Арендатор отказывается от всех прав на имущество навсегда", risk_score: 9, legal_status: "potentially_void",
        explanation: "", financial_impact: "", legal_basis: [], recommendation: "", suggested_wording: "", negotiation_tip: "",
      },
    ],
    missing_clauses: [], key_dates: [], questions_to_counterparty: [], confidence: "high", limitations: "",
    ...overrides,
  };
}

function fakeDeps(calls: StructuredRequest[]): Deps {
  const call: StructuredCaller = async (req, schema) => {
    calls.push(req);
    const data = schema === (ChunkAuditSchema as unknown)
      ? { findings: fakeAudit().findings.slice(0, 1), key_dates: [], notes_for_merge: ["цена 150 000"] }
      : fakeAudit();
    return { data: schema.parse(data), usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, cache_creation_1h_tokens: 0, calls: 1 }, model: "claude-sonnet-5-5" };
  };
  return { call, countTokens: async (_s, _t, estimate) => ({ tokens: estimate, exact: false }) };
}

describe("audit", () => {
  it("single pass: verifies quotes, drops unknown clause refs, sorts by risk", async () => {
    const { doc } = await prepareDocument(fixture("lease.docx"), "lease.docx");
    const calls: StructuredRequest[] = [];
    const { audit, meta } = await auditContract(doc, { clientParty: "Арендатор", jurisdiction: "РФ" }, fakeDeps(calls));

    expect(meta).toMatchObject({ mode: "single_pass", chunks: 1 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.content[0]).toMatchObject({ cache_control: { type: "ephemeral" } });
    expect(audit.findings.map((f) => [f.id, f.quote_verified])).toEqual([["F-2", false], ["F-1", true]]);
    expect(audit.findings.find((f) => f.id === "F-1")!.clause_refs).toEqual(["P-018"]);
    expect(meta.cost_usd).toBeCloseTo(0.007, 5);
  });

  it("map-reduce for long contracts: one call per chunk + one merge call", async () => {
    const { doc } = await prepareDocument(fixture("lease.docx"), "lease.docx");
    const saved = { ...config };
    Object.assign(config, { singlePassMaxTokens: 100, chunkTargetTokens: 250 });
    try {
      const calls: StructuredRequest[] = [];
      const { meta } = await auditContract(doc, { clientParty: "Арендатор", jurisdiction: "РФ" }, fakeDeps(calls));
      expect(meta.mode).toBe("map_reduce");
      expect(meta.chunks).toBeGreaterThan(1);
      expect(calls).toHaveLength(meta.chunks + 1);
      expect(calls.at(-1)!.purpose).toBe("audit_reduce");
      // The shared prefix (definitions + TOC) is identical across chunk calls → cacheable.
      const prefixes = new Set(calls.slice(0, -1).map((c) => JSON.stringify(c.content[0])));
      expect(prefixes.size).toBe(1);
    } finally {
      Object.assign(config, saved);
    }
  });

  it("schema rejects risk scores outside 1–10", () => {
    const bad = fakeAudit({ overall: { ...fakeAudit().overall, risk_score: 11 } });
    expect(AuditSchema.safeParse(bad).success).toBe(false);
    expect(verifyAudit(fakeAudit(), []).findings.every((f) => f.clause_refs.length === 0)).toBe(true);
  });
});

// --- HTTP ------------------------------------------------------------------------------------

describe("HTTP API", () => {
  let base = "";
  let close = () => {};
  beforeAll(async () => {
    const server = app.listen(0);
    await new Promise((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterAll(() => close());

  const post = (path: string, fields: Record<string, string>, file?: [Buffer, string]) => {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    if (file) form.append("file", new Blob([new Uint8Array(file[0])]), file[1]);
    return fetch(base + path, { method: "POST", body: form });
  };

  it("/api/extract returns paragraphs", async () => {
    const res = await post("/api/extract", {}, [fixture("lease.docx"), "Договор аренды.docx"]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.file.name).toBe("Договор аренды.docx");
    expect(body.paragraphs.length).toBeGreaterThan(15);
  });

  it("validates input", async () => {
    let res = await post("/api/audit", { client_party: "Арендатор" });
    expect([res.status, (await res.json()).error.code]).toEqual([400, "file_required"]);

    res = await post("/api/audit", {}, [fixture("lease.docx"), "a.docx"]);
    expect([res.status, (await res.json()).error.code]).toEqual([400, "client_party_required"]);

    res = await post("/api/audit", { client_party: "Арендатор" }, [fixture("broken.pdf"), "a.pdf"]);
    expect([res.status, (await res.json()).error.code]).toEqual([422, "pdf_corrupted"]);
  });

  it("rejects files over the size limit with 413", async () => {
    const res = await post("/api/extract", {}, [Buffer.alloc(config.maxFileBytes + 1), "big.pdf"]);
    expect([res.status, (await res.json()).error.code]).toEqual([413, "file_too_large"]);
  });
});
