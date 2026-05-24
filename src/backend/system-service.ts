import {copyFile} from "node:fs/promises";
import path from "node:path";
import {DATA_DIR, DB_PATH, getDatabaseStats, getDb} from "./db.js";

export function getSystemDatabaseInfo(): ReturnType<typeof getDatabaseStats> {
  return getDatabaseStats();
}

export async function backupDatabase(): Promise<{fileName: string; filePath: string}> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `codex-auth-manager-${timestamp}.db`;
  const filePath = path.join(DATA_DIR, fileName);
  await copyFile(DB_PATH, filePath);
  return {fileName, filePath};
}

export function cleanupJobs(input: {before?: string; keepLatest?: number} = {}): {deletedJobs: number; deletedEvents: number} {
  const keepLatest = Math.max(0, Math.min(1000, Number(input.keepLatest ?? 100) || 100));
  const before = String(input.before ?? "").trim();
  const params = {
    keepLatest,
    before: before || null,
  };
  const jobs = getDb().prepare(`
    SELECT id FROM jobs
    WHERE id NOT IN (
      SELECT id FROM jobs ORDER BY id DESC LIMIT @keepLatest
    )
      AND (@before IS NULL OR created_at < @before)
      AND status IN ('success', 'failed', 'cancelled')
  `).all(params) as Array<{id: number}>;
  if (!jobs.length) {
    return {deletedJobs: 0, deletedEvents: 0};
  }
  const ids = jobs.map((job) => job.id);
  const placeholders = ids.map(() => "?").join(",");
  const deletedEvents = getDb().prepare(`DELETE FROM job_events WHERE job_id IN (${placeholders})`).run(...ids).changes;
  getDb().prepare(`DELETE FROM job_inputs WHERE job_id IN (${placeholders})`).run(...ids);
  const deletedJobs = getDb().prepare(`DELETE FROM jobs WHERE id IN (${placeholders})`).run(...ids).changes;
  return {deletedJobs, deletedEvents};
}
