const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const M = require("./callMetrics");
const { mapCallStatsRow } = require("./employeeCallStats");
const { callKanbanColumn } = require("./leadKanban");

/**
 * The call metric definitions (utils/callMetrics.js - the ONE shared definition) must be a clean PARTITION:
 *   total = connected + notConnected
 *   connected = conversation + short + incomingShort
 *   notConnected = noPickup + rejected + missedIncoming
 */
function assertPartition(s, label = "") {
  assert.equal(s.total, s.connected + s.notConnected, `${label} total = connected + notConnected`);
  assert.equal(s.connected, s.conversation + s.short + s.incomingShort, `${label} connected = conversation + short + incomingShort`);
  assert.equal(s.notConnected, s.noPickup + s.missedIncoming + s.rejected, `${label} notConnected = noPickup + missed + rejected`);
  assert.equal(
    s.total,
    s.conversation + s.short + s.incomingShort + s.noPickup + s.rejected + s.missedIncoming,
    `${label} total = the six buckets`,
  );
  assert.equal(s.total, s.inbound + s.outbound, `${label} total = inbound + outbound`);
  assert.ok(s.leads.total <= s.total, `${label} distinct leads never exceed calls`);
  for (const k of ["connected", "conversation", "short", "incomingShort", "notConnected", "noPickup", "missedIncoming", "rejected"]) {
    assert.ok(s.leads[k] <= s[k], `${label} ${k}: ${s.leads[k]} leads <= ${s[k]} calls`);
  }
}

// Synthetic calls covering every case seen in the data (incl. the ones that used to fall through the cracks).
const SYNTHETIC = [
  // Answered, outbound
  { id: 1, leadId: 10, direction: "outbound", outcome: "Connected", durationSec: 400 }, // conversation
  { id: 2, leadId: 10, direction: "outbound", outcome: "Connected", durationSec: 121 }, // conversation (boundary: first second above 120)
  { id: 3, leadId: 11, direction: "outbound", outcome: "Connected", durationSec: 120 }, // short (boundary: exactly 120 s is still Short)
  { id: 4, leadId: 11, direction: "outbound", outcome: "Connected", durationSec: 3 }, // short
  // Answered, INBOUND under 2 min: its own bucket (incoming_short) - not Short, not Not pick
  { id: 5, leadId: 12, direction: "inbound", outcome: "Connected", durationSec: 45 },
  { id: 6, leadId: 13, direction: "inbound", outcome: "Connected", durationSec: 300 }, // inbound conversation
  // Not connected
  { id: 7, leadId: 14, direction: "outbound", outcome: "Not Connected", durationSec: 0 }, // not pick
  { id: 8, leadId: 14, direction: "outbound", outcome: "Not Connected", durationSec: 5 }, // ring time only -> NOT connected
  { id: 9, leadId: 15, direction: "inbound", outcome: "Not Connected", durationSec: 0 }, // legacy mis-tag -> outbound not pick, NOT missed
  { id: 10, leadId: 16, direction: "inbound", outcome: "Missed", durationSec: 0 }, // missed incoming
  { id: 11, leadId: 16, direction: "inbound", outcome: "Missed", durationSec: 0 }, // missed incoming (same lead)
  { id: 12, leadId: 17, direction: "outbound", outcome: "Rejected", durationSec: 0 }, // rejected (NOT not pick)
  { id: 13, leadId: null, phone: "+91 98765 43210", direction: "outbound", outcome: "Call logged", durationSec: 0 }, // unknown outcome, 0 s -> not pick
  { id: 14, leadId: null, phone: "9876543210", direction: "outbound", outcome: "Not Connected", durationSec: 0 }, // same number as 13
  { id: 15, leadId: 18, direction: "outbound", outcome: "Discovery complete", durationSec: 30 }, // custom outcome, talked -> short
  // duration strings (mock/frontend shape)
  { id: 16, leadId: 19, direction: "outbound", outcome: "Connected", duration: "2:30" },
  { id: 17, leadId: 19, direction: "outbound", outcome: "Not Connected", duration: "—" },
  // outcomes that merely CONTAIN a keyword are NOT matched by substring
  { id: 18, leadId: 20, direction: "outbound", outcome: "not connected - callback requested", durationSec: 30 }, // not in a set -> short
  { id: 19, leadId: 21, direction: "outbound", outcome: "Rejected by IVR note", durationSec: 0 }, // not in a set -> not pick
  // normalisation: case, underscores, hyphens, extra spaces
  { id: 20, leadId: 22, direction: "outbound", outcome: "  NOT_connected ", durationSec: 0 }, // -> not pick
  { id: 21, leadId: 23, direction: "inbound", outcome: "never-attended", durationSec: 0 }, // -> missed incoming
];

test("synthetic calls: buckets sum to the total", () => {
  const s = M.summarizeCalls(SYNTHETIC);
  assertPartition(s, "synthetic");
  assert.equal(s.total, 21);
  assert.equal(s.conversation, 4); // ids 1,2,6,16
  assert.equal(s.short, 4); // ids 3,4,15,18
  assert.equal(s.incomingShort, 1); // id 5
  assert.equal(s.connected, 9);
  assert.equal(s.rejected, 1); // id 12
  assert.equal(s.missedIncoming, 3); // ids 10, 11, 21
  assert.equal(s.noPickup, 8); // ids 7,8,9,13,14,17,19,20
  assert.equal(s.notConnected, 12);
});

test("calls vs distinct leads are different units", () => {
  const s = M.summarizeCalls(SYNTHETIC);
  assert.equal(s.leads.conversation, 3); // leads 10, 13, 19
  assert.equal(s.leads.missedIncoming, 2); // leads 16, 23
  assert.equal(s.leads.incomingShort, 1);
});

test("unknown-lead rows are de-duplicated by phone number (last 10 digits)", () => {
  const s = M.summarizeCalls(SYNTHETIC.filter((c) => c.id === 13 || c.id === 14));
  assert.equal(s.noPickup, 2);
  assert.equal(s.leads.noPickup, 1);
});

/* ───────────── exact-match behaviour (no substring / regex guessing) ───────────── */

const b = (direction, outcome, durationSec) => M.callBucket({ direction, outcome, durationSec });

test('outcome "Discovery complete" with 30 s is a short answered call', () => {
  assert.equal(b("outbound", "Discovery complete", 30), "short");
  assert.equal(b("outbound", "Discovery complete", 150), "conversation");
});

test('"Not Connected" with direction inbound is a Not pick (outbound dial), NOT a missed incoming', () => {
  assert.equal(b("inbound", "Not Connected", 0), "no_pickup");
  assert.equal(b("inbound", "Not Connected", 5), "no_pickup"); // ring time only
  assert.equal(M.isOutboundCall({ direction: "inbound", outcome: "Not Connected", durationSec: 0 }), true);
  assert.equal(M.isMissedCall({ direction: "inbound", outcome: "Not Connected", durationSec: 0 }), false);
});

test('outbound "Rejected" is rejected, NOT a Not pick', () => {
  assert.equal(b("outbound", "Rejected", 0), "rejected");
  assert.equal(M.isNotPickupByClientCall({ direction: "outbound", outcome: "Rejected", durationSec: 0 }), false);
  assert.equal(M.isRejectedCall({ direction: "outbound", outcome: "Rejected", durationSec: 0 }), true);
  assert.equal(M.callSqlExprs("ec").rejected.includes("rejected"), true);
});

test('inbound "Missed" is a missed incoming call', () => {
  assert.equal(b("inbound", "Missed", 0), "missed_incoming");
  assert.equal(M.isMissedCall({ direction: "inbound", outcome: "Missed", durationSec: 0 }), true);
  assert.equal(b("inbound", "Never Attended", 0), "missed_incoming");
  // an outbound row tagged "Missed" is an unanswered outbound dial, not a missed INCOMING call
  assert.equal(b("outbound", "Missed", 0), "no_pickup");
});

test('inbound "Connected" 45 s is an incoming short (own bucket, connected, not Short)', () => {
  assert.equal(b("inbound", "Connected", 45), "incoming_short");
  const c = { direction: "inbound", outcome: "Connected", durationSec: 45 };
  assert.equal(M.isConnectedCall(c), true);
  assert.equal(M.isShortConnectedCall(c), false);
  assert.equal(M.isIncomingShortCall(c), true);
  assert.equal(M.isNotPickupByClientCall(c), false);
});

test('unknown outcome "Foo" with 0 s outbound is a Not pick; with talk time it is answered', () => {
  assert.equal(b("outbound", "Foo", 0), "no_pickup");
  assert.equal(b("outbound", "Foo", 40), "short");
  assert.equal(b("inbound", "Foo", 0), "missed_incoming");
  assert.equal(b("inbound", "Foo", 40), "incoming_short");
  assert.equal(b("outbound", null, 0), "no_pickup");
  assert.equal(b("outbound", "", 90), "short");
});

test("an outcome that merely CONTAINS a keyword is not matched by substring", () => {
  // "not connected - callback requested" is not in the Not-connected set: the duration/direction rule applies.
  assert.equal(b("outbound", "not connected - callback requested", 30), "short");
  assert.equal(b("outbound", "not connected - callback requested", 0), "no_pickup");
  assert.equal(b("inbound", "not connected - callback requested", 0), "missed_incoming");
  // "Rejected by IVR note" is not in the Rejected set.
  assert.equal(b("outbound", "Rejected by IVR note", 0), "no_pickup");
  assert.equal(b("outbound", "Rejected by IVR note", 20), "short");
  assert.equal(b("outbound", "Busy tone then answered", 25), "short");
});

test("outcome normalisation: case, spaces, underscores, hyphens", () => {
  assert.equal(M.normalizeCallOutcome("  NOT_connected "), "not connected");
  assert.equal(M.normalizeCallOutcome("Never-Attended"), "never attended");
  assert.equal(M.normalizeCallOutcome("no   answer"), "no answer");
  assert.equal(b("outbound", "NOT_PICK", 0), "no_pickup");
  assert.equal(b("outbound", "Not-Connected", 4), "no_pickup");
});

test("talk > 120 s is always a conversation, whatever the outcome text says; exactly 120 s is not", () => {
  assert.equal(b("outbound", "Not Connected", 130), "conversation");
  assert.equal(b("inbound", "Missed", 121), "conversation");
  assert.equal(b("outbound", "Connected", 120), "short");
  assert.equal(b("outbound", "Connected", 119), "short");
  assert.equal(b("outbound", "Connected", 121), "conversation");
  assert.equal(b("inbound", "Connected", 120), "incoming_short");
  assert.equal(b("inbound", "Connected", 121), "conversation");
});

test("ring-time on a 'Not Connected' dial is not a connected call and adds no talk time", () => {
  const s = M.summarizeCalls([{ direction: "outbound", outcome: "Not Connected", durationSec: 5 }]);
  assert.equal(s.connected, 0);
  assert.equal(s.noPickup, 1);
  assert.equal(s.talkSec, 0);
});

/* ───────────── pickup rate: ONE definition ───────────── */

test("pickup rate = answered OUTBOUND calls / OUTBOUND dials (rejected dials count as dials, inbound never)", () => {
  const s = M.summarizeCalls([
    { direction: "outbound", outcome: "Connected", durationSec: 60 }, // answered
    { direction: "outbound", outcome: "Not Connected", durationSec: 0 },
    { direction: "outbound", outcome: "Not Connected", durationSec: 0 },
    { direction: "outbound", outcome: "Rejected", durationSec: 0 },
    { direction: "inbound", outcome: "Connected", durationSec: 600 }, // inbound is not part of pickup
    { direction: "inbound", outcome: "Connected", durationSec: 30 }, // incoming short: not part of pickup
    { direction: "inbound", outcome: "Missed", durationSec: 0 },
    { direction: "inbound", outcome: "Not Connected", durationSec: 0 }, // legacy mis-tag: an outbound dial
  ]);
  assert.equal(s.outbound, 5); // 1 answered + 2 not pick + 1 rejected + 1 legacy-tagged not pick
  assert.equal(s.connectedOutbound, 1);
  assert.equal(s.pickupRate, 20);
  assert.equal(M.pickupRatePct(1, 5), 20);
  assert.equal(M.pickupRatePct(0, 0), 0);
  assert.equal(M.pickupRatePct(5, 3), 100); // clamped
});

test("an old rule (any duration_sec > 0 = connected) is gone: ring seconds do not raise the pickup rate", () => {
  const s = M.summarizeCalls([
    { direction: "outbound", outcome: "Not Connected", durationSec: 4 },
    { direction: "outbound", outcome: "Not Connected", durationSec: 3 },
    { direction: "outbound", outcome: "Connected", durationSec: 50 },
  ]);
  assert.equal(s.pickupRate, 33);
});

test("legacy helpers agree with the partition", () => {
  for (const c of SYNTHETIC) {
    const bk = M.callBucket(c);
    assert.equal(M.isConnectedCall(c), bk === "conversation" || bk === "short" || bk === "incoming_short");
    assert.equal(M.isNotConnectedCall(c), !M.isConnectedCall(c));
    assert.equal(M.isShortConnectedCall(c), bk === "short");
    assert.equal(M.isIncomingShortCall(c), bk === "incoming_short");
    assert.equal(M.isConversationCall(M.callDurationSec(c)), bk === "conversation");
    assert.equal(M.isMissedCall(c), bk === "missed_incoming");
    assert.equal(M.isMissedIncomingCall(c), bk === "missed_incoming");
    assert.equal(M.isNotPickupByClientCall(c), bk === "no_pickup");
    assert.equal(M.isRejectedCall(c), bk === "rejected");
  }
});

test("pipeline columns - direction does NOT matter: answered 1-120 s = Short Call, answered > 120 s = Conversation, anything that did not connect = Not Pick", () => {
  for (const direction of ["outbound", "inbound"]) {
    assert.equal(callKanbanColumn({ direction, outcome: "Connected", durationSec: 1 }), "short_call", `${direction} 1 s`);
    assert.equal(callKanbanColumn({ direction, outcome: "Connected", durationSec: 33 }), "short_call", `${direction} 33 s`);
    assert.equal(callKanbanColumn({ direction, outcome: "Connected", durationSec: 119 }), "short_call", `${direction} 119 s`);
    assert.equal(callKanbanColumn({ direction, outcome: "Connected", durationSec: 120 }), "short_call", `${direction} exactly 120 s is Short`);
    assert.equal(callKanbanColumn({ direction, outcome: "Connected", durationSec: 121 }), "conversation_2min", `${direction} 121 s`);
    assert.equal(callKanbanColumn({ direction, outcome: "Connected", durationSec: 600 }), "conversation_2min", `${direction} 10 min`);
    // every call that did not connect -> Not Pick (not answered, not connected, missed, rejected)
    assert.equal(callKanbanColumn({ direction, outcome: "Not Connected", durationSec: 0 }), "not_pick", `${direction} not connected`);
    assert.equal(callKanbanColumn({ direction, outcome: "Not Connected", durationSec: 5 }), "not_pick", `${direction} ring only is not a Short Call`);
    assert.equal(callKanbanColumn({ direction, outcome: "Rejected", durationSec: 0 }), "not_pick", `${direction} rejected`);
    assert.equal(callKanbanColumn({ direction, outcome: "Missed", durationSec: 0 }), "not_pick", `${direction} missed`);
  }
  assert.equal(callKanbanColumn({ direction: "inbound", outcome: "Missed", durationSec: 0 }), "not_pick");
  assert.equal(callKanbanColumn({ direction: "inbound", outcome: "Connected", durationSec: 33 }), "short_call", "the 33 s INBOUND call from the screenshot");
  assert.equal(callKanbanColumn({ direction: "outbound", outcome: "Not Connected", durationSec: 120 }), "not_pick", "an unanswered outcome never becomes Short just because it has seconds");
});

test("mapCallStatsRow: SQL row -> API stats keeps the partition and the single pickup definition", () => {
  const stats = mapCallStatsRow({
    total_calls: 100, connected_calls: 45, conversations_5min_plus: 10, short_calls: 30, incoming_short_calls: 5,
    not_pickup_by_client: 40, missed_calls: 10, rejected_calls: 5,
    incoming_calls: 20, outgoing_calls: 80, connected_outbound_calls: 40,
  });
  assert.equal(stats.totalCalls, stats.connectedCalls + stats.notConnectedCalls);
  assert.equal(stats.connectedCalls, stats.conversations5MinPlus + stats.shortCalls + stats.incomingShortCalls);
  assert.equal(stats.notConnectedCalls, stats.notPickupByClient + stats.missedCalls + stats.rejectedCalls);
  assert.equal(stats.pickupRate, 50); // 40 / 80
});

test("frontend mirror (frontend/src/lib/callMetrics.js) classifies exactly like the backend", async () => {
  const fe = await import(pathToFileURL(path.resolve(__dirname, "../../../frontend/src/lib/callMetrics.js")).href);
  for (const c of SYNTHETIC) {
    assert.equal(fe.callBucket(c), M.callBucket(c), `bucket of call ${c.id}`);
  }
  assert.deepEqual(fe.summarizeCalls(SYNTHETIC), M.summarizeCalls(SYNTHETIC));
});

// Real DB rows are checked by scripts/verify-call-partition.js (read-only SELECTs against the local snapshot).
