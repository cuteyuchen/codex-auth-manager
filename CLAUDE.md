# CLAUDE.md

始终使用中文回答。

## 项目定位

`codex-auth-manager` 当前是本地 Web 管理台，用于管理 ChatGPT / Codex 注册授权链路、邮箱池、账号凭据、额度检查、任务日志、HeroSMS 接码，以及 CPA / Sub2API 推送。

配置唯一真源是 SQLite `app_settings`，通过 Web 配置页维护。

## 常用命令

- `npm install`：安装依赖。
- `npm run web:dev`：开发模式，同时启动后端 watch 和 Vite HMR。
- `npm run build`：构建 `web/dist` 和 `bundle/server.cjs`。
- `npm run web`：运行构建后的本地管理台。
- `npx tsc --noEmit --pretty false`：类型检查。

## 目录结构

- `web/`：Vue 3 + Vite + Element Plus + TailwindCSS 前端。
- `src/backend/`：Fastify API、SQLite、配置、账号、任务、邮箱、调度、HeroSMS 服务。
- `src/core/`：OpenAI 注册授权核心、邮箱 provider、SMS provider、CPA/Sub2API 客户端、sentinel、设备指纹。
- `bundle/`：后端构建产物，当前只应生成 `server.cjs`。
- `web/dist/`：前端构建产物。
- `data/`：SQLite 和本地密钥，gitignored。
- `auth/`：本地 Codex auth 文件，gitignored。
- `hotmail/`：本地 Hotmail 辅助文件，gitignored。

## 构建与入口

`tsup.config.ts` 只打包一个后端入口：

```text
src/backend/server.ts -> bundle/server.cjs
```

生产运行：

```bash
npm run build
npm run web
```

默认监听：

```text
http://127.0.0.1:3789/
```

可通过 `CODEX_REGISTER_WEB_PORT` 改端口。

## 配置系统

配置存储在 SQLite 表 `app_settings`，敏感字段由 `data/local.key` 加密。`src/core/config.ts` 保留 `appConfig` 导出和 `reloadAppConfig()`，用于兼容核心注册逻辑。

注意：

- UI 保存配置后应调用配置服务刷新内存快照，让新任务立即使用最新配置。
- API 返回敏感字段时只能返回 `hasValue`、`tail` 等掩码信息。

## 网络策略

只有 OpenAI 注册、登录、授权、token refresh、usage probe、sentinel 等 OpenAI 相关请求使用 `appConfig.defaultProxyUrl`。

以下请求默认走本地网络，不应复用 OpenAI 代理：

- HeroSMS 国家、价格、余额、接码请求
- Gmail / GPTMail / Cloudflare / 2925 / Hotmail 取件请求
- CPA / Sub2API 推送请求

## Web API

保持现有 API 路径兼容：

- `/api/health`
- `/api/config`
- `/api/dashboard`
- `/api/accounts`
- `/api/accounts/import-auth`
- `/api/accounts/:id/check`
- `/api/accounts/:id/refresh`
- `/api/accounts/:id/reauth`
- `/api/accounts/:id/push`
- `/api/accounts/:id/auth-file`
- `/api/accounts/export-auth`
- `/api/accounts/bulk/:action`
- `/api/jobs`
- `/api/jobs/:id/events`
- `/api/jobs/:id/stream`
- `/api/jobs/:id/input`
- `/api/mail-types`
- `/api/mail-sources`
- `/api/mailboxes`
- `/api/hero-sms/countries`
- `/api/hero-sms/prices`
- `/api/hero-sms/balance`
- `/api/scheduler`

## 账号和凭据

账号页支持：

- 导入递归扫描到的 auth 文件。
- 检查额度和凭据状态。
- refresh token 刷新。
- 重新登录授权。
- 保存账号级加密密码。
- 单个或批量导出 auth 文件。
- 单个或批量选择 CPA / Sub2API 推送目标。

推送前必须校验目标平台配置；未配置时返回明确错误，不要静默失败。

## 邮箱模型

Web 注册优先使用数据库邮箱池。

邮箱模型是三层：

1. 邮箱类型：Hotmail、Gmail、GPTMail、2925、Cloudflare 等。
2. Hotmail 子类型：`graph` 或 `xiongmaodian`。
3. 邮箱来源：购买渠道或批次标注，只用于追踪来源。

不要把“来源”重新设计成 provider。来源不是取码实现。

## HeroSMS

HeroSMS 配置页应展示：

- 当前余额，接口 `getBalance`，返回可能是 `ACCESS_BALANCE:0.7628`。
- 国家列表，接口 `getCountries`，返回可能是 `{ "52": { id, rus, eng, chn, visible, retry, rent, multiService } }`。
- OpenAI / `dr` 价格，接口 `getPrices`，返回可能是 `{ "52": { "dr": { cost, count, physicalCount } } }`。

解析器必须宽松处理返回结构，拿不到价格时降级显示，不阻塞配置保存。

## 代码约定

- TypeScript sibling import 使用 `.js` 扩展。
- 手工编辑使用 2 空格缩进。
- 前端优先使用 Element Plus 组件和 TailwindCSS 工具类。
- 所有异步操作需要成功/失败提示。
- 表格页需要分页。
- 筛选表单 label 和输入框保持一行。
- 操作区尽量一行展示，按钮可用 link 类型。

## 验证要求

改动后优先运行：

```bash
npx tsc --noEmit --pretty false
npm run build
```

涉及前端交互时，启动 `npm run web` 或 `npm run web:dev` 后，用浏览器检查页面无空白、控制台无 error。
