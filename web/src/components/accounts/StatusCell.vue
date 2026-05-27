<script setup lang="ts">
import type {Account} from "../../api";

const props = defineProps<{row: Account}>();

const statusOptions = [
  {label: "正常", value: "authorized", type: "success"},
  {label: "额度已用尽", value: "quota_exhausted", type: "warning"},
  {label: "凭据过期", value: "credential_expired", type: "danger"},
  {label: "账号异常", value: "account_abnormal", type: "danger"},
  {label: "需要人工重登", value: "needs_manual_reauth", type: "danger"},
  {label: "未检查", value: "unchecked", type: "info"},
  {label: "只保存 accessToken", value: "access_token_only", type: "primary"},
] as const;

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function statusTag(row: Account) {
  const status = row.status_code || row.status;
  const match = statusOptions.find((item) => item.value === status);
  return {
    label: row.status_label || match?.label || status || "未知",
    type: (match?.type || "info") as "" | "success" | "warning" | "info" | "danger" | "primary",
  };
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <el-tag :type="statusTag(row).type" size="small">{{ statusTag(row).label }}</el-tag>
    <el-tag v-if="row.needs_manual_reauth" type="danger" size="small" effect="dark">需要人工重登</el-tag>
    <span class="text-xs text-slate-500">检查 {{ formatDate(row.last_check_at) }}</span>
    <el-tooltip v-if="row.last_error" :content="row.last_error" placement="top">
      <span class="text-xs text-rose-500 line-clamp-1">{{ row.last_error }}</span>
    </el-tooltip>
  </div>
</template>
