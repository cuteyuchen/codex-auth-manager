<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, reactive, ref, watch} from "vue";
import {useRouter} from "vue-router";
import {ElMessage} from "element-plus";
import {Delete, Download, Refresh, Setting} from "@element-plus/icons-vue";
import {
  apiGet,
  apiSend,
  type Account,
  type BoundPlatformService,
  type IntegrationService,
  type MailSource,
} from "../api";
import ReauthDialog from "../components/ReauthDialog.vue";
import SyncDialog from "../components/SyncDialog.vue";
import DeleteAccountDialog from "../components/DeleteAccountDialog.vue";
import StatusCell from "../components/accounts/StatusCell.vue";
import CredentialCell from "../components/accounts/CredentialCell.vue";
import UsageCell from "../components/accounts/UsageCell.vue";
import MailBindingCell from "../components/accounts/MailBindingCell.vue";
import PlatformBindingsCell from "../components/accounts/PlatformBindingsCell.vue";
import StepCell from "../components/accounts/StepCell.vue";
import RowActions from "../components/accounts/RowActions.vue";
import BulkActionsBar from "../components/accounts/BulkActionsBar.vue";
import FilterBar from "../components/accounts/FilterBar.vue";

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
const rowActionLoading = ref(new Set<number>());
const bulkActionLoading = ref(false);
const pushSubmitting = ref(false);
const bindingSubmitting = ref(false);
const profileSubmitting = ref(false);

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
  if (!service.enabled) return false;
  return pushTarget.value === "both" || service.kind === pushTarget.value;
}));

function buildQuery() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") params.set(key, value);
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
    if (!silent) ElMessage.success("账号列表已刷新");
    if (checkCurrentPage) schedulePoll();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function autoCheckCurrentPage() {
  if (!autoPoll.value || autoChecking.value || !pagedAccountIds.value.length) {
    if (autoChecking.value) pendingAutoCheck = true;
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
        if (!id) continue;
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
  Object.assign(filters, {q: "", status: "", credentialType: "", plan: "", autoReauth: "", pushStatus: ""});
  bindingFilterServiceIds.value = [];
  currentPage.value = 1;
  void load(false, true);
}

function onFiltersUpdate(value: typeof filters) {
  Object.assign(filters, value);
}

function onBindingFilterUpdate(value: number[]) {
  bindingFilterServiceIds.value = value;
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
  if (!disposition) return fallback;
  const encoded = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return decodeURIComponent(encoded);
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
        const payload = JSON.parse(text) as {error?: string};
        throw new Error(payload.error || text);
      } catch (error) {
        if (error instanceof SyntaxError) throw new Error(text);
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

async function singleCheck(id: number) {
  rowActionLoading.value = new Set([...rowActionLoading.value, id]);
  try {
    await apiSend(`/api/accounts/${id}/check`, "POST");
    ElMessage.success("检查完成");
    await load(true);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    const next = new Set(rowActionLoading.value);
    next.delete(id);
    rowActionLoading.value = next;
  }
}

async function singleRepair(id: number) {
  rowActionLoading.value = new Set([...rowActionLoading.value, id]);
  try {
    const result = await apiSend<{job: {id: number}}>(`/api/accounts/${id}/check`, "POST", {repair: true});
    ElMessage.success(`修复任务已创建 #${result.job.id}`);
    await router.push("/jobs");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    const next = new Set(rowActionLoading.value);
    next.delete(id);
    rowActionLoading.value = next;
  }
}

async function singleRefresh(id: number) {
  rowActionLoading.value = new Set([...rowActionLoading.value, id]);
  try {
    await apiSend(`/api/accounts/${id}/refresh`, "POST");
    ElMessage.success("刷新完成");
    await load(true);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    const next = new Set(rowActionLoading.value);
    next.delete(id);
    rowActionLoading.value = next;
  }
}

async function singlePush(id: number, target: "cpa" | "sub2api" | "both" = "both", serviceIds?: number[]) {
  rowActionLoading.value = new Set([...rowActionLoading.value, id]);
  try {
    await apiSend(`/api/accounts/${id}/push`, "POST", {target, serviceIds});
    ElMessage.success("推送完成");
    await load(true);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    const next = new Set(rowActionLoading.value);
    next.delete(id);
    rowActionLoading.value = next;
  }
}

async function bulk(action: "check" | "refresh" | "reauth" | "push" | "repair", target: "cpa" | "sub2api" | "both" = "both", serviceIds?: number[]) {
  if (!selectedIds.value.length) {
    ElMessage.warning("请先选择账号");
    return;
  }
  bulkActionLoading.value = true;
  try {
    const result = await apiSend<{job: {id: number}}>(`/api/accounts/bulk/${action}`, "POST", {
      ids: selectedIds.value,
      target,
      serviceIds,
    });
    ElMessage.success(`已创建批量任务 #${result.job.id}`);
    await router.push("/jobs");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    bulkActionLoading.value = false;
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
  bindingSubmitting.value = true;
  try {
    if (bindingScope.value === "single") {
      if (!activeAccount.value) return;
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
  } finally {
    bindingSubmitting.value = false;
  }
}

async function confirmPush() {
  pushSubmitting.value = true;
  try {
    if (pushScope.value === "single") {
      if (!activeAccount.value) return;
      await singlePush(activeAccount.value.id, pushTarget.value, selectedServiceIds.value);
    } else {
      await bulk("push", pushTarget.value, selectedServiceIds.value);
    }
    pushDialog.value = false;
  } finally {
    pushSubmitting.value = false;
  }
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
        const payload = await apiGet<{hasPassword: boolean; password: string}>(`/api/accounts/${row.id}/password`);
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
  if (!activeAccount.value) return;
  profileSubmitting.value = true;
  try {
    const payload: {password?: string; sourceId: number | null} = {sourceId: accountSourceId.value};
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
  } finally {
    profileSubmitting.value = false;
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

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function accountSourceLabel(row: Account) {
  if (row.source_name) return `${row.source_name}${row.source_provider ? ` / ${row.source_provider}` : ""}`;
  return "-";
}

function bindingLabel(binding: BoundPlatformService) {
  return `${binding.kind === "cpa" ? "CPA" : "Sub2API"} / ${binding.name}`;
}

function schedulePoll() {
  if (timer) {
    window.clearInterval(timer);
    timer = undefined;
  }
  if (!autoPoll.value) return;
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
  if (timer) window.clearInterval(timer);
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

    <!-- 筛选区 -->
    <el-card shadow="never" class="mb-4">
      <FilterBar :filters="filters" :binding-filter-service-ids="bindingFilterServiceIds"
                 :enabled-services="enabledServices"
                 @search="load(false, true)"
                 @reset="resetFilters"
                 @update:filters="onFiltersUpdate"
                 @update:binding-filter-service-ids="onBindingFilterUpdate"/>

      <!-- 批量操作条 + 自动刷新 -->
      <div class="mt-1 flex flex-wrap items-center justify-between gap-3">
        <BulkActionsBar :loading="bulkActionLoading" :selected-count="selectedIds.length"
                        @check="bulk('check')"
                        @repair="bulk('repair')"
                        @refresh="bulk('refresh')"
                        @reauth="bulk('reauth')"
                        @push="openPush()"
                        @bindings="openBindings()"
                        @export="downloadAuth(selectedIds)"
                        @delete="openDeleteBulk"/>
        <div class="flex items-center gap-2">
          <el-switch v-model="autoPoll" active-text="自动检查当前页" :loading="autoChecking" @change="schedulePoll"/>
          <el-input-number v-model="pollSeconds" :min="15" :max="600" size="small" :disabled="autoChecking"
                           @change="schedulePoll"/>
          <span class="text-sm text-slate-500">秒</span>
        </div>
      </div>
    </el-card>

    <!-- 数据表格 -->
    <el-card shadow="never">
      <div class="data-table-wrap">
        <el-table v-loading="loading" :data="pagedAccounts" border row-key="id" class="w-full"
                  @selection-change="selected = $event">
          <el-table-column type="selection" width="46"/>
          <el-table-column label="邮箱" min-width="220" show-overflow-tooltip>
            <template #default="{row}">
              <CredentialCell :row="row"/>
            </template>
          </el-table-column>
          <el-table-column label="状态" min-width="170">
            <template #default="{row}">
              <StatusCell :row="row"/>
            </template>
          </el-table-column>
          <el-table-column label="绑定平台" min-width="200">
            <template #default="{row}">
              <PlatformBindingsCell :row="row"/>
            </template>
          </el-table-column>
          <el-table-column label="邮箱 / 邮箱绑定" min-width="200" show-overflow-tooltip>
            <template #default="{row}">
              <MailBindingCell :row="row"/>
            </template>
          </el-table-column>
          <el-table-column label="套餐 / 剩余" min-width="280">
            <template #default="{row}">
              <UsageCell :row="row"/>
            </template>
          </el-table-column>
          <el-table-column label="凭据步骤" min-width="170" show-overflow-tooltip>
            <template #default="{row}">
              <StepCell :row="row"/>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="220">
            <template #default="{row}">
              <RowActions :row="row" :loading="rowActionLoading.has(row.id)"
                          @check="singleCheck"
                          @repair="singleRepair"
                          @refresh="singleRefresh"
                          @reauth="(r, m) => openReauth(r, m)"
                          @push="(r) => openPush(r)"
                          @bindings="(r) => openBindings(r)"
                          @profile="(r) => openProfile(r)"
                          @detail="(r) => openDetail(r)"
                          @export="(id) => downloadAuth([id])"
                          @delete="(r) => openDeleteSingle(r)"/>
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

    <!-- 编辑账号资料 -->
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
        <el-button type="primary" :loading="profileSubmitting" @click="saveProfile">保存</el-button>
      </template>
    </el-dialog>

    <!-- 推送选择 -->
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
        <el-button type="primary" :loading="pushSubmitting" @click="confirmPush">
          {{ pushScope === "single" ? "推送当前账号" : `推送 ${selectedIds.length} 个账号` }}
        </el-button>
      </template>
    </el-dialog>

    <SyncDialog v-model="syncDialogVisible" :services="services" @finished="onSyncFinished"/>

    <!-- 绑定平台 -->
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
        <el-button :icon="Setting" type="primary" :loading="bindingSubmitting" @click="confirmBindings">保存绑定</el-button>
      </template>
    </el-dialog>

    <ReauthDialog v-model="reauthDialogVisible" :account="reauthAccount" :mode="reauthMode" @finished="onReauthFinished"/>

    <DeleteAccountDialog v-model="deleteDialogVisible" :accounts="deleteTargets" @deleted="onDeleted"/>

    <!-- 账号详情 -->
    <el-dialog v-model="detailDialog" title="账号详情" width="720px">
      <template v-if="activeAccount">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="邮箱">{{ activeAccount.email }}</el-descriptions-item>
          <el-descriptions-item label="Provider">{{ activeAccount.provider || "-" }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ activeAccount.status_label || activeAccount.status }}</el-descriptions-item>
          <el-descriptions-item label="凭据">
            {{ activeAccount.credential_type || activeAccount.auth_credential_type || "none" }}
          </el-descriptions-item>
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
          <el-descriptions-item label="绑定邮箱">
            <el-tag v-if="activeAccount.mailbox_id" type="success" size="small">已绑定 #{{ activeAccount.mailbox_id }}</el-tag>
            <span v-else class="text-slate-400">未绑定</span>
          </el-descriptions-item>
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
