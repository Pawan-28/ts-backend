/**
 * READ-ONLY check: the SQL call history served to the Pipeline (utils/callHistory.js) must equal the JavaScript call
 * classification (utils/callMetrics.js) for EVERY person in the database. Run: node scripts/verify-call-history.js
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const pool = require("../config/db");
const { loadCallHistory, historyColumn } = require("../src/utils/callHistory");
const { callBucket, isOutboundCall } = require("../src/utils/callMetrics");

const p10 = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : ""; };

(async () => {
  const leads = (await pool.query("SELECT id, phone FROM leads WHERE is_deleted = 0")).rows;
  const keyOf = new Map(leads.map((l) => [String(l.id), p10(l.phone) || `id:${l.id}`]));
  const calls = (await pool.query("SELECT lead_id, direction, outcome, duration_sec FROM employee_calls")).rows;

  // JS side
  const js = {};
  for (const c of calls) {
    const k = keyOf.get(String(c.lead_id));
    if (!k) continue;
    const shape = { durationSec: Number(c.duration_sec) || 0, outcome: c.outcome, direction: c.direction };
    const b = callBucket(shape);
    const h = js[k] || (js[k] = { total: 0, conversation: 0, short: 0, noPickup: 0, rejected: 0, missedIncoming: 0, incomingShort: 0, outbound: 0 });
    h.total += 1;
    if (b === "conversation") h.conversation += 1;
    else if (b === "short") h.short += 1;
    else if (b === "no_pickup") h.noPickup += 1;
    else if (b === "rejected") h.rejected += 1;
    else if (b === "missed_incoming") h.missedIncoming += 1;
    else if (b === "incoming_short") h.incomingShort += 1;
    if (isOutboundCall(shape)) h.outbound += 1;
  }

  // SQL side (tenant-wide, and per-employee scope must be a subset with identical numbers)
  const sql = await loadCallHistory(pool, "default");
  const fields = ["total", "conversation", "short", "noPickup", "rejected", "missedIncoming", "incomingShort", "outbound"];
  let bad = 0; const examples = [];
  const keys = new Set([...Object.keys(js), ...Object.keys(sql)]);
  for (const k of keys) {
    const a = js[k]; const b = sql[k];
    if (!a || !b || fields.some((f) => a[f] !== b[f])) { bad += 1; if (examples.length < 3) examples.push({ k, js: a, sql: b }); }
  }
  const tally = {};
  for (const h of Object.values(sql)) { const c = historyColumn(h); tally[c] = (tally[c] || 0) + 1; }

  const emp = await pool.query("SELECT DISTINCT assigned_to FROM leads WHERE is_deleted = 0 AND assigned_to IS NOT NULL");
  let scopeBad = 0;
  for (const r of emp.rows) {
    const scoped = await loadCallHistory(pool, "default", { employeeId: r.assigned_to });
    for (const [k, v] of Object.entries(scoped)) {
      const full = sql[k];
      if (!full || fields.some((f) => full[f] !== v[f])) scopeBad += 1;
    }
  }

  console.log(`people with calls: ${Object.keys(sql).length}; columns by history: ${JSON.stringify(tally)}`);
  console.log(`SQL vs JS mismatches: ${bad}; employee-scoped vs full mismatches: ${scopeBad}`);
  for (const e of examples) console.log("  e.g.", JSON.stringify(e));
  console.log(bad === 0 && scopeBad === 0 ? "ALL OK" : "MISMATCH");
  process.exit(bad === 0 && scopeBad === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
