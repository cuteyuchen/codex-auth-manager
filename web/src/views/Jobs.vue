<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from "vue";
import {ElMessage} from "element-plus";
import {CircleClose, Promotion, Refresh} from "@element-plus/icons-vue";
import {apiGet, apiSend, type Job, type JobEvent} from "../api";

const jobs = ref<Job[]>([]);
const events = ref<JobEvent[]>([]);
const selectedJob = ref<Job | null>(null);
const inputValue = ref("");
const currentPage = ref(1);
const pageSize = ref(20);
const logBoxRef = ref<HTMLElement | null>(null);
const stickToBottom = ref(true);
const cancelling = ref(false);
let source: EventSource | null = null;

const pagedJobs = computed(() => jobs.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const activeSelectedJob = computed(() => selectedJob.value ? isActiveJob(selectedJob.value) : false);

async function load() {
  try {
    const payload = await apiGet<{jobs: Job[]}>("/api/jobs");
    jobs.value = payload.jobs;
    if ((currentPage.value - 1) * pageSize.value >= jobs.value.length) {
      currentPage.value = 1;
    }
    if (!selectedJob.value && jobs.value.length) {
      await selectJob(jobs.value[0]);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function selectJob(job: Job) {
  selectedJob.value = job;
  events.value = [];
  if (source) {
    source.close();
  }
  const payload = await apiGet<{events: JobEvent[]}>(`/api/jobs/${job.id}/events`);
  events.value = payload.events;
  stickToBottom.value = true;
  source = new EventSource(`/api/jobs/${job.id}/stream`);
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as JobEvent;
    if (event.message.startsWith("jobStatus:")) {
      updateJobFromStatus(event.job_id, event.message.slice("jobStatus:".length));
      return;
    }
    if (event.id > 0 && !events.value.some((item) => item.id === event.id)) {
      events.value.push(event);
      void scrollLogToBottom();
    }
  };
  void scrollLogToBottom(true);
}

function handleLogScroll() {
  const el = logBoxRef.value;
  if (!el) {
    return;
  }
  stickToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
}

async function scrollLogToBottom(force = false) {
  await nextTick();
  const el = logBoxRef.value;
  if (!el || (!force && !stickToBottom.value)) {
    return;
  }
  el.scrollTop = el.scrollHeight;
}

async function submitInput() {
  if (!selectedJob.value || !inputValue.value.trim()) {
    return;
  }
  try {
    await apiSend(`/api/jobs/${selectedJob.value.id}/input`, "POST", {value: inputValue.value.trim()});
    inputValue.value = "";
    ElMessage.success("输入已提交");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function cancelSelectedJob() {
  if (!selectedJob.value || !activeSelectedJob.value) {
    return;
  }
  cancelling.value = true;
  try {
    const payload = await apiSend<{job: Job}>(`/api/jobs/${selectedJob.value.id}/cancel`, "POST");
    applyJobUpdate(payload.job);
    ElMessage.success("已请求结束任务");
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    cancelling.value = false;
  }
}

function isActiveJob(job: Job): boolean {
  return ["queued", "running", "waiting_input"].includes(job.status);
}

function applyJobUpdate(job: Job) {
  jobs.value = jobs.value.map((item) => item.id === job.id ? job : item);
  if (selectedJob.value?.id === job.id) {
    selectedJob.value = job;
  }
}

function updateJobFromStatus(jobId: number, status: string) {
  const waiting = status === "waiting_input";
  const patch = (job: Job): Job => ({
    ...job,
    status,
    waiting_for_input: waiting ? job.waiting_for_input : 0,
    input_prompt: waiting ? job.input_prompt : null,
  });
  jobs.value = jobs.value.map((job) => job.id === jobId ? patch(job) : job);
  if (selectedJob.value?.id === jobId) {
    selectedJob.value = patch(selectedJob.value);
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
onBeforeUnmount(() => source?.close());
watch(pageSize, () => {
  currentPage.value = 1;
});
watch(() => events.value.length, () => {
  void scrollLogToBottom();
});
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">任务</h1>
        <p class="page-subtitle">查看任务状态、实时日志和人工输入。</p>
      </div>
      <el-button :icon="Refresh" @click="load">刷新</el-button>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="9">
        <el-card shadow="never">
          <el-table :data="pagedJobs" border highlight-current-row @row-click="selectJob">
            <el-table-column prop="id" label="ID" width="72" />
            <el-table-column prop="title" label="标题" min-width="180" show-overflow-tooltip />
            <el-table-column label="状态" width="120">
              <template #default="{row}">
                <el-tag :type="jobType(row.status)">{{ row.status }}</el-tag>
              </template>
            </el-table-column>
          </el-table>
          <div class="mt-4 flex justify-end">
            <el-pagination
              v-model:current-page="currentPage"
              v-model:page-size="pageSize"
              :page-sizes="[10, 20, 50]"
              :total="jobs.length"
              layout="total, sizes, prev, pager, next"
            />
          </div>
        </el-card>
      </el-col>
      <el-col :xs="24" :lg="15">
        <el-card shadow="never">
          <template #header>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <strong>{{ selectedJob ? `#${selectedJob.id} ${selectedJob.title}` : "未选择任务" }}</strong>
              <div class="flex items-center gap-2">
                <el-button
                  v-if="selectedJob"
                  :icon="CircleClose"
                  type="danger"
                  plain
                  size="small"
                  :loading="cancelling"
                  :disabled="!activeSelectedJob"
                  @click="cancelSelectedJob"
                >
                  结束任务
                </el-button>
                <el-tag v-if="selectedJob" :type="jobType(selectedJob.status)">{{ selectedJob.status }}</el-tag>
              </div>
            </div>
          </template>
          <div v-if="selectedJob?.waiting_for_input" class="mb-3 flex gap-2">
            <el-input v-model="inputValue" :placeholder="selectedJob.input_prompt || '输入验证码'" @keyup.enter="submitInput" />
            <el-button :icon="Promotion" type="primary" @click="submitInput">提交</el-button>
          </div>
          <div ref="logBoxRef" class="log-box" @scroll="handleLogScroll">
            <div v-for="event in events" :key="event.id" class="log-line" :class="event.level">
              [{{ event.created_at }}] {{ event.level }} {{ event.message }}
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </section>
</template>
