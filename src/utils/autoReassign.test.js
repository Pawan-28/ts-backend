// Run: node --test src/utils/autoReassign.test.js
// Hot/Warm/Cold by Gemini + the 3-day stuck-lead auto-reassign: settings, target choice, counts and the wiring.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const T = require("./leadTemperature");
const { readAutoReassign, nextAutoReassign } = require("./autoReassignSettings");
const { pickTarget, summarizeClocks } = require("./autoReassignPlan");

const read = (rel) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8");

test("temperature: every spelling in the data maps to one of hot / warm / cold / not_interested", () => {
  const cases = { "Hot Lead": "hot", hot: "hot", HOT: "hot", "Warm Lead": "warm", warm: "warm", "Cold Lead": "cold", cold: "cold",
    "Not Interested": "not_interested", not_interested: "not_interested", NI: "not_interested", "not-interested": "not_interested" };
  for (const [raw, want] of Object.entries(cases)) assert.equal(T.normalizeTemperature(raw), want, raw);
  for (const raw of ["", null, undefined, "Not Pick", "Converted", "maybe"]) assert.equal(T.normalizeTemperature(raw), null, String(raw));
  assert.equal(T.temperatureLabel("hot"), "Hot Lead");
  assert.equal(T.temperatureLabel("Warm"), "Warm Lead");
  assert.equal(T.temperatureLabel("not interested"), "Not Interested");
  assert.equal(T.temperatureLabel("???"), null, "an unknown value never overwrites the lead");
});

test("temperature: the Gemini instructions carry the 7 / 30 / 90 day rule and the Not Interested option", () => {
  const p = T.temperaturePromptBlock();
  assert.match(p, /"Hot Lead": will pay within 7 days/);
  assert.match(p, /"Warm Lead": will pay within 30 days/);
  assert.match(p, /"Cold Lead": might pay within 90 days/);
  assert.match(p, /"Not Interested"/);
  assert.match(p, /Never guess/);
  assert.deepEqual(T.PAY_WINDOW_DAYS, { hot: 7, warm: 30, cold: 90 });
});

test("temperature wiring: the AI MoM uses these rules and only overwrites the lead's temperature when Gemini gave a valid one", () => {
  const ai = read("services/aiService.js");
  assert.match(ai, /\$\{temperaturePromptBlock\(\)\}/);
  assert.match(ai, /temperature = temperatureLabel\(analysis\.temperature\);/);
  assert.match(ai, /SET temperature = COALESCE\(\$1, temperature\)/);
  assert.ok(!/temperature = analysis\.temperature \|\| "Warm Lead"/.test(ai), "no silent default to Warm");
});

test("settings: OFF by default; the server stamps enabledAt when switched on and ignores a client-sent one", () => {
  assert.deepEqual(readAutoReassign(null), { enabled: false, days: 3, enabledAt: null });
  assert.deepEqual(readAutoReassign({}), { enabled: false, days: 3, enabledAt: null });
  const t1 = new Date("2026-10-08T10:00:00Z");
  const on = nextAutoReassign({}, { enabled: true, enabledAt: "1999-01-01T00:00:00Z" }, t1);
  assert.deepEqual(on, { enabled: true, days: 3, enabledAt: t1.toISOString() }, "the client cannot back-date the floor");
  const t2 = new Date("2026-10-09T10:00:00Z");
  assert.equal(nextAutoReassign({ autoReassign: on }, { enabled: true }, t2).enabledAt, t1.toISOString(), "saving again keeps the original switch-on moment");
  assert.deepEqual(nextAutoReassign({ autoReassign: on }, { enabled: false }, t2), { enabled: false, days: 3, enabledAt: null });
  assert.equal(nextAutoReassign({ autoReassign: { enabled: false } }, { enabled: true }, t2).enabledAt, t2.toISOString(), "off then on = a fresh floor");
  assert.equal(nextAutoReassign({}, { enabled: true, days: 99 }, t1).days, 30);
  assert.equal(nextAutoReassign({}, { enabled: true, days: 0 }, t1).days, 1);
  assert.equal(nextAutoReassign({}, { enabled: true, days: "abc" }, t1).days, 3);
});

test("target: least-loaded other employee; never the current owner; load is spread inside one run", () => {
  const emps = [
    { id: 10, capacity: { currentActiveLeads: 900 } },
    { id: 16, capacity: { currentActiveLeads: 40 } },
    { id: 17, capacity: { currentActiveLeads: 41 } },
  ];
  const load = new Map();
  assert.equal(pickTarget(emps, 10, load).id, 16);
  load.set("16", 42);
  assert.equal(pickTarget(emps, 10, load).id, 17, "after one lead went to 16, 17 is now the lighter one");
  assert.equal(pickTarget(emps, 16, new Map()).id, 17, "the current owner is never picked");
  assert.equal(pickTarget([{ id: 10 }], 10), null, "nobody else to give it to");
  assert.equal(pickTarget([], 10), null);
  assert.equal(pickTarget([{ id: 2 }, { id: 1 }], 99).id, 1, "ties go to the lowest id");
});

test("counts for the admin: due now / 1 / 2 / 3+ days; leads with no clock are not counted", () => {
  const m = new Map([
    ["1", { timed: true, due: true, daysLeft: 0 }], ["2", { timed: true, due: false, daysLeft: 1 }], ["3", { timed: true, due: false, daysLeft: 2 }],
    ["4", { timed: true, due: false, daysLeft: 3 }], ["5", { timed: false }],
  ]);
  assert.deepEqual(summarizeClocks(m), { total: 4, due: 1, in1Day: 1, in2Days: 1, in3PlusDays: 1 });
});

test("wiring: every stage writer stamps the stage-entry time; the worker is scheduled, capped, gated and re-checks each lead", () => {
  assert.match(read("repositories/operationalRepo.js"), /stageClockService"\)\.stampStageEntered\(/);
  assert.match(read("services/dataService.js"), /stageClockService"\)\.stampStageEntered\(/);
  assert.match(read("controllers/salesController.js"), /stageClockService"\)\.stampStageEntered\(/);
  const sched = read("jobs/schedulers.js");
  assert.match(sched, /setInterval\(autoReassignTick, autoReassignMs\)/);
  assert.match(sched, /setTimeout\(autoReassignTick, 5 \* 60 \* 1000\)/, "no burst at boot");
  const svc = read("services/autoReassignService.js");
  assert.match(svc, /if \(!settings\.enabled\) return \{ skipped: "disabled" \}/, "OFF unless an admin switched it on");
  assert.match(svc, /AUTO_REASSIGN_MAX_PER_RUN\) \|\| 50/, "a capped batch per run");
  assert.match(svc, /reason: "changed"/, "each lead is re-read before it is moved");
  assert.match(svc, /method: "auto_reassign"/);
  const routes = read("routes/operationalRoutes.js");
  assert.match(routes, /router\.get\("\/auto-reassign\/clocks"/);
  assert.match(routes, /router\.get\("\/auto-reassign\/preview"[\s\S]*?isAdminUser/);
  const settings = read("controllers/settingsController.js");
  assert.match(settings, /nextAutoReassign\(current\.settings, req\.body\.autoReassign\)/);
});

test("assignLead resolves the previous owner properly (an un-populated lead has an EMPTY assignedTo)", () => {
  const ops = read("services/operationalServices.js");
  assert.match(ops, /const fromEmployeeId = await resolveLeadAssigneeId\(tenantId, lead\);/);
  assert.ok(!/const fromEmployeeId = lead\.assignedTo\?\.id \?\? lead\.assignedTo;/.test(ops));
});

// ------------------------------------------------------------------------ who gets the lead: the lead's SERVICE GROUP
const { matchServiceForLead, candidatesForLead, bareServiceName } = require("./autoReassignPlan");
const SERVICES = [
  { name: "Podcast Interview On News Channel", serviceId: "SRV-001", distributionEnabled: true, distributionEmployeeIds: [15, 12] },
  { name: "Book Launch With Chetan Bhagat", serviceId: "SRV-010", distributionEnabled: true, distributionEmployeeIds: [12, 10] },
  { name: "Book Publishing", serviceId: "SRV-012", distributionEnabled: false, distributionEmployeeIds: [] },
  { name: "TedX", serviceId: "SRV-011", distributionEnabled: true, distributionEmployeeIds: [] },
];
const EMPS = [10, 12, 14, 15, 16, 17].map((id) => ({ id, capacity: { currentActiveLeads: 100 + id } }));

test("service of a lead: the service code first, then the exact name, then a name that contains it", () => {
  assert.equal(matchServiceForLead({ sourceMeta: { serviceId: "SRV-010" } }, SERVICES).name, "Book Launch With Chetan Bhagat");
  assert.equal(matchServiceForLead({ requirements: "[Service: Podcast Interview On News Channel] SOP: SOP-007" }, SERVICES).name, "Podcast Interview On News Channel");
  assert.equal(matchServiceForLead({ sourceMeta: { service: "book publishing" } }, SERVICES).name, "Book Publishing");
  assert.equal(matchServiceForLead({ requirements: "Podcast Interview On News Channel - 30 min" }, SERVICES).name, "Podcast Interview On News Channel");
  assert.equal(matchServiceForLead({ requirements: "something else" }, SERVICES), null);
  assert.equal(matchServiceForLead({}, SERVICES), null);
  assert.equal(bareServiceName("[Service: X Y] SOP: 1"), "X Y");
  assert.equal(bareServiceName("Service: X Y"), "X Y");
});

test("Ritik's Chetan Bhagat lead goes to the other member of that group (Sarita), never back to Ritik, never outside the group", () => {
  const lead = { sourceMeta: { serviceId: "SRV-010" } };
  const r = candidatesForLead(EMPS, lead, SERVICES, 10);
  assert.equal(r.restricted, true);
  assert.deepEqual(r.candidates.map((e) => e.id), [12]);
  assert.equal(pickTarget(r.candidates, 10).id, 12);
  assert.deepEqual(candidatesForLead(EMPS, lead, SERVICES, 12).candidates.map((e) => e.id), [10], "and Sarita's goes to Ritik");
});

test("a Podcast lead moves between Piyush and Sarita", () => {
  const lead = { requirements: "[Service: Podcast Interview On News Channel]" };
  assert.deepEqual(candidatesForLead(EMPS, lead, SERVICES, 15).candidates.map((e) => e.id), [12]);
  assert.deepEqual(candidatesForLead(EMPS, lead, SERVICES, 12).candidates.map((e) => e.id), [15]);
});

test("a group that does not include any other eligible employee leaves the lead where it is (no fallback outside the group)", () => {
  const lead = { sourceMeta: { serviceId: "SRV-001" } };
  const onlyPiyush = EMPS.filter((e) => e.id !== 12); // Sarita is paused / not eligible
  const r = candidatesForLead(onlyPiyush, lead, SERVICES, 15);
  assert.equal(r.restricted, true);
  assert.deepEqual(r.candidates, []);
  assert.equal(pickTarget(r.candidates, 15), null);
});

test("no group configured (or no service match) = any eligible employee except the owner", () => {
  for (const lead of [{ sourceMeta: { serviceId: "SRV-012" } }, { sourceMeta: { serviceId: "SRV-011" } }, { requirements: "unknown" }]) {
    const r = candidatesForLead(EMPS, lead, SERVICES, 10);
    assert.equal(r.restricted, false);
    assert.deepEqual(r.candidates.map((e) => e.id), [12, 14, 15, 16, 17]);
  }
  assert.equal(pickTarget(candidatesForLead(EMPS, { requirements: "unknown" }, SERVICES, 10).candidates, 10).id, 12, "then the least loaded");
});

test("wiring: Sunday off, service group used, reason says working days", () => {
  const svc = read("services/autoReassignService.js");
  assert.match(svc, /if \(isSunday\(now\)\) return \{ skipped: "sunday" \}/);
  assert.match(svc, /candidatesForLead\(eligible, leadLike, services, row\.assigned_to\)/);
  assert.match(svc, /no_other_employee_in_service_group/);
  assert.match(svc, /working days/);
  assert.match(read("services/stageClockService.js"), /l\.requirements, l\.insights, l\.source_meta/);
});

test("an auto-reassigned lead cannot be pulled back by the previous owner's open page; the real owner is recognised", () => {
  const routes = read("routes/operationalRoutes.js");
  assert.match(routes, /function movedAwayByAutoReassign\(lead, assignedId, selfId\)/);
  assert.match(routes, /assignmentMethod \|\| ""\) === "auto_reassign" && assignedId != null && assignedId !== selfId/);
  assert.equal((routes.match(/if \(movedAwayByAutoReassign\(lead, assignedId, selfId\)\) return res\.status\(403\)\.json\(LEAD_MOVED_BODY\);/g) || []).length, 2, "both ownership guards");
  assert.match(routes, /code: "LEAD_REASSIGNED"/);
  // the owner is read properly (an un-populated lead has an EMPTY assignedTo, which used to come out as NaN = "not yours")
  assert.match(routes, /const raw = await resolveAssigneeId\(lead, \(\) => repo\.findLeadById\(tenantId, leadId, \{ populate: true \}\)\);/);
  assert.ok(!/const raw = lead\.assignedTo\?\.id \?\? lead\.assignedTo;/.test(routes));
});
