<script setup lang="ts">
import {Search} from "@element-plus/icons-vue";
import type {IntegrationService} from "../../api";

const props = defineProps<{
  filters: {
    q: string;
    status: string;
    credentialType: string;
    plan: string;
    autoReauth: string;
    pushStatus: string;
  };
  bindingFilterServiceIds: number[];
  enabledServices: IntegrationService[];
}>();

const emit = defineEmits<{
  (event: "search"): void;
  (event: "reset"): void;
  (event: "update:filters", value: typeof props.filters): void;
  (event: "update:bindingFilterServiceIds", value: number[]): void;
}>();

const statusOptions = [
  {label: "正常", value: "authorized"},
  {label: "额度已用尽", value: "quota_exhausted"},
  {label: "凭据过期", value: "credential_expired"},
  {label: "账号异常", value: "account_abnormal"},
  {label: "需要人工重登", value: "needs_manual_reauth"},
  {label: "未检查", value: "unchecked"},
  {label: "只保存 accessToken", value: "access_token_only"},
];

const credentialOptions = [
  {label: "已授权 Codex auth", value: "codex_auth"},
  {label: "只保存 accessToken", value: "access_token_only"},
  {label: "无凭据", value: "none"},
];
</script>

<template>
  <el-form label-position="left" class="filter-form">
    <div class="filter-grid">
      <el-form-item label="关键词">
        <el-input :model-value="filters.q" clearable placeholder="邮箱/状态"
                  @update:model-value="(v: string) => emit('update:filters', {...filters, q: v})"
                  @keyup.enter="emit('search')"/>
      </el-form-item>
      <el-form-item label="状态">
        <el-select :model-value="filters.status" clearable placeholder="全部" class="w-full"
                   @update:model-value="(v: string) => emit('update:filters', {...filters, status: v})">
          <el-option v-for="item in statusOptions" :key="item.value" :label="item.label" :value="item.value"/>
        </el-select>
      </el-form-item>
      <el-form-item label="凭据">
        <el-select :model-value="filters.credentialType" clearable placeholder="全部" class="w-full"
                   @update:model-value="(v: string) => emit('update:filters', {...filters, credentialType: v})">
          <el-option v-for="item in credentialOptions" :key="item.value" :label="item.label" :value="item.value"/>
        </el-select>
      </el-form-item>
      <el-form-item label="绑定平台">
        <el-select :model-value="bindingFilterServiceIds" multiple collapse-tags clearable filterable class="w-full"
                   placeholder="全部"
                   @update:model-value="(v: number[]) => emit('update:bindingFilterServiceIds', v)">
          <el-option v-for="service in enabledServices" :key="service.id"
                     :label="`${service.kind === 'cpa' ? 'CPA' : 'Sub2API'} / ${service.name}`"
                     :value="service.id"/>
        </el-select>
      </el-form-item>
      <el-form-item label="套餐">
        <el-input :model-value="filters.plan" clearable placeholder="free/plus"
                  @update:model-value="(v: string) => emit('update:filters', {...filters, plan: v})"/>
      </el-form-item>
      <el-form-item label="自动重登">
        <el-select :model-value="filters.autoReauth" clearable placeholder="全部" class="w-full"
                   @update:model-value="(v: string) => emit('update:filters', {...filters, autoReauth: v})">
          <el-option label="开启" value="true"/>
          <el-option label="关闭" value="false"/>
        </el-select>
      </el-form-item>
      <el-form-item label="推送">
        <el-select :model-value="filters.pushStatus" clearable placeholder="全部" class="w-full"
                   @update:model-value="(v: string) => emit('update:filters', {...filters, pushStatus: v})">
          <el-option label="已推送" value="pushed"/>
          <el-option label="未推送" value="not_pushed"/>
        </el-select>
      </el-form-item>
      <el-form-item>
        <div class="filter-actions flex w-full gap-2">
          <el-button :icon="Search" type="primary" class="flex-1" @click="emit('search')">筛选</el-button>
          <el-button class="flex-1" @click="emit('reset')">重置</el-button>
        </div>
      </el-form-item>
    </div>
  </el-form>
</template>
