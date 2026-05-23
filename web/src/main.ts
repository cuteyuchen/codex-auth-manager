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
  ],
});

createApp(App).use(router).use(ElementPlus).mount("#app");
