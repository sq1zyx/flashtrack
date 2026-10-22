import { config } from "./config.js";
import { AppError } from "./errors.js";
import { auditContract, type AuditOptions } from "./llm/audit.js";
import { prepareDocument } from "./pipeline.js";
import { failJob, finishJob, markRunning, refundCredit } from "./store.js";

interface QueuedJob {
  id: string;
  code: string;
  file: Buffer;
  fileName: string;
  opts: AuditOptions;
}

/**
 * In-process queue: a few audits run at once, the rest wait. The browser polls GET /api/jobs/:id,
 * so a 2-minute analysis doesn't depend on one long HTTP request staying open.
 */
const queue: QueuedJob[] = [];
let running = 0;

export function enqueueAudit(job: QueuedJob): void {
  queue.push(job);
  pump();
}

export const queueStats = () => ({ running, waiting: queue.length });

function pump(): void {
  while (running < config.jobConcurrency && queue.length > 0) {
    const job = queue.shift()!;
    running++;
    run(job).finally(() => {
      running--;
      pump();
    });
  }
}

async function run(job: QueuedJob): Promise<void> {
  markRunning(job.id);
  try {
    const { extraction, doc } = await prepareDocument(job.file, job.fileName);
    const { audit, meta } = await auditContract(doc, job.opts);
    finishJob(job.id, { extraction: { ...extraction, paragraph_count: doc.paragraphs.length }, audit, meta, paragraphs: doc.paragraphs }, meta.cost_usd);
    console.info(`[job] ${job.id} done in ${meta.duration_ms} ms${meta.cost_usd === null ? "" : `, $${meta.cost_usd}`}`);
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError(500, "internal", "Внутренняя ошибка сервера.");
    if (!(err instanceof AppError)) console.error(`[job] ${job.id} crashed:`, err);
    // The user didn't get an audit, so they don't pay for it.
    refundCredit(job.code);
    failJob(job.id, { code: e.code, message: e.message + " Кредит не списан." });
    console.warn(`[job] ${job.id} failed: ${e.code}`);
  }
}
