import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

/**
 * SQLite in a single file (DATA_DIR/app.db): access codes with audit credits, and audit jobs.
 * Enough for one server instance; move to Postgres/Supabase when you run several.
 */
mkdirSync(config.dataDir, { recursive: true });
const db = new DatabaseSync(join(config.dataDir, "app.db"));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS access_codes (
    code          TEXT PRIMARY KEY,
    credits_total INTEGER NOT NULL,
    credits_used  INTEGER NOT NULL DEFAULT 0,
    note          TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    disabled      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS jobs (
    id            TEXT PRIMARY KEY,
    code          TEXT NOT NULL REFERENCES access_codes(code),
    status        TEXT NOT NULL,              -- queued | running | done | failed
    file_name     TEXT NOT NULL,
    client_party  TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at   TEXT,
    result_json   TEXT,
    error_json    TEXT,
    cost_usd      REAL
  );
  CREATE INDEX IF NOT EXISTS jobs_code ON jobs(code, created_at);
`);

export interface AccessCode {
  code: string;
  credits_total: number;
  credits_used: number;
  note: string;
  created_at: string;
  disabled: number;
}

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRow {
  id: string;
  code: string;
  status: JobStatus;
  file_name: string;
  client_party: string;
  created_at: string;
  finished_at: string | null;
  result_json: string | null;
  error_json: string | null;
  cost_usd: number | null;
}

// Unambiguous alphabet (no 0/O, 1/I/L) — codes get dictated over the phone and typed from screenshots.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newCode(): string {
  const bytes = randomBytes(8);
  const chars = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export const normalizeCode = (raw: string) => raw.trim().toUpperCase();

export function createCode(credits: number, note = ""): AccessCode {
  const code = newCode();
  db.prepare("INSERT INTO access_codes (code, credits_total, note) VALUES (?, ?, ?)").run(code, credits, note);
  return getCode(code)!;
}

export function getCode(code: string): AccessCode | undefined {
  return db.prepare("SELECT * FROM access_codes WHERE code = ?").get(normalizeCode(code)) as AccessCode | undefined;
}

export function listCodes(): AccessCode[] {
  return db.prepare("SELECT * FROM access_codes ORDER BY created_at DESC").all() as unknown as AccessCode[];
}

export function addCredits(code: string, credits: number): AccessCode | undefined {
  db.prepare("UPDATE access_codes SET credits_total = credits_total + ? WHERE code = ?").run(credits, normalizeCode(code));
  return getCode(code);
}

/** Atomically takes one credit. Returns false when the code is unknown, disabled or used up. */
export function reserveCredit(code: string): boolean {
  const r = db
    .prepare("UPDATE access_codes SET credits_used = credits_used + 1 WHERE code = ? AND disabled = 0 AND credits_used < credits_total")
    .run(normalizeCode(code));
  return r.changes === 1;
}

export function refundCredit(code: string): void {
  db.prepare("UPDATE access_codes SET credits_used = MAX(credits_used - 1, 0) WHERE code = ?").run(normalizeCode(code));
}

export function createJob(code: string, fileName: string, clientParty: string): JobRow {
  const id = randomUUID();
  db.prepare("INSERT INTO jobs (id, code, status, file_name, client_party) VALUES (?, ?, 'queued', ?, ?)")
    .run(id, normalizeCode(code), fileName, clientParty);
  return getJob(id)!;
}

export function getJob(id: string): JobRow | undefined {
  return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
}

export function markRunning(id: string): void {
  db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(id);
}

export function finishJob(id: string, result: unknown, costUsd: number | null): void {
  db.prepare("UPDATE jobs SET status = 'done', finished_at = datetime('now'), result_json = ?, cost_usd = ? WHERE id = ?")
    .run(JSON.stringify(result), costUsd, id);
}

export function failJob(id: string, error: { code: string; message: string }): void {
  db.prepare("UPDATE jobs SET status = 'failed', finished_at = datetime('now'), error_json = ? WHERE id = ?")
    .run(JSON.stringify(error), id);
}

export function listJobs(limit = 100): Omit<JobRow, "result_json">[] {
  return db.prepare(
    "SELECT id, code, status, file_name, client_party, created_at, finished_at, error_json, cost_usd FROM jobs ORDER BY created_at DESC LIMIT ?",
  ).all(limit) as unknown as Omit<JobRow, "result_json">[];
}

/** Deletes stored reports (they contain the contract text) older than `days`. Returns how many. */
export function purgeOldResults(days: number): number {
  const r = db.prepare(
    "UPDATE jobs SET result_json = NULL WHERE result_json IS NOT NULL AND finished_at < datetime('now', ?)",
  ).run(`-${days} days`);
  return Number(r.changes);
}

/**
 * Jobs live in process memory while they run (the uploaded file is not persisted), so a restart
 * loses them. Fail those jobs and give the credit back.
 */
export function recoverInterruptedJobs(): number {
  const stuck = db.prepare("SELECT id, code FROM jobs WHERE status IN ('queued', 'running')").all() as { id: string; code: string }[];
  for (const j of stuck) {
    failJob(j.id, { code: "server_restarted", message: "Анализ прервался из-за перезапуска сервера. Кредит возвращён — загрузите файл снова." });
    refundCredit(j.code);
  }
  return stuck.length;
}
