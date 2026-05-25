<script setup lang="ts">
import {computed, onMounted, reactive, ref, watch} from "vue";
import {ElMessage, ElMessageBox} from "element-plus";
import {Delete, Edit, Plus, Refresh, Search} from "@element-plus/icons-vue";
import {apiGet, apiSend, type MailSource, type MailType} from "../api";

const sources = ref<MailSource[]>([]);
const types = ref<MailType[]>([]);
const loading = ref(false);
const dialog = ref(false);
const editingId = ref<number | null>(null);
const currentPage = ref(1);
const pageSize = ref(20);

const filters = reactive({
  q: "",
  provider: "",
  subtype: "",
  enabled: "",
});

const form = reactive({
  name: "",
  mail_type_id: 0,
  provider: "",
  hotmailSubtype: "graph",
  vendor: "",
  batch_note: "",
  enabled: true,
  supports_auto_code: true,
});

const hotmailModes = [
  {label: "Outlook / Graph", value: "graph"},
  {label: "熊猫电竞", value: "xiongmaodian"},
];

const pagedSources = computed(() => sources.value.slice((currentPage.value - 1) * pageSize.value, currentPage.value * pageSize.value));
const providerTypes = computed(() => {
  const map = new Map<string, MailType>();
  for (const type of types.value) {
    if (type.provider === "hotmail") {
      map.set("hotmail", {...type, name: "Hotmail / Outlook"});
      continue;
    }
    if (!map.has(type.provider)) {
      map.set(type.provider, type);
    }
  }
  return [...map.values()];
});

function buildQuery() {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== "") {
      params.set(key, value);
    }
  }
  return params.toString();
}

async function load() {
  loading.value = true;
  try {
    const [typePayload, sourcePayload] = await Promise.all([
      apiGet<{types: MailType[]}>("/api/mail-types"),
      apiGet<{sources: MailSource[]}>(`/api/mail-sources?${buildQuery()}`),
    ]);
    types.value = typePayload.types;
    sources.value = sourcePayload.sources;
    if ((currentPage.value - 1) * pageSize.value >= sources.value.length) {
      currentPage.value = 1;
    }
    if (!form.mail_type_id && types.value[0]) {
      setFormType(types.value[0]);
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

function resetFilters() {
  Object.assign(filters, {
    q: "",
    provider: "",
    subtype: "",
    enabled: "",
  });
  void load();
}

function openCreate() {
  editingId.value = null;
  const firstType = types.value[0];
  Object.assign(form, {
    name: "",
    mail_type_id: firstType?.id ?? 0,
    provider: firstType?.provider ?? "",
    hotmailSubtype: firstType?.subtype ?? "graph",
    vendor: "",
    batch_note: "",
    enabled: true,
    supports_auto_code: firstType?.supports_auto_code ?? true,
  });
  dialog.value = true;
}

function openEdit(row: MailSource) {
  editingId.value = row.id;
  Object.assign(form, {
    name: row.name,
    mail_type_id: row.mail_type_id ?? types.value[0]?.id ?? 0,
    provider: row.provider,
    hotmailSubtype: row.subtype ?? "graph",
    vendor: row.vendor ?? "",
    batch_note: row.batch_note ?? "",
    enabled: row.enabled,
    supports_auto_code: row.supports_auto_code,
  });
  dialog.value = true;
}

function setFormType(type: MailType | undefined) {
  if (!type) {
    return;
  }
  form.mail_type_id = type.id;
  form.provider = type.provider;
  form.hotmailSubtype = type.provider === "hotmail" ? (type.subtype ?? "graph") : "graph";
  form.supports_auto_code = type.supports_auto_code;
}

function syncProviderType() {
  const type = form.provider === "hotmail"
    ? types.value.find((item) => item.provider === "hotmail" && item.subtype === form.hotmailSubtype)
    : types.value.find((item) => item.provider === form.provider);
  setFormType(type);
}

async function save() {
  try {
    if (editingId.value) {
      await apiSend(`/api/mail-sources/${editingId.value}`, "PUT", form);
      ElMessage.success("邮箱来源已更新");
    } else {
      await apiSend("/api/mail-sources", "POST", form);
      ElMessage.success("邮箱来源已创建");
    }
    dialog.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function remove(row: MailSource) {
  try {
    await ElMessageBox.confirm(`确定删除来源「${row.name}」？对应邮箱也会被删除。`, "删除邮箱来源", {
      type: "warning",
      confirmButtonText: "删除",
      cancelButtonText: "取消",
    });
    await apiSend(`/api/mail-sources/${row.id}`, "DELETE");
    ElMessage.success("邮箱来源已删除");
    await load();
  } catch (error) {
    if (error !== "cancel") {
      ElMessage.error(error instanceof Error ? error.message : String(error));
    }
  }
}

function subtypeLabel(value: string | null | undefined) {
  return hotmailModes.find((item) => item.value === value)?.label || value || "-";
}

function sourceTypeLabel(row: MailSource) {
  if (row.provider === "hotmail") {
    return `Hotmail / ${subtypeLabel(row.subtype)}`;
  }
  return row.mail_type_name || row.provider;
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
        <h1 class="page-title">邮箱来源</h1>
        <p class="page-subtitle">来源是渠道和批次标注，用于追踪邮箱从哪里来；邮箱类型才决定取件方式。</p>
      </div>
      <div class="flex flex-wrap gap-2">
        <el-button :icon="Plus" type="primary" @click="openCreate">添加来源</el-button>
        <el-button :icon="Refresh" :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>

    <el-card shadow="never" class="mb-4">
      <el-form :model="filters" label-position="left" class="filter-form">
        <div class="filter-grid">
          <el-form-item label="关键词">
            <el-input v-model="filters.q" clearable placeholder="来源/渠道/备注" @keyup.enter="load" />
          </el-form-item>
          <el-form-item label="邮箱类型">
            <el-select v-model="filters.provider" clearable filterable placeholder="全部" class="w-full">
              <el-option v-for="type in providerTypes" :key="type.provider" :label="type.provider === 'hotmail' ? 'Hotmail / Outlook' : type.name" :value="type.provider" />
            </el-select>
          </el-form-item>
          <el-form-item label="Hotmail 子类型">
            <el-select v-model="filters.subtype" clearable placeholder="全部" class="w-full">
              <el-option v-for="mode in hotmailModes" :key="mode.value" :label="mode.label" :value="mode.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="状态">
            <el-select v-model="filters.enabled" clearable placeholder="全部" class="w-full">
              <el-option label="启用" value="true" />
              <el-option label="停用" value="false" />
            </el-select>
          </el-form-item>
          <el-form-item>
            <div class="filter-actions flex w-full gap-2">
              <el-button :icon="Search" type="primary" class="flex-1" @click="load">筛选</el-button>
              <el-button class="flex-1" @click="resetFilters">重置</el-button>
            </div>
          </el-form-item>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never">
      <div class="data-table-wrap">
        <el-table v-loading="loading" :data="pagedSources" border row-key="id">
          <el-table-column prop="name" label="来源名称" min-width="180" show-overflow-tooltip />
          <el-table-column label="邮箱类型" min-width="190">
            <template #default="{row}">
              <div class="font-medium">{{ sourceTypeLabel(row) }}</div>
              <div class="text-xs text-[var(--app-muted)]">{{ row.provider }}</div>
            </template>
          </el-table-column>
          <el-table-column prop="vendor" label="渠道" min-width="150" show-overflow-tooltip>
            <template #default="{row}">{{ row.vendor || "-" }}</template>
          </el-table-column>
          <el-table-column prop="batch_note" label="批次备注" min-width="180" show-overflow-tooltip>
            <template #default="{row}">{{ row.batch_note || "-" }}</template>
          </el-table-column>
          <el-table-column label="库存" min-width="210">
            <template #default="{row}">
              <div class="flex flex-wrap gap-1">
                <el-tag effect="plain">总 {{ row.mailbox_count }}</el-tag>
                <el-tag type="success" effect="plain">未用 {{ row.unused_count }}</el-tag>
                <el-tag type="info" effect="plain">已用 {{ row.used_count }}</el-tag>
                <el-tag v-if="row.failed_count" type="danger" effect="plain">失败 {{ row.failed_count }}</el-tag>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="能力" width="130">
            <template #default="{row}">
              <el-tag :type="row.supports_auto_code ? 'success' : 'info'">{{ row.supports_auto_code ? "自动取件" : "库存邮箱" }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{row}">
              <el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? "启用" : "停用" }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" fixed="right" width="190">
            <template #default="{row}">
              <div class="table-actions">
                <el-button :icon="Edit" size="small" link @click="openEdit(row)">编辑</el-button>
                <el-button :icon="Delete" size="small" link type="danger" @click="remove(row)">删除</el-button>
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
          :total="sources.length"
          layout="total, sizes, prev, pager, next, jumper"
        />
      </div>
    </el-card>

    <el-dialog v-model="dialog" :title="editingId ? '编辑邮箱来源' : '添加邮箱来源'" width="640px">
      <el-form label-position="top" :model="form">
        <el-form-item label="来源名称">
          <el-input v-model="form.name" placeholder="例如：5月A商家 Hotmail 500枚" />
        </el-form-item>
        <el-form-item label="邮箱类型">
          <el-select v-model="form.provider" filterable class="w-full" @change="syncProviderType">
            <el-option
              v-for="type in providerTypes"
              :key="type.provider"
              :label="type.provider === 'hotmail' ? 'Hotmail / Outlook' : type.name"
              :value="type.provider"
            />
          </el-select>
        </el-form-item>
        <el-form-item v-if="form.provider === 'hotmail'" label="Hotmail 子类型">
          <el-select v-model="form.hotmailSubtype" class="w-full" @change="syncProviderType">
            <el-option v-for="mode in hotmailModes" :key="mode.value" :label="mode.label" :value="mode.value" />
          </el-select>
        </el-form-item>
        <el-row :gutter="12">
          <el-col :xs="24" :sm="12">
            <el-form-item label="渠道">
              <el-input v-model="form.vendor" placeholder="平台/商家/订单来源" />
            </el-form-item>
          </el-col>
          <el-col :xs="24" :sm="12">
            <el-form-item label="启用状态">
              <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="自动取件">
          <el-switch v-model="form.supports_auto_code" active-text="支持" inactive-text="仅库存" />
        </el-form-item>
        <el-form-item label="批次备注">
          <el-input v-model="form.batch_note" type="textarea" :rows="3" placeholder="例如价格、数量、购买时间、质量备注" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </section>
</template>
