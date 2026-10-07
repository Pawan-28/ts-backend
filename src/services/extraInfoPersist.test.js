// Run: node --test src/services/extraInfoPersist.test.js
// The database side of Extra Info (aiService.mergeLeadExtraInfo) against a FAKE pool - no real database is touched.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// stub config/db BEFORE aiService is loaded
const dbPath = require.resolve(path.resolve(__dirname, "../../config/db"));
const queries = [];
let leadRow = null;
const fakePool = {
  query: async (sql, params = []) => {
    queries.push({ sql, params });
    if (/^\s*SELECT source_meta FROM leads/i.test(sql)) return { rows: leadRow ? [{ source_meta: leadRow.source_meta }] : [] };
    if (/^\s*UPDATE leads SET source_meta/i.test(sql)) { leadRow = { source_meta: params[0] }; return { rows: [], rowCount: 1 }; }
    throw new Error(`unexpected SQL in test: ${sql}`);
  },
};
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakePool };
const { mergeLeadExtraInfo } = require("./aiService");
const { storedValues } = require("../utils/extraInfo");

const T1 = "2026-10-01T10:00:00.000Z";
const T2 = "2026-10-05T10:00:00.000Z";
const reset = (meta) => { queries.length = 0; leadRow = { source_meta: meta }; };
const saved = () => JSON.parse(leadRow.source_meta);

test("writes the customer's Extra Info into leads.source_meta and keeps every other key (utm, integration, ...)", async () => {
  reset(JSON.stringify({ integration: "n8n", utm_source: "meta", sopId: "SOP-1" }));
  const changed = await mergeLeadExtraInfo(77, { requirement: "Podcast", budget: "Not discussed", intent: "Considering" }, { callId: 1, at: T1 });
  assert.deepEqual(changed.sort(), ["intent", "requirement"]);
  const meta = saved();
  assert.equal(meta.integration, "n8n");
  assert.equal(meta.utm_source, "meta");
  assert.equal(meta.sopId, "SOP-1");
  assert.deepEqual(storedValues(meta.extraInfo), { requirement: "Podcast", intent: "Considering" });
  assert.equal(meta.extraInfo.fields.requirement.callId, 1);
  // exactly one read + one write, scoped to that lead, and only the source_meta column is written
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map((q) => q.sql.trim().split(/\s+/).slice(0, 3).join(" ").toUpperCase()), ["SELECT SOURCE_META FROM", "UPDATE LEADS SET"]);
  assert.match(queries[1].sql, /SET source_meta = \$1 WHERE id = \$2/);
  assert.equal(queries[1].params[1], 77);
});

test("a second call updates the SAME profile (later explicit value wins, 'Not discussed' keeps the known one)", async () => {
  reset(JSON.stringify({ integration: "n8n" }));
  await mergeLeadExtraInfo(77, { budget: "Not discussed", requirement: "Podcast" }, { callId: 1, at: T1 });
  await mergeLeadExtraInfo(77, { budget: "₹2 lakh" }, { callId: 2, at: T2 });
  assert.equal(storedValues(saved().extraInfo).budget, "₹2 lakh");
  await mergeLeadExtraInfo(77, { budget: "Not discussed", requirement: "Podcast" }, { callId: 3, at: "2026-10-09T10:00:00.000Z" });
  assert.equal(storedValues(saved().extraInfo).budget, "₹2 lakh");
  assert.equal(saved().integration, "n8n");
});

test("nothing new -> no write at all (and a call with only 'Not discussed' never touches the lead)", async () => {
  reset(JSON.stringify({}));
  const changed = await mergeLeadExtraInfo(77, { budget: "Not discussed", intent: "Unknown", requirement: "" }, { callId: 1, at: T1 });
  assert.deepEqual(changed, []);
  assert.equal(queries.filter((q) => /^\s*UPDATE/i.test(q.sql)).length, 0);
});

test("tolerates an object / null / invalid-JSON source_meta and an unknown lead", async () => {
  leadRow = { source_meta: { utm_source: "x" } };
  assert.deepEqual(await mergeLeadExtraInfo(1, { requirement: "A" }, { callId: 1, at: T1 }), ["requirement"]);
  assert.equal(saved().utm_source, "x");
  reset(null);
  assert.deepEqual(await mergeLeadExtraInfo(1, { requirement: "A" }, { callId: 1, at: T1 }), ["requirement"]);
  reset("{not json");
  assert.deepEqual(await mergeLeadExtraInfo(1, { requirement: "A" }, { callId: 1, at: T1 }), ["requirement"]);
  leadRow = null;
  assert.deepEqual(await mergeLeadExtraInfo(404, { requirement: "A" }, { callId: 1, at: T1 }), []);
});

test("re-processing an older call cannot roll the stored profile back", async () => {
  reset(JSON.stringify({}));
  await mergeLeadExtraInfo(77, { budget: "₹3 lakh" }, { callId: 2, at: T2 });
  const changed = await mergeLeadExtraInfo(77, { budget: "₹2 lakh" }, { callId: 1, at: T1 });
  assert.deepEqual(changed, []);
  assert.equal(storedValues(saved().extraInfo).budget, "₹3 lakh");
});
