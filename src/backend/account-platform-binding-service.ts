import {getDb, currentTimestamp, type IntegrationServiceKind, type IntegrationServiceRow} from "./db.js";

export interface BoundPlatformService {
  id: number;
  kind: IntegrationServiceKind;
  name: string;
  priority: number;
  enabled: boolean;
  lastPushAt: string | null;
  lastPushStatus: string | null;
  lastPushMessage: string | null;
}

export type BindingMode = "replace" | "append" | "clear";

function normalizeIds(ids: unknown): number[] {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter(Number.isFinite))];
}

function assertAccount(accountId: number): void {
  const row = getDb().prepare("SELECT id FROM accounts WHERE id = ?").get(accountId);
  if (!row) {
    throw new Error(`账号不存在: ${accountId}`);
  }
}

function loadServices(serviceIds: number[]): IntegrationServiceRow[] {
  if (!serviceIds.length) {
    return [];
  }
  const placeholders = serviceIds.map(() => "?").join(",");
  const rows = getDb().prepare(`
    SELECT * FROM integration_services
    WHERE id IN (${placeholders})
    ORDER BY priority ASC, id ASC
  `).all(...serviceIds) as IntegrationServiceRow[];
  if (rows.length !== serviceIds.length) {
    throw new Error("部分平台服务不存在");
  }
  return rows;
}

function applyBindingChanges(accountId: number, serviceIds: number[], mode: BindingMode, timestamp: string): void {
  if (mode === "replace" || mode === "clear") {
    getDb().prepare("DELETE FROM account_platform_bindings WHERE account_id = ?").run(accountId);
  }
  if (mode === "clear") {
    return;
  }
  const statement = getDb().prepare(`
    INSERT INTO account_platform_bindings (
      account_id, integration_service_id, created_at, updated_at
    )
    VALUES (?, ?, ?, ?)
    ON CONFLICT(account_id, integration_service_id) DO UPDATE SET
      updated_at = excluded.updated_at
  `);
  for (const serviceId of serviceIds) {
    statement.run(accountId, serviceId, timestamp, timestamp);
  }
}

export function listAccountPlatformBindings(accountId: number): BoundPlatformService[] {
  assertAccount(accountId);
  return getDb().prepare(`
    SELECT
      s.id,
      s.kind,
      s.name,
      s.priority,
      s.enabled,
      b.last_push_at AS lastPushAt,
      b.last_push_status AS lastPushStatus,
      b.last_push_message AS lastPushMessage
    FROM account_platform_bindings b
    JOIN integration_services s ON s.id = b.integration_service_id
    WHERE b.account_id = ?
    ORDER BY s.priority ASC, s.id ASC
  `).all(accountId).map((row) => ({
    ...(row as Omit<BoundPlatformService, "enabled"> & {enabled: number}),
    enabled: Boolean((row as {enabled: number}).enabled),
  })) as BoundPlatformService[];
}

export function setAccountPlatformBindings(accountId: number, serviceIdsInput: unknown, mode: BindingMode = "replace"): BoundPlatformService[] {
  assertAccount(accountId);
  const serviceIds = normalizeIds(serviceIdsInput);
  loadServices(serviceIds);
  const timestamp = currentTimestamp();
  const transaction = getDb().transaction(() => {
    applyBindingChanges(accountId, serviceIds, mode, timestamp);
  });
  transaction();
  return listAccountPlatformBindings(accountId);
}

export function ensureAccountPlatformBinding(accountId: number, serviceId: number): void {
  assertAccount(accountId);
  loadServices([serviceId]);
  applyBindingChanges(accountId, [serviceId], "append", currentTimestamp());
}

export function bulkSetAccountPlatformBindings(
  accountIdsInput: unknown,
  serviceIdsInput: unknown,
  mode: BindingMode = "replace",
): {updated: number} {
  const accountIds = normalizeIds(accountIdsInput);
  const serviceIds = normalizeIds(serviceIdsInput);
  loadServices(serviceIds);
  for (const accountId of accountIds) {
    assertAccount(accountId);
  }
  const timestamp = currentTimestamp();
  const transaction = getDb().transaction(() => {
    for (const accountId of accountIds) {
      applyBindingChanges(accountId, serviceIds, mode, timestamp);
    }
  });
  transaction();
  return {updated: accountIds.length};
}

export function listBoundPushServiceIds(accountId: number): number[] {
  return listAccountPlatformBindings(accountId)
    .filter((service) => service.enabled)
    .map((service) => service.id);
}

export function updateBindingPushResult(
  accountId: number,
  serviceId: number,
  status: "success" | "failed",
  message: string,
): void {
  getDb().prepare(`
    UPDATE account_platform_bindings
    SET last_push_at = @last_push_at,
        last_push_status = @last_push_status,
        last_push_message = @last_push_message,
        updated_at = @updated_at
    WHERE account_id = @account_id AND integration_service_id = @integration_service_id
  `).run({
    account_id: accountId,
    integration_service_id: serviceId,
    last_push_at: currentTimestamp(),
    last_push_status: status,
    last_push_message: message.slice(0, 500),
    updated_at: currentTimestamp(),
  });
}
