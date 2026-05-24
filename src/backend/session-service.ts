import {createHmac, randomBytes, timingSafeEqual} from "node:crypto";
import type {FastifyReply, FastifyRequest} from "fastify";
import {appConfig, updateConfigValues} from "../core/config.js";

const COOKIE_NAME = "codex_auth_manager_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function ensureSessionSecret(): string {
  if (appConfig.webSessionSecret) {
    return appConfig.webSessionSecret;
  }
  const secret = randomBytes(32).toString("base64url");
  updateConfigValues({webSessionSecret: secret});
  return appConfig.webSessionSecret;
}

function sign(value: string): string {
  return createHmac("sha256", ensureSessionSecret()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of String(header ?? "").split(";")) {
    const [key, ...valueParts] = part.trim().split("=");
    if (!key) {
      continue;
    }
    result[key] = decodeURIComponent(valueParts.join("="));
  }
  return result;
}

function buildCookie(value: string, maxAge: number): string {
  return [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

export function isAccessPasswordEnabled(): boolean {
  return Boolean(appConfig.webAccessPassword.trim());
}

export function isAuthenticated(request: FastifyRequest): boolean {
  if (!isAccessPasswordEnabled()) {
    return true;
  }
  const token = parseCookies(request.headers.cookie)[COOKIE_NAME];
  if (!token) {
    return false;
  }
  const [issuedAt, signature] = token.split(".");
  if (!issuedAt || !signature || sign(issuedAt) !== signature) {
    return false;
  }
  const ageMs = Date.now() - Number(issuedAt);
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= SESSION_MAX_AGE_SECONDS * 1000;
}

export function getSessionState(request: FastifyRequest): {passwordEnabled: boolean; authenticated: boolean} {
  return {
    passwordEnabled: isAccessPasswordEnabled(),
    authenticated: isAuthenticated(request),
  };
}

export function login(password: string, reply: FastifyReply): {ok: true} {
  const expected = appConfig.webAccessPassword.trim();
  if (!expected) {
    return {ok: true};
  }
  if (!safeEqual(password, expected)) {
    throw new Error("访问密码错误");
  }
  const issuedAt = String(Date.now());
  reply.header("Set-Cookie", buildCookie(`${issuedAt}.${sign(issuedAt)}`, SESSION_MAX_AGE_SECONDS));
  return {ok: true};
}

export function logout(reply: FastifyReply): {ok: true} {
  reply.header("Set-Cookie", buildCookie("", 0));
  return {ok: true};
}

export function assertHostAccessAllowed(host: string): void {
  const normalized = host.trim().toLowerCase();
  const isLocal = normalized === "127.0.0.1" || normalized === "localhost" || normalized === "::1";
  if (!isLocal && !isAccessPasswordEnabled()) {
    throw new Error("非本地监听必须先在配置页设置 Web 访问密码");
  }
}
