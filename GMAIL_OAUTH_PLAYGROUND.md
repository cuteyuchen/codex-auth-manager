# Gmail OAuth 2.0 Playground 临时 Token 教程

这份文档用于给项目的 Gmail 邮箱取件能力获取临时 Gmail API `access token`。

当前项目所有配置都在 Web 管理台里维护，不再使用 `config.json`。

## 适用场景

- 你想让注册任务自动从 Gmail 读取 OpenAI 验证码
- 你只需要临时测试 Gmail provider
- 你不想搭建完整 OAuth 回调服务

## 项目需要的字段

在 Web 管理台“配置”页填写：

- `gmailAccessToken`：Gmail API access token
- `gmailEmailAddress`：Gmail 主邮箱地址

注册页使用“自定义来源 / gmail”时会读取这些字段。

Gmail 请求默认走本地网络，不使用 OpenAI 代理。

## 获取临时 Token

打开 OAuth Playground：

[https://developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)

在 Step 1 选择 Gmail API scope：

```text
Gmail API v1 > https://mail.google.com/
```

点击：

```text
Authorize APIs
```

选择 Google 账号并授权。

授权完成后，在 Step 2 点击：

```text
Exchange authorization code for tokens
```

页面会显示：

- Access token
- Refresh token

当前项目 Gmail provider 使用的是 `Access token`。

## 填入项目

启动 Web 管理台：

```bash
npm run build
npm run web
```

打开：

```text
http://127.0.0.1:3789/settings
```

填写：

- `gmailAccessToken`：OAuth Playground 里的 Access token
- `gmailEmailAddress`：你的 Gmail 主邮箱

保存后，新任务会立即读取最新配置。

## 使用方式

在注册页选择“自定义来源”，provider 选择：

```text
gmail
```

程序会基于 `gmailEmailAddress` 生成 Gmail alias，例如：

```text
yourname+random@gmail.com
```

然后通过 Gmail API 查收该 alias 收到的验证码邮件。

## Token 有效期说明

OAuth Playground 默认适合临时测试：

- Access token 是短期 token。
- 如果不使用自己的 OAuth 客户端，Playground 生成的 refresh token 通常也不适合长期使用。

因此该方式适合：

- 临时测试
- 快速调试
- 跑通 Gmail provider

不适合：

- 长期挂机
- 大批量稳定运行

## 参考

- OAuth Playground: [https://developers.google.com/oauthplayground](https://developers.google.com/oauthplayground)
- Gmail API scopes: [https://developers.google.com/workspace/gmail/api/auth/scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
