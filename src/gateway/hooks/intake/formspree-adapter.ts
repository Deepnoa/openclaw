import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  readJsonBodyWithLimit,
  readRequestBodyWithLimit,
  requestBodyErrorToText,
} from "../../../infra/http-body.js";
import {
  FORMSPREE_SESSION_TYPE,
  FORMSPREE_SOURCE,
  INQUIRY_EVENT_TYPE,
  type FormspreeInquiryCategory,
  type FormspreeInquiryEvent,
} from "../contract/inquiry-events.js";

export type ReadHookBodyResult = { ok: true; value: unknown } | { ok: false; error: string };

export type FormspreeIntakeSession = {
  session_type: typeof FORMSPREE_SESSION_TYPE;
  source: typeof FORMSPREE_SOURCE;
  received_at: string;
  public_event: FormspreeInquiryEvent;
  contact: {
    has_email: boolean;
    has_company: boolean;
    has_phone: boolean;
    has_message: boolean;
  };
  routing: {
    category: FormspreeInquiryCategory;
    service?: string;
    initial_owner: "ops";
  };
  raw: {
    email?: string;
    company?: string;
    phone?: string;
    service?: string;
    subject?: string;
    message?: string;
  };
};

function getRequestContentType(req: IncomingMessage): string {
  const raw = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  return typeof raw === "string" ? raw.split(";")[0].trim().toLowerCase() : "";
}

function getMultipartBoundary(req: IncomingMessage): string | null {
  const raw = Array.isArray(req.headers["content-type"])
    ? req.headers["content-type"][0]
    : req.headers["content-type"];
  if (typeof raw !== "string") {
    return null;
  }
  const match = raw.match(/boundary=([^;]+)/i);
  return match?.[1]?.trim().replace(/^"|"$/g, "") || null;
}

function assignHookField(target: Record<string, unknown>, key: string, value: string) {
  const existing = target[key];
  if (existing === undefined) {
    target[key] = value;
    return;
  }
  if (Array.isArray(existing)) {
    existing.push(value);
    return;
  }
  target[key] = [existing, value];
}

function parseUrlEncodedHookBody(raw: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const params = new URLSearchParams(raw);
  for (const [key, value] of params.entries()) {
    assignHookField(payload, key, value);
  }
  return payload;
}

function parseMultipartHookBody(raw: string, boundary: string): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const delimiter = `--${boundary}`;
  for (const chunk of raw.split(delimiter)) {
    const trimmed = chunk.trim();
    if (!trimmed || trimmed === "--") {
      continue;
    }
    const normalized = trimmed.replace(/^\r\n/, "").replace(/\r\n--$/, "");
    const splitAt = normalized.indexOf("\r\n\r\n");
    if (splitAt === -1) {
      continue;
    }
    const headerBlock = normalized.slice(0, splitAt);
    const bodyBlock = normalized.slice(splitAt + 4).replace(/\r\n$/, "");
    const disposition = headerBlock
      .split("\r\n")
      .find((line) => line.toLowerCase().startsWith("content-disposition:"));
    if (!disposition) {
      continue;
    }
    const nameMatch = disposition.match(/name="([^"]+)"/i);
    const filenameMatch = disposition.match(/filename="([^"]*)"/i);
    if (!nameMatch || filenameMatch) {
      continue;
    }
    assignHookField(payload, nameMatch[1], bodyBlock);
  }
  return payload;
}

function firstStringField(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }
  return undefined;
}

function classifyFormspreeCategory(text: string): FormspreeInquiryCategory {
  if (!text) {
    return "other";
  }
  if (text.includes("見積")) {
    return "inquiry";
  }
  if (text.includes("資料")) {
    return "document_request";
  }
  if (text.includes("相談")) {
    return "consultation";
  }
  if (text.includes("営業")) {
    return "sales";
  }
  return "other";
}

export async function readHookBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<ReadHookBodyResult> {
  const contentType = getRequestContentType(req);
  if (!contentType || contentType === "application/json" || contentType.endsWith("+json")) {
    const result = await readJsonBodyWithLimit(req, { maxBytes, emptyObjectOnEmpty: true });
    if (result.ok) {
      return result;
    }
    if (result.code === "PAYLOAD_TOO_LARGE") {
      return { ok: false, error: "payload too large" };
    }
    if (result.code === "REQUEST_BODY_TIMEOUT") {
      return { ok: false, error: "request body timeout" };
    }
    if (result.code === "CONNECTION_CLOSED") {
      return { ok: false, error: requestBodyErrorToText("CONNECTION_CLOSED") };
    }
    return { ok: false, error: result.error };
  }

  try {
    const raw = await readRequestBodyWithLimit(req, { maxBytes });
    if (!raw.trim()) {
      return { ok: true, value: {} };
    }
    if (contentType === "application/x-www-form-urlencoded") {
      return { ok: true, value: parseUrlEncodedHookBody(raw) };
    }
    if (contentType === "multipart/form-data") {
      const boundary = getMultipartBoundary(req);
      if (!boundary) {
        return { ok: false, error: "multipart boundary missing" };
      }
      return { ok: true, value: parseMultipartHookBody(raw, boundary) };
    }
    return { ok: false, error: `unsupported content type: ${contentType}` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Payload too large")) {
      return { ok: false, error: "payload too large" };
    }
    if (message.includes("Request body timeout")) {
      return { ok: false, error: "request body timeout" };
    }
    if (message.includes("Connection closed")) {
      return { ok: false, error: requestBodyErrorToText("CONNECTION_CLOSED") };
    }
    return { ok: false, error: message };
  }
}

export function buildFormspreeIntakeSession(
  payload: Record<string, unknown>,
  now = new Date(),
): FormspreeIntakeSession {
  const email = firstStringField(payload, ["email", "_replyto", "from", "sender"]);
  const company = firstStringField(payload, ["company", "organization", "organisation"]);
  const phone = firstStringField(payload, ["phone", "tel", "telephone"]);
  const service = firstStringField(payload, ["service", "service_type", "serviceType"]);
  const rawSubject = firstStringField(payload, ["subject", "_subject"]);
  const message = firstStringField(payload, ["message", "body", "content", "details"]);
  const classificationText = [service, rawSubject, message].filter(Boolean).join("\n");
  const category = classifyFormspreeCategory(classificationText);
  const receivedAt = now.toISOString();
  const publicEvent: FormspreeInquiryEvent = {
    type: INQUIRY_EVENT_TYPE,
    source: FORMSPREE_SOURCE,
    received_at: receivedAt,
    has_sender: Boolean(email),
    has_subject: Boolean(rawSubject || message),
    raw_subject: rawSubject,
    category,
  };
  return {
    session_type: FORMSPREE_SESSION_TYPE,
    source: FORMSPREE_SOURCE,
    received_at: receivedAt,
    public_event: publicEvent,
    contact: {
      has_email: Boolean(email),
      has_company: Boolean(company),
      has_phone: Boolean(phone),
      has_message: Boolean(message),
    },
    routing: {
      category,
      service,
      initial_owner: "ops",
    },
    raw: {
      email,
      company,
      phone,
      service,
      subject: rawSubject,
      message,
    },
  };
}

export function normalizeFormspreeInquiryPayload(
  payload: Record<string, unknown>,
  now = new Date(),
): FormspreeInquiryEvent {
  return buildFormspreeIntakeSession(payload, now).public_event;
}

export function buildFormspreeOpsHookMessage(session: FormspreeIntakeSession): string {
  const event = session.public_event;
  return [
    "Formspree inquiry intake session detected.",
    `session_type=${session.session_type}`,
    `type=${event.type}`,
    `source=${event.source}`,
    `received_at=${event.received_at}`,
    `has_sender=${event.has_sender ? "true" : "false"}`,
    `has_subject=${event.has_subject ? "true" : "false"}`,
    `category=${event.category}`,
    `service=${session.routing.service ?? ""}`,
    `raw_subject=${event.raw_subject ?? ""}`,
    `email=${session.raw.email ?? ""}`,
    `company=${session.raw.company ?? ""}`,
    `phone=${session.raw.phone ?? ""}`,
    `message=${session.raw.message ?? ""}`,
    "Keep raw inquiry details internal. Public scene should use only visitor.inquiry.detected.",
  ].join("\n");
}

export function buildFormspreeInquiryId(session: FormspreeIntakeSession): string {
  const digest = createHash("sha256")
    .update(
      [
        session.raw.email ?? "",
        session.raw.company ?? "",
        session.raw.phone ?? "",
        session.raw.service ?? "",
        session.raw.subject ?? "",
        session.raw.message ?? "",
        session.public_event.category,
      ].join("\u001f"),
      "utf8",
    )
    .digest("hex");
  return digest.slice(0, 12);
}

export function buildFormspreeVisibleSessionMessage(session: FormspreeIntakeSession): string {
  const event = session.public_event;
  return [
    "Formspree inquiry marker for Control UI.",
    `type=${event.type}`,
    `received_at=${event.received_at}`,
    `category=${event.category}`,
    `service=${session.routing.service ?? ""}`,
    `has_email=${session.contact.has_email ? "true" : "false"}`,
    `has_company=${session.contact.has_company ? "true" : "false"}`,
    `has_phone=${session.contact.has_phone ? "true" : "false"}`,
    `has_message=${session.contact.has_message ? "true" : "false"}`,
    "This session is a lightweight intake marker only.",
    "Do not expose raw contact details or message body here.",
    "If no follow-up is needed, reply only with NO_REPLY.",
  ].join("\n");
}
