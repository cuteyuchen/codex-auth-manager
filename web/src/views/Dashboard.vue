<script setup lang="ts">
import {computed, onMounted, ref, watch} from "vue";
import {useRouter} from "vue-router";
import {ElMessage} from "element-plus";
import {Connection, Message, Refresh, Warning} from "@element-plus/icons-vue";
import {apiGet, type Job} from "../api";

interface DashboardPayload {
  stats: {
    total: number;
    ok: number;
    limited: number;
    invalid: number;
    remaining: number;
    planGroups: PlanGroup[];
  };
  scheduler: {
    enabled: boolean;
    dailyTime: string;
    lastRunStatus: string;
    nextRunHint: string;
  };
  mailboxes: {
    total: number;
    unused: number;
    failed: number;
    sources: number;
  };
  services: {
    cpa: number;
    sub2api: number;
  };
  heroSms: {
    configured: boolean;
    country: number;
  };
  jobs: Job[];
}

interface PlanGroup {
  plan: "free" | "plus" | "pro" | "team";
  count: number;
  limited: number;
  averageUsed: number | null;
  averageRemaining: number | null;
}

const router = useRouter();
const loading = ref(false);
const data = ref<DashboardPayload | null>(null);
const currentPage = ref(1);
const pageSize = ref(10);
const pagedJobs = computed(() => (data.value?.jobs ?? []).slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const waitingJobs = computed(() => (data.value?.jobs ?? []).filter((job) => job.status === "waiting_input"));
const failedJobs = computed(() => (data.value?.jobs ?? []).filter((job) => job.status === "failed"));
const planGroups = computed<PlanGroup[]>(() => data.value?.stats.planGroups ?? []);
const planLabels: Record<PlanGroup["plan"], string> = {
  free: "Free",
  plus: "Plus",
  pro: "Pro",
  team: "Team",
};

async function load() {
  loading.value = true;
  try {
    data.value = await apiGet<DashboardPayload>("/api/dashboard");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

function jobType(status: string) {
  if (status === "success") {
    return "success";
  }
  if (status === "failed") {
    return "danger";
  }
  if (status === "running" || status === "waiting_input") {
    return "warning";
  }
  return "info";
}

function planTagType(group: PlanGroup) {
  if (group.limited > 0) {
    return "danger";
  }
  if (group.count > 0) {
    return "success";
  }
  return "info";
}

function formatPercent(value: number | null | undefined) {
  return typeof value === "number" ? `${value.toFixed(1)}%` : "-";
}

function progressValue(value: number | null | undefined) {
  return typeof value === "number" ? Math.min(100, Math.max(0, value)) : 0;
}

onMounted(load);
watch(pageSize, () => {
  currentPage.value = 1;
});
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">概览</h1>
        <p class="page-subtitle">账号池、凭据状态、调度状态和最近任务。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-row :gutter="14" class="mb-4">
      <el-col :xs="12" :lg="6">
        <el-card shadow="never" class="metric-card" @click="router.push('/accounts')"><el-statistic title="账号总数" :value="data?.stats.total ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never" class="metric-card" @click="router.push('/accounts')"><el-statistic title="可用账号" :value="data?.stats.ok ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never" class="metric-card" @click="router.push('/accounts')"><el-statistic title="额度风险" :value="data?.stats.limited ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never" class="metric-card" @click="router.push('/accounts')"><el-statistic title="异常账号" :value="data?.stats.invalid ?? 0" /></el-card>
      </el-col>
    </el-row>

    <el-card shadow="never" class="mb-4">
      <template #header>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <strong>账号类别额度</strong>
          <el-button link type="primary" @click="router.push('/accounts')">查看账号</el-button>
        </div>
      </template>
      <el-row :gutter="12">
        <el-col v-for="group in planGroups" :key="group.plan" :xs="24" :sm="12" :xl="6">
          <div class="plan-quota-card">
            <div class="flex items-center justify-between gap-2">
              <div>
                <div class="text-sm text-[var(--app-muted)]">账号类别</div>
                <div class="mt-1 text-xl font-bold text-[var(--app-text)]">{{ planLabels[group.plan] }}</div>
              </div>
              <el-tag :type="planTagType(group)" effect="plain">{{ group.count }} 个</el-tag>
            </div>
            <div class="mt-4">
              <div class="mb-2 flex items-center justify-between text-sm">
                <span class="text-[var(--app-muted)]">平均已用</span>
                <strong>{{ formatPercent(group.averageUsed) }}</strong>
              </div>
              <el-progress :percentage="progressValue(group.averageUsed)" :stroke-width="8" :show-text="false" />
            </div>
            <div class="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div>
                <div class="text-[var(--app-muted)]">平均剩余</div>
                <div class="mt-1 font-semibold text-[var(--app-text)]">{{ formatPercent(group.averageRemaining) }}</div>
              </div>
              <div>
                <div class="text-[var(--app-muted)]">风险账号</div>
                <div class="mt-1 font-semibold" :class="group.limited > 0 ? 'text-red-600' : 'text-[var(--app-text)]'">{{ group.limited }}</div>
              </div>
            </div>
          </div>
        </el-col>
      </el-row>
    </el-card>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="8">
        <el-card shadow="never" class="mb-4">
          <template #header>
            <div class="flex items-center gap-2">
              <el-icon><Message /></el-icon>
              <strong>邮箱库存</strong>
            </div>
          </template>
          <div class="grid grid-cols-3 gap-3">
            <el-statistic title="来源" :value="data?.mailboxes.sources ?? 0" />
            <el-statistic title="未用" :value="data?.mailboxes.unused ?? 0" />
            <el-statistic title="失败" :value="data?.mailboxes.failed ?? 0" />
          </div>
          <el-button class="mt-4 w-full" @click="router.push('/mailboxes')">查看邮箱池</el-button>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="flex items-center gap-2">
              <el-icon><Connection /></el-icon>
              <strong>推送服务</strong>
            </div>
          </template>
          <div class="flex flex-wrap gap-2">
            <el-tag :type="(data?.services.cpa ?? 0) > 0 ? 'success' : 'warning'">CPA {{ data?.services.cpa ?? 0 }}</el-tag>
            <el-tag :type="(data?.services.sub2api ?? 0) > 0 ? 'success' : 'warning'">Sub2API {{ data?.services.sub2api ?? 0 }}</el-tag>
            <el-tag :type="data?.heroSms.configured ? 'success' : 'info'">HeroSMS {{ data?.heroSms.configured ? `国家 ${data.heroSms.country}` : "未配置" }}</el-tag>
          </div>
          <el-button class="mt-4 w-full" @click="router.push('/services')">管理推送服务</el-button>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="6">
        <el-card shadow="never">
          <template #header>定时刷新</template>
          <el-descriptions :column="1" border>
            <el-descriptions-item label="状态">
              <el-tag :type="data?.scheduler.enabled ? 'success' : 'info'">{{ data?.scheduler.enabled ? "启用" : "关闭" }}</el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="计划">{{ data?.scheduler.nextRunHint || "-" }}</el-descriptions-item>
            <el-descriptions-item label="上次结果">{{ data?.scheduler.lastRunStatus || "never" }}</el-descriptions-item>
          </el-descriptions>
        </el-card>
        <el-card shadow="never" class="mt-4">
          <template #header>
            <div class="flex items-center gap-2">
              <el-icon><Warning /></el-icon>
              <strong>需要处理</strong>
            </div>
          </template>
          <div class="grid grid-cols-2 gap-3">
            <el-statistic title="等待输入" :value="waitingJobs.length" />
            <el-statistic title="失败任务" :value="failedJobs.length" />
          </div>
          <el-button class="mt-4 w-full" @click="router.push('/jobs')">查看任务</el-button>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="10">
        <el-card shadow="never">
          <template #header>最近任务</template>
          <el-table :data="pagedJobs" border>
            <el-table-column prop="id" label="ID" width="80" />
            <el-table-column prop="title" label="标题" min-width="220" show-overflow-tooltip />
            <el-table-column label="状态" width="130">
              <template #default="{row}">
                <el-tag :type="jobType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="created_at" label="创建时间" width="190" />
          </el-table>
          <div class="mt-4 flex justify-end">
            <el-pagination
              v-model:current-page="currentPage"
              v-model:page-size="pageSize"
              :page-sizes="[5, 10, 20]"
              :total="data?.jobs.length ?? 0"
              layout="total, sizes, prev, pager, next"
            />
          </div>
        </el-card>
      </el-col>
    </el-row>
  </section>
</template>

<style scoped>
.metric-card {
  cursor: pointer;
}

.metric-card:hover {
  border-color: var(--app-primary) !important;
}

.plan-quota-card {
  min-height: 172px;
  border: 1px solid var(--app-border);
  border-radius: 8px;
  background: var(--app-surface-soft);
  padding: 16px;
}
</style>
