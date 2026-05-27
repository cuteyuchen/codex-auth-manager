<script setup lang="ts">
import type {Account} from "../../api";

const props = defineProps<{row: Account}>();

const credentialOptions = [
  {label: "已授权 Codex auth", value: "codex_auth"},
  {label: "只保存 accessToken", value: "access_token_only"},
  {label: "无凭据", value: "none"},
];

function credentialLabel(row: Account) {
  const value = row.credential_type || row.auth_credential_type || "none";
  return credentialOptions.find((item) => item.value === value)?.label || value;
}
</script>

<template>
  <div class="flex flex-col">
    <span class="text-sm font-medium">{{ row.email }}</span>
    <span class="text-xs text-slate-500">{{ credentialLabel(row) }}</span>
  </div>
</template>
