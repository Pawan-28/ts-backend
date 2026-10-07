/**
 * LEAD SOURCES - the list of sources the ADMIN "Sources" page shows, computed on the server so every dropdown (Add Lead, lead panel)
 * offers EXACTLY those sources - no more, no fewer. A source created from a dropdown ("+ Add new...") is saved in the settings
 * registry (settings.customSources) and so appears on the admin Sources page immediately.
 *
 * MIRROR of the frontend rules in frontend/src/lib/leadSource.js + leadAssignment.js (normalizeSource): the Sources page groups
 * leads with those, this file groups the same leads the same way. leadSources.parity.test.js proves they agree.
 */

const SOURCE_CATALOG = [
  { key: "meta_ads", label: "Meta" },
  { key: "google_ads", label: "Google Ads" },
  { key: "website", label: "Website" },
  { key: "whatsapp", label: "WhatsApp" },
  { key: "linkedin", label: "LinkedIn" },
  { key: "referral", label: "Referral" },
  { key: "landing_page", label: "Landing Page" },
  { key: "campaign", label: "Campaign" },
  { key: "manual", label: "Manual" },
  { key: "n8n", label: "n8n / Webhook" },
  { key: "api", label: "API" },
  { key: "form", label: "Form" },
  { key: "other", label: "Other" },
];
const CATALOG_LABELS = Object.fromEntries(SOURCE_CATALOG.map((s) => [s.key, s.label]));
const MARKETING_SOURCE_KEYS = new Set(SOURCE_CATALOG.map((s) => s.key));
const EXCLUDED_SOURCE_KEYS = new Set(["callyzer", "third_party"]);
/** Keys a custom source may never take (system / integration channels). */
const RESERVED_KEYS = new Set(["callyzer", "third_party", "unknown"]);

/** Frontend normalizeSource (lib/leadAssignment.js), same order of checks. */
function normalizeSourceKey(raw = "") {
  const s = String(raw || "").toLowerCase().trim();
  if (!s) return "api";
  if (s.includes("facebook") || s.includes("instagram") || s.includes("meta")) return "meta_ads";
  if (s.includes("google")) return "google_ads";
  if (s.includes("whatsapp") || s.includes("wa ")) return "whatsapp";
  if (s.includes("website") || s.includes("organic") || s.includes("web")) return "website";
  if (s.includes("linkedin")) return "linkedin";
  if (s.includes("referral")) return "referral";
  if (s.includes("campaign")) return "campaign";
  if (s.includes("landing")) return "landing_page";
  if (s.includes("manual")) return "manual";
  if (s.includes("n8n") || s.includes("webhook") || s.includes("zapier")) return "n8n";
  if (s.includes("callyzer")) return "callyzer";
  if (s.includes("api")) return "api";
  return s.replace(/\s+/g, "_");
}

function dig(obj, ...keys) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of keys) {
    const val = obj[key];
    if (val != null && String(val).trim()) return String(val).trim();
  }
  return null;
}

function parseMeta(value) {
  if (value && typeof value === "object") return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

/** Frontend isSeedOrDemoLead - demo / test rows never count as a source. */
function isSeedOrDemoLead(lead) {
  if (!lead) return true;
  if (lead.is_demo || lead.isDemo || lead.is_seed || lead.isSeed) return true;
  const idStr = String(lead.id || "").toLowerCase();
  if (idStr.startsWith("seed-") || idStr.startsWith("mock-") || idStr.startsWith("demo-") || idStr.startsWith("test-")) return true;
  const assignedBy = String(lead.assigned_by || lead.assignedBy || "").toLowerCase();
  if (assignedBy === "seed" || assignedBy === "demo" || assignedBy === "mock") return true;
  const meta = parseMeta(lead.sourceMeta || lead.source_meta);
  if (meta.isSeed || meta.is_seed || meta.isDemo || meta.is_demo || meta.dummy || meta.isMock) return true;
  const name = String(lead.lead_name || lead.leadName || lead.name || "").toLowerCase();
  if (name.includes("demo") || name.includes("test lead") || name.includes("sample lead") || name.includes("dummy") || name.includes("mock lead")) return true;
  const email = String(lead.email || "").toLowerCase();
  if (email.endsWith("@example.com") || email.endsWith("@test.com") || email.endsWith("@demo.com") || email.includes("dummy") || email.includes("test")) return true;
  const phone = String(lead.phone || lead.phone_number || "").replace(/\D/g, "");
  if (phone.startsWith("9190000") || phone.startsWith("90000") || phone.startsWith("00000") || phone.startsWith("12345")
    || phone === "1234567890" || phone === "9876543210" || phone === "9999999999") return true;
  return false;
}

/** Frontend resolveLeadSourceKey. */
function resolveLeadSourceKey(lead) {
  if (!lead) return "other";
  const meta = parseMeta(lead.sourceMeta || lead.source_meta);
  const raw = meta.rawPayload || meta.raw_payload || meta;
  const candidates = [
    meta.channel, meta.platform, meta.utm_source, meta.source,
    dig(raw, "channel", "platform", "utm_source", "source", "lead_source"),
    lead.source, lead.form_name, lead.formName, lead.keyword,
  ].filter(Boolean);
  for (const value of candidates) {
    const key = normalizeSourceKey(value);
    if (key === "n8n") continue;
    if (key) return key;
  }
  const dbSource = normalizeSourceKey(lead.source);
  if (dbSource && dbSource !== "n8n") return dbSource;
  return "n8n";
}

/** Frontend isSourceDashboardLead, extended with the custom sources the admin created. */
function isSourceDashboardLead(lead, customKeys = new Set()) {
  if (!lead || isSeedOrDemoLead(lead)) return false;
  const rawSource = String(lead.source || parseMeta(lead.sourceMeta || lead.source_meta).integration || "").toLowerCase();
  if (rawSource.includes("callyzer")) return false;
  const key = resolveLeadSourceKey(lead);
  if (EXCLUDED_SOURCE_KEYS.has(key)) return false;
  if (!MARKETING_SOURCE_KEYS.has(key) && !customKeys.has(key)) return false;
  if (key === "manual") {
    const meta = parseMeta(lead.sourceMeta || lead.source_meta);
    if (!meta.channel) return false;
  }
  return true;
}

const titleCase = (key) => key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** key for a typed source name: the same normalisation every lead goes through. */
function sourceKeyForLabel(label) {
  return normalizeSourceKey(String(label || ""));
}

/** Validate + clean a source name typed by a person. Returns { ok, label?, key?, reason? }. */
function validateSourceLabel(raw) {
  const label = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (label.length < 2) return { ok: false, reason: "Source name must be at least 2 characters." };
  if (label.length > 40) return { ok: false, reason: "Source name must be 40 characters or fewer." };
  if (!/^[\p{L}\p{N}][\p{L}\p{N} &.\-/+']*$/u.test(label)) return { ok: false, reason: "Use letters, numbers and spaces only." };
  const key = sourceKeyForLabel(label);
  if (!key || RESERVED_KEYS.has(key)) return { ok: false, reason: "That name is reserved for a system channel." };
  return { ok: true, label, key };
}

/**
 * The sources the admin Sources page shows.
 * @param {object[]} leads   DB lead rows (source, form_name, keyword, source_meta, lead_name, email, phone, created_at, id, assigned_by)
 * @param {{ dismissed?: object, customSources?: {key,label}[] }} opts  settings.dismissedSources / settings.customSources
 * @returns {{ key, label, leadCount, custom }[]} catalog order first, then the rest by lead count
 */
function listLeadSources(leads = [], { dismissed = {}, customSources = [] } = {}) {
  const custom = (Array.isArray(customSources) ? customSources : []).filter((c) => c && c.key && c.label);
  const customKeys = new Set(custom.map((c) => c.key));
  const customLabel = new Map(custom.map((c) => [c.key, c.label]));
  const groups = new Map();
  const ensure = (key) => {
    if (!groups.has(key)) groups.set(key, { key, label: customLabel.get(key) || CATALOG_LABELS[key] || titleCase(key), leadCount: 0, latestMs: 0, custom: customKeys.has(key) });
    return groups.get(key);
  };
  for (const lead of Array.isArray(leads) ? leads : []) {
    if (!isSourceDashboardLead(lead, customKeys)) continue;
    const g = ensure(resolveLeadSourceKey(lead));
    g.leadCount += 1;
    const ms = new Date(lead.createdAt || lead.created_at || 0).getTime();
    if (Number.isFinite(ms) && ms > g.latestMs) g.latestMs = ms;
  }
  // a custom source is on the page even before its first lead
  for (const c of custom) ensure(c.key);

  const out = [];
  for (const g of groups.values()) {
    const at = dismissed && dismissed[g.key] ? new Date(dismissed[g.key]).getTime() : null;
    // dismissed stays hidden only while every one of its leads predates the dismissal (frontend isSourceDismissed)
    if (at != null && !Number.isNaN(at) && g.latestMs <= at) continue;
    out.push({ key: g.key, label: g.label, leadCount: g.leadCount, custom: g.custom });
  }
  const order = Object.fromEntries(SOURCE_CATALOG.map((s, i) => [s.key, i]));
  return out.sort((a, b) => (order[a.key] ?? 999) - (order[b.key] ?? 999) || b.leadCount - a.leadCount || a.label.localeCompare(b.label));
}

/**
 * "+ Add new..." from any source dropdown. Decides what to do with a typed source name:
 *   { status: "invalid", reason }                 - rejected
 *   { status: "exists", source }                  - it is already one of the admin's sources (no duplicate is created)
 *   { status: "created", source, nextSettings }   - saved in settings.customSources (and un-dismissed), so the admin Sources page
 *                                                   shows it right away, before it has any lead
 * Pure: the caller loads the leads / settings and saves nextSettings.
 */
function planAddSource(rawLabel, { leads = [], settings = {}, now = new Date() } = {}) {
  const v = validateSourceLabel(rawLabel);
  if (!v.ok) return { status: "invalid", reason: v.reason };
  const current = listLeadSources(leads, { dismissed: settings.dismissedSources, customSources: settings.customSources });
  const hit = current.find((s) => s.key === v.key);
  if (hit) return { status: "exists", source: hit };

  const customSources = [...(Array.isArray(settings.customSources) ? settings.customSources : []).filter((c) => c && c.key !== v.key),
    { key: v.key, label: v.label, createdAt: new Date(now).toISOString() }];
  const dismissed = { ...(settings.dismissedSources || {}) };
  delete dismissed[v.key]; // creating it again brings back a card the admin had removed
  const nextSettings = { ...settings, customSources, dismissedSources: dismissed };
  const after = listLeadSources(leads, { dismissed, customSources });
  return { status: "created", source: after.find((s) => s.key === v.key) || { key: v.key, label: v.label, leadCount: 0, custom: true }, nextSettings };
}

module.exports = {
  planAddSource,
  SOURCE_CATALOG,
  MARKETING_SOURCE_KEYS,
  EXCLUDED_SOURCE_KEYS,
  normalizeSourceKey,
  isSeedOrDemoLead,
  resolveLeadSourceKey,
  isSourceDashboardLead,
  sourceKeyForLabel,
  validateSourceLabel,
  listLeadSources,
};
