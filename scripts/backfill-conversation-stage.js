/**
 * One-time clean-up: everyone who ever had an ANSWERED CALL ABOVE 2 MINUTES (any employee, any direction, any date) belongs in the
 * Conversation stage - on EVERY lead row of that phone number. New calls now do this by themselves
 * (services/autoPipelineStageService); this brings the old data in line.
 *
 *   node scripts/backfill-conversation-stage.js            -> DRY RUN (default): prints what WOULD change, writes nothing
 *   node scripts/backfill-conversation-stage.js --apply    -> backs the rows up to backups/conversation-stage-<time>.csv, then moves them
 *   node scripts/backfill-conversation-stage.js --restore backups/conversation-stage-<time>.csv   -> puts the old stages back
 *
 * Only leads whose stored stage is Lead / Not Pick / Short Call (incl. "new", "New Lead", Attempted ...) move up, and only to
 * "Conversation 2 min+". Meeting Booked and later stages, Not Interested and every deleted lead are never touched. Same write and the
 * same timeline note ("Auto: X -> Y") as the live rule; nothing is created or deleted.
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const pool = require("../config/db");
const repo = require("../src/repositories/operationalRepo");
const { callSqlExprs } = require("../src/utils/callMetrics");
const { personKeySql } = require("../src/utils/callHistory");
const { mapStageToId, getStageLabelById } = require("../src/utils/pipelineStages");

const TENANT = process.env.BACKFILL_TENANT || "default";
const APPLY = process.argv.includes("--apply");
const restoreIdx = process.argv.indexOf("--restore");
const RESTORE = restoreIdx > -1 ? process.argv[restoreIdx + 1] : null;
const BEHIND = new Set(["lead", "not_pick", "short_call"]);
const TARGET = getStageLabelById("conversation_2min"); // "Conversation 2 min+"

const csv = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

(async () => {
  console.log(`DB ${process.env.DB_HOST}/${process.env.DB_NAME} - tenant ${TENANT} - ${RESTORE ? "RESTORE" : APPLY ? "APPLY" : "DRY RUN (nothing is written)"}`);

  if (RESTORE) {
    const lines = fs.readFileSync(RESTORE, "utf8").trim().split(/\r?\n/).slice(1);
    let n = 0;
    for (const line of lines) {
      const [id, stage, status] = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
      const r = await pool.query("UPDATE leads SET pipeline_stage = $1, status = $2 WHERE id = $3 AND tenant_id = $4 AND pipeline_stage = $5", [stage, status, Number(id), TENANT, TARGET]);
      n += r.rowCount || 0;
    }
    console.log(`restored ${n} of ${lines.length} rows (a row whose stage changed again since is left as it is)`);
    process.exit(0);
  }

  const x = callSqlExprs("ec");
  const key = personKeySql("l");
  const people = new Set((await pool.query(
    `SELECT ${key} AS pk FROM employee_calls ec JOIN leads l ON l.id = ec.lead_id AND l.is_deleted = 0 AND (l.tenant_id = $1 OR l.tenant_id IS NULL)
     WHERE ec.tenant_id = $1 AND ${x.conversation} GROUP BY pk`, [TENANT],
  )).rows.map((r) => String(r.pk)));

  const leads = (await pool.query(
    `SELECT l.id, l.lead_name, l.pipeline_stage, l.status, l.assigned_to, ${key} AS pk FROM leads l WHERE (l.tenant_id = $1 OR l.tenant_id IS NULL) AND l.is_deleted = 0`, [TENANT],
  )).rows;

  const todo = leads.filter((l) => people.has(String(l.pk)) && BEHIND.has(mapStageToId(l.pipeline_stage, l.status)));
  const byFrom = {};
  const byOwner = {};
  for (const l of todo) {
    byFrom[l.pipeline_stage || "(blank)"] = (byFrom[l.pipeline_stage || "(blank)"] || 0) + 1;
    byOwner[l.assigned_to ?? "unassigned"] = (byOwner[l.assigned_to ?? "unassigned"] || 0) + 1;
  }
  console.log(`\npeople with an answered call above 2 minutes: ${people.size}`);
  console.log(`WOULD MOVE to "${TARGET}": ${todo.length} lead rows (${new Set(todo.map((l) => l.pk)).size} people)`);
  console.log("  from (stored stage):", JSON.stringify(byFrom));
  console.log("  by assignee:", JSON.stringify(byOwner));
  console.log("NOT touched: Meeting Booked / Done / Proposal / Objection / paid, Not Interested, deleted leads, leads already in Conversation.");

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to move them (a backup CSV is written first).");
    process.exit(0);
  }

  const dir = path.resolve(__dirname, "../backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `conversation-stage-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  fs.writeFileSync(file, `id,pipeline_stage,status\n${todo.map((l) => `${l.id},${csv(l.pipeline_stage)},${csv(l.status)}`).join("\n")}\n`);
  console.log(`backup written: ${file}`);

  let moved = 0;
  for (const l of todo) {
    const from = getStageLabelById(mapStageToId(l.pipeline_stage, l.status));
    await repo.updateLead(TENANT, l.id, { pipelineStage: TARGET, status: TARGET, lastActivityAt: new Date() });
    await repo.insertTimeline({
      tenantId: TENANT,
      leadId: l.id,
      type: "stage_change",
      summary: `Auto: ${from} → ${TARGET} (answered call above 2 min)`,
      payload: { from, to: TARGET, auto: true, backfill: true },
      actorId: "system:backfill",
      actorName: "Conversation backfill",
      actorRole: "system",
    });
    moved += 1;
  }
  console.log(`moved ${moved} lead rows. Undo: node scripts/backfill-conversation-stage.js --restore "${file}"`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
