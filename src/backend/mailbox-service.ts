import {create2925Provider} from "../core/mail/2925.js";
import {createCloudflareProvider} from "../core/mail/cloudflare.js";
import {createGmailProvider} from "../core/mail/gmail.js";
import {createGPTMailProvider} from "../core/mail/gptmail.js";
import {buildHotmailTokenAccount, createHotmailDatabaseProvider, createHotmailProvider} from "../core/mail/hotmail.js";
import {createProxiedMailProvider} from "../core/mail/proxiedmail.js";
import {normalizeMailbox} from "../core/mail/verification-matcher.js";
import type {MailProviderName, HotmailMode} from "../core/config.js";
import type {EmailCodeProvider, EmailVerificationCodeOptions, LatestEmail} from "../core/mailbox.js";
import {currentTimestamp, getDb, type MailboxRow, type MailSourceRow, type MailTypeRow} from "./db.js";
import {decryptSecret, encryptSecret} from "./crypto.js";

export type MailboxStatus = "unused" | "reserved" | "used" | "failed" | "disabled";

export interface MailTypeInput {
    key?: string;
    provider?: MailProviderName;
    name?: string;
    subtype?: HotmailMode | "";
    domain_hint?: string;
    supports_auto_code?: boolean;
    enabled?: boolean;
    sort_order?: number;
}

export interface MailSourceInput {
    name?: string;
    mail_type_id?: number;
    type_id?: number;
    provider?: MailProviderName;
    subtype?: HotmailMode | "";
    vendor?: string;
    batch_note?: string;
    enabled?: boolean;
    supports_auto_code?: boolean;
    config?: string;
}

export interface MailboxInput {
    source_id?: number;
    mail_type_id?: number;
    email?: string;
    password?: string;
    client_id?: string;
    refresh_token?: string;
    access_token?: string;
    status?: MailboxStatus;
    used?: boolean;
}

export interface MailboxImportInput {
    source_id?: number;
    mail_type_id?: number;
    provider?: MailProviderName;
    subtype?: HotmailMode | "";
    name?: string;
    vendor?: string;
    batch_note?: string;
    text?: string;
}

export interface MailboxListFilters {
    q?: string;
    sourceId?: number;
    typeId?: number;
    provider?: string;
    subtype?: string;
    status?: string;
    used?: string;
    autoCode?: string;
}

export interface MailSourceListFilters {
    q?: string;
    typeId?: number;
    provider?: string;
    subtype?: string;
    enabled?: string;
}

export interface MailTypeItem {
    id: number;
    key: string;
    provider: string;
    name: string;
    subtype: string | null;
    domain_hint: string | null;
    supports_auto_code: boolean;
    enabled: boolean;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

export interface MailSourceItem {
    id: number;
    name: string;
    provider: string;
    mail_type_id: number | null;
    mail_type_key: string | null;
    mail_type_name: string | null;
    subtype: string | null;
    vendor: string | null;
    batch_note: string | null;
    enabled: boolean;
    supports_auto_code: boolean;
    mailbox_count: number;
    unused_count: number;
    used_count: number;
    failed_count: number;
    has_config: boolean;
    created_at: string;
    updated_at: string;
}

export interface MailboxListItem {
    id: number;
    source_id: number;
    source_name: string;
    mail_type_id: number | null;
    mail_type_key: string | null;
    mail_type_name: string | null;
    subtype: string | null;
    email: string;
    provider: string;
    status: string;
    used: number;
    has_password: boolean;
    has_client_id: boolean;
    has_refresh_token: boolean;
    has_access_token: boolean;
    supports_auto_code: number;
    last_code_status: string | null;
    last_code_at: string | null;
    last_used_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
}

export interface MailboxLatestEmailResult {
    ok: boolean;
    email?: LatestEmail | null;
    error?: string;
}

let reservedMailboxId: number | null = null;

const PROVIDERS: MailProviderName[] = ["proxiedmail", "gmail", "gptmail", "hotmail", "2925", "cloudflare"];
const AUTO_CODE_PROVIDERS = new Set<MailProviderName>(PROVIDERS);

function normalizeProvider(value: unknown): MailProviderName {
  if (PROVIDERS.includes(value as MailProviderName)) {
    return value as MailProviderName;
  }
  return "hotmail";
}

function normalizeSubtype(value: unknown): HotmailMode | null {
  if (value === "graph" || value === "xiongmaodian") {
    return value;
  }
  return null;
}

function toEnabled(value: unknown, fallback = true): number {
  return typeof value === "boolean" ? (value ? 1 : 0) : (fallback ? 1 : 0);
}

function hasSecret(value: string | null | undefined): boolean {
  return Boolean(value && value.trim());
}

function tail(value: string): string {
  return value ? value.slice(-4) : "";
}

function providerTypeKey(provider: string, subtype?: string | null): string {
  if (provider === "hotmail") {
    return `hotmail_${subtype || "graph"}`;
  }
  return provider;
}

function ensureMailType(id: number): MailTypeRow {
  const row = getDb().prepare("SELECT * FROM mail_types WHERE id = ?").get(id) as MailTypeRow | undefined;
  if (!row) {
    throw new Error(`邮箱类型不存在: ${id}`);
  }
  return row;
}

function ensureMailTypeByProvider(provider: MailProviderName, subtype?: HotmailMode | null): MailTypeRow {
  const key = providerTypeKey(provider, subtype);
  const row = getDb().prepare("SELECT * FROM mail_types WHERE key = ?").get(key) as MailTypeRow | undefined;
  if (!row) {
    throw new Error(`邮箱类型不存在: ${key}`);
  }
  return row;
}

function resolveMailType(input: {mail_type_id?: number; type_id?: number; provider?: MailProviderName; subtype?: HotmailMode | ""}): MailTypeRow {
  const id = Number(input.mail_type_id ?? input.type_id ?? 0);
  if (id) {
    return ensureMailType(id);
  }
  return ensureMailTypeByProvider(normalizeProvider(input.provider), normalizeSubtype(input.subtype));
}

function ensureSource(id: number): MailSourceRow {
  const row = getDb().prepare("SELECT * FROM mail_sources WHERE id = ?").get(id) as MailSourceRow | undefined;
  if (!row) {
    throw new Error(`邮箱来源不存在: ${id}`);
  }
  return row;
}

function ensureMailbox(id: number): MailboxRow {
  const row = getDb().prepare("SELECT * FROM mailboxes WHERE id = ?").get(id) as MailboxRow | undefined;
  if (!row) {
    throw new Error(`邮箱不存在: ${id}`);
  }
  return row;
}

function createProvider(type: Pick<MailTypeRow, "provider" | "subtype">): EmailCodeProvider {
  switch (type.provider) {
    case "proxiedmail":
      return createProxiedMailProvider();
    case "gmail":
      return createGmailProvider();
    case "gptmail":
      return createGPTMailProvider();
    case "hotmail":
      return createHotmailProvider(normalizeSubtype(type.subtype) ?? "graph");
    case "2925":
      return create2925Provider();
    case "cloudflare":
      return createCloudflareProvider();
    default:
      throw new Error(`不支持的邮箱 provider: ${type.provider}`);
  }
}

async function createMailboxProvider(type: Pick<MailTypeRow, "provider" | "subtype">, mailbox: MailboxRow): Promise<EmailCodeProvider> {
  if (type.provider !== "hotmail" || normalizeSubtype(type.subtype) === "xiongmaodian") {
    return createProvider(type);
  }
  const password = mailbox.password_encrypted ? await decryptSecret(mailbox.password_encrypted) : "";
  const clientId = mailbox.client_id_encrypted ? await decryptSecret(mailbox.client_id_encrypted) : "";
  const refreshToken = mailbox.refresh_token_encrypted ? await decryptSecret(mailbox.refresh_token_encrypted) : "";
  const accessToken = mailbox.access_token_encrypted ? await decryptSecret(mailbox.access_token_encrypted) : "";
  if (!clientId || !refreshToken) {
    throw new Error("Hotmail/Outlook 自动取件需要在邮箱记录中保存 client_id 和 refresh_token");
  }
  const account = buildHotmailTokenAccount({
    email: mailbox.email,
    password,
    clientId,
    refreshToken,
    accessToken,
    scope: "",
    apiMode: "graph",
    fileName: `mailbox:${mailbox.id}`,
    filePath: "database",
    raw: {source: "database-mailbox", mailboxId: mailbox.id},
    persist: async (updatedAccount: {accessToken?: string; refreshToken?: string}) => {
      getDb().prepare(`
                UPDATE mailboxes
                SET access_token_encrypted = @access_token_encrypted,
                    refresh_token_encrypted = @refresh_token_encrypted,
                    updated_at = @updated_at
                WHERE id = @id
            `).run({
        id: mailbox.id,
        access_token_encrypted: updatedAccount.accessToken ? await encryptSecret(updatedAccount.accessToken) : mailbox.access_token_encrypted,
        refresh_token_encrypted: updatedAccount.refreshToken ? await encryptSecret(updatedAccount.refreshToken) : mailbox.refresh_token_encrypted,
        updated_at: currentTimestamp(),
      });
    },
  });
  if (!account) {
    throw new Error("Hotmail/Outlook token 字段不完整，请检查邮箱记录");
  }
  return createHotmailDatabaseProvider(account);
}

function recordMailEvent(sourceId: number | null, mailboxId: number | null, type: string, message: string): void {
  getDb().prepare(`
        INSERT INTO mail_events (source_id, mailbox_id, type, message, created_at)
        VALUES (?, ?, ?, ?, ?)
    `).run(sourceId, mailboxId, type, message, currentTimestamp());
}

function rowToMailType(row: MailTypeRow): MailTypeItem {
  return {
    id: row.id,
    key: row.key,
    provider: row.provider,
    name: row.name,
    subtype: row.subtype,
    domain_hint: row.domain_hint,
    supports_auto_code: Boolean(row.supports_auto_code),
    enabled: Boolean(row.enabled),
    sort_order: row.sort_order,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToSource(row: MailSourceRow & {
    mail_type_key?: string | null;
    mail_type_name?: string | null;
    subtype?: string | null;
    mailbox_count?: number;
    unused_count?: number;
    used_count?: number;
    failed_count?: number;
}): MailSourceItem {
  return {
    id: row.id,
    name: row.name,
    provider: row.provider,
    mail_type_id: row.mail_type_id ?? null,
    mail_type_key: row.mail_type_key ?? null,
    mail_type_name: row.mail_type_name ?? null,
    subtype: row.subtype ?? null,
    vendor: row.vendor ?? null,
    batch_note: row.batch_note ?? null,
    enabled: Boolean(row.enabled),
    supports_auto_code: Boolean(row.supports_auto_code),
    mailbox_count: Number(row.mailbox_count ?? 0),
    unused_count: Number(row.unused_count ?? 0),
    used_count: Number(row.used_count ?? 0),
    failed_count: Number(row.failed_count ?? 0),
    has_config: hasSecret(row.config_encrypted),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function rowToMailbox(row: MailboxRow & {
    source_name?: string;
    supports_auto_code?: number;
    mail_type_key?: string | null;
    mail_type_name?: string | null;
    subtype?: string | null;
}): MailboxListItem {
  return {
    id: row.id,
    source_id: row.source_id,
    source_name: row.source_name ?? "",
    mail_type_id: row.mail_type_id ?? null,
    mail_type_key: row.mail_type_key ?? null,
    mail_type_name: row.mail_type_name ?? null,
    subtype: row.subtype ?? null,
    email: row.email,
    provider: row.provider,
    status: row.status,
    used: row.used,
    has_password: hasSecret(row.password_encrypted),
    has_client_id: hasSecret(row.client_id_encrypted),
    has_refresh_token: hasSecret(row.refresh_token_encrypted),
    has_access_token: hasSecret(row.access_token_encrypted),
    supports_auto_code: row.supports_auto_code ?? 0,
    last_code_status: row.last_code_status,
    last_code_at: row.last_code_at,
    last_used_at: row.last_used_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listMailTypes(): MailTypeItem[] {
  const rows = getDb().prepare("SELECT * FROM mail_types WHERE enabled = 1 ORDER BY sort_order ASC, id ASC").all() as MailTypeRow[];
  return rows.map(rowToMailType);
}

export async function createMailType(input: MailTypeInput): Promise<MailTypeItem> {
  const provider = normalizeProvider(input.provider);
  const subtype = provider === "hotmail" ? (normalizeSubtype(input.subtype) ?? "graph") : null;
  const key = String(input.key ?? providerTypeKey(provider, subtype)).trim();
  const timestamp = currentTimestamp();
  const result = getDb().prepare(`
        INSERT INTO mail_types (
            key, provider, name, subtype, domain_hint, supports_auto_code, enabled, sort_order, created_at, updated_at
        )
        VALUES (@key, @provider, @name, @subtype, @domain_hint, @supports_auto_code, @enabled, @sort_order, @created_at, @updated_at)
    `).run({
    key,
    provider,
    name: String(input.name ?? key).trim() || key,
    subtype,
    domain_hint: String(input.domain_hint ?? "").trim() || null,
    supports_auto_code: typeof input.supports_auto_code === "boolean"
      ? (input.supports_auto_code ? 1 : 0)
      : (AUTO_CODE_PROVIDERS.has(provider) ? 1 : 0),
    enabled: toEnabled(input.enabled, true),
    sort_order: Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : 100,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return rowToMailType(ensureMailType(Number(result.lastInsertRowid)));
}

export async function updateMailType(id: number, input: MailTypeInput): Promise<MailTypeItem> {
  const current = ensureMailType(id);
  const provider = input.provider ? normalizeProvider(input.provider) : current.provider as MailProviderName;
  const subtype = provider === "hotmail" ? (normalizeSubtype(input.subtype ?? current.subtype) ?? "graph") : null;
  getDb().prepare(`
        UPDATE mail_types
        SET key = @key,
            provider = @provider,
            name = @name,
            subtype = @subtype,
            domain_hint = @domain_hint,
            supports_auto_code = @supports_auto_code,
            enabled = @enabled,
            sort_order = @sort_order,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
    id,
    key: String(input.key ?? current.key).trim() || current.key,
    provider,
    name: String(input.name ?? current.name).trim() || current.name,
    subtype,
    domain_hint: input.domain_hint === undefined ? current.domain_hint : (String(input.domain_hint).trim() || null),
    supports_auto_code: typeof input.supports_auto_code === "boolean" ? (input.supports_auto_code ? 1 : 0) : current.supports_auto_code,
    enabled: typeof input.enabled === "boolean" ? (input.enabled ? 1 : 0) : current.enabled,
    sort_order: Number.isFinite(Number(input.sort_order)) ? Number(input.sort_order) : current.sort_order,
    updated_at: currentTimestamp(),
  });
  return rowToMailType(ensureMailType(id));
}

export function deleteMailType(id: number): {ok: true} {
  const count = getDb().prepare("SELECT COUNT(*) AS count FROM mail_sources WHERE mail_type_id = ?").get(id) as {count: number};
  if (count.count > 0) {
    throw new Error("该邮箱类型下还有来源，不能删除");
  }
  getDb().prepare("DELETE FROM mail_types WHERE id = ?").run(id);
  return {ok: true};
}

export function listMailSources(filters: MailSourceListFilters = {}): MailSourceItem[] {
  const params: Record<string, unknown> = {
    q: `%${String(filters.q ?? "").trim()}%`,
    hasQ: String(filters.q ?? "").trim(),
    typeId: filters.typeId ?? null,
    provider: String(filters.provider ?? "").trim(),
    subtype: String(filters.subtype ?? "").trim(),
    enabled: String(filters.enabled ?? "").trim(),
  };
  const rows = getDb().prepare(`
        SELECT
            s.*,
            t.key AS mail_type_key,
            t.name AS mail_type_name,
            t.subtype AS subtype,
            COUNT(m.id) AS mailbox_count,
            SUM(CASE WHEN m.used = 0 AND m.status = 'unused' THEN 1 ELSE 0 END) AS unused_count,
            SUM(CASE WHEN m.used = 1 THEN 1 ELSE 0 END) AS used_count,
            SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
        FROM mail_sources s
        LEFT JOIN mail_types t ON t.id = s.mail_type_id
        LEFT JOIN mailboxes m ON m.source_id = s.id
        WHERE (@hasQ = '' OR s.name LIKE @q OR s.vendor LIKE @q OR s.batch_note LIKE @q)
          AND (@typeId IS NULL OR s.mail_type_id = @typeId)
          AND (@provider = '' OR s.provider = @provider)
          AND (@subtype = '' OR t.subtype = @subtype)
          AND (@enabled = '' OR s.enabled = CASE WHEN @enabled = 'true' THEN 1 ELSE 0 END)
        GROUP BY s.id
        ORDER BY s.enabled DESC, s.updated_at DESC, s.id DESC
    `).all(params) as Array<MailSourceRow & {
        mail_type_key: string | null;
        mail_type_name: string | null;
        subtype: string | null;
        mailbox_count: number;
        unused_count: number;
        used_count: number;
        failed_count: number;
    }>;
  return rows.map(rowToSource);
}

export async function createMailSource(input: MailSourceInput): Promise<MailSourceItem> {
  const type = resolveMailType(input);
  const timestamp = currentTimestamp();
  const result = getDb().prepare(`
        INSERT INTO mail_sources (
            name, provider, mail_type_id, vendor, batch_note, enabled, supports_auto_code, config_encrypted, created_at, updated_at
        )
        VALUES (
            @name, @provider, @mail_type_id, @vendor, @batch_note, @enabled, @supports_auto_code, @config_encrypted, @created_at, @updated_at
        )
    `).run({
    name: String(input.name ?? type.name).trim() || type.name,
    provider: type.provider,
    mail_type_id: type.id,
    vendor: String(input.vendor ?? "").trim() || null,
    batch_note: String(input.batch_note ?? "").trim() || null,
    enabled: toEnabled(input.enabled, true),
    supports_auto_code: typeof input.supports_auto_code === "boolean" ? (input.supports_auto_code ? 1 : 0) : type.supports_auto_code,
    config_encrypted: input.config ? await encryptSecret(input.config) : null,
    created_at: timestamp,
    updated_at: timestamp,
  });
  recordMailEvent(Number(result.lastInsertRowid), null, "source_created", `新增邮箱来源 ${type.name}`);
  return getMailSourceItem(Number(result.lastInsertRowid));
}

export async function updateMailSource(id: number, input: MailSourceInput): Promise<MailSourceItem> {
  const current = ensureSource(id);
  const type = input.mail_type_id || input.type_id || input.provider || input.subtype
    ? resolveMailType(input)
    : current.mail_type_id
      ? ensureMailType(current.mail_type_id)
      : ensureMailTypeByProvider(normalizeProvider(current.provider));
  getDb().prepare(`
        UPDATE mail_sources
        SET name = @name,
            provider = @provider,
            mail_type_id = @mail_type_id,
            vendor = @vendor,
            batch_note = @batch_note,
            enabled = @enabled,
            supports_auto_code = @supports_auto_code,
            config_encrypted = @config_encrypted,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
    id,
    name: String(input.name ?? current.name).trim() || current.name,
    provider: type.provider,
    mail_type_id: type.id,
    vendor: input.vendor === undefined ? current.vendor : (String(input.vendor).trim() || null),
    batch_note: input.batch_note === undefined ? current.batch_note : (String(input.batch_note).trim() || null),
    enabled: typeof input.enabled === "boolean" ? (input.enabled ? 1 : 0) : current.enabled,
    supports_auto_code: typeof input.supports_auto_code === "boolean" ? (input.supports_auto_code ? 1 : 0) : current.supports_auto_code,
    config_encrypted: input.config ? await encryptSecret(input.config) : current.config_encrypted,
    updated_at: currentTimestamp(),
  });
  getDb().prepare(`
        UPDATE mailboxes
        SET provider = @provider,
            mail_type_id = @mail_type_id,
            updated_at = @updated_at
        WHERE source_id = @source_id
    `).run({
    source_id: id,
    provider: type.provider,
    mail_type_id: type.id,
    updated_at: currentTimestamp(),
  });
  return getMailSourceItem(id);
}

export function deleteMailSource(id: number): {ok: true} {
  ensureSource(id);
  getDb().prepare("DELETE FROM mail_sources WHERE id = ?").run(id);
  return {ok: true};
}

function getMailSourceItem(id: number): MailSourceItem {
  const row = getDb().prepare(`
        SELECT
            s.*,
            t.key AS mail_type_key,
            t.name AS mail_type_name,
            t.subtype AS subtype,
            COUNT(m.id) AS mailbox_count,
            SUM(CASE WHEN m.used = 0 AND m.status = 'unused' THEN 1 ELSE 0 END) AS unused_count,
            SUM(CASE WHEN m.used = 1 THEN 1 ELSE 0 END) AS used_count,
            SUM(CASE WHEN m.status = 'failed' THEN 1 ELSE 0 END) AS failed_count
        FROM mail_sources s
        LEFT JOIN mail_types t ON t.id = s.mail_type_id
        LEFT JOIN mailboxes m ON m.source_id = s.id
        WHERE s.id = ?
        GROUP BY s.id
    `).get(id) as (MailSourceRow & {
        mail_type_key: string | null;
        mail_type_name: string | null;
        subtype: string | null;
        mailbox_count: number;
        unused_count: number;
        used_count: number;
        failed_count: number;
    }) | undefined;
  if (!row) {
    throw new Error(`邮箱来源不存在: ${id}`);
  }
  return rowToSource(row);
}

async function encryptOptional(value: string | undefined): Promise<string | null | undefined> {
  if (value === undefined) {
    return undefined;
  }
  return value ? await encryptSecret(value) : null;
}

export function listMailboxes(filters: MailboxListFilters = {}): MailboxListItem[] {
  const params: Record<string, unknown> = {
    q: `%${String(filters.q ?? "").trim()}%`,
    hasQ: String(filters.q ?? "").trim(),
    sourceId: filters.sourceId ?? null,
    typeId: filters.typeId ?? null,
    provider: String(filters.provider ?? "").trim(),
    subtype: String(filters.subtype ?? "").trim(),
    status: String(filters.status ?? "").trim(),
    used: String(filters.used ?? "").trim(),
    autoCode: String(filters.autoCode ?? "").trim(),
  };
  const rows = getDb().prepare(`
        SELECT
            m.*,
            s.name AS source_name,
            s.supports_auto_code AS supports_auto_code,
            t.key AS mail_type_key,
            t.name AS mail_type_name,
            t.subtype AS subtype
        FROM mailboxes m
        JOIN mail_sources s ON s.id = m.source_id
        LEFT JOIN mail_types t ON t.id = m.mail_type_id
        WHERE (@hasQ = '' OR m.email LIKE @q OR s.name LIKE @q OR s.vendor LIKE @q)
          AND (@sourceId IS NULL OR m.source_id = @sourceId)
          AND (@typeId IS NULL OR m.mail_type_id = @typeId)
          AND (@provider = '' OR m.provider = @provider)
          AND (@subtype = '' OR t.subtype = @subtype)
          AND (@status = '' OR m.status = @status)
          AND (@used = '' OR m.used = CASE WHEN @used = 'true' THEN 1 ELSE 0 END)
          AND (@autoCode = '' OR s.supports_auto_code = CASE WHEN @autoCode = 'true' THEN 1 ELSE 0 END)
        ORDER BY m.used ASC, m.updated_at DESC, m.id DESC
    `).all(params) as Array<MailboxRow & {
        source_name: string;
        supports_auto_code: number;
        mail_type_key: string | null;
        mail_type_name: string | null;
        subtype: string | null;
    }>;
  return rows.map(rowToMailbox);
}

export async function createMailbox(input: MailboxInput): Promise<MailboxListItem> {
  if (!input.source_id) {
    throw new Error("邮箱来源不能为空");
  }
  const source = ensureSource(input.source_id);
  const type = input.mail_type_id ? ensureMailType(input.mail_type_id) : source.mail_type_id ? ensureMailType(source.mail_type_id) : ensureMailTypeByProvider(normalizeProvider(source.provider));
  const email = normalizeMailbox(input.email ?? "");
  if (!email) {
    throw new Error("邮箱格式不正确");
  }
  const timestamp = currentTimestamp();
  const result = getDb().prepare(`
        INSERT INTO mailboxes (
            source_id, mail_type_id, email, provider, password_encrypted, client_id_encrypted,
            refresh_token_encrypted, access_token_encrypted, status, used, created_at, updated_at
        )
        VALUES (
            @source_id, @mail_type_id, @email, @provider, @password_encrypted, @client_id_encrypted,
            @refresh_token_encrypted, @access_token_encrypted, @status, @used, @created_at, @updated_at
        )
        ON CONFLICT(source_id, email) DO UPDATE SET
            mail_type_id = excluded.mail_type_id,
            provider = excluded.provider,
            password_encrypted = COALESCE(excluded.password_encrypted, password_encrypted),
            client_id_encrypted = COALESCE(excluded.client_id_encrypted, client_id_encrypted),
            refresh_token_encrypted = COALESCE(excluded.refresh_token_encrypted, refresh_token_encrypted),
            access_token_encrypted = COALESCE(excluded.access_token_encrypted, access_token_encrypted),
            status = excluded.status,
            used = excluded.used,
            updated_at = excluded.updated_at
    `).run({
    source_id: source.id,
    mail_type_id: type.id,
    email,
    provider: type.provider,
    password_encrypted: await encryptOptional(input.password) ?? null,
    client_id_encrypted: await encryptOptional(input.client_id) ?? null,
    refresh_token_encrypted: await encryptOptional(input.refresh_token) ?? null,
    access_token_encrypted: await encryptOptional(input.access_token) ?? null,
    status: input.status ?? (input.used ? "used" : "unused"),
    used: input.used ? 1 : 0,
    created_at: timestamp,
    updated_at: timestamp,
  });
  const id = Number(result.lastInsertRowid) || ensureMailboxBySourceAndEmail(source.id, email).id;
  recordMailEvent(source.id, id, "mailbox_saved", `保存邮箱 ${email}`);
  return getMailboxListItem(id);
}

export async function updateMailbox(id: number, input: MailboxInput): Promise<MailboxListItem> {
  const current = ensureMailbox(id);
  const source = input.source_id ? ensureSource(input.source_id) : ensureSource(current.source_id);
  const type = input.mail_type_id ? ensureMailType(input.mail_type_id) : source.mail_type_id ? ensureMailType(source.mail_type_id) : ensureMailTypeByProvider(normalizeProvider(source.provider));
  const password = await encryptOptional(input.password);
  const clientId = await encryptOptional(input.client_id);
  const refreshToken = await encryptOptional(input.refresh_token);
  const accessToken = await encryptOptional(input.access_token);
  getDb().prepare(`
        UPDATE mailboxes
        SET source_id = @source_id,
            mail_type_id = @mail_type_id,
            provider = @provider,
            email = @email,
            password_encrypted = @password_encrypted,
            client_id_encrypted = @client_id_encrypted,
            refresh_token_encrypted = @refresh_token_encrypted,
            access_token_encrypted = @access_token_encrypted,
            status = @status,
            used = @used,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
    id,
    source_id: source.id,
    mail_type_id: type.id,
    provider: type.provider,
    email: normalizeMailbox(input.email ?? current.email) || current.email,
    password_encrypted: password === undefined ? current.password_encrypted : password,
    client_id_encrypted: clientId === undefined ? current.client_id_encrypted : clientId,
    refresh_token_encrypted: refreshToken === undefined ? current.refresh_token_encrypted : refreshToken,
    access_token_encrypted: accessToken === undefined ? current.access_token_encrypted : accessToken,
    status: input.status ?? current.status,
    used: typeof input.used === "boolean" ? (input.used ? 1 : 0) : current.used,
    updated_at: currentTimestamp(),
  });
  return getMailboxListItem(id);
}

export function deleteMailbox(id: number): {ok: true} {
  ensureMailbox(id);
  getDb().prepare("DELETE FROM mailboxes WHERE id = ?").run(id);
  return {ok: true};
}

function ensureMailboxBySourceAndEmail(sourceId: number, email: string): MailboxRow {
  const row = getDb().prepare("SELECT * FROM mailboxes WHERE source_id = ? AND email = ?").get(sourceId, email) as MailboxRow | undefined;
  if (!row) {
    throw new Error(`邮箱保存失败: ${email}`);
  }
  return row;
}

function getMailboxListItem(id: number): MailboxListItem {
  const row = getDb().prepare(`
        SELECT
            m.*,
            s.name AS source_name,
            s.supports_auto_code AS supports_auto_code,
            t.key AS mail_type_key,
            t.name AS mail_type_name,
            t.subtype AS subtype
        FROM mailboxes m
        JOIN mail_sources s ON s.id = m.source_id
        LEFT JOIN mail_types t ON t.id = m.mail_type_id
        WHERE m.id = ?
    `).get(id) as (MailboxRow & {
        source_name: string;
        supports_auto_code: number;
        mail_type_key: string | null;
        mail_type_name: string | null;
        subtype: string | null;
    }) | undefined;
  if (!row) {
    throw new Error(`邮箱不存在: ${id}`);
  }
  return rowToMailbox(row);
}

function parseMailboxLine(line: string, type?: Pick<MailTypeRow, "provider" | "subtype">): Omit<MailboxInput, "source_id" | "mail_type_id"> | null {
  const raw = line.trim();
  if (!raw || raw.startsWith("#")) {
    return null;
  }
  const parts = raw.split("----");
  const [emailPart, password = "", clientId = "", ...refreshParts] = parts;
  const email = normalizeMailbox(emailPart);
  if (!email) {
    return null;
  }
  if (type?.provider === "hotmail" && type.subtype === "graph" && parts.length < 4) {
    throw new Error("Hotmail/Outlook 导入格式应为：邮箱----密码----client_id----refresh_token");
  }
  if (type?.provider === "2925" && parts.length > 1) {
    throw new Error("2925 来源导入格式应为：邮箱，一行一个；账号配置在配置页维护");
  }
  if ((type?.provider === "gmail" || type?.provider === "gptmail" || type?.provider === "cloudflare" || type?.provider === "proxiedmail") && parts.length > 1) {
    throw new Error(`${type.provider} 来源导入格式应为：邮箱，一行一个；渠道配置在配置页维护`);
  }
  return {
    email,
    password: password.trim(),
    client_id: clientId.trim(),
    refresh_token: refreshParts.join("----").trim(),
  };
}

export async function importMailboxes(input: MailboxImportInput): Promise<{imported: number; updated: number; skipped: number; source_id: number}> {
  let sourceId = Number(input.source_id);
  if (!sourceId) {
    const type = resolveMailType(input);
    const source = await createMailSource({
      mail_type_id: type.id,
      name: input.name || `${type.name} 来源`,
      vendor: input.vendor,
      batch_note: input.batch_note,
    });
    sourceId = Number(source.id);
  }
  const source = ensureSource(sourceId);
  const sourceType = source.mail_type_id ? ensureMailType(source.mail_type_id) : ensureMailTypeByProvider(normalizeProvider(source.provider));
  let imported = 0;
  let updated = 0;
  let skipped = 0;
  for (const line of String(input.text ?? "").split(/\r?\n/)) {
    try {
      const parsed = parseMailboxLine(line, sourceType);
      if (!parsed) {
        skipped += line.trim() ? 1 : 0;
        continue;
      }
      const exists = getDb().prepare("SELECT id FROM mailboxes WHERE source_id = ? AND email = ?").get(source.id, parsed.email);
      await createMailbox({...parsed, source_id: source.id});
      if (exists) {
        updated += 1;
      } else {
        imported += 1;
      }
    } catch (error) {
      skipped += 1;
      recordMailEvent(source.id, null, "mailbox_import_skipped", error instanceof Error ? error.message : String(error));
    }
  }
  recordMailEvent(source.id, null, "mailbox_import", `导入 ${imported}，更新 ${updated}，跳过 ${skipped}`);
  return {imported, updated, skipped, source_id: source.id};
}

export function markMailboxUsed(id: number, used: boolean, status?: MailboxStatus, error?: string): void {
  ensureMailbox(id);
  getDb().prepare(`
        UPDATE mailboxes
        SET used = @used,
            status = @status,
            last_used_at = CASE WHEN @used = 1 THEN @now ELSE last_used_at END,
            last_error = @error,
            updated_at = @now
        WHERE id = @id
    `).run({
    id,
    used: used ? 1 : 0,
    status: status ?? (used ? "used" : "unused"),
    error: error ?? null,
    now: currentTimestamp(),
  });
  recordMailEvent(null, id, used ? "mark_used" : "mark_unused", used ? "标记已使用" : "标记未使用");
}

export function setMailboxLastError(id: number, error: string, release = true): void {
  const status = release ? "unused" : "failed";
  getDb().prepare(`
        UPDATE mailboxes
        SET status = @status,
            used = CASE WHEN @release = 1 THEN 0 ELSE used END,
            last_error = @error,
            updated_at = @updated_at
        WHERE id = @id
    `).run({
    id,
    release: release ? 1 : 0,
    status,
    error,
    updated_at: currentTimestamp(),
  });
  recordMailEvent(null, id, "mailbox_error", error);
}

export function reserveMailbox(sourceId?: number, typeId?: number): MailboxRow {
  const row = getDb().prepare(`
        SELECT m.*
        FROM mailboxes m
        JOIN mail_sources s ON s.id = m.source_id
        WHERE s.enabled = 1
          AND m.used = 0
          AND m.status IN ('unused', 'reserved')
          AND (@sourceId IS NULL OR m.source_id = @sourceId)
          AND (@typeId IS NULL OR m.mail_type_id = @typeId)
        ORDER BY m.last_used_at ASC NULLS FIRST, m.id ASC
        LIMIT 1
    `).get({sourceId: sourceId || null, typeId: typeId || null}) as MailboxRow | undefined;
  if (!row) {
    throw new Error("邮箱池没有可用邮箱");
  }
  getDb().prepare(`
        UPDATE mailboxes
        SET status = 'reserved',
            updated_at = ?
        WHERE id = ?
    `).run(currentTimestamp(), row.id);
  reservedMailboxId = row.id;
  recordMailEvent(row.source_id, row.id, "reserved", "注册任务占用邮箱");
  return ensureMailbox(row.id);
}

export function createDatabaseMailboxProvider(sourceId?: number, typeId?: number): EmailCodeProvider {
  return {
    async getEmailAddress(): Promise<string> {
      const mailbox = reserveMailbox(sourceId, typeId);
      return mailbox.email;
    },
    async getEmailVerificationCode(email: string, options?: EmailVerificationCodeOptions): Promise<string> {
      const mailbox = getDb().prepare("SELECT * FROM mailboxes WHERE email = ? ORDER BY updated_at DESC LIMIT 1").get(normalizeMailbox(email)) as MailboxRow | undefined;
      if (!mailbox) {
        throw new Error(`邮箱池未找到邮箱: ${email}`);
      }
      const source = ensureSource(mailbox.source_id);
      const type = mailbox.mail_type_id ? ensureMailType(mailbox.mail_type_id) : source.mail_type_id ? ensureMailType(source.mail_type_id) : ensureMailTypeByProvider(normalizeProvider(source.provider));
      if (!source.supports_auto_code || !type.supports_auto_code) {
        throw new Error(`邮箱来源 ${source.name} 未启用自动取件`);
      }
      const provider = await createMailboxProvider(type, mailbox);
      try {
        const code = await provider.getEmailVerificationCode(mailbox.email, options);
        getDb().prepare(`
                    UPDATE mailboxes
                    SET last_code_status = 'success',
                        last_code_at = @last_code_at,
                        last_error = NULL,
                        updated_at = @updated_at
                    WHERE id = @id
                `).run({id: mailbox.id, last_code_at: currentTimestamp(), updated_at: currentTimestamp()});
        recordMailEvent(source.id, mailbox.id, "code_success", `获取验证码成功 ${tail(code)}`);
        return code;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        getDb().prepare(`
                    UPDATE mailboxes
                    SET last_code_status = 'failed',
                        last_code_at = @last_code_at,
                        last_error = @last_error,
                        updated_at = @updated_at
                    WHERE id = @id
                `).run({
          id: mailbox.id,
          last_code_at: currentTimestamp(),
          last_error: message,
          updated_at: currentTimestamp(),
        });
        recordMailEvent(source.id, mailbox.id, "code_failed", message);
        throw error;
      }
    },
  };
}

export async function testMailboxCode(id: number): Promise<{ok: boolean; codeTail?: string; error?: string}> {
  const mailbox = ensureMailbox(id);
  try {
    const source = ensureSource(mailbox.source_id);
    const type = mailbox.mail_type_id ? ensureMailType(mailbox.mail_type_id) : source.mail_type_id ? ensureMailType(source.mail_type_id) : ensureMailTypeByProvider(normalizeProvider(source.provider));
    const provider = await createMailboxProvider(type, mailbox);
    const code = await provider.getEmailVerificationCode(mailbox.email);
    return {ok: true, codeTail: tail(code)};
  } catch (error) {
    return {ok: false, error: error instanceof Error ? error.message : String(error)};
  }
}

export async function fetchLatestMailboxEmail(id: number): Promise<MailboxLatestEmailResult> {
  const mailbox = ensureMailbox(id);
  const source = ensureSource(mailbox.source_id);
  const type = mailbox.mail_type_id ? ensureMailType(mailbox.mail_type_id) : source.mail_type_id ? ensureMailType(source.mail_type_id) : ensureMailTypeByProvider(normalizeProvider(source.provider));
  if (!source.supports_auto_code || !type.supports_auto_code) {
    return {ok: false, error: `邮箱来源 ${source.name} 未启用自动取件`};
  }
  const provider = await createMailboxProvider(type, mailbox);
  if (!provider.getLatestEmail) {
    return {ok: false, error: `${type.name} 暂不支持读取最新邮件正文`};
  }
  try {
    const email = await provider.getLatestEmail(mailbox.email);
    getDb().prepare(`
            UPDATE mailboxes
            SET last_code_status = @status,
                last_code_at = @last_code_at,
                last_error = NULL,
                updated_at = @updated_at
            WHERE id = @id
        `).run({
      id,
      status: email ? "fetched" : "empty",
      last_code_at: currentTimestamp(),
      updated_at: currentTimestamp(),
    });
    recordMailEvent(source.id, mailbox.id, "mail_fetch", email ? "读取最新邮件成功" : "未找到邮件");
    return {ok: true, email};
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getDb().prepare(`
            UPDATE mailboxes
            SET last_code_status = 'failed',
                last_code_at = @last_code_at,
                last_error = @last_error,
                updated_at = @updated_at
            WHERE id = @id
        `).run({
      id,
      last_code_at: currentTimestamp(),
      last_error: message,
      updated_at: currentTimestamp(),
    });
    recordMailEvent(source.id, mailbox.id, "mail_fetch_failed", message);
    return {ok: false, error: message};
  }
}

export async function getReservedMailboxPassword(): Promise<string> {
  if (!reservedMailboxId) {
    return "";
  }
  const mailbox = ensureMailbox(reservedMailboxId);
  return mailbox.password_encrypted ? decryptSecret(mailbox.password_encrypted) : "";
}

export function consumeReservedMailbox(): MailboxRow | null {
  if (!reservedMailboxId) {
    return null;
  }
  const mailbox = ensureMailbox(reservedMailboxId);
  reservedMailboxId = null;
  return mailbox;
}
