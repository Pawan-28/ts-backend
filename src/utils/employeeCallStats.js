const { CALL_CONVERSATION_LABEL, callSqlExprs, pickupRatePct } = require("./callMetrics");
const { buildPeriodDateFilter, buildPeriodOrCustomDateFilter } = require("./periodFilter");

function formatDurationHms(seconds) {
  const s = Number(seconds) || 0;
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, "0")).join(":");
}

/**
 * Row (from callStatsAggSql) -> API stats. The call counts are a PARTITION of totalCalls
 * (definitions live in utils/callMetrics.js - the one shared definition):
 *   totalCalls     = connectedCalls + notConnectedCalls
 *   connectedCalls = conversations5MinPlus (answered, talk >= 2 min) + shortCalls (answered OUTBOUND < 2 min)
 *                    + incomingShortCalls (answered INCOMING < 2 min)
 *   notConnectedCalls = notPickupByClient (OUTBOUND, not answered - "Not pick") + rejectedCalls
 *                       + missedCalls (INCOMING, not answered)
 * Rejected is never counted inside Not pick. `neverAttended` is a SUBSET of missedCalls (missed incoming never
 * called back / answered later).
 * pickupRate = answered OUTBOUND calls / OUTBOUND dials (utils/callMetrics.js pickupRatePct).
 * `*Leads` fields are DISTINCT leads (a lead with many calls counts once).
 */
function mapCallStatsRow(row = {}) {
  const totalCalls = Number(row.total_calls) || 0;
  const connectedCalls = Number(row.connected_calls) || 0;
  const incomingCalls = Number(row.incoming_calls) || 0;
  const outgoingCalls = Number(row.outgoing_calls) || 0;
  const missedCalls = Number(row.missed_calls) || 0;
  const rejectedCalls = Number(row.rejected_calls) || 0;
  const notPickupByClient = Number(row.not_pickup_by_client) || 0;
  const neverAttended = Number(row.never_attended_calls) || 0;
  const shortCalls = Number(row.short_calls) || 0;
  const incomingShortCalls = Number(row.incoming_short_calls) || 0;
  const uniqueClients = Number(row.unique_clients) || 0;
  const conversations5MinPlus = Number(row.conversations_5min_plus) || 0;
  const connectedOutbound = Number(row.connected_outbound_calls) || 0;
  const totalDurationSec = Number(row.total_duration_sec) || 0;
  const incomingDurationSec = Number(row.incoming_duration_sec) || 0;
  const outgoingDurationSec = Number(row.outgoing_duration_sec) || 0;

  return {
    totalCalls,
    connectedCalls,
    notConnectedCalls: Math.max(0, totalCalls - connectedCalls),
    incomingCalls,
    outgoingCalls,
    shortCalls,
    incomingShortCalls,
    missedCalls,
    rejectedCalls,
    neverAttended,
    notPickupByClient,
    uniqueClients,
    conversations5MinPlus,
    connectedOutbound,
    leads: {
      total: uniqueClients,
      connected: Number(row.connected_leads) || 0,
      conversation: Number(row.conversation_leads) || 0,
      short: Number(row.short_leads) || 0,
      incomingShort: Number(row.incoming_short_leads) || 0,
      notConnected: Number(row.not_connected_leads) || 0,
      noPickup: Number(row.no_pickup_leads) || 0,
      missedIncoming: Number(row.missed_leads) || 0,
      rejected: Number(row.rejected_leads) || 0,
    },
    // Talk time = seconds of CONNECTED calls only (ring seconds on unanswered dials are excluded).
    totalDuration: formatDurationHms(totalDurationSec),
    incomingDuration: formatDurationHms(incomingDurationSec),
    outgoingDuration: formatDurationHms(outgoingDurationSec),
    workingHours: formatDurationHms(totalDurationSec),
    conversations5MinDuration: `${conversations5MinPlus} connected calls ≥ ${CALL_CONVERSATION_LABEL}`,
    // Pickup rate = answered outbound / outbound dials (the single shared definition).
    pickupRate: pickupRatePct(connectedOutbound, outgoingCalls),
    avgDurationSec: connectedCalls > 0 ? Math.round(totalDurationSec / connectedCalls) : 0,
  };
}

function callStatsAggSql(prefix = "ec") {
  const p = prefix ? `${prefix}.` : "";
  const x = callSqlExprs(prefix);
  const clientKey = `COALESCE(${p}lead_id, ${p}callyzer_call_id, ${p}id)`;
  const distinctWhen = (cond) => `COUNT(DISTINCT CASE WHEN ${cond} THEN ${clientKey} END)`;
  const startedAt = (a) => `COALESCE(${a}.started_at, ${a}.created_at)`; // prefix is always the employee_calls alias
  return `
  COUNT(*) AS total_calls,
  SUM(CASE WHEN ${x.connected} THEN 1 ELSE 0 END) AS connected_calls,
  SUM(CASE WHEN ${x.inbound} THEN 1 ELSE 0 END) AS incoming_calls,
  SUM(CASE WHEN ${x.outbound} THEN 1 ELSE 0 END) AS outgoing_calls,
  SUM(CASE WHEN ${x.connectedOutbound} THEN 1 ELSE 0 END) AS connected_outbound_calls,
  SUM(CASE WHEN ${x.short} THEN 1 ELSE 0 END) AS short_calls,
  SUM(CASE WHEN ${x.incomingShort} THEN 1 ELSE 0 END) AS incoming_short_calls,
  SUM(CASE WHEN ${x.missedIncoming} THEN 1 ELSE 0 END) AS missed_calls,
  SUM(CASE WHEN ${x.rejected} THEN 1 ELSE 0 END) AS rejected_calls,
  SUM(CASE WHEN ${x.noPickup} THEN 1 ELSE 0 END) AS not_pickup_by_client,
  SUM(CASE WHEN ${x.missedIncoming} AND NOT EXISTS (
      SELECT 1 FROM employee_calls cb
      WHERE cb.tenant_id = ${p}tenant_id
        AND cb.employee_id = ${p}employee_id
        AND cb.lead_id = ${p}lead_id
        AND cb.id <> ${p}id
        AND ${startedAt("cb")} > ${startedAt(prefix)}
    ) THEN 1 ELSE 0 END) AS never_attended_calls,
  COUNT(DISTINCT ${clientKey}) AS unique_clients,
  ${distinctWhen(x.connected)} AS connected_leads,
  ${distinctWhen(x.conversation)} AS conversation_leads,
  ${distinctWhen(x.short)} AS short_leads,
  ${distinctWhen(x.incomingShort)} AS incoming_short_leads,
  ${distinctWhen(x.notConnected)} AS not_connected_leads,
  ${distinctWhen(x.noPickup)} AS no_pickup_leads,
  ${distinctWhen(x.missedIncoming)} AS missed_leads,
  ${distinctWhen(x.rejected)} AS rejected_leads,
  SUM(CASE WHEN ${x.connected} THEN ${x.durationSql} ELSE 0 END) AS total_duration_sec,
  SUM(CASE WHEN ${x.connected} AND ${x.inbound} THEN ${x.durationSql} ELSE 0 END) AS incoming_duration_sec,
  SUM(CASE WHEN ${x.connected} AND NOT ${x.inbound} THEN ${x.durationSql} ELSE 0 END) AS outgoing_duration_sec,
  SUM(CASE WHEN ${x.conversation} THEN 1 ELSE 0 END) AS conversations_5min_plus
`;
}

const CALL_STATS_AGG_SQL = callStatsAggSql("ec");

async function queryCallStats(poolConn, {
  tenantId, employeeId = null, period = "month", month = null, startDate = null, endDate = null,
}) {
  const filter = buildPeriodOrCustomDateFilter({
    period: month ? "month" : period,
    month,
    startDate,
    endDate,
    column: "COALESCE(ec.started_at, ec.created_at)",
    paramOffset: employeeId != null ? 3 : 2,
  });

  const params = [tenantId];
  let employeeSql = "";
  if (employeeId != null) {
    params.push(employeeId);
    employeeSql = " AND ec.employee_id = $2";
  }
  params.push(...filter.params);

  const queryText = `
    SELECT ${CALL_STATS_AGG_SQL}
    FROM employee_calls ec
    LEFT JOIN leads l ON ec.lead_id = l.id
    WHERE ec.tenant_id = $1${employeeSql}
      AND NOT EXISTS (
        SELECT 1 FROM employee_private_contacts epc
        WHERE epc.employee_id = ec.employee_id
          AND epc.tenant_id = ec.tenant_id
          AND l.phone IS NOT NULL
          AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '+', ''), '-', ''), '(', ''), 10) = epc.phone_normalized
      )
      AND ${filter.clause}
  `;

  const result = await poolConn.query(queryText, params);
  return mapCallStatsRow(result.rows[0] || {});
}

function resolvePeriodFilter(period, month, paramOffset = 3) {
  return buildPeriodDateFilter({
    period: month ? "month" : period,
    month,
    column: "COALESCE(ec.started_at, ec.created_at)",
    paramOffset,
  });
}

module.exports = {
  formatDurationHms,
  mapCallStatsRow,
  callStatsAggSql,
  CALL_STATS_AGG_SQL,
  resolvePeriodFilter,
  queryCallStats,
};
