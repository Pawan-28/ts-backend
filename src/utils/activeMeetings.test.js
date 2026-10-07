// Run: node --test src/utils/activeMeetings.test.js
// Pipeline "Meeting Booked" <-> Meetings page synchronisation rules (utils/activeMeetings.js + services/meetingSyncService.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isMeetingBookedStage, meetingPersonKey, pickCurrentMeeting, annotateActiveMeetings, activeOnly,
  meetingExitStatus, meetingStageTransition, planBooking, wallClockNow,
} = require("./activeMeetings");
const { createMeetingSync, MeetingRequiredError } = require("../services/meetingSyncService");
const { mapStageToId } = require("./pipelineStages");

const NOW = Date.parse("2026-10-07T06:30:00Z"); // = 2026-10-07 12:00 IST
const FUTURE = "2026-10-09T15:30:00";
const PAST = "2026-10-05T15:30:00";

const m = (o = {}) => ({
  id: 1, leadId: 10, employeeId: 5, status: "scheduled", scheduledAt: FUTURE,
  leadPhone: "+91 99999 11111", leadStage: "Meeting Booked", leadStatus: "Meeting Booked", leadAssignedTo: 5, leadIsDeleted: 0, ...o,
});

test("which lead stage labels mean Meeting Booked", () => {
  for (const [stage, status] of [["Meeting Booked", ""], ["booked", "New Lead"], ["meeting_booked", ""], ["Booked", "Booked"], ["Call Booked", ""]]) {
    assert.equal(isMeetingBookedStage(stage, status), true, `${stage}/${status}`);
  }
  for (const [stage, status] of [["Lead", "booked"], ["Conversation", ""], ["Meeting Done", ""], ["Not Interested", ""], ["new", "New Lead"], ["Not Pick", ""], ["Closed Won", ""]]) {
    assert.equal(isMeetingBookedStage(stage, status), false, `${stage}/${status}`);
  }
  assert.equal(isMeetingBookedStage("", ""), false);
});

test("Meeting Booked lead -> exactly ONE active meeting, visible to the assigned employee", () => {
  const out = annotateActiveMeetings([m()], { now: NOW, viewerEmployeeId: 5 });
  assert.equal(activeOnly(out).length, 1);
  assert.equal(out[0].lifecycle, "active");
});

test("a scheduled meeting whose lead is NOT in Meeting Booked is history, whatever the new stage", () => {
  for (const stage of ["Conversation", "Not Interested", "Not Pick", "Lead", "Meeting Done", "Proposal Sent", "Closed Won", "Rejected"]) {
    const out = annotateActiveMeetings([m({ leadStage: stage, leadStatus: stage })], { now: NOW });
    assert.equal(activeOnly(out).length, 0, stage);
    assert.equal(out[0].lifecycle, "stage_moved", stage);
  }
});

test("completed / cancelled meetings are history and never active, even while the lead is in Meeting Booked", () => {
  const out = annotateActiveMeetings([m({ id: 1, status: "completed" }), m({ id: 2, status: "cancelled" })], { now: NOW });
  assert.equal(activeOnly(out).length, 0);
  assert.deepEqual(out.map((x) => x.lifecycle), ["completed", "cancelled"]);
});

test("two scheduled meetings for one customer -> only the CURRENT one is active (soonest upcoming), the rest are superseded", () => {
  const rows = [
    m({ id: 1, scheduledAt: "2026-10-12T10:00:00" }),
    m({ id: 2, scheduledAt: "2026-10-09T10:00:00" }),
    m({ id: 3, scheduledAt: PAST }),
  ];
  const out = annotateActiveMeetings(rows, { now: NOW });
  assert.deepEqual(activeOnly(out).map((x) => x.id), [2]);
  assert.deepEqual(out.filter((x) => x.lifecycle === "superseded").map((x) => x.id).sort(), [1, 3]);
  assert.ok(out.filter((x) => x.lifecycle === "superseded").every((x) => x.supersededBy === 2));
});

test("with no upcoming meeting the most recent past one is the current (overdue) meeting", () => {
  const out = annotateActiveMeetings([m({ id: 1, scheduledAt: "2026-09-01T10:00:00" }), m({ id: 2, scheduledAt: PAST })], { now: NOW });
  assert.deepEqual(activeOnly(out).map((x) => x.id), [2]);
});

test("one customer = one meeting ACROSS lead records that share a phone (last 10 digits)", () => {
  const rows = [
    m({ id: 1, leadId: 10, leadPhone: "+91 99999 11111", scheduledAt: "2026-10-09T10:00:00" }),
    m({ id: 2, leadId: 11, leadPhone: "9999911111", scheduledAt: "2026-10-10T10:00:00" }),
  ];
  assert.equal(meetingPersonKey(rows[0]), meetingPersonKey(rows[1]));
  assert.equal(activeOnly(annotateActiveMeetings(rows, { now: NOW })).length, 1);
});

test("customers with different phones keep one active meeting each", () => {
  const rows = [m({ id: 1, leadId: 10, leadPhone: "9999911111" }), m({ id: 2, leadId: 11, leadPhone: "8888822222" })];
  assert.equal(activeOnly(annotateActiveMeetings(rows, { now: NOW })).length, 2);
});

test("ownership: another employee's meeting is NOT active for this employee; the assignee sees it", () => {
  const row = m({ employeeId: 9, leadAssignedTo: 5 }); // booked by employee 9 on a lead assigned to 5
  assert.equal(activeOnly(annotateActiveMeetings([row], { now: NOW, viewerEmployeeId: 5 })).length, 1);
  const other = annotateActiveMeetings([row], { now: NOW, viewerEmployeeId: 9 });
  assert.equal(activeOnly(other).length, 0);
  assert.equal(other[0].lifecycle, "other_owner");
  // an unassigned lead falls back to the meeting's own employee
  const unassigned = m({ employeeId: 9, leadAssignedTo: null });
  assert.equal(activeOnly(annotateActiveMeetings([unassigned], { now: NOW, viewerEmployeeId: 9 })).length, 1);
  assert.equal(activeOnly(annotateActiveMeetings([unassigned], { now: NOW, viewerEmployeeId: 5 })).length, 0);
  // admin / tenant-wide (no viewer): no ownership filter
  assert.equal(activeOnly(annotateActiveMeetings([row], { now: NOW })).length, 1);
});

test("deleted lead -> not active; inputs are never mutated", () => {
  const row = m({ leadIsDeleted: 1 });
  const copy = JSON.stringify(row);
  assert.equal(annotateActiveMeetings([row], { now: NOW })[0].lifecycle, "lead_deleted");
  assert.equal(JSON.stringify(row), copy);
});

test("stage exit status: held when the time has passed or the lead went to Meeting Done, cancelled for a future meeting dropped", () => {
  assert.equal(meetingExitStatus({ scheduledAt: PAST }, { toStageId: "conversation_2min", now: NOW }), "completed");
  assert.equal(meetingExitStatus({ scheduledAt: FUTURE }, { toStageId: "conversation_2min", now: NOW }), "cancelled");
  assert.equal(meetingExitStatus({ scheduledAt: FUTURE }, { toStageId: "meeting_done", now: NOW }), "completed");
  assert.equal(meetingExitStatus({ scheduledAt: FUTURE }, { toStageId: "not_interested", now: NOW }), "cancelled");
  assert.equal(wallClockNow(NOW), "2026-10-07T12:00:00");
});

test("stage transition detection", () => {
  assert.equal(meetingStageTransition({ stage: "Meeting Booked" }, { stage: "Conversation" }).leaving, true);
  assert.equal(meetingStageTransition({ stage: "Meeting Booked" }, { stage: "Meeting Booked" }).leaving, false);
  assert.equal(meetingStageTransition({ stage: "Lead" }, { stage: "Meeting Booked" }).entering, true);
  assert.equal(meetingStageTransition({ stage: "Lead" }, { stage: "Not Pick" }).leaving, false);
  assert.equal(meetingStageTransition({ stage: "Meeting Booked" }, { stage: "Not Interested" }).toStageId, "not_interested");
});

test("booking plan: no meeting -> insert; existing scheduled meeting -> reschedule THAT one (the current one)", () => {
  assert.deepEqual(planBooking([], NOW), { action: "insert" });
  const plan = planBooking([m({ id: 4, scheduledAt: "2026-10-12T10:00:00" }), m({ id: 7, scheduledAt: "2026-10-09T10:00:00" })], NOW);
  assert.equal(plan.action, "reschedule");
  assert.equal(plan.meetingId, 7);
  assert.equal(pickCurrentMeeting([], NOW), null);
});

/* ───────── lifecycle simulation: the real service functions on an in-memory store ───────── */

function world() {
  const lead = { id: 10, phone: "+91 99999 11111", stage: "Lead", status: "Lead", assignedTo: 5, isDeleted: 0 };
  const meetings = [];
  let nextId = 1;
  const repo = {
    listScheduledMeetingsForLead: async (_t, leadId) => meetings.filter((x) => x.leadId === leadId && x.status === "scheduled"),
    listScheduledMeetingsForPhone: async () => [],
    setScheduledMeetingsStatus: async (_t, ids, status) => {
      let n = 0;
      for (const x of meetings) if (ids.includes(x.id) && x.status === "scheduled") { x.status = status; n += 1; }
      return n;
    },
  };
  const sync = createMeetingSync(() => repo);
  const api = {
    lead, meetings, sync,
    /** the booking rule used by createMeeting: insert, or reschedule the existing active meeting */
    async book(scheduledAt) {
      const plan = await sync.planCustomerBooking("t", lead, NOW);
      if (plan.action === "reschedule") {
        Object.assign(meetings.find((x) => x.id === plan.meetingId), { scheduledAt });
        return { id: plan.meetingId, rescheduled: true };
      }
      const row = { id: nextId++, leadId: lead.id, employeeId: 5, status: "scheduled", scheduledAt };
      meetings.push(row);
      return { id: row.id, rescheduled: false };
    },
    /** the stage-change rule used by every stage writer: guard INTO, apply, settle OUT of */
    async moveStage(stage, { skipGuard = false } = {}) {
      const before = { stage: lead.stage, status: lead.status };
      const after = { stage, status: stage };
      if (!skipGuard) await sync.guardEnterMeetingBooked({ tenantId: "t", leadId: lead.id, before, after });
      lead.stage = stage; lead.status = stage;
      return sync.settleOnStageChange({ tenantId: "t", leadId: lead.id, before, after, now: NOW });
    },
    holdMeeting(id) { meetings.find((x) => x.id === id).status = "completed"; },
    /** what the Meetings page / board receive from the API */
    active() {
      const rows = meetings.map((x) => ({
        ...x, leadPhone: lead.phone, leadStage: lead.stage, leadStatus: lead.status, leadAssignedTo: lead.assignedTo, leadIsDeleted: lead.isDeleted,
      }));
      return activeOnly(annotateActiveMeetings(rows, { now: NOW, viewerEmployeeId: 5 }));
    },
  };
  return api;
}

test("ACCEPTANCE: Meeting Booked lead -> 1 active meeting on the Meetings page", async () => {
  const w = world();
  await w.book(FUTURE);
  await w.moveStage("Meeting Booked");
  assert.equal(w.active().length, 1);
});

test("ACCEPTANCE: reschedule -> still ONE active meeting, SAME record updated, no second row", async () => {
  const w = world();
  const first = await w.book(FUTURE);
  await w.moveStage("Meeting Booked");
  const second = await w.book("2026-10-15T11:00:00");
  const third = await w.book("2026-10-16T12:00:00");
  assert.equal(second.rescheduled, true);
  assert.equal(third.rescheduled, true);
  assert.equal(second.id, first.id);
  assert.equal(w.meetings.length, 1, "no extra meeting rows");
  assert.equal(w.active().length, 1);
  assert.equal(w.active()[0].scheduledAt, "2026-10-16T12:00:00");
});

for (const dest of ["Conversation", "Not Interested", "Not Pick", "Rejected", "Lead", "Proposal Sent", "Short Call"]) {
  test(`ACCEPTANCE: meeting held + lead moves to ${dest} -> 0 active meetings, history kept (not deleted)`, async () => {
    const w = world();
    const { id } = await w.book(PAST);
    await w.moveStage("Meeting Booked");
    w.holdMeeting(id); // Mark held
    await w.moveStage(dest);
    assert.equal(w.active().length, 0);
    assert.equal(w.meetings.length, 1, "historical meeting is not deleted");
    assert.equal(w.meetings[0].status, "completed");
  });
}

test("ACCEPTANCE: any move out of Meeting Booked settles the scheduled meeting: past -> completed, future -> cancelled", async () => {
  const past = world();
  await past.book(PAST); await past.moveStage("Meeting Booked");
  const r1 = await past.moveStage("Not Pick");
  assert.deepEqual([r1.settled, r1.completed.length], [1, 1]);
  assert.equal(past.active().length, 0);

  const future = world();
  await future.book(FUTURE); await future.moveStage("Meeting Booked");
  const r2 = await future.moveStage("Conversation");
  assert.deepEqual([r2.settled, r2.cancelled.length], [1, 1]);
  assert.equal(future.active().length, 0);
  assert.equal(future.meetings.length, 1);
});

test("ACCEPTANCE: moving to Meeting Done completes the meeting (even a future one)", async () => {
  const w = world();
  await w.book(FUTURE); await w.moveStage("Meeting Booked");
  await w.moveStage("Meeting Done");
  assert.equal(w.meetings[0].status, "completed");
  assert.equal(w.active().length, 0);
});

test("ACCEPTANCE: moving BACK to Meeting Booked needs a meeting first, then there is exactly ONE active meeting", async () => {
  const w = world();
  await w.book(PAST); await w.moveStage("Meeting Booked");
  await w.moveStage("Conversation");
  assert.equal(w.active().length, 0);
  await assert.rejects(() => w.moveStage("Meeting Booked"), (e) => e instanceof MeetingRequiredError && e.status === 409);
  assert.equal(w.lead.stage, "Conversation", "the lead did not move without a meeting");
  await w.book("2026-10-20T10:00:00"); // the old one is completed -> a NEW meeting row is correct
  await w.moveStage("Meeting Booked");
  assert.equal(w.active().length, 1);
  assert.equal(w.meetings.filter((x) => x.status === "scheduled").length, 1, "never 2 active meetings for one customer");
  assert.equal(w.meetings.length, 2, "history kept");
});

test("webhook intake may set Meeting Booked before the meeting row exists (skip guard); the meeting then makes it consistent", async () => {
  const w = world();
  await w.moveStage("Meeting Booked", { skipGuard: true });
  await w.book(FUTURE);
  assert.equal(w.active().length, 1);
});

test("stage moves that do not touch Meeting Booked never settle anything", async () => {
  const w = world();
  await w.book(FUTURE); await w.moveStage("Meeting Booked");
  const r = await w.moveStage("Meeting Booked");
  assert.equal(r.settled, 0);
  const w2 = world();
  const r2 = await w2.moveStage("Conversation");
  assert.equal(r2.settled, 0);
});

test("legacy duplicates (3 scheduled meetings, lead in Meeting Booked) -> API reports exactly one active; booking again reschedules the current one", async () => {
  const w = world();
  w.meetings.push(
    { id: 1, leadId: 10, employeeId: 5, status: "scheduled", scheduledAt: "2026-07-01T14:00:00" },
    { id: 2, leadId: 10, employeeId: 5, status: "scheduled", scheduledAt: "2026-07-09T14:00:00" },
    { id: 3, leadId: 10, employeeId: 5, status: "scheduled", scheduledAt: "2026-07-09T14:00:00" },
  );
  w.lead.stage = "Meeting Booked"; w.lead.status = "Meeting Booked";
  assert.equal(w.active().length, 1);
  assert.equal(w.active()[0].id, 3);
  const r = await w.book(FUTURE);
  assert.equal(r.rescheduled, true);
  assert.equal(r.id, 3, "the CURRENT meeting is the one rescheduled");
  assert.equal(w.meetings.length, 3, "no new row");
  assert.equal(w.active()[0].scheduledAt, FUTURE);
});

test("settling a lead's meetings only touches that lead's still-scheduled rows", async () => {
  const w = world();
  w.meetings.push({ id: 1, leadId: 10, employeeId: 5, status: "completed", scheduledAt: PAST });
  w.meetings.push({ id: 2, leadId: 99, employeeId: 5, status: "scheduled", scheduledAt: FUTURE });
  await w.book(FUTURE);
  await w.moveStage("Meeting Booked");
  await w.moveStage("Conversation");
  assert.equal(w.meetings.find((x) => x.id === 1).status, "completed");
  assert.equal(w.meetings.find((x) => x.id === 2).status, "scheduled", "another lead's meeting untouched");
});

test("stage vocabulary used by the guard matches the Pipeline's own mapping", () => {
  assert.equal(mapStageToId("Meeting Booked", ""), "meeting_booked");
  assert.equal(mapStageToId("booked", "New Lead"), "meeting_booked");
});
