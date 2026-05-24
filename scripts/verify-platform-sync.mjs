import {createServer} from "node:http";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import path from "node:path";

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": typeof payload === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    ...headers,
  });
  res.end(body);
}

async function startMockPlatform() {
  const requests = [];
  const cpaFiles = new Map([
    ["same@example.com.json", {
      email: "same@example.com",
      access_token: "cpa-access",
      refresh_token: "cpa-refresh",
      account_id: "cpa-account",
      expired: "2099-01-01T00:00:00.000Z",
    }],
    ["bad.json", "{bad-json"],
  ]);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requests.push({method: req.method, pathname: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers});
    try {
      if (url.pathname === "/cpa/v0/management/auth-files" && req.method === "GET") {
        if (req.headers.authorization !== "Bearer cpa-secret") {
          send(res, 401, {error: "bad cpa token"});
          return;
        }
        send(res, 200, {files: [...cpaFiles.keys()].map((name) => ({name}))});
        return;
      }
      if (url.pathname === "/cpa/v0/management/auth-files/download" && req.method === "GET") {
        if (req.headers.authorization !== "Bearer cpa-secret") {
          send(res, 401, {error: "bad cpa token"});
          return;
        }
        const file = cpaFiles.get(url.searchParams.get("name") ?? "");
        if (!file) {
          send(res, 404, {error: "missing"});
          return;
        }
        send(res, 200, typeof file === "string" ? file : file);
        return;
      }
      if (url.pathname === "/cpa/v0/management/auth-files" && req.method === "POST") {
        if (req.headers.authorization !== "Bearer cpa-secret") {
          send(res, 401, {error: "bad cpa token"});
          return;
        }
        await readJson(req);
        send(res, 200, {ok: true});
        return;
      }
      if (url.pathname === "/sub2api/api/v1/admin/accounts/data" && req.method === "GET") {
        if (req.headers["x-api-key"] !== "sub-secret") {
          send(res, 403, {error: "bad sub2api token"});
          return;
        }
        send(res, 200, {
          data: {
            "sub2api-data": true,
            accounts: [{
              id: "sub-same",
              name: "wrong-name@example.com",
              credentials: {
                email: "same@example.com",
                access_token: "sub-access",
                refresh_token: "sub-refresh",
                account_id: "sub-account",
                expires_at: 4070908800,
              },
            }],
          },
        });
        return;
      }
      if (url.pathname === "/sub2api/api/v1/admin/accounts/import/codex-session" && req.method === "POST") {
        if (req.headers["x-api-key"] !== "sub-secret") {
          send(res, 403, {error: "bad sub2api token"});
          return;
        }
        await readJson(req);
        send(res, 200, {created: 0, updated: 1, skipped: 0, failed: 0});
        return;
      }
      send(res, 404, {error: "not found"});
    } catch (error) {
      send(res, 500, {error: error instanceof Error ? error.message : String(error)});
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock server failed to listen");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function removeWithRetry(target) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await rm(target, {recursive: true, force: true});
      return;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EBUSY") || attempt === 7) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function main() {
  const originalCwd = process.cwd();
  const workspace = await mkdtemp(path.join(tmpdir(), "codex-register-platform-sync-"));
  process.chdir(workspace);
  const mock = await startMockPlatform();
  let closeDatabase = () => {};
  try {
    const {getDb} = await import("../src/backend/db.ts");
    closeDatabase = () => {
      const database = getDb();
      database.pragma("wal_checkpoint(TRUNCATE)");
      database.close();
    };
    const {createIntegrationService} = await import("../src/backend/integration-service.ts");
    const {syncPlatformCredentials} = await import("../src/backend/credential-sync-service.ts");
    const {listAccountPlatformBindings} = await import("../src/backend/account-platform-binding-service.ts");
    const {getActiveAuthFile, loadAuthRecord, pushAccountToBoundPlatforms, setAccountPassword} = await import("../src/backend/auth-service.ts");

    const cpa = await createIntegrationService({
      kind: "cpa",
      name: "Mock CPA",
      baseUrl: `${mock.baseUrl}/cpa`,
      secret: "cpa-secret",
      priority: 10,
    });
    const sub2api = await createIntegrationService({
      kind: "sub2api",
      name: "Mock Sub2API",
      baseUrl: `${mock.baseUrl}/sub2api`,
      secret: "sub-secret",
      priority: 20,
    });
    await createIntegrationService({
      kind: "sub2api",
      name: "Bad Sub2API",
      baseUrl: `${mock.baseUrl}/sub2api`,
      secret: "bad-secret",
      priority: 30,
    });

    const syncResult = await syncPlatformCredentials({source: "all"});
    assert(syncResult.imported === 1, `expected 1 imported account, got ${JSON.stringify(syncResult)}`);
    assert(syncResult.updated === 1, `expected Sub2API to update existing account, got ${JSON.stringify(syncResult)}`);
    assert(syncResult.failed === 2, `expected bad JSON and bad auth failures, got ${JSON.stringify(syncResult)}`);

    const account = getDb().prepare("SELECT * FROM accounts WHERE email = ?").get("same@example.com");
    assert(account, "same@example.com should be imported");
    assert(!account.password_encrypted, "platform-synced account should not inherit a default password");
    assert(!getDb().prepare("SELECT id FROM accounts WHERE email = ?").get("wrong-name@example.com"), "Sub2API name should not override credential email");
    assert(account.credential_source_service_id === cpa.id, "CPA with higher priority should win active source");
    const bindings = listAccountPlatformBindings(account.id);
    assert(bindings.length === 2, `same account should be bound to both synced platforms, got ${JSON.stringify(bindings)}`);
    assert(bindings.some((binding) => binding.id === cpa.id), "CPA source should be auto-bound");
    assert(bindings.some((binding) => binding.id === sub2api.id), "Sub2API source should be auto-bound");
    const authFile = getActiveAuthFile(account.id);
    const activeRecord = await loadAuthRecord(authFile.file_path);
    assert(activeRecord.access_token === "cpa-access", "active auth file should be CPA credential");

    await setAccountPassword(account.id, "registered-pass-123");
    const accountWithPassword = getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(account.id);
    assert(Boolean(accountWithPassword.password_encrypted), "locally registered accounts should persist the registration password");

    const pushResult = await pushAccountToBoundPlatforms(account.id);
    assert(pushResult.cpa && pushResult.sub2api, "bound platform push should include CPA and Sub2API");
    assert(mock.requests.some((request) => request.method === "POST" && request.pathname === "/cpa/v0/management/auth-files"), "CPA push was not called");
    assert(mock.requests.some((request) => request.method === "POST" && request.pathname === "/sub2api/api/v1/admin/accounts/import/codex-session"), "Sub2API push was not called");

    let mismatchError = "";
    try {
      await syncPlatformCredentials({source: "cpa", serviceIds: [sub2api.id]});
    } catch (error) {
      mismatchError = error instanceof Error ? error.message : String(error);
    }
    assert(mismatchError.includes("不存在或与同步来源不匹配"), "mismatched service selection should fail clearly");

    console.log(JSON.stringify({
      ok: true,
      imported: syncResult.imported,
      updated: syncResult.updated,
      failed: syncResult.failed,
      activeSourceServiceId: account.credential_source_service_id,
      requests: mock.requests.length,
    }));
  } finally {
    try {
      closeDatabase();
    } catch {
      // Best-effort cleanup for the temporary verification database.
    }
    process.chdir(originalCwd);
    await mock.close();
    await removeWithRetry(workspace);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
