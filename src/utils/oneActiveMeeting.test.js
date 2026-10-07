// Run: node --test src/utils/oneActiveMeeting.test.js
// FINAL RULE: ONE CUSTOMER = ONE ACTIVE MEETING, and the Meetings page + Pipeline read the SAME active set.
// Every booking path (manual Meetings page, lead drawer, Follow-Ups, Pipeline drag, landing-page/n8n webhook, reschedule action)
// ends in operationalServices.createMeeting -> meetingSync.bookForCustomer; these tests run that real function on an in-memory store.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  annotateActiveMeetings, activeOnly, boardMeetings, supersedingMeeting, pickCurrentMeeting,
} = require("./activeMeetings");
const { createMeetingSync } = require("../services/meetingSyncService");
const { extractWebhookMeeting } = require("./webhookMeeting");

const NOW = Date.parse("2026-10-07T09:30:00Z"); // 2026-10-07 15:00 IST

function store() {
  const lead = { id: 77, phone: "+91 91947 24633", stage: "Meeting Booked", status: "Meeting Booked", assignedTo: 5, isDeleted: 0 };
  const meetings = [];
  let nextId = 100;
  const repo = {
    listScheduledMeetingsForLead: async (_t, leadId) => meetings.filter((x) => x.leadId === leadId && x.status === "scheduled"),
    listScheduledMeetingsForPhone: async () => [],
    setScheduledMeetingsStatus: async () => 0,
  };
  const sync = createMeetingSync(() => repo);
  const s = {
    lead, meetings, sync,
    /** exactly what operationalServices.createMeeting does: bookForCustomer with the DB insert / update injected */
    async createMeeting(payload) {
      const booking = await sync.bookForCustomer({
        tenantId: "t", lead, payload, now: NOW,
        updateMeeting: async (id, patch) => Object.assign(meetings.find((x) => x.id === id), patch),
        insertMeeting: async (p) => { const row = { id: nextId++, leadId: lead.id, employeeId: 5, status: "scheduled", ...p }; meetings.push(row); return row; },
      });
      return booking.meeting;
    },
    /** PATCH /employee/meetings/:id with a new time (the reschedule action) - same row, with the superseded guard */
    async reschedule(id, scheduledAt) {
      const row = meetings.find((x) => x.id === id);
      const siblings = await sync.findExistingScheduledForCustomer("t", lead);
      const current = supersedingMeeting(row, siblings);
      if (current) { const e = new Error("current is #" + current.id); e.status = 409; throw e; }
      row.scheduledAt = scheduledAt;
      return row;
    },
    /** what the Meetings page receives (employee list) */
    api() {
      return annotateActiveMeetings(meetings.map((x) => ({
        ...x, leadPhone: lead.phone, leadStage: lead.stage, leadStatus: lead.status, leadAssignedTo: lead.assignedTo, leadIsDeleted: lead.isDeleted,
      })), { now: NOW, viewerEmployeeId: 5 });
    },
  };
  return s;
}

test("manual booking: same customer booked twice at different times -> ONE active meeting, SAME row updated", async () => {
  const s = store();
  const first = await s.createMeeting({ scheduledAt: "2026-10-06T14:00:00", title: "Clarity Call" });
  const second = await s.createMeeting({ scheduledAt: "2026-10-06T20:30:00", title: "Clarity Call" });
  assert.equal(second.id, first.id);
  assert.equal(second.rescheduled, true);
  assert.equal(s.meetings.length, 1, "no second row was inserted");
  assert.equal(activeOnly(s.api()).length, 1);
  assert.equal(activeOnly(s.api())[0].scheduledAt, "2026-10-06T20:30:00", "only 8:30 PM remains");
});

test("webhook rebooking: customer re-books through the form -> the existing meeting is moved, never a second active meeting", async () => {
  const s = store();
  await s.createMeeting({ scheduledAt: "2026-10-06T14:00:00", title: "Deepak - Clarity Call", meetLink: "https://meet.google.com/aaa-bbbb-ccc" });
  // the n8n / landing-page payload: UTC "Z" time + a link, parsed with the SAME parser the live webhook uses
  const sched = extractWebhookMeeting({ scheduledAt: "2026-10-06T15:00:00Z", meetLink: "https://meet.google.com/aaa-bbbb-ccc", meetingTitle: "Deepak - Clarity Call" });
  assert.ok(sched.scheduledAt instanceof Date);
  const rebooked = await s.createMeeting({ scheduledAt: "2026-10-06T20:30:00", title: sched ? "Deepak - Clarity Call" : "", meetLink: sched.meetLink });
  assert.equal(rebooked.rescheduled, true);
  assert.equal(s.meetings.length, 1);
  assert.equal(activeOnly(s.api()).length, 1);
  assert.equal(s.meetings[0].meetLink, "https://meet.google.com/aaa-bbbb-ccc", "the existing meeting keeps its link");
});

test("a booking without its own link keeps the existing Meet link when it reschedules", async () => {
  const s = store();
  await s.createMeeting({ scheduledAt: "2026-10-09T10:00:00", meetLink: "https://meet.google.com/xxx-yyyy-zzz" });
  await s.createMeeting({ scheduledAt: "2026-10-09T18:00:00" });
  assert.equal(s.meetings.length, 1);
  assert.equal(s.meetings[0].meetLink, "https://meet.google.com/xxx-yyyy-zzz");
});

test("reschedule action (PATCH time on the active meeting): one meeting, same id, new time", async () => {
  const s = store();
  const m1 = await s.createMeeting({ scheduledAt: "2026-10-09T14:00:00" });
  await s.reschedule(m1.id, "2026-10-09T20:30:00");
  assert.equal(s.meetings.length, 1);
  assert.equal(activeOnly(s.api()).length, 1);
  assert.equal(activeOnly(s.api())[0].id, m1.id);
  assert.equal(activeOnly(s.api())[0].scheduledAt, "2026-10-09T20:30:00");
});

test("rescheduling the current meeting LATER than a replaced legacy row keeps it current (the old row never takes over)", async () => {
  const s = store();
  // legacy duplicates already in the DB: #1 (older, upcoming) and #2 (the latest booking)
  s.meetings.push({ id: 1, leadId: 77, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-09T10:00:00" });
  s.meetings.push({ id: 2, leadId: 77, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-12T10:00:00" });
  assert.deepEqual(activeOnly(s.api()).map((x) => x.id), [2]);
  await s.reschedule(2, "2026-10-20T10:00:00");
  assert.deepEqual(activeOnly(s.api()).map((x) => x.id), [2], "still the same single active meeting");
  await assert.rejects(() => s.reschedule(1, "2026-10-21T10:00:00"), (e) => e.status === 409, "a replaced meeting cannot be rescheduled directly");
});

test("a booking when legacy duplicates exist updates the CURRENT meeting; the old rows stay superseded (history), none is added", async () => {
  const s = store();
  s.meetings.push({ id: 1, leadId: 77, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-06T14:00:00" });
  s.meetings.push({ id: 2, leadId: 77, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-06T20:30:00" });
  const out = await s.createMeeting({ scheduledAt: "2026-10-15T11:00:00" });
  assert.equal(out.id, 2);
  assert.equal(s.meetings.length, 2, "no new row");
  const api = s.api();
  assert.deepEqual(activeOnly(api).map((x) => x.id), [2]);
  assert.equal(api.find((x) => x.id === 1).lifecycle, "superseded");
});

test("the visible Deepak case: two overdue meetings (6 Oct 2:00 PM and 8:30 PM) on one lead in Meeting Booked -> ONE active card (8:30 PM)", () => {
  const rows = [
    { id: 301, leadId: 9, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-06T14:00:00", leadPhone: "919194724633", leadStage: "Meeting Booked", leadStatus: "Meeting Booked", leadAssignedTo: 5, leadIsDeleted: 0 },
    { id: 302, leadId: 9, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-06T20:30:00", leadPhone: "919194724633", leadStage: "Meeting Booked", leadStatus: "Meeting Booked", leadAssignedTo: 5, leadIsDeleted: 0 },
  ];
  const out = annotateActiveMeetings(rows, { now: NOW, viewerEmployeeId: 5 });
  assert.deepEqual(activeOnly(out).map((x) => x.id), [302]);
  assert.equal(out[0].isActive, false);
  assert.equal(out[0].lifecycle, "superseded");
  assert.equal(out[0].supersededBy, 302);
});

test("two lead records of the same customer (same phone, different formatting) -> still one active meeting", () => {
  const rows = [
    { id: 1, leadId: 9, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-09T14:00:00", leadPhone: "+91 91947 24633", leadStage: "Meeting Booked", leadAssignedTo: 5 },
    { id: 2, leadId: 10, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-09T20:30:00", leadPhone: "9194724633", leadStage: "Meeting Booked", leadAssignedTo: 5 },
  ];
  assert.deepEqual(activeOnly(annotateActiveMeetings(rows, { now: NOW })).map((x) => x.id), [2]);
});

test("lead leaves Meeting Booked -> the customer's active card disappears from the Meetings list; returning needs ONE active meeting", async () => {
  const s = store();
  await s.createMeeting({ scheduledAt: "2026-10-09T14:00:00" });
  assert.equal(activeOnly(s.api()).length, 1);
  const before = { stage: s.lead.stage, status: s.lead.status };
  s.lead.stage = "Conversation"; s.lead.status = "Conversation";
  await s.sync.settleOnStageChange({ tenantId: "t", leadId: s.lead.id, before, after: { stage: "Conversation", status: "Conversation" }, now: NOW });
  // (the in-memory repo does not persist the settle; the read-time definition alone already removes the active card)
  assert.equal(activeOnly(s.api()).length, 0);
  s.lead.stage = "Meeting Booked"; s.lead.status = "Meeting Booked";
  s.meetings.length = 0; // settled to history
  await s.createMeeting({ scheduledAt: "2026-10-14T11:00:00" });
  assert.equal(activeOnly(s.api()).length, 1);
});

test("Pipeline and Meetings page use the SAME active set: every scheduled meeting the board gets is active, and every active one reaches the board", () => {
  const mk = (id, over = {}) => ({ id, leadId: 9, employeeId: 5, status: "scheduled", scheduledAt: "2026-10-09T14:00:00", leadPhone: "9194724633", leadStage: "Meeting Booked", leadStatus: "Meeting Booked", leadAssignedTo: 5, leadIsDeleted: 0, ...over });
  const annotated = annotateActiveMeetings([
    mk(1),                                                  // superseded by 2
    mk(2, { scheduledAt: "2026-10-09T20:30:00" }),          // active
    mk(3, { leadId: 11, leadPhone: "8888822222", leadStage: "Conversation" }),   // lead moved on
    mk(4, { leadId: 12, leadPhone: "7777733333", status: "completed" }),         // held
    mk(5, { leadId: 13, leadPhone: "6666644444", status: "cancelled" }),         // cancelled
    mk(6, { leadId: 14, leadPhone: "5555544444", leadAssignedTo: 9, employeeId: 9 }), // another employee's lead
  ], { now: NOW, viewerEmployeeId: 5 });
  const meetingsPageActive = activeOnly(annotated).map((x) => x.id).sort();
  const boardScheduled = boardMeetings(annotated).filter((x) => x.status === "scheduled").map((x) => x.id).sort();
  assert.deepEqual(boardScheduled, meetingsPageActive);
  assert.deepEqual(meetingsPageActive, [2]);
  assert.ok(boardMeetings(annotated).some((x) => x.id === 4), "held meetings still reach the board (they place Meeting Done)");
  assert.ok(!boardMeetings(annotated).some((x) => x.id === 1 || x.id === 3 || x.id === 6));
});

test("pickCurrentMeeting / supersedingMeeting basics", () => {
  assert.equal(pickCurrentMeeting([{ id: 3 }, { id: 9 }, { id: 5 }]).id, 9);
  assert.equal(supersedingMeeting({ id: 3 }, [{ id: 3 }, { id: 9 }]).id, 9);
  assert.equal(supersedingMeeting({ id: 9 }, [{ id: 3 }, { id: 9 }]), null);
  assert.equal(supersedingMeeting({ id: 9 }, [{ id: 9 }]), null);
});

/* ───────── single choke point: nothing else may insert a meeting, and both screens use the shared definition ───────── */

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(p);
    return p.endsWith(".js") && !p.endsWith(".test.js") ? [p] : [];
  });
}

test("source guard: only operationalServices.createMeeting inserts meetings, and every booking path goes through it", () => {
  const src = path.resolve(__dirname, "..");
  const callers = walk(src).filter((f) => /[.]insertMeeting\s*\(/.test(fs.readFileSync(f, "utf8")) && !f.endsWith(path.join("repositories", "operationalRepo.js")));
  assert.deepEqual(callers.map((f) => path.basename(f)), ["operationalServices.js"], "no other file may call insertMeeting()");
  const services = fs.readFileSync(path.join(src, "services", "operationalServices.js"), "utf8");
  assert.equal((services.match(/repo\.insertMeeting\(/g) || []).length, 1, "exactly one insert call");
  assert.match(services, /meetingSync\.bookForCustomer\(/);
  // the manual route and the webhook both book through createMeeting (never a direct insert)
  const routes = fs.readFileSync(path.join(src, "routes", "operationalRoutes.js"), "utf8");
  assert.match(routes, /createMeeting\(\{ tenantId, data: meetingData/);
  assert.match(services, /const saved = await createMeeting\(\{/);
});

test("source guard: the Meetings API and the Pipeline board both use the shared active-meeting functions", () => {
  const src = path.resolve(__dirname, "..");
  const repoSrc = fs.readFileSync(path.join(src, "repositories", "operationalRepo.js"), "utf8");
  assert.match(repoSrc, /annotateActiveMeetings\(result\.rows\.map\(mapMeeting\), \{ viewerEmployeeId: employeeId \}\)/);
  assert.match(repoSrc, /return annotateActiveMeetings\(result\.rows\.map\(mapMeeting\)\);/);
  const board = fs.readFileSync(path.join(src, "services", "pipelineBoardService.js"), "utf8");
  assert.match(board, /boardMeetings\(allMeetings\)/);
  assert.match(board, /includeAssignedLeads: true/, "the board loads the same meeting set as the Meetings page");
});

/* ───────── Pipeline cards with no meeting record are still listed on the Meetings page ───────── */
const { leadsWithoutMeeting } = require("./activeMeetings");

test("Meeting Booked / Meeting Done leads with no meeting record are returned so the page can list them (same cards as the Pipeline)", () => {
  const leads = [
    { id: 1, phone: "9000000001", stage: "Meeting Booked", status: "Meeting Booked" },   // has an active meeting
    { id: 2, phone: "9000000002", stage: "booked", status: "New Lead" },                  // stage only
    { id: 3, phone: "9000000003", stage: "Meeting Done", status: "Meeting Done" },        // has a completed meeting
    { id: 4, phone: "9000000004", stage: "Meeting Done", status: "Meeting Done" },        // stage only
    { id: 5, phone: "9000000005", stage: "Meeting Done", status: "Meeting Done" },        // only a SCHEDULED meeting -> still needs a held record
    { id: 6, phone: "9000000006", stage: "Conversation", status: "Conversation" },        // neither
  ];
  const base = { employeeId: 5, leadStage: "x", leadAssignedTo: 5, scheduledAt: "2026-10-09T10:00:00" };
  const annotated = [
    { ...base, id: 11, leadId: 1, leadPhone: "9000000001", status: "scheduled", isActive: true },
    { ...base, id: 13, leadId: 3, leadPhone: "9000000003", status: "completed", isActive: false },
    { ...base, id: 15, leadId: 5, leadPhone: "9000000005", status: "scheduled", isActive: false },
  ];
  assert.deepEqual(leadsWithoutMeeting(leads, annotated, "meeting_booked").map((l) => l.id), [2]);
  assert.deepEqual(leadsWithoutMeeting(leads, annotated, "meeting_done").map((l) => l.id), [4, 5]);
  // one customer with two lead records: covered once, listed once
  const dupLeads = [{ id: 7, phone: "+91 90000 00007", stage: "Meeting Booked", status: "x" }, { id: 8, phone: "9000000007", stage: "Meeting Booked", status: "x" }];
  const cover = [{ ...base, id: 21, leadId: 7, leadPhone: "9000000007", status: "scheduled", isActive: true }];
  assert.deepEqual(leadsWithoutMeeting(dupLeads, cover, "meeting_booked"), [], "same phone is the same customer");
});
