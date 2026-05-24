import {appConfig} from "./config.js";
import type {SavedAuthRecord} from "./openai.js";

interface Sub2APIImportItem {
    index?: number;
    name?: string;
    action?: string;
    account_id?: number;
    message?: string;
}

interface Sub2APIImportResult {
    total?: number;
    created?: number;
    updated?: number;
    skipped?: number;
    failed?: number;
    items?: Sub2APIImportItem[];
    errors?: Array<{message?: string; name?: string; index?: number}>;
}

export interface Sub2APIUploadResult {
    created: number;
    updated: number;
    skipped: number;
    failed: number;
}

function normalizeBaseUrl(value: string): string {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

function getSub2APIConfig(): {baseUrl: string; adminApiKey: string} {
  const baseUrl = normalizeBaseUrl(appConfig.sub2apiBaseUrl);
  const adminApiKey = String(appConfig.sub2apiAdminApiKey ?? "").trim();
  if (!baseUrl) {
    throw new Error("sub2apiBaseUrl 未配置");
  }
  if (!adminApiKey) {
    throw new Error("sub2apiAdminApiKey 未配置");
  }
  return {baseUrl, adminApiKey};
}

function buildImportUrl(baseUrl: string): string {
  return `${baseUrl}/api/v1/admin/accounts/import/codex-session`;
}

function setOptionalNumber(
  payload: Record<string, unknown>,
  key: string,
  value: number | null,
): void {
  if (typeof value === "number" && Number.isFinite(value)) {
    payload[key] = value;
  }
}

function setOptionalBoolean(
  payload: Record<string, unknown>,
  key: string,
  value: boolean | null,
): void {
  if (typeof value === "boolean") {
    payload[key] = value;
  }
}

function buildCodexSessionImportPayload(
  fileName: string,
  record: SavedAuthRecord,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    content: JSON.stringify(record, null, 2),
    update_existing: appConfig.sub2apiUpdateExisting,
    skip_default_group_bind: appConfig.sub2apiSkipDefaultGroupBind,
    confirm_mixed_channel_risk: appConfig.sub2apiConfirmMixedChannelRisk,
    extra: {
      import_source: "codex-auth-manager",
      auth_file: fileName,
    },
  };

  if (appConfig.sub2apiGroupIds.length > 0) {
    payload.group_ids = appConfig.sub2apiGroupIds;
  }
  setOptionalNumber(payload, "proxy_id", appConfig.sub2apiProxyId);
  setOptionalNumber(payload, "concurrency", appConfig.sub2apiConcurrency);
  setOptionalNumber(payload, "priority", appConfig.sub2apiPriority);
  setOptionalNumber(payload, "rate_multiplier", appConfig.sub2apiRateMultiplier);
  setOptionalNumber(payload, "load_factor", appConfig.sub2apiLoadFactor);
  setOptionalBoolean(payload, "auto_pause_on_expired", appConfig.sub2apiAutoPauseOnExpired);

  return payload;
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

export function shouldAutoUploadAuthToSub2API(): boolean {
  return appConfig.sub2apiAutoUploadAuth;
}

export async function uploadAuthFileToSub2API(
  fileName: string,
  record: SavedAuthRecord,
): Promise<Sub2APIUploadResult> {
  const {baseUrl, adminApiKey} = getSub2APIConfig();
  const response = await fetch(buildImportUrl(baseUrl), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": adminApiKey,
    },
    body: JSON.stringify(buildCodexSessionImportPayload(fileName, record)),
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
  };

  if (uploadResult.failed > 0) {
    throw new Error(`Sub2API 导入失败: failed=${uploadResult.failed}${summarizeImportErrors(result)}`);
  }

  return uploadResult;
}
