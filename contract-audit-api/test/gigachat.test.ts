import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { callGigaChat, extractJson } from "../src/llm/gigachat.js";
import { ChunkAuditSchema } from "../src/llm/schema.js";

// A fake GigaChat: OAuth + chat completions, with replies scripted per test.
let replies: Array<{ status?: number; content?: string; finish?: string }> = [];
const seen: { oauth: number; chats: { auth: string; body: { model: string; messages: { role: string; content: string }[] } }[] } = { oauth: 0, chats: [] };
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      if (req.url === "/oauth") {
        seen.oauth++;
        expect(req.headers.authorization).toBe("Basic dGVzdDprZXk=");
        expect(b).toBe("scope=GIGACHAT_API_PERS");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `tok-${seen.oauth}`, expires_at: Date.now() + 30 * 60_000 }));
        return;
      }
      seen.chats.push({ auth: req.headers.authorization ?? "", body: JSON.parse(b) });
      const r = replies.shift() ?? { status: 500 };
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        model: "GigaChat-2:test",
        choices: [{ message: { role: "assistant", content: r.content ?? "" }, finish_reason: r.finish ?? "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  Object.assign(config, { gigachatAuthKey: "dGVzdDprZXk=", gigachatAuthUrl: `${base}/oauth`, gigachatApiUrl: base });
});
afterAll(() => server.close());
beforeEach(() => { replies = []; seen.chats = []; });

const finding = {
  id: "F-1", category: "penalties_liability", title: "Штраф", clause_refs: ["P-015"], quote: "штраф 1%",
  risk_score: "8", // a string on purpose: must be coerced
  legal_status: "unfavorable", explanation: "", financial_impact: "", legal_basis: [], recommendation: "", suggested_wording: "", negotiation_tip: "",
};
const req = { purpose: "test", system: "Ты юрист.", effort: "medium" as const, content: [{ type: "text" as const, text: "<contract>…</contract>" }] };

describe("GigaChat provider", () => {
  it("parses JSON wrapped in a Markdown fence and coerces numeric strings", async () => {
    replies = [{ content: "Вот результат:\n```json\n" + JSON.stringify({ findings: [finding], key_dates: [], notes_for_merge: [] }) + "\n```" }];
    const res = await callGigaChat(req, ChunkAuditSchema);
    expect(res.data.findings[0]!.risk_score).toBe(8);
    expect(res.model).toBe("GigaChat-2:test");
    expect(res.usage).toMatchObject({ input_tokens: 100, output_tokens: 50, calls: 1 });

    const sent = seen.chats[0]!;
    expect(sent.auth).toMatch(/^Bearer tok-\d+$/);
    expect(sent.body.model).toBe(config.gigachatModel);
    expect(sent.body.messages[0]!.content).toContain("<output_format>"); // schema is in the system prompt
  });

  it("sends validation errors back to the model and accepts the corrected answer", async () => {
    replies = [
      { content: JSON.stringify({ findings: [{ ...finding, risk_score: 15 }], key_dates: [] }) }, // out of range + missing field
      { content: JSON.stringify({ findings: [finding], key_dates: [], notes_for_merge: [] }) },
    ];
    const res = await callGigaChat(req, ChunkAuditSchema);
    expect(res.usage.calls).toBe(2);
    const retry = seen.chats[1]!.body.messages;
    expect(retry.at(-1)!.content).toMatch(/Ответ не соответствует схеме: .*risk_score.*notes_for_merge/);
    expect(retry.at(-2)!.role).toBe("assistant");
  });

  it("refreshes the token once on 401", async () => {
    const before = seen.oauth;
    replies = [{ status: 401 }, { content: JSON.stringify({ findings: [], key_dates: [], notes_for_merge: [] }) }];
    await callGigaChat(req, ChunkAuditSchema);
    expect(seen.oauth).toBe(before + 1);
  });

  it("maps an exhausted quota (402) to a clear error", async () => {
    replies = [{ status: 402 }];
    await expect(callGigaChat(req, ChunkAuditSchema)).rejects.toMatchObject({ status: 503, code: "llm_quota_exhausted" });
  });

  it("gives up after 3 invalid answers", async () => {
    replies = [{ content: "не JSON" }, { content: "{}" }, { content: "{oops" }];
    await expect(callGigaChat(req, ChunkAuditSchema)).rejects.toMatchObject({ status: 502, code: "llm_invalid_output" });
  });

  it("extractJson ignores prose around the object", () => {
    expect(extractJson('Конечно! {"a": {"b": 1}} Надеюсь, помог.')).toEqual({ a: { b: 1 } });
    expect(() => extractJson("нет json")).toThrow();
  });
});
