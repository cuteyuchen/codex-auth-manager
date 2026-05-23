import {getDb, currentTimestamp} from "../backend/db.js";
import {decryptSecretSync, encryptSecretSync} from "../backend/crypto.js";

export type MailProviderName = "2925" | "gmail" | "proxiedmail" | "cloudflare" | "hotmail" | "gptmail";
export type HotmailMode = "graph" | "xiongmaodian";

interface AppConfigInput {
  provider?: unknown;
  defaultPassword?: unknown;
  loopDelayMs?: unknown;
  gmailAccessToken?: unknown;
  gmailEmailAddress?: unknown;
  gptMailApiKey?: unknown;
  gptMailDomain?: unknown;
  "2925EmailAddress"?: unknown;
  "2925Password"?: unknown;
  cloudflareEmailDomain?: unknown;
  cloudflareApiBaseUrl?: unknown;
  cloudflareApiKey?: unknown;
  defaultProxyUrl?: unknown;
  hotmailMode?: unknown;
  heroSMSApiKey?: unknown;
  heroSMSCountry?: unknown;
  heroSMSMaxPrice?: unknown;
  heroSMSPollAttempts?: unknown;
  heroSMSPollIntervalMs?: unknown;
  cliproxyApiAutoUploadAuth?: unknown;
  cliproxyApiBaseUrl?: unknown;
  cliproxyApiManagementKey?: unknown;
  sub2apiAutoUploadAuth?: unknown;
  sub2apiBaseUrl?: unknown;
  sub2apiAdminApiKey?: unknown;
  sub2apiGroupIds?: unknown;
  sub2apiProxyId?: unknown;
  sub2apiConcurrency?: unknown;
  sub2apiPriority?: unknown;
  sub2apiRateMultiplier?: unknown;
  sub2apiLoadFactor?: unknown;
  sub2apiAutoPauseOnExpired?: unknown;
  sub2apiUpdateExisting?: unknown;
  sub2apiSkipDefaultGroupBind?: unknown;
  sub2apiConfirmMixedChannelRisk?: unknown;
}

export interface AppConfig {
  provider: MailProviderName;
  defaultPassword: string;
  loopDelayMs: number;
  gmailAccessToken: string;
  gmailEmailAddress: string;
  gptMailApiKey: string;
  gptMailDomain: string;
  ["2925EmailAddress"]: string;
  ["2925Password"]: string;
  cloudflareEmailDomain: string;
  cloudflareApiBaseUrl: string;
  cloudflareApiKey: string;
  defaultProxyUrl: string;
  hotmailMode: HotmailMode;
  heroSMSApiKey?: string;
  heroSMSCountry: number;
  heroSMSMaxPrice: number;
  heroSMSPollAttempts: number;
  heroSMSPollIntervalMs: number;
  cliproxyApiAutoUploadAuth: boolean;
  cliproxyApiBaseUrl: string;
  cliproxyApiManagementKey: string;
  sub2apiAutoUploadAuth: boolean;
  sub2apiBaseUrl: string;
  sub2apiAdminApiKey: string;
  sub2apiGroupIds: number[];
  sub2apiProxyId: number | null;
  sub2apiConcurrency: number | null;
  sub2apiPriority: number | null;
  sub2apiRateMultiplier: number | null;
  sub2apiLoadFactor: number | null;
  sub2apiAutoPauseOnExpired: boolean | null;
  sub2apiUpdateExisting: boolean;
  sub2apiSkipDefaultGroupBind: boolean;
  sub2apiConfirmMixedChannelRisk: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  provider: "proxiedmail",
  defaultPassword: "",
  loopDelayMs: 120000,
  gmailAccessToken: "",
  gmailEmailAddress: "",
  gptMailApiKey: "",
  gptMailDomain: "",
  "2925EmailAddress": "",
  "2925Password": "",
  cloudflareEmailDomain: "",
  cloudflareApiBaseUrl: "",
  cloudflareApiKey: "",
  defaultProxyUrl: "http://127.0.0.1:10808",
  hotmailMode: "graph",
  heroSMSApiKey: "",
  heroSMSCountry: 52,
  heroSMSMaxPrice: 0.05,
  heroSMSPollAttempts: 10,
  heroSMSPollIntervalMs: 3000,
  cliproxyApiAutoUploadAuth: false,
  cliproxyApiBaseUrl: "http://localhost:8317",
  cliproxyApiManagementKey: "",
  sub2apiAutoUploadAuth: false,
  sub2apiBaseUrl: "",
  sub2apiAdminApiKey: "",
  sub2apiGroupIds: [],
  sub2apiProxyId: null,
  sub2apiConcurrency: null,
  sub2apiPriority: null,
  sub2apiRateMultiplier: null,
  sub2apiLoadFactor: null,
  sub2apiAutoPauseOnExpired: null,
  sub2apiUpdateExisting: true,
  sub2apiSkipDefaultGroupBind: false,
  sub2apiConfirmMixedChannelRisk: false,
};

export const SECRET_CONFIG_KEYS = new Set<keyof AppConfig>([
  "defaultPassword",
  "gmailAccessToken",
  "gptMailApiKey",
  "2925Password",
  "cloudflareApiKey",
  "heroSMSApiKey",
  "cliproxyApiManagementKey",
  "sub2apiAdminApiKey",
]);

interface AppSettingRow {
  key: string;
  value_json: string;
  is_secret: number;
}

export function getConfigKeys(): Array<keyof AppConfig> {
  return Object.keys(DEFAULT_CONFIG) as Array<keyof AppConfig>;
}

export function isConfigKey(key: string): key is keyof AppConfig {
  return key in DEFAULT_CONFIG;
}

export function isSecretConfigKey(key: string): key is keyof AppConfig {
  return isConfigKey(key) && SECRET_CONFIG_KEYS.has(key);
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return value;
}

function normalizeOptionalNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function normalizeOptionalBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function normalizeNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => typeof item === "number" && Number.isFinite(item) ? item : null)
    .filter((item): item is number => item !== null);
}

function normalizeProvider(value: unknown): MailProviderName {
  if (value === "2925" || value === "gmail" || value === "proxiedmail" || value === "cloudflare" || value === "hotmail" || value === "gptmail") {
    return value;
  }
  return DEFAULT_CONFIG.provider;
}

function normalizeHotmailMode(value: unknown): HotmailMode {
  if (value === "graph" || value === "xiongmaodian") {
    return value;
  }
  return DEFAULT_CONFIG.hotmailMode;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "on"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "off"].includes(normalized)) {
      return false;
    }
  }
  return fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  return value.trim();
}

function normalizeConfig(parsed: AppConfigInput): AppConfig {
  return {
    provider: normalizeProvider(parsed.provider),
    defaultPassword: normalizeString(parsed.defaultPassword, DEFAULT_CONFIG.defaultPassword),
    loopDelayMs: normalizeNumber(parsed.loopDelayMs, DEFAULT_CONFIG.loopDelayMs),
    gmailAccessToken: normalizeString(parsed.gmailAccessToken, DEFAULT_CONFIG.gmailAccessToken),
    gmailEmailAddress: normalizeString(parsed.gmailEmailAddress, DEFAULT_CONFIG.gmailEmailAddress),
    gptMailApiKey: normalizeString(parsed.gptMailApiKey, DEFAULT_CONFIG.gptMailApiKey),
    gptMailDomain: normalizeString(parsed.gptMailDomain, DEFAULT_CONFIG.gptMailDomain),
    "2925EmailAddress": normalizeString(parsed["2925EmailAddress"], DEFAULT_CONFIG["2925EmailAddress"]),
    "2925Password": normalizeString(parsed["2925Password"], DEFAULT_CONFIG["2925Password"]),
    cloudflareEmailDomain: normalizeString(parsed.cloudflareEmailDomain, DEFAULT_CONFIG.cloudflareEmailDomain),
    cloudflareApiBaseUrl: normalizeString(parsed.cloudflareApiBaseUrl, DEFAULT_CONFIG.cloudflareApiBaseUrl),
    cloudflareApiKey: normalizeString(parsed.cloudflareApiKey, DEFAULT_CONFIG.cloudflareApiKey),
    defaultProxyUrl: normalizeString(parsed.defaultProxyUrl, DEFAULT_CONFIG.defaultProxyUrl),
    hotmailMode: normalizeHotmailMode(parsed.hotmailMode),
    heroSMSApiKey: normalizeString(parsed.heroSMSApiKey, DEFAULT_CONFIG.heroSMSApiKey ?? ""),
    heroSMSCountry: normalizeNumber(parsed.heroSMSCountry, DEFAULT_CONFIG.heroSMSCountry),
    heroSMSMaxPrice: normalizeNumber(parsed.heroSMSMaxPrice, DEFAULT_CONFIG.heroSMSMaxPrice),
    heroSMSPollAttempts: normalizeNumber(parsed.heroSMSPollAttempts, DEFAULT_CONFIG.heroSMSPollAttempts),
    heroSMSPollIntervalMs: normalizeNumber(parsed.heroSMSPollIntervalMs, DEFAULT_CONFIG.heroSMSPollIntervalMs),
    cliproxyApiAutoUploadAuth: normalizeBoolean(
      parsed.cliproxyApiAutoUploadAuth,
      DEFAULT_CONFIG.cliproxyApiAutoUploadAuth,
    ),
    cliproxyApiBaseUrl: normalizeString(parsed.cliproxyApiBaseUrl, DEFAULT_CONFIG.cliproxyApiBaseUrl),
    cliproxyApiManagementKey: normalizeString(
      parsed.cliproxyApiManagementKey,
      DEFAULT_CONFIG.cliproxyApiManagementKey,
    ),
    sub2apiAutoUploadAuth: normalizeBoolean(
      parsed.sub2apiAutoUploadAuth,
      DEFAULT_CONFIG.sub2apiAutoUploadAuth,
    ),
    sub2apiBaseUrl: normalizeString(parsed.sub2apiBaseUrl, DEFAULT_CONFIG.sub2apiBaseUrl),
    sub2apiAdminApiKey: normalizeString(parsed.sub2apiAdminApiKey, DEFAULT_CONFIG.sub2apiAdminApiKey),
    sub2apiGroupIds: normalizeNumberArray(parsed.sub2apiGroupIds),
    sub2apiProxyId: normalizeOptionalNumber(parsed.sub2apiProxyId),
    sub2apiConcurrency: normalizeOptionalNumber(parsed.sub2apiConcurrency),
    sub2apiPriority: normalizeOptionalNumber(parsed.sub2apiPriority),
    sub2apiRateMultiplier: normalizeOptionalNumber(parsed.sub2apiRateMultiplier),
    sub2apiLoadFactor: normalizeOptionalNumber(parsed.sub2apiLoadFactor),
    sub2apiAutoPauseOnExpired: normalizeOptionalBoolean(parsed.sub2apiAutoPauseOnExpired),
    sub2apiUpdateExisting: normalizeBoolean(
      parsed.sub2apiUpdateExisting,
      DEFAULT_CONFIG.sub2apiUpdateExisting,
    ),
    sub2apiSkipDefaultGroupBind: normalizeBoolean(
      parsed.sub2apiSkipDefaultGroupBind,
      DEFAULT_CONFIG.sub2apiSkipDefaultGroupBind,
    ),
    sub2apiConfirmMixedChannelRisk: normalizeBoolean(
      parsed.sub2apiConfirmMixedChannelRisk,
      DEFAULT_CONFIG.sub2apiConfirmMixedChannelRisk,
    ),
  };
}

function serializeSettingValue(key: keyof AppConfig, value: unknown): string {
  if (SECRET_CONFIG_KEYS.has(key)) {
    const text = typeof value === "string" ? value.trim() : "";
    return JSON.stringify(text ? encryptSecretSync(text) : "");
  }
  return JSON.stringify(value);
}

function deserializeSettingValue(row: AppSettingRow): unknown {
  const parsed = JSON.parse(row.value_json) as unknown;
  if (!row.is_secret) {
    return parsed;
  }
  if (typeof parsed !== "string" || !parsed) {
    return "";
  }
  return decryptSecretSync(parsed);
}

function saveSetting(key: keyof AppConfig, value: unknown): void {
  getDb().prepare(`
    INSERT INTO app_settings (key, value_json, is_secret, updated_at)
    VALUES (@key, @value_json, @is_secret, @updated_at)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      is_secret = excluded.is_secret,
      updated_at = excluded.updated_at
  `).run({
    key,
    value_json: serializeSettingValue(key, value),
    is_secret: SECRET_CONFIG_KEYS.has(key) ? 1 : 0,
    updated_at: currentTimestamp(),
  });
}

function seedDefaultSettings(): void {
  const statement = getDb().prepare("SELECT key FROM app_settings WHERE key = ?");
  for (const key of getConfigKeys()) {
    const existing = statement.get(key) as {key: string} | undefined;
    if (!existing) {
      saveSetting(key, DEFAULT_CONFIG[key]);
    }
  }
}

export function loadConfig(): AppConfig {
  seedDefaultSettings();
  const rows = getDb().prepare("SELECT key, value_json, is_secret FROM app_settings").all() as AppSettingRow[];
  const parsed: AppConfigInput = {};
  for (const row of rows) {
    if (!isConfigKey(row.key)) {
      continue;
    }
    parsed[row.key] = deserializeSettingValue(row);
  }
  return normalizeConfig(parsed);
}

export function updateConfigValues(patch: Record<string, unknown>): AppConfig {
  const update = getDb().transaction((entries: Array<[keyof AppConfig, unknown]>) => {
    for (const [key, value] of entries) {
      saveSetting(key, value);
    }
  });
  const entries = Object.entries(patch)
    .filter(([key]) => isConfigKey(key))
    .map(([key, value]) => [key as keyof AppConfig, value] as [keyof AppConfig, unknown]);
  update(entries);
  return reloadAppConfig();
}

export const appConfig: AppConfig = loadConfig();

export function reloadAppConfig(): AppConfig {
  const next = loadConfig();
  Object.assign(appConfig, next);
  return appConfig;
}
