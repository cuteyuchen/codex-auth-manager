<script setup lang="ts">
import {computed, onMounted, ref, watch} from "vue";
import {ElMessage} from "element-plus";
import {Refresh} from "@element-plus/icons-vue";
import {apiGet, type Job} from "../api";

interface DashboardPayload {
  stats: {
    total: number;
    ok: number;
    limited: number;
    invalid: number;
    remaining: number;
  };
  scheduler: {
    enabled: boolean;
    dailyTime: string;
    lastRunStatus: string;
    nextRunHint: string;
  };
  jobs: Job[];
}

const loading = ref(false);
const data = ref<DashboardPayload | null>(null);
const currentPage = ref(1);
const pageSize = ref(10);
const pagedJobs = computed(() => (data.value?.jobs ?? []).slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));

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
        <el-card shadow="never"><el-statistic title="账号总数" :value="data?.stats.total ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never"><el-statistic title="可用账号" :value="data?.stats.ok ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never"><el-statistic title="额度风险" :value="data?.stats.limited ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never"><el-statistic title="异常账号" :value="data?.stats.invalid ?? 0" /></el-card>
      </el-col>
    </el-row>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="9">
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
      </el-col>
      <el-col :xs="24" :lg="15">
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
