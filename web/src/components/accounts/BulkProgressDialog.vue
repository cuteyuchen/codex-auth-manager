<script setup lang="ts">
import {nextTick, ref, watch} from "vue";
import {ElMessage} from "element-plus";
import {apiGet, apiSend, type Job, type JobEvent} from "../../api";

const props = defineProps<{
  modelValue: boolean;
  job: Job | null;
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "finished"): void;
}>();

const events = ref<JobEvent[]>([]);
const finalized = ref(false);
const currentJob = ref<Job | null>(null);
const logRef = ref<HTMLDivElement | null>(null);
let eventSource: EventSource | null = null;
let lastEventId = 0;

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (logRef.value) {
      logRef.value.scrollTop = logRef.value.scrollHeight;
    }
  });
}

function appendEvent(event: JobEvent) {
  if (event.id && event.id <= lastEventId) return;
  if (event.id) lastEventId = event.id;
  events.value.push(event);
  scrollToBottom();
  if (event.message?.startsWith("jobStatus:")) {
    const status = event.message.slice(10);
    if (currentJob.value) {
      currentJob.value = {...currentJob.value, status};
    }
    if (status === "success" || status === "failed" || status === "cancelled") {
      finalized.value = true;
      closeStream();
      void refreshJob();
      emit("finished");
    }
  }
}

async function refreshJob() {
  if (!currentJob.value) return;
  try {
    const [jobPayload, eventsPayload] = await Promise.all([
      apiGet<{job: Job}>(`/api/jobs/${currentJob.value.id}`),
      apiGet<{events: JobEvent[]}>(`/api/jobs/${currentJob.value.id}/events?after=0`),
    ]);
    currentJob.value = jobPayload.job;
    events.value = eventsPayload.events ?? [];
    if (events.value.length) {
      lastEventId = Math.max(...events.value.map((e) => e.id));
    }
  } catch (error) {
    console.warn("拉取任务事件失败", error);
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
      console.warn("解析任务事件失败", error);
    }
  };
  source.onerror = () => {
    closeStream();
    void refreshJob();
  };
}

async function cancelJob() {
  if (!currentJob.value) return;
  try {
    await apiSend(`/api/jobs/${currentJob.value.id}/cancel`, "POST");
    ElMessage.success("已请求取消任务");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function reset() {
  events.value = [];
  finalized.value = false;
  currentJob.value = null;
  lastEventId = 0;
  closeStream();
}

function close() {
  closeStream();
  emit("update:modelValue", false);
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleTimeString();
}

function levelType(level: string) {
  if (level === "error") return "danger";
  if (level === "warn") return "warning";
  if (level === "success") return "success";
  return "info";
}

watch(() => props.modelValue, (visible) => {
  if (visible && props.job) {
    reset();
    currentJob.value = {...props.job};
    subscribeStream(props.job.id);
    void refreshJob();
  } else if (!visible) {
    closeStream();
  }
});
</script>

<template>
  <el-dialog :model-value="modelValue" title="批量操作进度" width="640px" :close-on-click-modal="false"
             :close-on-press-escape="finalized" @update:model-value="(value: boolean) => emit('update:modelValue', value)" @close="close">
    <div v-if="currentJob">
      <div class="mb-3 flex items-center justify-between">
        <span class="text-sm font-semibold text-slate-700">{{ currentJob.title }} #{{ currentJob.id }}</span>
        <el-tag :type="currentJob.status === 'success' ? 'success' : currentJob.status === 'failed' ? 'danger' : currentJob.status === 'cancelled' ? 'info' : 'warning'" size="small">
          {{ currentJob.status === 'waiting_input' ? '等待输入' : currentJob.status }}
        </el-tag>
      </div>

      <!-- 等待输入提示 -->
      <el-alert v-if="currentJob.waiting_for_input && currentJob.input_prompt" type="warning" show-icon class="mb-3"
                :title="currentJob.input_prompt"/>

      <div ref="logRef" class="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
        <div v-if="!events.length" class="text-slate-400">等待任务事件…</div>
        <div v-for="event in events" :key="event.id" class="flex gap-2 py-0.5">
          <span class="w-16 shrink-0 text-slate-400">{{ formatDate(event.created_at) }}</span>
          <el-tag size="small" :type="levelType(event.level)" effect="plain">{{ event.level }}</el-tag>
          <span class="flex-1 break-all text-slate-700">{{ event.message }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <el-button v-if="!finalized" type="danger" plain @click="cancelJob">取消任务</el-button>
      <el-button @click="close">{{ finalized ? "关闭" : "后台运行" }}</el-button>
    </template>
  </el-dialog>
</template>
