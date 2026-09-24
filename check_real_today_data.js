require("dotenv").config();
const pool = require("./config/db");

async function checkRealData() {
  const tenantId = "default";

  // Check leads created today vs this week vs this month
  const todayLeads = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND is_deleted = 0 AND DATE(created_at) = CURRENT_DATE()`,
    [tenantId]
  );

  const weekLeads = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND is_deleted = 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    [tenantId]
  );

  const monthLeads = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND is_deleted = 0 AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    [tenantId]
  );

  const allLeads = await pool.query(
    `SELECT COUNT(*) FROM leads WHERE tenant_id = $1 AND is_deleted = 0`,
    [tenantId]
  );

  console.log("Leads count:");
  console.log("  Today:", todayLeads.rows[0]);
  console.log("  This Week (7 days):", weekLeads.rows[0]);
  console.log("  This Month (30 days):", monthLeads.rows[0]);
  console.log("  All time:", allLeads.rows[0]);

  // Check calls today vs this week vs this month
  const todayCalls = await pool.query(
    `SELECT COUNT(*) FROM employee_calls WHERE tenant_id = $1 AND DATE(started_at) = CURRENT_DATE()`,
    [tenantId]
  );

  const weekCalls = await pool.query(
    `SELECT COUNT(*) FROM employee_calls WHERE tenant_id = $1 AND started_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
    [tenantId]
  );

  const monthCalls = await pool.query(
    `SELECT COUNT(*) FROM employee_calls WHERE tenant_id = $1 AND started_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`,
    [tenantId]
  );

  const allCalls = await pool.query(
    `SELECT COUNT(*) FROM employee_calls WHERE tenant_id = $1`,
    [tenantId]
  );

  console.log("\nCalls count:");
  console.log("  Today:", todayCalls.rows[0]);
  console.log("  This Week (7 days):", weekCalls.rows[0]);
  console.log("  This Month (30 days):", monthCalls.rows[0]);
  console.log("  All time:", allCalls.rows[0]);

  process.exit(0);
}

checkRealData();
