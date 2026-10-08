/**
 * Database side of the 3-day stuck-lead clock (the rules themselves are pure, in utils/stageClock.js).
 *
 *   getSettings(tenantId)                 -> { enabled, days, enabledAt }  (tenant settings `autoReassign`, OFF by default)
 *   stampStageEntered({...})              -> remembers WHEN a lead's stored stage changed (leads.source_meta.stageClock)
 *   loadOpenLeadRows(tenantId, {...})     -> assigned, not-deleted leads that could carry a clock
 *   clocksForLeadRows(tenantId, rows, {}) -> Map leadId -> clock (calls of each PERSON are read in one batch)
 */
const pool = require("../../config/db");
const { logger } = require("../config/logger");
const { personKeySql } = require("../utils/callHistory");
const { computeStageClock } = require("../utils/stageClock");
const { mapStageToId } = require("../utils/pipelineStages");
const { readAutoReassign } = require("../utils/autoReassignSettings");

const CHUNK = 400;

async function getSettings(tenantId = "default") {
  const dataService = require("./dataService");
  try {
    const { settings } = await dataService.getSettings(tenantId);
    return readAutoReassign(settings);
  } catch (err) {
    logger.warn("Could not read the auto-reassign settings", { error: err.message });
    return readAutoReassign(null);
  }
}

const parseMeta = (v) => {
  if (v && typeof v === "object") return v;
  try { const p = JSON.parse(v || "{}"); return p && typeof p === "object" ? p : {}; } catch { return {}; }
};

/**
 * Remember when this lead entered `stage`. Best effort - it never throws (a stage change must not fail because of the clock).
 * Only a REAL change counts: the caller passes the stage it had before.
 */
async function stampStageEntered({ tenantId = "default", leadId, before, after, at = new Date() }) {
  try {
    if (!leadId) return false;
    const fromId = mapStageToId(before?.stage, before?.status);
    const toId = mapStageToId(after?.stage, after?.status);
    if (fromId === toId) return false;
    const res = await pool.query("SELECT source_meta FROM leads WHERE id = $1 LIMIT 1", [leadId]);
    if (!res.rows.length) return false;
    const meta = parseMeta(res.rows[0].source_meta);
    meta.stageClock = { stage: after.stage || toId, enteredAt: new Date(at).toISOString() };
    await pool.query("UPDATE leads SET source_meta = $1 WHERE id = $2", [JSON.stringify(meta), leadId]);
    return true;
  } catch (err) {
    logger.warn("Could not record when the lead entered its stage", { leadId, error: err.message });
    return false;
  }
}

/** Leads that are assigned to someone and not deleted. `employeeId` limits it to one employee. */
async function loadOpenLeadRows(tenantId, { employeeId = null, assignedBefore = null } = {}) {
  const params = [tenantId];
  let where = "(l.tenant_id = $1 OR l.tenant_id IS NULL) AND l.is_deleted = 0 AND l.assigned_to IS NOT NULL";
  if (employeeId != null && employeeId !== "") { params.push(employeeId); where += ` AND l.assigned_to = $${params.length}`; }
  if (assignedBefore) { params.push(assignedBefore); where += ` AND (l.assigned_at IS NULL OR l.assigned_at <= $${params.length})`; }
  const res = await pool.query(
    `SELECT l.id, l.lead_name, l.phone, l.pipeline_stage, l.status, l.temperature, l.assigned_to, l.assigned_at, l.created_at,
            l.assignment_status, l.requirements, l.insights, l.source_meta
     FROM leads l WHERE ${where}`,
    params,
  );
  return res.rows;
}

const personKeyOf = (row) => {
  const digits = String(row.phone || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : `id:${row.id}`;
};

/** Every call of the given people (any employee, any date): Map personKey -> [{ startedAt, direction, outcome, durationSec }]. */
async function loadCallsByPerson(tenantId, keys) {
  const out = new Map();
  const unique = [...new Set(keys)];
  const keySql = personKeySql("l");
  for (let i = 0; i < unique.length; i += CHUNK) {
    const part = unique.slice(i, i + CHUNK);
    const marks = part.map((_, k) => `$${k + 2}`).join(", ");
    const res = await pool.query(
      `SELECT ${keySql} AS pk, COALESCE(ec.started_at, ec.created_at) AS at, ec.direction, ec.outcome, ec.duration_sec
       FROM employee_calls ec
       JOIN leads l ON l.id = ec.lead_id AND l.is_deleted = 0 AND (l.tenant_id = $1 OR l.tenant_id IS NULL)
       WHERE ec.tenant_id = $1 AND ${keySql} IN (${marks})`,
      [tenantId, ...part],
    );
    for (const r of res.rows) {
      const k = String(r.pk);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push({ startedAt: r.at, direction: r.direction, outcome: r.outcome, durationSec: Number(r.duration_sec) || 0 });
    }
  }
  return out;
}

/** @returns {Promise<Map<string, ReturnType<typeof computeStageClock>>>} keyed by lead id (string) */
async function clocksForLeadRows(tenantId, rows, { now = Date.now(), days, floorAt = null } = {}) {
  const callsByPerson = await loadCallsByPerson(tenantId, rows.map(personKeyOf));
  const out = new Map();
  for (const row of rows) {
    const meta = parseMeta(row.source_meta);
    const stamp = meta.stageClock;
    // a stamp counts only while it still describes the stage the lead is in
    const stampValid = stamp && mapStageToId(stamp.stage, "") === mapStageToId(row.pipeline_stage, row.status);
    out.set(String(row.id), computeStageClock({
      stage: row.pipeline_stage,
      status: row.status,
      temperature: row.temperature,
      calls: callsByPerson.get(personKeyOf(row)) || [],
      stageEnteredAt: stampValid ? stamp.enteredAt : null,
      assignedAt: row.assigned_at,
      createdAt: row.created_at,
      floorAt,
      now,
      days,
    }));
  }
  return out;
}

module.exports = { getSettings, stampStageEntered, loadOpenLeadRows, loadCallsByPerson, clocksForLeadRows, personKeyOf };
