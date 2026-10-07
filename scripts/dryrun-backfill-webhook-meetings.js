/**
 * DRY RUN ONLY - READ-ONLY. Run: node scripts/dryrun-backfill-webhook-meetings.js
 *
 * Old customer bookings (n8n / form webhook) stored the meeting only inside leads.source_meta and set the lead stage to
 * "booked", but never created a row in `meetings`, so the lead sits in the Pipeline's Meeting Booked column while the
 * Meetings page (which reads the `meetings` table) has nothing to show.
 *
 * This script lists the `meetings` rows that WOULD be inserted for those leads, using the SAME parser as the live
 * webhook flow (utils/webhookMeeting.js: explicit "Z" / offset is trusted, bare times are read as IST). It never writes.
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const pool = require("../config/db");
const { extractWebhookMeeting } = require("../src/utils/webhookMeeting");

const TENANT = process.env.DRYRUN_TENANT || "default";
const BOOKED = new Set(["booked", "meeting booked"]);
const HELD = new Set(["meeting done"]);

const ist = (d) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(d).replace(",", "");

const parseMeta = (v) => {
  if (v && typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return null; }
};

(async () => {
  const rows = (await pool.query(
    `SELECT l.id, l.assigned_to, l.pipeline_stage, l.status, l.source, l.source_meta, e.name AS employee_name
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
      WHERE l.is_deleted = 0 AND l.tenant_id = $1
        AND (LOWER(l.pipeline_stage) IN ('booked','meeting booked','meeting done') OR LOWER(l.status) IN ('booked','meeting booked','meeting done'))
        AND NOT EXISTS (SELECT 1 FROM meetings m WHERE m.lead_id = l.id)
      ORDER BY l.id`,
    [TENANT],
  )).rows;

  const wouldInsert = [];
  const skipped = [];
  const now = Date.now();
  for (const l of rows) {
    const stage = String(l.pipeline_stage || "").toLowerCase();
    const status = String(l.status || "").toLowerCase();
    const held = HELD.has(stage) || HELD.has(status);
    const meta = parseMeta(l.source_meta);
    const m = meta ? extractWebhookMeeting(meta) : null;
    const base = { leadId: l.id, stage: l.pipeline_stage, assignedTo: l.assigned_to, employee: l.employee_name || null };
    if (!m) { skipped.push({ ...base, reason: held ? "Meeting Done stage, no meeting data anywhere - cannot recover a date" : "legacy stage only, no meeting data in source_meta - cannot recover a date" }); continue; }
    if (!m.scheduledAt) { skipped.push({ ...base, meetLink: m.meetLink, rawScheduledAt: m.rawTime || (meta.scheduledAt ?? ""), reason: "meetLink present but scheduledAt is empty/unparseable - will NOT invent a time" }); continue; }
    if (!l.assigned_to) { skipped.push({ ...base, scheduledAt: meta.scheduledAt, reason: "lead has no assigned employee - meeting needs an owner" }); continue; }
    wouldInsert.push({
      leadId: l.id,
      assignedEmployee: `${l.assigned_to} ${l.employee_name || ""}`.trim(),
      sourceScheduledAt: meta.scheduledAt,
      utcIso: m.scheduledAt.toISOString(),
      scheduledAtIST: ist(m.scheduledAt),
      meetLink: m.meetLink || null,
      title: meta.meetingTitle || "(built from lead + service)",
      durationMin: Number(meta.durationMin || 30),
      status: "scheduled",
      willShowAs: m.scheduledAt.getTime() < now ? "Overdue (time already passed, still booked)" : "Upcoming",
      reason: "booked-stage lead, no meetings row, scheduledAt recoverable from source_meta",
    });
  }

  console.log(`DRY RUN (nothing written). tenant=${TENANT}. booked/held-stage leads with NO meetings row: ${rows.length}`);
  console.log(`\n=== WOULD INSERT: ${wouldInsert.length} meetings rows ===`);
  console.table(wouldInsert.map((r) => ({
    lead: r.leadId, employee: r.assignedEmployee, "source scheduledAt": r.sourceScheduledAt,
    "IST date/time": r.scheduledAtIST, link: r.meetLink ? r.meetLink.replace("https://", "") : "-", "shows as": r.willShowAs.split(" ")[0],
  })));
  console.log("full rows:\n" + JSON.stringify(wouldInsert, null, 1));
  console.log(`\n=== SKIPPED: ${skipped.length} leads (no insert) ===`);
  console.table(skipped.map((r) => ({ lead: r.leadId, stage: r.stage, employee: r.employee || r.assignedTo || "-", reason: r.reason })));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
