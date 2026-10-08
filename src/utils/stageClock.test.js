// Run: node --test src/utils/stageClock.test.js
// The 3-day stuck-lead clock: when did the lead enter its stage, how long is left, which leads have no clock.
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeStageClock, autoAssignLabel, entryFromCalls, callColumn, DAY_MS } = require("./stageClock");

const NOW = Date.parse("2026-10-08T12:00:00Z");
const ago = (days, hours = 0) => new Date(NOW - days * DAY_MS - hours * 3600 * 1000).toISOString();
const clock = (p) => computeStageClock({ now: NOW, ...p });
const call = (daysAgo, props = {}) => ({ startedAt: ago(daysAgo), direction: "outbound", outcome: "Not Answered", durationSec: 0, ...props });
const answered = (daysAgo, sec, props = {}) => call(daysAgo, { outcome: "Connected", durationSec: sec, ...props });

test("a fresh assigned lead with no call: 3 days from assignment, counting down 3 -> 2 -> 1 -> due", () => {
  const c = (assigned) => clock({ stage: "Lead", assignedAt: assigned });
  assert.equal(c(ago(0, 1)).daysLeft, 3);
  assert.equal(autoAssignLabel(c(ago(0, 1))), "3 days to auto-assign");
  assert.equal(c(ago(1, 1)).daysLeft, 2);
  assert.equal(autoAssignLabel(c(ago(1, 1))), "2 days to auto-assign");
  assert.equal(autoAssignLabel(c(ago(2, 1))), "1 day to auto-assign");
  assert.equal(c(ago(3)).due, true, "exactly 3 days = due");
  assert.equal(autoAssignLabel(c(ago(3, 1))), "Auto-assigning soon");
  assert.equal(c(ago(2, 23)).due, false);
});

test("calls: the FIRST call that put the lead in Not Pick starts the clock; more not-picked calls do not restart it", () => {
  const calls = [call(2.5), call(1), call(0.1)];
  const c = clock({ stage: "Lead", assignedAt: ago(10), calls });
  assert.equal(c.column, "not_pick");
  assert.equal(c.enteredAt.toISOString(), ago(2.5));
  assert.equal(c.daysLeft, 1);
});

test("moving forward restarts the clock: a short answered call after the not-picks", () => {
  const calls = [call(2.5), answered(1, 30)];
  const c = clock({ stage: "Lead", assignedAt: ago(10), calls });
  assert.equal(c.column, "short_call");
  assert.equal(c.enteredAt.toISOString(), ago(1));
  assert.equal(c.daysLeft, 2);
  // an answered call above 2 min lifts it into Conversation: no clock from then on
  const conv = clock({ stage: "Lead", assignedAt: ago(10), calls: [...calls, answered(0.5, 400)] });
  assert.equal(conv.timed, false);
  assert.equal(conv.column, "conversation_2min");
  assert.equal(autoAssignLabel(conv), null);
});

test("call classes: exactly 120 s is Short Call, 121 s is Conversation; missed / rejected / incoming short follow the Pipeline", () => {
  assert.equal(callColumn(answered(1, 120)), "short_call");
  assert.equal(callColumn(answered(1, 121)), "conversation_2min");
  assert.equal(callColumn(answered(1, 33, { direction: "inbound" })), "short_call");
  assert.equal(callColumn(call(1, { direction: "inbound", outcome: "Missed" })), "not_pick");
  assert.equal(callColumn(call(1, { outcome: "Rejected" })), "not_pick");
});

test("a stored stage move that is further along than the calls wins, from the time of the move", () => {
  const c = clock({ stage: "Short Call", stageEnteredAt: ago(1), assignedAt: ago(20), calls: [call(5)] });
  assert.equal(c.column, "short_call");
  assert.equal(c.enteredAt.toISOString(), ago(1));
  assert.equal(c.daysLeft, 2);
  assert.equal(clock({ stage: "Conversation", stageEnteredAt: ago(1), assignedAt: ago(20), calls: [call(5)] }).timed, false, "a stored Conversation has no clock");
});

test("same stage in the stored data and in the calls: in the stage since the EARLIER of the two", () => {
  const c = clock({ stage: "Not Pick", stageEnteredAt: ago(0.5), assignedAt: ago(30), calls: [call(2)] });
  assert.equal(c.enteredAt.toISOString(), ago(2));
});

test("legacy stage names map like the Pipeline (Attempted = Not Pick, Contacted = Conversation = no clock)", () => {
  assert.equal(clock({ stage: "Attempted", assignedAt: ago(1) }).column, "not_pick");
  assert.equal(clock({ stage: "Contacted", assignedAt: ago(1) }).timed, false);
  assert.equal(clock({ stage: "Qualified", assignedAt: ago(1) }).timed, false);
  assert.equal(clock({ stage: "Not Contacted", assignedAt: ago(1) }).column, "lead");
});

test("re-assignment restarts the window", () => {
  const c = clock({ stage: "Lead", assignedAt: ago(0, 1), calls: [call(2.9)] });
  assert.equal(c.daysLeft, 3, "a new owner gets the full window even though the lead entered Not Pick days ago");
});

test("floorAt (the moment the feature was switched on) protects old leads from being recycled at once", () => {
  const c = clock({ stage: "Lead", assignedAt: ago(40), createdAt: ago(60), calls: [call(30)], floorAt: ago(0, 2) });
  assert.equal(c.due, false);
  assert.equal(c.daysLeft, 3);
  const without = clock({ stage: "Lead", assignedAt: ago(40), calls: [call(30)] });
  assert.equal(without.due, true);
});

test("no clock for: later stages, Not Interested (stage or AI temperature), and leads with no usable time", () => {
  for (const stage of ["Conversation", "Conversation 2 min+", "Meeting Booked", "Meeting Done", "Proposal Sent", "Objection", "Advance Paid", "Payment Complete", "Not Interested"]) {
    const c = clock({ stage, assignedAt: ago(20) });
    assert.equal(c.timed, false, stage);
    assert.equal(autoAssignLabel(c), null);
  }
  assert.equal(clock({ stage: "Lead", temperature: "Not Interested", assignedAt: ago(20) }).timed, false);
  assert.equal(clock({ stage: "Lead", temperature: "Hot Lead", assignedAt: ago(1) }).timed, true);
  assert.equal(clock({ stage: "Lead" }).timed, false, "nothing to start the clock from");
});

test("entryFromCalls ignores calls without a time and picks the furthest column", () => {
  assert.equal(entryFromCalls([]), null);
  assert.equal(entryFromCalls([{ outcome: "Connected", durationSec: 200 }]), null, "no timestamp");
  const e = entryFromCalls([answered(3, 10), answered(2, 500), answered(1, 700)]);
  assert.equal(e.column, "conversation_2min");
  assert.equal(new Date(e.enteredAtMs).toISOString(), ago(2));
});

test("window length is configurable", () => {
  assert.equal(clock({ stage: "Lead", assignedAt: ago(1), days: 5 }).daysLeft, 4);
});

// ---------------------------------------------------------------------------------------------------- Sunday
// 2026-10-03 is a Saturday, 2026-10-04 a Sunday, 2026-10-05 a Monday (India time = UTC + 5:30).
const ist = (iso) => Date.parse(`${iso}+05:30`);
const nowAt = (iso) => ({ now: ist(iso) });

test("Sunday does not count: a lead that enters on Saturday noon is due on WEDNESDAY noon, not Tuesday", () => {
  const c = computeStageClock({ stage: "Lead", assignedAt: new Date(ist("2026-10-03T12:00:00")), ...nowAt("2026-10-05T09:00:00") });
  assert.equal(c.deadlineAt.getTime(), ist("2026-10-07T12:00:00"), "Sat 12h + Mon 24h + Tue 24h + Wed 12h");
  assert.equal(c.due, false);
  const noSunday = computeStageClock({ stage: "Lead", assignedAt: new Date(ist("2026-10-06T12:00:00")), ...nowAt("2026-10-06T12:00:00") });
  assert.equal(noSunday.deadlineAt.getTime(), ist("2026-10-09T12:00:00"), "a window with no Sunday in it is exactly 3 days");
});

test("the timer STOPS on Sunday: the time left is the same all day Sunday", () => {
  const base = { stage: "Lead", assignedAt: new Date(ist("2026-10-03T12:00:00")) };
  const morning = computeStageClock({ ...base, ...nowAt("2026-10-04T00:30:00") });
  const night = computeStageClock({ ...base, ...nowAt("2026-10-04T23:30:00") });
  assert.equal(morning.paused, true);
  assert.equal(night.paused, true);
  assert.equal(morning.msLeft, night.msLeft, "frozen");
  assert.equal(morning.msLeft, 60 * 3600 * 1000, "60 working hours left (Mon + Tue + Wed noon... = 3 days minus Saturday's 12h)");
  assert.equal(autoAssignLabel(morning), "Paused on Sunday \u00b7 3 days left");
  const monday = computeStageClock({ ...base, ...nowAt("2026-10-05T00:30:00") });
  assert.equal(monday.paused, false);
  assert.equal(monday.msLeft, morning.msLeft - 30 * 60 * 1000, "it runs again from Monday");
});

test("a lead that enters on a Sunday starts counting on Monday", () => {
  const c = computeStageClock({ stage: "Lead", assignedAt: new Date(ist("2026-10-04T10:00:00")), ...nowAt("2026-10-04T11:00:00") });
  assert.equal(c.deadlineAt.getTime(), ist("2026-10-08T00:00:00"), "Mon 00:00 + 3 days = Thursday 00:00");
  assert.equal(c.daysLeft, 3);
});

test("a window that ends before any Sunday is unchanged; counting down 3 -> 2 -> 1 uses working days", () => {
  const assigned = new Date(ist("2026-10-05T10:00:00"));
  const left = (iso) => computeStageClock({ stage: "Lead", assignedAt: assigned, ...nowAt(iso) }).daysLeft;
  assert.equal(left("2026-10-05T10:00:01"), 3);
  assert.equal(left("2026-10-06T11:00:00"), 2);
  assert.equal(left("2026-10-07T11:00:00"), 1);
  assert.equal(computeStageClock({ stage: "Lead", assignedAt: assigned, ...nowAt("2026-10-08T10:00:00") }).due, true);
});
