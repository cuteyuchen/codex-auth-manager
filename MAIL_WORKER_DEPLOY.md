# Cloudflare 邮件 Worker 部署说明

这份文档说明如何部署一个 Cloudflare Worker + D1 邮件接收接口，供 `codex-auth-manager` 的 Cloudflare 邮箱类型自动取件。

当前项目配置都在 Web 管理台维护，不再使用 `config.json`。

## 前置条件

需要准备：

- Cloudflare 账号
- 已接入 Cloudflare 的域名
- 一个 D1 数据库
- 已启用 Email Routing

## 创建 D1 数据库

进入 Cloudflare 控制台：

1. 打开 `Storage & Databases`
2. 进入 `D1`
3. 新建数据库

建议名称：

```text
mail-db
```

## 初始化表结构

在 D1 查询页面执行：

```sql
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mailbox TEXT NOT NULL,
  from_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  message_id TEXT NOT NULL DEFAULT '',
  raw_text TEXT NOT NULL DEFAULT '',
  received_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_emails_mailbox_received_at
ON emails (mailbox, received_at DESC, id DESC);
```

## 创建 Worker

进入 Cloudflare 控制台：

1. 打开 `Workers & Pages`
2. 创建 Worker
3. 可以从 Hello World 模板开始
4. Worker 名称可用：

```text
mail-d1-api
```

## 粘贴代码

打开 Worker 代码编辑器，删除默认代码，把项目里的单文件脚本粘进去：

```text
MAIL_WORKER_UPLOAD.js
```

该脚本是纯 JavaScript，不需要构建。

## 绑定 D1

在 Worker 设置中添加 D1 binding：

- Variable name: `DB`
- Database: 选择刚创建的 D1 数据库

变量名必须是 `DB`。

## 配置 API Key

在 Worker 设置中添加 Secret：

- Name: `API_KEY`
- Value: 自定义一串密钥

项目请求 Worker 时会通过 `x-api-key` 传入该密钥。

## 绑定 Email Routing

在 Cloudflare Email Routing 中把域名邮件转发到这个 Worker。

建议启用 catch-all，这样项目生成任意随机前缀邮箱都可以收信：

```text
*@your-domain.com
```

## 测试接口

假设：

- Worker 地址：`https://mail-d1-api.xxx.workers.dev`
- API key：`your_api_key`
- 测试邮箱：`admin@example.com`

查询最新邮件：

```bash
curl -H "x-api-key: your_api_key" "https://mail-d1-api.xxx.workers.dev/latest?to=admin@example.com"
```

查询邮件列表：

```bash
curl -H "x-api-key: your_api_key" "https://mail-d1-api.xxx.workers.dev/emails?to=admin@example.com"
```

查询单封邮件：

```bash
curl -H "x-api-key: your_api_key" "https://mail-d1-api.xxx.workers.dev/emails/1"
```

删除单封邮件：

```bash
curl -X DELETE -H "x-api-key: your_api_key" "https://mail-d1-api.xxx.workers.dev/emails/1"
```

## 返回格式

`GET /latest?to=xxx@example.com`：

```json
{
  "id": 1,
  "mailbox": "xxx@example.com",
  "from_email": "noreply@example.com",
  "subject": "Your verification code",
  "message_id": "<abc@example.com>",
  "raw_text": "Your verification code is 123456",
  "received_at": 1770000000000
}
```

`GET /emails?to=xxx@example.com`：

```json
{
  "mailbox": "xxx@example.com",
  "emails": [
    {
      "id": 1,
      "mailbox": "xxx@example.com",
      "from_email": "noreply@example.com",
      "subject": "Your verification code",
      "message_id": "<abc@example.com>",
      "raw_text": "Your verification code is 123456",
      "received_at": 1770000000000
    }
  ],
  "limit": 20,
  "offset": 0
}
```

## 接入项目

启动 Web 管理台：

```bash
npm run build
npm run web
```

打开：

```text
http://127.0.0.1:3789/settings
```

在配置页填写：

- `cloudflareEmailDomain`：你的域名，例如 `your-domain.com`
- `cloudflareApiBaseUrl`：Worker 地址，例如 `https://mail-d1-api.xxx.workers.dev`
- `cloudflareApiKey`：Worker 的 `API_KEY`

注册页使用“自定义来源 / cloudflare”时会读取这些字段。

也可以在“邮箱来源 / 邮箱管理”中为 Cloudflare 类型维护库存邮箱和来源批次。

Cloudflare Worker 请求默认走本地网络，不使用 OpenAI 代理。

## 常见问题

### 是否必须 catch-all

不强制，但强烈建议。注册流程会生成随机前缀邮箱，catch-all 可以避免逐个创建邮箱地址。

### 邮件正文为空怎么办

Worker 会尽量解析 `text/plain` 或 `text/html`。如果解析失败，会退回保存原始 MIME 文本，验证码解析会在项目侧再尝试多种规则。

### 邮件数据会保存多久

当前 Worker 示例不会自动清理 D1。可以后续在 Cloudflare 里加定时任务清理旧邮件。
