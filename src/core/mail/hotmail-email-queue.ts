import {access, readFile} from "node:fs/promises";
import path from "node:path";
import {recordEmailSourceFile} from "../email-error-recorder.js";
import {normalizeMailbox} from "./verification-matcher.js";

const HOTMAIL_EMAILS_FILE = path.resolve(process.cwd(), "hotmail", "emails.txt");
const HOTMAIL_EMAIL_FILE = path.resolve(process.cwd(), "hotmail", "email.txt");

export interface HotmailEmailQueueEntry {
    email: string;
    password: string;
    clientId: string;
    refreshToken: string;
    sourceFile: string;
    lineIndex: number;
    lineRaw: string;
}

let emailQueue: HotmailEmailQueueEntry[] | null = null;
let activeEmailFile: string | null = null;

async function resolveHotmailEmailsFile(): Promise<string> {
  if (activeEmailFile) {
    return activeEmailFile;
  }

  for (const filePath of [HOTMAIL_EMAILS_FILE, HOTMAIL_EMAIL_FILE]) {
    try {
      await access(filePath);
      activeEmailFile = filePath;
      return activeEmailFile;
    } catch {
      // try the next supported filename
    }
  }

  activeEmailFile = HOTMAIL_EMAILS_FILE;
  return activeEmailFile;
}

function parseHotmailEmailLine(line: string, sourceFile: string, lineIndex: number): HotmailEmailQueueEntry | null {
  const lineRaw = String(line ?? "").trim();
  if (!lineRaw || lineRaw.startsWith("#")) {
    return null;
  }

  const [emailPart, password = "", clientId = "", ...refreshTokenParts] = lineRaw.split("----");
  const email = normalizeMailbox(emailPart);
  if (!email) {
    return null;
  }

  return {
    email,
    password: String(password ?? "").trim(),
    clientId: String(clientId ?? "").trim(),
    refreshToken: refreshTokenParts.join("----").trim(),
    sourceFile,
    lineIndex,
    lineRaw,
  };
}

async function loadHotmailEmailQueue(): Promise<HotmailEmailQueueEntry[]> {
  if (emailQueue) {
    return emailQueue;
  }

  const emailFile = await resolveHotmailEmailsFile();
  let raw: string;
  try {
    raw = await readFile(emailFile, "utf8");
  } catch {
    throw new Error(
      `未找到 ${HOTMAIL_EMAILS_FILE} 或 ${HOTMAIL_EMAIL_FILE}，请创建其中一个文件并按一行一个的格式写入 outlook 邮箱`,
    );
  }

  const seenEmails = new Set<string>();
  const list = raw
    .split(/\r?\n/)
    .map((line, index) => parseHotmailEmailLine(line, emailFile, index))
    .filter((entry): entry is HotmailEmailQueueEntry => {
      if (!entry || seenEmails.has(entry.email)) {
        return false;
      }
      seenEmails.add(entry.email);
      return true;
    });

  if (list.length === 0) {
    throw new Error(`${emailFile} 为空，请填入至少一个 outlook 邮箱`);
  }

  emailQueue = list;
  return emailQueue;
}

export async function getHotmailEmailsFile(): Promise<string> {
  return resolveHotmailEmailsFile();
}

export async function getHotmailRemainingEmailCount(): Promise<number> {
  const queue = await loadHotmailEmailQueue();
  return queue.length;
}

export async function nextHotmailEmail(label: string): Promise<string> {
  const entry = await nextHotmailEmailEntry(label);
  return entry.email;
}

export async function nextHotmailEmailEntry(label: string): Promise<HotmailEmailQueueEntry> {
  const queue = await loadHotmailEmailQueue();
  const entry = queue.shift();
  if (!entry) {
    throw new Error(`${await resolveHotmailEmailsFile()} 中的邮箱已全部使用完毕`);
  }

  recordEmailSourceFile(entry.email, entry.sourceFile);
  console.log(`${label}: remaining=${queue.length} selected=${entry.email}`);
  return entry;
}
