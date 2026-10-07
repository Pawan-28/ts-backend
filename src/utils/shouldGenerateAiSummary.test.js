const test = require("node:test");
const assert = require("node:assert/strict");
const { shouldGenerateAiSummary, aiSummarySkipReason } = require("./callMetrics");

// Shapes mirror employee_calls rows (snake_case) and mapCall() API objects (camelCase).
const REC = "https://cdn.example.com/rec/abc.mp3";

test("not-connected 0:00 outbound call (the Vivek Singh case) is skipped", () => {
  const call = { direction: "outbound", outcome: "Not Connected", duration_sec: 0, recording_url: null, transcript: null };
  assert.equal(shouldGenerateAiSummary(call), false);
  assert.match(aiSummarySkipReason(call), /not connected/i);
});

test("rejected outbound call is skipped", () => {
  assert.equal(shouldGenerateAiSummary({ direction: "outbound", outcome: "Rejected", duration_sec: 0 }), false);
});

test("missed inbound call is skipped", () => {
  assert.equal(shouldGenerateAiSummary({ direction: "inbound", outcome: "Missed", durationSec: 0 }), false);
});

test("5-second 'Not connected' call is skipped even with a recording", () => {
  const call = { direction: "outbound", outcome: "Not connected", duration_sec: 5, recording_url: REC };
  assert.equal(shouldGenerateAiSummary(call), false);
});

test("inbound 'Not Connected' call with ringing duration is skipped", () => {
  assert.equal(shouldGenerateAiSummary({ direction: "inbound", outcome: "Not Connected", duration_sec: 22, recording_url: REC }), false);
});

test("connected 2-minute call with a recording is summarized", () => {
  const call = { direction: "outbound", outcome: "Connected", duration_sec: 120, recording_url: REC, transcript: null };
  assert.equal(shouldGenerateAiSummary(call), true);
  assert.equal(aiSummarySkipReason(call), null);
});

test("connected inbound call with transcript but no recording is summarized", () => {
  assert.equal(shouldGenerateAiSummary({ direction: "inbound", outcome: "Connected", duration_sec: 95, transcript: "Rep: Hello ..." }), true);
});

test("connected call with no recording and no transcript has nothing to summarize", () => {
  const call = { direction: "outbound", outcome: "Connected", duration_sec: 180, recording_url: "", transcript: "" };
  assert.equal(shouldGenerateAiSummary(call), false);
  assert.match(aiSummarySkipReason(call), /no recording or transcript/i);
});

test("camelCase API shape and 'm:ss' duration strings are understood", () => {
  assert.equal(shouldGenerateAiSummary({ direction: "outbound", outcome: "Connected", duration: "2:00", recordingUrl: REC }), true);
  assert.equal(shouldGenerateAiSummary({ direction: "outbound", outcome: "Connected", duration: "0:00", recordingUrl: REC }), false);
});

test("empty / missing call is skipped", () => {
  assert.equal(shouldGenerateAiSummary({}), false);
  assert.equal(shouldGenerateAiSummary(), false);
});
