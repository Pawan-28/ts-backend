#!/usr/bin/env node
/**
 * One-time admin seed — run on Hostinger after creating the users table:
 *   node scripts/seed-admin.js
 */
require("dotenv").config({ quiet: true });

async function main() {
  const { ensureAdminUser } = require("../src/services/userService");
  const result = await ensureAdminUser();
  console.log(result?.created ? "Admin user created." : "Admin user already exists — nothing changed.");
  console.log("Login ID:", result?.loginId || process.env.ADMIN_LOGIN_ID || "ADMIN");
  console.log("Email:", result?.email || (process.env.ADMIN_EMAIL || "admin@tspublication.in").toLowerCase());
  if (result?.created && result?.tempPassword) {
    console.log("One-time password (change immediately after login):", result.tempPassword);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Seed failed:", err.message || err);
  process.exit(1);
});
