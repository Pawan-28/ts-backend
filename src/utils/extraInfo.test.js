// Run: node --test src/utils/extraInfo.test.js
// Customer-level EXTRA INFO: built from the AI analysis of call recordings, updated over time, never guessed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EXTRA_INFO_FIELDS, isEmptyValue, normalizeExtraInfo, mergeExtraInfo, storedValues, extraInfoPromptBlock, EXTRA_INFO_JSON_EXAMPLE,
} = require("./extraInfo");

const T1 = "2026-10-01T10:00:00.000Z";
const T2 = "2026-10-05T10:00:00.000Z";
const T3 = "2026-10-09T10:00:00.000Z";

test("the profile has exactly the 12 AI fields (temperature is read from the lead, not stored)", () => {
  assert.deepEqual(EXTRA_INFO_FIELDS.map((f) => f.key), [
    "requirement", "intent", "budget", "offerQuoted", "mainConcern", "purchaseTimeline", "decisionMaker", "objection", "nextAction", "followUp", "meeting", "conversion",
  ]);
  assert.ok(!EXTRA_INFO_FIELDS.some((f) => /temperature/i.test(f.key)), "Lead Temperature keeps its existing source of truth");
});

test("'nothing was said' values are recognised and never stored", () => {
  for (const v of ["", "  ", "Not discussed", "not discussed on the call", "Not mentioned", "N/A", "none", "Unknown", "-", "No objections raised", null, undefined]) {
    assert.equal(isEmptyValue(v), true, JSON.stringify(v));
  }
  for (const v of ["Podcast", "₹2 lakh", "24-25 October"]) assert.equal(isEmptyValue(v), false);
  assert.deepEqual(normalizeExtraInfo({ budget: "Not discussed", offerQuoted: "Not discussed", intent: "Unknown", requirement: "" }), {});
});

test("normalisation: enums are exact, free text is trimmed and short, junk is dropped", () => {
  const out = normalizeExtraInfo({
    requirement: "  Podcast  ", intent: "interested but delayed", budget: "₹2 lakh", offerQuoted: "₹45,000 + 18% GST",
    mainConcern: "Certification pending", purchaseTimeline: "Tentatively 24-25 October", decisionMaker: "Owner and her partner",
    objection: "Certification delay", nextAction: "Customer to contact certification authority",
    followUp: { needed: "yes", when: "after certification update" }, meeting: "Not discussed", conversion: "not converted",
  });
  assert.equal(out.requirement, "Podcast");
  assert.equal(out.intent, "Interested but delayed");
  assert.deepEqual(out.followUp, { needed: "Yes", when: "after certification update" });
  assert.equal(out.conversion, "Not converted");
  assert.equal(out.meeting, undefined, "'Not discussed' is not stored");
  // invalid enum values are dropped, not coerced
  assert.deepEqual(normalizeExtraInfo({ intent: "very hot!!", meeting: "maybe", conversion: "sold" }), {});
  // follow-up: Yes/No only; an empty date is simply omitted
  assert.deepEqual(normalizeExtraInfo({ followUp: { needed: "No", when: "" } }).followUp, { needed: "No" });
  assert.equal(normalizeExtraInfo({ followUp: "Not discussed" }).followUp, undefined);
  // objects / arrays / non-objects never leak in as values
  assert.deepEqual(normalizeExtraInfo({ budget: { x: 1 }, requirement: ["a"] }), {});
  assert.deepEqual(normalizeExtraInfo(null), {});
  assert.deepEqual(normalizeExtraInfo("text"), {});
  assert.ok(normalizeExtraInfo({ requirement: "x".repeat(500) }).requirement.length <= 160);
});

test("CALL 1 budget not discussed -> CALL 2 customer says 2 lakh -> Extra Info becomes 2 lakh (one field, not one per call)", () => {
  const p1 = mergeExtraInfo(null, { requirement: "Podcast", budget: "Not discussed" }, { callId: 1, at: T1 });
  assert.equal(p1.fields.budget, undefined);
  assert.equal(p1.fields.requirement.value, "Podcast");
  const p2 = mergeExtraInfo(p1, { budget: "₹2 lakh" }, { callId: 2, at: T2 });
  assert.equal(storedValues(p2).budget, "₹2 lakh");
  assert.equal(Object.keys(p2.fields).filter((k) => k === "budget").length, 1);
  assert.deepEqual(p2.changed, ["budget"]);
  assert.equal(p2.fields.budget.callId, 2, "evidence points at the call it came from");
  assert.equal(storedValues(p2).requirement, "Podcast", "unrelated known fields stay");
});

test("a later call that does NOT discuss budget keeps the known budget (Not discussed never overwrites)", () => {
  let p = mergeExtraInfo(null, { budget: "₹2 lakh", mainConcern: "Certification pending" }, { callId: 2, at: T2 });
  p = mergeExtraInfo(p, { budget: "Not discussed", mainConcern: "Not discussed", requirement: "Podcast" }, { callId: 3, at: T3 });
  assert.equal(storedValues(p).budget, "₹2 lakh");
  assert.equal(storedValues(p).mainConcern, "Certification pending");
  assert.equal(storedValues(p).requirement, "Podcast");
  assert.deepEqual(p.changed, ["requirement"]);
});

test("the customer explicitly changes the information -> the newest explicit statement wins", () => {
  let p = mergeExtraInfo(null, { budget: "₹2 lakh", intent: "Considering", conversion: "Pending" }, { callId: 1, at: T1 });
  p = mergeExtraInfo(p, { budget: "₹3.5 lakh", intent: "Interested", conversion: "Converted" }, { callId: 2, at: T2 });
  assert.deepEqual(storedValues(p).budget, "₹3.5 lakh");
  assert.equal(storedValues(p).intent, "Interested");
  assert.equal(storedValues(p).conversion, "Converted");
  assert.deepEqual(p.changed.sort(), ["budget", "conversion", "intent"]);
});

test("re-processing an OLD call later can never roll back what a NEWER call said", () => {
  let p = mergeExtraInfo(null, { budget: "₹3.5 lakh" }, { callId: 2, at: T2 });
  const after = mergeExtraInfo(p, { budget: "₹2 lakh" }, { callId: 1, at: T1 }); // call 1 (older) is re-processed now
  assert.equal(storedValues(after).budget, "₹3.5 lakh");
  assert.deepEqual(after.changed, []);
});

test("the same value from a newer call only refreshes the evidence (no change reported)", () => {
  let p = mergeExtraInfo(null, { requirement: "Podcast" }, { callId: 1, at: T1 });
  p = mergeExtraInfo(p, { requirement: "Podcast" }, { callId: 3, at: T3 });
  assert.deepEqual(p.changed, []);
  assert.equal(p.fields.requirement.callId, 3);
  assert.equal(p.fields.requirement.at, T3);
});

test("merge never mutates its inputs and tolerates a missing / odd stored profile", () => {
  const stored = { fields: { budget: { value: "₹2 lakh", callId: 1, at: T1 } } };
  const snapshot = JSON.stringify(stored);
  mergeExtraInfo(stored, { budget: "₹4 lakh" }, { callId: 2, at: T2 });
  assert.equal(JSON.stringify(stored), snapshot);
  assert.deepEqual(mergeExtraInfo(undefined, {}, { callId: 1, at: T1 }).fields, {});
  assert.deepEqual(mergeExtraInfo({}, { budget: "x" }, { callId: 1, at: "not a date" }).changed, ["budget"]);
  assert.deepEqual(storedValues(null), {});
});

test("AI prompt contract: asks for every field, forbids guessing, and uses PLACEHOLDERS (never copyable example values)", () => {
  const block = extraInfoPromptBlock();
  for (const f of EXTRA_INFO_FIELDS) assert.ok(block.includes(`"${f.key}"`), `prompt mentions ${f.key}`);
  assert.match(block, /NEVER guess/);
  assert.match(block, /Not discussed/);
  assert.match(block, /Do NOT copy MoM text, transcript lines/);
  assert.match(EXTRA_INFO_JSON_EXAMPLE, /<from the transcript, or Not discussed>/);
  for (const copyable of ["Podcast", "Certification", "24-25", "lakh"]) {
    assert.ok(!EXTRA_INFO_JSON_EXAMPLE.includes(copyable) && !block.includes(copyable), `no real example value "${copyable}" in the prompt`);
  }
});

test("the existing single Gemini call carries Extra Info (no second AI pipeline) and the MoM text path is untouched", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../services/aiService.js"), "utf8");
  assert.equal((src.match(/geminiGenerateContent\(apiKey, \{/g) || []).length, 2, "still one transcription call + one MoM call");
  assert.match(src, /\$\{extraInfoPromptBlock\(\)\}/);
  assert.match(src, /extraInfoRaw = analysis\.extraInfo/);
  assert.match(src, /mergeLeadExtraInfo\(call\.lead_id, extraInfoRaw/);
  // the MoM storage is exactly as before: flattened summary + charges block, no extra info inside ai_summary
  assert.match(src, /summaryText = flattenSummaryForStorage\(rawSummary\);/);
  assert.ok(!/ai_summary[^\n]*extraInfo/i.test(src), "Extra Info is never written into ai_summary");
  // only connected calls with a transcript can feed it
  assert.match(src, /call\.lead_id && transcriptSource && extraInfoRaw/);
});
