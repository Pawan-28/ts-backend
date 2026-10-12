/**
 * READ-ONLY. Why does a lead have no AI MoM / Extra Info?
 *
 *   node scripts/diagnose-lead-ai.js "Ankan Lahiri"
 *   node scripts/diagnose-lead-ai.js 9830884160
 *
 * For every matching lead it prints each call with: duration, outcome, whether a recording / transcript exists, whether the AI
 * step would even be allowed to run (the skip rule), and the text stored in ai_summary - that text is where the pipeline writes
 * the REAL reason ("GEMINI_API_KEY is not configured", "recording download failed (HTTP 403)", "Gemini ... quota", ...).
 * It also prints the lead's saved Extra Info and whether this server has a Gemini key. Nothing is written or sent.
 */
require("dotenv").config();
const pool = require("../config/db");
const { aiSummarySkipReason } = require("../src/utils/callMetrics");

const term = String(process.argv[2] || "").trim();
if (!term) {
  console.error('Usage: node scripts/diagnose-lead-ai.js "<lead name or phone>"');
  process.exit(1);
}

const clip = (s, n = 260) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

(async () => {
  const digits = term.replace(/\D/g, "");
  const leads = await pool.query(
    `SELECT id, lead_name, phone, pipeline_stage, assigned_to, source_meta FROM leads
     WHERE is_deleted = 0 AND (LOWER(lead_name) LIKE $1 ${digits.length >= 6 ? "OR REPLACE(REPLACE(REPLACE(phone, ' ', ''), '+', ''), '-', '') LIKE $2" : ""})
     ORDER BY id DESC LIMIT 5`,
    digits.length >= 6 ? [`%${term.toLowerCase()}%`, `%${digits}%`] : [`%${term.toLowerCase()}%`],
  );
  console.log(`\nGemini key on this server: ${String(process.env.GEMINI_API_KEY || "").trim() ? "present" : "MISSING"}`);
  if (!leads.rows.length) console.log("No lead found.");

  for (const lead of leads.rows) {
    let meta = lead.source_meta;
    if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch { meta = {}; } }
    console.log(`\n=== Lead ${lead.id}: ${lead.lead_name} | ${lead.phone} | stage: ${lead.pipeline_stage} ===`);
    console.log("Extra Info saved:", meta?.extraInfo ? clip(JSON.stringify(meta.extraInfo), 400) : "none");

    const calls = await pool.query(
      `SELECT id, direction, outcome, duration_sec, started_at, created_at, recording_url, transcript, ai_summary, notes, callyzer_call_id
       FROM employee_calls WHERE lead_id = $1 ORDER BY COALESCE(started_at, created_at) DESC LIMIT 20`,
      [lead.id],
    );
    if (!calls.rows.length) console.log("No calls linked to this lead.");
    for (const c of calls.rows) {
      const skip = aiSummarySkipReason(c);
      console.log(`\n  Call ${c.id} | ${c.direction} | ${c.outcome || "-"} | ${c.duration_sec || 0}s | ${c.started_at || c.created_at}`);
      console.log(`    recording: ${c.recording_url ? "yes" : "NO"} | transcript: ${c.transcript ? `${String(c.transcript).length} chars` : "none"} | callyzer id: ${c.callyzer_call_id || "none"}`);
      console.log(`    AI allowed to run: ${skip ? `NO - ${skip}` : "yes"}`);
      console.log(`    stored ai_summary: ${c.ai_summary ? clip(c.ai_summary) : "(empty - the AI step has never written anything)"}`);
      console.log(`    stored notes: ${c.notes ? clip(c.notes, 140) : "(empty)"}`);
    }
  }
  process.exit(0);
})().catch((e) => { console.error("Failed:", e.message); process.exit(1); });
