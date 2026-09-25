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

function getWebhookUrl() {
  return (process.env.N8N_WEBHOOK_URL || "").trim();
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
function buildMeetingPayload({ action, meeting, lead, employee }) {
  return {
    action,
    leadId: lead?.id ?? meeting?.leadId ?? null,
    leadName: lead?.leadName ?? meeting?.leadName ?? null,
    phone: lead?.phone ?? meeting?.leadPhone ?? null,
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
async function sendMeetingWebhook({ action, meeting, lead, employee }) {
  const url = getWebhookUrl();
  if (!url) {
    logger.warn("[n8nWebhookService] N8N_WEBHOOK_URL not configured — skipping outbound meeting webhook", {
      action,
      meetingId: meeting?.id,
    });
    return { skipped: true };
  }

  const payload = buildMeetingPayload({ action, meeting, lead, employee });
  const headers = { "Content-Type": "application/json" };
  const secret = getWebhookSecret();
  if (secret) headers["X-Webhook-Secret"] = secret;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`n8n webhook responded with ${res.status}${text ? `: ${text}` : ""}`);
    err.status = res.status;
    throw err;
  }

  return { skipped: false };
}

async function sendMeetingBookedWebhook({ meeting, lead, employee }) {
  return sendMeetingWebhook({ action: "booked", meeting, lead, employee });
}

async function sendMeetingRescheduledWebhook({ meeting, lead, employee }) {
  return sendMeetingWebhook({ action: "rescheduled", meeting, lead, employee });
}

module.exports = {
  isConfigured,
  sendMeetingWebhook,
  sendMeetingBookedWebhook,
  sendMeetingRescheduledWebhook,
};
