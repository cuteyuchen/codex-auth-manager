<script setup lang="ts">
import type {Account} from "../../api";
import {CREDENTIAL_TYPES} from "../../../../src/shared/constants";

const props = defineProps<{row: Account}>();

function credentialLabel(row: Account) {
  const value = row.credential_type || row.auth_credential_type || "none";
  return CREDENTIAL_TYPES.find((item) => item.value === value)?.label || value;
}
</script>

<template>
  <div class="flex flex-col">
    <span class="text-sm font-medium">{{ row.email }}</span>
    <span class="text-xs text-slate-500">{{ credentialLabel(row) }}</span>
  </div>
</template>
