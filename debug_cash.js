// Quick diagnostic — run with: node debug_cash.js
require("dotenv").config();
const pool = require("./src/config/db");

async function main() {
  console.log("\n=== All cash_collections rows ===");
  const all = await pool.query(
    "SELECT id, tenant_id, employee_id, amount, payment_at, created_at, TO_CHAR(payment_at,'YYYY-MM') as month_payment, TO_CHAR(created_at,'YYYY-MM') as month_created FROM cash_collections ORDER BY created_at DESC LIMIT 20"
  );
  console.table(all.rows);

  console.log("\n=== Sum with payment_at month filter (2026-07) ===");
  const byMonth = await pool.query(
    "SELECT COALESCE(SUM(amount),0)::float as total FROM cash_collections WHERE TO_CHAR(payment_at,'YYYY-MM')='2026-07'"
  );
  console.log("total:", byMonth.rows[0]);

  console.log("\n=== Sum with created_at month filter (2026-07) ===");
  const byCreated = await pool.query(
    "SELECT COALESCE(SUM(amount),0)::float as total FROM cash_collections WHERE TO_CHAR(created_at,'YYYY-MM')='2026-07'"
  );
  console.log("total:", byCreated.rows[0]);

  await pool.end();
}

main().catch(console.error);
