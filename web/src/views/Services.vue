<script setup lang="ts">
import {computed, onMounted, reactive, ref} from "vue";
import {ElMessage, ElMessageBox} from "element-plus";
import {Check, Delete, Edit, Plus, Refresh, Search} from "@element-plus/icons-vue";
import {apiGet, apiSend, type IntegrationService, type IntegrationServiceKind} from "../api";

const services = ref<IntegrationService[]>([]);
const loading = ref(false);
const saving = ref(false);
const dialog = ref(false);
const editingId = ref<number | null>(null);
const activeKind = ref<IntegrationServiceKind | "all">("all");

const form = reactive({
  kind: "cpa" as IntegrationServiceKind,
  name: "",
  baseUrl: "",
  secret: "",
  enabled: true,
  priority: 0,
  includeProxyUrl: false,
  optionsText: "",
});

const filteredServices = computed(() => activeKind.value === "all"
  ? services.value
  : services.value.filter((item) => item.kind === activeKind.value));

const serviceSummary = computed(() => ({
  cpa: services.value.filter((item) => item.kind === "cpa" && item.enabled).length,
  sub2api: services.value.filter((item) => item.kind === "sub2api" && item.enabled).length,
}));

function kindLabel(kind: IntegrationServiceKind) {
  return kind === "cpa" ? "CPA" : "Sub2API";
}

function resetForm(kind: IntegrationServiceKind = "cpa") {
  Object.assign(form, {
    kind,
    name: "",
    baseUrl: "",
    secret: "",
    enabled: true,
    priority: 0,
    includeProxyUrl: false,
    optionsText: kind === "sub2api" ? "{}" : "",
  });
}

async function load() {
  loading.value = true;
  try {
    const payload = await apiGet<{services: IntegrationService[]}>("/api/integration-services");
    services.value = payload.services;
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

function openCreate(kind: IntegrationServiceKind) {
  editingId.value = null;
  resetForm(kind);
  dialog.value = true;
}

function openEdit(row: IntegrationService) {
  editingId.value = row.id;
  Object.assign(form, {
    kind: row.kind,
    name: row.name,
    baseUrl: row.baseUrl,
    secret: "",
    enabled: row.enabled,
    priority: row.priority,
    includeProxyUrl: row.includeProxyUrl,
    optionsText: row.kind === "sub2api" ? JSON.stringify(row.options ?? {}, null, 2) : "",
  });
  dialog.value = true;
}

function buildPayload() {
  let options: Record<string, unknown> = {};
  if (form.kind === "sub2api" && form.optionsText.trim()) {
    options = JSON.parse(form.optionsText) as Record<string, unknown>;
  }
  return {
    kind: form.kind,
    name: form.name,
    baseUrl: form.baseUrl,
    secret: form.secret || undefined,
    enabled: form.enabled,
    priority: form.priority,
    includeProxyUrl: form.includeProxyUrl,
    options,
  };
}

async function save() {
  saving.value = true;
  try {
    const payload = buildPayload();
    if (editingId.value) {
      await apiSend(`/api/integration-services/${editingId.value}`, "PUT", payload);
      ElMessage.success("服务已更新");
    } else {
      await apiSend("/api/integration-services", "POST", payload);
      ElMessage.success("服务已创建");
    }
    dialog.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    saving.value = false;
  }
}

async function remove(row: IntegrationService) {
  try {
    await ElMessageBox.confirm(`确定删除「${row.name}」？`, "删除服务", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
    await apiSend(`/api/integration-services/${row.id}`, "DELETE");
    ElMessage.success("服务已删除");
    await load();
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function test(row: IntegrationService) {
  try {
    const result = await apiSend<{success: boolean; message: string}>(`/api/integration-services/${row.id}/test`, "POST");
    if (result.success) {
      ElMessage.success(result.message);
    } else {
      ElMessage.error(result.message);
    }
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString() : "-";
}

onMounted(load);
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">推送服务</h1>
        <p class="page-subtitle">CPA / Sub2API 的统一维护入口；配置页旧单组字段仅作为兼容回退。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <el-button :icon="Plus" type="primary" @click="openCreate('cpa')">新增 CPA</el-button>
        <el-button :icon="Plus" type="primary" plain @click="openCreate('sub2api')">新增 Sub2API</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <div class="mb-4 grid gap-3 md:grid-cols-3">
      <el-card shadow="never">
        <el-statistic title="启用 CPA 服务" :value="serviceSummary.cpa" />
      </el-card>
      <el-card shadow="never">
        <el-statistic title="启用 Sub2API 服务" :value="serviceSummary.sub2api" />
      </el-card>
      <el-card shadow="never">
        <el-segmented
          v-model="activeKind"
          :options="[{label: '全部', value: 'all'}, {label: 'CPA', value: 'cpa'}, {label: 'Sub2API', value: 'sub2api'}]"
          class="w-full"
        />
      </el-card>
    </div>

    <el-card shadow="never">
      <div class="data-table-wrap">
        <el-table v-loading="loading" :data="filteredServices" border row-key="id">
          <template #empty>
            <el-empty description="还没有配置推送服务">
              <div class="flex flex-wrap justify-center gap-2">
                <el-button :icon="Plus" type="primary" @click="openCreate('cpa')">新增 CPA</el-button>
                <el-button :icon="Plus" type="primary" plain @click="openCreate('sub2api')">新增 Sub2API</el-button>
              </div>
            </el-empty>
          </template>
          <el-table-column label="服务" min-width="210">
            <template #default="{row}">
              <div class="font-semibold">{{ row.name }}</div>
              <div class="text-xs text-[var(--app-muted)]">{{ kindLabel(row.kind) }} / 优先级 {{ row.priority }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="baseUrl" label="Base URL" min-width="260" show-overflow-tooltip />
          <el-table-column label="密钥" width="130">
            <template #default="{row}">
              <el-tag :type="row.secret.hasValue ? 'success' : 'danger'" effect="plain">
                {{ row.secret.hasValue ? `尾号 ${row.secret.tail}` : "未配置" }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="110">
            <template #default="{row}">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? "启用" : "停用" }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="最近测试" min-width="220">
            <template #default="{row}">
              <div>
                <el-tag v-if="row.lastTestStatus" :type="row.lastTestStatus === 'success' ? 'success' : 'danger'" effect="plain">
                  {{ row.lastTestStatus === "success" ? "通过" : "失败" }}
                </el-tag>
                <span v-else class="text-[var(--app-muted)]">未测试</span>
              </div>
              <div class="mt-1 text-xs text-[var(--app-muted)]">{{ formatDate(row.lastTestAt) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="220">
            <template #default="{row}">
              <div class="table-actions">
                <el-button :icon="Search" link type="primary" @click="test(row)">测试</el-button>
                <el-button :icon="Edit" link type="primary" @click="openEdit(row)">编辑</el-button>
                <el-button :icon="Delete" link type="danger" @click="remove(row)">删除</el-button>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-card>

    <el-dialog v-model="dialog" :title="editingId ? '编辑推送服务' : '新增推送服务'" width="680px">
      <el-form label-position="top" :model="form">
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12">
            <el-form-item label="类型">
              <el-select v-model="form.kind" class="w-full" :disabled="Boolean(editingId)" @change="resetForm(form.kind)">
                <el-option label="CPA" value="cpa" />
                <el-option label="Sub2API" value="sub2api" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="优先级">
              <el-input-number v-model="form.priority" :min="0" class="w-full" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="服务名称"><el-input v-model="form.name" placeholder="例如：主 Sub2API" /></el-form-item>
        <el-form-item label="Base URL"><el-input v-model="form.baseUrl" placeholder="https://example.com" /></el-form-item>
        <el-form-item :label="form.kind === 'cpa' ? 'CPA 管理密钥' : 'Sub2API Admin Key'">
          <el-input
            v-model="form.secret"
            type="password"
            show-password
            :placeholder="editingId ? '留空保持原密钥' : '请输入密钥'"
          />
        </el-form-item>
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12">
            <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
          </el-col>
          <el-col v-if="form.kind === 'cpa'" :xs="24" :sm="12">
            <el-form-item label="写入代理 URL"><el-switch v-model="form.includeProxyUrl" /></el-form-item>
          </el-col>
        </el-row>
        <el-form-item v-if="form.kind === 'sub2api'" label="Sub2API 可选参数 JSON">
          <el-input v-model="form.optionsText" type="textarea" :rows="7" placeholder='{"group_ids":[1],"priority":50}' />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button :icon="Check" type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
