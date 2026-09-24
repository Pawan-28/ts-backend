require("dotenv").config();
const pool = require("./config/db");

async function check() {
  const call = await pool.query(
    "SELECT id, outcome, duration_sec, recording_url, ai_summary, notes, transcript FROM employee_calls WHERE id = 4357 LIMIT 1"
  );
  const r = call.rows[0];
  if (!r) { console.log("Call 4357 not found"); process.exit(0); }
  console.log("=== CALL 4357 ===");
  console.log("outcome:", r.outcome);
  console.log("duration_sec:", r.duration_sec);
  console.log("recording_url:", r.recording_url ? r.recording_url.substring(0, 80) + "..." : "NULL");
  console.log("ai_summary length:", (r.ai_summary || "").length);
  console.log("ai_summary:", (r.ai_summary || "").substring(0, 200));
  console.log("notes:", (r.notes || "").substring(0, 200));
  console.log("transcript length:", (r.transcript || "").length);
  process.exit(0);
}
check().catch(e => { console.error(e.message); process.exit(1); });
