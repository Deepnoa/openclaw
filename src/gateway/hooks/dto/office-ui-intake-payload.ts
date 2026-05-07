import {
  FORMSPREE_SOURCE,
  INQUIRY_EVENT_TYPE,
  OFFICE_UI_HAS_REPLY_DRAFT_FIELD,
  OFFICE_UI_RUNTIME_TASK_ID_FIELD,
} from "../contract/inquiry-events.js";
import type { FormspreeIntakeSession } from "../intake/formspree-adapter.js";

export type OfficeUiIntakePayload = {
  type: typeof INQUIRY_EVENT_TYPE;
  source: typeof FORMSPREE_SOURCE;
  received_at: string;
  category: FormspreeIntakeSession["public_event"]["category"];
  service: string;
  has_email: boolean;
  has_company: boolean;
  has_phone: boolean;
  has_message: boolean;
  summary: string;
  raw_details_hidden: true;
  name: string;
  message: string;
  [OFFICE_UI_RUNTIME_TASK_ID_FIELD]?: string;
  [OFFICE_UI_HAS_REPLY_DRAFT_FIELD]?: boolean;
};

export function buildOfficeUiIntakePayload(
  session: FormspreeIntakeSession,
  runtimeTaskId?: string,
): OfficeUiIntakePayload {
  const event = session.public_event;
  const service = session.routing.service?.trim() || "other";
  const hasEmail = session.contact.has_email;
  const hasCompany = session.contact.has_company;
  const hasPhone = session.contact.has_phone;
  const hasMessage = session.contact.has_message;

  const payload: OfficeUiIntakePayload = {
    type: event.type,
    source: event.source,
    received_at: event.received_at,
    category: event.category,
    service,
    has_email: hasEmail,
    has_company: hasCompany,
    has_phone: hasPhone,
    has_message: hasMessage,
    summary: "Formspree inquiry detected",
    raw_details_hidden: true,
    name: "Formspree intake",
    message:
      `Formspree inquiry detected ` +
      `(category=${event.category}, service=${service}, has_email=${hasEmail ? "true" : "false"}, ` +
      `has_company=${hasCompany ? "true" : "false"}, has_phone=${hasPhone ? "true" : "false"}, ` +
      `has_message=${hasMessage ? "true" : "false"}, raw_details_hidden=true).`,
  };
  if (runtimeTaskId) {
    payload[OFFICE_UI_RUNTIME_TASK_ID_FIELD] = runtimeTaskId;
    payload[OFFICE_UI_HAS_REPLY_DRAFT_FIELD] = false;
  }
  return payload;
}
