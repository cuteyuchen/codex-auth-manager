<script setup lang="ts">
import {ref, watch} from "vue";
import {ElMessage} from "element-plus";
import {apiGet, apiSend, type IntegrationService, type Job, type JobEvent} from "../api";

const props = defineProps<{
  modelValue: boolean;
  services: IntegrationService[];
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "finished"): void;
}>();

const selectedServiceIds = ref<number[]>([]);
const checkAfter = ref(true);
const job = ref<Job | null>(null);
const events = ref<JobEvent[]>([]);
const finalized = ref(false);
const summary = ref<Record<string, unknown> | null>(null);
let eventSource: EventSource | null = null;
let lastEventId = 0;

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function reset() {
  selectedServiceIds.value = [];
  checkAfter.value = true;
  job.value = null;
  events.value = [];
  summary.value = null;
  finalized.value = false;
}

function close() {
  closeStream();
  emit("update:modelValue", false);
}

async function refreshJob() {
  if (!job.value) {
    return;
  }
  try {
    const [jobPayload, eventsPayload] = await Promise.all([
      apiGet<{ job: Job }>(`/api/jobs/${job.value.id}`),
      apiGet<{ events: JobEvent[] }>(`/api/jobs/${job.value.id}/events?after=0`),
    ]);
    job.value = jobPayload.job;
    events.value = eventsPayload.events ?? [];
    if (events.value.length) {
      lastEventId = Math.max(...events.value.map((event) => event.id));
    }
    if (jobPayload.job.result) {
      const inner = (jobPayload.job.result as Record<string, unknown>).result ?? jobPayload.job.result;
      summary.value = inner as Record<string, unknown>;
    }
  } catch (error) {
    console.warn("拉取同步任务事件失败", error);
  }
}

function appendEvent(event: JobEvent) {
  if (event.id && event.id <= lastEventId) {
    return;
  }
  if (event.id) {
    lastEventId = event.id;
  }
  events.value.push(event);
  if (event.message?.startsWith("jobStatus:")) {
    const status = event.message.slice(10);
    if (job.value) {
      job.value = {...job.value, status};
    }
    if (status === "success" || status === "failed" || status === "cancelled") {
      finalized.value = true;
      closeStream();
      void refreshJob();
      emit("finished");
    }
  }
}

function subscribeStream(jobId: number) {
  closeStream();
  lastEventId = 0;
  const source = new EventSource(`/api/jobs/${jobId}/stream`);
  eventSource = source;
  source.onmessage = (message) => {
    try {
      const event = JSON.parse(message.data) as JobEvent;
      appendEvent(event);
    } catch (error) {
      console.warn("解析同步事件失败", error);
    }
  };
  source.onerror = () => {
    closeStream();
    void refreshJob();
  };
}

async function confirmSync() {
  try {
    const ids = selectedServiceIds.value;
    events.value = [];
    summary.value = null;
    finalized.value = false;
    closeStream();
    const result = await apiSend<{ job: Job }>("/api/accounts/sync-platforms", "POST", {
      source: ids.length ? undefined : "all",
      serviceIds: ids,
      checkAfterSync: checkAfter.value,
    });
    job.value = result.job;
    ElMessage.success(`已创建平台同步任务 #${result.job.id}`);
    subscribeStream(result.job.id);
    await refreshJob();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function formatDate(value: string | null | undefined) {
  if (!value) {
    return "-";
  }
  return new Date(value).toLocaleString();
}

watch(() => props.modelValue, (visible) => {
  if (visible) {
    reset();
  } else {
    closeStream();
  }
});
</script>

<template>
  <el-dialog :model-value="modelValue" title="同步平台凭据" width="640px" :close-on-click-modal="false"
             @update:model-value="(value: boolean) => emit('update:modelValue', value)" @close="close">
    <el-alert
        title="勾选要拉取的平台服务（可同时选 CPA 与 Sub2API）。留空则同步全部启用的服务。同步过程中匹配到本地账号的会自动建立绑定。"
        type="info" show-icon class="mb-4"/>
    <el-form label-position="top">
      <el-form-item label="平台服务">
        <el-select v-model="selectedServiceIds" multiple clearable filterable class="w-full"
                   :disabled="job !== null && !finalized" placeholder="留空使用全部启用服务">
          <el-option
              v-for="service in services.filter(s => s.enabled)"
              :key="service.id"
              :label="`${service.kind === 'cpa' ? 'CPA' : 'Sub2API'} / ${service.name}`"
              :value="service.id"
          />
        </el-select>
      </el-form-item>
      <el-form-item label="同步后检查状态">
        <el-switch v-model="checkAfter" :disabled="job !== null && !finalized" active-text="开启"
                   inactive-text="关闭"/>
      </el-form-item>
    </el-form>

    <div v-if="job" class="mt-2">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-semibold text-slate-700">同步进度</span>
        <el-tag
            :type="job.status === 'success' ? 'success' : job.status === 'failed' ? 'danger' : job.status === 'cancelled' ? 'info' : 'warning'"
            size="small">{{ job.status }}</el-tag>
      </div>
      <div v-if="summary && finalized" class="mb-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div class="rounded bg-emerald-50 p-2">
          <div class="text-slate-500">新建账号</div>
          <div class="text-lg font-semibold text-emerald-600">{{ summary.imported ?? 0 }}</div>
        </div>
        <div class="rounded bg-sky-50 p-2">
          <div class="text-slate-500">更新匹配</div>
          <div class="text-lg font-semibold text-sky-600">{{ summary.updated ?? 0 }}</div>
        </div>
        <div class="rounded bg-amber-50 p-2">
          <div class="text-slate-500">跳过</div>
          <div class="text-lg font-semibold text-amber-600">{{ summary.skipped ?? 0 }}</div>
        </div>
        <div class="rounded bg-rose-50 p-2">
          <div class="text-slate-500">失败</div>
          <div class="text-lg font-semibold text-rose-600">{{ summary.failed ?? 0 }}</div>
        </div>
      </div>
      <div class="max-h-56 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
        <div v-if="!events.length" class="text-slate-400">等待任务事件…</div>
        <div v-for="event in events" :key="event.id" class="flex gap-2 py-0.5">
          <span class="w-32 shrink-0 text-slate-400">{{ formatDate(event.created_at) }}</span>
          <el-tag size="small"
                  :type="event.level === 'error' ? 'danger' : event.level === 'warn' ? 'warning' : event.level === 'success' ? 'success' : 'info'"
                  effect="plain">{{ event.level }}</el-tag>
          <span class="flex-1 break-all text-slate-700">{{ event.message }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button @click="close">{{ finalized ? "关闭" : "取消" }}</el-button>
      <el-button v-if="!job || finalized" type="primary" @click="confirmSync">
        {{ job && finalized ? "再次同步" : "创建同步任务" }}
      </el-button>
    </template>
  </el-dialog>
</template>
