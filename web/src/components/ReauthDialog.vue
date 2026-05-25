<script setup lang="ts">
import {ref, watch} from "vue";
import {ElMessage, ElMessageBox} from "element-plus";
import {CopyDocument} from "@element-plus/icons-vue";
import {apiGet, apiSend, type Account, type Job, type JobEvent} from "../api";

const props = defineProps<{
  modelValue: boolean;
  account: Account | null;
  mode: "auto" | "manual";
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "finished"): void;
}>();

const job = ref<Job | null>(null);
const events = ref<JobEvent[]>([]);
const authUrl = ref("");
const callbackInput = ref("");
const submittingCallback = ref(false);
const finalized = ref(false);
let eventSource: EventSource | null = null;
let lastEventId = 0;

function close() {
  closeStream();
  emit("update:modelValue", false);
}

function closeStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function safeJsonParse(value: string | null | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function syncAuthUrlFromJob(target: Job | null) {
  if (!target) {
    return;
  }
  const result = (target.result ?? (target.result_json ? safeJsonParse(target.result_json) : null)) as Record<string, unknown> | null;
  if (result && typeof result.auth_url === "string" && result.auth_url) {
    authUrl.value = result.auth_url;
  }
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
    syncAuthUrlFromJob(jobPayload.job);
  } catch (error) {
    console.warn("拉取重登任务事件失败", error);
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
  const match = event.message?.match(/授权链接已生成:\s*(https?:\/\/\S+)/);
  if (match?.[1]) {
    authUrl.value = match[1];
  }
  if (event.message?.startsWith("jobStatus:")) {
    const status = event.message.slice(10);
    if (job.value) {
      job.value = {...job.value, status};
    }
    if (status === "success" || status === "failed" || status === "cancelled") {
      finalized.value = true;
      closeStream();
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
      console.warn("解析重登事件失败", error);
    }
  };
  source.onerror = () => {
    closeStream();
    void refreshJob();
  };
}

async function start() {
  if (!props.account) {
    return;
  }
  if (props.mode === "auto" && !props.account.has_password) {
    try {
      await ElMessageBox.confirm(
          "该账号没有保存密码，自动重登可能在登录阶段失败。是否仍然继续？",
          "自动重登",
          {type: "warning", confirmButtonText: "继续", cancelButtonText: "取消"},
      );
    } catch {
      emit("update:modelValue", false);
      return;
    }
  }
  events.value = [];
  authUrl.value = "";
  callbackInput.value = "";
  submittingCallback.value = false;
  finalized.value = false;
  job.value = null;
  try {
    const result = await apiSend<{ job: Job }>(`/api/accounts/${props.account.id}/reauth`, "POST", {mode: props.mode});
    job.value = result.job;
    subscribeStream(result.job.id);
    await refreshJob();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
    emit("update:modelValue", false);
  }
}

async function submitCallback() {
  if (!job.value) {
    return;
  }
  const value = callbackInput.value.trim();
  if (!value) {
    ElMessage.warning("请填写回调地址");
    return;
  }
  submittingCallback.value = true;
  try {
    await apiSend(`/api/jobs/${job.value.id}/input`, "POST", {value});
    ElMessage.success("已提交回调地址");
    callbackInput.value = "";
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    submittingCallback.value = false;
  }
}

async function copyAuthorizeUrl() {
  if (!authUrl.value) {
    return;
  }
  try {
    await navigator.clipboard.writeText(authUrl.value);
    ElMessage.success("授权链接已复制");
  } catch {
    ElMessage.warning("剪贴板不可用，请手动复制");
  }
}

function openAuthorizeUrl() {
  if (!authUrl.value) {
    return;
  }
  window.open(authUrl.value, "_blank", "noopener,noreferrer");
}

async function cancelJob() {
  if (!job.value) {
    return;
  }
  try {
    await apiSend(`/api/jobs/${job.value.id}/cancel`, "POST");
    ElMessage.success("已请求取消任务");
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
    void start();
  } else {
    closeStream();
  }
});
</script>

<template>
  <el-dialog :model-value="modelValue" :close-on-click-modal="false" width="640px"
             @update:model-value="(value: boolean) => emit('update:modelValue', value)" @close="close">
    <template #header>
      <span class="font-semibold">
        {{ mode === "manual" ? "人工重登" : "自动重登" }} ·
        {{ account?.email || "-" }}
      </span>
    </template>
    <div v-if="mode === 'auto'" class="space-y-3">
      <el-alert
          title="自动重登使用账号保存的密码登录，邮箱验证码从账号关联的邮箱来源自动取件，不使用短信。"
          type="info" show-icon/>
      <div v-if="account && !account.has_password" class="text-sm text-amber-500">
        ⚠️ 该账号未保存密码，自动登录大概率失败，将自动转为需要人工重登。
      </div>
      <div v-if="account && !account.source_id" class="text-sm text-amber-500">
        ⚠️ 该账号未关联邮箱来源，若登录需要邮箱验证码将无法自动获取。
      </div>
    </div>
    <div v-else class="space-y-3">
      <el-alert
          title="人工重登：复制下方授权链接，在浏览器登录后将地址栏中的完整回调地址粘贴回来，由系统交换 token 并生成授权文件。"
          type="info" show-icon/>
      <div class="rounded-md border border-slate-200 bg-slate-50 p-3">
        <div class="mb-2 text-xs font-semibold text-slate-500">授权链接</div>
        <div v-if="authUrl" class="break-all rounded bg-white p-2 font-mono text-xs text-slate-700">
          {{ authUrl }}
        </div>
        <div v-else class="text-sm text-slate-400">正在生成授权链接…</div>
        <div class="mt-2 flex gap-2">
          <el-button :icon="CopyDocument" size="small" :disabled="!authUrl" @click="copyAuthorizeUrl">复制</el-button>
          <el-button size="small" type="primary" :disabled="!authUrl" @click="openAuthorizeUrl">在浏览器打开</el-button>
        </div>
      </div>
      <el-form label-position="top">
        <el-form-item label="回调地址">
          <el-input
              v-model="callbackInput"
              type="textarea"
              :rows="2"
              placeholder="登录完成后浏览器地址栏中以 http://localhost/ 开头的完整地址"
          />
        </el-form-item>
      </el-form>
      <div class="flex justify-end">
        <el-button type="primary" :loading="submittingCallback" :disabled="!job || finalized"
                   @click="submitCallback">提交回调
        </el-button>
      </div>
    </div>

    <div class="mt-4">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-sm font-semibold text-slate-700">进度</span>
        <el-tag v-if="job"
                :type="job.status === 'success' ? 'success' : job.status === 'failed' ? 'danger' : job.status === 'cancelled' ? 'info' : 'warning'"
                size="small">{{ job.status }}</el-tag>
      </div>
      <div class="max-h-64 overflow-auto rounded-md border border-slate-200 bg-slate-50 p-3 text-xs">
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
      <el-button v-if="job && !finalized" type="danger" plain @click="cancelJob">取消任务</el-button>
      <el-button @click="close">关闭</el-button>
    </template>
  </el-dialog>
</template>
