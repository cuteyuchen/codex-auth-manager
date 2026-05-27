<script setup lang="ts">
const props = defineProps<{
  loading: boolean;
  selectedCount: number;
}>();

const emit = defineEmits<{
  (event: "check"): void;
  (event: "refresh"): void;
  (event: "reauth"): void;
  (event: "push"): void;
  (event: "bindings"): void;
  (event: "export"): void;
  (event: "delete"): void;
}>();
</script>

<template>
  <div class="flex flex-wrap gap-1.5">
    <el-button :loading="loading" @click="emit('check')">批量检查</el-button>
    <el-button :loading="loading" @click="emit('refresh')">批量刷新</el-button>
    <el-button :loading="loading" @click="emit('reauth')">批量自动重登</el-button>
    <el-button :loading="loading" @click="emit('push')">批量推送</el-button>
    <el-button :loading="loading" @click="emit('bindings')">批量绑定平台</el-button>
    <el-button :loading="loading" @click="emit('export')">批量导出</el-button>
    <el-button type="danger" plain :disabled="loading" @click="emit('delete')">批量删除</el-button>
  </div>
</template>
