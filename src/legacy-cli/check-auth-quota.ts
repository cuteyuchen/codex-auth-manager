import path from "node:path";
import {cpus} from "node:os";
import {
  deleteAuthFileFromCLIProxyAPI,
  downloadAuthFileJsonObjectFromCLIProxyAPI,
  listAuthFilesFromCLIProxyAPI,
  saveAuthFileJsonObjectToCLIProxyAPI,
  setAuthFileDisabledStatusToCLIProxyAPI,
  type CLIProxyAuthFileItem,
} from "../core/cliproxyapi.js";
import {
  collectAuthFiles,
  loadAuthRecord,
  mapWithConcurrency,
  saveAuthRecord,
  summarizeAuthFile,
  type AuthRecord,
  type AuthSummary,
} from "../backend/auth-service.js";

interface IndexedAuthSummary {
    index: number;
    row: AuthSummary;
}

interface AuthTarget {
    filePath: string;
    currentDisabled?: boolean;
    summarize: (forceRefresh: boolean) => Promise<AuthSummary>;
    remove?: () => Promise<boolean>;
    setDisabled?: (disabled: boolean) => Promise<void>;
}

const DEFAULT_AUTH_DIR = path.resolve(process.cwd(), "auth");

function readFlagValue(flag: string): string {
  const index = process.argv.indexOf(flag);
  if (index === -1) {
    return "";
  }
  return process.argv[index + 1] ?? "";
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function normalizeCLIProxyAuthFileName(item: CLIProxyAuthFileItem): string {
  return String(item?.name ?? "").trim();
}

function normalizeCLIProxyDisabled(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.trim().toLowerCase() === "true";
  }
  return false;
}

function isCodexAuthRecord(record: Record<string, unknown>): boolean {
  return typeof record?.access_token === "string" || typeof record?.refresh_token === "string";
}

function parsePercent(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatPercent(value: number | null): string {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)}%` : "-";
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 3)}...`;
}

function formatCell(value: string, width: number): string {
  return value.padEnd(width, " ");
}

function resolveConcurrency(total: number): number {
  const rawValue = readFlagValue("--concurrency").trim() || readFlagValue("-c").trim();
  const parsed = Number.parseInt(rawValue, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(parsed, total);
  }
  const cpuCount = Math.max(1, cpus().length || 1);
  return Math.min(Math.max(4, cpuCount), total);
}

async function collectCPAAuthTargets(): Promise<AuthTarget[]> {
  const files = await listAuthFilesFromCLIProxyAPI();
  const targets = files
    .filter((item) => {
      const name = normalizeCLIProxyAuthFileName(item);
      if (!name.toLowerCase().endsWith(".json")) {
        return false;
      }
      if (typeof item?.type === "string" && item.type.trim() && item.type !== "codex") {
        return false;
      }
      return true;
    })
    .map((item) => {
      const name = normalizeCLIProxyAuthFileName(item);
      const filePath = `cpa:${name}`;
      const currentDisabled = normalizeCLIProxyDisabled(item.disabled);
      return {
        filePath,
        currentDisabled,
        async summarize(forceRefresh: boolean) {
          const payload = await downloadAuthFileJsonObjectFromCLIProxyAPI(name);
          if (!isCodexAuthRecord(payload)) {
            throw new Error(`不是 codex auth 文件: ${name}`);
          }
          const tempPath = path.join(process.cwd(), "data", "cpa-temp", name);
          await saveAuthRecord(tempPath, payload as AuthRecord);
          const summary = await summarizeAuthFile(tempPath, forceRefresh);
          if (summary.refreshed) {
            await saveAuthFileJsonObjectToCLIProxyAPI(name, await loadAuthRecord(tempPath) as Record<string, unknown>);
          }
          summary.file = filePath;
          return summary;
        },
        async setDisabled(disabled: boolean) {
          await setAuthFileDisabledStatusToCLIProxyAPI(name, disabled);
        },
        async remove() {
          await deleteAuthFileFromCLIProxyAPI(name);
          return true;
        },
      } satisfies AuthTarget;
    });
  targets.sort((left, right) => left.filePath.localeCompare(right.filePath));
  return targets;
}

function printCheckLine(row: AuthSummary): void {
  if (!row.ok) {
    console.log(`[❌️]${row.email}-${row.note || "未知错误"}`);
    return;
  }

  const extra = row.movedTo401 ? " 已移除" : "";
  const remaining = row.remainingPercent == null ? "N/A" : `${row.remainingPercent.toFixed(2)}%`;
  const reset = row.resetAt || "N/A";
  console.log(`[✅️][${row.plan}][${remaining}]${row.email}-${reset}${extra}`);
}

function printTable(rows: AuthSummary[]): void {
  const headers = {
    file: "file",
    email: "email",
    plan: "plan",
    status: "status",
    used: "used",
    remaining: "remaining",
    reset: "reset",
    limitReached: "limit_reached",
    expires: "expires",
    note: "note",
  };
  const widths = {
    file: Math.min(42, Math.max(headers.file.length, ...rows.map((row) => row.file.length))),
    email: Math.min(32, Math.max(headers.email.length, ...rows.map((row) => row.email.length))),
    plan: Math.max(headers.plan.length, ...rows.map((row) => row.plan.length)),
    status: Math.max(headers.status.length, ...rows.map((row) => row.status.length)),
    used: Math.max(headers.used.length, ...rows.map((row) => formatPercent(row.usedPercent).length)),
    remaining: Math.max(headers.remaining.length, ...rows.map((row) => formatPercent(row.remainingPercent).length)),
    reset: Math.min(32, Math.max(headers.reset.length, ...rows.map((row) => (row.resetAt || "-").length))),
    limitReached: Math.max(headers.limitReached.length, ...rows.map((row) => String(row.limitReached ?? "-").length)),
    expires: Math.max(headers.expires.length, ...rows.map((row) => row.expires.length)),
    note: Math.min(60, Math.max(headers.note.length, ...rows.map((row) => row.note.length))),
  };
  const headerLine = [
    formatCell(headers.file, widths.file),
    formatCell(headers.email, widths.email),
    formatCell(headers.plan, widths.plan),
    formatCell(headers.status, widths.status),
    formatCell(headers.used, widths.used),
    formatCell(headers.remaining, widths.remaining),
    formatCell(headers.reset, widths.reset),
    formatCell(headers.limitReached, widths.limitReached),
    formatCell(headers.expires, widths.expires),
    formatCell(headers.note, widths.note),
  ].join("  ");
  console.log(headerLine);
  console.log("-".repeat(headerLine.length));
  for (const row of rows) {
    console.log([
      formatCell(truncate(row.file, widths.file), widths.file),
      formatCell(truncate(row.email, widths.email), widths.email),
      formatCell(truncate(row.plan, widths.plan), widths.plan),
      formatCell(truncate(row.status, widths.status), widths.status),
      formatCell(formatPercent(row.usedPercent), widths.used),
      formatCell(formatPercent(row.remainingPercent), widths.remaining),
      formatCell(truncate(row.resetAt || "-", widths.reset), widths.reset),
      formatCell(String(row.limitReached ?? "-"), widths.limitReached),
      formatCell(truncate(row.expires || "-", widths.expires), widths.expires),
      formatCell(truncate(row.note, widths.note), widths.note),
    ].join("  "));
  }
}

async function main(): Promise<void> {
  const limitArg = Number.parseInt(readFlagValue("--limit").trim(), 10);
  const forceRefresh = hasFlag("--refresh");
  const verbose = hasFlag("--verbose");
  const useCPA = hasFlag("--cpa");
  const authDir = path.resolve(readFlagValue("--dir").trim() || DEFAULT_AUTH_DIR);
  const targets = useCPA
    ? await collectCPAAuthTargets()
    : (await collectAuthFiles(authDir)).map((filePath) => ({
      filePath,
      summarize: (refresh: boolean) => summarizeAuthFile(filePath, refresh),
    } satisfies AuthTarget));
  const targetItems =
        Number.isFinite(limitArg) && limitArg > 0 ? targets.slice(0, limitArg) : targets;

  if (!targetItems.length) {
    throw new Error(useCPA ? "未在 CPA 中找到可检查的 codex 授权文件" : `未在目录中找到授权文件: ${authDir}`);
  }

  const concurrency = resolveConcurrency(targetItems.length);
  console.log(
    `准备检查 ${targetItems.length} 个 auth 文件: ${useCPA ? "CPA" : authDir}${forceRefresh ? " (强制刷新 token)" : ""} (并发: ${concurrency})`,
  );

  const indexedRows = await mapWithConcurrency<AuthTarget, IndexedAuthSummary>(
    targetItems,
    concurrency,
    async (target, index) => {
      const row = await target.summarize(forceRefresh);
      if (useCPA && row.rawStatus === 401 && row.note.toLowerCase().includes("deactivated") && target.remove) {
        row.movedTo401 = await target.remove();
      }
      if (useCPA && row.ok && target.setDisabled && row.remainingPercent != null) {
        if (row.remainingPercent <= 5 && target.currentDisabled !== true) {
          await target.setDisabled(true);
          target.currentDisabled = true;
          console.log(`cpaAuthDisabled: ${target.filePath} remaining=${row.remainingPercent.toFixed(2)}%`);
        } else if (row.remainingPercent > 5 && target.currentDisabled === true) {
          await target.setDisabled(false);
          target.currentDisabled = false;
          console.log(`cpaAuthEnabled: ${target.filePath} remaining=${row.remainingPercent.toFixed(2)}%`);
        }
      }
      printCheckLine(row);
      if (verbose) {
        console.log(`RAW_STATUS: ${row.rawStatus}`);
        console.log("RAW_BODY_START");
        console.log(row.rawBody);
        console.log("RAW_BODY_END");
      }
      return {index, row};
    },
  );
  const rows = indexedRows
    .sort((left, right) => left.index - right.index)
    .map((entry) => entry.row);
  const totalCount = rows.length;
  const availableRows = rows.filter((row) => row.ok);
  const availableCount = availableRows.length;
  const limitedCount = rows.filter((row) => parsePercent(row.remainingPercent) === 0).length;
  const movedCount = rows.filter((row) => row.movedTo401).length;
  const totalRemaining = availableRows.reduce((sum, row) => sum + ((row.remainingPercent ?? 0) / 100), 0);
  console.log(
    `总数 ${totalCount} | 可用 ${availableCount} | 限额 ${limitedCount} | 移除 ${movedCount} | 可用额度 ${totalRemaining.toFixed(2)}`,
  );
  if (hasFlag("--table")) {
    printTable(rows);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
