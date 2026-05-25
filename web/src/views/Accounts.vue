<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, reactive, ref, watch} from "vue";
import {useRouter} from "vue-router";
import {ElMessage} from "element-plus";
import {Delete, Download, Refresh, Search, Setting} from "@element-plus/icons-vue";
import {
  apiGet,
  apiSend,
  type Account,
  type BoundPlatformService,
  type IntegrationService,
  type MailSource,
  type UsageWindow,
} from "../api";
import ReauthDialog from "../components/ReauthDialog.vue";
import SyncDialog from "../components/SyncDialog.vue";
import DeleteAccountDialog from "../components/DeleteAccountDialog.vue";

const router = useRouter();
const accounts = ref<Account[]>([]);
const selected = ref<Account[]>([]);
const mailSources = ref<MailSource[]>([]);
const loading = ref(false);
const autoChecking = ref(false);
const autoPoll = ref(true);
const pollSeconds = ref(60);
const currentPage = ref(1);
const pageSize = ref(20);
const profileDialog = ref(false);
const detailDialog = ref(false);
const pushDialog = ref(false);
const syncDialogVisible = ref(false);
const bindingDialog = ref(false);
const reauthDialogVisible = ref(false);
const reauthAccount = ref<Account | null>(null);
const reauthMode = ref<"auto" | "manual">("auto");
const deleteDialogVisible = ref(false);
const deleteTargets = ref<Account[]>([]);
const activeAccount = ref<Account | null>(null);
const passwordValue = ref("");
const clearPassword = ref(false);
const accountSourceId = ref<number | null>(null);
const pushTarget = ref<"cpa" | "sub2api" | "both">("cpa");
const pushScope = ref<"single" | "bulk">("single");
const bindingScope = ref<"single" | "bulk">("single");
const bindingMode = ref<"replace" | "append" | "clear">("replace");
const services = ref<IntegrationService[]>([]);
const selectedServiceIds = ref<number[]>([]);
const selectedBindingServiceIds = ref<number[]>([]);
const bindingFilterServiceIds = ref<number[]>([]);

let timer: number | undefined;
let pendingAutoCheck = false;

const filters = reactive({
  q: "",
  status: "",
  credentialType: "",
  plan: "",
  autoReauth: "",
  pushStatus: "",
});

const statusOptions = [
  {label: "正常", value: "authorized", type: "success"},
  {label: "额度已用尽", value: "quota_exhausted", type: "warning"},
  {label: "凭据过期", value: "credential_expired", type: "danger"},
  {label: "账号异常", value: "account_abnormal", type: "danger"},
  {label: "需要人工重登", value: "needs_manual_reauth", type: "danger"},
  {label: "未检查", value: "unchecked", type: "info"},
  {label: "只保存 accessToken", value: "access_token_only", type: "primary"},
];

const credentialOptions = [
  {label: "已授权 Codex auth", value: "codex_auth"},
  {label: "只保存 accessToken", value: "access_token_only"},
  {label: "无凭据", value: "none"},
];

const pushTargets = [
  {label: "CPA", value: "cpa"},
  {label: "Sub2API", value: "sub2api"},
  {label: "CPA + Sub2API", value: "both"},
] as const;

const selectedIds = computed(() => selected.value.map((item) => item.id));
const pagedAccounts = computed(() => accounts.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const pagedAccountIds = computed(() => pagedAccounts.value.map((item) => item.id));
const enabledServices = computed(() => services.value.filter((service) => service.enabled));
const availablePushServices = computed(() => services.value.filter((service) => {
  if (!service.enabled) {
    return false;
  }
  return pushTarget.value === "both" || service.kind === pushTarget.value;
}));

function buildQuery() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") {
      params.set(key, value);
    }
  }
  if (bindingFilterServiceIds.value.length) {
    params.set("bindingServiceIds", bindingFilterServiceIds.value.join(","));
  }
  params.set("pageSize", "300");
  return params.toString();
}

async function load(silent = false, checkCurrentPage = false) {
  loading.value = true;
  try {
    const payload = await apiGet<{ accounts: Account[] }>(`/api/accounts?${buildQuery()}`);
    accounts.value = payload.accounts;
    if ((currentPage.value - 1) * pageSize.value >= accounts.value.length) {
      currentPage.value = 1;
    }
    if (!silent) {
      ElMessage.success("账号列表已刷新");
    }
    if (checkCurrentPage) {
      schedulePoll();
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function autoCheckCurrentPage() {
  if (!autoPoll.value || autoChecking.value || !pagedAccountIds.value.length) {
    if (autoChecking.value) {
      pendingAutoCheck = true;
    }
    return;
  }
  autoChecking.value = true;
  const ids = [...pagedAccountIds.value];
  const failed: number[] = [];
  try {
    let nextIndex = 0;
    const workerCount = Math.min(4, ids.length);
    await Promise.all(Array.from({length: workerCount}, async () => {
      while (nextIndex < ids.length) {
        const id = ids[nextIndex];
        nextIndex += 1;
        if (!id) {
          continue;
        }
        try {
          await apiSend(`/api/accounts/${id}/check`, "POST");
        } catch {
          failed.push(id);
        }
      }
    }));
    await load(true);
    if (failed.length) {
      ElMessage.warning(`当前页自动检查完成，失败 ${failed.length} 个账号`);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    autoChecking.value = false;
    if (pendingAutoCheck) {
      pendingAutoCheck = false;
      void autoCheckCurrentPage();
    }
  }
}

async function loadServices() {
  try {
    const payload = await apiGet<{ services: IntegrationService[] }>("/api/integration-services");
    services.value = payload.services;
  } catch {
    services.value = [];
  }
}

async function loadMailSources() {
  try {
    const payload = await apiGet<{ sources: MailSource[] }>("/api/mail-sources");
    mailSources.value = payload.sources;
  } catch {
    mailSources.value = [];
  }
}

function resetFilters() {
  Object.assign(filters, {
    q: "",
    status: "",
    credentialType: "",
    plan: "",
    autoReauth: "",
    pushStatus: "",
  });
  bindingFilterServiceIds.value = [];
  currentPage.value = 1;
  void load(false, true);
}

async function importAuth() {
  loading.value = true;
  try {
    const result = await apiSend<Record<string, number>>("/api/accounts/import-auth", "POST");
    ElMessage.success(`导入 ${result.imported}，更新 ${result.updated}，跳过 ${result.skipped}`);
    await load(true);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

function openSync() {
  syncDialogVisible.value = true;
  void loadServices();
}

function filenameFromDisposition(disposition: string | null, fallback: string) {
  if (!disposition) {
    return fallback;
  }
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    return decodeURIComponent(encoded);
  }
  const plain = disposition.match(/filename="?([^"]+)"?/i)?.[1];
  return plain || fallback;
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function downloadAuth(ids: number[]) {
  if (!ids.length) {
    ElMessage.warning("请先选择账号");
    return;
  }
  loading.value = true;
  try {
    const response = ids.length === 1
        ? await fetch(`/api/accounts/${ids[0]}/auth-file`)
        : await fetch("/api/accounts/export-auth", {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ids}),
        });
    if (!response.ok) {
      const text = await response.text();
      try {
        const payload = JSON.parse(text) as { error?: string };
        throw new Error(payload.error || text);
      } catch (error) {
        if (error instanceof SyntaxError) {
          throw new Error(text);
        }
        throw error;
      }
    }
    const fallback = ids.length === 1 ? "codex-auth.json" : "codex-auth.zip";
    const fileName = filenameFromDisposition(response.headers.get("Content-Disposition"), fallback);
    downloadBlob(await response.blob(), fileName);
    ElMessage.success(ids.length === 1 ? "认证文件已导出" : `已导出 ${ids.length} 个认证文件`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function single(
    id: number,
    action: "check" | "refresh" | "push",
    target: "cpa" | "sub2api" | "both" = "both",
    serviceIds?: number[],
) {
  try {
    if (action === "check") {
      await apiSend(`/api/accounts/${id}/check`, "POST");
      ElMessage.success("检查完成");
    } else if (action === "refresh") {
      await apiSend(`/api/accounts/${id}/refresh`, "POST");
      ElMessage.success("刷新完成");
    } else {
      await apiSend(`/api/accounts/${id}/push`, "POST", {target, serviceIds});
      ElMessage.success("推送完成");
    }
    await load(true);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function bulk(
    action: "check" | "refresh" | "reauth" | "push",
    target: "cpa" | "sub2api" | "both" = "both",
    serviceIds?: number[],
) {
  if (!selectedIds.value.length) {
    ElMessage.warning("请先选择账号");
    return;
  }
  try {
    const result = await apiSend<{ job: { id: number } }>(`/api/accounts/bulk/${action}`, "POST", {
      ids: selectedIds.value,
      target,
      serviceIds,
    });
    ElMessage.success(`已创建批量任务 #${result.job.id}`);
    await router.push("/jobs");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function openPush(row?: Account) {
  if (row) {
    activeAccount.value = row;
    pushScope.value = "single";
  } else {
    if (!selectedIds.value.length) {
      ElMessage.warning("请先选择账号");
      return;
    }
    activeAccount.value = null;
    pushScope.value = "bulk";
  }
  pushTarget.value = "cpa";
  selectedServiceIds.value = [];
  pushDialog.value = true;
  void loadServices();
}

function openBindings(row?: Account) {
  if (row) {
    activeAccount.value = row;
    bindingScope.value = "single";
    selectedBindingServiceIds.value = row.platform_bindings?.map((item) => item.id) ?? [];
  } else {
    if (!selectedIds.value.length) {
      ElMessage.warning("请先选择账号");
      return;
    }
    activeAccount.value = null;
    bindingScope.value = "bulk";
    selectedBindingServiceIds.value = [];
  }
  bindingMode.value = "replace";
  bindingDialog.value = true;
  void loadServices();
}

async function confirmBindings() {
  try {
    if (bindingScope.value === "single") {
      if (!activeAccount.value) {
        return;
      }
      await apiSend(`/api/accounts/${activeAccount.value.id}/platform-bindings`, "PUT", {
        serviceIds: selectedBindingServiceIds.value,
        mode: bindingMode.value,
      });
      ElMessage.success("绑定平台已保存");
    } else {
      await apiSend("/api/accounts/bulk/platform-bindings", "POST", {
        ids: selectedIds.value,
        serviceIds: selectedBindingServiceIds.value,
        mode: bindingMode.value,
      });
      ElMessage.success(`已更新 ${selectedIds.value.length} 个账号的绑定平台`);
    }
    bindingDialog.value = false;
    await load(true);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function confirmPush() {
  if (pushScope.value === "single") {
    if (!activeAccount.value) {
      return;
    }
    await single(activeAccount.value.id, "push", pushTarget.value, selectedServiceIds.value);
  } else {
    await bulk("push", pushTarget.value, selectedServiceIds.value);
  }
  pushDialog.value = false;
}

function openProfile(row: Account) {
  activeAccount.value = row;
  passwordValue.value = "";
  clearPassword.value = false;
  accountSourceId.value = row.source_id ?? null;
  profileDialog.value = true;
  void loadMailSources();
  if (row.has_password) {
    void (async () => {
      try {
        const payload = await apiGet<{ hasPassword: boolean; password: string }>(`/api/accounts/${row.id}/password`);
        if (activeAccount.value?.id === row.id && profileDialog.value) {
          passwordValue.value = payload.password ?? "";
        }
      } catch {
        // 拉取失败保持空，用户可手动输入
      }
    })();
  }
}

async function saveProfile() {
  if (!activeAccount.value) {
    return;
  }
  try {
    const payload: { password?: string; sourceId: number | null } = {
      sourceId: accountSourceId.value,
    };
    if (clearPassword.value) {
      payload.password = "";
    } else if (passwordValue.value) {
      payload.password = passwordValue.value;
    }
    await apiSend(`/api/accounts/${activeAccount.value.id}/profile`, "PUT", payload);
    ElMessage.success("账号资料已保存");
    profileDialog.value = false;
    await load(true);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function openDetail(row: Account) {
  activeAccount.value = row;
  detailDialog.value = true;
}

function openReauth(row: Account, mode: "auto" | "manual") {
  reauthAccount.value = row;
  reauthMode.value = mode;
  reauthDialogVisible.value = true;
}

function openDeleteSingle(row: Account) {
  deleteTargets.value = [row];
  deleteDialogVisible.value = true;
}

function openDeleteBulk() {
  if (!selected.value.length) {
    ElMessage.warning("请先选择账号");
    return;
  }
  deleteTargets.value = [...selected.value];
  deleteDialogVisible.value = true;
}

function onReauthFinished() {
  void load(true);
}

function onSyncFinished() {
  void load(true);
}

function onDeleted() {
  void load(true);
}

function statusTag(row: Account) {
  const status = row.status_code || row.status;
  const match = statusOptions.find((item) => item.value === status);
  return {
    label: row.status_label || match?.label || status || "未知",
    type: match?.type || "info",
  };
}

function credentialLabel(row: Account) {
  const value = row.credential_type || row.auth_credential_type || "none";
  return credentialOptions.find((item) => item.value === value)?.label || value;
}

function bindingLabel(binding: BoundPlatformService) {
  return `${binding.kind === "cpa" ? "CPA" : "Sub2API"} / ${binding.name}`;
}

function bindingTagType(binding: BoundPlatformService): "" | "success" | "warning" | "info" | "danger" {
  if (binding.lastPushStatus === "success") {
    return "success";
  }
  if (binding.lastPushStatus === "failed") {
    return "danger";
  }
  return "info";
}

function accountSourceLabel(row: Account) {
  if (row.source_name) {
    return `${row.source_name}${row.source_provider ? ` / ${row.source_provider}` : ""}`;
  }
  return "-";
}

function formatPercent(value: number | null | undefined) {
  return typeof value === "number" ? `${value.toFixed(2)}%` : "未返回";
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

function formatResetAt(value: string | null | undefined) {
  if (!value) {
    return "重置 -";
  }
  return `重置 ${new Date(value).toLocaleString()}`;
}

function usageWindows(row: Account): UsageWindow[] {
  const plan = String(row.plan ?? "").toLowerCase();
  const isFree = !plan || plan.includes("free");
  if (row.usage_windows?.length) {
    const windows = row.usage_windows.map((item) => ({
      ...item,
      label: item.window_key === "primary" ? "5小时" : item.window_key === "secondary" ? "7天" : item.label,
    }));
    if (isFree) {
      return windows.filter((item) => item.label.includes("7") || item.window_key === "secondary").slice(0, 1);
    }
    return windows;
  }
  if (row.remaining_percent != null || row.used_percent != null) {
    return [{
      window_key: "primary",
      label: isFree ? "7天" : "5小时",
      used_percent: row.used_percent,
      remaining_percent: row.remaining_percent,
      reset_at: row.reset_at,
      limit_reached: null,
    }];
  }
  return [];
}

function schedulePoll() {
  if (timer) {
    window.clearInterval(timer);
    timer = undefined;
  }
  if (!autoPoll.value) {
    return;
  }
  void autoCheckCurrentPage();
  timer = window.setInterval(() => void autoCheckCurrentPage(), Math.max(15, pollSeconds.value) * 1000);
}

onMounted(async () => {
  await load(true);
  await Promise.all([loadServices(), loadMailSources()]);
  schedulePoll();
});

watch(pushTarget, () => {
  selectedServiceIds.value = selectedServiceIds.value.filter((id) => availablePushServices.value.some((service) => service.id === id));
});

onBeforeUnmount(() => {
  if (timer) {
    window.clearInterval(timer);
  }
});

watch(pageSize, () => {
  currentPage.value = 1;
  schedulePoll();
});

watch(currentPage, () => {
  schedulePoll();
});
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">账号管理</h1>
        <p class="page-subtitle">多平台授权文件管理同步：同步外部凭据、统一绑定推送、自动 / 人工重登。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <el-button :icon="Refresh" type="primary" plain :loading="loading" @click="openSync">同步平台凭据</el-button>
        <el-button :icon="Download" type="primary" :loading="loading" @click="importAuth">导入 auth</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="load(false, true)">刷新列表</el-button>
      </div>
    </div>

    <el-card shadow="never" class="mb-4">
      <el-form :model="filters" label-position="left" class="filter-form">
        <div class="filter-grid">
          <el-form-item label="关键词">
            <el-input v-model="filters.q" clearable placeholder="邮箱/状态" @keyup.enter="load(false, true)"/>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="filters.status" clearable placeholder="全部" class="w-full">
              <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value"/>
            </el-select>
          </el-form-item>
          <el-form-item label="凭据">
            <el-select v-model="filters.credentialType" clearable placeholder="全部" class="w-full">
              <el-option v-for="item in credentialOptions" :key="item.value" :label="item.label" :value="item.value"/>
            </el-select>
          </el-form-item>
          <el-form-item label="绑定平台">
            <el-select v-model="bindingFilterServiceIds" multiple collapse-tags clearable filterable class="w-full"
                       placeholder="全部">
              <el-option v-for="service in enabledServices" :key="service.id"
                         :label="`${service.kind === 'cpa' ? 'CPA' : 'Sub2API'} / ${service.name}`"
                         :value="service.id"/>
            </el-select>
          </el-form-item>
          <el-form-item label="套餐">
            <el-input v-model="filters.plan" clearable placeholder="free/plus"/>
          </el-form-item>
          <el-form-item label="自动重登">
            <el-select v-model="filters.autoReauth" clearable placeholder="全部" class="w-full">
              <el-option label="开启" value="true"/>
              <el-option label="关闭" value="false"/>
            </el-select>
          </el-form-item>
          <el-form-item label="推送">
            <el-select v-model="filters.pushStatus" clearable placeholder="全部" class="w-full">
              <el-option label="已推送" value="pushed"/>
              <el-option label="未推送" value="not_pushed"/>
            </el-select>
          </el-form-item>
          <el-form-item>
            <div class="filter-actions flex w-full gap-2">
              <el-button :icon="Search" type="primary" class="flex-1" @click="load(false, true)">筛选</el-button>
              <el-button class="flex-1" @click="resetFilters">重置</el-button>
            </div>
          </el-form-item>
        </div>
      </el-form>
      <div class="mt-1 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap gap-1.5">
          <el-button @click="bulk('check')">批量检查</el-button>
          <el-button @click="bulk('refresh')">批量刷新</el-button>
          <el-button @click="bulk('reauth')">批量自动重登</el-button>
          <el-button @click="openPush()">批量推送</el-button>
          <el-button @click="openBindings()">批量绑定平台</el-button>
          <el-button @click="downloadAuth(selectedIds)">批量导出</el-button>
          <el-button type="danger" plain :icon="Delete" @click="openDeleteBulk">批量删除</el-button>
        </div>
        <div class="flex items-center gap-2">
          <el-switch v-model="autoPoll" active-text="自动检查当前页" :loading="autoChecking" @change="schedulePoll"/>
          <el-input-number v-model="pollSeconds" :min="15" :max="600" size="small" :disabled="autoChecking"
                           @change="schedulePoll"/>
          <span class="text-sm text-slate-500">秒</span>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <div class="data-table-wrap">
        <el-table v-loading="loading" :data="pagedAccounts" border row-key="id" class="w-full"
                  @selection-change="selected = $event">
          <el-table-column type="selection" width="46"/>
          <el-table-column label="邮箱" min-width="240" show-overflow-tooltip>
            <template #default="{row}">
              <div class="flex flex-col">
                <span class="text-sm font-medium">{{ row.email }}</span>
                <span class="text-xs text-slate-500">{{ credentialLabel(row) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="状态" min-width="170">
            <template #default="{row}">
              <div class="flex flex-col gap-1">
                <el-tag :type="statusTag(row).type" size="small">{{ statusTag(row).label }}</el-tag>
                <el-tag v-if="row.needs_manual_reauth" type="danger" size="small" effect="dark">需要人工重登</el-tag>
                <span class="text-xs text-slate-500">检查 {{ formatDate(row.last_check_at) }}</span>
                <el-tooltip v-if="row.last_error" :content="row.last_error" placement="top">
                  <span class="text-xs text-rose-500 line-clamp-1">{{ row.last_error }}</span>
                </el-tooltip>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="绑定平台" min-width="240">
            <template #default="{row}">
              <div v-if="row.platform_bindings?.length" class="flex flex-wrap gap-1">
                <el-tooltip v-for="binding in row.platform_bindings" :key="binding.id"
                            :content="`最近推送: ${binding.lastPushStatus || '-'}${binding.lastPushAt ? ' @ ' + formatDate(binding.lastPushAt) : ''}${binding.lastPushMessage ? '\n' + binding.lastPushMessage : ''}`"
                            placement="top">
                  <el-tag :type="bindingTagType(binding)" size="small" effect="plain">
                    {{ bindingLabel(binding) }}
                  </el-tag>
                </el-tooltip>
              </div>
              <span v-else class="text-slate-400">未绑定</span>
            </template>
          </el-table-column>
          <el-table-column label="邮箱来源" min-width="180" show-overflow-tooltip>
            <template #default="{row}">
              <div class="text-sm">{{ accountSourceLabel(row) }}</div>
              <div v-if="row.source_vendor || row.source_batch_note" class="text-xs text-slate-500">
                {{ [row.source_vendor, row.source_batch_note].filter(Boolean).join(" / ") }}
              </div>
              <div class="text-xs text-slate-400">
                密码 {{ row.has_password ? "已保存" : "未保存" }} · 自动重登 {{ row.auto_reauth ? "开启" : "关闭" }}
              </div>
            </template>
          </el-table-column>
          <el-table-column label="套餐 / 剩余" min-width="280">
            <template #default="{row}">
              <div class="text-xs text-slate-500">{{ row.plan || "-" }}</div>
              <div v-if="usageWindows(row).length" class="mt-1 space-y-1">
                <div v-for="window in usageWindows(row)" :key="window.window_key">
                  <div class="flex items-center gap-2">
                    <span class="w-10 text-xs text-slate-500">{{ window.label }}</span>
                    <el-progress :percentage="Math.max(0, Math.min(100, window.remaining_percent ?? 0))"
                                 :stroke-width="8" class="min-w-24 flex-1"/>
                    <span class="w-16 text-xs">{{ formatPercent(window.remaining_percent) }}</span>
                  </div>
                  <div class="ml-12 text-xs text-slate-500">{{ formatResetAt(window.reset_at) }}</div>
                </div>
              </div>
              <span v-else class="text-slate-400">未返回</span>
            </template>
          </el-table-column>
          <el-table-column label="凭据步骤" min-width="170" show-overflow-tooltip>
            <template #default="{row}">
              <el-tag
                  :type="row.step_status === 'failed' ? 'danger' : row.step_status === 'success' ? 'success' : 'warning'"
                  size="small" effect="plain">
                {{ row.current_step || "未检查" }}
              </el-tag>
              <div class="text-xs text-slate-500">{{ formatDate(row.last_step_at) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="260">
            <template #default="{row}">
              <div class="table-actions">
                <el-button link type="primary" @click="single(row.id, 'check')">检查</el-button>
                <el-button link type="primary" @click="single(row.id, 'refresh')">刷新</el-button>
                <el-dropdown trigger="click" @command="(mode: 'auto' | 'manual') => openReauth(row, mode)">
                  <el-button link :type="row.needs_manual_reauth ? 'danger' : 'warning'">重登
                    <el-icon class="el-icon--right">
                      <i-ep-arrow-down/>
                    </el-icon>
                  </el-button>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item command="auto">自动重登（密码 + 邮箱验证码）</el-dropdown-item>
                      <el-dropdown-item command="manual">人工重登（OAuth 回填）</el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
                <el-button link type="primary" @click="openPush(row)">推送</el-button>
                <el-button link type="primary" @click="openBindings(row)">绑定</el-button>
                <el-button link type="primary" @click="openProfile(row)">编辑</el-button>
                <el-button link type="primary" @click="openDetail(row)">详情</el-button>
                <el-button link type="primary" @click="downloadAuth([row.id])">导出</el-button>
                <el-button link type="danger" @click="openDeleteSingle(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
      <div class="mt-4 flex justify-end">
        <el-pagination v-model:current-page="currentPage" v-model:page-size="pageSize"
                       :page-sizes="[10, 20, 50, 100]" :total="accounts.length"
                       layout="total, sizes, prev, pager, next, jumper"/>
      </div>
    </el-card>

    <el-dialog v-model="profileDialog" title="编辑账号资料" width="480px">
      <el-alert title="密码会加密保存，本页面不会回显明文；留空表示不修改已保存密码。" type="info" show-icon class="mb-3"/>
      <el-form label-position="top">
        <el-form-item label="账号密码">
          <el-input v-model="passwordValue" type="password" show-password :disabled="clearPassword"
                    placeholder="留空不修改密码" @keyup.enter="saveProfile"/>
        </el-form-item>
        <el-form-item v-if="activeAccount?.has_password">
          <el-checkbox v-model="clearPassword" @change="passwordValue = ''">清空已保存密码</el-checkbox>
        </el-form-item>
        <el-form-item label="邮箱来源">
          <el-select v-model="accountSourceId" clearable filterable class="w-full" placeholder="未关联邮箱来源">
            <el-option v-for="source in mailSources" :key="source.id"
                       :label="`${source.name} / ${source.mail_type_name || source.provider}`" :value="source.id"/>
          </el-select>
        </el-form-item>
      </el-form>
      <div class="text-xs text-[var(--app-muted)]">修改邮箱来源会清空账号绑定的具体邮箱池记录，只保留来源关系。</div>
      <template #footer>
        <el-button @click="profileDialog = false">取消</el-button>
        <el-button type="primary" @click="saveProfile">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pushDialog" title="选择推送平台" width="440px">
      <el-alert title="不选择具体服务时，会按启用服务优先级推送；若没有服务，则回退到配置页的单组 CPA/Sub2API 配置。"
                type="info" show-icon class="mb-4"/>
      <el-radio-group v-model="pushTarget" class="grid w-full grid-cols-1 gap-2">
        <el-radio-button v-for="target in pushTargets" :key="target.value" :label="target.value">
          {{ target.label }}
        </el-radio-button>
      </el-radio-group>
      <div class="mt-4">
        <div class="mb-2 text-sm font-semibold text-[var(--app-text)]">指定服务</div>
        <el-select v-model="selectedServiceIds" multiple clearable filterable class="w-full"
                   placeholder="留空使用全部启用服务">
          <el-option v-for="service in availablePushServices" :key="service.id"
                     :label="`${service.kind === 'cpa' ? 'CPA' : 'Sub2API'} / ${service.name}`"
                     :value="service.id"/>
        </el-select>
        <div class="mt-2 text-xs text-[var(--app-muted)]">
          当前将推送 {{ pushScope === "single" ? 1 : selectedIds.length }} 个账号。
        </div>
      </div>
      <template #footer>
        <el-button @click="pushDialog = false">取消</el-button>
        <el-button type="primary" @click="confirmPush">
          {{ pushScope === "single" ? "推送当前账号" : `推送 ${selectedIds.length} 个账号` }}
        </el-button>
      </template>
    </el-dialog>

    <SyncDialog v-model="syncDialogVisible" :services="services" @finished="onSyncFinished"/>

    <el-dialog v-model="bindingDialog" title="设置同步平台" width="540px">
      <el-alert title="账号过期并自动重登成功后，只会回推到这里绑定的平台；未绑定账号不会自动推送。" type="info" show-icon
                class="mb-4"/>
      <el-form label-position="top">
        <el-form-item label="保存方式">
          <el-segmented v-model="bindingMode"
                        :options="[{label: '覆盖', value: 'replace'}, {label: '追加', value: 'append'}, {label: '清空', value: 'clear'}]"
                        class="w-full"/>
        </el-form-item>
        <el-form-item label="平台服务">
          <el-select v-model="selectedBindingServiceIds" multiple clearable filterable class="w-full"
                     :disabled="bindingMode === 'clear'" placeholder="选择需要绑定的平台">
            <el-option v-for="service in enabledServices" :key="service.id"
                       :label="`${service.kind === 'cpa' ? 'CPA' : 'Sub2API'} / ${service.name}`" :value="service.id"/>
          </el-select>
          <div class="mt-2 text-xs text-[var(--app-muted)]">
            当前将更新 {{ bindingScope === "single" ? 1 : selectedIds.length }} 个账号。
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="bindingDialog = false">取消</el-button>
        <el-button :icon="Setting" type="primary" @click="confirmBindings">保存绑定</el-button>
      </template>
    </el-dialog>

    <ReauthDialog v-model="reauthDialogVisible" :account="reauthAccount" :mode="reauthMode" @finished="onReauthFinished"/>

    <DeleteAccountDialog v-model="deleteDialogVisible" :accounts="deleteTargets" @deleted="onDeleted"/>

    <el-dialog v-model="detailDialog" title="账号详情" width="720px">
      <template v-if="activeAccount">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="邮箱">{{ activeAccount.email }}</el-descriptions-item>
          <el-descriptions-item label="Provider">{{ activeAccount.provider || "-" }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusTag(activeAccount).label }}</el-descriptions-item>
          <el-descriptions-item label="凭据">{{ credentialLabel(activeAccount) }}</el-descriptions-item>
          <el-descriptions-item label="是否需要人工重登">
            <el-tag v-if="activeAccount.needs_manual_reauth" type="danger">是</el-tag>
            <span v-else>否</span>
          </el-descriptions-item>
          <el-descriptions-item label="最近重登尝试">{{ formatDate(activeAccount.last_reauth_attempt_at) }}</el-descriptions-item>
          <el-descriptions-item label="最近重登错误" :span="2">{{ activeAccount.last_reauth_error || "-" }}</el-descriptions-item>
          <el-descriptions-item label="凭据来源">
            {{
              activeAccount.credential_source_kind && activeAccount.credential_source_kind !== "local"
                  ? `${activeAccount.credential_source_kind === "cpa" ? "CPA" : "Sub2API"}${activeAccount.credential_source_name ? " / " + activeAccount.credential_source_name : ""}`
                  : "本地"
            }}
          </el-descriptions-item>
          <el-descriptions-item label="最近同步">{{ formatDate(activeAccount.credential_synced_at) }}</el-descriptions-item>
          <el-descriptions-item label="账号密码">{{ activeAccount.has_password ? "已保存" : "未保存" }}</el-descriptions-item>
          <el-descriptions-item label="邮箱来源">{{ accountSourceLabel(activeAccount) }}</el-descriptions-item>
          <el-descriptions-item label="绑定平台" :span="2">
            <span v-if="!activeAccount.platform_bindings?.length">-</span>
            <span v-else>{{ activeAccount.platform_bindings.map(bindingLabel).join("，") }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="auth 文件" :span="2">
            <span class="mono">{{ activeAccount.auth_file_name || "-" }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="最近错误" :span="2">{{ activeAccount.last_error || "-" }}</el-descriptions-item>
        </el-descriptions>
        <el-timeline class="mt-5">
          <el-timeline-item :timestamp="formatDate(activeAccount.last_step_at)"
                            :type="activeAccount.step_status === 'failed' ? 'danger' : 'success'">
            {{ activeAccount.current_step || "未检查" }}
          </el-timeline-item>
          <el-timeline-item :timestamp="formatDate(activeAccount.last_refresh_at)">最近刷新</el-timeline-item>
          <el-timeline-item :timestamp="formatDate(activeAccount.last_auth_at)">最近授权</el-timeline-item>
        </el-timeline>
      </template>
    </el-dialog>
  </section>
</template>
