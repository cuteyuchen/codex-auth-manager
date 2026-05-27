import {appConfig} from "../core/config.js";
import type {SavedAuthRecord} from "../core/openai.js";
import {getDb, currentTimestamp, type IntegrationServiceKind, type IntegrationServiceRow} from "./db.js";
import {decryptSecret, encryptSecret} from "./crypto.js";

export interface IntegrationServiceInput {
  kind?: IntegrationServiceKind;
  name?: string;
  baseUrl?: string;
  secret?: string;
  enabled?: boolean;
  priority?: number;
  includeProxyUrl?: boolean;
  options?: Record<string, unknown>;
}

export interface IntegrationServiceItem {
  id: number;
  kind: IntegrationServiceKind;
  name: string;
  baseUrl: string;
  secret: {hasValue: boolean; tail: string};
  enabled: boolean;
  priority: number;
  includeProxyUrl: boolean;
  options: Record<string, unknown>;
  lastTestAt: string | null;
  lastTestStatus: string | null;
  lastTestMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PushServiceConfig {
  id?: number;
  kind: IntegrationServiceKind;
  name: string;
  baseUrl: string;
  secret: string;
  includeProxyUrl: boolean;
  options: Record<string, unknown>;
  priority: number;
  fallback: boolean;
}

interface CLIProxyAPIConfig {
  baseUrl: string;
  managementKey: string;
}

interface Sub2APIConfig {
  baseUrl: string;
  adminApiKey: string;
  options: Record<string, unknown>;
}

interface Sub2APIImportResult {
  total?: number;
  created?: number;
  updated?: number;
  skipped?: number;
  failed?: number;
  items?: Array<{
    action?: string;
    account_id?: number | string;
    id?: number | string;
    name?: string;
    message?: string;
  }>;
  errors?: Array<{message?: string}>;
}

export interface Sub2APIUploadResult {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  accountIds: number[];
}

function normalizeKind(value: unknown): IntegrationServiceKind {
  if (value === "cpa" || value === "sub2api") {
    return value;
  }
  throw new Error("服务类型必须是 cpa 或 sub2api");
}

function normalizeBaseUrl(value: unknown): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function tail(value: string): string {
  return value ? value.slice(-4) : "";
}

function maskSecret(value: string): {hasValue: boolean; tail: string} {
  return {
    hasValue: Boolean(value),
    tail: tail(value),
  };
}

function parseOptions(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function rowToItem(row: IntegrationServiceRow): Promise<IntegrationServiceItem> {
  const secret = await decryptSecret(row.secret_encrypted);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.base_url,
    secret: maskSecret(secret),
    enabled: Boolean(row.enabled),
    priority: row.priority,
    includeProxyUrl: Boolean(row.include_proxy_url),
    options: parseOptions(row.options_json),
    lastTestAt: row.last_test_at,
    lastTestStatus: row.last_test_status,
    lastTestMessage: row.last_test_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function rowToPushConfig(row: IntegrationServiceRow): Promise<PushServiceConfig> {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    baseUrl: row.base_url,
    secret: await decryptSecret(row.secret_encrypted),
    includeProxyUrl: Boolean(row.include_proxy_url),
    options: parseOptions(row.options_json),
    priority: row.priority,
    fallback: false,
  };
}

function ensureService(id: number): IntegrationServiceRow {
  const row = getDb().prepare("SELECT * FROM integration_services WHERE id = ?").get(id) as IntegrationServiceRow | undefined;
  if (!row) {
    throw new Error(`服务不存在: ${id}`);
  }
  return row;
}

export async function listIntegrationServices(kind?: string): Promise<IntegrationServiceItem[]> {
  const kindFilter = String(kind ?? "").trim();
  const rows = kindFilter
    ? getDb().prepare(`
        SELECT * FROM integration_services
        WHERE kind = ?
        ORDER BY enabled DESC, priority ASC, id ASC
      `).all(normalizeKind(kindFilter)) as IntegrationServiceRow[]
    : getDb().prepare(`
        SELECT * FROM integration_services
        ORDER BY kind ASC, enabled DESC, priority ASC, id ASC
      `).all() as IntegrationServiceRow[];
  return Promise.all(rows.map(rowToItem));
}

export async function createIntegrationService(input: IntegrationServiceInput): Promise<IntegrationServiceItem> {
  const kind = normalizeKind(input.kind);
  const name = String(input.name ?? "").trim();
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const secret = String(input.secret ?? "").trim();
  if (!name) {
    throw new Error("服务名称不能为空");
  }
  if (!baseUrl) {
    throw new Error("Base URL 不能为空");
  }
  if (!secret) {
    throw new Error(kind === "cpa" ? "CPA 管理密钥不能为空" : "Sub2API Admin Key 不能为空");
  }
  const timestamp = currentTimestamp();
  const result = getDb().prepare(`
    INSERT INTO integration_services (
      kind, name, base_url, secret_encrypted, enabled, priority, include_proxy_url,
      options_json, created_at, updated_at
    )
    VALUES (
      @kind, @name, @base_url, @secret_encrypted, @enabled, @priority, @include_proxy_url,
      @options_json, @created_at, @updated_at
    )
  `).run({
    kind,
    name,
    base_url: baseUrl,
    secret_encrypted: await encryptSecret(secret),
    enabled: input.enabled === false ? 0 : 1,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : 0,
    include_proxy_url: kind === "cpa" && input.includeProxyUrl ? 1 : 0,
    options_json: JSON.stringify(input.options ?? {}),
    created_at: timestamp,
    updated_at: timestamp,
  });
  return rowToItem(ensureService(Number(result.lastInsertRowid)));
}

export async function updateIntegrationService(id: number, input: IntegrationServiceInput): Promise<IntegrationServiceItem> {
  const current = ensureService(id);
  const kind = input.kind ? normalizeKind(input.kind) : current.kind;
  const name = input.name === undefined ? current.name : String(input.name).trim();
  const baseUrl = input.baseUrl === undefined ? current.base_url : normalizeBaseUrl(input.baseUrl);
  if (!name) {
    throw new Error("服务名称不能为空");
  }
  if (!baseUrl) {
    throw new Error("Base URL 不能为空");
  }
  const secret = String(input.secret ?? "").trim();
  getDb().prepare(`
    UPDATE integration_services
    SET kind = @kind,
        name = @name,
        base_url = @base_url,
        secret_encrypted = @secret_encrypted,
        enabled = @enabled,
        priority = @priority,
        include_proxy_url = @include_proxy_url,
        options_json = @options_json,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    kind,
    name,
    base_url: baseUrl,
    secret_encrypted: secret ? await encryptSecret(secret) : current.secret_encrypted,
    enabled: typeof input.enabled === "boolean" ? (input.enabled ? 1 : 0) : current.enabled,
    priority: Number.isFinite(Number(input.priority)) ? Number(input.priority) : current.priority,
    include_proxy_url: kind === "cpa" && typeof input.includeProxyUrl === "boolean" ? (input.includeProxyUrl ? 1 : 0) : current.include_proxy_url,
    options_json: input.options === undefined ? current.options_json : JSON.stringify(input.options),
    updated_at: currentTimestamp(),
  });
  return rowToItem(ensureService(id));
}

export function deleteIntegrationService(id: number): {ok: true} {
  ensureService(id);
  getDb().prepare("DELETE FROM integration_services WHERE id = ?").run(id);
  return {ok: true};
}

function updateTestResult(id: number, success: boolean, message: string): void {
  getDb().prepare(`
    UPDATE integration_services
    SET last_test_at = @last_test_at,
        last_test_status = @last_test_status,
        last_test_message = @last_test_message,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id,
    last_test_at: currentTimestamp(),
    last_test_status: success ? "success" : "failed",
    last_test_message: message.slice(0, 500),
    updated_at: currentTimestamp(),
  });
}

export async function testIntegrationService(id: number): Promise<{success: boolean; message: string}> {
  const config = await rowToPushConfig(ensureService(id));
  let result: {success: boolean; message: string};
  try {
    if (config.kind === "cpa") {
      result = await testCPAConnection({baseUrl: config.baseUrl, managementKey: config.secret});
    } else {
      result = await testSub2APIConnection({baseUrl: config.baseUrl, adminApiKey: config.secret, options: config.options});
    }
  } catch (error) {
    result = {success: false, message: error instanceof Error ? error.message : String(error)};
  }
  updateTestResult(id, result.success, result.message);
  return result;
}

export async function resolvePushServices(kind: IntegrationServiceKind, ids?: number[]): Promise<PushServiceConfig[]> {
  const normalizedIds = [...new Set((ids ?? []).map(Number).filter(Number.isFinite))];
  let rows: IntegrationServiceRow[];
  if (normalizedIds.length) {
    const placeholders = normalizedIds.map(() => "?").join(",");
    rows = getDb().prepare(`
      SELECT * FROM integration_services
      WHERE kind = ? AND id IN (${placeholders})
      ORDER BY priority ASC, id ASC
    `).all(kind, ...normalizedIds) as IntegrationServiceRow[];
    if (rows.length !== normalizedIds.length) {
      throw new Error(`${kind === "cpa" ? "CPA" : "Sub2API"} 推送服务不存在或类型不匹配`);
    }
    return Promise.all(rows.map(rowToPushConfig));
  }

  rows = getDb().prepare(`
    SELECT * FROM integration_services
    WHERE kind = ? AND enabled = 1
    ORDER BY priority ASC, id ASC
  `).all(kind) as IntegrationServiceRow[];
  if (rows.length) {
    return Promise.all(rows.map(rowToPushConfig));
  }

  if (kind === "cpa") {
    const baseUrl = normalizeBaseUrl(appConfig.cliproxyApiBaseUrl);
    const secret = String(appConfig.cliproxyApiManagementKey ?? "").trim();
    return baseUrl && secret
      ? [{kind, name: "全局 CPA 配置", baseUrl, secret, includeProxyUrl: false, options: {}, priority: 9999, fallback: true}]
      : [];
  }

  const baseUrl = normalizeBaseUrl(appConfig.sub2apiBaseUrl);
  const secret = String(appConfig.sub2apiAdminApiKey ?? "").trim();
  return baseUrl && secret
    ? [{
      kind,
      name: "全局 Sub2API 配置",
      baseUrl,
      secret,
      includeProxyUrl: false,
      options: buildSub2APIFallbackOptions(),
      priority: 9999,
      fallback: true,
    }]
    : [];
}

function createManagementHeaders(config: CLIProxyAPIConfig, extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${config.managementKey}`,
    Accept: "application/json",
    ...extraHeaders,
  };
}

export async function saveAuthFileJsonObjectToCPAService(
  config: CLIProxyAPIConfig,
  fileName: string,
  record: Record<string, unknown>,
): Promise<void> {
  if (!fileName.toLowerCase().endsWith(".json")) {
    throw new Error(`上传到 CPA 的 auth 文件名必须是 .json: ${fileName}`);
  }
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/v0/management/auth-files`);
  url.searchParams.set("name", fileName);
  const response = await fetch(url, {
    method: "POST",
    headers: createManagementHeaders(config, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify(record, null, 2),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`CPA 上传 auth 失败: ${response.status} body=${rawBody}`);
  }
}

export async function deleteAuthFileFromCPAService(
  config: CLIProxyAPIConfig,
  fileName: string,
): Promise<void> {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v0/management/auth-files`, {
    method: "DELETE",
    headers: createManagementHeaders(config, {
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({names: [fileName]}),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`CPA 删除 auth 失败: ${response.status} body=${rawBody}`);
  }
}

async function testCPAConnection(config: CLIProxyAPIConfig): Promise<{success: boolean; message: string}> {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/v0/management/auth-files`, {
    method: "GET",
    headers: createManagementHeaders(config),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    return {success: false, message: `CPA 连接失败: HTTP ${response.status} ${rawBody.slice(0, 200)}`};
  }
  return {success: true, message: "CPA 连接正常"};
}

function buildSub2APIFallbackOptions(): Record<string, unknown> {
  const options: Record<string, unknown> = {
    update_existing: appConfig.sub2apiUpdateExisting,
    skip_default_group_bind: appConfig.sub2apiSkipDefaultGroupBind,
    confirm_mixed_channel_risk: appConfig.sub2apiConfirmMixedChannelRisk,
  };
  if (appConfig.sub2apiGroupIds.length) {
    options.group_ids = appConfig.sub2apiGroupIds;
  }
  for (const [key, value] of Object.entries({
    proxy_id: appConfig.sub2apiProxyId,
    concurrency: appConfig.sub2apiConcurrency,
    priority: appConfig.sub2apiPriority,
    rate_multiplier: appConfig.sub2apiRateMultiplier,
    load_factor: appConfig.sub2apiLoadFactor,
    auto_pause_on_expired: appConfig.sub2apiAutoPauseOnExpired,
  })) {
    if (value !== null && value !== undefined) {
      options[key] = value;
    }
  }
  return options;
}

function buildCodexSessionImportPayload(
  fileName: string,
  record: SavedAuthRecord,
  options: Record<string, unknown>,
): Record<string, unknown> {
  return {
    content: JSON.stringify(record, null, 2),
    update_existing: options.update_existing ?? true,
    skip_default_group_bind: options.skip_default_group_bind ?? false,
    confirm_mixed_channel_risk: options.confirm_mixed_channel_risk ?? false,
    ...Object.fromEntries(Object.entries(options).filter(([key]) => ![
      "update_existing",
      "skip_default_group_bind",
      "confirm_mixed_channel_risk",
    ].includes(key))),
    extra: {
      import_source: "codex-auth-manager",
      auth_file: fileName,
    },
  };
}

function parseStandardResponse(rawBody: string): Sub2APIImportResult {
  const payload = JSON.parse(rawBody) as {
    code?: number;
    message?: string;
    data?: Sub2APIImportResult;
  };
  if (typeof payload?.code === "number" && payload.code !== 0) {
    throw new Error(`Sub2API 返回错误: code=${payload.code} message=${payload.message ?? ""}`);
  }
  return payload?.data ?? (payload as Sub2APIImportResult);
}

function summarizeImportErrors(result: Sub2APIImportResult): string {
  const messages = [
    ...(result.errors ?? []).map((item) => item.message),
    ...(result.items ?? [])
      .filter((item) => item.action === "failed")
      .map((item) => item.message),
  ]
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
  return messages.length ? ` errors=${messages.join("; ")}` : "";
}

function normalizeSub2APIAccountId(value: unknown): number | null {
  const id = Number(value);
  return Number.isFinite(id) && id > 0 ? id : null;
}

function collectSub2APIAccountIds(result: Sub2APIImportResult): number[] {
  const ids = new Set<number>();
  for (const item of result.items ?? []) {
    if (item.action === "failed" || item.action === "skipped") {
      continue;
    }
    const id = normalizeSub2APIAccountId(item.account_id ?? item.id);
    if (id) {
      ids.add(id);
    }
  }
  return [...ids];
}

export async function uploadAuthFileToSub2APIService(
  config: Sub2APIConfig,
  fileName: string,
  record: SavedAuthRecord,
): Promise<Sub2APIUploadResult> {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/v1/admin/accounts/import/codex-session`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": config.adminApiKey,
    },
    body: JSON.stringify(buildCodexSessionImportPayload(fileName, record, config.options)),
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`Sub2API 上传 auth 失败: ${response.status} body=${rawBody}`);
  }
  const result = parseStandardResponse(rawBody);
  const uploadResult = {
    created: Number(result.created ?? 0),
    updated: Number(result.updated ?? 0),
    skipped: Number(result.skipped ?? 0),
    failed: Number(result.failed ?? 0),
    accountIds: collectSub2APIAccountIds(result),
  };
  if (uploadResult.failed > 0) {
    throw new Error(`Sub2API 导入失败: failed=${uploadResult.failed}${summarizeImportErrors(result)}`);
  }
  return uploadResult;
}

export async function recoverSub2APIAccountStateService(
  config: Sub2APIConfig,
  remoteId: number | string,
): Promise<void> {
  const id = String(remoteId).trim();
  if (!id) {
    throw new Error("Sub2API 恢复账号状态缺少 remoteId");
  }
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/v1/admin/accounts/${encodeURIComponent(id)}/recover-state`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "x-api-key": config.adminApiKey,
    },
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`Sub2API 恢复账号状态失败: ${response.status} body=${rawBody.slice(0, 200)}`);
  }
}

export async function deleteAccountFromSub2APIService(
  config: Sub2APIConfig,
  remoteId: string,
): Promise<void> {
  if (!remoteId) {
    throw new Error("Sub2API 删除缺少 remoteId");
  }
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/v1/admin/accounts/${encodeURIComponent(remoteId)}`, {
    method: "DELETE",
    headers: {
      Accept: "application/json",
      "x-api-key": config.adminApiKey,
    },
  });
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`Sub2API 删除账号失败: ${response.status} body=${rawBody.slice(0, 200)}`);
  }
}

async function testSub2APIConnection(config: Sub2APIConfig): Promise<{success: boolean; message: string}> {
  const response = await fetch(`${normalizeBaseUrl(config.baseUrl)}/api/v1/admin/accounts/import/codex-session`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": config.adminApiKey,
    },
    body: JSON.stringify({
      content: "{}",
      dry_run: true,
      extra: {import_source: "codex-auth-manager-test"},
    }),
  });
  const rawBody = await response.text();
  if (response.status === 401 || response.status === 403) {
    return {success: false, message: `Sub2API 鉴权失败: HTTP ${response.status}`};
  }
  if (response.status === 404) {
    return {success: false, message: "Sub2API 接口不存在，请检查 Base URL"};
  }
  if (!response.ok && response.status >= 500) {
    return {success: false, message: `Sub2API 服务错误: HTTP ${response.status} ${rawBody.slice(0, 200)}`};
  }
  return {success: true, message: response.ok ? "Sub2API 连接正常" : `Sub2API 可访问，返回 HTTP ${response.status}`};
}
