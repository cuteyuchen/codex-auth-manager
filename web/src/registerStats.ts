import type {Job, JobEvent} from "./api";

export interface RegisterStats {
  total: number;
  completed: number;
  success: number;
  failed: number;
  smsNumbersUsed: number;
  smsSuccessCount: number;
}

export function createRegisterStats(): RegisterStats {
  return {
    total: 0,
    completed: 0,
    success: 0,
    failed: 0,
    smsNumbersUsed: 0,
    smsSuccessCount: 0,
  };
}

export function applyRegisterStatsEvent(stats: RegisterStats, message: string): boolean {
  const progress = message.match(/总轮数\s+(\d+)，已完成\s+(\d+)，成功\s+(\d+)，失败\s+(\d+)，短信(?:使用)?号码\s+(\d+)，短信成功(?:激活)?\s+(\d+)/);
  if (progress) {
    stats.total = Number(progress[1]);
    stats.completed = Number(progress[2]);
    stats.success = Number(progress[3]);
    stats.failed = Number(progress[4]);
    stats.smsNumbersUsed = Number(progress[5]);
    stats.smsSuccessCount = Number(progress[6]);
    return true;
  }

  const summary = message.match(/自动模式结束:\s+已执行=(\d+)\s+成功=(\d+)\s+失败=(\d+)\s+短信号码=(\d+)\s+短信成功=(\d+)/);
  if (summary) {
    stats.completed = Number(summary[1]);
    stats.success = Number(summary[2]);
    stats.failed = Number(summary[3]);
    stats.total = Math.max(stats.total, stats.completed);
    stats.smsNumbersUsed = Number(summary[4]);
    stats.smsSuccessCount = Number(summary[5]);
    return true;
  }

  return false;
}

export function applyRegisterJobResult(stats: RegisterStats, job: Job | null | undefined): void {
  const result = job?.result;
  if (!result) {
    return;
  }
  stats.success = Number(result.success ?? stats.success);
  stats.failed = Number(result.failed ?? stats.failed);
  stats.completed = stats.success + stats.failed;
  stats.total = Math.max(stats.total, stats.completed);
  stats.smsNumbersUsed = Number(result.smsNumbersUsed ?? stats.smsNumbersUsed);
  stats.smsSuccessCount = Number(
    result.smsSuccessCount ??
    result.smsActivationsCompleted ??
    stats.smsSuccessCount,
  );
}

export function buildRegisterStatsFromEvents(events: JobEvent[], job?: Job | null): RegisterStats {
  const stats = createRegisterStats();
  for (const event of events) {
    applyRegisterStatsEvent(stats, event.message);
  }
  applyRegisterJobResult(stats, job);
  return stats;
}
