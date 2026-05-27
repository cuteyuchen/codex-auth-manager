<script setup lang="ts">
import type {Account, UsageWindow} from "../../api";

const props = defineProps<{row: Account}>();

function formatPercent(value: number | null | undefined) {
  return typeof value === "number" ? `${value.toFixed(2)}%` : "未返回";
}

function formatResetAt(value: string | null | undefined) {
  if (!value) return "重置 -";
  return `重置 ${new Date(value).toLocaleString()}`;
}

function usageWindows(row: Account): UsageWindow[] {
  const plan = String(row.plan ?? "").toLowerCase();
  const isFree = !plan || plan.includes("free");
  if (row.usage_windows?.length) {
    const windows = row.usage_windows.map((item) => ({
      ...item,
      label: item.window_key === "primary" ? "5小时" : item.window_key === "secondary" ? "7天" : item.label,
    }));
    if (isFree) {
      return windows.filter((item) => item.label.includes("7") || item.window_key === "secondary").slice(0, 1);
    }
    return windows;
  }
  if (row.remaining_percent != null || row.used_percent != null) {
    return [{
      window_key: "primary",
      label: isFree ? "7天" : "5小时",
      used_percent: row.used_percent,
      remaining_percent: row.remaining_percent,
      reset_at: row.reset_at,
      limit_reached: null,
    }];
  }
  return [];
}
</script>

<template>
  <div>
    <div class="text-xs text-slate-500">{{ row.plan || "-" }}</div>
    <div v-if="usageWindows(row).length" class="mt-1 space-y-1">
      <div v-for="window in usageWindows(row)" :key="window.window_key">
        <div class="flex items-center gap-2">
          <span class="w-10 text-xs text-slate-500">{{ window.label }}</span>
          <el-progress :percentage="Math.max(0, Math.min(100, window.remaining_percent ?? 0))"
                       :stroke-width="8" class="min-w-24 flex-1"/>
          <span class="w-16 text-xs">{{ formatPercent(window.remaining_percent) }}</span>
        </div>
        <div class="ml-12 text-xs text-slate-500">{{ formatResetAt(window.reset_at) }}</div>
      </div>
    </div>
    <span v-else class="text-slate-400">未返回</span>
  </div>
</template>
