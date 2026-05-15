export const INQUIRY_EVENT_TYPE = "visitor.inquiry.detected";
export const FORMSPREE_SOURCE = "formspree";
export const FORMSPREE_SESSION_TYPE = "formspree_intake_session";
export const OFFICE_UI_RUNTIME_TASK_ID_FIELD = "runtime_task_id";
export const OFFICE_UI_HAS_REPLY_DRAFT_FIELD = "has_reply_draft";
export const OFFICE_UI_INQUIRY_ID_FIELD = "inquiry_id";

export const FORMSPREE_INQUIRY_CATEGORIES = [
  "inquiry",
  "document_request",
  "consultation",
  "sales",
  "other",
] as const;

export type FormspreeInquiryCategory = (typeof FORMSPREE_INQUIRY_CATEGORIES)[number];

export type FormspreeInquiryEvent = {
  type: typeof INQUIRY_EVENT_TYPE;
  source: typeof FORMSPREE_SOURCE;
  received_at: string;
  has_sender: boolean;
  has_subject: boolean;
  raw_subject?: string;
  category: FormspreeInquiryCategory;
};
