// Run: node --test src/utils/blankTemperature.test.js
// Hot / Warm / Cold is BLANK until Gemini (after a connected call) or a person sets it: no insert path invents one.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (rel) => fs.readFileSync(path.join(__dirname, "../..", rel), "utf8");

test("intake: only an EXPLICIT temperature counts - never guessed from status / priority", () => {
  const ops = read("src/services/operationalServices.js");
  assert.match(ops, /temperature: normalizeTemperature\(input\.temperature\),/);
  assert.ok(!/normalizeTemperature\(input\.temperature \|\| input\.status/.test(ops));
  const fn = ops.slice(ops.indexOf("function normalizeTemperature"), ops.indexOf("function normalizePriority"));
  assert.match(fn, /if \(!s\) return null;/);
  assert.match(fn, /return null;\s*\n\}/, "an unknown value is blank too, not warm");
  assert.ok(!/return "warm";\s*\n\}/.test(fn), "no more default Warm");
});

test("every insert stores NULL when there is no temperature (the column default 'warm' is never used)", () => {
  assert.match(read("src/repositories/operationalRepo.js"), /data\.temperature \|\| null,/);
  assert.ok(!/data\.temperature \|\| "warm"/.test(read("src/repositories/operationalRepo.js")));
  const routes = read("src/routes/operationalRoutes.js");
  assert.match(routes, /temperature: leadData\.temperature \|\| null,/);
  assert.ok(!/temperature: "warm"/.test(routes), "a lead made from a Callyzer call is blank too");
  assert.match(read("src/services/callyzerService.js"), /"new", "new", null, employeeId, "Callyzer"/);
  const sales = read("src/controllers/salesController.js");
  assert.ok(!/temperature \|\| "Cold Lead"/.test(sales));
  assert.match(sales, /temperature=COALESCE\(\$18, temperature\)/, "an edit that does not mention temperature keeps what the lead has");
  assert.match(read("database/init.js"), /temperature VARCHAR\(50\) DEFAULT NULL,/);
});

test("Gemini is the one that fills it in, after a connected call", () => {
  const ai = read("src/services/aiService.js");
  assert.match(ai, /SET temperature = COALESCE\(\$1, temperature\)/);
  assert.match(ai, /temperaturePromptBlock/);
});

test("the one-time clean-up script is a dry run unless --apply is given, backs up first, and can undo", () => {
  const s = read("scripts/blank-default-temperature.js");
  assert.match(s, /const APPLY = process\.argv\.includes\("--apply"\)/);
  assert.match(s, /if \(!APPLY\) \{[\s\S]*?process\.exit\(0\);/);
  assert.ok(s.indexOf("fs.writeFileSync(file") < s.indexOf("UPDATE leads SET temperature = NULL"), "the backup is written BEFORE the update");
  assert.match(s, /temperature = BINARY 'warm'/, "only the bare default, case-sensitive");
  assert.match(s, /--restore/);
});

test("Gemini says Not Interested -> the lead goes to the Not Interested stage (early funnel only, latest call only)", () => {
  const ai = read("src/services/aiService.js");
  assert.match(ai, /if \(temperature === "Not Interested"\) \{[\s\S]{0,200}moveLeadToNotInterestedIfEarly\(\{ tenantId, call \}\)/);
  const fn = ai.slice(ai.indexOf("async function moveLeadToNotInterestedIfEarly"), ai.indexOf("/** Merge one call's AI extraInfo"));
  assert.match(ai, /const NOT_INTERESTED_FROM = new Set\(\["lead", "not_pick", "short_call", "conversation_2min"\]\);/, "meeting booked / done / proposal / objection / paid are never dropped");
  assert.match(fn, /if \(!NOT_INTERESTED_FROM\.has\(mapStageToId\(lead\.pipeline_stage, lead\.status\)\)\) return false;/);
  assert.match(fn, /COALESCE\(started_at, created_at\) > \$2 LIMIT 1/, "an old call that is re-processed cannot undo a newer conversation");
  assert.match(fn, /stage: "Not Interested"/);
  assert.match(fn, /actorName: "Gemini AI"/);
  assert.match(ai, /moveLeadToNotInterestedIfEarly, \/\/ exported for tests/);
});
