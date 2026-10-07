/**
 * READ-ONLY PREFLIGHT. Run: node scripts/verify-active-meetings.js     (VERIFY_TENANT=<id> to change the tenant, default "default")
 * (see the "WHICH DATABASE?" note below for pointing it at production without touching backend/.env)
 * Shows, with the real data, how the ACTIVE-meeting definition (utils/activeMeetings.js) lines the Meetings page up with the
 * Pipeline "Meeting Booked" column, and checks the business rules that can be checked from data. Writes NOTHING.
 */
/*
 * WHICH DATABASE? If backend/.env.preflight exists it is the ONLY env file used (so the normal backend/.env, and the dev
 * server, are never touched). Otherwise it falls back to backend/.env (your local dev database). The banner printed first
 * shows exactly which host / database is in use. Put in .env.preflight (never commit it):
 *   DB_HOST=...  DB_PORT=3306  DB_USER=...  DB_PASSWORD=...  DB_NAME=...  [DB_SSL=true]  [EXPECT_DB_HOST=<part of the prod host>]
 */
const fs = require("fs");
const path = require("path");
const preflightEnv = path.resolve(__dirname, "../.env.preflight");
const envFile = fs.existsSync(preflightEnv) ? preflightEnv : path.resolve(__dirname, "../.env");
require("dotenv").config({ path: envFile, override: true, quiet: true });
const pool = require("../config/db");

// HARD read-only guard: this script can only ever run SELECT / SHOW statements. Anything else throws before it reaches MySQL.
const rawQuery = pool.query.bind(pool);
pool.query = (sql, ...rest) => {
  if (!/^\s*(SELECT|SHOW)\b/i.test(String(sql))) throw new Error(`verify-active-meetings is READ-ONLY - refused statement: ${String(sql).slice(0, 60)}`);
  return rawQuery(sql, ...rest);
};
const repo = require("../src/repositories/operationalRepo");
const { activeOnly, wallClockNow, isMeetingBookedStage, meetingPersonKey } = require("../src/utils/activeMeetings");

const TENANT = process.env.VERIFY_TENANT || "default";
const wall = (v) => String(v || "").replace(" ", "T").slice(0, 19);
const section = (t) => console.log(`\n=== ${t} ===`);

(async () => {
  const host = await pool.query("SELECT DATABASE() AS db, @@hostname AS host, NOW() AS now");
  const nowWall = wallClockNow();
  console.log("==================== READ-ONLY PREFLIGHT ====================");
  console.log(`env file      : ${path.basename(envFile)}${envFile === preflightEnv ? "" : "   <-- NOT .env.preflight: this is your LOCAL dev .env"}`);
  console.log(`DB_HOST       : ${process.env.DB_HOST || "(unset)"}:${process.env.DB_PORT || 3306}`);
  console.log(`DB_NAME       : ${process.env.DB_NAME || "(unset)"}   DB_USER: ${process.env.DB_USER || "(unset)"}   password: ${process.env.DB_PASSWORD ? "(set)" : "(unset)"}`);
  console.log(`connected to  : database "${host.rows[0].db}" on server "${host.rows[0].host}"   tenant: ${TENANT}   now (IST): ${nowWall}`);
  console.log("statements    : SELECT / SHOW only (anything else is refused)");
  console.log("=============================================================");
  if (process.env.EXPECT_DB_HOST && !String(process.env.DB_HOST || "").includes(process.env.EXPECT_DB_HOST)) {
    throw new Error(`EXPECT_DB_HOST="${process.env.EXPECT_DB_HOST}" is not part of DB_HOST - refusing to run against the wrong database`);
  }

  const emps = (await pool.query("SELECT id, name FROM employees WHERE tenant_id = $1", [TENANT])).rows;
  const nameOf = new Map(emps.map((e) => [String(e.id), e.name]));

  /* ---------- 1. totals (tenant-wide, no viewer filter) ---------- */
  const all = await repo.listTenantMeetings(TENANT, { limit: 2000 });
  const byStatus = {}; const byLife = {};
  for (const m of all) { byStatus[m.status] = (byStatus[m.status] || 0) + 1; byLife[m.lifecycle] = (byLife[m.lifecycle] || 0) + 1; }
  const scheduled = all.filter((m) => m.status === "scheduled");
  const active = activeOnly(all);
  section("1. TOTALS");
  console.log(`total meetings: ${all.length}  (by status ${JSON.stringify(byStatus)})`);
  console.log(`total SCHEDULED rows: ${scheduled.length}`);
  console.log(`ACTIVE meetings after the new logic: ${active.length}`);
  console.log(`inactive / history: ${all.length - active.length}  (by lifecycle ${JSON.stringify(byLife)})`);
  console.log(`scheduled rows that become history: ${scheduled.length - active.length}`);
  if (all.length >= 2000) console.log("WARNING: list limit (2000) reached - totals may be partial");

  /* ---------- 2. per employee: Meetings page vs Pipeline ---------- */
  section("2. PER EMPLOYEE (employee Meetings page, same query the page uses)");
  const rows = [];
  const withoutAll = [];
  for (const e of emps) {
    const annotated = await repo.listMeetings(TENANT, e.id, { includeAssignedLeads: true });
    const act = activeOnly(annotated);
    const without = await repo.listMeetingBookedLeadsWithoutActiveMeeting(TENANT, e.id, annotated);
    withoutAll.push(...without.map((w) => ({ employee: `#${e.id} ${e.name}`, ...w })));
    const booked = (await pool.query(
      `SELECT id, phone, pipeline_stage, status FROM leads WHERE tenant_id = $1 AND assigned_to = $2 AND is_deleted = 0
         AND (LOWER(COALESCE(pipeline_stage,'')) LIKE '%book%' OR LOWER(COALESCE(status,'')) LIKE '%book%')`, [TENANT, e.id],
    )).rows.filter((l) => isMeetingBookedStage(l.pipeline_stage, l.status));
    const bookedCustomers = new Set(booked.map((l) => meetingPersonKey({ leadId: l.id, leadPhone: l.phone })));
    if (!annotated.length && !booked.length) continue;
    rows.push({
      employee: `#${e.id} ${e.name}`, "scheduled rows": annotated.filter((m) => m.status === "scheduled").length,
      "ACTIVE meetings": act.length, "Meeting Booked cards": bookedCustomers.size, "cards w/o meeting": without.length,
      "history rows": annotated.length - act.length,
    });
  }
  console.table(rows);

  /* ---------- 3. upcoming meetings that STOP being active ---------- */
  const stopping = scheduled.filter((m) => !m.isActive && wall(m.scheduledAt) >= nowWall);
  section("3. UPCOMING scheduled meetings that would stop being active");
  console.log(stopping.length ? `${stopping.length} found - REVIEW BEFORE DEPLOY:` : "none");
  for (const m of stopping) {
    console.log("  ", JSON.stringify({ meetingId: m.id, lead: m.leadId, leadName: m.leadName, scheduledAt: m.scheduledAt, why: m.lifecycle, leadStage: m.leadStage, owner: nameOf.get(String(m.employeeId)), assignee: nameOf.get(String(m.leadAssignedTo)) }));
  }
  const pastScheduledHistory = scheduled.filter((m) => !m.isActive && wall(m.scheduledAt) < nowWall);
  console.log(`(past scheduled rows that become history, for information: ${pastScheduledHistory.length})`);

  /* ---------- 4. Meeting Booked leads with no active meeting ---------- */
  section("4. MEETING BOOKED leads with NO active meeting (Pipeline cards the Meetings page cannot show)");
  console.log(withoutAll.length ? `${withoutAll.length} found:` : "none");
  if (withoutAll.length) console.table(withoutAll);

  /* ---------- 5. customers with more than one active meeting ---------- */
  const perCustomer = {};
  for (const m of active) (perCustomer[meetingPersonKey(m)] ||= []).push(m.id);
  const multi = Object.entries(perCustomer).filter(([, ids]) => ids.length > 1);
  section("5. CUSTOMERS with more than one ACTIVE meeting");
  console.log(multi.length ? JSON.stringify(multi) : "none");

  // legacy duplicates that the logic collapses (informational: these are still 'scheduled' in the DB)
  const legacyDup = {};
  for (const m of scheduled) (legacyDup[meetingPersonKey(m)] ||= []).push(m.id);
  const dups = Object.entries(legacyDup).filter(([, ids]) => ids.length > 1);
  console.log(`customers with >1 SCHEDULED row in the database (collapsed to one active by the logic, rows untouched): ${dups.length}`);
  for (const [k, ids] of dups) console.log("  ", k, "->", ids.join(","));

  /* ---------- 6. ownership mismatches ---------- */
  section("6. OWNERSHIP");
  const mismatch = active.filter((m) => m.leadAssignedTo != null && String(m.employeeId) !== String(m.leadAssignedTo));
  console.log(`ACTIVE meetings whose booking employee differs from the lead's assignee: ${mismatch.length} (the assignee sees them; this is allowed)`);
  for (const m of mismatch) console.log("  ", JSON.stringify({ meetingId: m.id, lead: m.leadId, bookedBy: nameOf.get(String(m.employeeId)), assignee: nameOf.get(String(m.leadAssignedTo)) }));
  const unassigned = active.filter((m) => m.leadAssignedTo == null);
  console.log(`ACTIVE meetings on UNASSIGNED leads (owner = booking employee): ${unassigned.length}`);
  const otherOwner = [];
  for (const e of emps) {
    const l = await repo.listMeetings(TENANT, e.id, { includeAssignedLeads: true });
    for (const m of l) if (m.lifecycle === "other_owner") otherOwner.push(`${m.id}@#${e.id}`);
  }
  console.log(`rows an employee owns but whose lead is assigned to someone else (shown to that employee as history): ${otherOwner.length}`);

  /* ---------- 7. business rules checked against the data ---------- */
  section("7. BUSINESS RULES (as far as data can show; reschedule / settle behaviour is covered by the unit tests)");
  const bookedLeads = (await pool.query(
    `SELECT id, phone, pipeline_stage, status FROM leads WHERE tenant_id = $1 AND is_deleted = 0
       AND (LOWER(COALESCE(pipeline_stage,'')) LIKE '%book%' OR LOWER(COALESCE(status,'')) LIKE '%book%')`, [TENANT],
  )).rows.filter((l) => isMeetingBookedStage(l.pipeline_stage, l.status));
  const activeKeys = new Set(active.map(meetingPersonKey));
  const noActive = bookedLeads.filter((l) => !activeKeys.has(meetingPersonKey({ leadId: l.id, leadPhone: l.phone })));
  const check = (label, ok, detail = "") => console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? "  - " + detail : ""}`);
  check("one customer / phone -> at most ONE active meeting", multi.length === 0, `${multi.length} violations`);
  check("Meeting Booked lead -> exactly one active meeting", noActive.length === 0, `${bookedLeads.length} Meeting Booked leads, ${noActive.length} without an active meeting (stage-only legacy / test leads)`);
  const leaving = all.filter((m) => m.status === "scheduled" && m.lifecycle === "stage_moved");
  check("a lead NOT in Meeting Booked has no active meeting", active.every((m) => isMeetingBookedStage(m.leadStage, m.leadStatus)), `${leaving.length} stale scheduled rows are reported as history`);
  check("historical meetings stay history (completed / cancelled never active)", all.filter((m) => ["completed", "cancelled"].includes(m.status)).every((m) => !m.isActive));
  check("active meeting is on a non-deleted lead", active.every((m) => Number(m.leadIsDeleted) !== 1));
  check("no upcoming meeting silently disappears", stopping.length === 0, `${stopping.length} to review`);
  console.log("\nNothing was written. Re-run is safe at any time.");
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
