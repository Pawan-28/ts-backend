// Finds UTM / SOP values in a lead's source_meta (or an inbound webhook body) whatever
// way the sender spelled or nested them: utm_source, utmSource, "UTM Source", "utm-source",
// { utm: { source } }, { body: { utm_source } }, { rawPayload: {...} }, sop_id, sopCode, …
const FIELD_KEYS = {
  utm_source: ["utmsource", "utmsrc", "utmsite"],
  utm_medium: ["utmmedium", "utmchannel"],
  // Meta / Google lead-ad exports use campaign_name, adset_name, ad_name instead of utm_*.
  utm_campaign: ["utmcampaign", "utmcampaignname", "campaignname", "campaign"],
  utm_term: ["utmterm", "utmkeyword", "adsetname", "keyword", "searchterm"],
  utm_content: ["utmcontent", "utmadcontent", "adname", "adcontent", "creative"],
  sopId: ["sopid", "sopcode", "sopno", "sopnumber", "sopref", "sopcodeid"],
};
const UTM_GROUP_KEYS = { utm_source: "source", utm_medium: "medium", utm_campaign: "campaign", utm_term: "term", utm_content: "content" };
const NESTED_KEYS = ["body", "data", "json", "payload", "rawpayload", "query", "params", "lead", "fields", "utm", "utms", "utmparams", "tracking", "attribution", "meta", "sourcemeta"];

const normKey = (k) => String(k || "").toLowerCase().replace(/[^a-z0-9]/g, "");

function cleanValue(v) {
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return "";
  const s = String(v).trim();
  // Empty-ish values and unresolved n8n expressions ("{{ $json.utm_source }}") count as missing.
  if (!s || /^[.\-–—_]+$/.test(s) || /^(null|undefined|none|n\/a|na)$/i.test(s) || /^\{\{.*\}\}$/.test(s) || /^=\{\{/.test(s)) return "";
  return s;
}

function parseObj(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  if (typeof value === "string" && /^\s*[{[]/.test(value)) {
    try { return JSON.parse(value); } catch { return null; }
  }
  return null;
}

function findIn(obj, field, depth, inUtmGroup) {
  if (!obj || typeof obj !== "object" || depth > 4) return "";
  const wanted = FIELD_KEYS[field];
  const entries = Object.entries(obj);
  for (const [k, v] of entries) {
    const nk = normKey(k);
    if (wanted.includes(nk) || (inUtmGroup && UTM_GROUP_KEYS[field] === nk)) {
      const val = cleanValue(v);
      if (val) return val;
    }
  }
  for (const [k, v] of entries) {
    const nk = normKey(k);
    if (!NESTED_KEYS.includes(nk)) continue;
    const child = parseObj(v);
    if (!child) continue;
    const hit = findIn(Array.isArray(child) ? child[0] : child, field, depth + 1, nk.startsWith("utm"));
    if (hit) return hit;
  }
  return "";
}

/** One field: "utm_source" | "utm_medium" | "utm_campaign" | "utm_term" | "utm_content" | "sopId". */
function findLeadMetaValue(...sources) {
  const field = sources.pop();
  for (const src of sources) {
    const obj = parseObj(src);
    const hit = findIn(obj, field, 0, false);
    if (hit) return hit;
  }
  return "";
}

/** All five UTMs + sopId ("" when absent). */
function extractTracking(...sources) {
  const out = {};
  for (const field of Object.keys(FIELD_KEYS)) out[field] = findLeadMetaValue(...sources, field);
  return out;
}

// Sources that say nothing about the marketing channel — never used as a UTM Source fallback.
const NON_CHANNEL_SOURCES = new Set(["n8n", "manual", "api", "callyzer", "bulk_upload", "webhook", "website", "third_party", "form", "unknown", "sheet"]);

/** Fills a blank utm_source from the lead's own ad channel (e.g. meta_ads) so the field is never empty
 *  for ad leads whose sender did not pass UTM params. Real UTM values always win. */
function withUtmSourceFallback(tracking, lead, meta) {
  if (tracking.utm_source) return tracking;
  const candidates = [meta?.channel, meta?.source, meta?.platform, lead?.source];
  for (const c of candidates) {
    const v = cleanValue(c);
    if (v && !NON_CHANNEL_SOURCES.has(v.toLowerCase())) return { ...tracking, utm_source: v };
  }
  return tracking;
}

module.exports = { findLeadMetaValue, extractTracking, cleanValue, withUtmSourceFallback };
