// Run: node --test src/services/momRetry.test.js
// A call whose Gemini MoM answer fails once (overload) or comes back cut off used to stay "MoM not generated yet" for ever.
// Real aiService, fake database and a fake Gemini (global fetch).
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.GEMINI_API_KEY = "test-key";
process.env.GEMINI_CALL_MODEL = "gemini-test-flash";

const dbPath = require.resolve("../../config/db");
const writes = [];
const callRow = {
  id: 77, lead_id: 5, tenant_id: "default", employee_id: 3, direction: "outbound", outcome: "connected", duration_sec: 97,
  recording_url: "https://example.test/a.mp3", transcript: "Rep: Hello. Client: I want a book launch, budget two and a half lakh.",
  lead_name: "Anoop Sao", lead_phone: "9919425115", company_name: "FightBackk", lead_status: "Conversation", lead_requirements: "Book Launch",
  started_at: "2026-10-11T09:00:00Z",
};
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    query: async (sql, params) => {
      if (/^\s*UPDATE employee_calls/i.test(sql)) writes.push({ sql, params });
      if (/FROM employee_calls c\s+LEFT JOIN leads l/i.test(sql)) return { rows: [callRow] };
      return { rows: [], rowCount: 0 };
    },
  },
};

const good = {
  summary: { keyHighlights: "• Customer: Anoop Sao", callHeader: "Date: 11 Oct", discussionHighlights: "x", qualificationsMet: "y", actionItems: "z" },
  sentiment: "positive", rating: 4, competencyScores: {}, checklistProgress: [],
};
const geminiOk = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: {} }), text: async () => "" });
const geminiErr = (status, msg) => ({ ok: false, status, json: async () => ({}), text: async () => JSON.stringify({ error: { message: msg } }) });

const realFetch = global.fetch;
const realSetTimeout = global.setTimeout;
test.before(() => { global.setTimeout = (fn, ms, ...a) => realSetTimeout(fn, Math.min(ms || 0, 5), ...a); }); // no 3 s waits in the test
test.after(() => { global.fetch = realFetch; global.setTimeout = realSetTimeout; });

const { processCallWithAi } = require("./aiService");
const lastSummary = () => writes[writes.length - 1]?.params?.[2] || "";

test("an overloaded answer (503) is retried and the MoM is saved", async () => {
  writes.length = 0;
  const answers = [geminiErr(503, "model overloaded"), geminiOk(JSON.stringify(good))];
  let calls = 0;
  global.fetch = async () => { calls += 1; return answers.shift(); };
  await processCallWithAi("default", 77);
  assert.equal(calls, 2);
  assert.match(lastSummary(), /Customer: Anoop Sao/);
  assert.ok(!/AI SUMMARY PENDING/.test(lastSummary()));
});

test("an answer cut off in the middle is repaired instead of being thrown away", async () => {
  writes.length = 0;
  const cut = JSON.stringify(good).slice(0, JSON.stringify(good).indexOf("qualificationsMet") + 30);
  global.fetch = async () => geminiOk(cut);
  await processCallWithAi("default", 77);
  assert.match(lastSummary(), /Customer: Anoop Sao/, "the finished parts are kept");
  assert.ok(!/AI SUMMARY PENDING/.test(lastSummary()));
});

test("when it keeps failing, the REASON is stored with the call", async () => {
  writes.length = 0;
  let calls = 0;
  global.fetch = async () => { calls += 1; return geminiErr(429, "Resource has been exhausted (quota)"); };
  await processCallWithAi("default", 77);
  assert.equal(calls, 3, "first try + 2 retries");
  assert.match(lastSummary(), /\[AI SUMMARY PENDING\]/);
  assert.match(lastSummary(), /Reason: Gemini 429: Resource has been exhausted/);
});

test("a permanent error (400) is not retried", async () => {
  writes.length = 0;
  let calls = 0;
  global.fetch = async () => { calls += 1; return geminiErr(400, "API key not valid"); };
  await processCallWithAi("default", 77);
  assert.equal(calls, 1);
  assert.match(lastSummary(), /Reason: Gemini 400: API key not valid/);
});
