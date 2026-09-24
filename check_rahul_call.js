require("dotenv").config();
const pool = require("./config/db");

async function checkRahulCall() {
  const phone = "917208577151";

  // Check leads table
  const leadsRes = await pool.query(
    `SELECT id, lead_name, phone, email, status, temperature, assigned_to FROM leads WHERE phone LIKE $1 OR lead_name LIKE $2`,
    [`%${phone.slice(-10)}%`, "%Rahul Nirala%"]
  );

  console.log("=== LEADS FOUND ===");
  console.log(JSON.stringify(leadsRes.rows, null, 2));

  // Check employee_calls table
  const callsRes = await pool.query(
    `SELECT id, tenant_id, employee_id, lead_id, recording_url, transcript, ai_summary, notes, outcome, duration_sec, started_at, created_at
     FROM employee_calls
     WHERE lead_id IN (SELECT id FROM leads WHERE phone LIKE $1 OR lead_name LIKE $2)
        OR notes LIKE $3
        OR ai_summary LIKE $3`,
    [`%${phone.slice(-10)}%`, "%Rahul Nirala%", `%${phone.slice(-10)}%`]
  );

  console.log("\n=== CALLS FOUND ===");
  console.log(JSON.stringify(callsRes.rows, null, 2));

  process.exit(0);
}

checkRahulCall();
