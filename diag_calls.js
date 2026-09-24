require("dotenv").config();
const pool = require("./config/db");

async function check() {
  // Check calls with recordings - see if they have lead_id
  const withRec = await pool.query(
    "SELECT id, callyzer_call_id, lead_id, recording_url, outcome, duration_sec FROM employee_calls WHERE recording_url IS NOT NULL AND recording_url <> '' ORDER BY id DESC LIMIT 5"
  );
  console.log("\n=== CALLS WITH RECORDINGS ===");
  console.log(JSON.stringify(withRec.rows, null, 2));

  // Check calls without lead_id
  const noLead = await pool.query(
    "SELECT COUNT(*) as cnt FROM employee_calls WHERE lead_id IS NULL"
  );
  console.log("\n=== CALLS WITHOUT LEAD_ID ===", noLead.rows[0].cnt);

  // Check total
  const total = await pool.query("SELECT COUNT(*) as cnt FROM employee_calls");
  console.log("=== TOTAL CALLS ===", total.rows[0].cnt);

  // Sample calls with callyzer_call_id
  const sample = await pool.query(
    "SELECT id, callyzer_call_id, lead_id, outcome FROM employee_calls WHERE callyzer_call_id IS NOT NULL LIMIT 5"
  );
  console.log("\n=== CALLYZER CALLS SAMPLE ===");
  console.log(JSON.stringify(sample.rows, null, 2));

  process.exit(0);
}

check().catch((e) => { console.error(e.message); process.exit(1); });
