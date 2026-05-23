import path from "node:path";
import {existsSync} from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import {getConfigForUi, updateConfigFromUi} from "./config-service.js";
import {
  checkAccount,
  dashboardStats,
  exportAccountsAuthZip,
  getAccount,
  importAuthFiles,
  listAccounts,
  mapWithConcurrency,
  pushAccount,
  readAccountAuthFile,
  resolveDefaultConcurrency,
  setAccountPassword,
  type PushTarget,
} from "./auth-service.js";
import {getSchedulerConfig, startScheduler, updateSchedulerConfig} from "./scheduler.js";
import {
  createJob,
  getJob,
  listJobEvents,
  listJobs,
  onJobEvent,
  runJob,
  submitJobInput,
} from "./job-service.js";
import {reauthorizeAccount, runRegistrationJob, type RegisterOptions} from "./registration-service.js";
import {
  createMailbox,
  createMailType,
  createMailSource,
  deleteMailbox,
  deleteMailType,
  deleteMailSource,
  fetchLatestMailboxEmail,
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

const HOST = "127.0.0.1";
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

app.get("/api/health", async () => ({ok: true}));

app.get("/api/config", async () => getConfigForUi());
app.put("/api/config", async (request) => {
  return updateConfigFromUi((request.body ?? {}) as Record<string, unknown>);
});

app.get("/api/dashboard", async () => ({
  stats: dashboardStats(),
  scheduler: getSchedulerConfig(),
  jobs: listJobs(8),
}));

app.get("/api/accounts", async (request) => {
  const query = (request.query as Record<string, string> | undefined) ?? {};
  return {accounts: listAccounts({
    q: query.q,
    status: query.status,
    credentialType: query.credentialType,
    provider: query.provider,
    plan: query.plan,
    autoReauth: query.autoReauth,
    page: Number(query.page ?? 1),
    pageSize: Number(query.pageSize ?? 200),
  })};
});

app.post("/api/accounts/import-auth", async () => importAuthFiles());

app.get("/api/accounts/:id/auth-file", async (request, reply) => {
  const id = Number((request.params as {id: string}).id);
  const auth = await readAccountAuthFile(id);
  return reply
    .type("application/json; charset=utf-8")
    .header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(auth.fileName)}`)
    .send(auth.content);
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

app.put("/api/accounts/:id/password", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {password?: string};
  await setAccountPassword(id, body.password ?? "");
  return {ok: true};
});

app.post("/api/accounts/:id/check", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {refresh?: boolean} | undefined;
  return checkAccount(id, Boolean(body?.refresh));
});

app.post("/api/accounts/:id/refresh", async (request) => {
  const id = Number((request.params as {id: string}).id);
  return checkAccount(id, true);
});

app.post("/api/accounts/:id/reauth", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const account = getAccount(id);
  const job = createJob("reauth", `重新授权 ${account.email}`, {id});
  void runJob(job.id, async () => reauthorizeAccount(id, job.id), {exclusiveRegister: true});
  return {job};
});

app.post("/api/accounts/:id/push", async (request) => {
  const id = Number((request.params as {id: string}).id);
  const body = request.body as {target?: PushTarget} | undefined;
  return pushAccount(id, body?.target ?? "both");
});

app.post("/api/accounts/bulk/:action", async (request) => {
  const action = (request.params as {action: string}).action;
  const body = request.body as {ids?: number[]; target?: PushTarget} | undefined;
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
        return {id, result: await reauthorizeAccount(id, job.id)};
      }
      if (action === "push") {
        return {id, result: await pushAccount(id, body?.target ?? "both")};
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
  void runJob(job.id, async () => ({...(await runRegistrationJob({...body, jobId: job.id}))}), {exclusiveRegister: true});
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

async function registerStatic(): Promise<void> {
  if (existsSync(path.join(WEB_DIST, "index.html"))) {
    await app.register(fastifyStatic, {
      root: WEB_DIST,
      prefix: "/",
      wildcard: false,
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
  await registerStatic();
  startScheduler();
  await app.listen({host: HOST, port: PORT});
  console.log(`codex-auth-manager web: http://${HOST}:${PORT}`);
}

startServer().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
