import {createApp} from "vue";
import {createRouter, createWebHistory} from "vue-router";
import ElementPlus from "element-plus";
import "element-plus/dist/index.css";
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import Dashboard from "./views/Dashboard.vue";
import Accounts from "./views/Accounts.vue";
import Register from "./views/Register.vue";
import MailSources from "./views/MailSources.vue";
import Mailboxes from "./views/Mailboxes.vue";
import Settings from "./views/Settings.vue";
import Jobs from "./views/Jobs.vue";
import Services from "./views/Services.vue";
import System from "./views/System.vue";
import Login from "./views/Login.vue";
import {apiGet, type SessionState} from "./api";
import "./style.css";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {path: "/", component: Dashboard},
    {path: "/accounts", component: Accounts},
    {path: "/register", component: Register},
    {path: "/mail-sources", component: MailSources},
    {path: "/mailboxes", component: Mailboxes},
    {path: "/settings", component: Settings},
    {path: "/jobs", component: Jobs},
    {path: "/services", component: Services},
    {path: "/system", component: System},
    {path: "/login", component: Login},
  ],
});

router.beforeEach(async (to) => {
  if (to.path === "/login") {
    return true;
  }
  const state = await apiGet<SessionState>("/api/session");
  if (state.passwordEnabled && !state.authenticated) {
    return {
      path: "/login",
      query: {next: to.fullPath},
    };
  }
  return true;
});

createApp(App).use(router).use(ElementPlus).mount("#app");
