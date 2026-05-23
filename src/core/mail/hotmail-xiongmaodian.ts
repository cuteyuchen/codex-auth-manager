import type {EmailCodeProvider, EmailVerificationCodeOptions} from "../mailbox.js";
import {
  getHotmailEmailsFile,
  getHotmailRemainingEmailCount,
  nextHotmailEmail,
} from "./hotmail-email-queue.js";
import {findLatestVerificationMail, normalizeMailbox} from "./verification-matcher.js";

const API_BASE = "https://mail.xiongmaodianjing.top/api/fetch";
const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 5000;
const SAME_CODE_OBSERVE_ATTEMPTS = 3;

interface XmdEmail {
    date?: string;
    from?: string;
    subject?: string;
    html_body?: string;
    text_body?: string;
}

interface XmdResponse {
    status?: string;
    emails?: XmdEmail[];
}

const lastAcceptedCodeByEmail = new Map<string, string>();

export async function getHotmailXiongmaodianEmailsFile(): Promise<string> {
  return getHotmailEmailsFile();
}

export async function getHotmailXiongmaodianRemainingEmailCount(): Promise<number> {
  return getHotmailRemainingEmailCount();
}

function parseTimestamp(date: string | undefined): number {
  const raw = String(date ?? "").trim();
  if (!raw) {
    return Date.now();
  }
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const parsed = Date.parse(withZone);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Date.now();
}

async function fetchInbox(email: string): Promise<XmdEmail[]> {
  const url = `${API_BASE}/${encodeURIComponent(email)}/1`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`xiongmaodian fetch HTTP ${response.status}`);
  }
  const payload = (await response.json()) as XmdResponse;
  if (payload?.status !== "success" || !Array.isArray(payload.emails)) {
    throw new Error(
      `xiongmaodian fetch payload invalid: status=${String(payload?.status)}`,
    );
  }
  return payload.emails;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeCode(value: string): string {
  const digitsOnly = String(value ?? "").replace(/\D/g, "");
  return digitsOnly.length === 6 ? digitsOnly : "";
}

async function getLatestEmailSummary(email: string) {
  const targetEmail = normalizeMailbox(email);
  const emails = await fetchInbox(targetEmail);
  const candidates = emails.map((mail) => ({
    sender: String(mail.from ?? ""),
    recipient: targetEmail,
    subject: String(mail.subject ?? ""),
    content: String(mail.html_body ?? "") || String(mail.text_body ?? ""),
    snippet: String(mail.text_body ?? ""),
    timestamp: parseTimestamp(mail.date),
    receivedAt: String(mail.date ?? ""),
    extraTexts: [String(mail.text_body ?? "")],
  })).sort((a, b) => b.timestamp - a.timestamp);
  const latest = candidates[0];
  if (!latest) {
    return null;
  }
  const matched = findLatestVerificationMail([latest], {
    targetEmail,
    rememberLastCode: false,
    candidateMatcher: (mail) =>
      /(OpenAI|ChatGPT)/i.test(
        `${mail.subject ?? ""}\n${mail.content ?? ""}\n${mail.sender ?? ""}`,
      ),
  });
  return {
    id: "",
    sender: latest.sender,
    recipient: latest.recipient,
    subject: latest.subject,
    content: latest.content,
    html: latest.content,
    snippet: latest.snippet,
    timestamp: latest.timestamp,
    receivedAt: latest.receivedAt || new Date(latest.timestamp).toISOString(),
    verificationCode: matched?.verificationCode ?? "",
  };
}

export function createHotmailXiongmaodianProvider(): EmailCodeProvider {
  return {
    async getEmailAddress(): Promise<string> {
      return nextHotmailEmail("xiongmaodianEmailQueue");
    },
    async getEmailVerificationCode(
      email: string,
      options: EmailVerificationCodeOptions = {},
    ): Promise<string> {
      const targetEmail = normalizeMailbox(email);
      const excludedCodes = (options.excludeCodes ?? [])
        .map((code) => normalizeCode(code))
        .filter(Boolean);
      const lastAcceptedCode = lastAcceptedCodeByEmail.get(targetEmail) ?? "";
      for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
        console.log(
          `pollHotmailOtp(xiongmaodian): attempt=${attempt}/${POLL_ATTEMPTS} targetEmail=${targetEmail}`,
        );

        let emails: XmdEmail[] = [];
        try {
          emails = await fetchInbox(targetEmail);
        } catch (error) {
          console.warn(
            `pollHotmailOtp(xiongmaodian) 拉取失败: ${(error as Error).message}`,
          );
        }

        if (emails.length > 0) {
          const candidates = emails.map((mail) => ({
            sender: String(mail.from ?? ""),
            recipient: targetEmail,
            subject: String(mail.subject ?? ""),
            content:
                            String(mail.html_body ?? "") ||
                            String(mail.text_body ?? ""),
            timestamp: parseTimestamp(mail.date),
            extraTexts: [String(mail.text_body ?? "")],
          }));

          const matched = findLatestVerificationMail(candidates, {
            targetEmail,
            rememberLastCode: false,
            excludeCodes: excludedCodes,
            candidateMatcher: (mail) =>
              /(OpenAI|ChatGPT)/i.test(
                `${mail.subject ?? ""}\n${mail.content ?? ""}\n${mail.sender ?? ""}`,
              ),
          });

          if (matched?.verificationCode) {
            if (
              lastAcceptedCode &&
                            matched.verificationCode === lastAcceptedCode &&
                            attempt < SAME_CODE_OBSERVE_ATTEMPTS
            ) {
              console.log(
                `pollHotmailOtp(xiongmaodian): same code ${matched.verificationCode} as previous, wait until attempt ${SAME_CODE_OBSERVE_ATTEMPTS}`,
              );
            } else {
              lastAcceptedCodeByEmail.set(targetEmail, matched.verificationCode);
              if (lastAcceptedCode && matched.verificationCode === lastAcceptedCode) {
                console.log(
                  `pollHotmailOtp(xiongmaodian): reuse same code ${matched.verificationCode} after ${attempt} attempts`,
                );
              }
              return matched.verificationCode;
            }
          }
        }

        if (attempt < POLL_ATTEMPTS) {
          await sleep(POLL_INTERVAL_MS);
        }
      }
      throw new Error(`Hotmail(xiongmaodian) 等待验证码超时: ${email}`);
    },
    async getLatestEmail(email: string) {
      return getLatestEmailSummary(email);
    },
  };
}
