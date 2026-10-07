/**
 * ACTIVE MEETING - the ONE definition shared by the Meetings page, the Pipeline board, the admin lists and the
 * stage-change / booking services. (Product rule: Pipeline "Meeting Booked" and the Meetings page must stay in sync.)
 *
 * A meeting is ACTIVE only when ALL of these hold:
 *   1. its status is "scheduled"                                  (completed / cancelled are history)
 *   2. its lead is not deleted and is CURRENTLY in Meeting Booked (any lead stage / status label that maps to meeting_booked)
 *   3. it belongs to the lead's assignee (an unassigned lead falls back to the meeting's own employee)  [viewer filter]
 *   4. it is the CURRENT meeting of that customer: ONE active meeting per customer (person key = last 10 digits of the
 *      phone, else the lead id). The current one is the MOST RECENT BOOKING (highest id): a customer who books or moves a
 *      meeting to another time replaces the old one, whatever the old / new times are (2 PM -> 8:30 PM keeps 8:30 PM,
 *      and 12 Oct -> 9 Oct keeps 9 Oct). A reschedule updates the SAME row, so its id - and its place as "current" - never changes.
 * Everything else is HISTORY with a `lifecycle` explaining why (completed | cancelled | stage_moved | superseded |
 * lead_deleted | other_owner). Nothing is ever deleted.
 *
 * Moving a lead OUT of Meeting Booked settles its scheduled meetings (see meetingExitStatus): the meeting becomes
 * "completed" when it already took place (its time has passed) or the lead moved to Meeting Done, else "cancelled"
 * (a future meeting that was dropped). This matches how the app already treats a past still-booked meeting ("Held").
 */
const { mapStageToId } = require("./pipelineStages");
const { formatUtcInstantAsAppSql } = require("./appTimezone");

const LIFECYCLE = ["active", "completed", "cancelled", "stage_moved", "superseded", "lead_deleted", "other_owner"];

const norm = (v) => String(v == null ? "" : v).trim().toLowerCase();

/** True when a lead's stored stage/status label means "Meeting Booked". */
function isMeetingBookedStage(stage, status) {
  if (!String(stage || "").trim() && !String(status || "").trim()) return false;
  return mapStageToId(stage, status) === "meeting_booked";
}

/** Person key: last 10 digits of the phone, else the lead id (same key the Pipeline uses for "one card per phone"). */
function meetingPersonKey(meeting) {
  const digits = String(meeting?.leadPhone || "").replace(/\D/g, "");
  if (digits.length >= 10) return `p:${digits.slice(-10)}`;
  return `l:${meeting?.leadId}`;
}

/** "YYYY-MM-DDTHH:mm:ss" IST wall clock for `now` - the same format meetings.scheduledAt is stored/returned in. */
function wallClockNow(now = Date.now()) {
  return formatUtcInstantAsAppSql(new Date(now));
}

const wall = (v) => String(v == null ? "" : v).replace(" ", "T").slice(0, 19);

/**
 * Current meeting of one customer among scheduled candidates = the MOST RECENT BOOKING (highest id).
 * (Not "soonest" - a customer who moves 2 PM to 8:30 PM, both still upcoming, wants 8:30 PM.)
 */
function pickCurrentMeeting(candidates) {
  if (!candidates.length) return null;
  return [...candidates].sort((a, b) => Number(b.id) - Number(a.id))[0];
}

/**
 * PIPELINE CARDS WITH NO MEETING RECORD. A lead can sit in Meeting Booked / Meeting Done with no meeting row (legacy stage, or a
 * customer booking that carried no date). The Meetings page must still list it - otherwise Pipeline and Meetings can never match.
 *   stageId "meeting_booked": leads in Meeting Booked that have no ACTIVE meeting
 *   stageId "meeting_done"  : leads in Meeting Done that have no COMPLETED meeting
 * `leads`: [{ id, name, phone, company, service, stage, status }], `annotated`: the annotated meetings of the same viewer.
 */
function leadsWithoutMeeting(leads = [], annotated = [], stageId = "meeting_booked") {
  const covered = new Set(
    annotated
      .filter((m) => (stageId === "meeting_done" ? m.status === "completed" : m.isActive))
      .map((m) => meetingPersonKey(m)),
  );
  return leads
    .filter((l) => mapStageToId(l.stage, l.status) === stageId)
    .filter((l) => !covered.has(meetingPersonKey({ leadId: l.id, leadPhone: l.phone })));
}

/**
 * Is `existing` a scheduled row that a NEWER booking of the same customer replaced? Returns the customer's current meeting when
 * so (the one to reschedule instead), else null. `siblings` = the customer's scheduled meetings (may include `existing`).
 */
function supersedingMeeting(existing, siblings = []) {
  const current = pickCurrentMeeting(siblings);
  return current && String(current.id) !== String(existing.id) && Number(current.id) > Number(existing.id) ? current : null;
}

/**
 * The meetings the Pipeline board receives: exactly the Meetings page's active set + the history it needs (completed meetings
 * place Meeting Done). A "scheduled" meeting that is not active never reaches the board. ONE function, used by both sides.
 */
function boardMeetings(annotated = []) {
  return annotated.filter((m) => m.status !== "scheduled" || m.isActive !== false);
}

/**
 * Returns NEW meeting objects (inputs untouched) with `isActive` + `lifecycle` (+ `supersededBy`).
 * `viewerEmployeeId`: when given (employee Meetings page / employee board) a scheduled meeting only counts as active for
 * the lead's assignee. Rows without lead info (older callers) are treated as eligible.
 */
function annotateActiveMeetings(meetings = [], { now = Date.now(), viewerEmployeeId = null } = {}) {
  const list = Array.isArray(meetings) ? meetings : [];
  const viewer = viewerEmployeeId == null ? null : String(viewerEmployeeId);
  const out = new Map();
  const eligible = new Map(); // personKey -> scheduled eligible meetings

  for (const m of list) {
    const status = norm(m.status) || "scheduled";
    if (status === "completed") { out.set(m, { ...m, isActive: false, lifecycle: "completed" }); continue; }
    if (status === "cancelled" || status === "canceled") { out.set(m, { ...m, isActive: false, lifecycle: "cancelled" }); continue; }

    const hasLeadInfo = m.leadStage !== undefined || m.leadStatus !== undefined;
    if (hasLeadInfo) {
      if (Number(m.leadIsDeleted) === 1 || m.leadIsDeleted === true) { out.set(m, { ...m, isActive: false, lifecycle: "lead_deleted" }); continue; }
      if (!isMeetingBookedStage(m.leadStage, m.leadStatus)) { out.set(m, { ...m, isActive: false, lifecycle: "stage_moved" }); continue; }
    }
    if (viewer != null) {
      const assignee = m.leadAssignedTo == null ? null : String(m.leadAssignedTo);
      const owner = m.employeeId == null ? null : String(m.employeeId);
      const mine = assignee != null ? assignee === viewer : owner === viewer;
      if (!mine) { out.set(m, { ...m, isActive: false, lifecycle: "other_owner" }); continue; }
    }
    const key = meetingPersonKey(m);
    if (!eligible.has(key)) eligible.set(key, []);
    eligible.get(key).push(m);
  }

  for (const group of eligible.values()) {
    const current = pickCurrentMeeting(group);
    for (const m of group) {
      out.set(m, m === current
        ? { ...m, isActive: true, lifecycle: "active" }
        : { ...m, isActive: false, lifecycle: "superseded", supersededBy: current.id });
    }
  }
  return list.map((m) => out.get(m));
}

const activeOnly = (annotated = []) => annotated.filter((m) => m.isActive);

/**
 * New status for a scheduled meeting when its lead leaves Meeting Booked.
 * "completed" = it took place (time passed) or the lead went to Meeting Done; "cancelled" = a future meeting that was dropped.
 */
function meetingExitStatus(meeting, { toStageId, now = Date.now() } = {}) {
  if (toStageId === "meeting_done") return "completed";
  return wall(meeting.scheduledAt) <= wallClockNow(now) ? "completed" : "cancelled";
}

/** What changed for a lead's stage: did it just LEAVE or ENTER Meeting Booked? */
function meetingStageTransition(before = {}, after = {}) {
  const wasBooked = isMeetingBookedStage(before.stage, before.status);
  const nowBooked = isMeetingBookedStage(after.stage, after.status);
  return {
    leaving: wasBooked && !nowBooked,
    entering: !wasBooked && nowBooked,
    toStageId: mapStageToId(after.stage, after.status),
  };
}

/**
 * Booking rule: one active meeting per customer. Given the customer's existing SCHEDULED meetings, decide whether a new
 * booking inserts a row or reschedules the existing one. With several legacy rows the CURRENT one is rescheduled.
 */
function planBooking(existingScheduled = []) {
  const current = pickCurrentMeeting(existingScheduled);
  return current ? { action: "reschedule", meetingId: current.id, existing: current } : { action: "insert" };
}

module.exports = {
  LIFECYCLE,
  isMeetingBookedStage,
  meetingPersonKey,
  wallClockNow,
  pickCurrentMeeting,
  supersedingMeeting,
  leadsWithoutMeeting,
  boardMeetings,
  annotateActiveMeetings,
  activeOnly,
  meetingExitStatus,
  meetingStageTransition,
  planBooking,
};
