<script setup lang="ts">
import type {Account, BoundPlatformService} from "../../api";

const props = defineProps<{row: Account}>();

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function bindingLabel(binding: BoundPlatformService) {
  return `${binding.kind === "cpa" ? "CPA" : "Sub2API"} / ${binding.name}`;
}

function bindingTagType(binding: BoundPlatformService): "" | "success" | "warning" | "info" | "danger" {
  if (binding.lastPushStatus === "success") return "success";
  if (binding.lastPushStatus === "failed") return "danger";
  return "info";
}
</script>

<template>
  <div>
    <div v-if="row.platform_bindings?.length" class="flex flex-wrap gap-1">
      <el-tooltip v-for="binding in row.platform_bindings" :key="binding.id"
                  :content="`最近推送: ${binding.lastPushStatus || '-'}${binding.lastPushAt ? ' @ ' + formatDate(binding.lastPushAt) : ''}${binding.lastPushMessage ? '\n' + binding.lastPushMessage : ''}`"
                  placement="top">
        <el-tag :type="bindingTagType(binding)" size="small" effect="plain">
          {{ bindingLabel(binding) }}
        </el-tag>
      </el-tooltip>
    </div>
    <span v-else class="text-slate-400">未绑定</span>
  </div>
</template>
