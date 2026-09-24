require("dotenv").config();
const pool = require("./config/db");

async function check() {
  const call = await pool.query(
    "SELECT id, outcome, duration_sec, recording_url, ai_summary, notes, transcript, started_at FROM employee_calls WHERE duration_sec = 14 ORDER BY id DESC LIMIT 5"
  );
  console.log("=== 14s CALLS ===");
  call.rows.forEach(r => {
    console.log(`ID:${r.id} | outcome:${r.outcome} | dur:${r.duration_sec}s | started:${r.started_at}`);
    console.log("recording_url:", r.recording_url);
    console.log("ai_summary:", (r.ai_summary || "").substring(0, 200));
  });
  
  const call2 = await pool.query(
    "SELECT id, outcome, duration_sec, recording_url, ai_summary, notes, transcript, started_at FROM employee_calls ORDER BY id DESC LIMIT 5"
  );
  console.log("=== RECENT CALLS ===");
  call2.rows.forEach(r => {
    console.log(`ID:${r.id} | outcome:${r.outcome} | dur:${r.duration_sec}s | started:${r.started_at}`);
    console.log("recording_url:", r.recording_url);
    console.log("ai_summary:", (r.ai_summary || "").substring(0, 200));
  });

  process.exit(0);
}
check().catch(e => { console.error(e.message); process.exit(1); });
