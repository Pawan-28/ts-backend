/**
 * Keeps the Pipeline "Meeting Booked" column and the Meetings page in sync (rules live in utils/activeMeetings.js).
 *
 *  - settleOnStageChange   a lead LEAVES Meeting Booked  -> its scheduled meeting(s) become history (completed / cancelled).
 *                          Called from EVERY path that writes a lead's stage (repo.updateLead, admin pipeline drag, legacy
 *                          salesController.updateLead). Historical rows are never deleted.
 *  - guardEnterMeetingBooked  a lead is moved INTO Meeting Booked by a person -> it must already have a scheduled meeting
 *                          (book / reschedule one first). Webhook intake is exempt (the customer's booking creates the meeting).
 *  - findExistingScheduledForCustomer  the "one customer = one active meeting" lookup used by every booking path.
 *
 * `repo` is injectable so the rules can be unit-tested without a database (see meetingSync.test.js).
 */
const {
  meetingExitStatus,
  meetingStageTransition,
  planBooking,
  meetingPersonKey,
} = require("../utils/activeMeetings");

/** The fields of an existing meeting that a repeat booking overwrites (same row, new time). Pure. */
function buildReschedulePatch(existing, payload) {
  const patch = {
    scheduledAt: payload.scheduledAt,
    durationMin: payload.durationMin || existing.durationMin || undefined,
    title: payload.title || existing.title || undefined,
    location: payload.location || existing.location || undefined,
    // A Meet link does not depend on the time, so keep the existing one unless the booking brought a new link.
    meetLink: String(payload.meetLink || "").trim() || existing.meetLink || undefined,
    agenda: payload.agenda || undefined,
  };
  for (const k of Object.keys(patch)) if (patch[k] === undefined) delete patch[k];
  return patch;
}

const defaultRepo = () => require("../repositories/operationalRepo");

class MeetingRequiredError extends Error {
  constructor(message) {
    super(message || "Book a meeting (date and time) before moving this lead to Meeting Booked.");
    this.name = "MeetingRequiredError";
    this.status = 409;
    this.code = "MEETING_REQUIRED";
  }
}

function createMeetingSync(getRepo = defaultRepo) {
  /** Scheduled meetings of this customer: the lead itself plus every lead record sharing its phone. De-duplicated. */
  async function findExistingScheduledForCustomer(tenantId, lead) {
    const repo = getRepo();
    const own = await repo.listScheduledMeetingsForLead(tenantId, lead.id);
    const byPhone = lead.phone ? await repo.listScheduledMeetingsForPhone(tenantId, lead.phone) : [];
    const seen = new Set();
    const all = [];
    for (const m of [...own, ...byPhone]) {
      if (seen.has(String(m.id))) continue;
      seen.add(String(m.id));
      all.push(m.leadPhone ? m : { ...m, leadPhone: lead.phone });
    }
    return all;
  }

  /** Decide insert vs reschedule for a new booking of `lead`. */
  async function planCustomerBooking(tenantId, lead, now = Date.now()) {
    const existing = await findExistingScheduledForCustomer(tenantId, lead);
    return { ...planBooking(existing, now), existingCount: existing.length };
  }

  /**
   * THE booking rule, used by EVERY way of booking (manual Meetings page, lead drawer / modal, Follow-Ups, Pipeline drag, and
   * the landing-page / n8n webhook all end in operationalServices.createMeeting -> here): if the customer already has a
   * scheduled meeting, UPDATE that meeting (same id); only a customer with none gets a new row.
   * insertMeeting(payload) / updateMeeting(id, patch) are injected (DB in production, memory in tests).
   */
  async function bookForCustomer({ tenantId, lead, payload, insertMeeting, updateMeeting, now = Date.now() }) {
    const plan = lead ? await planCustomerBooking(tenantId, lead, now) : { action: "insert" };
    if (plan.action === "reschedule") {
      const meeting = await updateMeeting(plan.existing.id, buildReschedulePatch(plan.existing, payload));
      return {
        rescheduled: true,
        existing: plan.existing,
        meeting: { ...meeting, rescheduled: true, previousScheduledAt: plan.existing.scheduledAt },
      };
    }
    return { rescheduled: false, existing: null, meeting: await insertMeeting(payload) };
  }

  /**
   * A lead's stage/status was written. If it just LEFT Meeting Booked, settle its scheduled meetings.
   * @returns {{ settled: number, completed: number[], cancelled: number[] }}
   */
  async function settleOnStageChange({ tenantId, leadId, before, after, now = Date.now() }) {
    const empty = { settled: 0, completed: [], cancelled: [] };
    const tr = meetingStageTransition(before, after);
    if (!tr.leaving) return empty;
    const repo = getRepo();
    const scheduled = await repo.listScheduledMeetingsForLead(tenantId, leadId);
    const completed = [];
    const cancelled = [];
    for (const m of scheduled) {
      (meetingExitStatus(m, { toStageId: tr.toStageId, now }) === "completed" ? completed : cancelled).push(m.id);
    }
    if (completed.length) await repo.setScheduledMeetingsStatus(tenantId, completed, "completed");
    if (cancelled.length) await repo.setScheduledMeetingsStatus(tenantId, cancelled, "cancelled");
    return { settled: completed.length + cancelled.length, completed, cancelled };
  }

  /** Throws MeetingRequiredError when a person moves a lead into Meeting Booked without a scheduled meeting. */
  async function guardEnterMeetingBooked({ tenantId, leadId, before, after }) {
    const tr = meetingStageTransition(before, after);
    if (!tr.entering) return;
    const scheduled = await getRepo().listScheduledMeetingsForLead(tenantId, leadId);
    if (!scheduled.length) throw new MeetingRequiredError();
  }

  return { findExistingScheduledForCustomer, planCustomerBooking, bookForCustomer, settleOnStageChange, guardEnterMeetingBooked };
}

const shared = createMeetingSync();

module.exports = { createMeetingSync, MeetingRequiredError, meetingPersonKey, buildReschedulePatch, ...shared };
