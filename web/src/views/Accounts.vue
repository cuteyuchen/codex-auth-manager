<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, reactive, ref, watch} from "vue";
import {useRouter} from "vue-router";
import {ElMessage} from "element-plus";
import {
  Download,
  Refresh,
  Search,
} from "@element-plus/icons-vue";
import {apiGet, apiSend, type Account, type IntegrationService, type UsageWindow} from "../api";

const router = useRouter();
const accounts = ref<Account[]>([]);
const selected = ref<Account[]>([]);
const loading = ref(false);
const autoPoll = ref(true);
const pollSeconds = ref(60);
const currentPage = ref(1);
const pageSize = ref(20);
const passwordDialog = ref(false);
const detailDialog = ref(false);
const pushDialog = ref(false);
const activeAccount = ref<Account | null>(null);
const passwordValue = ref("");
const pushTarget = ref<"cpa" | "sub2api" | "both">("cpa");
const pushScope = ref<"single" | "bulk">("single");
const services = ref<IntegrationService[]>([]);
const selectedServiceIds = ref<number[]>([]);
let timer: number | undefined;

const filters = reactive({
  q: "",
  status: "",
  credentialType: "",
  provider: "",
  plan: "",
  autoReauth: "",
});

const statusOptions = [
  {label: "正常", value: "authorized", type: "success"},
  {label: "额度已用尽", value: "quota_exhausted", type: "warning"},
  {label: "凭据过期", value: "credential_expired", type: "danger"},
  {label: "账号异常", value: "account_abnormal", type: "danger"},
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
  params.set("pageSize", "300");
  return params.toString();
}

async function load(silent = false) {
  loading.value = true;
  try {
    const payload = await apiGet<{accounts: Account[]}>(`/api/accounts?${buildQuery()}`);
    accounts.value = payload.accounts;
    if ((currentPage.value - 1) * pageSize.value >= accounts.value.length) {
      currentPage.value = 1;
    }
    if (!silent) {
      ElMessage.success("账号列表已刷新");
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

async function loadServices() {
  try {
    const payload = await apiGet<{services: IntegrationService[]}>("/api/integration-services");
    services.value = payload.services;
  } catch {
    services.value = [];
  }
}

function resetFilters() {
  Object.assign(filters, {
    q: "",
    status: "",
    credentialType: "",
    provider: "",
    plan: "",
    autoReauth: "",
  });
  void load();
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
        const payload = JSON.parse(text) as {error?: string};
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
  action: "check" | "refresh" | "reauth" | "push",
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
    } else if (action === "reauth") {
      const result = await apiSend<{job: {id: number}}>(`/api/accounts/${id}/reauth`, "POST");
      ElMessage.success(`已创建重新授权任务 #${result.job.id}`);
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
    const result = await apiSend<{job: {id: number}}>(`/api/accounts/bulk/${action}`, "POST", {
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

function openPassword(row: Account) {
  activeAccount.value = row;
  passwordValue.value = "";
  passwordDialog.value = true;
}

async function savePassword() {
  if (!activeAccount.value) {
    return;
  }
  try {
    await apiSend(`/api/accounts/${activeAccount.value.id}/password`, "PUT", {password: passwordValue.value});
    ElMessage.success("密码已保存");
    passwordDialog.value = false;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function openDetail(row: Account) {
  activeAccount.value = row;
  detailDialog.value = true;
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

function formatPercent(value: number | null | undefined) {
  return typeof value === "number" ? `${value.toFixed(2)}%` : "未返回";
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
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
  }
  if (!autoPoll.value) {
    return;
  }
  timer = window.setInterval(() => void load(true), Math.max(15, pollSeconds.value) * 1000);
}

onMounted(async () => {
  await load(true);
  await loadServices();
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
});
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">账号管理</h1>
        <p class="page-subtitle">导入 auth、检查状态、刷新凭据、重登授权和推送远端。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <el-button :icon="Download" type="primary" :loading="loading" @click="importAuth">导入 auth</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="load()">刷新列表</el-button>
      </div>
    </div>

    <el-card shadow="never" class="mb-4">
      <el-form :model="filters" label-position="left" class="filter-form">
        <div class="filter-grid">
          <el-form-item label="关键词">
            <el-input v-model="filters.q" clearable placeholder="邮箱/状态" @keyup.enter="load()" />
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="filters.status" clearable placeholder="全部" class="w-full">
              <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="凭据">
            <el-select v-model="filters.credentialType" clearable placeholder="全部" class="w-full">
              <el-option v-for="item in credentialOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="Provider">
            <el-input v-model="filters.provider" clearable placeholder="hotmail/gmail" />
          </el-form-item>
          <el-form-item label="套餐">
            <el-input v-model="filters.plan" clearable placeholder="free/plus" />
          </el-form-item>
          <el-form-item label="自动重登">
            <el-select v-model="filters.autoReauth" clearable placeholder="全部" class="w-full">
              <el-option label="开启" value="true" />
              <el-option label="关闭" value="false" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <div class="filter-actions flex w-full gap-2">
              <el-button :icon="Search" type="primary" class="flex-1" @click="load()">筛选</el-button>
              <el-button class="flex-1" @click="resetFilters">重置</el-button>
            </div>
          </el-form-item>
        </div>
      </el-form>
      <div class="mt-1 flex flex-wrap items-center justify-between gap-3">
        <div class="flex flex-wrap gap-1.5">
          <el-button @click="bulk('check')">批量检查</el-button>
          <el-button @click="bulk('refresh')">批量刷新</el-button>
          <el-button @click="bulk('reauth')">批量重登</el-button>
          <el-button @click="openPush()">批量推送</el-button>
          <el-button @click="downloadAuth(selectedIds)">批量导出</el-button>
        </div>
        <div class="flex items-center gap-2">
          <el-switch v-model="autoPoll" active-text="自动检查状态" @change="schedulePoll" />
          <el-input-number v-model="pollSeconds" :min="15" :max="600" size="small" @change="schedulePoll" />
          <span class="text-sm text-slate-500">秒</span>
        </div>
      </div>
    </el-card>

    <el-card shadow="never">
      <div class="data-table-wrap">
        <el-table
          v-loading="loading"
          :data="pagedAccounts"
          border
          row-key="id"
          class="w-full"
          @selection-change="selected = $event"
        >
          <el-table-column type="selection" width="46" />
          <el-table-column prop="email" label="邮箱" min-width="220" show-overflow-tooltip />
          <el-table-column label="状态" width="150">
            <template #default="{row}">
              <el-tag :type="statusTag(row).type">{{ statusTag(row).label }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="凭据" width="160">
            <template #default="{row}">
              <el-tag effect="plain">{{ credentialLabel(row) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="plan" label="套餐" width="110">
            <template #default="{row}">{{ row.plan || "-" }}</template>
          </el-table-column>
          <el-table-column label="套餐剩余" min-width="230">
            <template #default="{row}">
              <div v-if="usageWindows(row).length" class="space-y-1">
                <div v-for="window in usageWindows(row)" :key="window.window_key" class="flex items-center gap-2">
                  <span class="w-12 text-xs text-slate-500">{{ window.label }}</span>
                  <el-progress :percentage="Math.max(0, Math.min(100, window.remaining_percent ?? 0))" :stroke-width="8" class="min-w-28 flex-1" />
                  <span class="w-16 text-xs">{{ formatPercent(window.remaining_percent) }}</span>
                </div>
              </div>
              <span v-else class="text-slate-400">未返回</span>
            </template>
          </el-table-column>
          <el-table-column label="凭据步骤" min-width="170" show-overflow-tooltip>
            <template #default="{row}">
              <el-tag :type="row.step_status === 'failed' ? 'danger' : row.step_status === 'success' ? 'success' : 'warning'" effect="plain">
                {{ row.current_step || "未检查" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="最近检查" width="170">
            <template #default="{row}">{{ formatDate(row.last_check_at) }}</template>
          </el-table-column>
          <el-table-column label="添加时间" width="170">
            <template #default="{row}">{{ formatDate(row.created_at) }}</template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="300">
            <template #default="{row}">
              <div class="table-actions">
                <el-button link type="primary" @click="openDetail(row)">详情</el-button>
                <el-button link type="primary" @click="single(row.id, 'check')">检查</el-button>
                <el-button link type="primary" @click="single(row.id, 'refresh')">刷新</el-button>
                <el-popconfirm title="确定重新登录授权这个账号？" @confirm="single(row.id, 'reauth')">
                  <template #reference>
                    <el-button link type="warning">重登</el-button>
                  </template>
                </el-popconfirm>
                <el-button link type="primary" @click="openPush(row)">推送</el-button>
                <el-button link type="primary" @click="downloadAuth([row.id])">导出</el-button>
                <el-button link type="primary" @click="openPassword(row)">密码</el-button>
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
          :total="accounts.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </el-card>

    <el-dialog v-model="passwordDialog" title="保存账号密码" width="420px">
      <el-alert title="密码会加密保存，本页面不会回显明文。" type="info" show-icon class="mb-3" />
      <el-input v-model="passwordValue" type="password" show-password placeholder="账号密码" @keyup.enter="savePassword" />
      <template #footer>
        <el-button @click="passwordDialog = false">取消</el-button>
        <el-button type="primary" @click="savePassword">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="pushDialog" title="选择推送平台" width="440px">
      <el-alert
        title="不选择具体服务时，会按启用服务优先级推送；若没有服务，则回退到配置页的单组 CPA/Sub2API 配置。"
        type="info"
        show-icon
        class="mb-4"
      />
      <el-radio-group v-model="pushTarget" class="grid w-full grid-cols-1 gap-2">
        <el-radio-button v-for="target in pushTargets" :key="target.value" :label="target.value">
          {{ target.label }}
        </el-radio-button>
      </el-radio-group>
      <div class="mt-4">
        <div class="mb-2 text-sm font-semibold text-[var(--app-text)]">指定服务</div>
        <el-select
          v-model="selectedServiceIds"
          multiple
          clearable
          filterable
          class="w-full"
          placeholder="留空使用全部启用服务"
        >
          <el-option
            v-for="service in availablePushServices"
            :key="service.id"
            :label="`${service.kind === 'cpa' ? 'CPA' : 'Sub2API'} / ${service.name}`"
            :value="service.id"
          />
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

    <el-dialog v-model="detailDialog" title="账号详情" width="720px">
      <template v-if="activeAccount">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="邮箱">{{ activeAccount.email }}</el-descriptions-item>
          <el-descriptions-item label="Provider">{{ activeAccount.provider || "-" }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusTag(activeAccount).label }}</el-descriptions-item>
          <el-descriptions-item label="凭据">{{ credentialLabel(activeAccount) }}</el-descriptions-item>
          <el-descriptions-item label="auth 文件">
            <span class="mono">{{ activeAccount.auth_file_name || "-" }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="最近错误">{{ activeAccount.last_error || "-" }}</el-descriptions-item>
        </el-descriptions>
        <el-timeline class="mt-5">
          <el-timeline-item :timestamp="formatDate(activeAccount.last_step_at)" :type="activeAccount.step_status === 'failed' ? 'danger' : 'success'">
            {{ activeAccount.current_step || "未检查" }}
          </el-timeline-item>
          <el-timeline-item :timestamp="formatDate(activeAccount.last_refresh_at)">最近刷新</el-timeline-item>
          <el-timeline-item :timestamp="formatDate(activeAccount.last_auth_at)">最近授权</el-timeline-item>
        </el-timeline>
      </template>
    </el-dialog>
  </section>
</template>
