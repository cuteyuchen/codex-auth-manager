<script setup lang="ts">
import {computed, onMounted, reactive, ref, watch} from "vue";
import {ElMessage} from "element-plus";
import {Check, Refresh} from "@element-plus/icons-vue";
import {apiGet, apiSend, type HeroSmsBalance, type HeroSmsCountry, type HeroSmsPrice} from "../api";

const config = reactive<Record<string, any>>({});
const scheduler = reactive({enabled: true, dailyTime: "03:30", lastRunStatus: "", nextRunHint: ""});
const secretInputs = reactive<Record<string, string>>({});
const heroCountries = ref<HeroSmsCountry[]>([]);
const heroPrices = ref<HeroSmsPrice[]>([]);
const heroBalance = ref<HeroSmsBalance | null>(null);
const heroError = ref("");
const heroPriceError = ref("");
const heroBalanceError = ref("");
const loadingHero = ref(false);

const secretKeys = [
  "defaultPassword",
  "gmailAccessToken",
  "gptMailApiKey",
  "2925Password",
  "cloudflareApiKey",
  "heroSMSApiKey",
  "cliproxyApiManagementKey",
  "sub2apiAdminApiKey",
];

const selectedHeroPrice = computed(() => heroPrices.value[0]);

function heroCountryLabel(country: HeroSmsCountry) {
  const primary = country.countryName || country.countryNameEn || country.countryNameRu || `国家 ID: ${country.countryId}`;
  const secondary = country.countryNameEn && country.countryNameEn !== primary ? ` / ${country.countryNameEn}` : "";
  const phoneCode = country.phoneCode ? ` +${country.phoneCode}` : "";
  return `${primary}${secondary}${phoneCode} (ID: ${country.countryId})`;
}

async function load() {
  try {
    Object.assign(config, await apiGet<Record<string, unknown>>("/api/config"));
    Object.assign(scheduler, await apiGet<Record<string, unknown>>("/api/scheduler"));
    await Promise.all([
      loadHeroCountries(),
      loadHeroBalance(),
    ]);
    await loadHeroPrices();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

function secretPlaceholder(key: string) {
  const value = config[key];
  if (value?.hasValue) {
    return `已配置，尾号 ${value.tail}`;
  }
  return "未配置";
}

async function save() {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!secretKeys.includes(key)) {
      patch[key] = value;
    }
  }
  for (const key of secretKeys) {
    if (secretInputs[key]) {
      patch[key] = secretInputs[key];
    }
  }
  try {
    Object.assign(config, await apiSend<Record<string, unknown>>("/api/config", "PUT", patch));
    Object.assign(scheduler, await apiSend("/api/scheduler", "PUT", {
      enabled: scheduler.enabled,
      dailyTime: scheduler.dailyTime,
    }));
    for (const key of secretKeys) {
      secretInputs[key] = "";
    }
    ElMessage.success("配置已保存");
    await loadHeroPrices();
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  }
}

async function loadHeroCountries() {
  loadingHero.value = true;
  heroError.value = "";
  try {
    const payload = await apiGet<{countries: HeroSmsCountry[]; error?: string}>("/api/hero-sms/countries");
    heroCountries.value = payload.countries;
    heroError.value = payload.error || "";
  } catch (error) {
    heroError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loadingHero.value = false;
  }
}

async function loadHeroBalance() {
  heroBalanceError.value = "";
  heroBalance.value = null;
  try {
    const payload = await apiGet<{balance: HeroSmsBalance | null; error?: string}>("/api/hero-sms/balance");
    heroBalance.value = payload.balance;
    heroBalanceError.value = payload.error || "";
  } catch (error) {
    heroBalanceError.value = error instanceof Error ? error.message : String(error);
  }
}

async function loadHeroPrices() {
  heroPriceError.value = "";
  heroPrices.value = [];
  if (!config.heroSMSCountry) {
    return;
  }
  try {
    const payload = await apiGet<{prices: HeroSmsPrice[]; error?: string}>(`/api/hero-sms/prices?country=${encodeURIComponent(config.heroSMSCountry)}&service=dr`);
    heroPrices.value = payload.prices;
    heroPriceError.value = payload.error || "";
  } catch (error) {
    heroPriceError.value = error instanceof Error ? error.message : String(error);
  }
}

function formatBalance(value: HeroSmsBalance | null) {
  if (!value || typeof value.balance !== "number") {
    return "未返回";
  }
  return `${value.balance.toFixed(4)}${value.currency ? ` ${value.currency}` : ""}`;
}

watch(() => config.heroSMSCountry, () => {
  void loadHeroPrices();
});

onMounted(load);
</script>

<template>
  <section>
    <div class="page-head">
      <div>
        <h1 class="page-title">配置</h1>
        <p class="page-subtitle">保存后新任务会读取最新配置；敏感字段只显示是否已配置。</p>
      </div>
      <el-button :icon="Check" type="primary" @click="save">保存</el-button>
    </div>

    <el-row :gutter="14">
      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="mb-4">
          <template #header>基础</template>
          <el-form label-position="top" :model="config">
            <el-alert title="配置页是全局配置唯一入口；邮箱 provider 与 Hotmail 模式已移到注册页，那里只影响单次 Web 注册任务。" type="info" show-icon class="mb-3" />
            <el-form-item label="默认代理"><el-input v-model="config.defaultProxyUrl" /></el-form-item>
            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="默认密码">
                  <el-input v-model="secretInputs.defaultPassword" type="password" show-password :placeholder="secretPlaceholder('defaultPassword')" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="循环间隔 ms"><el-input-number v-model="config.loopDelayMs" :min="1000" class="w-full" /></el-form-item>
              </el-col>
            </el-row>
          </el-form>
        </el-card>

        <el-card shadow="never" class="mb-4">
          <template #header>定时刷新</template>
          <el-form label-position="top" :model="scheduler">
            <el-form-item label="启用"><el-switch v-model="scheduler.enabled" /></el-form-item>
            <el-form-item label="每日时间"><el-input v-model="scheduler.dailyTime" placeholder="03:30" /></el-form-item>
            <el-alert :title="`上次结果：${scheduler.lastRunStatus || 'never'}；计划：${scheduler.nextRunHint || '-'}`" type="info" show-icon />
          </el-form>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="mb-4">
          <template #header>远端推送</template>
          <el-form label-position="top" :model="config">
            <el-form-item label="CPA Base URL"><el-input v-model="config.cliproxyApiBaseUrl" /></el-form-item>
            <el-form-item label="CPA 管理密钥">
              <el-input v-model="secretInputs.cliproxyApiManagementKey" type="password" show-password :placeholder="secretPlaceholder('cliproxyApiManagementKey')" />
            </el-form-item>
            <el-form-item label="Sub2API Base URL"><el-input v-model="config.sub2apiBaseUrl" /></el-form-item>
            <el-form-item label="Sub2API Admin Key">
              <el-input v-model="secretInputs.sub2apiAdminApiKey" type="password" show-password :placeholder="secretPlaceholder('sub2apiAdminApiKey')" />
            </el-form-item>
          </el-form>
        </el-card>

        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <span>HeroSMS</span>
              <el-button :icon="Refresh" :loading="loadingHero" size="small" @click="() => { void loadHeroCountries(); void loadHeroBalance(); }">刷新</el-button>
            </div>
          </template>
          <el-form label-position="top" :model="config">
            <el-form-item label="HeroSMS API Key">
              <el-input v-model="secretInputs.heroSMSApiKey" type="password" show-password :placeholder="secretPlaceholder('heroSMSApiKey')" />
            </el-form-item>
            <div class="mb-3 rounded-lg border border-[var(--el-border-color-light)] bg-[var(--el-fill-color-lighter)] px-3 py-2">
              <div class="text-xs text-[var(--el-text-color-secondary)]">当前余额</div>
              <div class="mt-1 text-lg font-semibold text-[var(--el-text-color-primary)]">{{ formatBalance(heroBalance) }}</div>
              <div v-if="heroBalanceError" class="mt-1 text-xs text-amber-600">{{ heroBalanceError }}</div>
            </div>
            <el-form-item label="国家">
              <el-select v-model="config.heroSMSCountry" filterable class="w-full" placeholder="选择国家">
                <el-option
                  v-for="country in heroCountries"
                  :key="country.countryId"
                  :label="heroCountryLabel(country)"
                  :value="country.countryId"
                  class="hero-country-option"
                >
                  <div class="flex h-8 items-center justify-between gap-3">
                    <span class="min-w-0 truncate text-sm">
                      {{ heroCountryLabel(country) }}
                    </span>
                    <span class="flex shrink-0 items-center gap-1">
                      <el-tag v-if="country.visible === false" size="small" type="danger" effect="plain">隐藏</el-tag>
                      <el-tag v-if="country.retry === true" size="small" type="success" effect="plain">重试</el-tag>
                      <el-tag v-if="country.rent === true" size="small" type="info" effect="plain">租用</el-tag>
                      <el-tag v-if="country.multiService === true" size="small" type="warning" effect="plain">多服务</el-tag>
                    </span>
                  </div>
                </el-option>
              </el-select>
              <div v-if="heroError" class="mt-2 text-sm text-amber-600">{{ heroError }}</div>
            </el-form-item>
            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="最高价格"><el-input-number v-model="config.heroSMSMaxPrice" :step="0.01" :min="0" class="w-full" /></el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="轮询次数"><el-input-number v-model="config.heroSMSPollAttempts" :min="1" class="w-full" /></el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="轮询间隔 ms"><el-input-number v-model="config.heroSMSPollIntervalMs" :min="1000" class="w-full" /></el-form-item>
            <el-alert
              v-if="selectedHeroPrice"
              :title="`OpenAI(dr) 当前价格：${selectedHeroPrice.price ?? '未返回'}${selectedHeroPrice.currency ? ' ' + selectedHeroPrice.currency : ''}，可用数量：${selectedHeroPrice.available ?? '未返回'}`"
              type="success"
              show-icon
            />
            <el-alert v-else :title="heroPriceError || '价格接口未返回'" type="warning" show-icon />
          </el-form>
        </el-card>
      </el-col>
    </el-row>
  </section>
</template>

<style scoped>
:deep(.hero-country-option) {
  height: 34px;
  line-height: 34px;
  padding-top: 0;
  padding-bottom: 0;
}
</style>
