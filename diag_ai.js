require("dotenv").config();
const pool = require("./config/db");

async function check() {
  // Find calls that have recording but ai_summary is a fallback/empty/placeholder
  const calls = await pool.query(`
    SELECT id, callyzer_call_id, recording_url, ai_summary, outcome, duration_sec, started_at
    FROM employee_calls
    WHERE recording_url IS NOT NULL AND recording_url <> ''
    ORDER BY id DESC LIMIT 10
  `);
  console.log("\n=== CALLS WITH RECORDINGS (latest 10) ===");
  calls.rows.forEach(r => {
    console.log(`ID:${r.id} | outcome:${r.outcome} | dur:${r.duration_sec}s | ai_summary_len:${(r.ai_summary||'').length} | ai_summary_start: "${(r.ai_summary||'').substring(0,80)}"`);
  });

  // Count calls with recording but NO real ai_summary
  const noSummary = await pool.query(`
    SELECT COUNT(*) as cnt FROM employee_calls
    WHERE recording_url IS NOT NULL AND recording_url <> ''
    AND (
      ai_summary IS NULL OR ai_summary = '' OR
      ai_summary LIKE '%No call recording%' OR
      ai_summary LIKE '%No AI summary%' OR
      ai_summary LIKE '%no_summary%'
    )
  `);
  console.log("\n=== CALLS WITH RECORDING BUT NO REAL AI SUMMARY ===", noSummary.rows[0].cnt);

  // Show the specific call that might be the one in the screenshot
  const today = await pool.query(`
    SELECT id, callyzer_call_id, recording_url, ai_summary, outcome, duration_sec, started_at
    FROM employee_calls
    WHERE recording_url IS NOT NULL AND recording_url <> ''
    AND DATE(started_at) = CURDATE()
    ORDER BY started_at DESC LIMIT 5
  `);
  console.log("\n=== TODAY'S CALLS WITH RECORDINGS ===");
  today.rows.forEach(r => {
    console.log(`ID:${r.id} | outcome:${r.outcome} | dur:${r.duration_sec}s | started:${r.started_at} | ai_summary_start: "${(r.ai_summary||'').substring(0,100)}"`);
  });

  process.exit(0);
}

check().catch(e => { console.error(e.message); process.exit(1); });
