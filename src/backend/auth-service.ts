import {cpus} from "node:os";
import {readdir, readFile} from "node:fs/promises";
import path from "node:path";
import {Buffer} from "node:buffer";
import {fetch as undiciFetch, Agent, ProxyAgent, type Dispatcher, type RequestInit as UndiciRequestInit} from "undici";
import {appConfig} from "../core/config.js";
import {AUTH_OAUTH_TOKEN_URLS, DEFAULT_CLIENT_ID, DEFAULT_USER_AGENT} from "../core/constants.js";
import type {SavedAuthRecord} from "../core/openai.js";
import {getDb, currentTimestamp, getAuthFileContent, updateAuthFileContent, type AccountRow, type AuthFileRow} from "./db.js";
import {decryptSecret, encryptSecret} from "./crypto.js";
import {buildZip, type ZipEntry} from "./zip.js";
import {
  resolvePushServices,
  saveAuthFileJsonObjectToCPAService,
  deleteAuthFileFromCPAService,
  uploadAuthFileToSub2APIService,
  deleteAccountFromSub2APIService,
} from "./integration-service.js";
import {
  ensureAccountPlatformBinding,
  listAccountPlatformBindings,
  updateBindingPushResult,
  type BoundPlatformService,
} from "./account-platform-binding-service.js";
import {createJob, runJob} from "./job-service.js";

export interface AuthRecord {
    access_token?: string;
    account_id?: string;
    disabled?: boolean;
    email?: string;
    expired?: string;
    expires_at?: string;
    id_token?: string;
    last_refresh?: string;
    refresh_token?: string;
    type?: string;
    websockets?: boolean;
}

interface JwtClaims {
    email?: string;
    exp?: number;
    ["https://api.openai.com/auth"]?: {
        chatgpt_account_id?: string;
        chatgpt_plan_type?: string;
    };
}

interface ProbeResponse {
    status: number;
    body: string;
}

interface OAuthTokenResponse {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
}

interface UsageWindow {
    used_percent?: number;
    reset_after_seconds?: number;
}

interface UsagePayload {
    plan_type?: string;
    rate_limit?: {
        limit_reached?: boolean;
        primary_window?: UsageWindow;
        secondary_window?: UsageWindow;
        daily_window?: UsageWindow;
        weekly_window?: UsageWindow;
    };
}

export interface AuthSummary {
    file: string;
    email: string;
    plan: string;
    status: string;
    ok: boolean;
    usedPercent: number | null;
    remainingPercent: number | null;
    resetAt: string | null;
    limitReached: boolean | null;
    expires: string;
    note: string;
    rawStatus: number;
    rawBody: string;
    movedTo401: boolean;
    refreshed: boolean;
    statusCode: string;
    statusLabel: string;
    credentialType: "codex_auth" | "access_token_only" | "none";
    windows: AccountUsageWindow[];
}

export type CredentialSourceKind = "local" | "cpa" | "sub2api";

export interface UpsertAuthOptions {
    sourceKind?: CredentialSourceKind;
    sourceName?: string | null;
    sourceServiceId?: number | null;
    sourceRemoteId?: string | null;
    syncedAt?: string | null;
    preserveSource?: boolean;
    preserveAccountMetadata?: boolean;
    activate?: boolean;
    contentJson?: string;
}

const DEFAULT_AUTH_DIR = path.resolve(process.cwd(), "auth");
const REQUEST_TIMEOUT_MS = 15000;
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

function maskPath(filePath: string): string {
  return path.relative(process.cwd(), filePath) || filePath;
}

function isExcludedAuthDir(dirPath: string): boolean {
  const parts = path.relative(DEFAULT_AUTH_DIR, dirPath).split(path.sep).map((item) => item.toLowerCase());
  return parts.includes("401") || parts.includes("platforms");
}

export async function collectAuthFiles(rootDir = DEFAULT_AUTH_DIR): Promise<string[]> {
  const files: string[] = [];

  async function walk(dirPath: string): Promise<void> {
    if (isExcludedAuthDir(dirPath)) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dirPath, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries) {
      const childPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        files.push(childPath);
      }
    }
  }

  await walk(rootDir);
  files.sort((left, right) => left.localeCompare(right));
  return files;
}

export async function loadAuthRecord(filePath: string): Promise<AuthRecord> {
  return JSON.parse(await readFile(filePath, "utf8")) as AuthRecord;
}

export function loadAuthRecordFromDb(authFile: AuthFileRow): AuthRecord {
  const content = authFile.content_json ?? getAuthFileContent(authFile.id);
  if (!content) {
    throw new Error(`账号凭据内容为空: auth_file_id=${authFile.id}`);
  }
  return JSON.parse(content) as AuthRecord;
}

export function decodeJwtClaims(token: string | undefined): JwtClaims | null {
  if (!token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = payload.padEnd(Math.ceil(payload.length / 4) * 4, "=");
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as JwtClaims;
  } catch {
    return null;
  }
}

function parseJson<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function buildDispatcher(proxyUrl = appConfig.defaultProxyUrl): Dispatcher {
  return proxyUrl
    ? new ProxyAgent({
      uri: proxyUrl,
      requestTls: {rejectUnauthorized: false},
    })
    : new Agent({
      connect: {rejectUnauthorized: false},
    });
}

function extractMessage(rawBody: string): string {
  const payload = parseJson<Record<string, unknown>>(rawBody);
  const errorObject =
        payload?.error && typeof payload.error === "object"
          ? payload.error as Record<string, unknown>
          : null;
  return String(
    errorObject?.message ??
        payload?.message ??
        payload?.detail ??
        errorObject?.code ??
        payload?.error_description ??
        payload?.error ??
        rawBody,
  );
}

function shouldMoveTo401(message: string): boolean {
  return message.toLowerCase().includes("deactivated");
}

function formatResetAt(seconds: number | undefined): string | null {
  if (typeof seconds !== "number" || seconds <= 0 || Number.isNaN(seconds)) {
    return null;
  }
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export interface AccountUsageWindow {
    window_key: string;
    label: string;
    used_percent: number | null;
    remaining_percent: number | null;
    reset_at: string | null;
    limit_reached: boolean | null;
}

function isAccessTokenOnlyRecord(record: AuthRecord): boolean {
  return record.type === "chatgpt" || (!record.refresh_token && Boolean(record.access_token));
}

function resolveCredentialType(record: AuthRecord): "codex_auth" | "access_token_only" | "none" {
  if (isAccessTokenOnlyRecord(record)) {
    return "access_token_only";
  }
  if (record.access_token || record.refresh_token || record.id_token) {
    return "codex_auth";
  }
  return "none";
}

function isFreePlan(plan: string | null | undefined): boolean {
  const normalized = String(plan ?? "").trim().toLowerCase();
  return !normalized || normalized === "-" || normalized === "free" || normalized.includes("free");
}

function buildUsageWindow(
  windowKey: string,
  label: string,
  window: UsageWindow | undefined,
  limitReached: boolean | null,
): AccountUsageWindow {
  const usedPercent =
        typeof window?.used_percent === "number" && Number.isFinite(window.used_percent)
          ? window.used_percent
          : null;
  return {
    window_key: windowKey,
    label,
    used_percent: usedPercent,
    remaining_percent: usedPercent == null ? null : Math.max(0, 100 - usedPercent),
    reset_at: formatResetAt(window?.reset_after_seconds),
    limit_reached: limitReached,
  };
}

function extractUsageWindows(payload: UsagePayload | null, plan: string): AccountUsageWindow[] {
  const limitReached =
        typeof payload?.rate_limit?.limit_reached === "boolean"
          ? payload.rate_limit.limit_reached
          : null;
  const primary = payload?.rate_limit?.primary_window;
  const secondary = payload?.rate_limit?.secondary_window ?? payload?.rate_limit?.daily_window ?? payload?.rate_limit?.weekly_window;

  if (isFreePlan(plan)) {
    return [buildUsageWindow("seven_day", "7天", secondary ?? primary, limitReached)];
  }

  return [
    buildUsageWindow("five_hour", "5小时", primary, limitReached),
    buildUsageWindow("seven_day", "7天", secondary, limitReached),
  ];
}

function deriveStatus(summary: {
    ok: boolean;
    rawStatus: number;
    credentialType: "codex_auth" | "access_token_only" | "none";
    note: string;
    limitReached: boolean | null;
    remainingPercent: number | null;
    refreshed: boolean;
}): {statusCode: string; statusLabel: string} {
  if (summary.credentialType === "access_token_only") {
    return {statusCode: "access_token_only", statusLabel: "只保存 accessToken"};
  }
  if (summary.credentialType === "none") {
    return {statusCode: "credential_expired", statusLabel: "凭据过期"};
  }
  if (summary.ok) {
    if (summary.limitReached || summary.remainingPercent === 0) {
      return {statusCode: "quota_exhausted", statusLabel: "额度已用尽"};
    }
    return {statusCode: "authorized", statusLabel: "正常"};
  }
  const note = summary.note.toLowerCase();
  if (summary.rawStatus === 401 || note.includes("refresh") || note.includes("token") || note.includes("expired") || note.includes("缺少 refresh_token")) {
    return {statusCode: "credential_expired", statusLabel: "凭据过期"};
  }
  if (summary.rawStatus === 403 || note.includes("deactivated") || note.includes("forbidden")) {
    return {statusCode: "account_abnormal", statusLabel: "账号状态异常"};
  }
  return {statusCode: "account_abnormal", statusLabel: "账号状态异常"};
}

function normalizeRefreshedAuthRecord(existing: AuthRecord, payload: OAuthTokenResponse): AuthRecord {
  if (!payload.access_token) {
    throw new Error(`refresh 响应缺少 access_token: ${JSON.stringify(payload)}`);
  }
  if (!payload.refresh_token) {
    throw new Error(`refresh 响应缺少 refresh_token: ${JSON.stringify(payload)}`);
  }
  if (!payload.id_token) {
    throw new Error(`refresh 响应缺少 id_token: ${JSON.stringify(payload)}`);
  }

  const accessClaims = decodeJwtClaims(payload.access_token);
  const idClaims = decodeJwtClaims(payload.id_token);
  const accountId =
        accessClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() ||
        idClaims?.["https://api.openai.com/auth"]?.chatgpt_account_id?.trim() ||
        existing.account_id?.trim() ||
        "";
  const email =
        existing.email?.trim() ||
        idClaims?.email?.trim() ||
        accessClaims?.email?.trim() ||
        "";
  const exp =
        accessClaims?.exp
          ? new Date(accessClaims.exp * 1000).toISOString()
          : typeof payload.expires_in === "number" && payload.expires_in > 0
            ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
            : existing.expired?.trim() || "";

  return {
    ...existing,
    access_token: payload.access_token,
    account_id: accountId,
    disabled: false,
    email,
    expired: exp,
    id_token: payload.id_token,
    last_refresh: new Date().toISOString(),
    refresh_token: payload.refresh_token,
    type: existing.type ?? "codex",
    websockets: existing.websockets ?? false,
  };
}

export async function refreshAccessToken(
  record: AuthRecord,
): Promise<{ record?: AuthRecord; error?: string; status?: number }> {
  if (!record.refresh_token) {
    return {error: "缺少 refresh_token"};
  }

  let lastError = "";
  let lastStatus = 0;
  for (const tokenURL of AUTH_OAUTH_TOKEN_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
    try {
      const response = await undiciFetch(tokenURL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": DEFAULT_USER_AGENT,
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: DEFAULT_CLIENT_ID,
          refresh_token: record.refresh_token,
        }),
        signal: controller.signal,
        dispatcher: buildDispatcher(),
      } satisfies UndiciRequestInit);

      const rawBody = await response.text();
      if (!response.ok) {
        lastStatus = response.status;
        lastError = extractMessage(rawBody);
        continue;
      }

      const payload = parseJson<OAuthTokenResponse>(rawBody);
      if (!payload) {
        lastError = "refresh 响应不是合法 JSON";
        continue;
      }

      return {
        record: normalizeRefreshedAuthRecord(record, payload),
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  return {error: lastError || "refresh 失败", status: lastStatus || undefined};
}

async function sendUsageProbe(accessToken: string, accountId: string): Promise<ProbeResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), REQUEST_TIMEOUT_MS);
  try {
    const response = await undiciFetch(USAGE_URL, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
        Origin: "https://chatgpt.com",
        Referer: "https://chatgpt.com/",
        ...(accountId ? {"Chatgpt-Account-Id": accountId} : {}),
      },
      signal: controller.signal,
      dispatcher: buildDispatcher(),
    } satisfies UndiciRequestInit);
    return {
      status: response.status,
      body: await response.text(),
    };
  } catch (error) {
    return {
      status: 0,
      body: String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function moveTo401Dir(filePath: string): Promise<boolean> {
  // no-op: auth content is stored in DB, no file to move
  return true;
}

export async function summarizeAuthFile(authFileId: number, contentJson: string, forceRefresh: boolean): Promise<AuthSummary> {
  let record = JSON.parse(contentJson) as AuthRecord;
  const claims = decodeJwtClaims(record.id_token ?? record.access_token);
  const email = record.email?.trim() || claims?.email?.trim() || `auth-file-${authFileId}`;
  const localPlan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type?.trim() || "-";
  const credentialType = resolveCredentialType(record);

  if (credentialType === "access_token_only") {
    const exp = record.expired?.trim() || String(record.expires_at ?? "").trim();
    return {
      file: `auth-file-${authFileId}`,
      email,
      plan: localPlan,
      status: "access_token_only",
      ok: true,
      usedPercent: null,
      remainingPercent: null,
      resetAt: null,
      limitReached: null,
      expires: exp,
      note: "只保存 ChatGPT accessToken",
      rawStatus: 200,
      rawBody: "",
      movedTo401: false,
      refreshed: false,
      statusCode: "access_token_only",
      statusLabel: "只保存 accessToken",
      credentialType,
      windows: [],
    };
  }

  if (!record.access_token) {
    const status = deriveStatus({
      ok: false,
      rawStatus: 0,
      credentialType,
      note: "缺少 access_token",
      limitReached: null,
      remainingPercent: null,
      refreshed: false,
    });
    return {
      file: `auth-file-${authFileId}`,
      email,
      plan: localPlan,
      status: "invalid",
      ok: false,
      usedPercent: null,
      remainingPercent: null,
      resetAt: null,
      limitReached: null,
      expires: record.expired?.trim() || "",
      note: "缺少 access_token",
      rawStatus: 0,
      rawBody: "missing access_token",
      movedTo401: false,
      refreshed: false,
      ...status,
      credentialType,
      windows: [],
    };
  }

  let movedTo401 = false;
  let refreshed = false;
  let probe: ProbeResponse;
  let message = "";

  if (forceRefresh) {
    const result = await refreshAccessToken(record);
    if (result.record) {
      record = result.record;
      refreshed = true;
      updateAuthFileContent(authFileId, JSON.stringify(record));
      probe = await sendUsageProbe(record.access_token ?? "", record.account_id?.trim() || "");
      message = extractMessage(probe.body);
    } else {
      probe = {
        status: result.status ?? 0,
        body: result.error || "refresh 失败",
      };
      message = result.error || "refresh 失败";
    }
  } else {
    probe = await sendUsageProbe(record.access_token, record.account_id?.trim() || "");
    message = extractMessage(probe.body);
  }

  if (probe.status === 401) {
    if (shouldMoveTo401(message)) {
      movedTo401 = true;
    } else {
      const result = await refreshAccessToken(record);
      if (result.record) {
        record = result.record;
        refreshed = true;
        updateAuthFileContent(authFileId, JSON.stringify(record));
        probe = await sendUsageProbe(record.access_token ?? "", record.account_id?.trim() || "");
        message = extractMessage(probe.body);
      } else {
        message = result.error || message;
      }
    }
  }

  const payload = parseJson<UsagePayload>(probe.body);
  const plan = payload?.plan_type?.trim() || localPlan;
  const windows = extractUsageWindows(payload, plan);
  const primary = windows[0];
  const usedPercent =
        typeof primary?.used_percent === "number" && Number.isFinite(primary.used_percent)
          ? primary.used_percent
          : null;
  const remainingPercent = usedPercent == null ? null : Math.max(0, 100 - usedPercent);
  const limitReached =
        typeof payload?.rate_limit?.limit_reached === "boolean"
          ? payload.rate_limit.limit_reached
          : null;
  const status = deriveStatus({
    ok: probe.status === 200,
    rawStatus: probe.status,
    credentialType,
    note: probe.status === 200 ? "请求成功" : message,
    limitReached,
    remainingPercent,
    refreshed,
  });

  return {
    file: `auth-file-${authFileId}`,
    email,
    plan,
    status: probe.status === 200 ? "ok" : `http_${probe.status}`,
    ok: probe.status === 200,
    usedPercent,
    remainingPercent,
    resetAt: primary?.reset_at ?? null,
    limitReached,
    expires: record.expired?.trim() || "",
    note: probe.status === 200 ? "请求成功" : message,
    rawStatus: probe.status,
    rawBody: probe.body,
    movedTo401,
    refreshed,
    ...status,
    credentialType,
    windows,
  };
}

export async function importAuthFiles(): Promise<{imported: number; updated: number; skipped: number}> {
  const files = await collectAuthFiles();
  let imported = 0;
  let updated = 0;
  let skipped = 0;

  for (const filePath of files) {
    try {
      const content = await readFile(filePath, "utf8");
      const record = JSON.parse(content) as AuthRecord;
      const claims = decodeJwtClaims(record.id_token ?? record.access_token);
      const email = record.email?.trim() || claims?.email?.trim();
      if (!email) {
        skipped += 1;
        continue;
      }

      const authExists = getDb().prepare("SELECT id FROM auth_files WHERE file_path = ?").get(filePath);
      await upsertAccountFromAuthRecord(record, filePath, {contentJson: content});
      if (authExists) {
        updated += 1;
      } else {
        imported += 1;
      }
    } catch {
      skipped += 1;
    }
  }

  return {imported, updated, skipped};
}

export async function upsertAccountFromAuthRecord(
  record: AuthRecord,
  filePath?: string,
  options: UpsertAuthOptions = {},
): Promise<AccountRow> {
  const claims = decodeJwtClaims(record.id_token ?? record.access_token);
  const email = record.email?.trim() || claims?.email?.trim();
  if (!email) {
    throw new Error("auth 记录缺少 email");
  }
  const timestamp = currentTimestamp();
  const sourceKind = options.sourceKind ?? (filePath && !options.preserveSource ? "local" : undefined);
  const sourceName = options.sourceName ?? null;
  const sourceServiceId = options.sourceServiceId ?? null;
  const sourceRemoteId = options.sourceRemoteId ?? null;
  const syncedAt = options.syncedAt ?? timestamp;
  const existing = getDb().prepare("SELECT * FROM accounts WHERE email = ?").get(email) as AccountRow | undefined;
  const plan = claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type?.trim() || existing?.plan || null;
  const credentialType = resolveCredentialType(record);
  const initialStatusCode = credentialType === "access_token_only" ? "access_token_only" : "unchecked";
  const initialStatusLabel = credentialType === "access_token_only" ? "只保存 accessToken" : "未检查";
  if (existing) {
    if (options.preserveAccountMetadata) {
      getDb().prepare(`
            UPDATE accounts
            SET credential_type = @credential_type,
                credential_source_kind = COALESCE(@credential_source_kind, credential_source_kind),
                credential_source_name = COALESCE(@credential_source_name, credential_source_name),
                credential_source_service_id = COALESCE(@credential_source_service_id, credential_source_service_id),
                credential_source_remote_id = COALESCE(@credential_source_remote_id, credential_source_remote_id),
                credential_synced_at = CASE
                    WHEN @credential_source_kind IS NULL THEN credential_synced_at
                    ELSE @credential_synced_at
                END,
                updated_at = @updated_at
            WHERE id = @id
        `).run({
        id: existing.id,
        credential_type: credentialType,
        credential_source_kind: sourceKind ?? null,
        credential_source_name: sourceName,
        credential_source_service_id: sourceServiceId,
        credential_source_remote_id: sourceRemoteId,
        credential_synced_at: syncedAt,
        updated_at: timestamp,
      });
    } else {
      getDb().prepare(`
            UPDATE accounts
            SET provider = COALESCE(provider, @provider),
                status = CASE WHEN status = 'unknown' THEN 'imported' ELSE status END,
                plan = @plan,
                credential_type = @credential_type,
                status_code = COALESCE(status_code, @status_code),
                status_label = COALESCE(status_label, @status_label),
                last_auth_at = COALESCE(last_auth_at, @last_auth_at),
                credential_source_kind = COALESCE(@credential_source_kind, credential_source_kind),
                credential_source_name = COALESCE(@credential_source_name, credential_source_name),
                credential_source_service_id = COALESCE(@credential_source_service_id, credential_source_service_id),
                credential_source_remote_id = COALESCE(@credential_source_remote_id, credential_source_remote_id),
                credential_synced_at = CASE
                    WHEN @credential_source_kind IS NULL THEN credential_synced_at
                    ELSE @credential_synced_at
                END,
                updated_at = @updated_at
            WHERE id = @id
        `).run({
        id: existing.id,
        provider: appConfig.provider,
        plan,
        credential_type: credentialType,
        status_code: initialStatusCode,
        status_label: initialStatusLabel,
        last_auth_at: record.last_refresh ?? timestamp,
        credential_source_kind: sourceKind ?? null,
        credential_source_name: sourceName,
        credential_source_service_id: sourceServiceId,
        credential_source_remote_id: sourceRemoteId,
        credential_synced_at: syncedAt,
        updated_at: timestamp,
      });
    }
  } else {
    getDb().prepare(`
            INSERT INTO accounts (
                email, password_encrypted, provider, status, plan,
                last_auth_at, auto_reauth, created_at, updated_at,
                credential_type, status_code, status_label,
                credential_source_kind, credential_source_name, credential_source_service_id,
                credential_source_remote_id, credential_synced_at
            )
            VALUES (
                @email, NULL, @provider, 'imported', @plan,
                @last_auth_at, 1, @created_at, @updated_at,
                @credential_type, @status_code, @status_label,
                @credential_source_kind, @credential_source_name, @credential_source_service_id,
                @credential_source_remote_id, @credential_synced_at
            )
        `).run({
      email,
      provider: appConfig.provider,
      plan,
      last_auth_at: record.last_refresh ?? timestamp,
      created_at: timestamp,
      updated_at: timestamp,
      credential_type: credentialType,
      status_code: initialStatusCode,
      status_label: initialStatusLabel,
      credential_source_kind: sourceKind ?? null,
      credential_source_name: sourceName,
      credential_source_service_id: sourceServiceId,
      credential_source_remote_id: sourceRemoteId,
      credential_synced_at: sourceKind ? syncedAt : null,
    });
  }

  const account = getDb().prepare("SELECT * FROM accounts WHERE email = ?").get(email) as AccountRow;
  if (filePath) {
    upsertAuthFile(account.id, filePath, record, options);
  }
  return account;
}

export function upsertAuthFile(accountId: number, filePath: string, record: AuthRecord, options: UpsertAuthOptions = {}): AuthFileRow {
  const timestamp = currentTimestamp();
  const credentialType = resolveCredentialType(record);
  const shouldActivate = options.activate !== false;
  const contentJson = options.contentJson ?? JSON.stringify(record, null, 2);
  if (shouldActivate) {
    getDb().prepare("UPDATE auth_files SET active = 0 WHERE account_id = ? AND file_path <> ?").run(accountId, filePath);
  }
  getDb().prepare(`
        INSERT INTO auth_files (
            account_id, file_path, file_name, active, token_expires_at, credential_type,
            current_step, step_status, last_step_at,
            credential_source_kind, credential_source_name, credential_source_service_id,
            credential_source_remote_id, credential_synced_at,
            content_json,
            created_at, updated_at
        )
        VALUES (
            @account_id, @file_path, @file_name, @active, @token_expires_at, @credential_type,
            @current_step, @step_status, @last_step_at,
            @credential_source_kind, @credential_source_name, @credential_source_service_id,
            @credential_source_remote_id, @credential_synced_at,
            @content_json,
            @created_at, @updated_at
        )
        ON CONFLICT(file_path) DO UPDATE SET
            account_id = excluded.account_id,
            file_name = excluded.file_name,
            active = excluded.active,
            token_expires_at = excluded.token_expires_at,
            credential_type = excluded.credential_type,
            credential_source_kind = COALESCE(excluded.credential_source_kind, credential_source_kind),
            credential_source_name = COALESCE(excluded.credential_source_name, credential_source_name),
            credential_source_service_id = COALESCE(excluded.credential_source_service_id, credential_source_service_id),
            credential_source_remote_id = COALESCE(excluded.credential_source_remote_id, credential_source_remote_id),
            credential_synced_at = COALESCE(excluded.credential_synced_at, credential_synced_at),
            content_json = excluded.content_json,
            updated_at = excluded.updated_at
    `).run({
    account_id: accountId,
    file_path: filePath,
    file_name: path.basename(filePath),
    active: shouldActivate ? 1 : 0,
    token_expires_at: record.expired ?? record.expires_at ?? null,
    credential_type: credentialType,
    current_step: credentialType === "access_token_only" ? "保存 accessToken" : "导入 auth",
    step_status: "success",
    last_step_at: timestamp,
    credential_source_kind: options.preserveSource ? null : (options.sourceKind ?? (filePath ? "local" : null)),
    credential_source_name: options.sourceName ?? null,
    credential_source_service_id: options.sourceServiceId ?? null,
    credential_source_remote_id: options.sourceRemoteId ?? null,
    credential_synced_at: options.sourceKind ? (options.syncedAt ?? timestamp) : null,
    content_json: contentJson,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return getDb().prepare("SELECT * FROM auth_files WHERE file_path = ?").get(filePath) as AuthFileRow;
}

export interface AccountListItem {
    id: number;
    email: string;
    provider: string | null;
    status: string;
    plan: string | null;
    remaining_percent: number | null;
    used_percent: number | null;
    reset_at: string | null;
    last_check_at: string | null;
    last_refresh_at: string | null;
    last_auth_at: string | null;
    last_error: string | null;
    auto_reauth: number;
    has_password: boolean | number;
    created_at: string;
    updated_at: string;
    auth_file_path: string | null;
    auth_file_name: string | null;
    auth_credential_type: string | null;
    current_step: string | null;
    step_status: string | null;
    last_step_at: string | null;
    status_code: string | null;
    status_label: string | null;
    credential_type: string | null;
    credential_source_kind: string | null;
    credential_source_name: string | null;
    credential_source_service_id: number | null;
    credential_source_remote_id: string | null;
    credential_synced_at: string | null;
    needs_manual_reauth: number;
    last_reauth_attempt_at: string | null;
    last_reauth_error: string | null;
    source_id: number | null;
    source_name: string | null;
    source_provider: string | null;
    source_vendor: string | null;
    source_batch_note: string | null;
    mailbox_id: number | null;
    usage_windows: AccountUsageWindow[];
    platform_bindings: BoundPlatformService[];
}

export interface AccountFilters {
    q?: string;
    status?: string;
    credentialType?: string;
    provider?: string;
    plan?: string;
    autoReauth?: string;
    pushStatus?: string;
    bindingServiceIds?: number[];
    page?: number;
    pageSize?: number;
}

export function listAccounts(filters: string | AccountFilters = ""): AccountListItem[] {
  const normalized: AccountFilters = typeof filters === "string" ? {q: filters} : filters;
  const q = `%${String(normalized.q ?? "").trim()}%`;
  const bindingIds = Array.isArray(normalized.bindingServiceIds)
    ? [...new Set(normalized.bindingServiceIds.map(Number).filter((value) => Number.isFinite(value) && value > 0))]
    : [];
  const bindingNames = bindingIds.map((_, index) => `@bindingId${index}`);
  const bindingClause = bindingIds.length
    ? `AND EXISTS (
        SELECT 1 FROM account_platform_bindings b
        WHERE b.account_id = a.id AND b.integration_service_id IN (${bindingNames.join(",")})
      )`
    : "";
  const sql = `
        SELECT
            a.id,
            a.email,
            a.provider,
            a.status,
            a.plan,
            a.remaining_percent,
            a.used_percent,
            a.reset_at,
            a.last_check_at,
            a.last_refresh_at,
            a.last_auth_at,
            a.last_error,
            a.auto_reauth,
            CASE
                WHEN a.password_encrypted IS NOT NULL AND a.password_encrypted <> '' THEN 1
                ELSE 0
            END AS has_password,
            a.created_at,
            a.updated_at,
            a.status_code,
            a.status_label,
            a.credential_type,
            a.credential_source_kind,
            a.credential_source_name,
            a.credential_source_service_id,
            a.credential_source_remote_id,
            a.credential_synced_at,
            a.needs_manual_reauth,
            a.last_reauth_attempt_at,
            a.last_reauth_error,
            a.source_id,
            ms.name AS source_name,
            ms.provider AS source_provider,
            ms.vendor AS source_vendor,
            ms.batch_note AS source_batch_note,
            a.mailbox_id,
            af.file_path AS auth_file_path,
            af.file_name AS auth_file_name,
            af.credential_type AS auth_credential_type,
            af.current_step AS current_step,
            af.step_status AS step_status,
            af.last_step_at AS last_step_at
        FROM accounts a
        LEFT JOIN auth_files af ON af.account_id = a.id AND af.active = 1
        LEFT JOIN mail_sources ms ON ms.id = a.source_id
        WHERE (@query = '' OR a.email LIKE @q OR a.status LIKE @q OR a.status_code LIKE @q)
          AND (@status = '' OR
                (@status = 'needs_manual_reauth' AND a.needs_manual_reauth = 1) OR
                COALESCE(a.status_code, a.status) = @status)
          AND (@credentialType = '' OR COALESCE(af.credential_type, a.credential_type, 'none') = @credentialType)
          AND (@provider = '' OR COALESCE(a.provider, '') = @provider)
          AND (@plan = '' OR COALESCE(a.plan, '') = @plan)
          AND (@autoReauth = '' OR a.auto_reauth = CASE WHEN @autoReauth = 'true' THEN 1 ELSE 0 END)
          AND (
            @pushStatus = ''
            OR (@pushStatus = 'pushed' AND EXISTS (
                  SELECT 1 FROM account_platform_bindings b WHERE b.account_id = a.id))
            OR (@pushStatus = 'not_pushed' AND NOT EXISTS (
                  SELECT 1 FROM account_platform_bindings b WHERE b.account_id = a.id))
          )
          ${bindingClause}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT @limit OFFSET @offset
    `;
  const params: Record<string, unknown> = {
    query: String(normalized.q ?? "").trim(),
    q,
    status: String(normalized.status ?? "").trim(),
    credentialType: String(normalized.credentialType ?? "").trim(),
    provider: String(normalized.provider ?? "").trim(),
    plan: String(normalized.plan ?? "").trim(),
    autoReauth: String(normalized.autoReauth ?? "").trim(),
    pushStatus: String(normalized.pushStatus ?? "").trim(),
    limit: Math.min(500, Math.max(1, Number(normalized.pageSize ?? 200) || 200)),
    offset: Math.max(0, ((Number(normalized.page ?? 1) || 1) - 1) * (Number(normalized.pageSize ?? 200) || 200)),
  };
  bindingIds.forEach((id, index) => {
    params[`bindingId${index}`] = id;
  });
  const rows = getDb().prepare(sql).all(params) as AccountListItem[];
  const ids = rows.map((row) => row.id);
  const windowsByAccount = new Map<number, AccountUsageWindow[]>();
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",");
    const windows = getDb().prepare(`
            SELECT * FROM account_usage_windows
            WHERE account_id IN (${placeholders})
            ORDER BY account_id ASC, id ASC
        `).all(...ids) as Array<AccountUsageWindow & {account_id: number}>;
    for (const window of windows) {
      const list = windowsByAccount.get(window.account_id) ?? [];
      list.push(window);
      windowsByAccount.set(window.account_id, list);
    }
  }
  for (const row of rows) {
    row.usage_windows = windowsByAccount.get(row.id) ?? [];
    row.platform_bindings = listAccountPlatformBindings(row.id);
    row.has_password = Boolean(row.has_password);
    row.status_code = row.status_code ?? row.status;
    row.status_label = row.status_label ?? row.status;
    row.credential_type = row.auth_credential_type ?? row.credential_type ?? "none";
  }
  return rows;
}

export function getAccount(id: number): AccountRow {
  const row = getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
  if (!row) {
    throw new Error(`账号不存在: ${id}`);
  }
  return row;
}

export function getActiveAuthFile(accountId: number): AuthFileRow {
  const row = getDb().prepare(`
        SELECT * FROM auth_files
        WHERE account_id = ? AND active = 1
        ORDER BY id DESC
        LIMIT 1
    `).get(accountId) as AuthFileRow | undefined;
  if (row) {
    return row;
  }
  // 没有 active 记录时，尝试激活最新的一条
  const latest = getDb().prepare(`
        SELECT * FROM auth_files
        WHERE account_id = ?
        ORDER BY COALESCE(credential_synced_at, updated_at, created_at) DESC, id DESC
        LIMIT 1
    `).get(accountId) as AuthFileRow | undefined;
  if (!latest) {
    throw new Error(`账号缺少 auth 文件: ${accountId}，请重新导入 auth 或从平台同步凭据`);
  }
  const timestamp = currentTimestamp();
  getDb().prepare("UPDATE auth_files SET active = 0 WHERE account_id = ?").run(accountId);
  getDb().prepare("UPDATE auth_files SET active = 1, updated_at = ? WHERE id = ?").run(timestamp, latest.id);
  return {...latest, active: 1};
}

export async function setAccountPassword(accountId: number, password: string): Promise<void> {
  const encrypted = await encryptSecret(password);
  getDb().prepare(`
        UPDATE accounts
        SET password_encrypted = ?, updated_at = ?
        WHERE id = ?
    `).run(encrypted || null, currentTimestamp(), accountId);
}

export async function updateAccountProfile(accountId: number, input: {password?: string; sourceId?: number | null}): Promise<AccountRow> {
  getAccount(accountId);
  if (input.sourceId != null) {
    const source = getDb().prepare("SELECT id FROM mail_sources WHERE id = ?").get(input.sourceId);
    if (!source) {
      throw new Error(`邮箱来源不存在: ${input.sourceId}`);
    }
  }
  const encrypted = input.password === undefined ? undefined : await encryptSecret(input.password);
  getDb().prepare(`
        UPDATE accounts
        SET password_encrypted = CASE
                WHEN @password_provided = 1 THEN @password_encrypted
                ELSE password_encrypted
            END,
            source_id = CASE
                WHEN @source_provided = 1 THEN @source_id
                ELSE source_id
            END,
            mailbox_id = CASE
                WHEN @source_provided = 1 THEN NULL
                ELSE mailbox_id
            END,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
    id: accountId,
    password_provided: input.password === undefined ? 0 : 1,
    password_encrypted: encrypted || null,
    source_provided: Object.hasOwn(input, "sourceId") ? 1 : 0,
    source_id: input.sourceId ?? null,
    updated_at: currentTimestamp(),
  });
  return getAccount(accountId);
}

export function updateAuthFileStep(accountId: number, step: string, status: "running" | "success" | "failed" = "running"): void {
  getDb().prepare(`
        UPDATE auth_files
        SET current_step = @current_step,
            step_status = @step_status,
            last_step_at = @last_step_at,
            updated_at = @updated_at
        WHERE account_id = @account_id AND active = 1
    `).run({
    account_id: accountId,
    current_step: step,
    step_status: status,
    last_step_at: currentTimestamp(),
    updated_at: currentTimestamp(),
  });
}

export async function getAccountPassword(account: AccountRow): Promise<string> {
  if (account.password_encrypted) {
    return decryptSecret(account.password_encrypted);
  }
  throw new Error("账号未保存密码，请先在账号管理中为该账号添加密码");
}

function updateAccountFromSummary(accountId: number, summary: AuthSummary): void {
  getDb().prepare(`
        UPDATE accounts
        SET status = @status,
            status_code = @status_code,
            status_label = @status_label,
            credential_type = @credential_type,
            plan = @plan,
            remaining_percent = @remaining_percent,
            used_percent = @used_percent,
            reset_at = @reset_at,
            last_check_at = @last_check_at,
            last_refresh_at = CASE WHEN @refreshed = 1 THEN @last_check_at ELSE last_refresh_at END,
            last_error = @last_error,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
    id: accountId,
    status: summary.ok ? "ok" : summary.status,
    status_code: summary.statusCode,
    status_label: summary.statusLabel,
    credential_type: summary.credentialType,
    plan: summary.plan === "-" ? null : summary.plan,
    remaining_percent: summary.remainingPercent,
    used_percent: summary.usedPercent,
    reset_at: summary.resetAt,
    last_check_at: currentTimestamp(),
    refreshed: summary.refreshed ? 1 : 0,
    last_error: summary.ok ? null : summary.note,
    updated_at: currentTimestamp(),
  });
  const timestamp = currentTimestamp();
  for (const window of summary.windows) {
    getDb().prepare(`
            INSERT INTO account_usage_windows (
                account_id, window_key, label, used_percent, remaining_percent, reset_at, limit_reached, updated_at
            )
            VALUES (
                @account_id, @window_key, @label, @used_percent, @remaining_percent, @reset_at, @limit_reached, @updated_at
            )
            ON CONFLICT(account_id, window_key) DO UPDATE SET
                label = excluded.label,
                used_percent = excluded.used_percent,
                remaining_percent = excluded.remaining_percent,
                reset_at = excluded.reset_at,
                limit_reached = excluded.limit_reached,
                updated_at = excluded.updated_at
        `).run({
      account_id: accountId,
      window_key: window.window_key,
      label: window.label,
      used_percent: window.used_percent,
      remaining_percent: window.remaining_percent,
      reset_at: window.reset_at,
      limit_reached: window.limit_reached == null ? null : (window.limit_reached ? 1 : 0),
      updated_at: timestamp,
    });
  }
  updateAuthFileStep(accountId, summary.ok ? "检查完成" : summary.statusLabel, summary.ok ? "success" : "failed");
}

export async function checkAccount(accountId: number, forceRefresh = false): Promise<AuthSummary> {
  const authFile = getActiveAuthFile(accountId);
  const contentJson = authFile.content_json ?? getAuthFileContent(authFile.id);
  if (!contentJson) {
    throw new Error(`账号凭据内容为空: ${accountId}`);
  }
  updateAuthFileStep(accountId, forceRefresh ? "refresh token 刷新中" : "usage 检查中", "running");
  const summary = await summarizeAuthFile(authFile.id, contentJson, forceRefresh);
  updateAccountFromSummary(accountId, summary);
  maybeTriggerAutoReauth(accountId, summary);
  return summary;
}

const REAUTH_ELIGIBLE_STATUS_CODES = new Set(["credential_expired", "credential_invalid"]);
const reauthTriggerInFlight = new Set<number>();

function maybeTriggerAutoReauth(accountId: number, summary: AuthSummary): void {
  if (!REAUTH_ELIGIBLE_STATUS_CODES.has(summary.statusCode)) {
    return;
  }
  if (reauthTriggerInFlight.has(accountId)) {
    return;
  }
  const row = getDb().prepare(`
    SELECT a.auto_reauth, a.password_encrypted, a.needs_manual_reauth, a.email
    FROM accounts a
    WHERE a.id = ?
  `).get(accountId) as {auto_reauth: number; password_encrypted: string | null; needs_manual_reauth: number; email: string} | undefined;
  if (!row) {
    return;
  }
  if (row.auto_reauth !== 1) {
    return;
  }
  if (!row.password_encrypted) {
    return;
  }
  if (row.needs_manual_reauth === 1) {
    return;
  }
  reauthTriggerInFlight.add(accountId);
  const job = createJob("reauth", `自动重登 ${row.email}`, {id: accountId, mode: "auto", trigger: "auto"});
  void (async () => {
    try {
      const {reauthorizeAccount} = await import("./registration-service.js");
      await runJob(job.id, async () => {
        const result = await reauthorizeAccount(accountId, job.id, {mode: "auto"});
        try {
          await pushAccountToBoundPlatforms(accountId);
          return {...result, boundPlatformPush: "success"};
        } catch (error) {
          return {...result, boundPlatformPush: "failed", pushError: error instanceof Error ? error.message : String(error)};
        }
      }, {exclusiveRegister: true});
    } finally {
      reauthTriggerInFlight.delete(accountId);
    }
  })();
}

export type PushTarget = "cpa" | "sub2api" | "both";

function assertPushTargetConfigured(target: PushTarget): void {
  if (target === "cpa" || target === "both") {
    if (!String(appConfig.cliproxyApiBaseUrl ?? "").trim() || !String(appConfig.cliproxyApiManagementKey ?? "").trim()) {
      throw new Error("CPA 未配置，请先在配置页填写 CPA Base URL 和管理密钥");
    }
  }
  if (target === "sub2api" || target === "both") {
    if (!String(appConfig.sub2apiBaseUrl ?? "").trim() || !String(appConfig.sub2apiAdminApiKey ?? "").trim()) {
      throw new Error("Sub2API 未配置，请先在配置页填写 Sub2API Base URL 和 Admin Key");
    }
  }
}

function resolveBindServiceId(kind: "cpa" | "sub2api", serviceId: number | undefined, baseUrl: string): number | null {
  if (serviceId) {
    return serviceId;
  }
  const normalizedUrl = baseUrl.replace(/\/+$/, "").toLowerCase();
  const row = getDb().prepare(`
    SELECT id FROM integration_services
    WHERE kind = ? AND enabled = 1
    ORDER BY priority ASC, id ASC
  `).all(kind) as Array<{id: number; base_url: string}>;
  for (const r of row) {
    if (r.base_url.replace(/\/+$/, "").toLowerCase() === normalizedUrl) {
      return r.id;
    }
  }
  return null;
}

export function readAccountAuthFile(accountId: number): {fileName: string; content: Buffer} {
  const authFile = getActiveAuthFile(accountId);
  const contentJson = authFile.content_json ?? getAuthFileContent(authFile.id);
  if (!contentJson) {
    throw new Error(`账号凭据内容为空: ${accountId}`);
  }
  return {
    fileName: authFile.file_name,
    content: Buffer.from(contentJson, "utf8"),
  };
}

export interface DeleteAccountOptions {
    deleteFromServiceIds?: number[];
}

export interface DeleteAccountResult {
    deleted: boolean;
    email: string;
    platformErrors: Array<{serviceId: number; serviceName: string; kind: string; message: string}>;
    platformDeleted: Array<{serviceId: number; serviceName: string; kind: string}>;
}

async function deletePlatformRecordsForAccount(
  accountId: number,
  serviceIds: number[],
): Promise<{deleted: DeleteAccountResult["platformDeleted"]; errors: DeleteAccountResult["platformErrors"]}> {
  const deleted: DeleteAccountResult["platformDeleted"] = [];
  const errors: DeleteAccountResult["platformErrors"] = [];
  if (!serviceIds.length) {
    return {deleted, errors};
  }
  const placeholders = serviceIds.map((_, index) => `@id${index}`).join(",");
  const params: Record<string, number> = {};
  serviceIds.forEach((value, index) => {
    params[`id${index}`] = value;
  });
  const rows = getDb().prepare(`
    SELECT af.credential_source_service_id AS serviceId,
           af.credential_source_remote_id AS remoteId,
           af.file_name AS fileName,
           s.kind AS kind,
           s.name AS serviceName
    FROM auth_files af
    JOIN integration_services s ON s.id = af.credential_source_service_id
    WHERE af.account_id = @accountId
      AND af.credential_source_service_id IN (${placeholders})
  `).all({...params, accountId}) as Array<{serviceId: number; remoteId: string | null; fileName: string; kind: string; serviceName: string}>;
  const requested = new Set(serviceIds);
  const handledServices = new Set<number>();
  for (const row of rows) {
    handledServices.add(row.serviceId);
    try {
      const services = await resolvePushServices(row.kind as "cpa" | "sub2api", [row.serviceId]);
      const service = services[0];
      if (!service) {
        throw new Error("平台服务不存在或已禁用");
      }
      if (row.kind === "cpa") {
        await deleteAuthFileFromCPAService({baseUrl: service.baseUrl, managementKey: service.secret}, row.fileName);
      } else if (row.kind === "sub2api") {
        const remote = (row.remoteId ?? "").trim();
        if (!remote) {
          throw new Error("Sub2API 缺少 remoteId，无法精准删除");
        }
        await deleteAccountFromSub2APIService({baseUrl: service.baseUrl, adminApiKey: service.secret, options: service.options}, remote);
      } else {
        throw new Error(`未支持的平台类型: ${row.kind}`);
      }
      deleted.push({serviceId: row.serviceId, serviceName: row.serviceName, kind: row.kind});
    } catch (error) {
      errors.push({
        serviceId: row.serviceId,
        serviceName: row.serviceName,
        kind: row.kind,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  for (const id of requested) {
    if (handledServices.has(id)) {
      continue;
    }
    const service = getDb().prepare("SELECT kind, name FROM integration_services WHERE id = ?").get(id) as {kind: string; name: string} | undefined;
    errors.push({
      serviceId: id,
      serviceName: service?.name ?? String(id),
      kind: service?.kind ?? "",
      message: "本地未记录该平台上的远端 ID，无法删除",
    });
  }
  return {deleted, errors};
}

export async function deleteAccount(accountId: number, options: DeleteAccountOptions = {}): Promise<DeleteAccountResult> {
  const account = getAccount(accountId);
  const serviceIds = [...new Set((options.deleteFromServiceIds ?? []).map(Number).filter((v) => Number.isFinite(v) && v > 0))];
  const {deleted, errors} = await deletePlatformRecordsForAccount(accountId, serviceIds);
  getDb().prepare("DELETE FROM accounts WHERE id = ?").run(accountId);
  return {
    deleted: true,
    email: account.email,
    platformDeleted: deleted,
    platformErrors: errors,
  };
}

export async function bulkDeleteAccounts(
  ids: number[],
  options: DeleteAccountOptions = {},
): Promise<{total: number; deleted: number; failures: Array<{id: number; message: string}>; perAccount: Array<{id: number; email: string; platformErrors: DeleteAccountResult["platformErrors"]; platformDeleted: DeleteAccountResult["platformDeleted"]}>}> {
  const uniqueIds = [...new Set(ids.map(Number).filter((v) => Number.isFinite(v) && v > 0))];
  const failures: Array<{id: number; message: string}> = [];
  const perAccount: Array<{id: number; email: string; platformErrors: DeleteAccountResult["platformErrors"]; platformDeleted: DeleteAccountResult["platformDeleted"]}> = [];
  let deleted = 0;
  for (const id of uniqueIds) {
    try {
      const result = await deleteAccount(id, options);
      deleted += 1;
      perAccount.push({id, email: result.email, platformErrors: result.platformErrors, platformDeleted: result.platformDeleted});
    } catch (error) {
      failures.push({id, message: error instanceof Error ? error.message : String(error)});
    }
  }
  return {total: uniqueIds.length, deleted, failures, perAccount};
}

export function exportAccountsAuthZip(accountIds: number[]): {fileName: string; content: Buffer; count: number} {
  const ids = [...new Set(accountIds.map(Number).filter(Number.isFinite))];
  if (!ids.length) {
    throw new Error("请先选择需要导出的账号");
  }

  const entries: ZipEntry[] = [];
  const usedNames = new Set<string>();
  for (const id of ids) {
    const auth = readAccountAuthFile(id);
    let fileName = auth.fileName;
    let suffix = 2;
    while (usedNames.has(fileName)) {
      fileName = auth.fileName.replace(/\.json$/i, `-${suffix}.json`);
      suffix += 1;
    }
    usedNames.add(fileName);
    entries.push({
      name: fileName,
      content: auth.content,
    });
  }

  const date = new Date().toISOString().slice(0, 10);
  return {
    fileName: `codex-auth-${date}-${entries.length}.zip`,
    content: buildZip(entries),
    count: entries.length,
  };
}

export async function pushAccount(accountId: number, target: PushTarget, serviceIds?: number[]): Promise<Record<string, unknown>> {
  const authFile = getActiveAuthFile(accountId);
  const contentJson = authFile.content_json ?? getAuthFileContent(authFile.id);
  if (!contentJson) {
    throw new Error(`账号凭据内容为空: ${accountId}`);
  }
  const record = JSON.parse(contentJson) as SavedAuthRecord;
  const fileName = authFile.file_name;
  const result: Record<string, unknown> = {};
  const timestamp = currentTimestamp();
  const effectiveServiceIds = serviceIds && serviceIds.length ? serviceIds : undefined;

  if (target === "cpa" || target === "both") {
    const services = await resolvePushServices("cpa", effectiveServiceIds);
    if (!services.length) {
      assertPushTargetConfigured("cpa");
    }
    updateAuthFileStep(accountId, "推送 CPA 中", "running");
    const serviceResults = [];
    for (const service of services) {
      try {
        await saveAuthFileJsonObjectToCPAService({
          baseUrl: service.baseUrl,
          managementKey: service.secret,
        }, fileName, record as unknown as Record<string, unknown>);
        const boundId = resolveBindServiceId("cpa", service.id, service.baseUrl);
        if (boundId) {
          ensureAccountPlatformBinding(accountId, boundId);
          updateBindingPushResult(accountId, boundId, "success", "CPA 推送成功");
        }
        serviceResults.push({id: service.id, name: service.name, fallback: service.fallback, status: "success"});
      } catch (error) {
        const boundId = resolveBindServiceId("cpa", service.id, service.baseUrl);
        if (boundId) {
          updateBindingPushResult(accountId, boundId, "failed", error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    }
    getDb().prepare(`
            UPDATE auth_files
            SET last_cpa_push_at = ?, last_cpa_status = 'success', updated_at = ?
            WHERE id = ?
        `).run(timestamp, timestamp, authFile.id);
    result.cpa = serviceResults.length ? serviceResults : "success";
  }

  if (target === "sub2api" || target === "both") {
    const services = await resolvePushServices("sub2api", effectiveServiceIds);
    if (!services.length) {
      assertPushTargetConfigured("sub2api");
    }
    updateAuthFileStep(accountId, "推送 Sub2API 中", "running");
    const serviceResults = [];
    for (const service of services) {
      try {
        const uploadResult = await uploadAuthFileToSub2APIService({
          baseUrl: service.baseUrl,
          adminApiKey: service.secret,
          options: service.options,
        }, fileName, record);
        const boundId = resolveBindServiceId("sub2api", service.id, service.baseUrl);
        if (boundId) {
          ensureAccountPlatformBinding(accountId, boundId);
          updateBindingPushResult(accountId, boundId, "success", "Sub2API 推送成功");
        }
        serviceResults.push({id: service.id, name: service.name, fallback: service.fallback, ...uploadResult});
      } catch (error) {
        const boundId = resolveBindServiceId("sub2api", service.id, service.baseUrl);
        if (boundId) {
          updateBindingPushResult(accountId, boundId, "failed", error instanceof Error ? error.message : String(error));
        }
        throw error;
      }
    }
    getDb().prepare(`
            UPDATE auth_files
            SET last_sub2api_push_at = ?, last_sub2api_status = 'success', updated_at = ?
            WHERE id = ?
        `).run(timestamp, timestamp, authFile.id);
    result.sub2api = serviceResults;
  }
  updateAuthFileStep(accountId, "推送完成", "success");

  return result;
}

export async function pushAccountToBoundPlatforms(accountId: number): Promise<Record<string, unknown>> {
  const services = listAccountPlatformBindings(accountId).filter((service) => service.enabled);
  if (!services.length) {
    updateAuthFileStep(accountId, "无绑定平台，跳过自动同步", "success");
    return {skipped: true, reason: "no_bound_platforms"};
  }
  const result: Record<string, unknown> = {};
  const cpaIds = services.filter((service) => service.kind === "cpa").map((service) => service.id);
  const sub2apiIds = services.filter((service) => service.kind === "sub2api").map((service) => service.id);
  if (cpaIds.length) {
    result.cpa = await pushAccount(accountId, "cpa", cpaIds);
  }
  if (sub2apiIds.length) {
    result.sub2api = await pushAccount(accountId, "sub2api", sub2apiIds);
  }
  return result;
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) {
    return [];
  }

  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workers = Array.from({length: Math.min(concurrency, items.length)}, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export function resolveDefaultConcurrency(total: number): number {
  const cpuCount = Math.max(1, cpus().length || 1);
  return Math.min(Math.max(4, cpuCount), total);
}

export function dashboardStats(): Record<string, unknown> {
  const rows = listAccounts();
  const total = rows.length;
  const ok = rows.filter((row) => row.status === "ok").length;
  const limited = rows.filter((row) => row.status_code === "quota_exhausted" || (typeof row.remaining_percent === "number" && row.remaining_percent <= 5)).length;
  const invalid = rows.filter((row) => row.status_code === "credential_expired" || row.status_code === "account_abnormal").length;
  const remaining = rows.reduce((sum, row) => sum + (typeof row.remaining_percent === "number" ? row.remaining_percent / 100 : 0), 0);
  const planGroups = ["free", "plus", "pro", "team"].map((plan) => {
    const planRows = rows.filter((row) => normalizePlanGroup(row.plan) === plan);
    const usageRows = planRows.filter((row) => typeof row.used_percent === "number" || typeof row.remaining_percent === "number");
    const averageUsed = usageRows.length
      ? usageRows.reduce((sum, row) => sum + (typeof row.used_percent === "number" ? row.used_percent : Math.max(0, 100 - (row.remaining_percent ?? 100))), 0) / usageRows.length
      : null;
    const averageRemaining = usageRows.length
      ? usageRows.reduce((sum, row) => sum + (typeof row.remaining_percent === "number" ? row.remaining_percent : Math.max(0, 100 - (row.used_percent ?? 0))), 0) / usageRows.length
      : null;
    return {
      plan,
      count: planRows.length,
      limited: planRows.filter((row) => row.status_code === "quota_exhausted" || (typeof row.remaining_percent === "number" && row.remaining_percent <= 5)).length,
      averageUsed: averageUsed == null ? null : Number(averageUsed.toFixed(1)),
      averageRemaining: averageRemaining == null ? null : Number(averageRemaining.toFixed(1)),
    };
  });
  return {total, ok, limited, invalid, remaining: Number(remaining.toFixed(2)), planGroups};
}

function normalizePlanGroup(plan: string | null | undefined): "free" | "plus" | "pro" | "team" {
  const normalized = String(plan ?? "").trim().toLowerCase();
  if (normalized.includes("team")) {
    return "team";
  }
  if (normalized.includes("pro")) {
    return "pro";
  }
  if (normalized.includes("plus")) {
    return "plus";
  }
  return "free";
}
