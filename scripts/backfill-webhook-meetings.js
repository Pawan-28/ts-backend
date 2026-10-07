/**
 * One-time backfill of `meetings` rows for old customer bookings that only live in leads.source_meta.
 *   node scripts/backfill-webhook-meetings.js            -> preflight only (prints what WOULD be inserted, checks, writes nothing)
 *   node scripts/backfill-webhook-meetings.js --apply    -> runs the same checks, then inserts
 *
 * Only the lead ids in APPROVED are ever touched (approved after the dry-run in dryrun-backfill-webhook-meetings.js).
 * Excluded on purpose: 4833 (test data), 4534 (empty scheduledAt), and every legacy stage-only lead (no date to recover).
 * Date parsing = the live webhook's extractWebhookMeeting (explicit "Z"/offset trusted, bare times read as IST).
 * Inserts through repo.insertMeeting (the same insert the live flow uses). No timeline entry / notification is created -
 * these are historical meetings and the rep must not be pinged about them. Existing meetings are never updated or deleted.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const pool = require("../config/db");
const repo = require("../src/repositories/operationalRepo");
const { extractWebhookMeeting } = require("../src/utils/webhookMeeting");

const TENANT = "default";
const APPROVED = [4705, 4733, 4734, 4754, 4755, 4758, 4759, 4766, 4775, 4784, 4790, 4815, 4817];
const APPLY = process.argv.includes("--apply");

const ist = (d) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d).replace(",", "");
const parseMeta = (v) => { if (v && typeof v === "object") return v; try { return JSON.parse(v); } catch { return null; } };
const count = async () => Number((await pool.query("SELECT COUNT(*) c FROM meetings")).rows[0].c);

(async () => {
  const before = await count();
  const leads = (await pool.query(
    `SELECT id, lead_name, assigned_to, tenant_id, is_deleted, pipeline_stage, source_meta FROM leads WHERE id IN (${APPROVED.join(",")})`,
  )).rows;
  const plan = [];
  const problems = [];
  for (const id of APPROVED) {
    const l = leads.find((x) => Number(x.id) === id);
    if (!l) { problems.push(`lead ${id} not found`); continue; }
    if (l.tenant_id !== TENANT) problems.push(`lead ${id} tenant is ${l.tenant_id}, expected ${TENANT}`);
    if (Number(l.is_deleted) !== 0) problems.push(`lead ${id} is deleted`);
    if (!l.assigned_to) problems.push(`lead ${id} has no assigned employee`);
    const meta = parseMeta(l.source_meta);
    const m = meta ? extractWebhookMeeting(meta) : null;
    if (!m || !m.scheduledAt) { problems.push(`lead ${id}: no recoverable scheduledAt`); continue; }
    const anyRow = (await pool.query("SELECT id FROM meetings WHERE lead_id = $1", [id])).rows;
    if (anyRow.length) problems.push(`lead ${id} ALREADY has meetings row(s): ${anyRow.map((r) => r.id)}`);
    const same = await repo.findActiveMeetingAt(TENANT, id, m.scheduledAt);
    if (same) problems.push(`lead ${id}: duplicate - meeting ${same.id} already at that slot`);
    plan.push({
      leadId: id,
      leadName: l.lead_name,
      employeeId: l.assigned_to,
      scheduledAt: m.scheduledAt,
      title: meta.meetingTitle || `Meeting - ${l.lead_name}`,
      durationMin: Number(meta.durationMin || 30),
      meetLink: m.meetLink || null,
      location: m.meetLink ? "Google Meet" : "Online",
      agenda: `Initial discussion for ${l.lead_name}`,
      sourceScheduledAt: meta.scheduledAt,
    });
  }
  // a lead id repeated in the plan, or two planned rows at the same lead+slot
  const keys = plan.map((p) => `${p.leadId}|${p.scheduledAt.getTime()}`);
  if (new Set(keys).size !== keys.length) problems.push("duplicate lead+slot inside the plan");

  console.log(`mode: ${APPLY ? "APPLY" : "PREFLIGHT ONLY"} | meetings before: ${before}`);
  console.log(`\n${plan.length} records ${APPLY ? "to insert" : "that WOULD be inserted"}:`);
  console.table(plan.map((p) => ({
    lead: p.leadId, name: p.leadName, employee: p.employeeId, "source scheduledAt": p.sourceScheduledAt,
    "IST": ist(p.scheduledAt), min: p.durationMin, status: "scheduled", title: p.title, link: p.meetLink,
  })));
  console.log("checks: none has an existing meetings row, no duplicate slot, tenant/deleted/assignee valid ->", problems.length ? "FAILED" : "PASSED");
  if (problems.length) { problems.forEach((p) => console.log("  PROBLEM:", p)); process.exit(1); }
  if (plan.length !== 13) { console.log("expected exactly 13 records, got", plan.length); process.exit(1); }
  if (!APPLY) { console.log("\nNothing written (preflight). Re-run with --apply to insert."); process.exit(0); }

  const inserted = [];
  for (const p of plan) {
    const m = await repo.insertMeeting({
      tenantId: TENANT, leadId: p.leadId, employeeId: p.employeeId, title: p.title, scheduledAt: p.scheduledAt,
      durationMin: p.durationMin, meetLink: p.meetLink, location: p.location, agenda: p.agenda,
    });
    inserted.push({ meetingId: m.id, leadId: p.leadId, employeeId: p.employeeId, scheduledAt: m.scheduledAt });
  }
  console.log("\nINSERTED:");
  console.table(inserted);
  console.log(`meetings after: ${await count()}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
