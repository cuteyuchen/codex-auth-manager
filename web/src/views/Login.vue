<script setup lang="ts">
import {onMounted, ref} from "vue";
import {useRoute, useRouter} from "vue-router";
import {ElMessage} from "element-plus";
import {Lock, Right} from "@element-plus/icons-vue";
import {apiGet, apiSend, type SessionState} from "../api";

const route = useRoute();
const router = useRouter();
const password = ref("");
const loading = ref(false);
const checking = ref(true);

async function checkSession() {
  checking.value = true;
  try {
    const state = await apiGet<SessionState>("/api/session");
    if (!state.passwordEnabled || state.authenticated) {
      await router.replace(String(route.query.next || "/"));
    }
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    checking.value = false;
  }
}

async function submit() {
  loading.value = true;
  try {
    await apiSend("/api/session/login", "POST", {password: password.value});
    ElMessage.success("已登录");
    await router.replace(String(route.query.next || "/"));
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : String(error));
  } finally {
    loading.value = false;
  }
}

onMounted(checkSession);
</script>

<template>
  <section class="login-page">
    <el-card v-loading="checking" shadow="never" class="login-card">
      <div class="mb-5 flex items-center gap-3">
        <div class="flex h-11 w-11 items-center justify-center rounded-[10px] bg-blue-600 text-white">
          <el-icon size="22"><Lock /></el-icon>
        </div>
        <div>
          <h1 class="m-0 text-xl font-bold text-[var(--app-text)]">访问验证</h1>
          <p class="m-0 mt-1 text-sm text-[var(--app-muted)]">输入 Web 访问密码后继续使用管理台。</p>
        </div>
      </div>
      <el-form label-position="top" @submit.prevent>
        <el-form-item label="访问密码">
          <el-input
            v-model="password"
            type="password"
            show-password
            autocomplete="current-password"
            autofocus
            @keyup.enter="submit"
          />
        </el-form-item>
        <el-button :icon="Right" type="primary" class="w-full" :loading="loading" @click="submit">进入管理台</el-button>
      </el-form>
    </el-card>
  </section>
</template>

<style scoped>
.login-page {
  min-height: calc(100dvh - var(--header-height) - 48px);
  display: grid;
  place-items: center;
}

.login-card {
  width: min(420px, 100%);
}
</style>
