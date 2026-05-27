<script setup lang="ts">
import {computed, ref, watch} from "vue";
import {ElMessage} from "element-plus";
import {apiSend, type Account} from "../api";

const props = defineProps<{
  modelValue: boolean;
  accounts: Account[];
}>();

const emit = defineEmits<{
  (event: "update:modelValue", value: boolean): void;
  (event: "deleted"): void;
}>();

const deleteFromServiceIds = ref<number[]>([]);
const submitting = ref(false);

const isSingle = computed(() => props.accounts.length === 1);
const candidateServices = computed(() => {
  const map = new Map<number, {id: number; kind: string; name: string; accountCount: number}>();
  for (const account of props.accounts) {
    for (const binding of account.platform_bindings ?? []) {
      const existing = map.get(binding.id);
      if (existing) {
        existing.accountCount += 1;
      } else {
        map.set(binding.id, {id: binding.id, kind: binding.kind, name: binding.name, accountCount: 1});
      }
    }
  }
  return [...map.values()].sort((a, b) => a.id - b.id);
});

function close() {
  emit("update:modelValue", false);
}

async function confirmDelete() {
  if (!props.accounts.length) {
    return;
  }
  submitting.value = true;
  try {
    if (isSingle.value) {
      const account = props.accounts[0]!;
      const result = await apiSend<{deleted: boolean; platformErrors: Array<{serviceName: string; message: string}>; platformDeleted: Array<{serviceName: string}>}>(`/api/accounts/${account.id}`, "DELETE", {
        deleteFromServiceIds: deleteFromServiceIds.value,
      }) as {deleted: boolean; platformErrors: Array<{serviceName: string; message: string}>; platformDeleted: Array<{serviceName: string}>; platformSkipped?: Array<{serviceName: string; message: string}>};
      const errs = result.platformErrors ?? [];
      const ok = result.platformDeleted ?? [];
      const skipped = result.platformSkipped ?? [];
      if (errs.length) {
        ElMessage.warning(`已删除账号 ${account.email}；平台清理失败：${errs.map((e) => `${e.serviceName}(${e.message})`).join("；")}`);
      } else if (skipped.length) {
        ElMessage.warning(`已删除账号 ${account.email}；平台清理跳过：${skipped.map((e) => `${e.serviceName}(${e.message})`).join("；")}`);
      } else if (ok.length) {
        ElMessage.success(`已删除账号 ${account.email}，并清理了 ${ok.length} 个平台`);
      } else {
        ElMessage.success(`已删除账号 ${account.email}`);
      }
    } else {
      const result = await apiSend<{total: number; deleted: number; failures: Array<{id: number; message: string}>; perAccount: Array<{platformErrors: unknown[]; platformSkipped?: unknown[]}>}>("/api/accounts/bulk-delete", "POST", {
        ids: props.accounts.map((account) => account.id),
        deleteFromServiceIds: deleteFromServiceIds.value,
      });
      const failureMessages = result.failures?.length
          ? `；失败 ${result.failures.length} 个：${result.failures.slice(0, 3).map((f) => `#${f.id}(${f.message})`).join("；")}`
          : "";
      const platformErrorCount = (result.perAccount ?? []).reduce((sum, item) => sum + (item.platformErrors?.length ?? 0), 0);
      const platformSkippedCount = (result.perAccount ?? []).reduce((sum, item) => sum + (item.platformSkipped?.length ?? 0), 0);
      const platformWarn = platformErrorCount ? `；平台清理失败 ${platformErrorCount} 次` : "";
      const platformSkipped = platformSkippedCount ? `；平台清理跳过 ${platformSkippedCount} 次` : "";
      if (result.failures?.length || platformErrorCount || platformSkippedCount) {
        ElMessage.warning(`已删除 ${result.deleted}/${result.total} 个账号${failureMessages}${platformWarn}${platformSkipped}`);
      } else {
        ElMessage.success(`已删除 ${result.deleted} 个账号`);
      }
    }
    emit("deleted");
    close();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    submitting.value = false;
  }
}

watch(() => props.modelValue, (visible) => {
  if (visible) {
    deleteFromServiceIds.value = [];
    submitting.value = false;
  }
});
</script>

<template>
  <el-dialog :model-value="modelValue" :title="isSingle ? '删除账号' : `删除 ${accounts.length} 个账号`" width="520px"
             :close-on-click-modal="false"
             @update:model-value="(value: boolean) => emit('update:modelValue', value)" @close="close">
    <el-alert type="warning" show-icon class="mb-3"
              :title="isSingle ? `将删除账号：${accounts[0]?.email}` : `将批量删除 ${accounts.length} 个账号`"
              description="本地账号、绑定、授权文件元数据、用量记录都会被清空（磁盘上的 auth 文件不会自动删除）。"/>

    <el-form label-position="top">
      <el-form-item v-if="candidateServices.length" label="同时删除以下平台上的远端 record（可选）">
        <el-checkbox-group v-model="deleteFromServiceIds">
          <div class="flex flex-col gap-1">
            <el-checkbox v-for="service in candidateServices" :key="service.id" :label="service.id">
              {{ service.kind === "cpa" ? "CPA" : "Sub2API" }} / {{ service.name }}
              <span v-if="!isSingle" class="ml-1 text-xs text-slate-400">（{{ service.accountCount }} 个账号绑定）</span>
            </el-checkbox>
          </div>
        </el-checkbox-group>
        <div class="mt-2 text-xs text-rose-500">勾选后会调用平台 DELETE API 删除远端记录，操作不可逆。</div>
      </el-form-item>
      <div v-else class="text-xs text-slate-500">所选账号未绑定任何平台。</div>
    </el-form>

    <template #footer>
      <el-button @click="close">取消</el-button>
      <el-button type="danger" :loading="submitting" @click="confirmDelete">
        {{ deleteFromServiceIds.length ? `删除本地 + ${deleteFromServiceIds.length} 个平台 record` : "仅删除本地" }}
      </el-button>
    </template>
  </el-dialog>
</template>
