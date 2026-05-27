<script setup lang="ts">
import type {Account} from "../../api";

const props = defineProps<{row: Account}>();

function accountSourceLabel(row: Account) {
  if (row.source_name) {
    return `${row.source_name}${row.source_provider ? ` / ${row.source_provider}` : ""}`;
  }
  return "-";
}
</script>

<template>
  <div class="text-sm">
    <!-- 邮箱来源 -->
    <div>{{ accountSourceLabel(row) }}</div>
    <div v-if="row.source_vendor || row.source_batch_note" class="text-xs text-slate-500">
      {{ [row.source_vendor, row.source_batch_note].filter(Boolean).join(" / ") }}
    </div>
    <!-- 邮箱绑定状态 -->
    <div v-if="row.mailbox_id" class="mt-0.5">
      <el-tag size="small" type="success" effect="plain">已绑定邮箱 #{{ row.mailbox_id }}</el-tag>
    </div>
    <div v-else class="mt-0.5">
      <el-tag size="small" type="warning" effect="plain">未绑定邮箱</el-tag>
      <span v-if="row.credential_source_kind && row.credential_source_kind !== 'local'"
            class="ml-1 text-xs text-amber-500">（平台导入，未配置取码）</span>
    </div>
    <!-- 密码/自动重登 -->
    <div class="text-xs text-slate-400">
      密码 {{ row.has_password ? "已保存" : "未保存" }} · 自动重登 {{ row.auto_reauth ? "开启" : "关闭" }}
    </div>
  </div>
</template>
