const { CALL_CONVERSATION_MIN_SEC, CALL_CONVERSATION_LABEL } = require("./callMetrics");
const { buildPeriodDateFilter } = require("./periodFilter");

function formatDurationHms(seconds) {
  const s = Number(seconds) || 0;
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  return [hrs, mins, secs].map((v) => String(v).padStart(2, "0")).join(":");
}

function mapCallStatsRow(row = {}) {
  const totalCalls = Number(row.total_calls) || 0;
  const connectedCalls = Number(row.connected_calls) || 0;
  const incomingCalls = Number(row.incoming_calls) || 0;
  const outgoingCalls = Number(row.outgoing_calls) || 0;
  const missedCalls = Number(row.missed_calls) || 0;
  const rejectedCalls = Number(row.rejected_calls) || 0;
  const notPickupByClient = Number(row.not_pickup_by_client) || 0;
  const uniqueClients = Number(row.unique_clients) || 0;
  const conversations5MinPlus = Number(row.conversations_5min_plus) || 0;
  const totalDurationSec = Number(row.total_duration_sec) || 0;
  const incomingDurationSec = Number(row.incoming_duration_sec) || 0;
  const outgoingDurationSec = Number(row.outgoing_duration_sec) || 0;

  return {
    totalCalls,
    connectedCalls,
    incomingCalls,
    outgoingCalls,
    missedCalls,
    rejectedCalls,
    neverAttended: missedCalls,
    notPickupByClient,
    uniqueClients,
    conversations5MinPlus,
    totalDuration: formatDurationHms(totalDurationSec),
    incomingDuration: formatDurationHms(incomingDurationSec),
    outgoingDuration: formatDurationHms(outgoingDurationSec),
    workingHours: formatDurationHms(totalDurationSec),
    conversations5MinDuration: `${conversations5MinPlus} connected calls ≥ ${CALL_CONVERSATION_LABEL}`,
    pickupRate: totalCalls > 0 ? Math.round((connectedCalls / totalCalls) * 100) : 0,
    avgDurationSec: connectedCalls > 0 ? Math.round(totalDurationSec / connectedCalls) : 0,
  };
}

function callStatsAggSql(prefix = "ec") {
  const p = prefix ? `${prefix}.` : "";
  return `
  COUNT(*) AS total_calls,
  SUM(CASE WHEN ${p}duration_sec > 0 THEN 1 ELSE 0 END) AS connected_calls,
  SUM(CASE WHEN LOWER(${p}direction) IN ('in', 'inbound', 'incoming') THEN 1 ELSE 0 END) AS incoming_calls,
  SUM(CASE WHEN LOWER(${p}direction) IN ('out', 'outbound', 'outgoing') THEN 1 ELSE 0 END) AS outgoing_calls,
  SUM(CASE WHEN ${p}duration_sec = 0 OR ${p}duration_sec IS NULL THEN 1 ELSE 0 END) AS missed_calls,
  SUM(CASE WHEN ${p}outcome = 'rejected' THEN 1 ELSE 0 END) AS rejected_calls,
  SUM(CASE WHEN (
      LOWER(${p}direction) IN ('out', 'outbound', 'outgoing')
      OR LOWER(COALESCE(${p}outcome, '')) IN ('rejected', 'not connected', 'not pick', 'no answer', 'busy', 'unanswered', 'not answered')
    ) AND (
      ${p}duration_sec = 0 OR ${p}duration_sec IS NULL
      OR (
        COALESCE(${p}duration_sec, 0) < ${CALL_CONVERSATION_MIN_SEC}
        AND LOWER(COALESCE(${p}outcome, '')) IN ('rejected', 'not connected', 'not pick', 'no answer', 'busy', 'unanswered', 'not answered')
      )
    ) THEN 1 ELSE 0 END) AS not_pickup_by_client,
  COUNT(DISTINCT COALESCE(${p}lead_id, ${p}callyzer_call_id, ${p}id)) AS unique_clients,
  SUM(${p}duration_sec) AS total_duration_sec,
  SUM(CASE WHEN LOWER(${p}direction) IN ('in', 'inbound') THEN ${p}duration_sec ELSE 0 END) AS incoming_duration_sec,
  SUM(CASE WHEN LOWER(${p}direction) IN ('out', 'outbound') THEN ${p}duration_sec ELSE 0 END) AS outgoing_duration_sec,
  SUM(CASE WHEN ${p}duration_sec >= ${CALL_CONVERSATION_MIN_SEC} THEN 1 ELSE 0 END) AS conversations_5min_plus
`;
}

const CALL_STATS_AGG_SQL = callStatsAggSql("ec");

async function queryCallStats(poolConn, { tenantId, employeeId = null, period = "month", month = null }) {
  const filter = buildPeriodDateFilter({
    period: month ? "month" : period,
    month,
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
