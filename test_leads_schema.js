require("dotenv").config();
const pool = require("./config/db");

async function checkLeadsSchema() {
  try {
    const res = await pool.query("SELECT * FROM leads LIMIT 1");
    if (res.rows.length > 0) {
      console.log("Leads table columns:", Object.keys(res.rows[0]));
      console.log("Sample lead row:", res.rows[0]);
    } else {
      console.log("No rows in leads table");
    }
  } catch (err) {
    console.error("Error:", err);
  } finally {
    process.exit(0);
  }
}

checkLeadsSchema();
