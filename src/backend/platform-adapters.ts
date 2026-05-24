import {Buffer} from "node:buffer";
import type {SavedAuthRecord} from "../core/openai.js";
import type {IntegrationServiceKind} from "./db.js";

export interface PlatformServiceConfig {
  id?: number;
  kind: IntegrationServiceKind;
  name: string;
  baseUrl: string;
  secret: string;
  options: Record<string, unknown>;
  priority: number;
  fallback: boolean;
}

export interface PlatformCredential {
  service: PlatformServiceConfig;
  remoteId: string;
  fileName: string;
  record: SavedAuthRecord;
}

export interface PlatformCredentialFailure {
  service: PlatformServiceConfig;
  remoteId: string;
  fileName?: string;
  error: string;
}

export interface PlatformCredentialPullResult {
  credentials: PlatformCredential[];
  failures: PlatformCredentialFailure[];
}

interface CLIProxyAuthFileItem {
  name?: string;
  disabled?: boolean;
  [key: string]: unknown;
}

interface Sub2APIAccountItem {
  id?: string | number;
  name?: string;
  email?: string;
  credentials?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  [key: string]: unknown;
}

function normalizeBaseUrl(value: string): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function createCPAHeaders(service: PlatformServiceConfig, extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    Authorization: `Bearer ${service.secret}`,
    Accept: "application/json",
    ...extraHeaders,
  };
}

function createSub2APIHeaders(service: PlatformServiceConfig, extraHeaders: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": service.secret,
    Accept: "application/json",
    ...extraHeaders,
  };
}

function parseJsonObject(rawBody: string, context: string): Record<string, unknown> {
  const payload = JSON.parse(rawBody) as unknown;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${context} 不是合法 JSON 对象`);
  }
  return payload as Record<string, unknown>;
}

function buildFileName(value: unknown, fallback: string): string {
  const raw = String(value ?? "").trim() || fallback;
  const safe = raw.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  return safe.toLowerCase().endsWith(".json") ? safe : `${safe}.json`;
}

function normalizeAuthRecord(payload: Record<string, unknown>, fallbackEmail?: string): SavedAuthRecord | null {
  const record = {...payload} as unknown as SavedAuthRecord;
  if (fallbackEmail && !record.email) {
    record.email = fallbackEmail;
  }
  if (!record.access_token && !record.refresh_token && !record.id_token) {
    return null;
  }
  return record;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function extractEmailFromJwt(token: unknown): string {
  const rawToken = stringValue(token);
  const payload = rawToken.split(".")[1];
  if (!payload) {
    return "";
  }
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const claims = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as {email?: unknown};
    const email = stringValue(claims.email);
    return isLikelyEmail(email) ? email : "";
  } catch {
    return "";
  }
}

function firstEmail(...values: unknown[]): string | undefined {
  for (const value of values) {
    const email = stringValue(value);
    if (isLikelyEmail(email)) {
      return email;
    }
  }
  return undefined;
}

async function fetchText(url: string, init: RequestInit, context: string): Promise<string> {
  const response = await fetch(url, init);
  const rawBody = await response.text();
  if (!response.ok) {
    throw new Error(`${context}: HTTP ${response.status} ${rawBody.slice(0, 300)}`);
  }
  return rawBody;
}

export async function fetchCredentialsFromCPA(service: PlatformServiceConfig): Promise<PlatformCredentialPullResult> {
  const baseUrl = normalizeBaseUrl(service.baseUrl);
  const rawList = await fetchText(`${baseUrl}/v0/management/auth-files`, {
    method: "GET",
    headers: createCPAHeaders(service),
  }, `${service.name} 获取 CPA auth 列表失败`);
  const payload = parseJsonObject(rawList, `${service.name} CPA auth 列表`);
  const files = Array.isArray(payload.files) ? payload.files as CLIProxyAuthFileItem[] : [];
  const credentials: PlatformCredential[] = [];
  const failures: PlatformCredentialFailure[] = [];
  for (const item of files) {
    const name = String(item.name ?? "").trim();
    if (!name || item.disabled) {
      continue;
    }
    try {
      const url = new URL(`${baseUrl}/v0/management/auth-files/download`);
      url.searchParams.set("name", name);
      const rawAuth = await fetchText(url.toString(), {
        method: "GET",
        headers: createCPAHeaders(service),
      }, `${service.name} 下载 CPA auth 失败: ${name}`);
      const record = normalizeAuthRecord(parseJsonObject(rawAuth, `${service.name} CPA auth 文件 ${name}`));
      if (!record) {
        failures.push({
          service,
          remoteId: name,
          fileName: name,
          error: "auth 文件缺少 access_token/refresh_token/id_token",
        });
        continue;
      }
      credentials.push({
        service,
        remoteId: name,
        fileName: buildFileName(name, "cpa-auth"),
        record,
      });
    } catch (error) {
      failures.push({
        service,
        remoteId: name,
        fileName: name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {credentials, failures};
}

function extractSub2APIAccounts(payload: Record<string, unknown>): Sub2APIAccountItem[] {
  const data = payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
    ? payload.data as Record<string, unknown>
    : payload;
  const container = data.data && typeof data.data === "object" && !Array.isArray(data.data)
    ? data.data as Record<string, unknown>
    : data;
  const accounts = container.accounts;
  return Array.isArray(accounts) ? accounts as Sub2APIAccountItem[] : [];
}

function normalizeSub2APIRecord(item: Sub2APIAccountItem): SavedAuthRecord | null {
  const credentials = item.credentials && typeof item.credentials === "object" && !Array.isArray(item.credentials)
    ? item.credentials
    : item;
  const expiresAt = credentials.expires_at ?? item.expires_at;
  const email = firstEmail(
    credentials.email,
    extractEmailFromJwt(credentials.id_token),
    extractEmailFromJwt(credentials.access_token),
    item.email,
    item.name,
  );
  const record = normalizeAuthRecord({
    access_token: credentials.access_token,
    refresh_token: credentials.refresh_token,
    id_token: credentials.id_token,
    account_id: credentials.chatgpt_account_id ?? credentials.account_id ?? item.account_id,
    email,
    expired: typeof expiresAt === "number" ? new Date(expiresAt * 1000).toISOString() : expiresAt,
    type: credentials.type ?? "codex",
  } as Record<string, unknown>, email);
  return record;
}

export async function fetchCredentialsFromSub2API(service: PlatformServiceConfig): Promise<PlatformCredentialPullResult> {
  const rawBody = await fetchText(`${normalizeBaseUrl(service.baseUrl)}/api/v1/admin/accounts/data`, {
    method: "GET",
    headers: createSub2APIHeaders(service),
  }, `${service.name} 获取 Sub2API 账号数据失败`);
  const accounts = extractSub2APIAccounts(parseJsonObject(rawBody, `${service.name} Sub2API 账号数据`));
  if (!accounts.length) {
    throw new Error(`${service.name} Sub2API 未返回 sub2api-data accounts[]`);
  }
  const failures: PlatformCredentialFailure[] = [];
  const credentials = accounts
    .map((item, index) => {
      const record = normalizeSub2APIRecord(item);
      const remoteId = String(item.id ?? item.name ?? item.email ?? index).trim();
      if (!record) {
        failures.push({
          service,
          remoteId,
          fileName: remoteId,
          error: "账号数据缺少 access_token/refresh_token/id_token",
        });
        return null;
      }
      return {
        service,
        remoteId,
        fileName: buildFileName(record.email ?? remoteId, "sub2api-auth"),
        record,
      } satisfies PlatformCredential;
    })
    .filter((item): item is PlatformCredential => Boolean(item));
  return {credentials, failures};
}

export async function fetchCredentialsFromPlatform(service: PlatformServiceConfig): Promise<PlatformCredentialPullResult> {
  if (service.kind === "cpa") {
    return fetchCredentialsFromCPA(service);
  }
  return fetchCredentialsFromSub2API(service);
}
