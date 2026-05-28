<script setup lang="ts">
import type {Account} from "../../api";

const props = defineProps<{row: Account}>();
</script>

<template>
  <div class="text-sm">
    <!-- 邮箱绑定状态 -->
    <div v-if="row.mailbox_id">
      <el-tag size="small" type="success" effect="plain">已绑定邮箱 #{{ row.mailbox_id }}</el-tag>
    </div>
    <div v-else>
      <el-tag size="small" type="info" effect="plain">未绑定邮箱</el-tag>
    </div>
    <!-- 密码/自动重登 -->
    <div class="mt-0.5 text-xs text-slate-400">
      密码 {{ row.has_password ? "已保存" : "未保存" }} · 自动重登 {{ row.auto_reauth ? "开启" : "关闭" }}
    </div>
  </div>
</template>
