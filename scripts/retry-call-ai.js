/**
 * Re-run the AI MoM for ONE call and print exactly what happens, step by step.
 *
 *   node scripts/retry-call-ai.js <callId>            # find the id with scripts/diagnose-lead-ai.js
 *
 * This WRITES: on success it saves the MoM / transcript on that call and merges Extra Info into the lead, and it uses Gemini credits
 * (it is the same step the "Generate AI MoM" button runs). Run it yourself on the server, one call at a time.
 * On failure nothing useful is saved except the reason text, which is printed here.
 */
require("dotenv").config();
const pool = require("../config/db");
const { aiSummarySkipReason } = require("../src/utils/callMetrics");
const { processCallWithAi } = require("../src/services/aiService");

const callId = Number(process.argv[2]);
if (!Number.isFinite(callId)) {
  console.error("Usage: node scripts/retry-call-ai.js <callId>");
  process.exit(1);
}

const clip = (s, n = 600) => String(s ?? "").trim().slice(0, n);

(async () => {
  const tenantId = process.env.DEFAULT_TENANT_ID || "default";
  const row = (await pool.query(
    "SELECT id, lead_id, direction, outcome, duration_sec, recording_url, transcript FROM employee_calls WHERE id = $1 LIMIT 1",
    [callId],
  )).rows[0];
  if (!row) {
    console.error(`Call ${callId} not found.`);
    process.exit(1);
  }
  console.log(`Call ${row.id} | ${row.direction} | ${row.outcome || "-"} | ${row.duration_sec || 0}s | recording: ${row.recording_url ? "yes" : "NO"}`);
  console.log(`Recording URL host: ${row.recording_url ? new URL(row.recording_url).host : "-"}`);
  const skip = aiSummarySkipReason(row);
  if (skip) {
    console.log(`The AI is not allowed to run for this call: ${skip}`);
    process.exit(0);
  }

  // 1. can this server even download the recording?
  if (row.recording_url) {
    const t0 = Date.now();
    try {
      const res = await fetch(row.recording_url);
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`Download: HTTP ${res.status}, ${buf.length} bytes, content-type ${res.headers.get("content-type")}, ${Date.now() - t0} ms`);
      console.log(`First bytes: ${buf.slice(0, 12).toString("hex")} (${buf.slice(0, 4).toString("latin1").replace(/[^\x20-\x7e]/g, ".")})`);
    } catch (e) {
      console.log(`Download FAILED: ${e.message}`);
    }
  }

  // 2. run the real pipeline
  console.log("\nRunning the AI step (long calls take a few minutes)...\n");
  const t1 = Date.now();
  try {
    const out = await processCallWithAi(tenantId, callId);
    console.log(`\nFinished in ${Math.round((Date.now() - t1) / 1000)} s.`);
    if (out?.skipped) console.log(`Skipped: ${out.skipReason}`);
    console.log("Saved ai_summary starts with:\n" + clip(out?.ai_summary || out?.aiSummary || "(empty)"));
  } catch (e) {
    console.log(`\nThe AI step threw an error: ${e.message}`);
  }
  process.exit(0);
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
