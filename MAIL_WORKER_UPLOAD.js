function normalizeEmailAddress(value) {
  return (value || "").trim().toLowerCase();
}

function unauthorized() {
  return new Response("unauthorized", { status: 401 });
}

function notFound() {
  return new Response("not found", { status: 404 });
}

function badRequest(message) {
  return new Response(message, { status: 400 });
}

function json(data, init) {
  return new Response(JSON.stringify(data), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(init?.headers || {}),
    },
  });
}

function getHeaderValue(headers, name) {
  return headers.get(name) || "";
}

function splitHeaderAndBody(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const dividerIndex = normalized.indexOf("\n\n");
  if (dividerIndex === -1) {
    return {
      headerText: normalized,
      bodyText: "",
    };
  }

  return {
    headerText: normalized.slice(0, dividerIndex),
    bodyText: normalized.slice(dividerIndex + 2),
  };
}

function parseHeaderLines(headerText) {
  const headers = new Map();
  const lines = headerText.split("\n");
  let currentName = "";
  let currentValue = "";

  for (const line of lines) {
    if (!line) {
      continue;
    }

    if (/^[ \t]/.test(line) && currentName) {
      currentValue += ` ${line.trim()}`;
      headers.set(currentName, currentValue);
      continue;
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }

    currentName = line.slice(0, colonIndex).trim().toLowerCase();
    currentValue = line.slice(colonIndex + 1).trim();
    headers.set(currentName, currentValue);
  }

  return headers;
}

function getBoundary(contentType) {
  const match = /boundary="?([^";]+)"?/i.exec(contentType || "");
  return match ? match[1] : "";
}

function getCharset(contentType) {
  const match = /charset="?([^";]+)"?/i.exec(contentType || "");
  return (match ? match[1] : "utf-8").trim().toLowerCase();
}

function decodeBytes(bytes, charset) {
  const normalizedCharset = charset || "utf-8";

  try {
    return new TextDecoder(normalizedCharset).decode(bytes);
  } catch {}

  try {
    return new TextDecoder("utf-8").decode(bytes);
  } catch {}

  return String.fromCharCode(...bytes);
}

function decodeQuotedPrintable(text, charset) {
  const input = (text || "").replace(/=\r?\n/g, "");
  const bytes = [];

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === "=" && /^[A-Fa-f0-9]{2}$/.test(input.slice(index + 1, index + 3))) {
      bytes.push(parseInt(input.slice(index + 1, index + 3), 16));
      index += 2;
      continue;
    }
    bytes.push(char.charCodeAt(0));
  }

  return decodeBytes(Uint8Array.from(bytes), charset);
}

function decodeBase64(text, charset) {
  const cleaned = text.replace(/\s+/g, "");
  if (!cleaned) {
    return "";
  }

  try {
    const binary = atob(cleaned);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return decodeBytes(bytes, charset);
  } catch {
    return text;
  }
}

function stripHtml(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function decodeMimeBody(bodyText, transferEncoding, contentType) {
  let decoded = bodyText || "";
  const charset = getCharset(contentType);

  if (/quoted-printable/i.test(transferEncoding || "")) {
    decoded = decodeQuotedPrintable(decoded, charset);
  } else if (/base64/i.test(transferEncoding || "")) {
    decoded = decodeBase64(decoded, charset);
  }

  if (/text\/html/i.test(contentType || "")) {
    return stripHtml(decoded);
  }

  return decoded.trim();
}

function extractTextFromMimePart(partSource) {
  const { headerText, bodyText } = splitHeaderAndBody(partSource);
  const headers = parseHeaderLines(headerText);
  const contentType = headers.get("content-type") || "text/plain";
  const transferEncoding = headers.get("content-transfer-encoding") || "";

  if (/multipart\//i.test(contentType)) {
    return extractBestBodyText(partSource);
  }

  if (/text\/plain/i.test(contentType) || /text\/html/i.test(contentType)) {
    return decodeMimeBody(bodyText, transferEncoding, contentType);
  }

  return "";
}

function extractMultipartParts(bodyText, boundary) {
  const marker = `--${boundary}`;
  const endMarker = `--${boundary}--`;
  const lines = bodyText.replace(/\r\n/g, "\n").split("\n");
  const parts = [];
  let current = [];
  let collecting = false;

  for (const line of lines) {
    if (line === marker || line === endMarker) {
      if (collecting && current.length > 0) {
        parts.push(current.join("\n").trim());
        current = [];
      }
      collecting = line !== endMarker;
      continue;
    }

    if (collecting) {
      current.push(line);
    }
  }

  if (current.length > 0) {
    parts.push(current.join("\n").trim());
  }

  return parts.filter(Boolean);
}

function extractBestBodyText(rawSource) {
  const { headerText, bodyText } = splitHeaderAndBody(rawSource);
  const headers = parseHeaderLines(headerText);
  const contentType = headers.get("content-type") || "text/plain";

  if (!/multipart\//i.test(contentType)) {
    return extractTextFromMimePart(rawSource);
  }

  const boundary = getBoundary(contentType);
  if (!boundary) {
    return bodyText.trim();
  }

  const parts = extractMultipartParts(bodyText, boundary);
  const textParts = [];
  const htmlParts = [];

  for (const part of parts) {
    const { headerText: partHeaderText } = splitHeaderAndBody(part);
    const partHeaders = parseHeaderLines(partHeaderText);
    const partContentType = partHeaders.get("content-type") || "";
    const extracted = extractTextFromMimePart(part);

    if (!extracted) {
      continue;
    }

    if (/text\/plain/i.test(partContentType)) {
      textParts.push(extracted);
      continue;
    }

    if (/text\/html/i.test(partContentType)) {
      htmlParts.push(extracted);
    }
  }

  if (textParts.length > 0) {
    return textParts.join("\n\n").trim();
  }

  if (htmlParts.length > 0) {
    return htmlParts.join("\n\n").trim();
  }

  return bodyText.trim();
}

async function readRawMessage(message) {
  try {
    if (typeof message.raw === "string") {
      return message.raw;
    }
  } catch {}

  try {
    if (message.raw) {
      return await new Response(message.raw).text();
    }
  } catch {}

  return "";
}

async function insertEmail(env, record) {
  await env.DB.prepare(
    `INSERT INTO emails (
      mailbox,
      from_email,
      subject,
      message_id,
      raw_text,
      received_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      record.mailbox,
      record.fromEmail,
      record.subject,
      record.messageId,
      record.rawText,
      record.receivedAt,
    )
    .run();
}

async function listEmails(env, mailbox, limit, offset) {
  const result = await env.DB.prepare(
    `SELECT
      id,
      mailbox,
      from_email,
      subject,
      message_id,
      raw_text,
      received_at
    FROM emails
    WHERE mailbox = ?
    ORDER BY received_at DESC, id DESC
    LIMIT ? OFFSET ?`,
  )
    .bind(mailbox, limit, offset)
    .all();

  return Array.isArray(result.results) ? result.results : [];
}

async function getLatestEmail(env, mailbox) {
  const result = await env.DB.prepare(
    `SELECT
      id,
      mailbox,
      from_email,
      subject,
      message_id,
      raw_text,
      received_at
    FROM emails
    WHERE mailbox = ?
    ORDER BY received_at DESC, id DESC
    LIMIT 1`,
  )
    .bind(mailbox)
    .first();

  return result || null;
}

async function getEmailById(env, id) {
  const result = await env.DB.prepare(
    `SELECT
      id,
      mailbox,
      from_email,
      subject,
      message_id,
      raw_text,
      received_at
    FROM emails
    WHERE id = ?`,
  )
    .bind(id)
    .first();

  return result || null;
}

async function deleteEmailById(env, id) {
  await env.DB.prepare("DELETE FROM emails WHERE id = ?").bind(id).run();
}

export default {
  async email(message, env) {
    const mailbox = normalizeEmailAddress(message.to);
    const fromEmail = normalizeEmailAddress(message.from);
    const subject = getHeaderValue(message.headers, "subject");
    const messageId = getHeaderValue(message.headers, "message-id");
    const rawSource = await readRawMessage(message);
    const bodyText = extractBestBodyText(rawSource);
    const rawText = bodyText || rawSource;
    const receivedAt = Date.now();

    await insertEmail(env, {
      mailbox,
      fromEmail,
      subject,
      messageId,
      rawText,
      receivedAt,
    });
  },

  async fetch(request, env) {
    if (request.headers.get("x-api-key") !== env.API_KEY) {
      return unauthorized();
    }

    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/emails") {
      const mailbox = normalizeEmailAddress(url.searchParams.get("to"));
      if (!mailbox) {
        return badRequest("missing to query parameter");
      }

      const limitParam = Number(url.searchParams.get("limit") || 20);
      const offsetParam = Number(url.searchParams.get("offset") || 0);
      const limit = Number.isFinite(limitParam) ? Math.max(1, Math.min(limitParam, 100)) : 20;
      const offset = Number.isFinite(offsetParam) ? Math.max(0, offsetParam) : 0;
      const emails = await listEmails(env, mailbox, limit, offset);

      return json({
        mailbox,
        emails,
        limit,
        offset,
      });
    }

    if (request.method === "GET" && url.pathname === "/latest") {
      const mailbox = normalizeEmailAddress(url.searchParams.get("to"));
      if (!mailbox) {
        return badRequest("missing to query parameter");
      }

      const latest = await getLatestEmail(env, mailbox);
      if (!latest) {
        return notFound();
      }

      return json(latest);
    }

    if (request.method === "GET" && url.pathname.startsWith("/emails/")) {
      const id = Number(url.pathname.slice("/emails/".length));
      if (!Number.isInteger(id) || id <= 0) {
        return badRequest("invalid email id");
      }

      const email = await getEmailById(env, id);
      if (!email) {
        return notFound();
      }

      return json(email);
    }

    if (request.method === "DELETE" && url.pathname.startsWith("/emails/")) {
      const id = Number(url.pathname.slice("/emails/".length));
      if (!Number.isInteger(id) || id <= 0) {
        return badRequest("invalid email id");
      }

      await deleteEmailById(env, id);
      return new Response("deleted");
    }

    return notFound();
  },
};
