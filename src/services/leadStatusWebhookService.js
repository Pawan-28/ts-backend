// Outbound n8n webhook for lead status "Converted" / "Advanced Paid".
//
// Triggered from every backend path that writes a lead's pipeline_stage / status
// (repo.updateLead → updateLeadStage, PUT /leads/:id, employee + admin panels;
// dataService.updatePipelineLeadStage → admin pipeline drag; salesController.updateLead)
// — always AFTER the database update has succeeded. A webhook failure is logged and
// never rolls the status back. Independent of the meeting webhook (n8nWebhookService).
const pool = require("../../config/db");
const { logger } = require("../config/logger");
const { mapStageToId } = require("../utils/pipelineStages");
const { toIndianMobile10 } = require("../utils/phone");
const { cleanServiceName } = require("../utils/meetingTitle");
const { extractTracking } = require("../utils/leadMeta");

// LEAD_STATUS_WEBHOOK_URL (server env) overrides it if set; .env is not modified.
const DEFAULT_LEAD_STATUS_WEBHOOK_URL = "https://n8n.srv1000386.hstgr.cloud/webhook/1b186ff4-3be6-484b-9b68-a124d8c8d2c1";
const WEBHOOK_TIMEOUT_MS = Number(process.env.N8N_WEBHOOK_TIMEOUT_MS || 10000);
const DEDUPE_WINDOW_MS = 30 * 1000;
const recentlySent = new Map(); // `${tenant}:${leadId}:${from}->${to}` → sent-at ms

const STATUS_CONVERTED = "Converted";
const STATUS_ADVANCED_PAID = "Advanced Paid";

function getWebhookUrl() {
  return (process.env.LEAD_STATUS_WEBHOOK_URL || DEFAULT_LEAD_STATUS_WEBHOOK_URL).trim();
}

/**
 * Map a lead's (pipeline_stage, status) to "Converted" | "Advanced Paid" | null, using
 * the same stage vocabulary as the rest of the CRM (utils/pipelineStages.mapStageToId):
 *   advance_paid ("Advance Paid")                              → "Advanced Paid"
 *   payment_complete ("Payment Complete", "Converted", "won")  → "Converted"
 */
function classifyLeadStatus(pipelineStage, status) {
  const stageRaw = String(pipelineStage || "").trim();
  if (stageRaw) {
    const id = mapStageToId(stageRaw, status);
    if (id === "advance_paid") return STATUS_ADVANCED_PAID;
    if (id === "payment_complete") return STATUS_CONVERTED;
    // A real pipeline stage is authoritative — a stale status column (e.g. still
    // "Advance Paid" after the lead moved back to Proposal Sent) must not count.
    if (id !== "lead") return null;
  }
  const st = String(status || "").toLowerCase().replace(/_/g, " ").trim();
  if (st.includes("advance paid") || st.includes("advanced paid")) return STATUS_ADVANCED_PAID;
  if (st === "converted" || st.includes("payment complete") || st === "won" || st.includes("closed won")) {
    return STATUS_CONVERTED;
  }
  return null;
}

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return {}; }
}

function emptyToNull(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s : null;
}

async function safeRow(sql, params) {
  try {
    const r = await pool.query(sql, params);
    return r.rows?.[0] || null;
  } catch {
    return null; // optional table/column not present in this deployment
  }
}

/** Current service code (services.service_code, e.g. SRV-001) for the lead. */
async function resolveServiceId(tenantId, lead, meta) {
  const serviceName = cleanServiceName(lead.requirements) || cleanServiceName(meta.services) || cleanServiceName(meta.service);
  if (serviceName) {
    const byName = await safeRow(
      `SELECT service_code, id FROM services
       WHERE (tenant_id = $1 OR tenant_id IS NULL) AND LOWER(name) = LOWER($2) LIMIT 1`,
      [tenantId, serviceName],
    );
    if (byName) return byName.service_code || String(byName.id);
  }
  return emptyToNull(meta.serviceId || meta.service_id);
}

/** Current SOP code (sops.sop_code, e.g. SOP-007) for the lead. */
async function resolveSopId(lead, meta) {
  // 1. Explicit SOP stored on the lead row (leads.sop_id), when that column exists.
  const leadSop = await safeRow(
    `SELECT s.sop_code, s.id FROM leads l JOIN sops s ON s.id = l.sop_id WHERE l.id = $1 LIMIT 1`,
    [lead.id],
  );
  if (leadSop) return leadSop.sop_code || String(leadSop.id);

  // 2. SOP id sent with the lead (n8n / form / bulk upload) — what the sender assigned.
  const sentSop = emptyToNull(extractTracking(meta).sopId);
  if (sentSop) return sentSop;

  // 3. SOP the CRM applies to this lead's current service (same matching as the AI MoM).
  const serviceName = cleanServiceName(lead.requirements) || cleanServiceName(meta.services) || cleanServiceName(meta.service);
  try {
    const result = await pool.query(`SELECT id, sop_code, service, services FROM sops WHERE status <> 'Archived' ORDER BY updated_at DESC`);
    const candidates = result.rows.map((row) => {
      let services = parseJson(row.services);
      if (!Array.isArray(services) || !services.length) services = [row.service || "All Services"];
      return { row, services };
    });
    const exact = serviceName && candidates.find((c) => c.services.includes(serviceName));
    const hit = exact || candidates.find((c) => c.services.includes("All Services"));
    if (hit) return hit.row.sop_code || String(hit.row.id);
  } catch {
    // sops table unavailable — fall through
  }

  return emptyToNull(meta.sopId || meta.sop_id);
}

/** Employee identifier used by the lead-creation webhook (employee phone), else CRM id. */
async function resolveEmployeeId(tenantId, assignedTo) {
  if (assignedTo == null || assignedTo === "") return null;
  const emp = await safeRow(
    `SELECT id, phone FROM employees WHERE id = $1 AND (tenant_id = $2 OR tenant_id IS NULL) LIMIT 1`,
    [Number(assignedTo), tenantId],
  );
  if (!emp) return String(assignedTo);
  const phone10 = String(emp.phone || "").replace(/\D/g, "").slice(-10);
  return phone10 || String(emp.id);
}

/** Build the payload from the lead's CURRENT database row. */
async function buildPayload(tenantId, leadRow, status) {
  const meta = parseJson(leadRow.source_meta);
  const tracking = extractTracking(meta);
  const phone10 = toIndianMobile10(leadRow.phone);
  const expected = leadRow.expected_revenue;
  return {
    status,
    leadName: emptyToNull(leadRow.lead_name),
    phone: phone10 ? `91${phone10}` : emptyToNull(String(leadRow.phone || "").replace(/\D/g, "")),
    email: emptyToNull(leadRow.email),
    companyName: emptyToNull(leadRow.company_name),
    city: emptyToNull(leadRow.city),
    serviceId: await resolveServiceId(tenantId, leadRow, meta),
    employeeId: await resolveEmployeeId(tenantId, leadRow.assigned_to),
    sopId: await resolveSopId(leadRow, meta),
    pipelineStage: emptyToNull(leadRow.pipeline_stage),
    expectedRevenue: expected === null || expected === undefined || expected === "" ? null : String(Number(expected)),
    utm_source: emptyToNull(tracking.utm_source),
    utm_medium: emptyToNull(tracking.utm_medium),
    utm_campaign: emptyToNull(tracking.utm_campaign),
    utm_term: emptyToNull(tracking.utm_term),
    utm_content: emptyToNull(tracking.utm_content),
  };
}

async function postWebhook(payload) {
  const res = await fetch(getWebhookUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`n8n responded ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
  }
}

/**
 * Call after a successful lead update. Sends only when the classified status actually
 * CHANGED into Converted / Advanced Paid (Converted ⇄ Advanced Paid counts as a change).
 * Re-saving a lead that is already Converted sends nothing.
 */
async function onLeadStatusUpdated({ tenantId = "default", leadId, before, after }) {
  try {
    if (leadId == null) return { sent: false, reason: "no lead id" };
    const prev = classifyLeadStatus(before?.pipelineStage ?? before?.pipeline_stage, before?.status);

    const row = await safeRow(`SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 LIMIT 1`, [leadId, tenantId]);
    if (!row) return { sent: false, reason: "lead not found" };
    const next = after
      ? classifyLeadStatus(after.pipelineStage ?? after.pipeline_stage, after.status)
      : classifyLeadStatus(row.pipeline_stage, row.status);

    if (!next || next === prev) return { sent: false, reason: "no qualifying transition" };

    // Duplicate guard: two concurrent/double-submitted requests that both see the same
    // from→to transition send only once. A later genuine transition (e.g.
    // Converted → Advanced Paid → Converted) has a different from→to and is sent.
    const now = Date.now();
    for (const [k, at] of recentlySent) if (now - at > DEDUPE_WINDOW_MS) recentlySent.delete(k);
    const key = `${tenantId}:${leadId}:${prev || "none"}->${next}`;
    if (recentlySent.has(key)) return { sent: false, reason: "duplicate suppressed" };
    recentlySent.set(key, now);

    const payload = await buildPayload(tenantId, row, next);
    try {
      await postWebhook(payload);
      logger.info("[leadStatusWebhook] delivered", { leadId, status: next });
      return { sent: true, payload };
    } catch (err) {
      recentlySent.delete(key); // not delivered — a later genuine transition may send
      logger.error("[leadStatusWebhook] n8n webhook failed (lead status update unaffected)", { leadId, status: next, error: err.message });
      return { sent: false, reason: err.message, payload };
    }
  } catch (err) {
    logger.error("[leadStatusWebhook] unexpected error (lead status update unaffected)", { leadId, error: err.message });
    return { sent: false, reason: err.message };
  }
}

/** Fire-and-forget wrapper so the API response is never delayed or failed by n8n. */
function notifyLeadStatusUpdated(args) {
  setImmediate(() => { onLeadStatusUpdated(args).catch(() => {}); });
}

module.exports = {
  classifyLeadStatus,
  buildPayload,
  onLeadStatusUpdated,
  notifyLeadStatusUpdated,
  STATUS_CONVERTED,
  STATUS_ADVANCED_PAID,
};
