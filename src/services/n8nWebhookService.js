// Outbound webhook notifications to n8n.
//
// This is the reverse direction of the existing inbound n8n integration
// (POST /webhooks/n8n in operationalRoutes.js, which n8n calls to create/update
// leads in this CRM). This service instead lets the backend push events OUT to an
// n8n webhook — e.g. when a meeting is booked or rescheduled — so n8n workflows can
// react to CRM-originated changes.
//
// Configuration follows the same pattern as the existing Callyzer integration
// (see callyzerService.js / CALLYZER_API_KEY): a base URL/key pair read from env,
// with an isConfigured() guard so a missing config degrades gracefully instead of
// throwing at import time.
const { logger } = require("../config/logger");
const { toIndianMobile10, toE164 } = require("../utils/phone");
const { cleanServiceName } = require("../utils/meetingTitle");

// Single n8n webhook used for BOTH "Booked" and "Reschedule" meeting events.
// N8N_WEBHOOK_URL (server env) still overrides it if set; .env is not modified.
const DEFAULT_MEETING_WEBHOOK_URL = "https://n8n.srv1000386.hstgr.cloud/webhook/aa5b59ea-ef7d-45cf-a9fd-1d6e5bfbdbee";
const WEBHOOK_TIMEOUT_MS = Number(process.env.N8N_WEBHOOK_TIMEOUT_MS || 10000);
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;
const recentlySent = new Map(); // dedupe key → sent-at ms

const STATUS_BY_ACTION = { booked: "Booked", rescheduled: "Reschedule" };

function getWebhookUrl() {
  return (process.env.N8N_WEBHOOK_URL || DEFAULT_MEETING_WEBHOOK_URL).trim();
}

function getWebhookSecret() {
  return (process.env.N8N_WEBHOOK_SECRET || "").trim();
}

function isConfigured() {
  return Boolean(getWebhookUrl());
}

/**
 * Build the outbound payload for a meeting event, using already-loaded lead/employee/
 * meeting records (no extra DB reads here — callers already have these from the route).
 */
/** Service saved with the meeting — the booking flows prefix the agenda with "Service: X". */
function serviceFromMeeting(meeting) {
  const agenda = meeting?.mom?.agenda;
  if (!agenda) return "";
  const m = String(agenda).match(/^Service:\s*(.+)$/im);
  return m ? cleanServiceName(m[1]) : "";
}

/** "YYYY-MM-DDTHH:mm:ss" (IST wall clock from toLocalSqlString) → { date, time }. */
function splitScheduledAt(scheduledAt) {
  const raw = scheduledAt instanceof Date ? scheduledAt.toISOString() : String(scheduledAt || "");
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
  return m ? { date: m[1], time: m[2] } : { date: null, time: null };
}

function buildMeetingPayload({ action, meeting, lead, employee, serviceName = "" }) {
  const rawPhone = lead?.phone ?? meeting?.leadPhone ?? null;
  const phone10 = toIndianMobile10(rawPhone);
  const { date, time } = splitScheduledAt(meeting?.scheduledAt);
  const service = cleanServiceName(serviceName) || serviceFromMeeting(meeting) || null;
  return {
    // Requested contract (snake_case) ─────────────────────────────────────────
    status: STATUS_BY_ACTION[action] || action,
    lead_id: lead?.id ?? meeting?.leadId ?? null,
    customer_name: lead?.leadName ?? meeting?.leadName ?? null,
    phone: rawPhone ? (toE164(rawPhone) || rawPhone) : null,
    country_code: phone10 ? "91" : null,
    phone_number: phone10 || null,
    service_name: service,
    meeting_title: meeting?.title ?? null,
    meeting_id: meeting?.id ?? null,
    meeting_date: date,
    meeting_time: time,
    meeting_link: meeting?.meetLink ?? null,
    employee_id: employee?.id ?? meeting?.employeeId ?? null,
    employee_name: employee?.name ?? meeting?.employeeName ?? null,
    // Existing camelCase fields (unchanged, kept for backward compatibility) ────
    action,
    leadId: lead?.id ?? meeting?.leadId ?? null,
    leadName: lead?.leadName ?? meeting?.leadName ?? null,
    leadPhone: rawPhone, // original stored value (the normalized one is `phone` above)
    email: lead?.email ?? meeting?.leadEmail ?? null,
    employeeId: employee?.id ?? meeting?.employeeId ?? null,
    employeeName: employee?.name ?? meeting?.employeeName ?? null,
    meetingId: meeting?.id ?? null,
    meetingTitle: meeting?.title ?? null,
    meetingUrl: meeting?.meetLink ?? null,
    meetLink: meeting?.meetLink ?? null,
    scheduledAt: meeting?.scheduledAt ?? null,
    durationMin: meeting?.durationMin ?? null,
    type: meeting?.location ?? null,
    location: meeting?.location ?? null,
    note: meeting?.mom?.agenda ?? null,
    agenda: meeting?.mom?.agenda ?? null,
  };
}

/**
 * POST a meeting event to the configured n8n webhook. Throws on failure (missing
 * config, network error, non-2xx response) — callers are expected to wrap this in
 * try/catch and log, since a webhook failure must never undo an already-saved meeting.
 */
async function sendMeetingWebhook({ action, meeting, lead, employee, serviceName }) {
  const url = getWebhookUrl();
  if (!url) {
    logger.warn("[n8nWebhookService] N8N_WEBHOOK_URL not configured — skipping outbound meeting webhook", {
      action,
      meetingId: meeting?.id,
    });
    return { skipped: true };
  }

  const payload = buildMeetingPayload({ action, meeting, lead, employee, serviceName });

  // Duplicate prevention: one POST per successful operation (same meeting + same
  // status + same schedule) even if the request is retried/double-submitted.
  const now = Date.now();
  for (const [key, at] of recentlySent) {
    if (now - at > DEDUPE_WINDOW_MS) recentlySent.delete(key);
  }
  const dedupeKey = `${payload.status}:${payload.meeting_id}:${meeting?.scheduledAt ?? ""}:${meeting?.meetLink ?? ""}`;
  if (payload.meeting_id != null && recentlySent.has(dedupeKey)) {
    logger.info("[n8nWebhookService] duplicate meeting webhook suppressed", { status: payload.status, meetingId: payload.meeting_id });
    return { skipped: true, duplicate: true };
  }
  recentlySent.set(dedupeKey, now);

  const headers = { "Content-Type": "application/json" };
  const secret = getWebhookSecret();
  if (secret) headers["X-Webhook-Secret"] = secret;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  } catch (err) {
    recentlySent.delete(dedupeKey); // not delivered — a later genuine retry may send
    throw err;
  }

  if (!res.ok) {
    recentlySent.delete(dedupeKey);
    const text = await res.text().catch(() => "");
    const err = new Error(`n8n webhook responded with ${res.status}${text ? `: ${text.slice(0, 300)}` : ""}`);
    err.status = res.status;
    throw err;
  }

  logger.info("[n8nWebhookService] meeting webhook delivered", { status: payload.status, meetingId: payload.meeting_id });
  return { skipped: false };
}

async function sendMeetingBookedWebhook({ meeting, lead, employee, serviceName }) {
  return sendMeetingWebhook({ action: "booked", meeting, lead, employee, serviceName });
}

async function sendMeetingRescheduledWebhook({ meeting, lead, employee, serviceName }) {
  return sendMeetingWebhook({ action: "rescheduled", meeting, lead, employee, serviceName });
}

module.exports = {
  isConfigured,
  buildMeetingPayload,
  serviceFromMeeting,
  sendMeetingWebhook,
  sendMeetingBookedWebhook,
  sendMeetingRescheduledWebhook,
};
