/**
 * 账号生命周期服务
 * 区分只读检查和修复检查 (repair)
 * 只读检查：仅探测 usage，不触发 refresh / 重登 / 回推
 * 修复检查 repair：先 refresh token，再自动重登，成功后回推绑定平台
 */
import {
  checkAccount,
  getAccount,
  updateAuthFileStep,
  pushAccountToBoundPlatforms,
  type AuthSummary,
} from "./auth-service.js";
import {
  reauthorizeAccount,
} from "./registration-service.js";
import {
  addJobEvent,
} from "./job-service.js";

// ─── 只读检查 ───────────────────────────────────────────
// 默认 check 走这个分支，只探测 usage，不触发任何写操作（refresh / reauth / push）

export async function checkAccountReadOnly(accountId: number): Promise<AuthSummary> {
  return checkAccount(accountId, false);
}

// ─── 修复检查 (repair) ──────────────────────────────────
// 1. refresh token 刷新
// 2. 如果刷新失败或凭据仍然无效，自动重登
// 3. 成功后只回推绑定平台

export interface RepairResult {
  accountId: number;
  email: string;
  checkResult?: AuthSummary;
  refreshResult?: {success: boolean; error?: string};
  reauthResult?: {success: boolean; error?: string};
  boundPlatformPush?: "success" | "failed" | "skipped";
  pushError?: string;
  success: boolean;
  summary: string;
}

export async function repairAccount(accountId: number, jobId?: number): Promise<RepairResult> {
  const account = getAccount(accountId);
  const result: RepairResult = {
    accountId,
    email: account.email,
    success: false,
    summary: "",
  };

  // 1) 先做 refresh + usage 检查
  if (jobId) {
    addJobEvent(jobId, "info", `修复检查: 先尝试 refresh token`);
  }
  updateAuthFileStep(accountId, "修复: refresh token 刷新中", "running");
  let checkFailed = false;
  try {
    result.checkResult = await checkAccount(accountId, {forceRefresh: true, triggerAutoReauth: false});
    if (jobId) {
      addJobEvent(jobId, "info", `refresh + 检查完成: ${result.checkResult.statusLabel}`);
    }
  } catch (error) {
    checkFailed = true;
    const msg = error instanceof Error ? error.message : String(error);
    result.refreshResult = {success: false, error: msg};
    if (jobId) {
      addJobEvent(jobId, "warn", `refresh 检查失败: ${msg}`);
    }
  }

  // 2) 检查失败或凭据仍无效/过期 → 尝试自动重登
  const needsReauth = Boolean(
    checkFailed ||
    (result.checkResult &&
     (result.checkResult.statusCode === "credential_expired" ||
      result.checkResult.statusCode === "credential_invalid" ||
      result.checkResult.statusCode === "access_token_only")),
  );

  if (needsReauth) {
    if (jobId) {
      addJobEvent(jobId, "info", checkFailed
        ? `refresh 检查抛错，尝试自动重登`
        : `凭据仍无效，尝试自动重登`);
    }
    updateAuthFileStep(accountId, "修复: 自动重登中", "running");
    try {
      await reauthorizeAccount(accountId, jobId, {mode: "auto"});
      result.reauthResult = {success: true};
      if (jobId) {
        addJobEvent(jobId, "success", `自动重登成功: ${account.email}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.reauthResult = {success: false, error: msg};
      if (jobId) {
        addJobEvent(jobId, "error", `自动重登失败: ${msg}`);
      }
    }
  }

  // 3) 只有检查正常（无需重登）或重登成功后才回推绑定平台
  const canPush = needsReauth ? Boolean(result.reauthResult?.success) : Boolean(result.checkResult?.ok);
  if (canPush) {
    try {
      await pushAccountToBoundPlatforms(accountId);
      result.boundPlatformPush = "success";
      if (jobId) {
        addJobEvent(jobId, "success", `已回推绑定平台`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      result.boundPlatformPush = "failed";
      result.pushError = msg;
      if (jobId) {
        addJobEvent(jobId, "warn", `回推绑定平台失败: ${msg}`);
      }
    }
  } else {
    result.boundPlatformPush = "skipped";
  }

  // 汇总
  const parts: string[] = [];
  if (checkFailed) {
    parts.push(`检查失败: ${result.refreshResult?.error ?? "未知错误"}`);
  } else if (result.checkResult) {
    parts.push(`检查: ${result.checkResult.statusLabel}`);
  }
  if (result.reauthResult) {
    parts.push(`重登: ${result.reauthResult.success ? "成功" : result.reauthResult.error}`);
  }
  if (result.boundPlatformPush) {
    parts.push(`回推: ${result.boundPlatformPush}`);
  }
  result.summary = parts.join(" | ");

  // step_status 反映实际结果
  result.success = canPush && result.boundPlatformPush !== "failed";
  const stepStatus = result.success ? "success" : "failed";
  updateAuthFileStep(accountId, result.summary, stepStatus);
  return result;
}

// ─── 批量修复检查 ──────────────────────────────────────

export interface BulkRepairOptions {
  ids: number[];
  jobId?: number;
}

export interface BulkRepairResult {
  total: number;
  succeeded: number;
  failed: number;
  failures: Array<{id: number; message: string}>;
  results: RepairResult[];
}

export async function bulkRepairAccounts(options: BulkRepairOptions): Promise<BulkRepairResult> {
  const {ids, jobId} = options;
  const uniqueIds = [...new Set(ids.map(Number).filter((v) => Number.isFinite(v) && v > 0))];
  const result: BulkRepairResult = {
    total: uniqueIds.length,
    succeeded: 0,
    failed: 0,
    failures: [],
    results: [],
  };

  if (jobId) {
    addJobEvent(jobId, "info", `开始批量修复检查 ${uniqueIds.length} 个账号`);
  }

  for (const id of uniqueIds) {
    try {
      const repairResult = await repairAccount(id, jobId);
      result.results.push(repairResult);
      if (repairResult.success) {
        result.succeeded += 1;
      } else {
        result.failed += 1;
        result.failures.push({id, message: repairResult.reauthResult?.error ?? repairResult.pushError ?? repairResult.summary ?? "修复失败"});
      }
    } catch (error) {
      result.failed += 1;
      const msg = error instanceof Error ? error.message : String(error);
      result.failures.push({id, message: msg});
      if (jobId) {
        addJobEvent(jobId, "error", `账号 #${id} 修复失败: ${msg}`);
      }
    }
  }

  if (jobId) {
    addJobEvent(jobId, "info", `批量修复完成: 成功 ${result.succeeded}，失败 ${result.failed}`);
  }
  return result;
}
