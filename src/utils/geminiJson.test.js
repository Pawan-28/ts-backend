// Run: node --test src/utils/geminiJson.test.js
// A long call can make Gemini answer with JSON that is fenced, padded, or cut off in the middle. All of those used to end as
// "[AI SUMMARY PENDING]" (no MoM, no Extra Info). parseGeminiJson recovers what is usable.
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseGeminiJson } = require("./geminiJson");

const full = { summary: { keyHighlights: "• Customer: Anoop", callHeader: "Date: 10 Oct" }, sentiment: "positive", rating: 4, extraInfo: { budget: "2.5L" } };

test("plain, fenced and padded answers parse", () => {
  const json = JSON.stringify(full);
  assert.deepEqual(parseGeminiJson(json), full);
  assert.deepEqual(parseGeminiJson("```json\n" + json + "\n```"), full);
  assert.deepEqual(parseGeminiJson("Here is the MoM:\n" + json + "\nHope it helps."), full);
});

test("an answer cut off in the middle keeps everything that was finished", () => {
  const json = JSON.stringify(full);
  // cut inside the last string value
  const cut = json.slice(0, json.indexOf("2.5L") + 2);
  const out = parseGeminiJson(cut);
  assert.ok(out, "recovered");
  assert.equal(out.summary.keyHighlights, "• Customer: Anoop");
  assert.equal(out.sentiment, "positive");
  assert.equal(out.rating, 4);
  // cut right after a comma, and after a key with no value
  assert.ok(parseGeminiJson('{"summary":{"keyHighlights":"a"},"sentiment":"neutral",'));
  assert.equal(parseGeminiJson('{"summary":{"keyHighlights":"a"},"rating":').summary.keyHighlights, "a");
  // cut inside the summary object itself
  const inner = parseGeminiJson('{"summary":{"keyHighlights":"• Customer: A","callHeader":"Date: 1 Oct | Ti');
  assert.equal(inner.summary.keyHighlights, "• Customer: A");
});

test("garbage and empty answers give null", () => {
  for (const bad of ["", null, undefined, "I cannot help with that.", "[]x", "```"]) assert.equal(parseGeminiJson(bad), null, String(bad));
});

test("strings containing braces, quotes and escapes do not confuse the repair", () => {
  const cut = '{"summary":{"keyHighlights":"say \\"hi\\" {not a brace}","callHeader":"x';
  const out = parseGeminiJson(cut);
  assert.equal(out.summary.keyHighlights, 'say "hi" {not a brace}');
});
