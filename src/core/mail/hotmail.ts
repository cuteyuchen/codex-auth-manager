// @ts-nocheck
import {readFile, writeFile} from "node:fs/promises";
import path from "node:path";
import {Agent, fetch as undiciFetch} from "undici";
import {appConfig} from "../config.js";
import {appendErrorEmail} from "../email-error-recorder.js";
import {nextHotmailEmailEntry} from "./hotmail-email-queue.js";
import {createHotmailXiongmaodianProvider} from "./hotmail-xiongmaodian.js";
import {findLatestVerificationMail} from "./verification-matcher.js";
import type {HotmailMode} from "../config.js";

const HOTMAIL_TOKEN_DIR = path.resolve(process.cwd(), "hotmail");
const HOTMAIL_TOKENS_FILE = path.join(HOTMAIL_TOKEN_DIR, "tokens.txt");
const HOTMAIL_REST_BASE_URL = "https://outlook.office.com/api/v2.0";
const HOTMAIL_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const HOTMAIL_OAUTH_TOKEN_URL = "https://login.microsoftonline.com/consumers/oauth2/v2.0/token";
const HOTMAIL_DEFAULT_REDIRECT_URI = "http://localhost:8787/callback";
const HOTMAIL_REST_READ_SCOPE = "https://outlook.office.com/Mail.Read offline_access";
const HOTMAIL_GRAPH_READ_SCOPE = "openid profile offline_access User.Read Mail.Read";
const HOTMAIL_GRAPH_QUALIFIED_READ_SCOPE = "openid profile offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/Mail.Read";
const HOTMAIL_LEGACY_SCOPE = "openid profile User.Read Mail.ReadWrite Mail.Send Mail.Read";
const HOTMAIL_POLL_ATTEMPTS = 12;
const HOTMAIL_POLL_INTERVAL_MS = 5000;
const HOTMAIL_MESSAGE_FETCH_LIMIT = 10;
const HOTMAIL_FOLDER_IDS = ["inbox", "junkemail"];
const aliasAccountMap = new Map();
let accountCache = null;
let cachedDispatcher = null;

function getHotmailDispatcher() {
  if (!cachedDispatcher) {
    cachedDispatcher = new Agent({connect: {rejectUnauthorized: false}});
  }
  return cachedDispatcher;
}

async function hotmailFetch(input, init = {}) {
  try {
    return await undiciFetch(input, {
      ...init,
      dispatcher: getHotmailDispatcher(),
    });
  } catch (error) {
    const cause = error?.cause;
    const causeMessage = cause instanceof Error ? cause.message : (cause ? String(cause) : "");
    const baseMessage = error instanceof Error ? error.message : String(error);
    const merged = causeMessage && causeMessage !== baseMessage
      ? `${baseMessage}: ${causeMessage}`
      : baseMessage;
    throw new Error(`Hotmail 请求网络异常: ${merged}`);
  }
}

function normalizeApiMode(value) {
  const mode = String(value ?? "").toLowerCase();
  return mode === "rest" || mode === "graph" ? mode : "";
}

function normalizeScope(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isRestScope(value) {
  const scope = normalizeScope(value);
  return scope.includes("outlook.office.com/");
}

function isGraphScope(value) {
  const scope = normalizeScope(value);
  if (scope.includes("outlook.office.com/")) {
    return false;
  }
  return scope.includes("graph.microsoft.com/")
    || /\buser\.read\b/i.test(scope)
    || /\bmail\.read(?:write)?\b/i.test(scope)
    || /\bmail\.send\b/i.test(scope);
}

function normalizeEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

function resolveApiMode(account) {
  const explicitMode = normalizeApiMode(account?.apiMode);
  if (explicitMode) {
    return explicitMode;
  }

  const scope = normalizeScope(account?.scope);
  const accessToken = String(account?.accessToken ?? "").trim();
  if (isRestScope(scope)) {
    return "rest";
  }
  if (isGraphScope(scope)) {
    return "graph";
  }

  const payload = decodeJwtPayload(accessToken);
  const audience = Array.isArray(payload.aud)
    ? payload.aud.join(" ").toLowerCase()
    : String(payload.aud ?? "").toLowerCase();
  if (audience.includes("outlook.office.com") || audience.includes("00000002-0000-0ff1-ce00-000000000000")) {
    return "rest";
  }
  if (audience.includes("graph.microsoft.com") || audience.includes("00000003-0000-0000-c000-000000000000")) {
    return "graph";
  }

  return "graph";
}

function decodeJwtPayload(token) {
  const parts = String(token ?? "").split(".");
  if (parts.length < 2) {
    return {};
  }
  const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  try {
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return {};
  }
}

function isCompactToken(value) {
  const parts = String(value ?? "").trim().split(".");
  return parts.length === 3 || parts.length === 5;
}

function getTokenExpireAtMs(account) {
  const payload = decodeJwtPayload(account.accessToken);
  const exp = Number(payload.exp ?? 0);
  if (exp > 0) {
    return exp * 1000;
  }

  const obtainedAt = Date.parse(String(account.obtainedAt ?? ""));
  const expiresIn = Number(account.expiresIn ?? 0);
  if (Number.isFinite(obtainedAt) && expiresIn > 0) {
    return obtainedAt + expiresIn * 1000;
  }

  return 0;
}

function isAccessTokenExpired(account) {
  const expireAtMs = getTokenExpireAtMs(account);
  if (!expireAtMs) {
    return !account.accessToken;
  }
  return Date.now() >= expireAtMs - 60 * 1000;
}

async function loadTextAccounts() {
  try {
    const raw = await readFile(HOTMAIL_TOKENS_FILE, "utf8");
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line, index) => parseDelimitedTokenLine(line, index))
      .filter(Boolean);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export function buildHotmailTokenAccount({
  email,
  password = "",
  clientId,
  refreshToken,
  accessToken = "",
  scope = "",
  redirectUri = "",
  index = -1,
  lineRaw = "",
  apiMode = "",
  raw = {},
  fileName = path.basename(HOTMAIL_TOKENS_FILE),
  filePath = HOTMAIL_TOKENS_FILE,
  persist,
}) {
  const loginHint = normalizeEmail(email);
  const account = {
    sourceType: "txt",
    fileName,
    filePath,
    lineIndex: index,
    lineRaw,
    loginHint,
    password: String(password ?? "").trim(),
    sourceAccount: loginHint,
    tenant: "consumers",
    clientId: String(clientId ?? "").trim(),
    redirectUri: String(redirectUri ?? "").trim(),
    scope: String(scope ?? "").trim(),
    tokenType: "Bearer",
    accessToken: String(accessToken ?? "").trim(),
    refreshToken: String(refreshToken ?? "").trim(),
    idToken: "",
    obtainedAt: "",
    expiresIn: 0,
    extExpiresIn: 0,
    apiMode: normalizeApiMode(apiMode),
    raw,
    persist,
  };
  return loginHint && account.clientId && account.refreshToken ? account : null;
}

function parseDelimitedTokenLine(line, index) {
  const parts = String(line ?? "").split("----");
  if (parts.length < 4) {
    return null;
  }
  const [email, password, clientId, ...refreshTokenParts] = parts;
  return buildHotmailTokenAccount({
    email,
    password,
    clientId,
    refreshToken: refreshTokenParts.join("----"),
    index,
    lineRaw: line,
  });
}

async function loadAccounts() {
  if (accountCache) {
    return accountCache;
  }

  const textAccounts = await loadTextAccounts();
  const accounts = textAccounts;
  if (!accounts.length) {
    throw new Error(`未在文件找到 Hotmail token: ${HOTMAIL_TOKENS_FILE}`);
  }

  accountCache = accounts;
  return accounts;
}

async function nextHotmailEmailFromQueue(label) {
  while (true) {
    const entry = await nextHotmailEmailEntry(label);
    const email = normalizeEmail(entry.email);
    try {
      const account = entry.clientId && entry.refreshToken
        ? buildHotmailTokenAccount({
          email,
          password: entry.password,
          clientId: entry.clientId,
          refreshToken: entry.refreshToken,
          apiMode: "graph",
          index: entry.lineIndex,
          lineRaw: entry.lineRaw,
        })
        : await resolveAccountForEmail(email);
      if (!account) {
        throw new Error(`邮箱行缺少 client_id 或 refresh_token: ${email}`);
      }
      aliasAccountMap.set(normalizeEmail(email), account);
      return {email, account};
    } catch (error) {
      await appendErrorEmail(email, entry.sourceFile);
      console.warn(
        `${label}: ${email} 未匹配到可用 token，已记录失败并跳过: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function persistTextAccount(account) {
  const raw = await readFile(HOTMAIL_TOKENS_FILE, "utf8");
  const lines = raw.split(/\r?\n/);
  const nextLine = [
    account.loginHint,
    account.password ?? "",
    account.clientId ?? "",
    account.refreshToken ?? "",
  ].join("----");
  const index = Number(account.lineIndex ?? -1);

  if (index >= 0 && index < lines.length) {
    lines[index] = nextLine;
  } else {
    lines.push(nextLine);
    account.lineIndex = lines.length - 1;
  }

  await writeFile(HOTMAIL_TOKENS_FILE, `${lines.filter((line) => line != null).join("\n").replace(/\n+$/g, "")}\n`, "utf8");
  account.lineRaw = nextLine;
}

async function persistAccount(account) {
  if (typeof account.persist === "function") {
    await account.persist(account);
    return;
  }
  await persistTextAccount(account);
}

function buildRefreshVariants(account) {
  const redirectUri = String(account.redirectUri ?? "").trim();
  const scope = String(account.scope ?? "").trim();
  const redirects = ["", redirectUri, HOTMAIL_DEFAULT_REDIRECT_URI];
  const scopes = [
    ...(isRestScope(scope) || isGraphScope(scope) ? [scope] : []),
    HOTMAIL_GRAPH_READ_SCOPE,
    HOTMAIL_GRAPH_QUALIFIED_READ_SCOPE,
    HOTMAIL_LEGACY_SCOPE,
    HOTMAIL_REST_READ_SCOPE,
    "",
  ];
  const variants = [];
  for (const variantScope of scopes) {
    for (const variantRedirect of redirects) {
      variants.push({redirectUri: variantRedirect, scope: variantScope});
    }
  }
  const seen = new Set();

  return variants.filter((item) => {
    const key = `${item.redirectUri}|||${item.scope}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

async function refreshAccessToken(account) {
  if (!account.clientId || !account.refreshToken) {
    throw new Error(`Hotmail token 缺少刷新所需字段: ${account.fileName}`);
  }

  const errors = [];
  for (const variant of buildRefreshVariants(account)) {
    const body = new URLSearchParams({
      client_id: account.clientId,
      grant_type: "refresh_token",
      refresh_token: account.refreshToken,
    });

    if (variant.redirectUri) {
      body.set("redirect_uri", variant.redirectUri);
    }
    if (variant.scope) {
      body.set("scope", variant.scope);
    }

    const response = await hotmailFetch(HOTMAIL_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const rawBody = await response.text();
    if (!response.ok) {
      errors.push(`redirect=${variant.redirectUri || "(empty)"} scope=${variant.scope || "(empty)"} status=${response.status} body=${rawBody}`);
      continue;
    }

    const payload = JSON.parse(rawBody);
    const accessToken = String(payload?.access_token ?? "").trim();
    const refreshToken = String(payload?.refresh_token ?? account.refreshToken).trim();
    if (!accessToken) {
      if (refreshToken) {
        account.refreshToken = refreshToken;
      }
      errors.push(`redirect=${variant.redirectUri || "(empty)"} scope=${variant.scope || "(empty)"} 响应缺少 access_token`);
      continue;
    }
    account.accessToken = accessToken;
    account.refreshToken = String(payload?.refresh_token ?? account.refreshToken).trim();
    account.idToken = String(payload?.id_token ?? account.idToken ?? "").trim();
    account.tokenType = String(payload?.token_type ?? account.tokenType ?? "Bearer").trim();
    account.scope = String(payload?.scope ?? variant.scope ?? account.scope).trim();
    account.redirectUri = variant.redirectUri || account.redirectUri || HOTMAIL_DEFAULT_REDIRECT_URI;
    account.expiresIn = Number(payload?.expires_in ?? account.expiresIn ?? 0);
    account.extExpiresIn = Number(payload?.ext_expires_in ?? account.extExpiresIn ?? 0);
    account.obtainedAt = new Date().toISOString();
    account.apiMode = normalizeApiMode(account.apiMode) || resolveApiMode(account);

    await persistAccount(account);
    console.log(`hotmailTokenRefreshed: ${account.loginHint} mode=${account.apiMode} scope=${account.scope}`);
    return account;
  }

  throw new Error(`Hotmail 刷新 token 失败: ${errors.slice(-3).join(" | ")}`);
}

async function ensureFreshAccount(account) {
  if (!account.accessToken || isAccessTokenExpired(account)) {
    await refreshAccessToken(account);
  }
  return account;
}

function buildAuthHeaders(account) {
  return {
    Accept: "application/json",
    Authorization: `Bearer ${account.accessToken}`,
  };
}

function normalizeRecipientList(recipients) {
  if (!Array.isArray(recipients)) {
    return [];
  }
  return recipients
    .map((item) => normalizeEmail(item?.EmailAddress?.Address ?? item?.emailAddress?.address ?? item?.address ?? ""))
    .filter(Boolean);
}

function normalizeMessage(message, folderId) {
  const bodyContent = String(message?.Body?.Content ?? message?.body?.content ?? "");
  return {
    id: String(message?.Id ?? message?.id ?? ""),
    folderId,
    subject: String(message?.Subject ?? message?.subject ?? ""),
    bodyContent,
    bodyPreview: String(message?.BodyPreview ?? message?.bodyPreview ?? ""),
    from: normalizeEmail(message?.From?.EmailAddress?.Address ?? message?.from?.emailAddress?.address ?? ""),
    toRecipients: normalizeRecipientList(message?.ToRecipients ?? message?.toRecipients),
    receivedDateTime: String(message?.ReceivedDateTime ?? message?.receivedDateTime ?? ""),
    receivedAtMs: Date.parse(String(message?.ReceivedDateTime ?? message?.receivedDateTime ?? "")) || 0,
    raw: message,
  };
}

async function listFolderMessages(account, folderId) {
  let payload = null;
  let apiMode = "graph";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    await ensureFreshAccount(account);
    apiMode = resolveApiMode(account);
    const isRest = apiMode === "rest";
    const url = new URL(
      isRest
        ? `${HOTMAIL_REST_BASE_URL}/me/mailfolders/${encodeURIComponent(folderId)}/messages`
        : `${HOTMAIL_GRAPH_BASE_URL}/me/mailFolders/${encodeURIComponent(folderId)}/messages`,
    );
    url.searchParams.set("$top", String(HOTMAIL_MESSAGE_FETCH_LIMIT));
    url.searchParams.set("$orderby", isRest ? "ReceivedDateTime desc" : "receivedDateTime desc");
    if (!isRest) {
      url.searchParams.set("$select", "id,subject,bodyPreview,body,from,toRecipients,receivedDateTime");
    }

    const response = await hotmailFetch(url, {
      method: "GET",
      headers: buildAuthHeaders(account),
    });

    if (response.status === 401 && attempt === 1) {
      await refreshAccessToken(account);
      continue;
    }

    if (!response.ok) {
      const rawBody = await response.text();
      const bodyText = rawBody || "(empty)";
      const hint = response.status === 401
        ? "，已刷新 token 后仍被拒绝，请确认 refresh_token 对应的 Microsoft Graph Mail.Read 权限仍有效"
        : "";
      throw new Error(`Hotmail ${isRest ? "REST" : "Graph"} 请求失败: ${response.status}${hint} body=${bodyText}`);
    }

    payload = await response.json();
    break;
  }

  return Array.isArray(payload?.value)
    ? payload.value.map((item) => normalizeMessage(item, folderId))
    : [];
}

async function getLatestVerificationMessage(targetEmail, account) {
  const messages = [];

  for (const folderId of HOTMAIL_FOLDER_IDS) {
    const folderMessages = await listFolderMessages(account, folderId);
    messages.push(...folderMessages);
  }

  messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);

  console.log(`hotmailMessagesFetched: targetEmail=${targetEmail} mailbox=${account.loginHint} count=${messages.length}`);
  return findLatestVerificationMail(
    messages.map((message) => ({
      ...message,
      recipient: message.toRecipients,
      content: message.bodyContent,
      timestamp: message.receivedAtMs,
      extraTexts: [message.bodyPreview],
    })),
    {
      targetEmail,
      candidateMatcher: (mail) =>
        /(OpenAI|ChatGPT)/i.test(
          `${mail.subject ?? ""}\n${mail.bodyPreview ?? ""}\n${mail.from ?? ""}`,
        ),
    },
  );
}

async function getLatestHotmailEmailSummary(targetEmail, account) {
  const messages = [];
  for (const folderId of HOTMAIL_FOLDER_IDS) {
    const folderMessages = await listFolderMessages(account, folderId);
    messages.push(...folderMessages);
  }
  messages.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
  const latest = messages[0];
  if (!latest) {
    return null;
  }
  const matched = findLatestVerificationMail(
    [{
      ...latest,
      recipient: latest.toRecipients,
      content: latest.bodyContent,
      timestamp: latest.receivedAtMs,
      extraTexts: [latest.bodyPreview],
    }],
    {
      targetEmail,
      rememberLastCode: false,
      candidateMatcher: (mail) =>
        /(OpenAI|ChatGPT)/i.test(
          `${mail.subject ?? ""}\n${mail.bodyPreview ?? ""}\n${mail.from ?? ""}`,
        ),
    },
  );
  return {
    id: latest.id,
    sender: latest.from,
    recipient: latest.toRecipients,
    subject: latest.subject,
    content: latest.bodyContent,
    html: latest.bodyContent,
    snippet: latest.bodyPreview,
    timestamp: latest.receivedAtMs,
    receivedAt: latest.receivedDateTime,
    verificationCode: matched?.verificationCode ?? "",
  };
}

async function resolveAccountForEmail(email) {
  const normalizedEmail = normalizeEmail(email);
  const mapped = aliasAccountMap.get(normalizedEmail);
  if (mapped) {
    return mapped;
  }

  const accounts = await loadAccounts();
  const [localPart, domain] = normalizedEmail.split("@");
  const baseLocalPart = String(localPart ?? "").split("+")[0];

  const matched = accounts.find((account) => {
    const [accountLocalPart, accountDomain] = normalizeEmail(account.loginHint).split("@");
    return accountLocalPart === baseLocalPart && accountDomain === domain;
  });

  if (matched) {
    aliasAccountMap.set(normalizeEmail(email), matched);
    return matched;
  }

  throw new Error(`Hotmail 未找到与邮箱匹配的 token: ${email}`);
}

function createHotmailGraphProvider(resolveAccount = resolveAccountForEmail) {
  return {
    async getEmailAddress() {
      const {email} = await nextHotmailEmailFromQueue("hotmailEmailQueue");
      return email;
    },
    async getEmailVerificationCode(email) {
      const account = await resolveAccount(email);

      for (let attempt = 1; attempt <= HOTMAIL_POLL_ATTEMPTS; attempt += 1) {
        console.log(
          `pollHotmailOtp: attempt=${attempt}/${HOTMAIL_POLL_ATTEMPTS} targetEmail=${email} mailbox=${account.loginHint}`,
        );

        const message = await getLatestVerificationMessage(email, account);
        if (message?.verificationCode) {
          console.log(`hotmailOtpCode: ${message.verificationCode}`);
          console.log(`hotmailOtpFolder: ${message.folderId}`);
          return message.verificationCode;
        }

        if (attempt < HOTMAIL_POLL_ATTEMPTS) {
          await new Promise((resolve) => setTimeout(resolve, HOTMAIL_POLL_INTERVAL_MS));
        }
      }

      throw new Error(`Hotmail 中未找到验证码: targetEmail=${email}`);
    },
    async getLatestEmail(email) {
      const targetEmail = normalizeEmail(email);
      const account = await resolveAccount(targetEmail);
      return getLatestHotmailEmailSummary(targetEmail, account);
    },
  };
}

export function createHotmailDatabaseProvider(account) {
  return createHotmailGraphProvider(async () => account);
}

export function createHotmailProvider(mode: HotmailMode = appConfig.hotmailMode) {
  if (mode === "xiongmaodian") {
    return createHotmailXiongmaodianProvider();
  }
  return createHotmailGraphProvider(resolveAccountForEmail);
}
