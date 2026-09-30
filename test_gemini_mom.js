// Real end-to-end check of the Gemini call MoM on ONE actual call.
//   node test_gemini_mom.js            → latest call that has a recording
//   node test_gemini_mom.js 15269      → a specific employee_calls.id
// Uses the server's existing .env / environment (GEMINI_API_KEY, DB_*). Never prints the key.
// It re-processes that call exactly like the "Re-process AI MoM" button (updates the same row).
require("dotenv").config({ quiet: true });
const pool = require("./config/db");
const { processCallWithAi } = require("./src/services/aiService");

(async () => {
  if (!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in this environment.");
    process.exit(1);
  }
  const tenantId = process.env.CALLYZER_TENANT_ID || "default";

  // Which models can this key use?
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", {
    headers: { "x-goog-api-key": process.env.GEMINI_API_KEY },
  });
  const data = await res.json().catch(() => ({}));
  const usable = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => m.name.replace(/^models\//, ""))
    .filter((n) => n.startsWith("gemini-"));
  console.log(`Models list HTTP ${res.status}. generateContent models:`, usable.join(", ") || "(none)");

  let callId = process.argv[2];
  if (!callId) {
    const r = await pool.query(
      `SELECT id FROM employee_calls
       WHERE recording_url IS NOT NULL AND recording_url <> '' AND COALESCE(duration_sec, 0) >= 30
       ORDER BY COALESCE(started_at, created_at) DESC LIMIT 1`,
    );
    callId = r.rows[0]?.id;
  }
  if (!callId) {
    console.error("No call with a recording found.");
    process.exit(1);
  }

  console.log(`\nProcessing call #${callId} …`);
  const started = Date.now();
  const call = await processCallWithAi(tenantId, callId);
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

  const transcript = String(call.transcript || "");
  console.log("=== TRANSCRIPT (first 600 chars, original language) ===");
  console.log(transcript.slice(0, 600) || "(none)");
  console.log("\n=== AI MoM saved to the call (ai_summary) ===");
  console.log(call.ai_summary);
  const devanagari = (String(call.ai_summary).match(/[ऀ-ॿ]/g) || []).length;
  console.log(`\nMoM language check: ${devanagari === 0 ? "ENGLISH ✓" : `contains ${devanagari} Hindi characters ✗`}`);
  console.log("checklist_progress:", JSON.stringify(call.checklist_progress));
  console.log("competency_scores:", JSON.stringify(call.competency_scores));
  process.exit(0);
})().catch((err) => {
  console.error("Test failed:", err.message);
  process.exit(1);
});
