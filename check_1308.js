require("dotenv").config();
const pool = require("./config/db");

async function check() {
  const call = await pool.query(
    "SELECT id, outcome, duration_sec, recording_url, ai_summary, notes, transcript, started_at FROM employee_calls WHERE started_at >= '2026-07-24 13:00:00' AND started_at <= '2026-07-24 13:15:00' ORDER BY id DESC"
  );
  console.log("=== CALLS AROUND 13:08 ===");
  call.rows.forEach(r => {
    console.log(`ID:${r.id} | outcome:${r.outcome} | dur:${r.duration_sec}s | started:${r.started_at}`);
    console.log("recording_url:", r.recording_url);
    console.log("ai_summary:", (r.ai_summary || "").substring(0, 100));
  });

  process.exit(0);
}
check().catch(e => { console.error(e.message); process.exit(1); });
