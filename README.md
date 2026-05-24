# codex-auth-manager

本地化 ChatGPT / Codex 账号注册授权与凭据运营管理台，支持邮箱池、状态刷新、额度监控和 CPA/Sub2API 推送。

本项目是一个本地 Web 管理台，用于管理 ChatGPT / Codex 注册授权链路、邮箱库存、账号凭据、额度状态、任务日志，以及 CPA / Sub2API 推送。

当前项目是本地 Web 管理台：前端是 Vue 3 + Vite + Element Plus + TailwindCSS，后端是 Fastify + SQLite。配置唯一真源是本地 SQLite。

## 免责声明

本项目仅供学习、研究与接口行为测试使用。使用者应自行确保用途符合目标平台服务条款、当地法律法规以及所在网络环境要求。

因使用本项目导致的账号风险、访问限制、数据丢失、封禁、法律责任或其他损失，均由使用者自行承担，项目作者与维护者不承担任何直接或间接责任。

## 环境要求

- Node.js 20 推荐，至少需要 Node.js 18+
- Windows / macOS / Linux 均可运行
- 需要本机可以访问 SQLite 数据目录
- 只有 OpenAI 注册、登录、授权、额度检查等 OpenAI 请求需要走代理
- HeroSMS、邮箱服务、CPA、Sub2API 等非 OpenAI 请求默认走本地网络

## 快速开始

安装依赖：

```bash
npm install
```

开发模式启动后端 watch 和前端 HMR：

```bash
npm run web:dev
```

构建生产产物：

```bash
npm run build
```

启动构建后的本地管理台：

```bash
npm run web
```

默认访问地址：

```text
http://127.0.0.1:3789/
```

如需换端口：

```bash
CODEX_REGISTER_WEB_PORT=3792 npm run web
```

Windows `cmd` 可使用：

```bat
set CODEX_REGISTER_WEB_PORT=3792&& npm run web
```

健康检查：

```text
GET http://127.0.0.1:3789/api/health
```

正常返回：

```json
{"ok":true}
```

## 配置方式

所有配置都通过 Web 管理台“配置”页维护，并保存到：

```text
data/codex-auth-manager.db
```

敏感字段使用本地密钥加密：

```text
data/local.key
```

配置页保存后，新任务会读取最新 SQLite 配置，不需要重启服务。

## 目录结构

```text
web/                 Vue 3 前端
src/backend/         Fastify API、SQLite、任务、账号、邮箱、配置、调度服务
src/core/            OpenAI 注册授权核心、邮箱 provider、SMS provider、CPA/Sub2API 客户端
bundle/              构建后的后端入口，gitignored
web/dist/            构建后的前端产物
data/                SQLite 和本地密钥，gitignored
auth/                本地 Codex auth 文件，gitignored
hotmail/             本地 Hotmail 辅助文件，gitignored
```

当前生产打包只生成：

```text
bundle/server.cjs
```

`npm run web` 会启动该文件，并托管 `web/dist`。

## Web 页面

- 概览：账号、额度、任务和调度状态汇总
- 账号管理：导入 auth、同步平台凭据、检查额度、刷新凭据、重登授权、保存密码、导出 auth、绑定并推送 CPA/Sub2API
- 注册链路：从数据库邮箱池或自定义来源发起注册/授权任务
- 邮箱来源：管理购买批次和来源标注
- 邮箱管理：管理具体邮箱库存、导入、取件测试、使用状态
- 任务日志：查看任务历史、实时日志、等待输入
- 配置：维护代理、默认密码、HeroSMS、CPA、Sub2API、邮箱 provider 相关配置

## 账号和凭据

账号数据存储在 SQLite，主要能力包括：

- 递归导入 `auth/**/*.json`
- 跳过 `auth/401` 和 `auth/at`
- 识别 Codex auth 和 ChatGPT access token only
- 保存账号级加密密码
- 手动检查、刷新、重登授权
- 定时刷新凭据状态
- 展示当前凭据阶段
- 展示套餐和额度窗口
- 单个或批量导出 auth 文件
- 单个或批量推送到 CPA / Sub2API
- 定时从 CPA / Sub2API 拉取平台凭据
- 单个或批量绑定需要自动同步回推的平台服务

账号状态包括：

- 正常
- 额度已用尽
- 凭据过期
- 账号异常
- 未检查
- 只保存 accessToken

免费账号只展示 7 天窗口；Plus / Pro / Team 等会员账号展示 5 小时和 7 天窗口。

## 邮箱模型

Web 注册默认使用数据库邮箱池。

邮箱模型分三层：

1. 邮箱类型：决定平台、后缀和取码方式，例如 Hotmail、Gmail、GPTMail、2925、Cloudflare。
2. Hotmail 子类型：`graph` 或 `xiongmaodian`。
3. 邮箱来源：购买渠道或批次标注，用于追踪来源，不决定取码实现。

邮箱来源页面只管理来源名称、渠道、批次备注、启用状态，以及关联邮箱类型。

邮箱管理页面管理具体邮箱库存，支持批量导入、标记已使用/未使用、删除、取件测试。

### Hotmail / Outlook

支持两种子类型：

- `graph`：数据库邮箱记录需要保存 `邮箱----密码----client_id----refresh_token` 中的字段，使用 Microsoft Graph / Outlook REST 取件。
- `xiongmaodian`：通过熊猫点公开接口取件，只需要邮箱地址。

批量导入 `graph` 格式：

```text
邮箱----密码----client_id----refresh_token
```

批量导入 `xiongmaodian` 格式：

```text
邮箱
```

### Gmail

在配置页填写：

- `gmailAccessToken`
- `gmailEmailAddress`

注册页选择“自定义来源 / gmail”时使用该配置。

临时 token 获取方式见 [GMAIL_OAUTH_PLAYGROUND.md](./GMAIL_OAUTH_PLAYGROUND.md)。

### GPTMail

在配置页填写：

- `gptMailApiKey`
- `gptMailDomain`，可选

注册页选择“自定义来源 / gptmail”时使用该配置。

### 2925

在配置页填写：

- `2925EmailAddress`
- `2925Password`

邮箱库存导入格式为一行一个邮箱。

### Cloudflare Email Routing

在配置页填写：

- `cloudflareEmailDomain`
- `cloudflareApiBaseUrl`
- `cloudflareApiKey`

Worker 部署说明见 [MAIL_WORKER_DEPLOY.md](./MAIL_WORKER_DEPLOY.md)。

## HeroSMS

HeroSMS 用于 OpenAI 要求手机号验证时的接码。

在配置页填写：

- `heroSMSApiKey`
- `heroSMSCountry`
- `heroSMSMaxPrice`
- `heroSMSPollAttempts`
- `heroSMSPollIntervalMs`

配置页会显示：

- 当前 HeroSMS 余额
- 国家列表，优先显示中文名
- OpenAI / `dr` 服务价格和可用数量

HeroSMS 接入说明见 [ADD_PHONE_HERO_SMS.md](./ADD_PHONE_HERO_SMS.md)。

## CPA / Sub2API 推送

账号管理页支持单个或批量推送 auth 文件，也支持从平台同步远端凭据到本地统一管理。

手动推送时可以选择目标：

- CPA
- Sub2API
- CPA + Sub2API

如果未配置目标平台的 Base URL 或密钥，后端会拒绝推送并提示先到配置页填写。

### 平台凭据同步

账号管理页的“同步平台凭据”会从已启用或指定的 CPA / Sub2API 服务拉取凭据，保存到本地 `auth/platforms/<service-id>/`，再写入 SQLite 账号表统一展示。

同步规则：

- CPA 使用管理接口读取 auth 文件列表并下载 JSON。
- Sub2API 优先读取 `/api/v1/admin/accounts/data` 的 `sub2api-data` 结构。
- 同邮箱多平台冲突时，按推送服务页的优先级排序，优先级更小的服务作为本地 active auth。
- 账号页会展示凭据来源、最近同步时间和绑定平台。

### 绑定平台和自动回推

每个账号可以显式绑定一个或多个 CPA / Sub2API 服务，也支持批量绑定、追加或清空。

定时刷新流程会先同步平台凭据，再检查本地账号状态。账号凭据过期且开启自动重登时，系统会重新授权；重新授权成功后只自动推送到该账号绑定的平台。未绑定平台的账号不会自动回推，避免误推到不应该同步的服务。

CPA 需要：

- `cliproxyApiBaseUrl`
- `cliproxyApiManagementKey`

Sub2API 需要：

- `sub2apiBaseUrl`
- `sub2apiAdminApiKey`，请求时通过 `x-api-key: <your-admin-api-key>` 发送
- 可选：`sub2apiGroupIds`、`sub2apiProxyId`、`sub2apiConcurrency`、`sub2apiPriority`、`sub2apiRateMultiplier`、`sub2apiLoadFactor`

## 代理策略

`defaultProxyUrl` 只用于 OpenAI 相关请求，例如：

- `auth.openai.com`
- `chatgpt.com`
- OpenAI OAuth / token refresh
- OpenAI usage probe
- Sentinel 相关请求

非 OpenAI 请求默认不走该代理，例如：

- HeroSMS
- Gmail
- GPTMail
- Cloudflare Worker
- CPA
- Sub2API

## 开发约定

- TypeScript 使用 NodeNext，兄弟模块 import 保留 `.js` 扩展。
- 手工编辑保持 2 空格缩进。
- 前端使用 Vue 3 Composition API、Element Plus 和 TailwindCSS。
- 后端 API 路径保持兼容：`/api/config`、`/api/accounts`、`/api/jobs`、`/api/mail-*`、`/api/hero-sms/*`、`/api/scheduler`。
- 不提交 `data/`、`auth/`、`hotmail/`、`bundle/`、`web/dist/`。

## License

MIT License. See [LICENSE](./LICENSE).

## 验证

常用验证命令：

```bash
npx tsc --noEmit --pretty false
npm run build
```

构建后启动：

```bash
npm run web
```

然后访问：

```text
http://127.0.0.1:3789/
```
