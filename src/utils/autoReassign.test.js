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
