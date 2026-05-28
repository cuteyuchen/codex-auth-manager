<script setup lang="ts">
import type {Account} from "../../api";

const props = defineProps<{row: Account}>();

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function isExpired(value: string | null | undefined): boolean {
  if (!value) return false;
  return new Date(value).getTime() < Date.now();
}
</script>

<template>
  <div class="text-xs">
    <div>
      <span class="text-slate-500">创建：</span>
      <span>{{ formatDate(row.created_at) }}</span>
    </div>
    <div>
      <span class="text-slate-500">保存：</span>
      <span>{{ formatDate(row.credential_synced_at) }}</span>
    </div>
    <div :class="isExpired(row.token_expires_at) ? 'text-red-500' : ''">
      <span class="text-slate-500">过期：</span>
      <span>{{ formatDate(row.token_expires_at) }}</span>
      <el-tag v-if="isExpired(row.token_expires_at)" type="danger" size="small" effect="plain" class="ml-1">已过期</el-tag>
    </div>
  </div>
</template>
