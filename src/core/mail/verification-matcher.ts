export interface VerificationMailCandidate {
    id?: string;
    sender?: string;
    recipient?: string | string[];
    subject?: string;
    content?: string;
    timestamp?: number;
    extraTexts?: string[];
}

interface FindVerificationMailOptions<T> {
    targetEmail?: string;
    candidateMatcher?: (mail: T) => boolean;
    rememberLastCode?: boolean;
    excludeCodes?: string[];
}

const lastVerificationCodeByEmail = new Map<string, string>();

export function normalizeMailbox(value: string): string {
  const input = String(value ?? "").trim().toLowerCase();
  const angleMatch = input.match(/<([^>]+)>/);
  return (angleMatch?.[1] ?? input).trim();
}

function normalizeTextForCodeMatching(text: string): string {
  return String(text ?? "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(?:br|p|div|tr|td|li|table|tbody|center|section|article|h[1-6])\b[^>]*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, codePoint) => String.fromCharCode(Number(codePoint)))
    .replace(/&#x([0-9a-f]+);/gi, (_, codePoint) => String.fromCharCode(Number.parseInt(codePoint, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/g, "'")
    .replace(/[０-９]/g, (char) => String(char.charCodeAt(0) - 0xff10))
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSixDigitCode(value: string | undefined): string {
  const digitsOnly = String(value ?? "").replace(/\D/g, "");
  return digitsOnly.length === 6 ? digitsOnly : "";
}

function collectCodeCandidates(text: string): string[] {
  const candidates: string[] = [];
  const add = (value: string | undefined) => {
    const code = normalizeSixDigitCode(value);
    if (code && !candidates.includes(code)) {
      candidates.push(code);
    }
  };

  const raw = normalizeTextForCodeMatching(text);
  if (!raw) {
    return candidates;
  }

  const patterns = [
    /\b(?:your\s+)?(?:openai|chatgpt)\s+(?:verification\s+)?code\s+(?:is|:)\s*((?:\d[\s-]*){6})\b/i,
    /\b(?:enter|use|input|copy|paste|submit)\b.{0,80}?\b(?:code|验证码)\b.{0,80}?\b((?:\d[\s-]*){6})\b/i,
    /\b(?:temporary|one[-\s]?time|verification|security|login|sign[-\s]?in|auth(?:entication)?|确认|校验|验证|验证码|安全码)\b.{0,120}?\b((?:\d[\s-]*){6})\b/i,
    /\b((?:\d[\s-]*){6})\b.{0,100}?\b(?:is your|your|openai|chatgpt|temporary|one[-\s]?time|verification|security|login|sign[-\s]?in|auth(?:entication)?|code|验证码|安全码)\b/i,
    /\b(?:code|验证码|安全码)\b\s*(?:is|为|是|:|：)?\s*((?:\d[\s-]*){6})\b/i,
  ];
  for (const pattern of patterns) {
    for (const matched of raw.matchAll(new RegExp(pattern.source, `${pattern.flags.includes("i") ? "i" : ""}g`))) {
      add(matched[1]);
    }
  }

  const htmlCodeBlocks = String(text ?? "").matchAll(
    /<(?:td|p|div|span|strong|b|code)\b[^>]*>([\s\S]{0,120}?(?:\d[\s-]*){6}[\s\S]{0,120}?)<\/(?:td|p|div|span|strong|b|code)>/gi,
  );
  for (const matched of htmlCodeBlocks) {
    const normalizedBlock = normalizeTextForCodeMatching(matched[1]);
    const blockCode = normalizedBlock.match(/\b((?:\d[\s-]*){6})\b/)?.[1];
    add(blockCode);
  }

  for (const matched of raw.matchAll(/\b((?:\d[\s-]*){6})\b/g)) {
    add(matched[1]);
  }

  return candidates;
}

function extractVerificationCode(text: string): string {
  return collectCodeCandidates(text)[0] ?? "";
}

function normalizeRecipientList(recipient: string | string[] | undefined): string[] {
  if (Array.isArray(recipient)) {
    return recipient
      .map((item) => normalizeMailbox(item))
      .filter(Boolean);
  }
  const normalized = normalizeMailbox(recipient ?? "");
  return normalized ? [normalized] : [];
}

function mailboxMatchesTarget(candidate: string, target: string): boolean {
  const normalizedCandidate = normalizeMailbox(candidate);
  const normalizedTarget = normalizeMailbox(target);
  if (!normalizedCandidate || !normalizedTarget) {
    return false;
  }
  if (normalizedCandidate === normalizedTarget) {
    return true;
  }
  const [candidateLocal, candidateDomain] = normalizedCandidate.split("@");
  const [targetLocal, targetDomain] = normalizedTarget.split("@");
  if (!candidateLocal || !targetLocal || candidateDomain !== targetDomain) {
    return false;
  }
  return candidateLocal.split("+")[0] === targetLocal.split("+")[0];
}

function collectCandidateTexts(mail: VerificationMailCandidate): string[] {
  const texts = [mail.subject ?? "", mail.content ?? "", ...(mail.extraTexts ?? [])];
  return texts
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

export function findLatestVerificationMail<T extends VerificationMailCandidate>(
  mails: T[],
  options: FindVerificationMailOptions<T> = {},
): (T & { verificationCode: string }) | null {
  const targetEmail = normalizeMailbox(options.targetEmail ?? "");
  const shouldRememberLastCode = options.rememberLastCode !== false;
  const previousCode = targetEmail && shouldRememberLastCode
    ? lastVerificationCodeByEmail.get(targetEmail) ?? ""
    : "";
  const excludedCodes = new Set(
    (options.excludeCodes ?? [])
      .map((code) => normalizeSixDigitCode(code))
      .filter(Boolean),
  );
  const sorted = [...mails].sort(
    (left, right) => Number(right.timestamp ?? 0) - Number(left.timestamp ?? 0),
  );

  for (const mail of sorted) {
    if (targetEmail) {
      const recipients = normalizeRecipientList(mail.recipient);
      if (recipients.length > 0 && !recipients.some((recipient) => mailboxMatchesTarget(recipient, targetEmail))) {
        continue;
      }
    }

    if (options.candidateMatcher && !options.candidateMatcher(mail)) {
      continue;
    }

    const verificationCode = collectCandidateTexts(mail)
      .map((text) => extractVerificationCode(text))
      .find(Boolean) ?? "";

    if (!verificationCode) {
      continue;
    }

    if (excludedCodes.has(verificationCode)) {
      continue;
    }

    if (previousCode && verificationCode === previousCode) {
      continue;
    }

    const matchedMail = {
      ...mail,
      verificationCode,
    };
    if (targetEmail && shouldRememberLastCode) {
      lastVerificationCodeByEmail.set(targetEmail, verificationCode);
    }
    return matchedMail;
  }

  return null;
}
