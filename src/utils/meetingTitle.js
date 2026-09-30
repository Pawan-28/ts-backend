/**
 * Automatic CRM meeting title: "{{Customer Name}} {{Service Name}} - Clarity Call".
 * Mirrors frontend/src/lib/meetingTitle.js — both sides generate the same string, and
 * the backend value is what gets saved and sent to Google Calendar / Meet and n8n.
 */

const EMPTY_SERVICE_VALUES = new Set(["", "—", "-", "–", "n/a", "na", "none", "null", "undefined", "all services"]);

function cleanServiceName(value) {
  let text = String(value ?? "").trim();
  // Older leads may carry the legacy "[Service: X] notes" / "Service: X" prefix.
  const bracketed = text.match(/^\[Service:\s*([^\]]+)\]/i);
  if (bracketed) text = bracketed[1].trim();
  else {
    const prefixed = text.match(/^Service:\s*(.+)$/im);
    if (prefixed) text = prefixed[1].trim();
  }
  return EMPTY_SERVICE_VALUES.has(text.toLowerCase()) ? "" : text;
}

/** Service for a lead row as returned by operationalRepo (requirements first, like the employee UI). */
function resolveLeadServiceName(lead) {
  if (!lead) return "";
  const meta = lead.sourceMeta || lead.source_meta || {};
  const candidates = [lead.requirements, lead.service, lead.serviceName, meta.services, meta.service];
  for (const c of candidates) {
    const cleaned = cleanServiceName(Array.isArray(c) ? c[0] : c);
    if (cleaned) return cleaned;
  }
  return "";
}

/** Customer name for the title — falls back to the phone when the lead is unnamed. */
function resolveCustomerName(lead) {
  const raw = String(lead?.leadName ?? lead?.lead_name ?? lead?.name ?? "").trim();
  if (raw && !/^unknown( lead)?$/i.test(raw) && raw !== "Lead") return raw;
  const digits = String(lead?.phone ?? "").replace(/\D/g, "");
  return digits ? digits.slice(-10) : (raw || "Lead");
}

function buildClarityCallTitle(customerName, serviceName) {
  const name = String(customerName ?? "").trim() || "Lead";
  const service = cleanServiceName(serviceName);
  return service ? `${name} ${service} - Clarity Call` : `${name} - Clarity Call`;
}

module.exports = {
  cleanServiceName,
  resolveLeadServiceName,
  resolveCustomerName,
  buildClarityCallTitle,
};
