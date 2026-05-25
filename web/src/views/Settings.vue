<script setup lang="ts">
import {computed, onMounted, reactive, ref, watch} from "vue";
import {ElMessage} from "element-plus";
import {Check, Connection, Refresh} from "@element-plus/icons-vue";
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
const loadingHeroPrices = ref(false);
const heroService = ref("dr");
let heroServiceRefreshTimer: ReturnType<typeof setTimeout> | undefined;
const testingProxy = ref(false);
const proxyTestResult = ref<{
  ok: boolean;
  proxyUrl: string;
  targetUrl: string;
  status: number | null;
  elapsedMs: number;
  message: string;
} | null>(null);

const loopDelaySeconds = computed({
  get: () => Math.max(0, Math.round(Number(config.loopDelayMs ?? 0) / 1000)),
  set: (value: number) => {
    config.loopDelayMs = Math.max(0, Number(value) || 0) * 1000;
  },
});

const secretKeys = [
  "defaultPassword",
  "gmailAccessToken",
  "gptMailApiKey",
  "2925Password",
  "cloudflareApiKey",
  "heroSMSApiKey",
  "webAccessPassword",
];

const legacyPushConfigKeys = new Set([
  "cliproxyApiAutoUploadAuth",
  "cliproxyApiBaseUrl",
  "cliproxyApiManagementKey",
  "sub2apiAutoUploadAuth",
  "sub2apiBaseUrl",
  "sub2apiAdminApiKey",
  "sub2apiGroupIds",
  "sub2apiProxyId",
  "sub2apiConcurrency",
  "sub2apiPriority",
  "sub2apiRateMultiplier",
  "sub2apiLoadFactor",
  "sub2apiAutoPauseOnExpired",
  "sub2apiUpdateExisting",
  "sub2apiSkipDefaultGroupBind",
  "sub2apiConfirmMixedChannelRisk",
]);

const selectedHeroPrice = computed(() => heroPrices.value[0]);
const selectedHeroCountry = computed(() => heroCountries.value.find((country) => String(country.countryId) === String(config.heroSMSCountry)) ?? null);
const heroPriceStatus = computed(() => {
  const price = selectedHeroPrice.value?.price;
  const maxPrice = Number(config.heroSMSMaxPrice);
  if (typeof price !== "number" || !Number.isFinite(price) || !Number.isFinite(maxPrice) || maxPrice <= 0) {
    return null;
  }
  if (price > maxPrice) {
    return {
      type: "warning" as const,
      title: `当前价格 ${formatPrice(selectedHeroPrice.value)} 高于最高价格 ${maxPrice}`,
    };
  }
  return {
    type: "success" as const,
    title: `当前价格 ${formatPrice(selectedHeroPrice.value)} 未超过最高价格 ${maxPrice}`,
  };
});

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
    if (legacyPushConfigKeys.has(key)) {
      continue;
    }
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

async function testDefaultProxy() {
  testingProxy.value = true;
  proxyTestResult.value = null;
  try {
    proxyTestResult.value = await apiSend<typeof proxyTestResult.value>("/api/config/proxy-test", "POST", {
      proxyUrl: config.defaultProxyUrl || "",
    });
    if (proxyTestResult.value?.ok) {
      ElMessage.success(`代理可用，耗时 ${proxyTestResult.value.elapsedMs}ms`);
    } else {
      ElMessage.error(proxyTestResult.value?.message || "代理不可用");
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    testingProxy.value = false;
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
  loadingHeroPrices.value = true;
  try {
    const service = heroService.value.trim() || "dr";
    const payload = await apiGet<{prices: HeroSmsPrice[]; error?: string}>(`/api/hero-sms/prices?country=${encodeURIComponent(config.heroSMSCountry)}&service=${encodeURIComponent(service)}`);
    heroPrices.value = payload.prices;
    heroPriceError.value = payload.error || "";
  } catch (error) {
    heroPriceError.value = error instanceof Error ? error.message : String(error);
  } finally {
    loadingHeroPrices.value = false;
  }
}

async function refreshHeroSms() {
  await Promise.all([
    loadHeroCountries(),
    loadHeroBalance(),
    loadHeroPrices(),
  ]);
}

function formatBalance(value: HeroSmsBalance | null) {
  if (!value || typeof value.balance !== "number") {
    return "未返回";
  }
  return `${value.balance.toFixed(4)}${value.currency ? ` ${value.currency}` : ""}`;
}

function formatPrice(value: HeroSmsPrice | null | undefined) {
  if (!value || typeof value.price !== "number") {
    return "未返回";
  }
  return `${value.price.toFixed(4)}${value.currency ? ` ${value.currency}` : ""}`;
}

function formatAvailable(value: HeroSmsPrice | null | undefined) {
  if (!value || typeof value.available !== "number") {
    return "未返回";
  }
  return String(value.available);
}

watch(() => config.heroSMSCountry, () => {
  void loadHeroPrices();
});

watch(heroService, () => {
  if (heroServiceRefreshTimer) {
    clearTimeout(heroServiceRefreshTimer);
  }
  heroServiceRefreshTimer = setTimeout(() => {
    void loadHeroPrices();
  }, 300);
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
            <el-form-item label="默认代理">
              <el-input v-model="config.defaultProxyUrl" placeholder="http://127.0.0.1:10808">
                <template #append>
                  <el-button :icon="Connection" :loading="testingProxy" @click="testDefaultProxy">测试</el-button>
                </template>
              </el-input>
              <div v-if="proxyTestResult" class="mt-2 w-full rounded-lg border px-3 py-2 text-sm" :class="proxyTestResult.ok ? 'border-green-200 bg-green-50 text-green-700' : 'border-red-200 bg-red-50 text-red-700'">
                <div class="font-medium">{{ proxyTestResult.message }}</div>
                <div class="mt-1 text-xs opacity-80">
                  目标 {{ proxyTestResult.targetUrl }}；状态 {{ proxyTestResult.status ?? "-" }}；耗时 {{ proxyTestResult.elapsedMs }}ms
                </div>
              </div>
            </el-form-item>
            <el-row :gutter="12">
              <el-col :span="12">
                <el-form-item label="默认密码">
                  <el-input v-model="secretInputs.defaultPassword" type="password" show-password :placeholder="secretPlaceholder('defaultPassword')" />
                </el-form-item>
              </el-col>
              <el-col :span="12">
                <el-form-item label="循环间隔（秒）"><el-input-number v-model="loopDelaySeconds" :min="0" class="w-full" /></el-form-item>
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

        <el-card shadow="never" class="mb-4">
          <template #header>访问控制</template>
          <el-form label-position="top" :model="config">
            <el-alert title="留空表示本机访问不需要密码；如果服务绑定到非本地地址，必须先设置访问密码。" type="warning" show-icon class="mb-3" />
            <el-form-item label="Web 访问密码">
              <el-input v-model="secretInputs.webAccessPassword" type="password" show-password :placeholder="secretPlaceholder('webAccessPassword')" />
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="12">
        <el-card shadow="never">
          <template #header>
            <div class="flex items-center justify-between">
              <span>HeroSMS</span>
              <el-button :icon="Refresh" :loading="loadingHero || loadingHeroPrices" size="small" @click="refreshHeroSms">刷新</el-button>
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
              <el-col :xs="24" :sm="12">
                <el-form-item label="服务代码">
                  <el-input
                    v-model="heroService"
                    placeholder="dr"
                    clearable
                    @keyup.enter="loadHeroPrices"
                  >
                    <template #append>
                      <el-button :icon="Refresh" :loading="loadingHeroPrices" @click="loadHeroPrices">价格</el-button>
                    </template>
                  </el-input>
                </el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="当前查询">
                  <div class="flex min-h-8 w-full flex-wrap items-center gap-2 rounded-md border border-[var(--el-border-color)] px-3 py-1.5 text-sm">
                    <el-tag size="small" effect="plain">{{ selectedHeroCountry?.countryName || selectedHeroCountry?.countryNameEn || config.heroSMSCountry || "未选择国家" }}</el-tag>
                    <el-tag size="small" type="info" effect="plain">服务 {{ heroService.trim() || "dr" }}</el-tag>
                  </div>
                </el-form-item>
              </el-col>
            </el-row>
            <el-row :gutter="12">
              <el-col :xs="24" :sm="12">
                <el-form-item label="最高价格"><el-input-number v-model="config.heroSMSMaxPrice" :step="0.01" :min="0" class="w-full" /></el-form-item>
              </el-col>
              <el-col :xs="24" :sm="12">
                <el-form-item label="轮询次数"><el-input-number v-model="config.heroSMSPollAttempts" :min="1" class="w-full" /></el-form-item>
              </el-col>
            </el-row>
            <el-form-item label="轮询间隔 ms"><el-input-number v-model="config.heroSMSPollIntervalMs" :min="1000" class="w-full" /></el-form-item>
            <div class="rounded-lg border border-[var(--el-border-color-light)]">
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--el-border-color-light)] px-3 py-2">
                <div>
                  <div class="text-sm font-medium text-[var(--el-text-color-primary)]">当前价格与号码数量</div>
                  <div class="text-xs text-[var(--el-text-color-secondary)]">来自 HeroSMS getPrices，按国家和服务返回。</div>
                </div>
                <el-button :icon="Refresh" :loading="loadingHeroPrices" size="small" @click="loadHeroPrices">刷新价格</el-button>
              </div>
              <el-table
                v-if="heroPrices.length > 0"
                :data="heroPrices"
                size="small"
                class="w-full"
              >
                <el-table-column label="国家" min-width="140">
                  <template #default="{row}">
                    <div class="font-medium">{{ row.countryName || selectedHeroCountry?.countryName || row.countryId }}</div>
                    <div class="text-xs text-[var(--el-text-color-secondary)]">
                      ID {{ row.countryId }}<span v-if="row.phoneCode || selectedHeroCountry?.phoneCode"> · +{{ row.phoneCode || selectedHeroCountry?.phoneCode }}</span>
                    </div>
                  </template>
                </el-table-column>
                <el-table-column label="服务" min-width="90">
                  <template #default="{row}">
                    <el-tag size="small" effect="plain">{{ row.service || heroService.trim() || "dr" }}</el-tag>
                  </template>
                </el-table-column>
                <el-table-column label="当前价格" min-width="110">
                  <template #default="{row}">
                    <span class="tabular-nums">{{ formatPrice(row) }}</span>
                  </template>
                </el-table-column>
                <el-table-column label="可用号码" min-width="100">
                  <template #default="{row}">
                    <span class="tabular-nums">{{ formatAvailable(row) }}</span>
                  </template>
                </el-table-column>
              </el-table>
              <div v-else class="px-3 py-4 text-sm text-amber-600">
                {{ heroPriceError || (config.heroSMSCountry ? "价格接口未返回" : "请选择国家后查询价格") }}
              </div>
            </div>
            <el-alert
              v-if="heroPriceStatus"
              class="mt-3"
              :title="heroPriceStatus.title"
              :type="heroPriceStatus.type"
              show-icon
            />
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
