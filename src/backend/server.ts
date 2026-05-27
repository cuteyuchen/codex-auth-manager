import path from "node:path";
import {createReadStream, existsSync} from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import {getConfigForUi, updateConfigFromUi} from "./config-service.js";
import {
  checkAccount,
  dashboardStats,
  deleteAccount,
  bulkDeleteAccounts,
  exportAccountsAuthZip,
  getAccount,
  getAccountPassword,
  importAuthFiles,
  listAccounts,
  mapWithConcurrency,
  pushAccount,
  pushAccountToBoundPlatforms,
  readAccountAuthFile,
  resolveDefaultConcurrency,
  updateAccountProfile,
  type PushTarget,
} from "./auth-service.js";
import {getSchedulerConfig, startScheduler, updateSchedulerConfig} from "./scheduler.js";
import {
  createJob,
  cancelJob,
  getJob,
  listJobEvents,
  listJobs,
  onJobEvent,
  runJob,
  submitJobInput,
} from "./job-service.js";
import {
  assertRegistrationSucceeded,
  manualReauthAccount,
  reauthorizeAccount,
  runRegistrationJob,
  type RegisterOptions,
} from "./registration-service.js";
import {
  createMailbox,
  createMailType,
  createMailSource,
  deleteMailbox,
  deleteMailType,
  deleteMailSource,
  fetchLatestMailboxEmail,
  getMailboxSecrets,
  importMailboxes,
  listMailboxes,
  listMailTypes,
  listMailSources,
  markMailboxUsed,
  testMailboxCode,
  updateMailbox,
  updateMailType,
  updateMailSource,
} from "./mailbox-service.js";
import {getHeroSmsBalance, getHeroSmsCountries, getHeroSmsPrices} from "./hero-sms-service.js";
import {testProxyConnection} from "./proxy-test-service.js";
import {
  createIntegrationService,
  deleteIntegrationService,
  listIntegrationServices,
  testIntegrationService,
  updateIntegrationService,
} from "./integration-service.js";
import {
  bulkSetAccountPlatformBindings,
  listAccountPlatformBindings,
  setAccountPlatformBindings,
  type BindingMode,
} from "./account-platform-binding-service.js";
import {syncPlatformCredentials, type CredentialSyncSource} from "./credential-sync-service.js";
import {backupDatabase, cleanupJobs, getSystemDatabaseInfo} from "./system-service.js";
import {
  assertHostAccessAllowed,
  getSessionState,
  isAuthenticated,
  login,
  logout,
} from "./session-service.js";
import {appConfig} from "../core/config.js";
import {getDb} from "./db.js";

const HOST = process.env.CODEX_REGISTER_WEB_HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.CODEX_REGISTER_WEB_PORT ?? "3789", 10) || 3789;
const WEB_DIST = path.resolve(process.cwd(), "web", "dist");

const app = Fastify({
  logger: false,
});

app.addContentTypeParser("*", {parseAs: "string"}, (_request, body, done) => {
  if (!body) {
    done(null, {});
    return;
  }
  try {
    done(null, JSON.parse(body as string));
  } catch {
    done(null, body);
  }
});

app.setErrorHandler((error, _request, reply) => {
  const message = error instanceof Error ? error.message : String(error);
  reply.code(500).send({error: message});
});

app.addHook("preHandler", async (request, reply) => {
  const url = request.raw.url ?? "";
  const publicApi =
    url.startsWith("/api/health") ||
    url.startsWith("/api/session");
  if (url.startsWith("/api/") && !publicApi && !isAuthenticated(request)) {
    reply.code(401);
    return {error: "请先登录"};
  }
  return undefined;
});

app.get("/api/health", async () => ({ok: true}));
app.get("/api/session", async (request) => getSessionState(request));
app.post("/api/session/login", async (request, reply) => {
  const body = request.body as {password?: string} | undefined;
  return login(String(body?.password ?? ""), reply);
});
app.post("/api/session/logout", async (_request, reply) => logout(reply));

app.get("/api/config", async () => getConfigForUi());
app.put("/api/config", async (request) => {
  return updateConfigFromUi((request.body ?? {}) as Record<string, unknown>);
});
app.post("/api/config/proxy-test", async (request) => {
  return testProxyConnection((request.body ?? {}) as {proxyUrl?: unknown; targetUrl?: unknown});
});

app.get("/api/dashboard", async () => {
  const mailboxes = getDb().prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN used = 0 AND status = 'unused' THEN 1 ELSE 0 END) AS unused,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM mailboxes
  `).get() as {total: number; unused: number | null; failed: number | null};
  const sources = getDb().prepare("SELECT COUNT(*) AS count FROM mail_sources WHERE enabled = 1").get() as {count: number};
  const services = getDb().prepare(`
    SELECT kind, COUNT(*) AS count
    FROM integration_services
    WHERE enabled = 1
    GROUP BY kind
  `).all() as Array<{kind: string; count: number}>;
  return {
    stats: dashboardStats(),
    scheduler: getSchedulerConfig(),
    jobs: listJobs(8),
    mailboxes: {
      total: mailboxes.total,
      unused: mailboxes.unused ?? 0,
      failed: mailboxes.failed ?? 0,
      sources: sources.count,
    },
    services: {
      cpa: services.find((item) => item.kind === "cpa")?.count ?? 0,
      sub2api: services.find((item) => item.kind === "sub2api")?.count ?? 0,
    },
    heroSms: {
      configured: Boolean(appConfig.heroSMSApiKey),
      country: appConfig.heroSMSCountry,
    },
  };
});

app.get("/api/accounts", async (request) => {
  const query = (request.query as Record<string, string> | undefined) ?? {};
  const bindingServiceIds = String(query.bindingServiceIds ?? "")
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
  return {accounts: listAccounts({
    q: query.q,
    status: query.status,
    credentialType: query.credentialType,
    provider: query.provider,
    plan: query.plan,
    autoReauth: query.autoReauth,
    pushStatus: query.pushStatus,
    bindingServiceIds,
    page: Number(query.page ?? 1),
    pageSize: Number(query.pageSize ?? 200),
  })};
});

app.post("/api/accounts/import-auth", async () => importAuthFiles());

app.post("/api/accounts/sync-platforms", async (request) => {
  const body = request.body as {source?: CredentialSyncSource; serviceIds?: number[]; checkAfterSync?: boolean} | undefined;
  const source = body?.source === "cpa" || body?.source === "sub2api" || body?.source === "all" ? body.source : "all";
  const job = createJob("sync_platform_credentials", "同步平台凭据", {
    source,
    serviceIds: body?.serviceIds,
    checkAfterSync: Boolean(body?.checkAfterSync),
  });
  void runJob(job.id, async () => ({
    result: await syncPlatformCredentials({
      source,
      serviceIds: body?.serviceIds,
      checkAfterSync: Boolean(body?.checkAfterSync),
      jobId: job.id,
    }),
  }));
  return {job};
});

app.get("/api/accounts/:id/auth-file", async (request, reply) => {
  const id = Number((request.params as {id: string}).id);
  const auth = readAccountAuthFile(id);
  return reply
    .type("application/json; charset=utf-8")
    .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(auth.fileName)}`)
    .send(auth.content);
});

app.delete("/api/accounts/:id", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {deleteFromServiceIds?: number[]} | undefined;
  return deleteAccount(id, {deleteFromServiceIds: body?.deleteFromServiceIds});
});

app.post("/api/accounts/bulk-delete", async (request) => {
  const body = request.body as {ids?: number[]; deleteFromServiceIds?: number[]} | undefined;
  return bulkDeleteAccounts(body?.ids ?? [], {deleteFromServiceIds: body?.deleteFromServiceIds});
});

app.post("/api/accounts/export-auth", async (request, reply) => {
  const body = request.body as {ids?: number[]} | undefined;
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  const archive = await exportAccountsAuthZip(ids);
  return reply
    .type("application/zip")
    .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(archive.fileName)}`)
    .send(archive.content);
});

app.put("/api/accounts/:id/profile", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {password?: unknown; sourceId?: unknown} | undefined;
  return {
    account: await updateAccountProfile(id, {
      password: typeof body?.password === "string" ? body.password : undefined,
      sourceId: body && Object.hasOwn(body, "sourceId") ? (body.sourceId ? Number(body.sourceId) : null) : undefined,
    }),
  };
});

app.post("/api/accounts/:id/check", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {refresh?: boolean} | undefined;
  return checkAccount(id, Boolean(body?.refresh));
});

app.get("/api/accounts/:id/password", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const account = getAccount(id);
  if (!account.password_encrypted) {
    return {hasPassword: false, password: ""};
  }
  try {
    const password = await getAccountPassword(account);
    return {hasPassword: true, password};
  } catch (error) {
    return {hasPassword: false, password: "", error: error instanceof Error ? error.message : String(error)};
  }
});

app.post("/api/accounts/:id/refresh", async (request) => {
  const id = Number((request.params as {id: string}).id);
  return checkAccount(id, true);
});

app.post("/api/accounts/:id/reauth", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {mode?: "auto" | "manual"} | undefined;
  const mode: "auto" | "manual" = body?.mode === "manual" ? "manual" : "auto";
  const account = getAccount(id);
  const job = createJob(`reauth_${mode}`, `${mode === "manual" ? "人工" : "自动"}重登 ${account.email}`, {id, mode});
  void runJob(job.id, async () => {
    if (mode === "manual") {
      const result = await manualReauthAccount(id, job.id);
      try {
        await pushAccountToBoundPlatforms(id);
        return {...result, mode, boundPlatformPush: "success"};
      } catch (error) {
        return {...result, mode, boundPlatformPush: "failed", pushError: error instanceof Error ? error.message : String(error)};
      }
    }
    const result = await reauthorizeAccount(id, job.id, {mode: "auto"});
    try {
      await pushAccountToBoundPlatforms(id);
      return {...result, mode, boundPlatformPush: "success"};
    } catch (error) {
      return {...result, mode, boundPlatformPush: "failed", pushError: error instanceof Error ? error.message : String(error)};
    }
  }, {exclusiveRegister: true});
  return {job};
});

app.post("/api/accounts/:id/push", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {target?: PushTarget; serviceIds?: number[]} | undefined;
  return pushAccount(id, body?.target ?? "both", body?.serviceIds);
});

app.get("/api/accounts/:id/platform-bindings", async (request) => {
  const id = Number((request.params as {id: string}).id);
  return {bindings: listAccountPlatformBindings(id)};
});

app.put("/api/accounts/:id/platform-bindings", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {serviceIds?: number[]; mode?: BindingMode} | undefined;
  return {bindings: setAccountPlatformBindings(id, body?.serviceIds ?? [], body?.mode ?? "replace")};
});

app.post("/api/accounts/bulk/platform-bindings", async (request) => {
  const body = request.body as {ids?: number[]; serviceIds?: number[]; mode?: BindingMode} | undefined;
  return bulkSetAccountPlatformBindings(body?.ids ?? [], body?.serviceIds ?? [], body?.mode ?? "replace");
});

app.post("/api/accounts/bulk/:action", async (request) => {
  const action = (request.params as {action: string}).action;
  const body = request.body as {ids?: number[]; target?: PushTarget; serviceIds?: number[]} | undefined;
  const ids = Array.isArray(body?.ids) ? body.ids.map(Number).filter(Number.isFinite) : [];
  const job = createJob(`bulk_${action}`, `批量${action}`, {ids, target: body?.target});
  void runJob(job.id, async () => {
    const concurrency = resolveDefaultConcurrency(ids.length);
    const results = await mapWithConcurrency(ids, concurrency, async (id) => {
      if (action === "check") {
        return {id, result: await checkAccount(id, false)};
      }
      if (action === "refresh") {
        return {id, result: await checkAccount(id, true)};
      }
      if (action === "reauth") {
        const result = await reauthorizeAccount(id, job.id);
        try {
          await pushAccountToBoundPlatforms(id);
          return {id, result: {...result, boundPlatformPush: "success"}};
        } catch (error) {
          return {id, result: {...result, boundPlatformPush: "failed", pushError: error instanceof Error ? error.message : String(error)}};
        }
      }
      if (action === "push") {
        return {id, result: await pushAccount(id, body?.target ?? "both", body?.serviceIds)};
      }
      throw new Error(`不支持的批量操作: ${action}`);
    });
    return {results};
  }, {exclusiveRegister: action === "reauth"});
  return {job};
});

app.post("/api/jobs/register", async (request) => {
  const body = (request.body ?? {}) as RegisterOptions & {title?: string};
  const job = createJob("register", body.title || "注册/授权任务", body as Record<string, unknown>);
  void runJob(job.id, async () => {
    const result = await runRegistrationJob({...body, jobId: job.id});
    return {...assertRegistrationSucceeded(result)};
  }, {exclusiveRegister: true});
  return {job};
});

app.get("/api/mail-types", async () => ({types: listMailTypes()}));
app.post("/api/mail-types", async (request) => ({type: await createMailType((request.body ?? {}) as Record<string, unknown>)}));
app.put("/api/mail-types/:id", async (request) => ({
  type: await updateMailType(Number((request.params as {id: string}).id), (request.body ?? {}) as Record<string, unknown>),
}));
app.delete("/api/mail-types/:id", async (request) => deleteMailType(Number((request.params as {id: string}).id)));

app.get("/api/mail-sources", async (request) => {
  const query = (request.query as Record<string, string> | undefined) ?? {};
  return {sources: listMailSources({
    q: query.q,
    typeId: query.typeId ? Number(query.typeId) : undefined,
    provider: query.provider,
    subtype: query.subtype,
    enabled: query.enabled,
  })};
});
app.post("/api/mail-sources", async (request) => ({source: await createMailSource((request.body ?? {}) as Record<string, unknown>)}));
app.put("/api/mail-sources/:id", async (request) => ({
  source: await updateMailSource(Number((request.params as {id: string}).id), (request.body ?? {}) as Record<string, unknown>),
}));
app.delete("/api/mail-sources/:id", async (request) => deleteMailSource(Number((request.params as {id: string}).id)));

app.get("/api/mailboxes", async (request) => {
  const query = (request.query as Record<string, string> | undefined) ?? {};
  return {mailboxes: listMailboxes({
    q: query.q,
    sourceId: query.sourceId ? Number(query.sourceId) : undefined,
    typeId: query.typeId ? Number(query.typeId) : undefined,
    provider: query.provider,
    subtype: query.subtype,
    status: query.status,
    used: query.used,
    autoCode: query.autoCode,
  })};
});
app.post("/api/mailboxes", async (request) => ({mailbox: await createMailbox((request.body ?? {}) as Record<string, unknown>)}));
app.put("/api/mailboxes/:id", async (request) => ({
  mailbox: await updateMailbox(Number((request.params as {id: string}).id), (request.body ?? {}) as Record<string, unknown>),
}));
app.delete("/api/mailboxes/:id", async (request) => deleteMailbox(Number((request.params as {id: string}).id)));
app.get("/api/mailboxes/:id/secrets", async (request) => ({
  secrets: await getMailboxSecrets(Number((request.params as {id: string}).id)),
}));
app.post("/api/mailboxes/import", async (request) => importMailboxes((request.body ?? {}) as Record<string, unknown>));
app.post("/api/mailboxes/:id/test-code", async (request) => testMailboxCode(Number((request.params as {id: string}).id)));
app.post("/api/mailboxes/:id/fetch-latest", async (request) => fetchLatestMailboxEmail(Number((request.params as {id: string}).id)));
app.post("/api/mailboxes/:id/mark-used", async (request) => {
  markMailboxUsed(Number((request.params as {id: string}).id), true, "used");
  return {ok: true};
});
app.post("/api/mailboxes/:id/mark-unused", async (request) => {
  markMailboxUsed(Number((request.params as {id: string}).id), false, "unused");
  return {ok: true};
});

app.get("/api/hero-sms/countries", async () => getHeroSmsCountries());
app.get("/api/hero-sms/balance", async () => getHeroSmsBalance());
app.get("/api/hero-sms/prices", async (request) => {
  const query = (request.query as {country?: string; service?: string} | undefined) ?? {};
  return getHeroSmsPrices(Number(query.country ?? 0), query.service ?? "dr");
});

app.get("/api/jobs", async () => ({jobs: listJobs()}));
app.get("/api/jobs/:id", async (request) => ({job: getJob(Number((request.params as {id: string}).id))}));
app.get("/api/jobs/:id/events", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const after = Number((request.query as {after?: string} | undefined)?.after ?? "0") || 0;
  return {events: listJobEvents(id, after)};
});

app.post("/api/jobs/:id/input", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {value?: string};
  submitJobInput(id, body.value ?? "");
  return {ok: true};
});

app.post("/api/jobs/:id/cancel", async (request) => {
  const id = Number((request.params as {id: string}).id);
  return {job: cancelJob(id)};
});

app.get("/api/jobs/:id/stream", async (request, reply) => {
  const id = Number((request.params as {id: string}).id);
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  for (const event of listJobEvents(id, 0)) {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  const off = onJobEvent(id, (event) => {
    reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
  });
  request.raw.on("close", off);
});

app.get("/api/scheduler", async () => getSchedulerConfig());
app.put("/api/scheduler", async (request) => updateSchedulerConfig((request.body ?? {}) as {enabled?: boolean; dailyTime?: string}));

app.get("/api/integration-services", async (request) => {
  const query = (request.query as {kind?: string} | undefined) ?? {};
  return {services: await listIntegrationServices(query.kind)};
});
app.post("/api/integration-services", async (request) => ({
  service: await createIntegrationService((request.body ?? {}) as Record<string, unknown>),
}));
app.put("/api/integration-services/:id", async (request) => ({
  service: await updateIntegrationService(Number((request.params as {id: string}).id), (request.body ?? {}) as Record<string, unknown>),
}));
app.delete("/api/integration-services/:id", async (request) => deleteIntegrationService(Number((request.params as {id: string}).id)));
app.post("/api/integration-services/:id/test", async (request) => testIntegrationService(Number((request.params as {id: string}).id)));

app.get("/api/system/database", async () => getSystemDatabaseInfo());
app.post("/api/system/database/backup", async (_request, reply) => {
  const backup = await backupDatabase();
  return reply
    .type("application/octet-stream")
    .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(backup.fileName)}`)
    .send(createReadStream(backup.filePath));
});
app.post("/api/system/jobs/cleanup", async (request) => cleanupJobs((request.body ?? {}) as {before?: string; keepLatest?: number}));

async function registerStatic(): Promise<void> {
  if (existsSync(path.join(WEB_DIST, "index.html"))) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: "/",
    });
  }
  app.setNotFoundHandler(async (request, reply) => {
    if (request.raw.url?.startsWith("/api/")) {
      reply.code(404);
      return {error: "API 不存在"};
    }
    if (!existsSync(path.join(WEB_DIST, "index.html"))) {
      reply.code(404);
      return "web/dist 不存在，请先运行 npm run build，或使用 npm run web:dev 访问 Vite 端口";
    }
    return reply.sendFile("index.html");
  });
}

export async function startServer(): Promise<void> {
  assertHostAccessAllowed(HOST);
  await registerStatic();
  startScheduler();
  await app.listen({host: HOST, port: PORT});
  console.log(`codex-auth-manager web: http://${HOST}:${PORT}`);
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
