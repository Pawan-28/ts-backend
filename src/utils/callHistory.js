/**
 * Full call history per PERSON (phone) — the input the Pipeline needs to place a lead in
 * Lead / Not Pick / Short Call / Conversation from what actually happened on the phone, instead of from a
 * stale stored stage or from only the calls of the selected period / current owner.
 *
 *   Conversation = answered, >= 2 min (any direction)
 *   Short Call   = answered OUTBOUND, < 2 min
 *   Not Pick     = OUTBOUND, not answered   (Rejected is its own bucket and never Not Pick)
 *   Lead         = none of the above
 *   Missed (incoming), Rejected and Incoming short never move a lead out of Lead on their own.
 *
 * The key is the last 10 digits of the lead's phone (the same key the Pipeline uses for "one card per phone"),
 * or "id:<leadId>" when the lead has no usable phone. Calls from ANY employee and ANY date are included.
 * Read-only: nothing is written or merged.
 */
const { callSqlExprs } = require("./callMetrics");

const HISTORY_COLUMN_RANK = { lead: 0, not_pick: 1, short_call: 2, conversation_2min: 3 };

/** SQL expression for the person key of a lead alias (matches frontend personPhoneKey / backend phone10). */
function personKeySql(alias = "l") {
  const digits = `REGEXP_REPLACE(COALESCE(${alias}.phone, ''), '[^0-9]', '')`;
  return `(CASE WHEN CHAR_LENGTH(${digits}) >= 10 THEN RIGHT(${digits}, 10) ELSE CONCAT('id:', ${alias}.id) END)`;
}

/** Pure: which pipeline column does this history say (priority Conversation > Short > Not Pick > Lead)? */
function historyColumn(h) {
  if (!h) return "lead";
  if (h.conversation > 0) return "conversation_2min";
  if (h.short > 0) return "short_call";
  if (h.noPickup > 0) return "not_pick";
  return "lead";
}

/** Pure: the later column of two (a stored stage can be further along than the call history). */
function furthestColumn(a, b) {
  return (HISTORY_COLUMN_RANK[b] ?? 0) > (HISTORY_COLUMN_RANK[a] ?? 0) ? b : a;
}

/**
 * @param pool       mysql pool wrapper (config/db)
 * @param tenantId
 * @param {{ employeeId?: string|number }} opts  when given, only people who have a lead assigned to that employee
 * @returns {Promise<Object<string, {conversation:number, short:number, noPickup:number, rejected:number,
 *           missedIncoming:number, incomingShort:number, outbound:number, total:number, lastCallAt:string|null}>>}
 */
async function loadCallHistory(pool, tenantId, { employeeId = null } = {}) {
  const x = callSqlExprs("ec");
  const key = personKeySql("l");
  const params = [tenantId];
  let scope = "";
  if (employeeId != null && employeeId !== "") {
    params.push(employeeId);
    // only the people this employee owns (cheap: the employee's leads are a few hundred phones)
    scope = ` AND ${key} IN (SELECT ${personKeySql("m")} FROM leads m WHERE (m.tenant_id = $1 OR m.tenant_id IS NULL) AND m.is_deleted = 0 AND m.assigned_to = $2)`;
  }
  const flag = (expr) => `SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END)`;
  const res = await pool.query(
    `SELECT ${key} AS pk,
            COUNT(*) AS total,
            ${flag(x.conversation)} AS conversation,
            ${flag(x.short)} AS short_calls,
            ${flag(x.noPickup)} AS no_pickup,
            ${flag(x.rejected)} AS rejected,
            ${flag(x.missedIncoming)} AS missed_incoming,
            ${flag(x.incomingShort)} AS incoming_short,
            ${flag(x.outbound)} AS outbound,
            MAX(COALESCE(ec.started_at, ec.created_at)) AS last_call_at
     FROM employee_calls ec
     JOIN leads l ON l.id = ec.lead_id AND l.is_deleted = 0 AND (l.tenant_id = $1 OR l.tenant_id IS NULL)
     WHERE ec.tenant_id = $1${scope}
     GROUP BY pk`,
    params,
  );
  const out = {};
  for (const r of res.rows) {
    out[String(r.pk)] = {
      total: Number(r.total) || 0,
      conversation: Number(r.conversation) || 0,
      short: Number(r.short_calls) || 0,
      noPickup: Number(r.no_pickup) || 0,
      rejected: Number(r.rejected) || 0,
      missedIncoming: Number(r.missed_incoming) || 0,
      incomingShort: Number(r.incoming_short) || 0,
      outbound: Number(r.outbound) || 0,
      lastCallAt: r.last_call_at ? new Date(r.last_call_at).toISOString() : null,
    };
  }
  return out;
}

module.exports = { loadCallHistory, personKeySql, historyColumn, furthestColumn, HISTORY_COLUMN_RANK };
