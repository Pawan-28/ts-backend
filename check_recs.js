require("dotenv").config();
const pool = require("./config/db");

async function check() {
  const total = await pool.query("SELECT count(id) as count FROM employee_calls");
  const withRec = await pool.query("SELECT count(id) as count FROM employee_calls WHERE recording_url IS NOT NULL AND recording_url != ''");
  const sample = await pool.query("SELECT id, callyzer_call_id, recording_url, outcome, duration_sec FROM employee_calls WHERE recording_url IS NOT NULL AND recording_url != '' LIMIT 5");

  console.log("Total calls:", total.rows[0].count);
  console.log("Calls with recording_url:", withRec.rows[0].count);
  console.log("Sample recordings:", sample.rows);
  process.exit(0);
}

check().catch((e) => {
  console.error(e);
  process.exit(1);
});
