// Auto pipeline stage from Callyzer calls:
//   Lead -> Not Pick -> Short Call -> Conversation
//
// Called after every Callyzer call is saved (webhook + sync). It only ever MOVES A LEAD FORWARD
// inside the early funnel and never touches leads a salesperson/admin already moved to
// Meeting Booked or later. Thresholds come from utils/callMetrics (single source of truth).
const repo = require("../repositories/operationalRepo");
const pool = require("../../config/db");
const { logger } = require("../config/logger");
const { emitTenant, emitEmployee } = require("../realtime/socket");
const { callKanbanColumn } = require("../utils/leadKanban");
const { mapStageToId, getStageLabelById } = require("../utils/pipelineStages");

const EARLY_RANK = { lead: 0, not_pick: 1, short_call: 2, conversation_2min: 3 };

/** Stage id this single call implies, or null (e.g. incoming missed call). */
function stageForCall(call) {
  return callKanbanColumn(call);
}

/**
 * @param {{tenantId:string, leadId:string|number, call:{durationSec?:number,direction?:string,outcome?:string}}} args
 * @returns {Promise<{changed:boolean, from?:string, to?:string}>}
 */
async function applyCallToLeadStage({ tenantId, leadId, call }) {
  try {
    if (!leadId || !call) return { changed: false };
    const target = stageForCall(call);
    if (!target || !(target in EARLY_RANK)) return { changed: false };

    const lead = await repo.findLeadById(tenantId, leadId);
    if (!lead) return { changed: false };

    const currentId = mapStageToId(lead.pipelineStage, lead.status);
    // Advanced stages (meeting booked, proposal, paid, not interested...) are never overwritten.
    if (!(currentId in EARLY_RANK)) return { changed: false };
    // Forward only: a later short call must not pull a Conversation lead back.
    if (EARLY_RANK[target] <= EARLY_RANK[currentId]) return { changed: false };

    const toLabel = getStageLabelById(target);
    const fromLabel = getStageLabelById(currentId);

    // Same write as the admin drag (stage + status), but without stage_is_manual (this is automatic).
    const updated = await repo.updateLead(tenantId, leadId, {
      pipelineStage: toLabel,
      status: toLabel,
      lastActivityAt: new Date(),
    });

    const event = await repo.insertTimeline({
      tenantId,
      leadId,
      type: "stage_change",
      summary: `Auto: ${fromLabel} → ${toLabel} (Callyzer call)`,
      payload: { from: fromLabel, to: toLabel, auto: true, durationSec: call.durationSec ?? null, outcome: call.outcome ?? null },
      actorId: "system:callyzer",
      actorName: "Callyzer Auto Pipeline",
      actorRole: "system",
    });
    emitTenant(tenantId, "lead.timeline", event);
    if (updated) {
      emitTenant(tenantId, "lead.updated", updated);
      const assigneeId = updated.assignedTo?.id ?? updated.assignedTo;
      if (assigneeId) emitEmployee(tenantId, assigneeId, "lead.updated", updated);
    }
    return { changed: true, from: fromLabel, to: toLabel };
  } catch (err) {
    // Never break call sync because of a stage update.
    logger.warn("Auto pipeline stage update failed", { leadId, message: err.message });
    return { changed: false };
  }
}

/** One-off backfill: replay every stored call (oldest first) through the same rule. */
async function backfillFromStoredCalls(tenantId) {
  const { rows } = await pool.query(
    `SELECT lead_id, direction, outcome, duration_sec, started_at
       FROM employee_calls
      WHERE tenant_id = $1 AND lead_id IS NOT NULL
      ORDER BY started_at ASC`,
    [tenantId],
  );
  let changed = 0;
  for (const r of rows) {
    const res = await applyCallToLeadStage({
      tenantId,
      leadId: r.lead_id,
      call: { direction: r.direction, outcome: r.outcome, durationSec: Number(r.duration_sec) || 0 },
    });
    if (res.changed) changed += 1;
  }
  return { calls: rows.length, changed };
}

module.exports = { applyCallToLeadStage, backfillFromStoredCalls, stageForCall };
