<script setup lang="ts">
import type {Account} from "../../api";

const props = defineProps<{row: Account}>();

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}
</script>

<template>
  <div>
    <el-tag
        :type="row.step_status === 'failed' ? 'danger' : row.step_status === 'success' ? 'success' : 'warning'"
        size="small" effect="plain">
      {{ row.current_step || "未检查" }}
    </el-tag>
    <div class="text-xs text-slate-500">{{ formatDate(row.last_step_at) }}</div>
  </div>
</template>
