import {copyFileSync, existsSync, mkdirSync, statSync} from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export const DATA_DIR = path.resolve(process.cwd(), "data");
const LEGACY_DB_BASENAME = `${["codex", "register"].join("-")}.db`;
const LEGACY_DB_PATH = path.join(DATA_DIR, LEGACY_DB_BASENAME);
export const DB_PATH = path.join(DATA_DIR, "codex-auth-manager.db");

export interface AccountRow {
    id: number;
    email: string;
    password_encrypted: string | null;
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
    created_at: string;
    updated_at: string;
    source_id?: number | null;
    mailbox_id?: number | null;
    status_code?: string | null;
    status_label?: string | null;
    credential_type?: string | null;
    credential_source_kind?: string | null;
    credential_source_name?: string | null;
    credential_source_service_id?: number | null;
    credential_source_remote_id?: string | null;
    credential_synced_at?: string | null;
}

export interface AuthFileRow {
    id: number;
    account_id: number;
    file_path: string;
    file_name: string;
    active: number;
    token_expires_at: string | null;
    last_cpa_push_at: string | null;
    last_cpa_status: string | null;
    last_sub2api_push_at: string | null;
    last_sub2api_status: string | null;
    created_at: string;
    updated_at: string;
    credential_type?: string;
    current_step?: string | null;
    step_status?: string | null;
    last_step_at?: string | null;
    credential_source_kind?: string | null;
    credential_source_name?: string | null;
    credential_source_service_id?: number | null;
    credential_source_remote_id?: string | null;
    credential_synced_at?: string | null;
}

export interface AccountUsageWindowRow {
    id: number;
    account_id: number;
    window_key: string;
    label: string;
    used_percent: number | null;
    remaining_percent: number | null;
    reset_at: string | null;
    limit_reached: number | null;
    updated_at: string;
}

export interface MailSourceRow {
    id: number;
    name: string;
    provider: string;
    mail_type_id?: number | null;
    vendor?: string | null;
    batch_note?: string | null;
    enabled: number;
    supports_auto_code: number;
    config_encrypted: string | null;
    created_at: string;
    updated_at: string;
}

export interface MailboxRow {
    id: number;
    source_id: number;
    mail_type_id?: number | null;
    email: string;
    provider: string;
    password_encrypted: string | null;
    client_id_encrypted: string | null;
    refresh_token_encrypted: string | null;
    access_token_encrypted: string | null;
    status: string;
    used: number;
    last_code_status: string | null;
    last_code_at: string | null;
    last_used_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
}

export interface MailTypeRow {
    id: number;
    key: string;
    provider: string;
    name: string;
    subtype: string | null;
    domain_hint: string | null;
    supports_auto_code: number;
    enabled: number;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

export interface JobRow {
    id: number;
    type: string;
    status: string;
    title: string;
    payload_json: string;
    result_json: string | null;
    error: string | null;
    waiting_for_input: number;
    input_prompt: string | null;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
}

export interface JobEventRow {
    id: number;
    job_id: number;
    level: string;
    message: string;
    created_at: string;
}

export type IntegrationServiceKind = "cpa" | "sub2api";

export interface IntegrationServiceRow {
    id: number;
    kind: IntegrationServiceKind;
    name: string;
    base_url: string;
    secret_encrypted: string;
    enabled: number;
    priority: number;
    include_proxy_url: number;
    options_json: string;
    last_test_at: string | null;
    last_test_status: string | null;
    last_test_message: string | null;
    created_at: string;
    updated_at: string;
}

export interface AccountPlatformBindingRow {
    id: number;
    account_id: number;
    integration_service_id: number;
    last_push_at: string | null;
    last_push_status: string | null;
    last_push_message: string | null;
    created_at: string;
    updated_at: string;
}

export interface CredentialSyncEventRow {
    id: number;
    account_id: number | null;
    integration_service_id: number | null;
    source_kind: IntegrationServiceKind | "local";
    action: string;
    status: string;
    message: string | null;
    created_at: string;
}

let db: Database.Database | null = null;

function now(): string {
  return new Date().toISOString();
}

export function getDb(): Database.Database {
  if (db) {
    return db;
  }

  mkdirSync(DATA_DIR, {recursive: true});
  if (!existsSync(DB_PATH) && existsSync(LEGACY_DB_PATH)) {
    copyFileSync(LEGACY_DB_PATH, DB_PATH);
  }
  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function migrate(database: Database.Database): void {
  database.exec(`
        CREATE TABLE IF NOT EXISTS accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_encrypted TEXT,
            provider TEXT,
            status TEXT NOT NULL DEFAULT 'unknown',
            plan TEXT,
            remaining_percent REAL,
            used_percent REAL,
            reset_at TEXT,
            last_check_at TEXT,
            last_refresh_at TEXT,
            last_auth_at TEXT,
            last_error TEXT,
            auto_reauth INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS auth_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            file_path TEXT NOT NULL UNIQUE,
            file_name TEXT NOT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            token_expires_at TEXT,
            last_cpa_push_at TEXT,
            last_cpa_status TEXT,
            last_sub2api_push_at TEXT,
            last_sub2api_status TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT NOT NULL,
            status TEXT NOT NULL,
            title TEXT NOT NULL,
            payload_json TEXT NOT NULL DEFAULT '{}',
            result_json TEXT,
            error TEXT,
            waiting_for_input INTEGER NOT NULL DEFAULT 0,
            input_prompt TEXT,
            created_at TEXT NOT NULL,
            started_at TEXT,
            finished_at TEXT
        );

        CREATE TABLE IF NOT EXISTS job_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            level TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS job_inputs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            value TEXT NOT NULL,
            consumed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value_json TEXT NOT NULL,
            is_secret INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_auth_files_account ON auth_files(account_id);
        CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, id);
        CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);
    `);

  addColumnIfMissing(database, "accounts", "source_id", "INTEGER");
  addColumnIfMissing(database, "accounts", "mailbox_id", "INTEGER");
  addColumnIfMissing(database, "accounts", "status_code", "TEXT");
  addColumnIfMissing(database, "accounts", "status_label", "TEXT");
  addColumnIfMissing(database, "accounts", "credential_type", "TEXT");
  addColumnIfMissing(database, "accounts", "credential_source_kind", "TEXT");
  addColumnIfMissing(database, "accounts", "credential_source_name", "TEXT");
  addColumnIfMissing(database, "accounts", "credential_source_service_id", "INTEGER");
  addColumnIfMissing(database, "accounts", "credential_source_remote_id", "TEXT");
  addColumnIfMissing(database, "accounts", "credential_synced_at", "TEXT");
  addColumnIfMissing(database, "auth_files", "credential_type", "TEXT NOT NULL DEFAULT 'codex_auth'");
  addColumnIfMissing(database, "auth_files", "current_step", "TEXT");
  addColumnIfMissing(database, "auth_files", "step_status", "TEXT");
  addColumnIfMissing(database, "auth_files", "last_step_at", "TEXT");
  addColumnIfMissing(database, "auth_files", "credential_source_kind", "TEXT");
  addColumnIfMissing(database, "auth_files", "credential_source_name", "TEXT");
  addColumnIfMissing(database, "auth_files", "credential_source_service_id", "INTEGER");
  addColumnIfMissing(database, "auth_files", "credential_source_remote_id", "TEXT");
  addColumnIfMissing(database, "auth_files", "credential_synced_at", "TEXT");

  database.exec(`
        CREATE TABLE IF NOT EXISTS mail_types (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL UNIQUE,
            provider TEXT NOT NULL,
            name TEXT NOT NULL,
            subtype TEXT,
            domain_hint TEXT,
            supports_auto_code INTEGER NOT NULL DEFAULT 0,
            enabled INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 100,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS account_usage_windows (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            window_key TEXT NOT NULL,
            label TEXT NOT NULL,
            used_percent REAL,
            remaining_percent REAL,
            reset_at TEXT,
            limit_reached INTEGER,
            updated_at TEXT NOT NULL,
            UNIQUE(account_id, window_key)
        );

        CREATE TABLE IF NOT EXISTS mail_sources (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            provider TEXT NOT NULL,
            mail_type_id INTEGER REFERENCES mail_types(id) ON DELETE SET NULL,
            vendor TEXT,
            batch_note TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            supports_auto_code INTEGER NOT NULL DEFAULT 0,
            config_encrypted TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS mailboxes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER NOT NULL REFERENCES mail_sources(id) ON DELETE CASCADE,
            mail_type_id INTEGER REFERENCES mail_types(id) ON DELETE SET NULL,
            email TEXT NOT NULL,
            provider TEXT NOT NULL,
            password_encrypted TEXT,
            client_id_encrypted TEXT,
            refresh_token_encrypted TEXT,
            access_token_encrypted TEXT,
            status TEXT NOT NULL DEFAULT 'unused',
            used INTEGER NOT NULL DEFAULT 0,
            last_code_status TEXT,
            last_code_at TEXT,
            last_used_at TEXT,
            last_error TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(source_id, email)
        );

        CREATE TABLE IF NOT EXISTS mail_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL,
            source_id INTEGER REFERENCES mail_sources(id) ON DELETE SET NULL,
            type TEXT NOT NULL,
            message TEXT NOT NULL,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_accounts_status_code ON accounts(status_code);
        CREATE INDEX IF NOT EXISTS idx_accounts_credential_type ON accounts(credential_type);
        CREATE INDEX IF NOT EXISTS idx_usage_windows_account ON account_usage_windows(account_id);
        CREATE INDEX IF NOT EXISTS idx_mail_types_key ON mail_types(key);
        CREATE INDEX IF NOT EXISTS idx_mail_sources_provider ON mail_sources(provider);
        CREATE INDEX IF NOT EXISTS idx_mailboxes_source ON mailboxes(source_id);
        CREATE INDEX IF NOT EXISTS idx_mailboxes_status ON mailboxes(status, used);
        CREATE INDEX IF NOT EXISTS idx_mail_events_mailbox ON mail_events(mailbox_id, id);
    `);

  database.exec(`
        CREATE TABLE IF NOT EXISTS integration_services (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL CHECK (kind IN ('cpa', 'sub2api')),
            name TEXT NOT NULL,
            base_url TEXT NOT NULL,
            secret_encrypted TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            priority INTEGER NOT NULL DEFAULT 0,
            include_proxy_url INTEGER NOT NULL DEFAULT 0,
            options_json TEXT NOT NULL DEFAULT '{}',
            last_test_at TEXT,
            last_test_status TEXT,
            last_test_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_integration_services_kind ON integration_services(kind, enabled, priority);

        CREATE TABLE IF NOT EXISTS account_platform_bindings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
            integration_service_id INTEGER NOT NULL REFERENCES integration_services(id) ON DELETE CASCADE,
            last_push_at TEXT,
            last_push_status TEXT,
            last_push_message TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            UNIQUE(account_id, integration_service_id)
        );

        CREATE TABLE IF NOT EXISTS credential_sync_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_id INTEGER REFERENCES accounts(id) ON DELETE SET NULL,
            integration_service_id INTEGER REFERENCES integration_services(id) ON DELETE SET NULL,
            source_kind TEXT NOT NULL,
            action TEXT NOT NULL,
            status TEXT NOT NULL,
            message TEXT,
            created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_account_platform_bindings_account ON account_platform_bindings(account_id);
        CREATE INDEX IF NOT EXISTS idx_account_platform_bindings_service ON account_platform_bindings(integration_service_id);
        CREATE INDEX IF NOT EXISTS idx_credential_sync_events_account ON credential_sync_events(account_id, id);
        CREATE INDEX IF NOT EXISTS idx_credential_sync_events_service ON credential_sync_events(integration_service_id, id);
    `);

  addColumnIfMissing(database, "mail_sources", "mail_type_id", "INTEGER REFERENCES mail_types(id) ON DELETE SET NULL");
  addColumnIfMissing(database, "mail_sources", "vendor", "TEXT");
  addColumnIfMissing(database, "mail_sources", "batch_note", "TEXT");
  addColumnIfMissing(database, "mailboxes", "mail_type_id", "INTEGER REFERENCES mail_types(id) ON DELETE SET NULL");

  database.exec(`
        CREATE INDEX IF NOT EXISTS idx_mail_sources_type ON mail_sources(mail_type_id);
        CREATE INDEX IF NOT EXISTS idx_mailboxes_type ON mailboxes(mail_type_id);
    `);

  seedMailTypes(database);
  migrateMailTypeLinks(database);

  const insertDefault = database.prepare(`
        INSERT OR IGNORE INTO settings_meta (key, value, updated_at)
        VALUES (?, ?, ?)
    `);
  insertDefault.run("scheduler.enabled", "true", now());
  insertDefault.run("scheduler.dailyTime", "03:30", now());
  insertDefault.run("scheduler.lastRunStatus", "never", now());
}

function seedMailTypes(database: Database.Database): void {
  const timestamp = now();
  const rows = [
    ["hotmail_graph", "hotmail", "Hotmail / Outlook", "graph", "outlook.com, hotmail.com", 1, 1, 10],
    ["hotmail_xiongmaodian", "hotmail", "Hotmail / 熊猫点", "xiongmaodian", "outlook.com, hotmail.com", 1, 1, 11],
    ["gmail", "gmail", "Gmail", null, "gmail.com", 1, 1, 20],
    ["gptmail", "gptmail", "GPTMail", null, "custom domain", 1, 1, 30],
    ["proxiedmail", "proxiedmail", "ProxiedMail", null, "proxiedmail", 1, 1, 40],
    ["2925", "2925", "2925 邮箱", null, "2925", 1, 1, 50],
    ["cloudflare", "cloudflare", "Cloudflare Email Routing", null, "custom domain", 1, 1, 60],
  ];
  const statement = database.prepare(`
        INSERT INTO mail_types (
            key, provider, name, subtype, domain_hint, supports_auto_code, enabled, sort_order, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            provider = excluded.provider,
            name = excluded.name,
            subtype = excluded.subtype,
            domain_hint = excluded.domain_hint,
            supports_auto_code = excluded.supports_auto_code,
            enabled = excluded.enabled,
            sort_order = excluded.sort_order,
            updated_at = excluded.updated_at
    `);
  for (const row of rows) {
    statement.run(...row, timestamp, timestamp);
  }
  const graphType = database.prepare("SELECT id FROM mail_types WHERE key = 'hotmail_graph'").get() as {id: number} | undefined;
  const xiongmaodianTokenType = database.prepare("SELECT id FROM mail_types WHERE key = 'hotmail_xiongmaodian_token' OR subtype = 'xiongmaodian_token'").get() as {id: number} | undefined;
  if (graphType && xiongmaodianTokenType) {
    database.prepare("UPDATE mail_sources SET mail_type_id = ?, updated_at = ? WHERE mail_type_id = ?").run(graphType.id, timestamp, xiongmaodianTokenType.id);
    database.prepare("UPDATE mailboxes SET mail_type_id = ?, updated_at = ? WHERE mail_type_id = ?").run(graphType.id, timestamp, xiongmaodianTokenType.id);
  }
  database.prepare("UPDATE mail_types SET enabled = 0, updated_at = ? WHERE key = 'hotmail_xiongmaodian_token' OR subtype = 'xiongmaodian_token'").run(timestamp);
}

function migrateMailTypeLinks(database: Database.Database): void {
  const timestamp = now();
  database.prepare(`
        UPDATE mail_sources
        SET mail_type_id = (
            SELECT id FROM mail_types
            WHERE key = CASE
                WHEN mail_sources.provider = 'hotmail' THEN 'hotmail_graph'
                ELSE mail_sources.provider
            END
        ),
            updated_at = ?
        WHERE mail_type_id IS NULL
    `).run(timestamp);
  database.prepare(`
        UPDATE mailboxes
        SET mail_type_id = COALESCE(
            (SELECT mail_type_id FROM mail_sources WHERE mail_sources.id = mailboxes.source_id),
            (SELECT id FROM mail_types WHERE key = CASE
                WHEN mailboxes.provider = 'hotmail' THEN 'hotmail_graph'
                ELSE mailboxes.provider
            END)
        ),
            updated_at = ?
        WHERE mail_type_id IS NULL
    `).run(timestamp);
}

function addColumnIfMissing(database: Database.Database, table: string, column: string, definition: string): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{name: string}>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function upsertSetting(key: string, value: string): void {
  getDb().prepare(`
        INSERT INTO settings_meta (key, value, updated_at)
        VALUES (@key, @value, @updated_at)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `).run({key, value, updated_at: now()});
}

export function getSettings(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM settings_meta").all() as Array<{key: string; value: string}>;
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function currentTimestamp(): string {
  return now();
}

export function getDatabaseStats(): {
    path: string;
    sizeBytes: number;
    accounts: number;
    authFiles: number;
    mailSources: number;
    mailboxes: number;
    jobs: number;
    jobEvents: number;
    integrationServices: number;
    accountPlatformBindings: number;
} {
  const database = getDb();
  const count = (table: string) => {
    const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {count: number};
    return row.count;
  };
  const sizeBytes = existsSync(DB_PATH) ? statSync(DB_PATH).size : 0;
  return {
    path: DB_PATH,
    sizeBytes,
    accounts: count("accounts"),
    authFiles: count("auth_files"),
    mailSources: count("mail_sources"),
    mailboxes: count("mailboxes"),
    jobs: count("jobs"),
    jobEvents: count("job_events"),
    integrationServices: count("integration_services"),
    accountPlatformBindings: count("account_platform_bindings"),
  };
}
