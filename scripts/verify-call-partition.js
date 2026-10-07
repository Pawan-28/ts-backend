/**
 * Read-only check against the real employee_calls rows (SELECT only): for every employee the SQL aggregation
 * (callSqlExprs / employeeCallStats) must equal the JS classification (utils/callMetrics.js), and both must be a
 * clean partition of the total:
 *   total = conversation + short + incomingShort + notPick + rejected + missedIncoming
 *   connected = conversation + short + incomingShort ;  notConnected = notPick + rejected + missedIncoming
 *   node scripts/verify-call-partition.js [YYYY-MM]      (month used for the queryCallStats check; default 2026-09)
 */
const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const assert = require("node:assert/strict");
const pool = require("../config/db");
const M = require("../src/utils/callMetrics");
const { queryCallStats, callStatsAggSql, mapCallStatsRow } = require("../src/utils/employeeCallStats");

const month = process.argv[2] || "2026-09";
const [y, m] = month.split("-").map(Number);
const start = `${month}-01`;
const end = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;

function compare(label, sql, js) {
  assert.equal(sql.totalCalls, js.total, `${label} total`);
  assert.equal(sql.connectedCalls, js.connected, `${label} connected`);
  assert.equal(sql.conversations5MinPlus, js.conversation, `${label} conversation`);
  assert.equal(sql.shortCalls, js.short, `${label} short`);
  assert.equal(sql.incomingShortCalls, js.incomingShort, `${label} incoming short`);
  assert.equal(sql.notPickupByClient, js.noPickup, `${label} not pick`);
  assert.equal(sql.rejectedCalls, js.rejected, `${label} rejected`);
  assert.equal(sql.missedCalls, js.missedIncoming, `${label} missed incoming`);
  assert.equal(sql.notConnectedCalls, js.notConnected, `${label} not connected`);
  assert.equal(sql.incomingCalls, js.inbound, `${label} inbound`);
  assert.equal(sql.outgoingCalls, js.outbound, `${label} outbound dials`);
  assert.equal(sql.connectedOutbound, js.connectedOutbound, `${label} answered outbound`);
  assert.equal(sql.pickupRate, js.pickupRate, `${label} pickup rate`);
  assert.equal(sql.leads.conversation, js.leads.conversation, `${label} conversation leads`);
  assert.equal(sql.leads.short, js.leads.short, `${label} short leads`);
  assert.equal(sql.leads.incomingShort, js.leads.incomingShort, `${label} incoming short leads`);
  assert.equal(sql.leads.noPickup, js.leads.noPickup, `${label} not pick leads`);
  assert.equal(sql.leads.rejected, js.leads.rejected, `${label} rejected leads`);
  assert.equal(sql.leads.missedIncoming, js.leads.missedIncoming, `${label} missed leads`);
}

function assertPartition(label, s) {
  assert.equal(s.totalCalls, s.connectedCalls + s.notConnectedCalls, `${label} total = connected + not connected`);
  assert.equal(s.connectedCalls, s.conversations5MinPlus + s.shortCalls + s.incomingShortCalls, `${label} connected parts`);
  assert.equal(s.notConnectedCalls, s.notPickupByClient + s.missedCalls + s.rejectedCalls, `${label} not connected parts`);
}

(async () => {
  const employees = (await pool.query(
    "SELECT employee_id, COUNT(*) c FROM employee_calls GROUP BY employee_id ORDER BY c DESC",
  )).rows;
  let failures = 0;
  for (const e of employees) {
    // 1) ALL rows of the employee: raw SQL aggregate (no private-contact filter) vs JS classification
    const aggRow = (await pool.query(
      `SELECT ${callStatsAggSql("ec")} FROM employee_calls ec WHERE ec.employee_id = $1`, [e.employee_id],
    )).rows[0];
    const sqlAll = mapCallStatsRow(aggRow);
    const rows = (await pool.query(
      "SELECT lead_id, callyzer_call_id, id, direction, outcome, duration_sec FROM employee_calls WHERE employee_id = $1",
      [e.employee_id],
    )).rows;
    const jsAll = M.summarizeCalls(rows.map((r) => ({
      id: r.id, leadId: r.lead_id, direction: r.direction, outcome: r.outcome, durationSec: Number(r.duration_sec) || 0,
    })));
    // 2) one month through the real queryCallStats (private contacts excluded, so only checked for partition)
    const sqlMonth = await queryCallStats(pool, { tenantId: "default", employeeId: e.employee_id, month });
    try {
      assertPartition(`emp ${e.employee_id} all-time`, sqlAll);
      assertPartition(`emp ${e.employee_id} ${month}`, sqlMonth);
      assert.equal(jsAll.total, jsAll.conversation + jsAll.short + jsAll.incomingShort + jsAll.noPickup + jsAll.rejected + jsAll.missedIncoming);
      compare(`emp ${e.employee_id} all-time`, sqlAll, jsAll);
      console.log(`emp ${e.employee_id}: OK all-time total=${sqlAll.totalCalls} = conversation ${sqlAll.conversations5MinPlus} + short ${sqlAll.shortCalls} + incoming short ${sqlAll.incomingShortCalls} + not pick ${sqlAll.notPickupByClient} + rejected ${sqlAll.rejectedCalls} + missed incoming ${sqlAll.missedCalls}; pickup ${sqlAll.pickupRate}% (${sqlAll.connectedOutbound}/${sqlAll.outgoingCalls}) | ${month}: total ${sqlMonth.totalCalls}, pickup ${sqlMonth.pickupRate}%`);
    } catch (err) {
      failures += 1;
      console.error(`emp ${e.employee_id}: FAIL ${err.message}`, { sqlAll, jsAll });
    }
  }
  console.log(failures ? `${failures} FAILED` : `ALL OK (${employees.length} employees)`);
  process.exit(failures ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
