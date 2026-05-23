import {appendFile, mkdir, readFile, rm, writeFile} from "node:fs/promises";
import path from "node:path";

const emailSourceFileByEmail = new Map<string, string>();

function normalizeEmail(email: string): string {
  const raw = String(email ?? "").trim().toLowerCase();
  return raw.split("----")[0]?.trim() ?? "";
}

export function recordEmailSourceFile(email: string, sourceFilePath: string): void {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPath = String(sourceFilePath ?? "").trim();
  if (!normalizedEmail || !normalizedPath) {
    return;
  }
  emailSourceFileByEmail.set(normalizedEmail, path.resolve(normalizedPath));
}

export function getEmailSourceFile(email: string): string | undefined {
  return emailSourceFileByEmail.get(normalizeEmail(email));
}

export function getErrorEmailFilePath(sourceFilePath: string): string {
  return path.join(path.dirname(path.resolve(sourceFilePath)), "error_emails.txt");
}

export function getSuccessEmailFilePath(sourceFilePath: string): string {
  return path.join(path.dirname(path.resolve(sourceFilePath)), "success_emial.txt");
}

export async function clearErrorEmailFile(sourceFilePath: string): Promise<string> {
  const errorFile = getErrorEmailFilePath(sourceFilePath);
  await rm(errorFile, {force: true});
  return errorFile;
}

export async function appendErrorEmail(
  email: string,
  sourceFilePath = getEmailSourceFile(email),
): Promise<string | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !sourceFilePath) {
    return null;
  }

  const errorFile = getErrorEmailFilePath(sourceFilePath);
  await mkdir(path.dirname(errorFile), {recursive: true});

  try {
    const raw = await readFile(errorFile, "utf8");
    const exists = raw
      .split(/\r?\n/)
      .map((line) => normalizeEmail(line))
      .includes(normalizedEmail);
    if (exists) {
      return errorFile;
    }
  } catch {
    // missing file is expected on the first failure
  }

  await appendFile(errorFile, `${normalizedEmail}\n`, "utf8");
  return errorFile;
}

export async function appendSuccessEmail(
  email: string,
  sourceFilePath = getEmailSourceFile(email),
): Promise<string | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !sourceFilePath) {
    return null;
  }

  const successFile = getSuccessEmailFilePath(sourceFilePath);
  await mkdir(path.dirname(successFile), {recursive: true});

  try {
    const raw = await readFile(successFile, "utf8");
    const exists = raw
      .split(/\r?\n/)
      .map((line) => normalizeEmail(line))
      .includes(normalizedEmail);
    if (exists) {
      return successFile;
    }
  } catch {
    // missing file is expected on the first success
  }

  await appendFile(successFile, `${normalizedEmail}\n`, "utf8");
  return successFile;
}

export async function removeEmailFromSourceFile(
  email: string,
  sourceFilePath = getEmailSourceFile(email),
): Promise<string | null> {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail || !sourceFilePath) {
    return null;
  }

  const resolvedSourceFile = path.resolve(sourceFilePath);
  const raw = await readFile(resolvedSourceFile, "utf8");
  const lines = raw.split(/\r?\n/);
  const nextLines = lines.filter((line) => normalizeEmail(line) !== normalizedEmail);

  if (nextLines.length === lines.length) {
    return resolvedSourceFile;
  }

  const content = nextLines.join("\n").replace(/\n+$/g, "");
  await writeFile(resolvedSourceFile, content ? `${content}\n` : "", "utf8");
  return resolvedSourceFile;
}
