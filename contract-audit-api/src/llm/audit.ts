import type Anthropic from "@anthropic-ai/sdk";
import { config, type Effort } from "../config.js";
import { planChunks, estimateTokens } from "../text/chunk.js";
import type { NormalizedDoc } from "../text/normalize.js";
import { addUsage, callClaude, costUsd, countTokens, emptyUsage, type StructuredCaller, type Usage } from "./call.js";
import { AUDIT_SYSTEM_PROMPT, CHUNK_INSTRUCTIONS, PROMPT_VERSION, REDUCE_SYSTEM_PROMPT } from "./prompts.js";
import { AuditSchema, ChunkAuditSchema, type ChunkAuditResult } from "./schema.js";
import { verifyAudit, type VerifiedAudit } from "./verify.js";

export interface AuditOptions {
  clientParty: string;
  jurisdiction: string;
  deep?: boolean;
}

export interface AuditMeta {
  mode: "single_pass" | "map_reduce";
  model: string;
  prompt_version: string;
  effort: Effort;
  input_tokens_counted: number;
  token_count_exact: boolean;
  chunks: number;
  usage: Usage;
  cost_usd: number | null;
  duration_ms: number;
}

export interface Deps {
  call: StructuredCaller;
  countTokens: typeof countTokens;
}
const defaultDeps: Deps = { call: callClaude, countTokens };

const escapeTag = (s: string) => s.replace(/[<>]/g, "");
const clientBlock = (o: AuditOptions) =>
  `<client_party>${escapeTag(o.clientParty)}</client_party>\n<jurisdiction>${escapeTag(o.jurisdiction)}</jurisdiction>`;

export async function auditContract(doc: NormalizedDoc, opts: AuditOptions, deps: Deps = defaultDeps): Promise<{ audit: VerifiedAudit; meta: AuditMeta }> {
  const started = Date.now();
  const effort = opts.deep ? config.deepEffort : config.effort;
  const contract = `<contract>\n${doc.text}\n</contract>`;
  const { tokens, exact } = await deps.countTokens(AUDIT_SYSTEM_PROMPT, contract, estimateTokens(contract));

  let result;
  let mode: AuditMeta["mode"];
  let chunks = 1;
  let usage = emptyUsage();
  let model = config.model;

  if (tokens <= config.singlePassMaxTokens) {
    mode = "single_pass";
    const res = await deps.call(
      {
        purpose: "audit",
        system: AUDIT_SYSTEM_PROMPT,
        effort,
        content: [
          // Cached: follow-up calls on the same document (retries, chat) read it at ~10% of the price.
          { type: "text", text: contract, cache_control: { type: "ephemeral" } },
          { type: "text", text: `${clientBlock(opts)}\nПроведи аудит договора в интересах клиента.` },
        ],
      },
      AuditSchema,
    );
    ({ data: result, usage, model } = res);
  } else {
    mode = "map_reduce";
    const plan = planChunks(doc, { targetTokens: config.chunkTargetTokens, sharedMaxTokens: config.sharedContextMaxTokens });
    chunks = plan.chunks.length;

    // Same prefix for every chunk → written to the cache once, read by the rest.
    const shared: Anthropic.Beta.BetaContentBlockParam = {
      type: "text",
      text: `<shared_context>\n${plan.sharedContext}\n</shared_context>\n<toc>\n${plan.toc}\n</toc>\n${clientBlock(opts)}\n\n${CHUNK_INSTRUCTIONS}`,
      cache_control: { type: "ephemeral" },
    };

    // Warm the cache with the first chunk, then run the rest in parallel: requests started before
    // the first one finishes would each pay for writing the same prefix.
    const runChunk = (i: number) => {
      const c = plan.chunks[i]!;
      return deps.call(
        {
          purpose: `audit_chunk_${i + 1}/${chunks}`,
          system: AUDIT_SYSTEM_PROMPT,
          effort,
          content: [
            shared,
            { type: "text", text: `<contract_part index="${i + 1}" of="${chunks}" sections="${escapeTag(c.titles.join("; "))}" paragraphs="${c.firstId}–${c.lastId}">\n${c.text}\n</contract_part>` },
          ],
        },
        ChunkAuditSchema,
      );
    };
    const first = await runChunk(0);
    const rest = await mapLimit(plan.chunks.slice(1).map((_, i) => i + 1), config.mapConcurrency, runChunk);
    const parts = [first, ...rest];
    usage = parts.reduce((u, p) => addUsage(u, p.usage), emptyUsage());

    const partFindings = parts.map((p, i) => ({ part: i + 1, sections: plan.chunks[i]!.titles, ...p.data as ChunkAuditResult }));
    const reduced = await deps.call(
      {
        purpose: "audit_reduce",
        system: REDUCE_SYSTEM_PROMPT,
        effort,
        content: [
          { type: "text", text: `<shared_context>\n${plan.sharedContext}\n</shared_context>\n<toc>\n${plan.toc}\n</toc>\n${clientBlock(opts)}` },
          { type: "text", text: `<part_findings>\n${JSON.stringify(partFindings)}\n</part_findings>\nСобери итоговое заключение по договору.` },
        ],
      },
      AuditSchema,
    );
    usage = addUsage(usage, reduced.usage);
    result = reduced.data;
    model = reduced.model;
  }

  const audit = verifyAudit(result, doc.paragraphs);
  return {
    audit,
    meta: {
      mode,
      model,
      prompt_version: PROMPT_VERSION,
      effort,
      input_tokens_counted: tokens,
      token_count_exact: exact,
      chunks,
      usage,
      cost_usd: costUsd(model, usage),
      duration_ms: Date.now() - started,
    },
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
