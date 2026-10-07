/** Short Call = answered talk time of 1-120 s INCLUSIVE; Conversation = answered talk time ABOVE 120 s. */
const CALL_SHORT_MAX_SEC = 120;
/** First whole second that counts as a Conversation (121 s). Used for 'duration greater than' API filters. */
const CALL_CONVERSATION_MIN_SEC = CALL_SHORT_MAX_SEC + 1;
const CALL_CONVERSATION_LABEL = "> 2 min";
const CALL_SHORT_LABEL = "≤ 2 min";

function parseCallDurationSeconds(durationStr) {
  if (durationStr == null || durationStr === "—") return 0;
  if (typeof durationStr === "number") return durationStr;
  const raw = String(durationStr).trim();
  if (!raw) return 0;
  if (raw.includes(":")) {
    const parts = raw.split(":").map((p) => parseInt(p, 10) || 0);
    if (parts.length >= 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function isConversationCall(durationOrSec) {
  const sec =
    typeof durationOrSec === "number"
      ? durationOrSec
      : parseCallDurationSeconds(durationOrSec);
  return sec > CALL_SHORT_MAX_SEC;
}

function phonesMatchLoose(a, b) {
  const da = String(a || "").replace(/\D/g, "");
  const db = String(b || "").replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;
  return da.slice(-10) === db.slice(-10);
}

/* ───────────────────────────── CALL CLASSIFICATION — THE ONE DEFINITION ─────────────────────────────
 * (Product-owner decision.) The same definitions are used in Backend, Frontend, Dashboard, Call Reporting,
 * Pipeline and Incentives/KRA. Every call lands in exactly ONE bucket:
 *
 *   conversation     answered call, talk ABOVE 2 min (> 120 s), any direction
 *   short            answered OUTBOUND call, talk 1-120 s (exactly 120 s is still Short)
 *   incoming_short   answered INCOMING call, talk 1-120 s  (own bucket: counts as CONNECTED, not Short, not Not pick)
 *   no_pickup        OUTBOUND call the client did not answer ("Not pick")           - Rejected is NOT inside it
 *   rejected         rejected call                                                  - never inside Not pick
 *   missed_incoming  INCOMING call that was not answered ("Missed")
 *
 *   Total calls   = Conversation + Short + Incoming short + Not pick + Rejected + Missed (incoming)
 *   Connected     = Conversation + Short + Incoming short
 *   Not connected = Not pick + Rejected + Missed (incoming)
 *
 * NO substring / regex guessing of free text. The rule is EXACT lookups of the NORMALIZED outcome
 * (lower-case, trim, "_" and "-" -> space, collapse spaces) in the explicit sets below, plus direction,
 * plus duration:
 *   1. talk > 120 s                                   -> conversation (an unanswered call cannot last 2 min)
 *   2. outcome in REJECTED set                        -> rejected
 *   3. talk > 0 and outcome NOT in any unanswered set -> answered (outcome "Connected", "Discovery complete",
 *                                                        or any unknown outcome that carries talk time):
 *                                                        outbound -> short, inbound -> incoming_short
 *   4. otherwise it is unanswered: inbound and outcome not in NOT_CONNECTED set -> missed_incoming,
 *                                                        else -> no_pickup
 *      ("Not Connected" is an unanswered OUTBOUND dial even when the row is tagged inbound (legacy) or carries
 *       1-5 s of ring time; an unknown outcome with 0 s is classified by direction only.)
 * An outcome that merely CONTAINS a keyword ("not connected - callback requested", "Rejected by IVR note") is NOT
 * in a set, so it falls through to the duration/direction rule - by design.
 *
 * Direction: "in" / "inbound" / "incoming" = inbound, everything else = outbound. "Outbound dials" (the pickup
 * denominator) = every outbound-direction call + every no_pickup call (legacy rows tagged inbound).
 * PICKUP RATE (one definition everywhere): answered OUTBOUND calls (conversation or short with direction
 * outbound) / OUTBOUND dials. Calls and DISTINCT LEADS are always counted separately.
 *
 * Mirrors: callSqlExprs() below (SQL twin used by employeeCallStats / dashboards / team) and
 * frontend/src/lib/callMetrics.js. KEEP ALL THREE IN SYNC; backend/src/utils/callPartition.test.js and
 * frontend/src/lib/callMetrics.parity.test.mjs prove they agree, scripts/verify-call-partition.js proves JS == SQL.
 */
const OUTCOME_NOT_CONNECTED = [
  "not connected", "not pick", "not picked", "not pickup", "not picked up",
  "no answer", "no pickup", "not answered", "unanswered", "busy",
];
const OUTCOME_MISSED = ["missed", "missed call", "missed incoming", "never attended"];
const OUTCOME_REJECTED = ["rejected", "call rejected", "declined"];
const NOT_CONNECTED_OUTCOMES = new Set(OUTCOME_NOT_CONNECTED);
const MISSED_OUTCOMES = new Set(OUTCOME_MISSED);
const REJECTED_OUTCOMES = new Set(OUTCOME_REJECTED);
const UNANSWERED_OUTCOMES = new Set([...OUTCOME_NOT_CONNECTED, ...OUTCOME_MISSED, ...OUTCOME_REJECTED]);
const INBOUND_DIRECTIONS = new Set(["in", "inbound", "incoming"]);

const CALL_BUCKETS = ["conversation", "short", "incoming_short", "no_pickup", "missed_incoming", "rejected"];
const CALL_BUCKET_LABELS = {
  conversation: `Conversation (${CALL_CONVERSATION_LABEL})`,
  short: `Short call (${CALL_SHORT_LABEL})`,
  incoming_short: `Incoming short (${CALL_SHORT_LABEL})`,
  no_pickup: "Not pick",
  missed_incoming: "Missed (incoming)",
  rejected: "Rejected",
};

/** lower-case, trim, "_" and "-" -> space, collapse spaces. SQL twin: callSqlExprs().outcomeNorm. */
function normalizeCallOutcome(value) {
  return String(value == null ? "" : value).toLowerCase().replace(/[_-]/g, " ").replace(/\s+/g, " ").trim();
}

function callDurationSec(call = {}) {
  return Number.isFinite(call.durationSec)
    ? call.durationSec
    : parseCallDurationSeconds(call.duration);
}

/** @returns {"inbound"|"outbound"} raw direction (falls back to the UI `type` only when `direction` is blank). */
function callDirection(call = {}) {
  const raw = String(call.direction == null ? "" : call.direction).toLowerCase().trim();
  if (raw) return INBOUND_DIRECTIONS.has(raw) ? "inbound" : "outbound";
  const type = String(call.type == null ? "" : call.type).toLowerCase().trim();
  return INBOUND_DIRECTIONS.has(type) ? "inbound" : "outbound";
}

/** @returns {"conversation"|"short"|"incoming_short"|"no_pickup"|"missed_incoming"|"rejected"} */
function callBucket(call = {}) {
  const sec = callDurationSec(call);
  if (sec > CALL_SHORT_MAX_SEC) return "conversation";
  const outcome = normalizeCallOutcome(call.outcome);
  if (REJECTED_OUTCOMES.has(outcome)) return "rejected";
  const inbound = callDirection(call) === "inbound";
  if (sec > 0 && !UNANSWERED_OUTCOMES.has(outcome)) return inbound ? "incoming_short" : "short";
  if (inbound && !NOT_CONNECTED_OUTCOMES.has(outcome)) return "missed_incoming";
  return "no_pickup";
}

/** Answered call (conversation, short or incoming short). */
function isConnectedCall(call = {}) {
  const b = callBucket(call);
  return b === "conversation" || b === "short" || b === "incoming_short";
}

function isRejectedCall(call = {}) {
  return callBucket(call) === "rejected";
}

/** Answered OUTBOUND call of 1-120 s (the lead-stage "Short Call" rule). */
function isShortConnectedCall(call = {}) {
  return callBucket(call) === "short";
}

/** Answered INCOMING call of 1-120 s. */
function isIncomingShortCall(call = {}) {
  return callBucket(call) === "incoming_short";
}

/** OUTBOUND call the client did not answer ("Not pick"). Rejected is NOT included. */
/**
 * A dial the CUSTOMER rejected (Rejected outcome on an OUTBOUND call). For the Pipeline COLUMN this counts as
 * "Not Pick" - the customer did not take the call. In the call-category counts it stays its own bucket
 * ("Rejected"), separate from "Not pick" (the Pipeline column rule no longer depends on direction - see isNotPickColumnCall).
 */
function isCustomerRejectedDial(call = {}) {
  return callBucket(call) === "rejected" && isOutboundCall(call);
}

/**
 * PIPELINE COLUMN RULES (direction does not matter - incoming and outgoing calls are treated the same):
 *   Not Pick   = every call that did NOT connect: not answered / not connected, missed, rejected
 *   Short Call = every ANSWERED call of 1-120 s (outgoing, or incoming = "Incoming short")
 *   Conversation = every answered call above 120 s
 * The call COUNTS keep their own categories (Short, Incoming short, Not pick, Missed, Rejected); only the column mapping is shared.
 */
function isNotPickColumnCall(call = {}) {
  const b = callBucket(call);
  return b === "no_pickup" || b === "missed_incoming" || b === "rejected";
}

/** Pipeline "Short Call" column rule: an answered call of 1-120 s, outgoing OR incoming. */
function isShortColumnCall(call = {}) {
  const b = callBucket(call);
  return b === "short" || b === "incoming_short";
}

function isNotPickupByClientCall(call = {}) {
  return callBucket(call) === "no_pickup";
}

/** Missed INCOMING call (unanswered inbound). Same as isMissedIncomingCall. */
function isMissedCall(call = {}) {
  return callBucket(call) === "missed_incoming";
}

const isMissedIncomingCall = isMissedCall;

/** Not connected, any reason: Not pick + Rejected + Missed (incoming). */
function isNotConnectedCall(call = {}) {
  return !isConnectedCall(call);
}

/** Outbound DIAL: outbound-direction call, or an unanswered dial legacy-tagged inbound. */
function isOutboundCall(call = {}) {
  return callDirection(call) === "outbound" || callBucket(call) === "no_pickup";
}

/** Answered outbound call (conversation or short, direction outbound): the pickup-rate numerator. */
function isAnsweredOutboundCall(call = {}) {
  const b = callBucket(call);
  return (b === "conversation" || b === "short") && callDirection(call) === "outbound";
}

/** ONE pickup-rate formula everywhere: answered outbound / outbound dials, whole percent. */
function pickupRatePct(answeredOutbound, outboundDials) {
  const den = Number(outboundDials) || 0;
  if (den <= 0) return 0;
  return Math.min(100, Math.round(((Number(answeredOutbound) || 0) / den) * 100));
}

function callContactKey(call = {}) {
  if (call.leadId != null && call.leadId !== "") return `id:${call.leadId}`;
  const phone = String(call.phone || call.clientPhone || "").replace(/\D/g, "").slice(-10);
  if (phone) return `phone:${phone}`;
  return `call:${call.id ?? ""}`;
}

/**
 * Partition + distinct-lead counts for a list of calls. Always:
 *   total === connected + notConnected
 *   connected === conversation + short + incomingShort
 *   notConnected === noPickup + missedIncoming + rejected
 *   outbound = outbound dials, inbound = the rest (total === inbound + outbound)
 */
function summarizeCalls(calls = []) {
  const list = Array.isArray(calls) ? calls : [];
  const FIELDS = ["total", "connected", "conversation", "short", "incomingShort", "notConnected", "noPickup", "missedIncoming", "rejected"];
  const out = {
    inbound: 0, outbound: 0, connectedOutbound: 0, talkSec: 0,
    leads: {},
  };
  const seen = {};
  for (const f of FIELDS) { out[f] = 0; out.leads[f] = 0; seen[f] = new Set(); }
  const BUCKET_KEY = {
    conversation: "conversation", short: "short", incoming_short: "incomingShort",
    no_pickup: "noPickup", missed_incoming: "missedIncoming", rejected: "rejected",
  };
  for (const call of list) {
    const bucket = callBucket(call);
    const key = callContactKey(call);
    const field = BUCKET_KEY[bucket];
    const connected = bucket === "conversation" || bucket === "short" || bucket === "incoming_short";
    const outbound = isOutboundCall(call);
    out.total += 1;
    out[field] += 1;
    seen.total.add(key);
    seen[field].add(key);
    if (connected) {
      out.connected += 1;
      out.talkSec += callDurationSec(call);
      seen.connected.add(key);
      if (isAnsweredOutboundCall(call)) out.connectedOutbound += 1;
    } else {
      out.notConnected += 1;
      seen.notConnected.add(key);
    }
    if (outbound) out.outbound += 1; else out.inbound += 1;
  }
  for (const k of FIELDS) out.leads[k] = seen[k].size;
  out.pickupRate = pickupRatePct(out.connectedOutbound, out.outbound);
  out.avgTalkSec = out.connected > 0 ? Math.round(out.talkSec / out.connected) : 0;
  return out;
}

/* ───────────────────────────── SQL twin of the classification ─────────────────────────────
 * `alias` is the employee_calls alias (default "ec"). Every expression is a boolean that is never NULL.
 * Exact IN-lookups on the normalized outcome - the same sets as above (no LIKE / REGEXP guessing of outcomes).
 */
function sqlList(values) {
  return values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(", ");
}

function callSqlExprs(alias = "ec") {
  const p = alias ? `${alias}.` : "";
  const dur = `COALESCE(${p}duration_sec, 0)`;
  const outcomeNorm = `TRIM(REGEXP_REPLACE(REPLACE(REPLACE(LOWER(COALESCE(${p}outcome, '')), '_', ' '), '-', ' '), '[[:space:]]+', ' '))`;
  const dirInbound = `LOWER(TRIM(COALESCE(${p}direction, ''))) IN (${sqlList([...INBOUND_DIRECTIONS])})`;
  const conversation = `(${dur} > ${CALL_SHORT_MAX_SEC})`;
  const rejected = `(NOT ${conversation} AND ${outcomeNorm} IN (${sqlList(OUTCOME_REJECTED)}))`;
  const unansweredOutcome = `${outcomeNorm} IN (${sqlList([...UNANSWERED_OUTCOMES])})`;
  const answeredBelow2 = `(NOT ${conversation} AND ${dur} > 0 AND NOT (${unansweredOutcome}))`;
  const short = `(${answeredBelow2} AND NOT (${dirInbound}))`;
  const incomingShort = `(${answeredBelow2} AND (${dirInbound}))`;
  const connected = `(${conversation} OR ${answeredBelow2})`;
  const notConnected = `(NOT ${connected})`;
  // unanswered and not rejected: missed_incoming when inbound and not a "Not Connected" outcome, else no_pickup
  const missedIncoming = `(${notConnected} AND NOT ${rejected} AND (${dirInbound}) AND NOT (${outcomeNorm} IN (${sqlList(OUTCOME_NOT_CONNECTED)})))`;
  const noPickup = `(${notConnected} AND NOT ${rejected} AND NOT ${missedIncoming})`;
  const outbound = `(NOT (${dirInbound}) OR ${noPickup})`;
  return {
    outcomeNorm,
    connected,
    notConnected,
    conversation,
    short,
    incomingShort,
    rejected,
    rejectedOutbound: `(${rejected} AND NOT (${dirInbound}))`,
    missedIncoming,
    noPickup,
    outbound,
    inbound: `(NOT ${outbound})`,
    connectedOutbound: `((${conversation} OR ${short}) AND NOT (${dirInbound}))`,
    durationSql: dur,
  };
}

/** Outcomes that mean no AI summary can be generated even when talk time was logged (exact set, normalized). */
const AI_SKIP_OUTCOMES = new Set(["failed", "cancelled", "canceled", "cancel"]);

/**
 * Why a call must NOT get an AI summary / MoM, or null when it may.
 * Accepts DB rows (duration_sec, recording_url, transcript) and API shapes (durationSec, recordingUrl, ...).
 */
function aiSummarySkipReason(call = {}) {
  const rawSec = call.durationSec ?? call.duration_sec;
  const durationSec = Number.isFinite(Number(rawSec)) && rawSec != null && rawSec !== ""
    ? Number(rawSec)
    : parseCallDurationSeconds(call.duration);
  const outcomeText = call.outcome || call.status || "";
  const normalized = { ...call, durationSec, outcome: outcomeText };
  if (!(durationSec > 0)) return "Call was not connected (duration 0:00) - no AI summary generated.";
  if (isNotConnectedCall(normalized) || AI_SKIP_OUTCOMES.has(normalizeCallOutcome(outcomeText))) {
    return "Call was not connected (missed / rejected / no answer) - no AI summary generated.";
  }
  const hasRecording = Boolean(String(call.recordingUrl ?? call.recording_url ?? "").trim());
  const hasTranscript = Boolean(String(call.transcript ?? "").trim());
  if (!hasRecording && !hasTranscript) {
    return "No recording or transcript is available for this call - no AI summary generated.";
  }
  return null;
}

/** True only for calls that actually connected (duration > 0) and have a recording or transcript to summarize. */
function shouldGenerateAiSummary(call = {}) {
  return aiSummarySkipReason(call) === null;
}

function dedupePeriodCalls(calls = []) {
  const list = Array.isArray(calls) ? calls : [];
  const seen = new Set();
  const out = [];
  for (const call of list) {
    const key = String(
      call?.callyzerCallId
      || call?.callyzer_call_id
      || call?.id
      || `${call?.phone || call?.clientPhone || ""}:${call?.startedAt || call?.callAt || call?.date || ""}:${call?.durationSec ?? ""}`,
    );
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(call);
  }
  return out;
}

module.exports = {
  CALL_SHORT_MAX_SEC,
  CALL_CONVERSATION_MIN_SEC,
  CALL_CONVERSATION_LABEL,
  CALL_SHORT_LABEL,
  parseCallDurationSeconds,
  isConversationCall,
  phonesMatchLoose,
  normalizeCallOutcome,
  callDirection,
  isOutboundCall,
  isAnsweredOutboundCall,
  isShortConnectedCall,
  isIncomingShortCall,
  isNotPickupByClientCall,
  isCustomerRejectedDial,
  isNotPickColumnCall,
  isShortColumnCall,
  isMissedCall,
  isNotConnectedCall,
  isMissedIncomingCall,
  isConnectedCall,
  isRejectedCall,
  callBucket,
  callDurationSec,
  callContactKey,
  pickupRatePct,
  summarizeCalls,
  callSqlExprs,
  NOT_CONNECTED_OUTCOMES,
  MISSED_OUTCOMES,
  REJECTED_OUTCOMES,
  UNANSWERED_OUTCOMES,
  INBOUND_DIRECTIONS,
  CALL_BUCKETS,
  CALL_BUCKET_LABELS,
  aiSummarySkipReason,
  shouldGenerateAiSummary,
  dedupePeriodCalls,
};
