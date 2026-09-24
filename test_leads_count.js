require("dotenv").config();
const pool = require("./config/db");

async function checkLeadsCount() {
  try {
    const leadsRes = await pool.query("SELECT COUNT(*) AS c FROM leads");
    const empLeadsRes = await pool.query("SELECT COUNT(*) AS c FROM emp_leads");
    console.log("Total in `leads` table:", leadsRes.rows[0]?.c);
    console.log("Total in `emp_leads` table:", empLeadsRes.rows[0]?.c);

    const leadsSample = await pool.query("SELECT id, name, status, pipeline_stage, created_at, updated_at FROM leads ORDER BY id DESC LIMIT 5");
    console.log("\nSample `leads` rows:", leadsSample.rows);

    const empLeadsSample = await pool.query("SELECT id, client_name, status, submitted_time FROM emp_leads ORDER BY id DESC LIMIT 5");
    console.log("\nSample `emp_leads` rows:", empLeadsSample.rows);
  } catch (err) {
    console.error("Error checking leads count:", err);
  } finally {
    process.exit(0);
  }
}

checkLeadsCount();
