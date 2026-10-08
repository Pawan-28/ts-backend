/**
 * EXTRA INFO - a SHORT, customer-level sales profile built from the AI analysis of call recordings.
 *
 * It is NOT the MOM (the MOM keeps the detailed per-call summary, SOP evaluation, action items ...). Extra Info is ONE record per
 * customer that is UPDATED over time as calls come in:
 *   - the AI returns an `extraInfo` object per connected call (same single Gemini call as the MOM - no second AI pipeline);
 *   - mergeExtraInfo() folds it into the customer's stored profile:
 *       a later "Not discussed" NEVER erases a known value;
 *       an explicit value replaces the old one when it comes from a call that is the same age or newer than the stored one;
 *       re-processing an OLD call can never overwrite something a NEWER call said;
 *   - the stored profile lives in leads.source_meta.extraInfo ({ fields: { key: { value, callId, at } }, updatedAt }) - no schema change.
 *
 * Fields NOT stored here (they have a verified CRM source of truth and are read live by the UI): Lead Temperature (lead.temperature),
 * and - when CRM data exists - Meeting (meetings table), Follow-up (follow-ups) and Conversion (pipeline stage / payment).
 */

const NOT_DISCUSSED = "Not discussed";
const UNKNOWN = "Unknown";

/** Stored AI fields, in display order. `kind` drives validation. */
const EXTRA_INFO_FIELDS = [
  { key: "business", label: "Business / Job", kind: "text" },
  { key: "interests", label: "Interests / Hobbies", kind: "text" },
  { key: "requirement", label: "Requirement", kind: "text" },
  { key: "intent", label: "Intent", kind: "enum", values: ["Interested", "Interested but delayed", "Considering", "Not Interested"] },
  { key: "budget", label: "Budget", kind: "text" },
  { key: "offerQuoted", label: "Offer / Price Quoted", kind: "text" },
  { key: "mainConcern", label: "Main Concern", kind: "text" },
  { key: "purchaseTimeline", label: "Purchase Timeline", kind: "text" },
  { key: "decisionMaker", label: "Decision Maker", kind: "text" },
  { key: "objection", label: "Objection", kind: "text" },
  { key: "nextAction", label: "Next Action", kind: "text" },
  { key: "followUp", label: "Follow-up", kind: "followUp" },
  { key: "meeting", label: "Meeting", kind: "enum", values: ["Required", "Booked", "Not required"] },
  { key: "conversion", label: "Conversion", kind: "enum", values: ["Converted", "Not converted", "Pending"] },
];
const FIELD_BY_KEY = new Map(EXTRA_INFO_FIELDS.map((f) => [f.key, f]));
const MAX_LEN = 500; // generous: a value is only cut when it is absurdly long

/** Values that mean "nothing was said" - never stored, never allowed to overwrite a known value. */
const EMPTY_PATTERNS = [
  /^$/, /^-+$/, /^n\/?a$/i, /^none$/i, /^null$/i, /^unknown$/i, /^not (discussed|mentioned|specified|stated|provided|available|applicable)\b/i,
  /^no (information|info|mention|details?)\b/i, /^nothing\b/i, /^not discussed on the call/i, /^no objections? (raised)?$/i,
];

function isEmptyValue(v) {
  if (v == null) return true;
  const s = String(v).replace(/\s+/g, " ").trim();
  return EMPTY_PATTERNS.some((re) => re.test(s));
}

const clean = (v) => String(v).replace(/\s+/g, " ").replace(/^[\s•\-*]+/, "").trim().slice(0, MAX_LEN);

function matchEnum(raw, values) {
  const s = String(raw).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return values.find((v) => v.toLowerCase() === s) || null;
}

/**
 * Normalise ONE field value coming from the AI. Returns the clean value or null (= nothing reliable / not discussed).
 * followUp is { needed: "Yes" | "No", when?: string } or null.
 */
function normalizeFieldValue(field, raw) {
  if (raw == null) return null;
  if (field.kind === "followUp") {
    const obj = typeof raw === "object" ? raw : { needed: raw };
    const needed = matchEnum(obj.needed ?? obj.required ?? obj.value ?? "", ["Yes", "No"]);
    if (!needed) return null;
    const when = isEmptyValue(obj.when ?? obj.date ?? "") ? "" : clean(obj.when ?? obj.date);
    return when ? { needed, when } : { needed };
  }
  if (typeof raw === "object") return null;
  if (isEmptyValue(raw)) return null;
  if (field.kind === "enum") return matchEnum(raw, field.values);
  const s = clean(raw);
  return s && !isEmptyValue(s) ? s : null;
}

/** AI `extraInfo` object -> { key: value } with only the fields that carry a reliable value. */
function normalizeExtraInfo(raw) {
  const out = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const field of EXTRA_INFO_FIELDS) {
    const v = normalizeFieldValue(field, raw[field.key]);
    if (v != null) out[field.key] = v;
  }
  return out;
}

const tsOf = (at) => {
  const t = at instanceof Date ? at.getTime() : Date.parse(at);
  return Number.isFinite(t) ? t : 0;
};

/**
 * Fold one call's extraInfo into the customer's stored profile.
 * @param {object|null} stored   leads.source_meta.extraInfo (or null)
 * @param {object} incoming      AI extraInfo for ONE call (any shape - it is normalised here)
 * @param {{callId: any, at: string|Date}} meta  the call it came from and when that call happened
 * @returns {{ fields: object, updatedAt: string, changed: string[] }} new profile (input is not mutated)
 */
function mergeExtraInfo(stored, incoming, { callId = null, at = new Date() } = {}) {
  const fields = { ...((stored && stored.fields) || {}) };
  const norm = normalizeExtraInfo(incoming);
  const changed = [];
  const incomingAt = tsOf(at) || Date.now();
  for (const [key, value] of Object.entries(norm)) {
    const prev = fields[key];
    // keep what a NEWER call already said (re-processing an old call must not roll the profile back)
    if (prev && tsOf(prev.at) > incomingAt) continue;
    if (prev && JSON.stringify(prev.value) === JSON.stringify(value)) {
      if (tsOf(prev.at) < incomingAt) fields[key] = { ...prev, callId, at: new Date(incomingAt).toISOString() };
      continue;
    }
    fields[key] = { value, callId, at: new Date(incomingAt).toISOString() };
    changed.push(key);
  }
  return { fields, updatedAt: new Date().toISOString(), changed };
}

/** Plain { key: value } view of a stored profile. */
function storedValues(stored) {
  const out = {};
  for (const [k, v] of Object.entries((stored && stored.fields) || {})) if (v && v.value != null) out[k] = v.value;
  return out;
}

/** Prompt block that is added to the EXISTING MoM prompt (one Gemini call). */
function extraInfoPromptBlock() {
  return `7. "extraInfo": a SHORT customer sales profile from THIS call only. Every value must be stated in the transcript; NEVER guess. If a field was not discussed, return "Not discussed" (for "intent" return "Unknown" when unclear). Keep each value under 12 words, in English. Keys:
   - "business": the customer's own business, profession or job, only if they said it, else "Not discussed"
   - "interests": the customer's personal interests / hobbies, only if they said them, else "Not discussed"
   - "requirement": what the customer is looking for / discussing
   - "intent": exactly one of "Interested", "Interested but delayed", "Considering", "Not Interested", "Unknown"
   - "budget": the customer's actual budget only if said (with the exact figure), else "Not discussed"
   - "offerQuoted": the actual price / package the rep quoted, else "Not discussed"
   - "mainConcern": the customer's biggest current blocker / concern, else "Not discussed"
   - "purchaseTimeline": only if the customer or rep said when they will decide / buy, else "Not discussed"
   - "decisionMaker": who is involved in the purchase decision, else "Not discussed"
   - "objection": the main sales objection, else "Not discussed"
   - "nextAction": the most important next step agreed on the call, else "Not discussed"
   - "followUp": { "needed": "Yes" | "No", "when": "<exact date/time only if explicitly said, else empty string>" } or "Not discussed"
   - "meeting": exactly one of "Required", "Booked", "Not required", "Not discussed"
   - "conversion": exactly one of "Converted", "Not converted", "Pending"  ("Converted" ONLY if payment / purchase is confirmed on the call)
   Do NOT copy MoM text, transcript lines, the SOP evaluation, rep performance or call duration into extraInfo.`;
}

// Placeholders only - real example values would be copied by the model.
const EXTRA_INFO_JSON_EXAMPLE = `  "extraInfo": {
    "business": "<their business / profession / job if said, else Not discussed>",
    "interests": "<their interests / hobbies if said, else Not discussed>",
    "requirement": "<from the transcript, or Not discussed>",
    "intent": "<Interested | Interested but delayed | Considering | Not Interested | Unknown>",
    "budget": "<exact figure if said, else Not discussed>",
    "offerQuoted": "<exact price/package if quoted, else Not discussed>",
    "mainConcern": "<from the transcript, or Not discussed>",
    "purchaseTimeline": "<only if said, else Not discussed>",
    "decisionMaker": "<only if said, else Not discussed>",
    "objection": "<from the transcript, or Not discussed>",
    "nextAction": "<agreed next step, or Not discussed>",
    "followUp": { "needed": "<Yes | No>", "when": "<exact date/time only if said, else empty>" },
    "meeting": "<Required | Booked | Not required | Not discussed>",
    "conversion": "<Converted | Not converted | Pending>"
  },`;

module.exports = {
  NOT_DISCUSSED,
  UNKNOWN,
  EXTRA_INFO_FIELDS,
  FIELD_BY_KEY,
  isEmptyValue,
  normalizeFieldValue,
  normalizeExtraInfo,
  mergeExtraInfo,
  storedValues,
  extraInfoPromptBlock,
  EXTRA_INFO_JSON_EXAMPLE,
};
