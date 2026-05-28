<script setup lang="ts">
import type {Account} from "../../api";

const props = defineProps<{
  row: Account;
  loading: boolean;
}>();

const emit = defineEmits<{
  (event: "check", id: number): void;
  (event: "refresh", id: number): void;
  (event: "reauth", row: Account, mode: "auto" | "manual"): void;
  (event: "push", row: Account): void;
  (event: "bindings", row: Account): void;
  (event: "profile", row: Account): void;
  (event: "detail", row: Account): void;
  (event: "export", id: number): void;
  (event: "delete", row: Account): void;
}>();
</script>

<template>
  <div class="flex flex-wrap gap-x-1 gap-y-0.5">
    <el-button link type="primary" :loading="loading" @click="emit('check', row.id)">检查</el-button>
    <el-button link type="primary" :loading="loading" @click="emit('refresh', row.id)">刷新</el-button>
    <el-dropdown trigger="click" @command="(mode: 'auto' | 'manual') => emit('reauth', row, mode)">
      <el-button link :type="row.needs_manual_reauth ? 'danger' : 'warning'">重登</el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="auto">自动重登（密码 + 邮箱验证码）</el-dropdown-item>
          <el-dropdown-item command="manual">人工重登（OAuth 回填）</el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
    <el-dropdown trigger="click" @command="(cmd: string) => {
      if (cmd === 'push') emit('push', row);
      else if (cmd === 'bindings') emit('bindings', row);
      else if (cmd === 'profile') emit('profile', row);
      else if (cmd === 'detail') emit('detail', row);
      else if (cmd === 'export') emit('export', row.id);
      else if (cmd === 'delete') emit('delete', row);
    }">
      <el-button link type="info">更多</el-button>
      <template #dropdown>
        <el-dropdown-menu>
          <el-dropdown-item command="push">推送</el-dropdown-item>
          <el-dropdown-item command="bindings">绑定平台</el-dropdown-item>
          <el-dropdown-item command="profile">编辑</el-dropdown-item>
          <el-dropdown-item command="detail">详情</el-dropdown-item>
          <el-dropdown-item command="export">导出</el-dropdown-item>
          <el-dropdown-item divided command="delete">
            <span class="text-red-500">删除</span>
          </el-dropdown-item>
        </el-dropdown-menu>
      </template>
    </el-dropdown>
  </div>
</template>
