import {AsyncLocalStorage} from "node:async_hooks";
import {EventEmitter} from "node:events";
import {getDb, currentTimestamp, type JobEventRow, type JobRow} from "./db.js";

export type JobStatus = "queued" | "running" | "waiting_input" | "success" | "failed" | "cancelled";
export type JobLevel = "info" | "warn" | "error" | "success";

interface JobEventPayload {
    id: number;
    job_id: number;
    level: JobLevel;
    message: string;
    created_at: string;
}

const emitter = new EventEmitter();
const consoleCaptureContext = new AsyncLocalStorage<number>();
let activeRegisterJobId: number | null = null;
let consoleCaptureInstallCount = 0;
let originalConsoleLog: typeof console.log | null = null;
let originalConsoleWarn: typeof console.warn | null = null;
let originalConsoleError: typeof console.error | null = null;

export class JobCancelledError extends Error {
  constructor(message = "任务已结束") {
    super(message);
    this.name = "JobCancelledError";
  }
}

export function createJob(type: string, title: string, payload: Record<string, unknown> = {}): JobRow {
  const timestamp = currentTimestamp();
  const result = getDb().prepare(`
        INSERT INTO jobs (type, status, title, payload_json, created_at)
        VALUES (@type, 'queued', @title, @payload_json, @created_at)
    `).run({
    type,
    title,
    payload_json: JSON.stringify(payload),
    created_at: timestamp,
  });
  return getJob(Number(result.lastInsertRowid));
}

export function getJob(id: number): JobRow {
  const row = getDb().prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  if (!row) {
    throw new Error(`任务不存在: ${id}`);
  }
  return normalizeJobRow(row);
}

export function listJobs(limit = 100): JobRow[] {
  return (getDb().prepare("SELECT * FROM jobs ORDER BY id DESC LIMIT ?").all(limit) as JobRow[]).map(normalizeJobRow);
}

function normalizeJobRow(row: JobRow): JobRow & {result: Record<string, unknown> | null} {
  return {
    ...row,
    result: parseJobJson(row.result_json),
  };
}

function parseJobJson(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function listJobEvents(jobId: number, afterId = 0): JobEventRow[] {
  return getDb().prepare(`
        SELECT * FROM job_events
        WHERE job_id = ? AND id > ?
        ORDER BY id ASC
        LIMIT 500
    `).all(jobId, afterId) as JobEventRow[];
}

export function addJobEvent(jobId: number, level: JobLevel, message: string): JobEventPayload {
  const timestamp = currentTimestamp();
  const result = getDb().prepare(`
        INSERT INTO job_events (job_id, level, message, created_at)
        VALUES (?, ?, ?, ?)
    `).run(jobId, level, message, timestamp);
  const event = {
    id: Number(result.lastInsertRowid),
    job_id: jobId,
    level,
    message,
    created_at: timestamp,
  };
  emitter.emit(`job:${jobId}`, event);
  return event;
}

export function updateJobStatus(
  jobId: number,
  status: JobStatus,
  fields: {error?: string | null; result?: Record<string, unknown> | null; inputPrompt?: string | null} = {},
): void {
  const timestamp = currentTimestamp();
  const current = getJob(jobId);
  const startedAt = current.started_at || (status === "running" ? timestamp : null);
  const finishedAt = ["success", "failed", "cancelled"].includes(status) ? timestamp : current.finished_at;
  getDb().prepare(`
        UPDATE jobs
        SET status = @status,
            error = @error,
            result_json = @result_json,
            waiting_for_input = @waiting_for_input,
            input_prompt = @input_prompt,
            started_at = @started_at,
            finished_at = @finished_at
        WHERE id = @id
    `).run({
    id: jobId,
    status,
    error: fields.error ?? current.error,
    result_json: fields.result ? JSON.stringify(fields.result) : current.result_json,
    waiting_for_input: status === "waiting_input" ? 1 : 0,
    input_prompt: fields.inputPrompt ?? null,
    started_at: startedAt,
    finished_at: finishedAt,
  });
  emitter.emit(`job:${jobId}`, {
    id: 0,
    job_id: jobId,
    level: "info",
    message: `jobStatus:${status}`,
    created_at: timestamp,
  } satisfies JobEventPayload);
}

export function isJobTerminal(status: string): boolean {
  return status === "success" || status === "failed" || status === "cancelled";
}

function getActiveRegisterJob(): JobRow | null {
  if (!activeRegisterJobId) {
    return null;
  }
  try {
    return getJob(activeRegisterJobId);
  } catch {
    activeRegisterJobId = null;
    return null;
  }
}

export function isJobCancellationRequested(jobId: number): boolean {
  return getJob(jobId).status === "cancelled";
}

export function throwIfJobCancelled(jobId?: number): void {
  if (jobId && isJobCancellationRequested(jobId)) {
    throw new JobCancelledError();
  }
}

export function cancelJob(jobId: number): JobRow {
  const job = getJob(jobId);
  if (isJobTerminal(job.status)) {
    return job;
  }
  updateJobStatus(jobId, "cancelled", {error: "用户结束任务"});
  addJobEvent(jobId, "warn", "任务已请求结束");
  emitter.emit(`job-cancel:${jobId}`);
  return getJob(jobId);
}

export async function runJob(
  jobId: number,
  runner: () => Promise<Record<string, unknown> | void>,
  options: {exclusiveRegister?: boolean} = {},
): Promise<void> {
  if (options.exclusiveRegister) {
    const activeRegisterJob = getActiveRegisterJob();
    if (activeRegisterJob && !isJobTerminal(activeRegisterJob.status)) {
      updateJobStatus(jobId, "failed", {error: "已有注册任务正在执行"});
      addJobEvent(jobId, "error", "已有注册任务正在执行");
      return;
    }
    activeRegisterJobId = jobId;
  }

  try {
    if (isJobCancellationRequested(jobId)) {
      addJobEvent(jobId, "warn", "任务已结束");
      return;
    }
    updateJobStatus(jobId, "running");
    addJobEvent(jobId, "info", "任务开始");
    const result = await withConsoleCapture(jobId, runner);
    if (isJobCancellationRequested(jobId)) {
      addJobEvent(jobId, "warn", "任务已结束");
      return;
    }
    updateJobStatus(jobId, "success", {result: result ?? {}});
    addJobEvent(jobId, "success", "任务完成");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof JobCancelledError || isJobCancellationRequested(jobId)) {
      updateJobStatus(jobId, "cancelled", {error: message});
      addJobEvent(jobId, "warn", message);
    } else {
      updateJobStatus(jobId, "failed", {error: message});
      addJobEvent(jobId, "error", message);
    }
  } finally {
    if (options.exclusiveRegister && activeRegisterJobId === jobId) {
      activeRegisterJobId = null;
    }
  }
}

async function withConsoleCapture<T>(jobId: number, runner: () => Promise<T>): Promise<T> {
  const cleanup = installConsoleCapture();

  try {
    return await consoleCaptureContext.run(jobId, runner);
  } finally {
    cleanup();
  }
}

function serializeConsoleItems(items: unknown[]): string {
  return items.map((item) => {
    if (typeof item === "string") {
      return item;
    }
    if (item instanceof Error) {
      return item.stack || item.message;
    }
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }).join(" ");
}

function installConsoleCapture(): () => void {
  consoleCaptureInstallCount += 1;
  if (consoleCaptureInstallCount === 1) {
    originalConsoleLog = console.log;
    originalConsoleWarn = console.warn;
    originalConsoleError = console.error;
    console.log = (...items: unknown[]) => {
      const jobId = consoleCaptureContext.getStore();
      if (jobId) {
        addJobEvent(jobId, "info", serializeConsoleItems(items));
      }
      originalConsoleLog?.(...items);
    };
    console.warn = (...items: unknown[]) => {
      const jobId = consoleCaptureContext.getStore();
      if (jobId) {
        addJobEvent(jobId, "warn", serializeConsoleItems(items));
      }
      originalConsoleWarn?.(...items);
    };
    console.error = (...items: unknown[]) => {
      const jobId = consoleCaptureContext.getStore();
      if (jobId) {
        addJobEvent(jobId, "error", serializeConsoleItems(items));
      }
      originalConsoleError?.(...items);
    };
  }

  return () => {
    consoleCaptureInstallCount = Math.max(0, consoleCaptureInstallCount - 1);
    if (consoleCaptureInstallCount === 0 && originalConsoleLog && originalConsoleWarn && originalConsoleError) {
      console.log = originalConsoleLog;
      console.warn = originalConsoleWarn;
      console.error = originalConsoleError;
      originalConsoleLog = null;
      originalConsoleWarn = null;
      originalConsoleError = null;
    }
  };
}

export function submitJobInput(jobId: number, value: string): void {
  throwIfJobCancelled(jobId);
  getDb().prepare(`
        INSERT INTO job_inputs (job_id, value, created_at)
        VALUES (?, ?, ?)
    `).run(jobId, value, currentTimestamp());
  updateJobStatus(jobId, "running");
  addJobEvent(jobId, "info", "已收到人工输入");
}

export async function waitForJobInput(jobId: number, prompt: string, timeoutMs = 10 * 60 * 1000): Promise<string> {
  throwIfJobCancelled(jobId);
  updateJobStatus(jobId, "waiting_input", {inputPrompt: prompt});
  addJobEvent(jobId, "warn", prompt);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    throwIfJobCancelled(jobId);
    const row = getDb().prepare(`
            SELECT * FROM job_inputs
            WHERE job_id = ? AND consumed = 0
            ORDER BY id ASC
            LIMIT 1
        `).get(jobId) as {id: number; value: string} | undefined;
    if (row) {
      getDb().prepare("UPDATE job_inputs SET consumed = 1 WHERE id = ?").run(row.id);
      return row.value.trim();
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("等待人工输入超时");
}

export function onJobEvent(jobId: number, listener: (event: JobEventPayload) => void): () => void {
  const key = `job:${jobId}`;
  emitter.on(key, listener);
  return () => emitter.off(key, listener);
}

export function onJobCancelled(jobId: number, listener: () => void): () => void {
  const key = `job-cancel:${jobId}`;
  emitter.on(key, listener);
  return () => emitter.off(key, listener);
}
