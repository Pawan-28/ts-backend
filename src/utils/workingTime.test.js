// Run: node --test src/utils/workingTime.test.js
// Working time = every hour except Sunday (India time). Identical on the server and in the browser.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const wt = require("./workingTime");

const H = 3600 * 1000;
const ist = (iso) => Date.parse(`${iso}+05:30`);

test("isSunday uses India time: Sunday 00:00 IST is already Sunday, Saturday 23:59 IST is not", () => {
  assert.equal(wt.isSunday(ist("2026-10-04T00:00:00")), true);
  assert.equal(wt.isSunday(ist("2026-10-04T23:59:59")), true);
  assert.equal(wt.isSunday(ist("2026-10-03T23:59:59")), false);
  assert.equal(wt.isSunday(ist("2026-10-05T00:00:00")), false);
  assert.equal(wt.isSunday(Date.parse("2026-10-03T19:00:00Z")), true, "19:00 UTC Saturday = 00:30 IST Sunday");
});

test("addWorkingMs skips Sunday and never lands inside one", () => {
  assert.equal(wt.addWorkingMs(ist("2026-10-06T12:00:00"), 72 * H), ist("2026-10-09T12:00:00"), "no Sunday: plain 72 hours");
  assert.equal(wt.addWorkingMs(ist("2026-10-03T12:00:00"), 72 * H), ist("2026-10-07T12:00:00"), "Saturday noon + 72 working h = Wednesday noon");
  assert.equal(wt.addWorkingMs(ist("2026-10-04T10:00:00"), 72 * H), ist("2026-10-08T00:00:00"), "starting on a Sunday = counting from Monday 00:00");
  assert.equal(wt.addWorkingMs(ist("2026-10-03T20:00:00"), 4 * H), ist("2026-10-04T00:00:00"), "working time used up exactly at Saturday midnight = Sunday 00:00 (the worker does not run on Sunday, so it moves on Monday)");
  assert.equal(wt.addWorkingMs(1000, 0), 1000);
  assert.equal(wt.addWorkingMs(1000, -5), 1000);
  // two Sundays inside a long window
  assert.equal(wt.addWorkingMs(ist("2026-10-03T12:00:00"), 9 * 24 * H), ist("2026-10-14T12:00:00"));
});

test("workingMsBetween counts everything except Sunday", () => {
  assert.equal(wt.workingMsBetween(ist("2026-10-03T12:00:00"), ist("2026-10-05T12:00:00")), 24 * H, "Sat 12h + Mon 12h");
  assert.equal(wt.workingMsBetween(ist("2026-10-04T01:00:00"), ist("2026-10-04T23:00:00")), 0, "all inside Sunday");
  assert.equal(wt.workingMsBetween(ist("2026-10-05T10:00:00"), ist("2026-10-05T09:00:00")), 0, "b <= a");
  assert.equal(wt.workingMsBetween(ist("2026-10-05T00:00:00"), ist("2026-10-12T00:00:00")), 6 * 24 * H, "a whole week = 6 working days");
});

test("addWorkingMs and workingMsBetween are inverses", () => {
  const starts = [ist("2026-10-03T12:00:00"), ist("2026-10-04T10:00:00"), ist("2026-10-07T23:59:00"), ist("2026-10-01T00:00:00")];
  for (const a of starts) {
    for (const d of [0.5 * H, 5 * H, 24 * H, 72 * H, 200 * H]) {
      const b = wt.addWorkingMs(a, d);
      assert.equal(wt.workingMsBetween(a, b), d, `from ${new Date(a).toISOString()} + ${d / H}h`);
    }
  }
});

test("the browser copy gives the same answers as the server copy", async () => {
  const fe = await import(pathToFileURL(path.resolve(__dirname, "../../../frontend/src/lib/workingTime.js")).href);
  for (let t = ist("2026-09-28T00:00:00"); t < ist("2026-10-20T00:00:00"); t += 7 * H + 13 * 60000) {
    assert.equal(fe.isSunday(t), wt.isSunday(t));
    assert.equal(fe.addWorkingMs(t, 72 * H), wt.addWorkingMs(t, 72 * H));
    assert.equal(fe.workingMsBetween(t, t + 100 * H), wt.workingMsBetween(t, t + 100 * H));
  }
});
