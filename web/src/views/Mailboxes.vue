<script setup lang="ts">
import {computed, onMounted, reactive, ref, watch} from "vue";
import {ElMessage, ElMessageBox} from "element-plus";
import {Delete, Edit, Hide, Message, Plus, Refresh, Search, Upload, View} from "@element-plus/icons-vue";
import {apiGet, apiSend, type LatestEmail, type Mailbox, type MailboxSecrets, type MailSource, type MailType} from "../api";

const sources = ref<MailSource[]>([]);
const types = ref<MailType[]>([]);
const mailboxes = ref<Mailbox[]>([]);
const loading = ref(false);
const mailboxDialog = ref(false);
const importDialog = ref(false);
const editingMailboxId = ref<number | null>(null);
const saving = ref(false);
const importing = ref(false);
const fetchDialog = ref(false);
const fetchingMail = ref(false);
const latestEmail = ref<LatestEmail | null>(null);
const fetchingMailbox = ref<Mailbox | null>(null);
const currentPage = ref(1);
const pageSize = ref(20);
const loadingSecrets = ref(false);

const filters = reactive({
  q: "",
  sourceId: "",
  typeId: "",
  provider: "",
  subtype: "",
  status: "",
  used: "",
  autoCode: "",
});

const mailboxForm = reactive({
  source_id: 0,
  email: "",
  password: "",
  client_id: "",
  refresh_token: "",
  access_token: "",
  status: "unused",
  used: false,
});

const importForm = reactive({
  source_id: 0,
  mail_type_id: 0,
  name: "",
  vendor: "",
  batch_note: "",
  text: "",
});

const statuses = [
  {label: "未使用", value: "unused", type: "success"},
  {label: "已占用", value: "reserved", type: "warning"},
  {label: "已使用", value: "used", type: "info"},
  {label: "失败", value: "failed", type: "danger"},
  {label: "禁用", value: "disabled", type: "danger"},
];

const hotmailModes = [
  {label: "Outlook / Graph", value: "graph"},
  {label: "熊猫电竞", value: "xiongmaodian"},
];

type MailboxSecretField = "password" | "client_id" | "refresh_token" | "access_token";

const SECRET_FIELD_KEYS: MailboxSecretField[] = ["password", "client_id", "refresh_token", "access_token"];

const revealedFields = reactive<Record<MailboxSecretField, boolean>>({
  password: false,
  client_id: false,
  refresh_token: false,
  access_token: false,
});

const fieldHadStoredValue = reactive<Record<MailboxSecretField, boolean>>({
  password: false,
  client_id: false,
  refresh_token: false,
  access_token: false,
});

const selectedImportSource = computed(() => sources.value.find((item) => item.id === importForm.source_id));
const creatingSourceOnImport = computed(() => !importForm.source_id);
const pagedMailboxes = computed(() => mailboxes.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const selectedMailboxSource = computed(() => sources.value.find((item) => item.id === mailboxForm.source_id));
const selectedMailboxProvider = computed(() => selectedMailboxSource.value?.provider ?? "");
const selectedImportType = computed(() => selectedImportSource.value
  ? types.value.find((item) => item.id === selectedImportSource.value?.mail_type_id)
  : types.value.find((item) => item.id === importForm.mail_type_id));
const mailboxFieldSchema = computed(() => fieldsForProvider(selectedMailboxProvider.value, selectedMailboxSource.value?.subtype));
const importPlaceholder = computed(() => placeholderForType(selectedImportType.value));
const latestEmailDocument = computed(() => buildEmailDocument(latestEmail.value));

function buildQuery() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") {
      params.set(key, value);
    }
  }
  return params.toString();
}

async function load() {
  loading.value = true;
  try {
    const [typePayload, sourcePayload, mailboxPayload] = await Promise.all([
      apiGet<{types: MailType[]}>("/api/mail-types"),
      apiGet<{sources: MailSource[]}>("/api/mail-sources"),
      apiGet<{mailboxes: Mailbox[]}>(`/api/mailboxes?${buildQuery()}`),
    ]);
    types.value = typePayload.types;
    sources.value = sourcePayload.sources;
    mailboxes.value = mailboxPayload.mailboxes;
    if ((currentPage.value - 1) * pageSize.value >= mailboxes.value.length) {
      currentPage.value = 1;
    }
    if (!mailboxForm.source_id && sources.value[0]) {
      mailboxForm.source_id = sources.value[0].id;
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  Object.assign(filters, {
    q: "",
    sourceId: "",
    typeId: "",
    provider: "",
    subtype: "",
    status: "",
    used: "",
    autoCode: "",
  });
  void load();
}

function resetMailboxForm() {
  editingMailboxId.value = null;
  Object.assign(mailboxForm, {
    source_id: sources.value[0]?.id ?? 0,
    email: "",
    password: "",
    client_id: "",
    refresh_token: "",
    access_token: "",
    status: "unused",
    used: false,
  });
  resetSecretReveal();
  for (const key of SECRET_FIELD_KEYS) {
    fieldHadStoredValue[key] = false;
  }
  mailboxDialog.value = true;
}

function resetSecretReveal() {
  for (const key of SECRET_FIELD_KEYS) {
    revealedFields[key] = false;
  }
}

function isFieldMasked(key: MailboxSecretField): boolean {
  return fieldHadStoredValue[key] && !revealedFields[key];
}

function fieldDisplayValue(key: MailboxSecretField): string {
  const real = mailboxForm[key] ?? "";
  if (!isFieldMasked(key) || !real) {
    return real;
  }
  return "●".repeat(Math.min(real.length, 16));
}

function fieldInputType(key: string): string {
  if (key === "refresh_token" || key === "access_token") {
    return "textarea";
  }
  if (key === "password") {
    return revealedFields.password ? "text" : "password";
  }
  return "text";
}

function toggleReveal(key: MailboxSecretField) {
  revealedFields[key] = !revealedFields[key];
}

function fieldsForProvider(provider: string, subtype?: string | null) {
  if (provider === "hotmail") {
    if (subtype === "xiongmaodian") {
      return [{key: "password", label: "邮箱密码", placeholder: "可选，熊猫电竞普通取件通常不需要"}];
    }
    return [
      {key: "password", label: "邮箱密码", placeholder: "可选"},
      {key: "client_id", label: "client_id", placeholder: "必填"},
      {key: "refresh_token", label: "refresh_token", placeholder: "必填"},
    ];
  }
  if (provider === "gmail") {
    return [
      {key: "access_token", label: "gmailAccessToken", placeholder: "来自 config.gmailAccessToken，可在单邮箱覆盖"},
      {key: "email", label: "gmailEmailAddress", placeholder: "例如 name@gmail.com"},
    ];
  }
  if (provider === "gptmail") {
    return [
      {key: "access_token", label: "gptMailApiKey", placeholder: "来自 config.gptMailApiKey，可在单邮箱覆盖"},
      {key: "client_id", label: "gptMailDomain", placeholder: "可选域名"},
    ];
  }
  if (provider === "2925") {
    return [
      {key: "email", label: "2925EmailAddress", placeholder: "2925 主邮箱或库存邮箱"},
      {key: "password", label: "2925Password", placeholder: "2925 登录密码，可选覆盖"},
    ];
  }
  if (provider === "cloudflare") {
    return [
      {key: "email", label: "cloudflareEmailDomain", placeholder: "该来源下的目标邮箱"},
      {key: "client_id", label: "cloudflareApiBaseUrl", placeholder: "Worker 地址，可选记录"},
      {key: "access_token", label: "cloudflareApiKey", placeholder: "Worker 密钥，可选记录"},
    ];
  }
  return [
    {key: "email", label: "邮箱", placeholder: "邮箱地址"},
    {key: "access_token", label: "API Token", placeholder: "可选"},
  ];
}

function secretFieldValue(key: string) {
  return mailboxForm[key as MailboxSecretField] ?? "";
}

function setSecretFieldValue(key: string, value: string | number) {
  mailboxForm[key as MailboxSecretField] = String(value ?? "");
}

function placeholderForType(type: MailType | undefined) {
  if (!type) {
    return "a@example.com";
  }
  if (type.provider === "hotmail" && type.subtype !== "xiongmaodian") {
    return "a@outlook.com----password----client_id----refresh_token";
  }
  return "a@example.com\nb@example.com";
}

async function editMailbox(row: Mailbox) {
  editingMailboxId.value = row.id;
  Object.assign(mailboxForm, {
    source_id: row.source_id,
    email: row.email,
    password: "",
    client_id: "",
    refresh_token: "",
    access_token: "",
    status: row.used ? "used" : row.status,
    used: Boolean(row.used),
  });
  fieldHadStoredValue.password = Boolean(row.has_password);
  fieldHadStoredValue.client_id = Boolean(row.has_client_id);
  fieldHadStoredValue.refresh_token = Boolean(row.has_refresh_token);
  fieldHadStoredValue.access_token = Boolean(row.has_access_token);
  resetSecretReveal();
  mailboxDialog.value = true;
  const needsFetch = SECRET_FIELD_KEYS.some((key) => fieldHadStoredValue[key]);
  if (!needsFetch) {
    return;
  }
  loadingSecrets.value = true;
  try {
    const {secrets} = await apiGet<{secrets: MailboxSecrets}>(`/api/mailboxes/${row.id}/secrets`);
    mailboxForm.password = secrets.password || "";
    mailboxForm.client_id = secrets.client_id || "";
    mailboxForm.refresh_token = secrets.refresh_token || "";
    mailboxForm.access_token = secrets.access_token || "";
  } catch (error) {
    ElMessage.warning(`读取已有敏感字段失败，编辑时若不重新输入将清空原值：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    loadingSecrets.value = false;
  }
}

async function saveMailbox() {
  saving.value = true;
  try {
    const payload = {
      ...mailboxForm,
      used: mailboxForm.status === "used",
    };
    if (editingMailboxId.value) {
      await apiSend(`/api/mailboxes/${editingMailboxId.value}`, "PUT", payload);
      ElMessage.success("邮箱已更新");
    } else {
      await apiSend("/api/mailboxes", "POST", payload);
      ElMessage.success("邮箱已创建");
    }
    mailboxDialog.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}

async function removeMailbox(row: Mailbox) {
  try {
    await ElMessageBox.confirm(`确定删除 ${row.email}？`, "删除邮箱", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
    await apiSend(`/api/mailboxes/${row.id}`, "DELETE");
    ElMessage.success("邮箱已删除");
    await load();
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(error instanceof Error ? error.message : String(error));
    }
  }
}

function resetImportForm() {
  Object.assign(importForm, {
    source_id: sources.value[0]?.id ?? 0,
    mail_type_id: types.value[0]?.id ?? 0,
    name: "",
    vendor: "",
    batch_note: "",
    text: "",
  });
}

function openImport() {
  resetImportForm();
  importDialog.value = true;
}

function closeImport() {
  importDialog.value = false;
  resetImportForm();
}

async function importMailboxes() {
  importing.value = true;
  try {
    const result = await apiSend<{imported: number; updated: number; skipped: number}>("/api/mailboxes/import", "POST", importForm);
    ElMessage.success(`导入 ${result.imported}，更新 ${result.updated}，跳过 ${result.skipped}`);
    closeImport();
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    importing.value = false;
  }
}

async function fetchLatest(row: Mailbox) {
  fetchingMailbox.value = row;
  latestEmail.value = null;
  fetchDialog.value = true;
  fetchingMail.value = true;
  try {
    const result = await apiSend<{ok: boolean; email?: LatestEmail | null; error?: string}>(`/api/mailboxes/${row.id}/fetch-latest`, "POST");
    if (result.ok) {
      latestEmail.value = result.email ?? null;
      ElMessage.success(result.email ? "取件成功" : "未找到邮件");
    } else {
      ElMessage.error(result.error || "取件失败");
    }
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    fetchingMail.value = false;
  }
}

function statusType(status: string) {
  return statuses.find((item) => item.value === status)?.type || "info";
}

function statusLabel(status: string) {
  return statuses.find((item) => item.value === status)?.label || status;
}

function rowStatusType(row: Mailbox) {
  if (row.used) {
    return "info";
  }
  return statusType(row.status);
}

function rowStatusLabel(row: Mailbox) {
  if (row.used) {
    return "已使用";
  }
  return statusLabel(row.status);
}

function subtypeLabel(value: string | null | undefined) {
  return hotmailModes.find((item) => item.value === value)?.label || value || "-";
}

function formatDate(value: string | null | undefined) {
  return value ? new Date(value).toLocaleString() : "-";
}

function formatRecipient(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.join(", ") : (value || "-");
}

function buildEmailDocument(email: LatestEmail | null) {
  const rawBody = email?.html || email?.content || email?.snippet || "";
  const body = rawBody.trim()
    ? (looksLikeHtml(rawBody) ? rawBody : `<div class="plain-mail">${escapeHtml(rawBody)}</div>`)
    : `<div class="empty-mail">无正文</div>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<base target="_blank">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 16px;
    color: #1f2937;
    background: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px;
    line-height: 1.65;
    overflow-wrap: anywhere;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; border-collapse: collapse; }
  a { color: #2563eb; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .plain-mail { white-space: pre-wrap; }
  .empty-mail { color: #64748b; }
  @media (prefers-color-scheme: dark) {
    body { color: #e5e7eb; background: #0f172a; }
    a { color: #60a5fa; }
    .empty-mail { color: #94a3b8; }
  }
</style>
</head>
<body>${body}</body>
</html>`;
}

function looksLikeHtml(value: string) {
  return /<\/?[a-z][\s\S]*>/i.test(value);
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

watch(importDialog, (open) => {
  if (!open) {
    resetImportForm();
  }
});

watch(pageSize, () => {
  currentPage.value = 1;
});

onMounted(load);
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">邮箱管理</h1>
        <p class="page-subtitle">维护具体邮箱库存、使用状态和取件能力；来源只作为渠道批次标注。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <el-button :icon="Plus" type="primary" @click="resetMailboxForm">添加邮箱</el-button>
        <el-button :icon="Upload" @click="openImport">批量导入</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <el-card shadow="never" class="mb-4">
      <el-form :model="filters" label-position="left" class="filter-form">
        <div class="filter-grid">
          <el-form-item label="关键词">
            <el-input v-model="filters.q" clearable placeholder="邮箱/来源/渠道" @keyup.enter="load" />
          </el-form-item>
          <el-form-item label="邮箱类型">
            <el-select v-model="filters.typeId" clearable filterable placeholder="全部" class="w-full">
              <el-option v-for="type in types" :key="type.id" :label="type.name" :value="String(type.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="Hotmail 子类">
            <el-select v-model="filters.subtype" clearable placeholder="全部" class="w-full">
              <el-option v-for="mode in hotmailModes" :key="mode.value" :label="mode.label" :value="mode.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="来源">
            <el-select v-model="filters.sourceId" clearable filterable placeholder="全部" class="w-full">
              <el-option v-for="source in sources" :key="source.id" :label="source.name" :value="String(source.id)" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="filters.status" clearable placeholder="全部" class="w-full">
              <el-option v-for="item in statuses" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="使用">
            <el-select v-model="filters.used" clearable placeholder="全部" class="w-full">
              <el-option label="已使用" value="true" />
              <el-option label="未使用" value="false" />
            </el-select>
          </el-form-item>
          <el-form-item label="取件">
            <el-select v-model="filters.autoCode" clearable placeholder="全部" class="w-full">
              <el-option label="自动取件" value="true" />
              <el-option label="仅库存" value="false" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <div class="filter-actions flex w-full gap-2">
              <el-button :icon="Search" type="primary" class="flex-1" @click="load">筛选</el-button>
              <el-button class="flex-1" @click="resetFilters">重置</el-button>
            </div>
          </el-form-item>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <div class="data-table-wrap">
        <el-table v-loading="loading" :data="pagedMailboxes" border row-key="id">
          <el-table-column prop="email" label="邮箱" min-width="230" show-overflow-tooltip />
          <el-table-column label="类型" min-width="170">
            <template #default="{row}">
              <div class="font-medium">{{ row.mail_type_name || row.provider }}</div>
              <div class="text-xs text-[var(--app-muted)]">{{ row.provider }} / {{ subtypeLabel(row.subtype) }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="source_name" label="来源" min-width="160" show-overflow-tooltip />
          <el-table-column label="状态" width="120">
            <template #default="{row}">
              <el-tag :type="rowStatusType(row)">{{ rowStatusLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="取件" min-width="145">
            <template #default="{row}">
              <div class="flex flex-col gap-1">
                <el-tag :type="row.supports_auto_code ? 'success' : 'info'" effect="plain">
                  {{ row.supports_auto_code ? "自动取件" : "仅库存" }}
                </el-tag>
                <span class="text-xs text-[var(--app-muted)]">{{ row.last_code_status || "未测试" }} / {{ formatDate(row.last_code_at) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column prop="last_error" label="最近错误" min-width="190" show-overflow-tooltip>
            <template #default="{row}">{{ row.last_error || "-" }}</template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="286">
            <template #default="{row}">
              <div class="table-actions">
                <el-button :icon="Edit" size="small" link @click="editMailbox(row)">编辑</el-button>
                <el-button :icon="Message" size="small" link :disabled="!row.supports_auto_code" @click="fetchLatest(row)">取件</el-button>
                <el-button :icon="Delete" size="small" link type="danger" @click="removeMailbox(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="mt-4 flex justify-end">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="mailboxes.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </el-card>

    <el-dialog v-model="mailboxDialog" :title="editingMailboxId ? '编辑邮箱' : '添加邮箱'" width="680px">
      <el-form v-loading="loadingSecrets" element-loading-text="正在读取敏感字段..." label-position="top" :model="mailboxForm">
        <el-form-item label="来源">
          <el-select v-model="mailboxForm.source_id" filterable class="w-full">
            <el-option
              v-for="source in sources"
              :key="source.id"
              :label="`${source.name} / ${source.mail_type_name || source.provider}`"
              :value="source.id"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="邮箱"><el-input v-model="mailboxForm.email" /></el-form-item>
        <div class="grid gap-3 md:grid-cols-2">
          <template v-for="field in mailboxFieldSchema" :key="field.key">
            <el-form-item
              v-if="field.key !== 'email'"
              class="mb-0"
            >
              <template #label>
                <div class="flex w-full items-center justify-between gap-2">
                  <span>{{ field.label }}</span>
                  <el-button
                    v-if="SECRET_FIELD_KEYS.includes(field.key as MailboxSecretField)"
                    link size="small" type="primary"
                    @click="toggleReveal(field.key as MailboxSecretField)"
                  >
                    <el-icon class="mr-1"><component :is="revealedFields[field.key as MailboxSecretField] ? Hide : View" /></el-icon>
                    {{ revealedFields[field.key as MailboxSecretField] ? '隐藏' : '显示' }}
                  </el-button>
                </div>
              </template>
              <el-input
                :model-value="SECRET_FIELD_KEYS.includes(field.key as MailboxSecretField)
                  ? fieldDisplayValue(field.key as MailboxSecretField)
                  : secretFieldValue(field.key)"
                :type="fieldInputType(field.key)"
                :rows="field.key === 'refresh_token' || field.key === 'access_token' ? 2 : undefined"
                :readonly="SECRET_FIELD_KEYS.includes(field.key as MailboxSecretField) && isFieldMasked(field.key as MailboxSecretField)"
                :placeholder="field.placeholder"
                @update:model-value="setSecretFieldValue(field.key, $event)"
              />
            </el-form-item>
          </template>
        </div>
        <el-form-item label="状态">
          <el-select v-model="mailboxForm.status" class="w-full">
            <el-option v-for="item in statuses" :key="item.value" :label="item.label" :value="item.value" />
          </el-select>
          <div class="mt-1 text-xs text-[var(--app-muted)]">选择"已使用"后，该邮箱会从可用池中移除。</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="mailboxDialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveMailbox">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importDialog" title="批量导入邮箱" width="780px" @close="resetImportForm">
      <el-alert title="导入格式会按所选来源类型校验；Hotmail/Outlook 使用：邮箱----密码----client_id----refresh_token，其他来源默认一行一个邮箱。" type="info" show-icon class="mb-3" />
      <el-form label-position="top" :model="importForm">
        <el-form-item label="导入到已有来源">
          <el-select v-model="importForm.source_id" clearable filterable class="w-full" placeholder="选择已有来源；清空后创建新来源">
            <el-option
              v-for="source in sources"
              :key="source.id"
              :label="`${source.name} / ${source.mail_type_name || source.provider}${source.subtype ? ' / ' + subtypeLabel(source.subtype) : ''}`"
              :value="source.id"
            />
          </el-select>
          <div v-if="selectedImportSource" class="mt-2 text-sm text-[var(--app-muted)]">
            将按 {{ selectedImportSource.mail_type_name || selectedImportSource.provider }} / {{ subtypeLabel(selectedImportSource.subtype) }} 的取件方式导入。
          </div>
        </el-form-item>

        <div v-if="creatingSourceOnImport" class="grid gap-3 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-soft)] p-3 md:grid-cols-2">
          <el-form-item label="新来源邮箱类型" class="mb-0">
            <el-select v-model="importForm.mail_type_id" filterable class="w-full">
              <el-option
                v-for="type in types"
                :key="type.id"
                :label="`${type.name}${type.subtype ? ' / ' + subtypeLabel(type.subtype) : ''}`"
                :value="type.id"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="新来源名称" class="mb-0">
            <el-input v-model="importForm.name" placeholder="例如：5月A商家 100枚" />
          </el-form-item>
          <el-form-item label="渠道" class="mb-0">
            <el-input v-model="importForm.vendor" placeholder="商家/平台/订单来源" />
          </el-form-item>
          <el-form-item label="批次备注" class="mb-0">
            <el-input v-model="importForm.batch_note" placeholder="价格、数量、质量备注" />
          </el-form-item>
        </div>

        <el-form-item label="邮箱文本" class="mt-3">
          <el-input v-model="importForm.text" type="textarea" :rows="12" :placeholder="importPlaceholder" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="closeImport">取消</el-button>
        <el-button type="primary" :loading="importing" @click="importMailboxes">导入</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="fetchDialog" title="最新邮件" width="760px">
      <div
        v-loading="fetchingMail"
        element-loading-text="正在读取最新邮件..."
        class="min-h-[460px]"
      >
        <el-descriptions v-if="latestEmail" :column="1" border>
          <el-descriptions-item label="邮箱">{{ fetchingMailbox?.email }}</el-descriptions-item>
          <el-descriptions-item label="发件人">{{ latestEmail.sender || "-" }}</el-descriptions-item>
          <el-descriptions-item label="收件人">{{ formatRecipient(latestEmail.recipient) }}</el-descriptions-item>
          <el-descriptions-item label="主题">{{ latestEmail.subject || "-" }}</el-descriptions-item>
          <el-descriptions-item label="时间">{{ latestEmail.receivedAt || (latestEmail.timestamp ? formatDate(new Date(latestEmail.timestamp).toISOString()) : "-") }}</el-descriptions-item>
          <el-descriptions-item label="验证码">{{ latestEmail.verificationCode || "未解析到" }}</el-descriptions-item>
        </el-descriptions>
        <div v-if="latestEmail" class="mt-3 overflow-hidden rounded-xl border border-[var(--app-border)] bg-[var(--app-surface)]">
          <div class="border-b border-[var(--app-border)] bg-[var(--app-surface-soft)] px-3 py-2 text-xs font-medium text-[var(--app-muted)]">
            邮件正文
          </div>
          <iframe
            class="block h-[360px] w-full bg-white dark:bg-slate-950"
            :srcdoc="latestEmailDocument"
            title="最新邮件正文"
            sandbox
            referrerpolicy="no-referrer"
          />
        </div>
        <el-empty v-else-if="!fetchingMail" class="min-h-[420px]" description="未找到邮件" />
      </div>
    </el-dialog>
  </section>
</template>
