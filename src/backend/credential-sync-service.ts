import type {SavedAuthRecord} from "../core/openai.js";
import {getDb, currentTimestamp, type IntegrationServiceKind} from "./db.js";
import {resolvePushServices} from "./integration-service.js";
import {fetchCredentialsFromPlatform, type PlatformCredential, type PlatformCredentialFailure, type PlatformServiceConfig} from "./platform-adapters.js";
import {checkAccount, decodeJwtClaims, mapWithConcurrency, resolveDefaultConcurrency, upsertAccountFromAuthRecord, upsertAuthFile} from "./auth-service.js";
import {addJobEvent} from "./job-service.js";
import {ensureAccountPlatformBinding} from "./account-platform-binding-service.js";

export type CredentialSyncSource = "all" | IntegrationServiceKind;

export interface CredentialSyncOptions {
  source?: CredentialSyncSource;
  serviceIds?: number[];
  checkAfterSync?: boolean;
  jobId?: number;
}

export interface CredentialSyncServiceResult {
  id?: number;
  name: string;
  kind: IntegrationServiceKind;
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  error?: string;
  accountIds: number[];
}

export interface CredentialSyncResult {
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  checked: number;
  services: CredentialSyncServiceResult[];
}

function normalizeServiceIds(ids: number[] | undefined, kind: IntegrationServiceKind): number[] | undefined {
  if (!ids?.length) {
    return undefined;
  }
  const placeholders = ids.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT id FROM integration_services
    WHERE kind = ? AND id IN (${placeholders})
  `).all(kind, ...ids) as Array<{id: number}>;
  return rows.map((row) => row.id);
}

async function resolveSyncServices(source: CredentialSyncSource, serviceIds?: number[]): Promise<PlatformServiceConfig[]> {
  const kinds: IntegrationServiceKind[] = source === "all" ? ["cpa", "sub2api"] : [source];
  const requestedIds = serviceIds?.length ? [...new Set(serviceIds.map(Number).filter(Number.isFinite))] : undefined;
  const matchedIds = new Set<number>();
  const services: PlatformServiceConfig[] = [];
  for (const kind of kinds) {
    const ids = normalizeServiceIds(requestedIds, kind);
    if (ids && !ids.length) {
      continue;
    }
    ids?.forEach((id) => matchedIds.add(id));
    const resolved = await resolvePushServices(kind, ids);
    services.push(...resolved.map((service) => ({
      id: service.id,
      kind: service.kind,
      name: service.name,
      baseUrl: service.baseUrl,
      secret: service.secret,
      options: service.options,
      priority: service.priority,
      fallback: service.fallback,
    })));
  }
  if (requestedIds && matchedIds.size !== requestedIds.length) {
    throw new Error("部分平台服务不存在或与同步来源不匹配");
  }
  return services.sort((left, right) => (left.priority - right.priority) || ((left.id ?? 999999) - (right.id ?? 999999)));
}

function writeSyncEvent(input: {
  accountId?: number;
  serviceId?: number;
  sourceKind: IntegrationServiceKind;
  action: string;
  status: "success" | "failed" | "skipped";
  message?: string;
}): void {
  getDb().prepare(`
    INSERT INTO credential_sync_events (
      account_id, integration_service_id, source_kind, action, status, message, created_at
    )
    VALUES (@account_id, @integration_service_id, @source_kind, @action, @status, @message, @created_at)
  `).run({
    account_id: input.accountId ?? null,
    integration_service_id: input.serviceId ?? null,
    source_kind: input.sourceKind,
    action: input.action,
    status: input.status,
    message: input.message ?? null,
    created_at: currentTimestamp(),
  });
}

function recordCredentialFailure(service: PlatformServiceConfig, failure: PlatformCredentialFailure): void {
  writeSyncEvent({
    serviceId: service.id,
    sourceKind: service.kind,
    action: "fetch",
    status: "failed",
    message: `${failure.remoteId}: ${failure.error}`,
  });
}

function resolveRecordEmail(record: SavedAuthRecord): string {
  const claims = decodeJwtClaims(record.id_token ?? record.access_token);
  return String(record.email ?? claims?.email ?? "").trim();
}

function ensureRecordHasEmail(record: SavedAuthRecord): boolean {
  return Boolean(resolveRecordEmail(record));
}

function findExistingAccountId(record: SavedAuthRecord): number | undefined {
  const email = resolveRecordEmail(record);
  if (!email) {
    return undefined;
  }
  const row = getDb().prepare("SELECT id FROM accounts WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))").get(email) as {id: number} | undefined;
  return row?.id;
}

function findExistingPlatformAuth(credential: PlatformCredential): {accountId: number; authFileId: number; filePath: string} | undefined {
  if (!credential.service.id) {
    return undefined;
  }
  return getDb().prepare(`
    SELECT account_id AS accountId, id AS authFileId, file_path AS filePath
    FROM auth_files
    WHERE credential_source_service_id = ?
      AND credential_source_remote_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(credential.service.id, credential.remoteId) as {accountId: number; authFileId: number; filePath: string} | undefined;
}

function getAccountEmail(accountId: number): string | undefined {
  const row = getDb().prepare("SELECT email FROM accounts WHERE id = ?").get(accountId) as {email: string} | undefined;
  return row?.email;
}

function buildPlatformFilePath(credential: PlatformCredential): string {
  const serviceId = credential.service.id ? String(credential.service.id) : `${credential.service.kind}-fallback`;
  return `platforms/${serviceId}/${credential.fileName}`;
}

async function importCredential(credential: PlatformCredential): Promise<{accountId?: number; action: "imported" | "updated" | "skipped"}> {
  if (!ensureRecordHasEmail(credential.record)) {
    return {action: "skipped"};
  }
  const existingPlatformAuth = findExistingPlatformAuth(credential);
  const existingAccountId = findExistingAccountId(credential.record);
  const targetAccountId = existingAccountId ?? existingPlatformAuth?.accountId;
  const filePath = existingPlatformAuth?.filePath ?? buildPlatformFilePath(credential);
  const contentJson = JSON.stringify(credential.record, null, 2);
  if (targetAccountId) {
    const localEmail = getAccountEmail(targetAccountId);
    const record = localEmail ? {...credential.record, email: localEmail} : credential.record;
    const finalContentJson = localEmail ? JSON.stringify(record, null, 2) : contentJson;
    upsertAuthFile(targetAccountId, filePath, record, {
      sourceKind: credential.service.kind,
      sourceName: credential.service.name,
      sourceServiceId: credential.service.id ?? null,
      sourceRemoteId: credential.remoteId,
      syncedAt: currentTimestamp(),
      activate: false,
      contentJson: finalContentJson,
    });
    if (credential.service.id) {
      ensureAccountPlatformBinding(targetAccountId, credential.service.id);
    }
    resolveActivePlatformCredential(targetAccountId);
    return {accountId: targetAccountId, action: "updated"};
  }
  const account = await upsertAccountFromAuthRecord(credential.record, filePath, {
    sourceKind: credential.service.kind,
    sourceName: credential.service.name,
    sourceServiceId: credential.service.id ?? null,
    sourceRemoteId: credential.remoteId,
    syncedAt: currentTimestamp(),
    preserveAccountMetadata: true,
    activate: false,
    contentJson,
  });
  if (credential.service.id) {
    ensureAccountPlatformBinding(account.id, credential.service.id);
  }
  resolveActivePlatformCredential(account.id);
  return {accountId: account.id, action: "imported"};
}

export function resolveActivePlatformCredential(accountId: number): void {
  const active = getDb().prepare(`
    SELECT
      af.id,
      af.credential_source_kind,
      af.credential_source_name,
      af.credential_source_service_id,
      af.credential_source_remote_id,
      af.credential_synced_at
    FROM auth_files af
    WHERE af.account_id = ?
    ORDER BY
      COALESCE(af.credential_synced_at, af.updated_at, af.created_at) DESC,
      af.id DESC
    LIMIT 1
  `).get(accountId) as {
    id: number;
    credential_source_kind: string | null;
    credential_source_name: string | null;
    credential_source_service_id: number | null;
    credential_source_remote_id: string | null;
    credential_synced_at: string | null;
  } | undefined;
  if (!active) {
    return;
  }
  const timestamp = currentTimestamp();
  getDb().prepare("UPDATE auth_files SET active = CASE WHEN id = ? THEN 1 ELSE 0 END, updated_at = ? WHERE account_id = ?")
    .run(active.id, timestamp, accountId);
  getDb().prepare(`
    UPDATE accounts
    SET credential_source_kind = @credential_source_kind,
        credential_source_name = @credential_source_name,
        credential_source_service_id = @credential_source_service_id,
        credential_source_remote_id = @credential_source_remote_id,
        credential_synced_at = @credential_synced_at,
        updated_at = @updated_at
    WHERE id = @id
  `).run({
    id: accountId,
    credential_source_kind: active.credential_source_kind,
    credential_source_name: active.credential_source_name,
    credential_source_service_id: active.credential_source_service_id,
    credential_source_remote_id: active.credential_source_remote_id,
    credential_synced_at: active.credential_synced_at,
    updated_at: timestamp,
  });
}

async function syncOneService(service: PlatformServiceConfig, options: CredentialSyncOptions): Promise<CredentialSyncServiceResult> {
  const summary: CredentialSyncServiceResult = {
    id: service.id,
    name: service.name,
    kind: service.kind,
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    accountIds: [],
  };
  try {
    const {credentials, failures} = await fetchCredentialsFromPlatform(service);
    summary.failed += failures.length;
    for (const failure of failures) {
      recordCredentialFailure(service, failure);
    }
    if (options.jobId) {
      addJobEvent(options.jobId, failures.length ? "warn" : "info", `${service.name} 拉取到 ${credentials.length} 条凭据，失败 ${failures.length} 条`);
    }
    for (const credential of credentials) {
      try {
        const result = await importCredential(credential);
        if (result.action === "imported") {
          summary.imported += 1;
        } else if (result.action === "updated") {
          summary.updated += 1;
        } else {
          summary.skipped += 1;
        }
        writeSyncEvent({
          accountId: result.accountId,
          serviceId: service.id,
          sourceKind: service.kind,
          action: result.action,
          status: result.action === "skipped" ? "skipped" : "success",
          message: credential.remoteId,
        });
        if (result.accountId) {
          summary.accountIds.push(result.accountId);
        }
      } catch (error) {
        summary.failed += 1;
        writeSyncEvent({
          serviceId: service.id,
          sourceKind: service.kind,
          action: "import",
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch (error) {
    summary.failed += 1;
    summary.error = error instanceof Error ? error.message : String(error);
    writeSyncEvent({
      serviceId: service.id,
      sourceKind: service.kind,
      action: "fetch",
      status: "failed",
      message: summary.error,
    });
  }
  return summary;
}

async function checkSyncedAccounts(accountIds: number[], jobId?: number): Promise<number> {
  const uniqueIds = [...new Set(accountIds)].filter(Number.isFinite);
  if (!uniqueIds.length) {
    return 0;
  }
  if (jobId) {
    addJobEvent(jobId, "info", `平台凭据已导入，开始批量检查 ${uniqueIds.length} 个账号`);
  }
  const outcomes = await mapWithConcurrency(uniqueIds, resolveDefaultConcurrency(uniqueIds.length), async (accountId) => {
    try {
      await checkAccount(accountId, false);
      return true;
    } catch (error) {
      const account = getDb().prepare("SELECT credential_source_kind FROM accounts WHERE id = ?").get(accountId) as {credential_source_kind: string | null} | undefined;
      const sourceKind: IntegrationServiceKind = account?.credential_source_kind === "cpa" ? "cpa" : "sub2api";
      writeSyncEvent({
        accountId,
        sourceKind,
        action: "check",
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  });
  return outcomes.filter(Boolean).length;
}

export async function syncPlatformCredentials(options: CredentialSyncOptions = {}): Promise<CredentialSyncResult> {
  const source = options.source ?? "all";
  const services = await resolveSyncServices(source, options.serviceIds);
  const result: CredentialSyncResult = {
    imported: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    checked: 0,
    services: [],
  };
  for (const service of services) {
    const serviceResult = await syncOneService(service, options);
    result.services.push(serviceResult);
    result.imported += serviceResult.imported;
    result.updated += serviceResult.updated;
    result.skipped += serviceResult.skipped;
    result.failed += serviceResult.failed;
  }
  const accountIds = result.services.flatMap((service) => service.accountIds);
  result.checked = options.checkAfterSync ? await checkSyncedAccounts(accountIds, options.jobId) : 0;
  return result;
}
