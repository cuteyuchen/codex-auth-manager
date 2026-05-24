import cron, {type ScheduledTask} from "node-cron";
import {checkAccount, listAccounts, mapWithConcurrency, pushAccountToBoundPlatforms, resolveDefaultConcurrency} from "./auth-service.js";
import {getSettings, upsertSetting} from "./db.js";
import {addJobEvent, createJob, runJob} from "./job-service.js";
import {reauthorizeAccount} from "./registration-service.js";
import {syncPlatformCredentials} from "./credential-sync-service.js";

let task: ScheduledTask | null = null;

function dailyTimeToCron(time: string): string {
  const [hourRaw, minuteRaw] = time.split(":");
  const hour = Math.min(23, Math.max(0, Number.parseInt(hourRaw ?? "3", 10) || 3));
  const minute = Math.min(59, Math.max(0, Number.parseInt(minuteRaw ?? "30", 10) || 30));
  return `${minute} ${hour} * * *`;
}

export function getSchedulerConfig(): {enabled: boolean; dailyTime: string; lastRunStatus: string; nextRunHint: string} {
  const settings = getSettings();
  const dailyTime = settings["scheduler.dailyTime"] || "03:30";
  return {
    enabled: settings["scheduler.enabled"] !== "false",
    dailyTime,
    lastRunStatus: settings["scheduler.lastRunStatus"] || "never",
    nextRunHint: `每天 ${dailyTime}`,
  };
}

export function updateSchedulerConfig(input: {enabled?: boolean; dailyTime?: string}): ReturnType<typeof getSchedulerConfig> {
  if (typeof input.enabled === "boolean") {
    upsertSetting("scheduler.enabled", String(input.enabled));
  }
  if (typeof input.dailyTime === "string" && /^\d{1,2}:\d{2}$/.test(input.dailyTime.trim())) {
    upsertSetting("scheduler.dailyTime", input.dailyTime.trim());
  }
  startScheduler();
  return getSchedulerConfig();
}

export function startScheduler(): void {
  if (task) {
    task.stop();
    task = null;
  }
  const config = getSchedulerConfig();
  if (!config.enabled) {
    return;
  }
  task = cron.schedule(dailyTimeToCron(config.dailyTime), () => {
    void runScheduledRefresh();
  });
}

export async function runScheduledRefresh(): Promise<void> {
  const job = createJob("scheduled_refresh", "定时刷新凭据状态");
  await runJob(job.id, async () => {
    addJobEvent(job.id, "info", "开始同步平台凭据");
    const syncResult = await syncPlatformCredentials({source: "all", checkAfterSync: false, jobId: job.id});
    addJobEvent(job.id, syncResult.failed ? "warn" : "success", `平台同步完成：新增 ${syncResult.imported}，更新 ${syncResult.updated}，跳过 ${syncResult.skipped}，失败 ${syncResult.failed}`);
    const accounts = listAccounts();
    addJobEvent(job.id, "info", `准备检查 ${accounts.length} 个账号`);
    const concurrency = resolveDefaultConcurrency(accounts.length);
    const results = await mapWithConcurrency(accounts, concurrency, async (account) => {
      try {
        const summary = await checkAccount(account.id, true);
        if (!summary.ok && account.auto_reauth) {
          addJobEvent(job.id, "warn", `${account.email} refresh/check 失败，尝试重新登录授权`);
          await reauthorizeAccount(account.id, job.id);
          try {
            await pushAccountToBoundPlatforms(account.id);
            addJobEvent(job.id, "success", `${account.email} 重新授权后已同步到绑定平台`);
          } catch (error) {
            addJobEvent(job.id, "error", `${account.email} 重新授权后同步绑定平台失败: ${error instanceof Error ? error.message : String(error)}`);
          }
          return {email: account.email, status: "reauthorized"};
        }
        return {email: account.email, status: summary.status};
      } catch (error) {
        return {
          email: account.email,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    const failed = results.filter((item) => item.status === "failed").length;
    upsertSetting("scheduler.lastRunStatus", failed ? `failed:${failed}` : "success");
    return {total: results.length, failed};
  });
}
