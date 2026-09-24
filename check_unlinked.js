require("dotenv").config();
const pool = require("./config/db");

async function check() {
  const r = await pool.query("SELECT COUNT(*) as total FROM employee_calls WHERE lead_id IS NULL");
  console.log("Unlinked calls count:", r.rows[0].total || r.rows[0]["COUNT(*)"]);
  process.exit(0);
}

check().catch(e => console.error(e));
