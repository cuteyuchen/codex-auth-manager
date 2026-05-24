<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, reactive, ref, watch} from "vue";
import {ElMessage} from "element-plus";
import {CircleClose, Promotion, Refresh, VideoPlay} from "@element-plus/icons-vue";
import {apiGet, apiSend, type Job, type JobEvent, type MailSource, type MailType} from "../api";

const types = ref<MailType[]>([]);
const sources = ref<MailSource[]>([]);
const events = ref<JobEvent[]>([]);
const jobId = ref<number | null>(null);
const currentJob = ref<Job | null>(null);
const inputValue = ref("");
const waitingPrompt = ref("");
const starting = ref(false);
const cancelling = ref(false);
let source: EventSource | null = null;

const form = reactive({
  useMailboxPool: true,
  mailboxSourceId: "",
  emailText: "",
  rounds: 1,
  password: "",
  mode: "sign",
  manualOtp: false,
  enableSmsVerification: true,
  cliProvider: "hotmail",
  cliHotmailMode: "graph",
  uploadTarget: "none",
});

const registerModes = [
  {label: "注册并授权", value: "sign"},
  {label: "只登录授权", value: "auth"},
  {label: "注册后授权", value: "normal"},
  {label: "只保存 accessToken", value: "at"},
];

const providers = ["proxiedmail", "gmail", "gptmail", "hotmail", "2925", "cloudflare"];
const uploadTargets = [
  {label: "不上传", value: "none"},
  {label: "上传 CPA", value: "cpa"},
  {label: "上传 Sub2API", value: "sub2api"},
  {label: "CPA + Sub2API", value: "both"},
];
const hotmailModes = [
  {label: "Outlook / Graph", value: "graph"},
  {label: "熊猫点", value: "xiongmaodian"},
];

const emails = computed(() => form.emailText.split(/\r?\n|,/).map((item) => item.trim()).filter(Boolean));
const filteredSources = computed(() => sources.value.filter((item) => item.enabled));
const selectedSource = computed(() => sources.value.find((item) => String(item.id) === form.mailboxSourceId));
const activeJob = computed(() => currentJob.value ? ["queued", "running", "waiting_input"].includes(currentJob.value.status) : false);
const currentStage = computed(() => {
  const last = [...events.value].reverse().find((item) => item.message.includes("凭据阶段") || item.message.includes("验证码") || item.level === "success" || item.level === "error");
  return last?.message ?? "等待创建任务";
});

async function loadMeta() {
  try {
    const [typePayload, sourcePayload] = await Promise.all([
      apiGet<{types: MailType[]}>("/api/mail-types"),
      apiGet<{sources: MailSource[]}>("/api/mail-sources"),
    ]);
    types.value = typePayload.types.filter((item) => item.enabled);
    sources.value = sourcePayload.sources.filter((item) => item.enabled);
    if (!form.mailboxSourceId && filteredSources.value[0]) {
      form.mailboxSourceId = String(filteredSources.value[0].id);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function connectStream(id: number) {
  if (source) {
    source.close();
  }
  events.value = [];
  source = new EventSource(`/api/jobs/${id}/stream`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as JobEvent;
    if (event.message.startsWith("jobStatus:")) {
      const status = event.message.slice("jobStatus:".length);
      if (currentJob.value) {
        currentJob.value = {
          ...currentJob.value,
          status,
          waiting_for_input: status === "waiting_input" ? currentJob.value.waiting_for_input : 0,
        };
      }
      if (status !== "waiting_input") {
        waitingPrompt.value = "";
      }
      return;
    }
    if (event.id > 0 && !events.value.some((item) => item.id === event.id)) {
      events.value.push(event);
      if (event.message.startsWith("请输入")) {
        waitingPrompt.value = event.message;
        if (currentJob.value) {
          currentJob.value = {
            ...currentJob.value,
            status: "waiting_input",
            waiting_for_input: 1,
            input_prompt: event.message,
          };
        }
      }
    }
  };
}

async function start() {
  if (form.useMailboxPool && !form.mailboxSourceId) {
    ElMessage.warning("请先选择邮箱来源");
    return;
  }
  starting.value = true;
  try {
    const result = await apiSend<{job: Job}>("/api/jobs/register", "POST", {
      emails: emails.value,
      rounds: emails.value.length ? emails.value.length : form.rounds,
      password: form.password || undefined,
      manualOtp: form.manualOtp,
      enableSmsVerification: form.enableSmsVerification,
      directSignupAuth: form.mode === "sign",
      authOnly: form.mode === "auth",
      saveAccessToken: form.mode === "at",
      useMailboxPool: form.useMailboxPool,
      mailboxSourceId: form.mailboxSourceId ? Number(form.mailboxSourceId) : undefined,
      cliProvider: !form.useMailboxPool ? form.cliProvider : undefined,
      cliHotmailMode: !form.useMailboxPool && form.cliProvider === "hotmail" ? form.cliHotmailMode : undefined,
      uploadTarget: form.uploadTarget,
      title: "Web 注册任务",
    });
    jobId.value = result.job.id;
    currentJob.value = result.job;
    waitingPrompt.value = "";
    inputValue.value = "";
    ElMessage.success(`已创建任务 #${result.job.id}`);
    connectStream(result.job.id);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    starting.value = false;
  }
}

async function cancelCurrentJob() {
  if (!currentJob.value || !activeJob.value) {
    return;
  }
  cancelling.value = true;
  try {
    const payload = await apiSend<{job: Job}>(`/api/jobs/${currentJob.value.id}/cancel`, "POST");
    currentJob.value = payload.job;
    waitingPrompt.value = "";
    ElMessage.success("已请求结束任务");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    cancelling.value = false;
  }
}

async function submitInput() {
  if (!jobId.value || !inputValue.value.trim()) {
    return;
  }
  try {
    await apiSend(`/api/jobs/${jobId.value}/input`, "POST", {value: inputValue.value.trim()});
    inputValue.value = "";
    waitingPrompt.value = "";
    ElMessage.success("验证码已提交");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function subtypeLabel(value: string | null | undefined) {
  return hotmailModes.find((item) => item.value === value)?.label || value || "-";
}

watch(() => form.useMailboxPool, (usePool) => {
  if (usePool) {
    form.emailText = "";
  }
});

onMounted(loadMeta);
onBeforeUnmount(() => source?.close());
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">注册链路</h1>
        <p class="page-subtitle">Web 默认从数据库邮箱池按来源取未使用邮箱；自定义来源保留旧 provider 字段。</p>
      </div>
      <el-button :icon="Refresh" @click="loadMeta">刷新邮箱池</el-button>
    </div>

    <div class="grid gap-4 xl:grid-cols-[440px_minmax(0,1fr)]">
      <el-card shadow="never">
        <template #header>
          <div class="flex items-center justify-between">
            <strong>任务配置</strong>
            <el-tag :type="form.useMailboxPool ? 'success' : 'warning'">{{ form.useMailboxPool ? "数据库邮箱池" : "自定义来源" }}</el-tag>
          </div>
        </template>
        <el-form label-position="top" :model="form">
          <el-form-item label="邮箱来源模式">
            <el-segmented
              v-model="form.useMailboxPool"
              :options="[{label: '数据库邮箱池', value: true}, {label: '自定义来源', value: false}]"
              class="w-full"
            />
          </el-form-item>

          <template v-if="form.useMailboxPool">
            <el-form-item label="邮箱来源">
              <el-select v-model="form.mailboxSourceId" filterable class="w-full" placeholder="选择已绑定邮箱类型的来源">
                <el-option
                  v-for="sourceItem in filteredSources"
                  :key="sourceItem.id"
                  :label="`${sourceItem.name} / ${sourceItem.mail_type_name || sourceItem.provider} (${sourceItem.unused_count} 未用)`"
                  :value="String(sourceItem.id)"
                />
              </el-select>
            </el-form-item>
            <el-alert
              v-if="selectedSource"
              :title="`当前来源类型：${selectedSource.mail_type_name || selectedSource.provider}${selectedSource.subtype ? ' / ' + subtypeLabel(selectedSource.subtype) : ''}；未用 ${selectedSource.unused_count} 个。`"
              type="success"
              show-icon
              class="mb-3"
            />
          </template>

          <template v-else>
            <el-alert title="自定义来源只在本次 Web 注册任务内临时使用，不会写回全局配置；字段沿用 CLI provider 语义。" type="info" show-icon class="mb-3" />
            <el-row :gutter="12">
              <el-col :xs="24" :sm="12">
                <el-form-item label="邮箱 provider">
                  <el-select v-model="form.cliProvider" class="w-full">
                    <el-option v-for="provider in providers" :key="provider" :label="provider" :value="provider" />
                  </el-select>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item v-if="form.cliProvider === 'hotmail'" label="Hotmail 模式">
                  <el-select v-model="form.cliHotmailMode" class="w-full">
                    <el-option v-for="mode in hotmailModes" :key="mode.value" :label="mode.label" :value="mode.value" />
                  </el-select>
                </el-form-item>
              </el-col>
            </el-row>
          </template>

          <el-form-item v-if="!form.useMailboxPool" label="指定邮箱">
            <el-input
              v-model="form.emailText"
              type="textarea"
              :rows="5"
              placeholder="可选；一行一个。自定义来源下可指定邮箱，不填则走 provider 自动取邮箱。"
            />
          </el-form-item>

          <el-row :gutter="12">
            <el-col :xs="24" :sm="12">
              <el-form-item label="轮数">
                <el-input-number v-model="form.rounds" :min="1" class="w-full" />
              </el-form-item>
            </el-col>
            <el-col :xs="24" :sm="12">
              <el-form-item label="模式">
                <el-select v-model="form.mode" class="w-full">
                  <el-option v-for="mode in registerModes" :key="mode.value" :label="mode.label" :value="mode.value" />
                </el-select>
              </el-form-item>
            </el-col>
          </el-row>

          <el-form-item label="账号密码">
            <el-input v-model="form.password" type="password" show-password placeholder="留空使用配置页的默认密码，至少 8 位" />
          </el-form-item>

          <el-form-item label="邮箱验证码">
            <el-switch v-model="form.manualOtp" active-text="手动输入邮箱验证码" />
          </el-form-item>

          <el-form-item label="短信验证码">
            <el-switch
              v-model="form.enableSmsVerification"
              aria-label="启用短信验证码"
              active-text="启用短信验证码"
              inactive-text="关闭短信验证码"
            />
            <div v-if="!form.enableSmsVerification" class="mt-2 text-sm text-amber-600">
              关闭后本次任务不会调用 HeroSMS；如果 OpenAI 要求手机验证，任务会直接失败。
            </div>
          </el-form-item>

          <el-form-item label="注册成功后上传">
            <el-segmented v-model="form.uploadTarget" :options="uploadTargets" class="w-full" />
          </el-form-item>

          <div v-if="form.manualOtp" class="mb-4 rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-soft)] p-3">
            <div class="mb-2 text-sm text-[var(--app-muted)]">
              勾选后任务等待验证码时会使用这里提交；也可以提前填好后按回车提交。
            </div>
            <div class="flex gap-2">
              <el-input v-model="inputValue" placeholder="邮箱验证码" @keyup.enter="submitInput" />
              <el-button :icon="Promotion" type="primary" :disabled="!jobId" @click="submitInput">提交</el-button>
            </div>
            <div v-if="waitingPrompt" class="mt-2 text-sm text-amber-600">{{ waitingPrompt }}</div>
          </div>

          <div class="grid gap-2 sm:grid-cols-2">
            <el-button :icon="VideoPlay" type="primary" class="w-full" :loading="starting" :disabled="activeJob" @click="start">
              开始任务
            </el-button>
            <el-button
              :icon="CircleClose"
              type="danger"
              plain
              class="w-full"
              :loading="cancelling"
              :disabled="!activeJob"
              @click="cancelCurrentJob"
            >
              结束任务
            </el-button>
          </div>
        </el-form>
      </el-card>

      <div class="grid min-w-0 gap-4">
        <el-card shadow="never">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <strong>当前阶段</strong>
              <div v-if="jobId" class="flex items-center gap-2">
                <el-tag type="primary">#{{ jobId }}</el-tag>
                <el-tag v-if="currentJob" :type="activeJob ? 'warning' : currentJob.status === 'success' ? 'success' : currentJob.status === 'failed' ? 'danger' : 'info'">
                  {{ currentJob.status }}
                </el-tag>
              </div>
            </div>
          </template>
          <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_280px]">
            <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-soft)] p-4">
              <div class="text-sm text-[var(--app-muted)]">凭据状态</div>
              <div class="mt-2 text-lg font-bold text-[var(--app-text)]">{{ currentStage }}</div>
            </div>
            <div class="rounded-xl border border-[var(--app-border)] bg-[var(--app-surface-soft)] p-4">
              <div class="text-sm text-[var(--app-muted)]">邮箱池</div>
              <div class="mt-2 flex flex-wrap gap-2">
                <el-tag>{{ types.length }} 类型</el-tag>
                <el-tag type="success">{{ filteredSources.length }} 可用来源</el-tag>
                <el-tag type="info">{{ form.useMailboxPool ? "按来源取号" : `${emails.length} 手动邮箱` }}</el-tag>
                <el-tag :type="form.enableSmsVerification ? 'success' : 'warning'">
                  短信{{ form.enableSmsVerification ? "启用" : "关闭" }}
                </el-tag>
              </div>
            </div>
          </div>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <strong>实时日志</strong>
              <el-tag v-if="events.length" effect="plain">{{ events.length }} 条</el-tag>
            </div>
          </template>
          <div class="log-box">
            <div v-for="event in events" :key="event.id" class="log-line" :class="event.level">
              [{{ event.created_at }}] {{ event.level }} {{ event.message }}
            </div>
            <div v-if="!events.length" class="text-slate-400">任务创建后这里会显示注册、取件、授权和推送日志。</div>
          </div>
        </el-card>
      </div>
    </div>
  </section>
</template>
