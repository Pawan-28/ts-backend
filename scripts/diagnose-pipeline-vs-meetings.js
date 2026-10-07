/**
 * READ-ONLY diagnostic. Run: node scripts/diagnose-pipeline-vs-meetings.js [employeeId]   (no id = every employee)
 *
 * Lists the Pipeline "Meeting Booked" cards of an employee that have NO meeting on that employee's Meetings page, and why.
 *   Pipeline set  = leads assigned to the employee (not deleted) whose stored stage/status is booked / meeting booked,
 *                   OR that have a still-scheduled meeting (the board also places a card from a scheduled meeting).
 *   Meetings page = repo.listMeetings(tenant, employee, { includeAssignedLeads: true }) minus cancelled (what the page shows).
 * Writes nothing.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const pool = require("../config/db");
const repo = require("../src/repositories/operationalRepo");

const TENANT = process.env.DIAG_TENANT || "default";
const BOOKED = new Set(["booked", "meeting booked", "meeting_booked"]);
const isBooked = (l) => BOOKED.has(String(l.pipeline_stage || "").toLowerCase()) || BOOKED.has(String(l.status || "").toLowerCase());

(async () => {
  const only = process.argv[2] ? Number(process.argv[2]) : null;
  const emps = (await pool.query("SELECT id, name FROM employees WHERE tenant_id = $1", [TENANT])).rows
    .filter((e) => (only ? Number(e.id) === only : true));

  for (const e of emps) {
    const leads = (await pool.query(
      `SELECT id, lead_name, phone, pipeline_stage, status FROM leads WHERE tenant_id = $1 AND is_deleted = 0 AND assigned_to = $2`,
      [TENANT, e.id],
    )).rows;
    const meetingsByLead = new Map();
    for (const m of (await pool.query(
      `SELECT m.id, m.lead_id, m.status, m.tenant_id, DATE_FORMAT(m.scheduled_at,'%Y-%m-%d %H:%i') s FROM meetings m JOIN leads l ON l.id = m.lead_id WHERE l.assigned_to = $1`, [e.id],
    )).rows) {
      const k = String(m.lead_id);
      (meetingsByLead.get(k) || meetingsByLead.set(k, []).get(k)).push(m);
    }
    const pageRows = (await repo.listMeetings(TENANT, e.id, { includeAssignedLeads: true })).filter((m) => m.status !== "cancelled");
    const onPage = new Set(pageRows.map((m) => String(m.leadId)));

    const pipeline = leads.filter((l) => isBooked(l) || (meetingsByLead.get(String(l.id)) || []).some((m) => m.status === "scheduled"));
    const missing = [];
    for (const l of pipeline) {
      if (onPage.has(String(l.id))) continue;
      const rows = meetingsByLead.get(String(l.id)) || [];
      let reason;
      if (!rows.length) reason = "NO meetings row (stage only - nothing to show on the Meetings page)";
      else if (rows.every((m) => m.status === "cancelled")) reason = `only CANCELLED meeting(s): ${rows.map((m) => m.id)}`;
      else if (rows.some((m) => m.tenant_id !== TENANT)) reason = `meeting row is in another tenant: ${rows.map((m) => `${m.id}@${m.tenant_id}`)}`;
      else reason = `meeting(s) exist but are not listed: ${rows.map((m) => `${m.id}/${m.status}`)}`;
      missing.push({ lead: l.id, name: l.lead_name, stage: l.pipeline_stage, status: l.status, reason });
    }
    if (!pipeline.length && !pageRows.length) continue;
    console.log(`\n#${e.id} ${e.name}: Pipeline Meeting-Booked cards ~${pipeline.length} | meetings on Meetings page ${pageRows.length} | pipeline cards WITHOUT a meeting on the page: ${missing.length}`);
    if (missing.length) console.table(missing);
  }
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
