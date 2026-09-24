/** Minimum connected call duration (seconds) counted as a conversation for KRA/incentives. */
const CALL_CONVERSATION_MIN_SEC = 120;
const CALL_CONVERSATION_LABEL = "2 min+";
const CALL_SHORT_LABEL = "< 2 min";

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
  return sec >= CALL_CONVERSATION_MIN_SEC;
}

function phonesMatchLoose(a, b) {
  const da = String(a || "").replace(/\D/g, "");
  const db = String(b || "").replace(/\D/g, "");
  if (!da || !db) return false;
  if (da === db) return true;
  return da.slice(-10) === db.slice(-10);
}

function isClientNoPickOutcome(outcome) {
  return /not connected|not pick|rejected|no answer|busy|unanswered|not answered/.test(
    String(outcome || "").toLowerCase(),
  );
}

function isOutboundCall(call = {}) {
  const durationSec = Number.isFinite(call.durationSec)
    ? call.durationSec
    : parseCallDurationSeconds(call.duration);
  if (durationSec < CALL_CONVERSATION_MIN_SEC && isClientNoPickOutcome(call.outcome)) {
    return true;
  }
  const direction = String(call.direction || "").toLowerCase();
  if (direction === "inbound" || direction === "in" || direction === "incoming") return false;
  if (direction === "outbound" || direction === "out" || direction === "outgoing") return true;
  const type = String(call.type || "").toLowerCase();
  if (type === "in" || type === "inbound" || type === "incoming") return false;
  return type === "out" || type === "outbound" || type === "outgoing" || type === "miss";
}

function isShortConnectedCall(call = {}) {
  const durationSec = Number.isFinite(call.durationSec)
    ? call.durationSec
    : parseCallDurationSeconds(call.duration);
  if (durationSec <= 0 || durationSec >= CALL_CONVERSATION_MIN_SEC) return false;
  if (!isOutboundCall(call)) return false;
  return !isNotPickupByClientCall(call);
}

function isNotPickupByClientCall(call = {}) {
  const durationSec = Number.isFinite(call.durationSec)
    ? call.durationSec
    : parseCallDurationSeconds(call.duration);
  if (durationSec >= CALL_CONVERSATION_MIN_SEC) return false;
  if (!isOutboundCall(call)) return false;
  if (durationSec <= 0) return true;
  return isClientNoPickOutcome(call.outcome);
}

function isMissedCall(call = {}) {
  if (isNotPickupByClientCall(call)) return true;
  if (call.type === "miss") return true;
  const outcome = String(call.outcome || "").toLowerCase();
  if (/not connected|not pick|missed|rejected|no answer|busy|unanswered|not answered/.test(outcome)) {
    return true;
  }
  const durationSec = Number.isFinite(call.durationSec)
    ? call.durationSec
    : parseCallDurationSeconds(call.duration);
  if (durationSec >= CALL_CONVERSATION_MIN_SEC) return false;
  return durationSec <= 0;
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
  CALL_CONVERSATION_MIN_SEC,
  CALL_CONVERSATION_LABEL,
  CALL_SHORT_LABEL,
  parseCallDurationSeconds,
  isConversationCall,
  phonesMatchLoose,
  isOutboundCall,
  isShortConnectedCall,
  isNotPickupByClientCall,
  isMissedCall,
  dedupePeriodCalls,
};
