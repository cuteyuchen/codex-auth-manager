import {fetch as undiciFetch, Agent, ProxyAgent, type Dispatcher, type RequestInit as UndiciRequestInit} from "undici";

const DEFAULT_TEST_URL = "https://chatgpt.com/cdn-cgi/trace";
const PROXY_TEST_TIMEOUT_MS = 10000;

export interface ProxyTestResult {
  ok: boolean;
  proxyUrl: string;
  targetUrl: string;
  status: number | null;
  elapsedMs: number;
  message: string;
}

function buildDispatcher(proxyUrl: string): Dispatcher {
  const normalized = proxyUrl.trim();
  return normalized
    ? new ProxyAgent({
      uri: normalized,
      requestTls: {rejectUnauthorized: false},
    })
    : new Agent({
      connect: {rejectUnauthorized: false},
    });
}

function normalizeTestUrl(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    return DEFAULT_TEST_URL;
  }
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("测试地址只支持 http/https");
  }
  return url.toString();
}

function formatErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause;
  const causeMessage = cause && typeof cause === "object" && "message" in cause
    ? String((cause as {message?: unknown}).message ?? "")
    : "";
  const causeCode = cause && typeof cause === "object" && "code" in cause
    ? String((cause as {code?: unknown}).code ?? "")
    : "";
  return [error.message, causeMessage, causeCode].filter(Boolean).join(" ");
}

export async function testProxyConnection(input: {proxyUrl?: unknown; targetUrl?: unknown}): Promise<ProxyTestResult> {
  const proxyUrl = typeof input.proxyUrl === "string" ? input.proxyUrl.trim() : "";
  const targetUrl = normalizeTestUrl(input.targetUrl);
  const started = Date.now();
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), PROXY_TEST_TIMEOUT_MS);

  try {
    const response = await undiciFetch(targetUrl, {
      method: "GET",
      dispatcher: buildDispatcher(proxyUrl),
      signal: abortController.signal,
      headers: {
        "user-agent": "codex-auth-manager/proxy-test",
      },
    } satisfies UndiciRequestInit);
    await response.body?.cancel();
    const elapsedMs = Date.now() - started;
    return {
      ok: response.ok,
      proxyUrl,
      targetUrl,
      status: response.status,
      elapsedMs,
      message: response.ok ? "代理可用" : `请求完成但状态异常: ${response.status}`,
    };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const aborted = error instanceof Error && error.name === "AbortError";
    return {
      ok: false,
      proxyUrl,
      targetUrl,
      status: null,
      elapsedMs,
      message: aborted ? `代理测试超时 (${PROXY_TEST_TIMEOUT_MS}ms)` : formatErrorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}
