/**
 * Auto-reassign of stuck leads: a lead that has not moved from its pipeline stage to the next one for the window (3 days) is taken from
 * the employee and assigned to another one. The rules are in utils/stageClock.js; this file finds the leads that are due and moves them.
 *
 * Safety:
 *   - OFF unless an admin switched it on (tenant settings `autoReassign.enabled`); the switch-on moment is the floor of every window.
 *   - at most `limit` leads per run (the rest wait for the next run) - never the whole backlog at once.
 *   - each lead is re-read just before it is moved; if it changed hands or moved on in the meantime it is left alone.
 *   - only the owner changes: the stage, notes, calls, meetings and history of the lead are untouched, and the move is written to
 *     the assignment history + timeline like every other assignment.
 *   - the new owner gets the normal "New lead assigned" notification, the previous owner a "lead moved" one.
 */
const pool = require("../../config/db");
const { logger } = require("../config/logger");
const { DAY_MS, autoAssignLabel } = require("../utils/stageClock");
const { getStageLabelById } = require("../utils/pipelineStages");
const stageClock = require("./stageClockService");
const { summarizeClocks, pickTarget } = require("../utils/autoReassignPlan");

const DEFAULT_LIMIT = Number(process.env.AUTO_REASSIGN_MAX_PER_RUN) || 50;
let running = false;

/** Leads that are past their window right now, oldest deadline first. */
async function findDueLeads(tenantId, { now = Date.now(), settings } = {}) {
  const cfg = settings || await stageClock.getSettings(tenantId);
  const rows = await stageClock.loadOpenLeadRows(tenantId, { assignedBefore: new Date(now - cfg.days * DAY_MS) });
  const clocks = await stageClock.clocksForLeadRows(tenantId, rows, { now, days: cfg.days, floorAt: cfg.enabledAt });
  const due = [];
  for (const row of rows) {
    const clock = clocks.get(String(row.id));
    if (clock && clock.timed && clock.due) due.push({ row, clock });
  }
  due.sort((a, b) => a.clock.deadlineAt - b.clock.deadlineAt);
  return due;
}

async function runAutoReassign(tenantId, { now = Date.now(), limit = DEFAULT_LIMIT, dryRun = false, actor } = {}) {
  const settings = await stageClock.getSettings(tenantId);
  if (!settings.enabled) return { skipped: "disabled" };
  if (running) return { skipped: "already_running" };
  running = true;
  try {
    const ops = require("./operationalServices");
    const due = await findDueLeads(tenantId, { now, settings });
    const batch = due.slice(0, Math.max(0, limit));
    const result = { enabled: true, days: settings.days, due: due.length, attempted: batch.length, reassigned: [], skipped: [] };
    if (dryRun || !batch.length) {
      result.wouldReassign = batch.map(({ row, clock }) => ({ leadId: row.id, name: row.lead_name, from: row.assigned_to, stage: getStageLabelById(clock.column), dueSince: clock.deadlineAt }));
      return result;
    }

    const config = await ops.getOrCreateAssignmentConfig(tenantId);
    const candidates = await ops.eligibleEmployees(tenantId, config);
    const load = new Map();
    for (const { row, clock } of batch) {
      try {
        // re-read: leave it alone if it changed hands (or was reassigned by someone else) since we looked
        const fresh = (await pool.query("SELECT assigned_to, assigned_at, is_deleted FROM leads WHERE id = $1 LIMIT 1", [row.id])).rows[0];
        const sameOwner = fresh && Number(fresh.assigned_to) === Number(row.assigned_to);
        const sameTime = fresh && (new Date(fresh.assigned_at || 0).getTime() === new Date(row.assigned_at || 0).getTime());
        if (!fresh || Number(fresh.is_deleted) !== 0 || !sameOwner || !sameTime) { result.skipped.push({ leadId: row.id, reason: "changed" }); continue; }

        const target = pickTarget(candidates, row.assigned_to, load);
        if (!target) { result.skipped.push({ leadId: row.id, reason: "no_other_employee" }); continue; }

        const stageLabel = getStageLabelById(clock.column);
        await ops.assignLead({
          tenantId,
          leadId: row.id,
          employeeId: target.id,
          method: "auto_reassign",
          performedBy: "auto-reassign",
          reason: `No movement out of "${stageLabel}" for ${settings.days} days`,
          actor,
        });
        load.set(String(target.id), (load.get(String(target.id)) ?? (target.capacity?.currentActiveLeads || 0)) + 1);
        try {
          await ops.notify({
            tenantId,
            employeeId: row.assigned_to,
            type: "lead_auto_reassigned",
            title: "Lead moved to another employee",
            body: `${row.lead_name || "A lead"} stayed in ${stageLabel} for ${settings.days} days, so it was auto-assigned to ${target.name}.`,
            entityType: "lead",
            entityId: row.id,
          });
        } catch { /* the lead is already moved - the notice is a courtesy */ }
        result.reassigned.push({ leadId: row.id, from: row.assigned_to, to: target.id, stage: stageLabel });
      } catch (err) {
        logger.warn("Auto-reassign failed for a lead", { leadId: row.id, error: err.message });
        result.skipped.push({ leadId: row.id, reason: err.message });
      }
    }
    if (result.reassigned.length) logger.info(`Auto-reassign moved ${result.reassigned.length} stuck lead(s) (${due.length} due).`);
    return result;
  } finally {
    running = false;
  }
}

module.exports = { findDueLeads, summarizeClocks, pickTarget, runAutoReassign, autoAssignLabel };
