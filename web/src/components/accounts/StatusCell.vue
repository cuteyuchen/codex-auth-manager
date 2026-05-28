<script setup lang="ts">
import type {Account} from "../../api";
import {ACCOUNT_STATUSES} from "../../../../src/shared/constants";

const props = defineProps<{row: Account}>();

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function statusTag(row: Account) {
  const status = row.status_code || row.status;
  const match = ACCOUNT_STATUSES[status];
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
