<script setup lang="ts">
import {computed, onBeforeUnmount, onMounted, ref, watch} from "vue";
import {useRoute} from "vue-router";
import {
  DataAnalysis,
  Files,
  Fold,
  List,
  Menu,
  Message,
  MessageBox,
  Moon,
  Setting,
  Sunny,
  Tickets,
  User,
  UserFilled,
} from "@element-plus/icons-vue";

type ThemeMode = "system" | "light" | "dark";

const route = useRoute();
const collapsed = ref(localStorage.getItem("codex-auth-manager-sidebar") === "collapsed");
const mobileMenu = ref(false);
const themeMode = ref<ThemeMode>((localStorage.getItem("codex-auth-manager-theme") as ThemeMode) || "system");
const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");

const navItems = [
  {to: "/", label: "概览", icon: DataAnalysis},
  {to: "/accounts", label: "账号管理", icon: UserFilled},
  {to: "/register", label: "注册链路", icon: User},
  {to: "/mail-sources", label: "邮箱来源", icon: Tickets},
  {to: "/mailboxes", label: "邮箱管理", icon: MessageBox},
  {to: "/jobs", label: "任务日志", icon: List},
  {to: "/settings", label: "配置", icon: Setting},
];

const activePath = computed(() => route.path);
const themeIcon = computed(() => themeMode.value === "dark" ? Moon : themeMode.value === "light" ? Sunny : Files);
const currentNav = computed(() => navItems.find((item) => item.to === route.path) ?? navItems[0]);

function applyTheme() {
  const dark = themeMode.value === "dark" || (themeMode.value === "system" && mediaQuery.matches);
  document.documentElement.classList.toggle("dark", dark);
}

function setTheme(mode: ThemeMode) {
  themeMode.value = mode;
  localStorage.setItem("codex-auth-manager-theme", mode);
  applyTheme();
}

function toggleSidebar() {
  collapsed.value = !collapsed.value;
  localStorage.setItem("codex-auth-manager-sidebar", collapsed.value ? "collapsed" : "expanded");
}

function handleSystemThemeChange() {
  if (themeMode.value === "system") {
    applyTheme();
  }
}

watch(() => route.path, () => {
  mobileMenu.value = false;
});

onMounted(() => {
  applyTheme();
  mediaQuery.addEventListener("change", handleSystemThemeChange);
});

onBeforeUnmount(() => {
  mediaQuery.removeEventListener("change", handleSystemThemeChange);
});
</script>

<template>
  <div class="app-shell grid h-dvh overflow-hidden bg-[var(--app-bg)]" :class="{collapsed}">
    <aside class="app-sidebar fixed left-0 top-0 z-50 h-dvh overflow-hidden border-r border-white/10 transition-transform md:sticky md:translate-x-0" :class="{open: mobileMenu}">
      <div class="flex h-[var(--header-height)] items-center gap-3 px-4 text-white">
        <div class="flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px] bg-gradient-to-br from-blue-600 to-teal-500 font-extrabold shadow-lg shadow-blue-700/30">AM</div>
        <div v-if="!collapsed" class="min-w-0">
          <div class="truncate text-sm font-bold">codex-auth-manager</div>
          <div class="mt-0.5 truncate text-xs text-slate-400">本地自动化管理台</div>
        </div>
      </div>

      <el-menu
        router
        :default-active="activePath"
        :collapse="collapsed"
        background-color="transparent"
        text-color="var(--sidebar-text)"
        active-text-color="var(--sidebar-active-text)"
        class="sidebar-menu"
      >
        <el-menu-item v-for="item in navItems" :key="item.to" :index="item.to">
          <el-icon><component :is="item.icon" /></el-icon>
          <span>{{ item.label }}</span>
        </el-menu-item>
      </el-menu>

      <div v-if="!collapsed" class="absolute bottom-3 left-3 right-3 flex items-center gap-2 rounded-[10px] border border-white/10 px-3 py-2 text-xs text-slate-400">
        <el-icon><Message /></el-icon>
        <span>仅监听 127.0.0.1</span>
      </div>
    </aside>

    <div v-if="mobileMenu" class="fixed inset-0 z-40 bg-slate-950/60 md:hidden" @click="mobileMenu = false" />

    <section class="flex h-dvh min-w-0 flex-col overflow-hidden">
      <header class="sticky top-0 z-30 flex h-[var(--header-height)] shrink-0 items-center justify-between gap-4 border-b border-[var(--app-border)] bg-[color-mix(in_srgb,var(--app-surface)_92%,transparent)] px-3 backdrop-blur md:px-5">
        <div class="flex min-w-0 items-center gap-3">
          <el-button class="desktop-toggle" :icon="collapsed ? Menu : Fold" text @click="toggleSidebar">
            {{ collapsed ? "展开" : "收起" }}
          </el-button>
          <el-button class="mobile-toggle" :icon="Menu" text @click="mobileMenu = true">菜单</el-button>
          <div class="min-w-0">
            <div class="text-base font-bold leading-tight text-[var(--app-text)]">{{ currentNav.label }}</div>
            <div class="mt-0.5 hidden text-xs text-[var(--app-muted)] sm:block">127.0.0.1 本地管理台</div>
          </div>
        </div>
        <el-dropdown trigger="click" @command="setTheme">
          <el-button :icon="themeIcon">
            {{ themeMode === "system" ? "跟随系统" : themeMode === "light" ? "浅色" : "深色" }}
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="system">跟随系统</el-dropdown-item>
              <el-dropdown-item command="light">浅色</el-dropdown-item>
              <el-dropdown-item command="dark">深色</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </header>

      <main class="min-w-0 flex-1 overflow-auto p-3 md:p-5 lg:p-6">
        <RouterView />
      </main>
    </section>
  </div>
</template>

<style scoped>
.app-shell {
    grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
    background:
        radial-gradient(circle at top left, rgba(37, 99, 235, 0.08), transparent 28rem),
        var(--app-bg);
}

.app-shell.collapsed {
    --sidebar-width: 76px;
}

.app-sidebar {
    width: var(--sidebar-width);
    background: linear-gradient(180deg, var(--app-sidebar) 0%, var(--app-sidebar-soft) 100%);
    transform: translateX(-100%);
}

.app-sidebar.open {
    transform: translateX(0);
}

.sidebar-menu {
    border-right: 0 !important;
    padding: 8px 10px;
}

.sidebar-menu :deep(.el-menu-item) {
    height: 44px;
    margin: 4px 0;
    border-radius: 10px;
}

.sidebar-menu :deep(.el-menu-item.is-active) {
    background: rgba(37, 99, 235, 0.24) !important;
    box-shadow: inset 3px 0 0 #38bdf8;
}

.mobile-toggle {
    display: inline-flex !important;
}

.desktop-toggle {
    display: none !important;
}

@media (min-width: 768px) {
    .app-sidebar {
        transform: translateX(0);
    }

    .mobile-toggle {
        display: none !important;
    }

    .desktop-toggle {
        display: inline-flex !important;
    }
}

@media (max-width: 767px) {
    .app-shell,
    .app-shell.collapsed {
        grid-template-columns: minmax(0, 1fr);
        --sidebar-width: 248px;
    }
}
</style>
