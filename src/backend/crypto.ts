import {randomBytes, createCipheriv, createDecipheriv} from "node:crypto";
import {mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {mkdir, readFile, writeFile} from "node:fs/promises";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const KEY_PATH = path.join(DATA_DIR, "local.key");

let cachedKey: Buffer | null = null;

async function loadKey(): Promise<Buffer> {
  if (cachedKey) {
    return cachedKey;
  }

  await mkdir(DATA_DIR, {recursive: true});
  try {
    const raw = (await readFile(KEY_PATH, "utf8")).trim();
    cachedKey = Buffer.from(raw, "base64");
  } catch {
    cachedKey = randomBytes(32);
    await writeFile(KEY_PATH, `${cachedKey.toString("base64")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  if (cachedKey.length !== 32) {
    throw new Error(`本地加密密钥长度不正确: ${KEY_PATH}`);
  }
  return cachedKey;
}

function loadKeySync(): Buffer {
  if (cachedKey) {
    return cachedKey;
  }

  mkdirSync(DATA_DIR, {recursive: true});
  try {
    const raw = readFileSync(KEY_PATH, "utf8").trim();
    cachedKey = Buffer.from(raw, "base64");
  } catch {
    cachedKey = randomBytes(32);
    writeFileSync(KEY_PATH, `${cachedKey.toString("base64")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }

  if (cachedKey.length !== 32) {
    throw new Error(`本地加密密钥长度不正确: ${KEY_PATH}`);
  }
  return cachedKey;
}

export async function encryptSecret(value: string): Promise<string> {
  if (!value) {
    return "";
  }
  const key = await loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export async function decryptSecret(value: string): Promise<string> {
  if (!value) {
    return "";
  }
  const [version, ivRaw, authTagRaw, encryptedRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !authTagRaw || !encryptedRaw) {
    throw new Error("加密字段格式不正确");
  }
  const key = await loadKey();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(authTagRaw, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}

export function encryptSecretSync(value: string): string {
  if (!value) {
    return "";
  }
  const key = loadKeySync();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecretSync(value: string): string {
  if (!value) {
    return "";
  }
  const [version, ivRaw, authTagRaw, encryptedRaw] = value.split(":");
  if (version !== "v1" || !ivRaw || !authTagRaw || !encryptedRaw) {
    throw new Error("加密字段格式不正确");
  }
  const key = loadKeySync();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(authTagRaw, "base64"));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedRaw, "base64")),
    decipher.final(),
  ]);
  return decrypted.toString("utf8");
}
