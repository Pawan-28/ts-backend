/**
 * ACTIVE MEETING - the ONE definition shared by the Meetings page, the Pipeline board, the admin lists and the
 * stage-change / booking services. (Product rule: Pipeline "Meeting Booked" and the Meetings page must stay in sync.)
 *
 * A meeting is ACTIVE only when ALL of these hold:
 *   1. its status is "scheduled"                                  (completed / cancelled are history)
 *   2. its lead is not deleted and is CURRENTLY in Meeting Booked (any lead stage / status label that maps to meeting_booked)
 *   3. it belongs to the lead's assignee (an unassigned lead falls back to the meeting's own employee)  [viewer filter]
 *   4. it is the CURRENT meeting of that customer: ONE active meeting per customer (person key = last 10 digits of the
 *      phone, else the lead id). The current one is the soonest upcoming meeting, else the most recent past one.
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

/** Current meeting of one customer among scheduled candidates: soonest upcoming, else most recent past. */
function pickCurrentMeeting(candidates, now = Date.now()) {
  if (!candidates.length) return null;
  const nowWall = wallClockNow(now);
  const upcoming = candidates
    .filter((m) => wall(m.scheduledAt) >= nowWall)
    .sort((a, b) => wall(a.scheduledAt).localeCompare(wall(b.scheduledAt)) || Number(a.id) - Number(b.id));
  if (upcoming.length) return upcoming[0];
  return [...candidates].sort((a, b) => wall(b.scheduledAt).localeCompare(wall(a.scheduledAt)) || Number(b.id) - Number(a.id))[0];
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
    const current = pickCurrentMeeting(group, now);
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
function planBooking(existingScheduled = [], now = Date.now()) {
  const current = pickCurrentMeeting(existingScheduled, now);
  return current ? { action: "reschedule", meetingId: current.id, existing: current } : { action: "insert" };
}

module.exports = {
  LIFECYCLE,
  isMeetingBookedStage,
  meetingPersonKey,
  wallClockNow,
  pickCurrentMeeting,
  annotateActiveMeetings,
  activeOnly,
  meetingExitStatus,
  meetingStageTransition,
  planBooking,
};
