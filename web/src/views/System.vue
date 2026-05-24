<script setup lang="ts">
import {onMounted, reactive, ref} from "vue";
import {ElMessage, ElMessageBox} from "element-plus";
import {Delete, Download, Refresh} from "@element-plus/icons-vue";
import {apiGet, apiSend} from "../api";

interface DatabaseInfo {
  path: string;
  sizeBytes: number;
  accounts: number;
  authFiles: number;
  mailSources: number;
  mailboxes: number;
  jobs: number;
  jobEvents: number;
  integrationServices: number;
}

const loading = ref(false);
const backingUp = ref(false);
const cleaning = ref(false);
const info = ref<DatabaseInfo | null>(null);
const cleanupForm = reactive({
  keepLatest: 100,
  before: "",
});

async function load() {
  loading.value = true;
  try {
    info.value = await apiGet<DatabaseInfo>("/api/system/database");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

function formatSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function filenameFromDisposition(disposition: string | null) {
  const encoded = disposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  return encoded ? decodeURIComponent(encoded) : "codex-auth-manager.db";
}

async function backup() {
  backingUp.value = true;
  try {
    const response = await fetch("/api/system/database/backup", {method: "POST"});
    if (!response.ok) {
      throw new Error(await response.text());
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement("a");
    link.href = url;
    link.download = filenameFromDisposition(response.headers.get("Content-Disposition"));
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    ElMessage.success("数据库备份已生成");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    backingUp.value = false;
  }
}

async function cleanup() {
  try {
    await ElMessageBox.confirm("清理只会删除已完成/失败/取消的历史任务和日志，不会删除账号、auth、邮箱和配置。确定继续？", "清理任务日志", {
      type: "warning",
      confirmButtonText: "清理",
      cancelButtonText: "取消",
    });
    cleaning.value = true;
    const result = await apiSend<{deletedJobs: number; deletedEvents: number}>("/api/system/jobs/cleanup", "POST", {
      keepLatest: cleanupForm.keepLatest,
      before: cleanupForm.before || undefined,
    });
    ElMessage.success(`已清理任务 ${result.deletedJobs} 个，日志 ${result.deletedEvents} 条`);
    await load();
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(error instanceof Error ? error.message : String(error));
    }
  } finally {
    cleaning.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">系统维护</h1>
        <p class="page-subtitle">查看 SQLite 运行数据、备份数据库并清理历史任务日志。</p>
      </div>
      <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-row :gutter="14" class="mb-4">
      <el-col :xs="12" :lg="6">
        <el-card shadow="never"><el-statistic title="账号" :value="info?.accounts ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never"><el-statistic title="邮箱库存" :value="info?.mailboxes ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never"><el-statistic title="任务" :value="info?.jobs ?? 0" /></el-card>
      </el-col>
      <el-col :xs="12" :lg="6">
        <el-card shadow="never"><el-statistic title="任务日志" :value="info?.jobEvents ?? 0" /></el-card>
      </el-col>
    </el-row>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="12">
        <el-card shadow="never">
          <template #header>数据库</template>
          <el-descriptions :column="1" border>
            <el-descriptions-item label="路径"><span class="mono">{{ info?.path || "-" }}</span></el-descriptions-item>
            <el-descriptions-item label="大小">{{ formatSize(info?.sizeBytes ?? 0) }}</el-descriptions-item>
            <el-descriptions-item label="auth 文件">{{ info?.authFiles ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="邮箱来源">{{ info?.mailSources ?? 0 }}</el-descriptions-item>
            <el-descriptions-item label="推送服务">{{ info?.integrationServices ?? 0 }}</el-descriptions-item>
          </el-descriptions>
          <div class="mt-4 flex justify-end">
            <el-button :icon="Download" type="primary" :loading="backingUp" @click="backup">下载备份</el-button>
          </div>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="12">
        <el-card shadow="never">
          <template #header>任务日志清理</template>
          <el-alert title="仅清理已结束任务；运行中和等待输入的任务不会被删除。" type="info" show-icon class="mb-4" />
          <el-form label-position="top" :model="cleanupForm">
            <el-form-item label="至少保留最近任务数">
              <el-input-number v-model="cleanupForm.keepLatest" :min="0" :max="1000" class="w-full" />
            </el-form-item>
            <el-form-item label="只清理早于该时间的任务">
              <el-date-picker
                v-model="cleanupForm.before"
                type="datetime"
                value-format="YYYY-MM-DDTHH:mm:ss.sssZ"
                placeholder="不填则不限制时间"
                class="w-full"
              />
            </el-form-item>
            <el-button :icon="Delete" type="danger" :loading="cleaning" @click="cleanup">清理历史任务</el-button>
          </el-form>
        </el-card>
      </el-col>
    </el-row>
  </section>
</template>
