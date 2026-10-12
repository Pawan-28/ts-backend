// Run: node --test src/utils/unratedBucket.test.js
// F-08: a lead with no temperature yet (blank until Gemini / the rep sets it) used to be counted as "Warm" on the Dashboard funnel.
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./metricDefinitions");
const { buildPipelineStatusGridFromKanban } = require("./leadKanban");

const row = (id, temperature, extra = {}) => ({ id, assigned_to: 1, pipeline_stage: "Lead", status: "", temperature, ...extra });

test("blank / unknown temperature is Unrated, not Warm", () => {
  assert.equal(M.leadTemperature({ temperature: "" }), "Unrated");
  assert.equal(M.leadTemperature({ temperature: null }), "Unrated");
  assert.equal(M.leadTemperature({}), "Unrated");
  assert.equal(M.leadTemperature({ temperature: "Not Interested" }), "Unrated");
  assert.equal(M.leadTemperature({ temperature: "Hot Lead" }), "Hot");
  assert.equal(M.leadTemperature({ temperature: "Warm Lead" }), "Warm");
  assert.equal(M.leadTemperature({ temperature: "Cold" }), "Cold");
  assert.deepEqual(M.TEMPS, ["Hot", "Warm", "Cold", "Unrated"]);
});

test("the funnel summary keeps every lead: Warm no longer swallows the blanks", () => {
  const rows = [row(1, "Hot Lead"), row(2, "Warm Lead"), row(3, "Cold Lead"), row(4, null), row(5, ""), row(6, null)];
  const s = M.summarizeLeadUniverse(rows);
  assert.deepEqual(s.tempTotals, { Hot: 1, Warm: 1, Cold: 1, Unrated: 3 });
  assert.equal(Object.values(s.tempTotals).reduce((a, b) => a + b, 0), s.total, "no lead is lost");
});

test("the kanban-based grid agrees", () => {
  const g = buildPipelineStatusGridFromKanban({ conversation_2min: [{ id: 1, temperature: "Warm" }, { id: 2, temperature: null }] });
  assert.equal(g.tempTotals.Warm, 1);
  assert.equal(g.tempTotals.Unrated, 1);
  assert.equal(g.totalLeads, 2);
});
