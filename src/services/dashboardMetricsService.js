/**
 * Dashboard data layer. Every widget on the admin Dashboard (KPI tiles, Sales Pipeline Status funnel,
 * Leader Board, Key Metrics, Revenue Trajectory, AI insights) is computed here from ONE period object and
 * ONE lead universe, using the definitions in ../utils/metricDefinitions.js.
 */
const pool = require("../../config/db");
const { buildPeriodOrCustomDateFilter, sqlTodayDate } = require("../utils/periodFilter");
const { normalizeStageLabel } = require("../utils/pipelineStages");
const M = require("../utils/metricDefinitions");

const num = (v) => Number(v) || 0;

/** Push period params and return the SQL clause for `column`. "all" => no restriction. */
function periodClause(period, column, params) {
  if (!period || period.period === "all") return "1=1";
  const f = buildPeriodOrCustomDateFilter({
    period: period.period,
    startDate: period.startDate,
    endDate: period.endDate,
    column,
    paramOffset: params.length + 1,
  });
  params.push(...f.params);
  return f.clause;
}

/* ───────────────────────────── Lead universe ───────────────────────────── */

/**
 * dateMode "created"  -> leads created in the period (default: Total Leads, funnel, tiles, leaderboard)
 * dateMode "activity" -> leads touched in the period (AI insights)
 */
async function loadLeadUniverse(tenantId, period, { service, employee, employeeId, dateMode = "created" } = {}) {
  const params = [tenantId];
  const where = [
    "(l.tenant_id = $1 OR l.tenant_id IS NULL)",
    "l.is_deleted = 0",
    "(l.assigned_to IS NULL OR LOWER(COALESCE(e.status, 'active')) = 'active')",
  ];

  if (service && service !== "All Services") {
    params.push(`%${service}%`);
    const idx = params.length;
    where.push(`(l.form_name LIKE $${idx} OR l.keyword LIKE $${idx} OR l.source LIKE $${idx} OR l.requirements LIKE $${idx})`);
  }
  if (employeeId != null && employeeId !== "") {
    params.push(employeeId);
    where.push(`l.assigned_to = $${params.length}`);
  }
  if (employee && employee !== "All Employees") {
    params.push(employee);
    where.push(`l.assigned_to = (SELECT id FROM employees WHERE tenant_id = $1 AND name = $${params.length} LIMIT 1)`);
  }

  const dateCol = dateMode === "activity"
    ? "COALESCE(l.last_activity_at, l.updated_at, l.created_at)"
    : "l.created_at";
  where.push(periodClause(period, dateCol, params));

  const result = await pool.query(
    `SELECT l.id, l.assigned_to, l.pipeline_stage, l.status, l.temperature, l.priority, l.expected_revenue,
            l.assignment_status, l.accepted_at,
            COALESCE(NULLIF(TRIM(l.lead_name), ''), NULLIF(TRIM(l.company_name), ''), CONCAT('Lead #', l.id)) AS lead_name,
            COALESCE(NULLIF(TRIM(l.company_name), ''), '') AS company_name,
            e.name AS assigned_employee,
            EXISTS (SELECT 1 FROM meetings m WHERE m.lead_id = l.id AND LOWER(COALESCE(m.status, '')) <> 'cancelled') AS has_meeting,
            EXISTS (SELECT 1 FROM employee_calls ec WHERE ec.lead_id = l.id
                    AND ${M.CONVERSATION_CALL_SQL("ec")}) AS has_conversation
     FROM leads l
     LEFT JOIN employees e ON e.id = l.assigned_to
     WHERE ${where.join(" AND ")}`,
    params,
  );
  return result.rows;
}

/* ───────────────────────────── Calls / cash ───────────────────────────── */

async function queryCallStats(tenantId, period) {
  const params = [tenantId];
  const clause = periodClause(period, "COALESCE(started_at, created_at)", params);
  const out = M.OUTBOUND_CALL_SQL();
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS total_calls,
            SUM(CASE WHEN ${M.ANSWERED_CALL_SQL()} THEN 1 ELSE 0 END) AS connected_calls,
            SUM(CASE WHEN ${out} THEN 1 ELSE 0 END) AS outbound_calls,
            SUM(CASE WHEN ${M.ANSWERED_OUTBOUND_CALL_SQL()} THEN 1 ELSE 0 END) AS answered_outbound,
            SUM(CASE WHEN ${M.CONVERSATION_CALL_SQL()} THEN 1 ELSE 0 END) AS conversation_calls
     FROM employee_calls
     WHERE tenant_id = $1 AND ${clause}`,
    params,
  );
  const r = rows[0] || {};
  return {
    total_calls: num(r.total_calls),
    connected_calls: num(r.connected_calls),
    outbound_calls: num(r.outbound_calls),
    answered_outbound: num(r.answered_outbound),
    conversation_calls: num(r.conversation_calls),
  };
}

async function queryCashTotal(tenantId, period) {
  const params = [tenantId];
  const clause = periodClause(period, "COALESCE(payment_at, created_at)", params);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) AS cash_collected, COUNT(*) AS payments
     FROM cash_collections WHERE tenant_id = $1 AND ${clause}`,
    params,
  );
  return { cash_collected: num(rows[0]?.cash_collected), payments: num(rows[0]?.payments) };
}

/* ───────────────────────────── Stats (tiles) ───────────────────────────── */

/**
 * Returns the legacy flat row shape (total_leads, conversions, revenue, ...) used by the Reports bundle
 * plus `summary` / `calls` / `cash` objects for the Dashboard.
 */
async function queryDashboardStats(tenantId, periodInput) {
  const period = M.resolvePeriod(periodInput || { period: "all" });
  const [leads, calls, cash] = await Promise.all([
    loadLeadUniverse(tenantId, period),
    queryCallStats(tenantId, period),
    queryCashTotal(tenantId, period),
  ]);
  const summary = M.summarizeLeadUniverse(leads);
  return {
    total_leads: summary.total,
    pipeline_value: summary.pipelineValue,
    qualified: summary.qualified,
    contacted: summary.contacted,
    conversions: summary.closed,
    revenue: summary.revenue,
    cash_collected: cash.cash_collected,
    total_calls: calls.total_calls,
    connected_calls: calls.connected_calls,
    conversation_calls: calls.conversation_calls,
    conversation_leads: summary.qualified,
    summary,
    calls,
    cash,
    leads,
  };
}

function buildKpis(summary, calls, cash, defs) {
  const tile = (key, label, valueNum, icon, isMoney = false) => ({
    key,
    label,
    value: isMoney ? M.formatINR(valueNum) : String(valueNum),
    raw: valueNum,
    icon,
    info: `${defs[key].formula}. ${defs[key].basis}.`,
  });
  return [
    tile("totalRevenue", "Revenue", summary.revenue, "DollarSign", true),
    tile("cashCollected", "Cash Collected", cash.cash_collected, "DollarSign", true),
    tile("totalLeads", "Total Leads", summary.total, "Users"),
    tile("totalCalls", "Total Calls", calls.total_calls, "Phone"),
    tile("qualifiedLeads", "Qualified Leads", summary.qualified, "FileText"),
    tile("pipelineValue", "Pipeline Value", summary.pipelineValue, "DollarSign", true),
    tile("closings", "Closed Deals", summary.closed, "Trophy"),
  ];
}

/**
 * Lead-count tiles for other pages (Pipeline summary row). Same lead universe, period and employee/service
 * filters as the Dashboard tiles, so "Total Leads", "Pipeline Value", Hot/Warm/Cold and Not Interested can
 * never disagree between the two pages.
 */
async function getLeadSummary(tenantId, periodInput = {}, { employee, employeeId, service } = {}) {
  const period = M.resolvePeriod(periodInput);
  const leads = await loadLeadUniverse(tenantId, period, { employee, employeeId, service });
  const s = M.summarizeLeadUniverse(leads);
  const defs = M.buildDefinitions(period);
  return {
    period,
    total: s.total,
    openLeads: s.openLeads,
    closed: s.closed,
    notInterested: s.notInterested,
    pipelineValue: s.pipelineValue,
    hot: s.tempTotals.Hot,
    warm: s.tempTotals.Warm,
    cold: s.tempTotals.Cold,
    definitions: {
      totalLeads: `${defs.totalLeads.formula}. ${defs.totalLeads.basis}.`,
      pipelineValue: `${defs.pipelineValue.formula}. ${defs.pipelineValue.basis}.`,
    },
  };
}

/* ───────────────────────────── Funnel grid ───────────────────────────── */

function buildFunnelPayload(summary, period) {
  const defs = M.buildDefinitions(period);
  return {
    source: summary.total ? "database" : "empty",
    openLeads: summary.openLeads,
    grid: summary.grid,
    stages: M.FUNNEL_STAGES,
    stageTotals: summary.stageTotals,
    tempTotals: summary.tempTotals,
    totalLeads: summary.total,
    conversions: summary.closed,
    overallConv: M.pct(summary.closed, summary.total),
    notInFunnel: summary.notInFunnel,
    stageMapping: M.STAGE_TO_FUNNEL,
    definition: defs.funnel,
    period,
  };
}

async function getPipelineStatus(tenantId, options = {}) {
  const period = M.resolvePeriod(options);
  const rows = await loadLeadUniverse(tenantId, period, { service: options.service, employee: options.employee });
  const summary = M.summarizeLeadUniverse(rows);
  return { success: true, ...buildFunnelPayload(summary, period) };
}

/* ───────────────────────────── Leaderboard ───────────────────────────── */

async function queryLeaderboard(tenantId, period, summary, limit = 3) {
  const callParams = [tenantId];
  const callClause = periodClause(period, "COALESCE(ec.started_at, ec.created_at)", callParams);
  const cashParams = [tenantId];
  const cashClause = periodClause(period, "COALESCE(cc.payment_at, cc.created_at)", cashParams);
  const out = M.OUTBOUND_CALL_SQL("ec");

  const [emps, calls, cash] = await Promise.all([
    pool.query(
      `SELECT id, name FROM employees WHERE tenant_id = $1 AND LOWER(COALESCE(status, 'active')) = 'active'`,
      [tenantId],
    ),
    pool.query(
      `SELECT ec.employee_id, COUNT(*) AS total_calls,
              SUM(CASE WHEN ${out} THEN 1 ELSE 0 END) AS outbound_calls,
              SUM(CASE WHEN ${M.ANSWERED_OUTBOUND_CALL_SQL("ec")} THEN 1 ELSE 0 END) AS pickup_calls
       FROM employee_calls ec WHERE ec.tenant_id = $1 AND ${callClause}
       GROUP BY ec.employee_id`,
      callParams,
    ),
    pool.query(
      `SELECT cc.employee_id, COALESCE(SUM(cc.amount), 0) AS cash
       FROM cash_collections cc WHERE cc.tenant_id = $1 AND ${cashClause}
       GROUP BY cc.employee_id`,
      cashParams,
    ),
  ]);

  const callBy = new Map(calls.rows.map((r) => [String(r.employee_id), r]));
  const cashBy = new Map(cash.rows.map((r) => [String(r.employee_id), num(r.cash)]));

  const board = emps.rows.map((emp) => {
    const key = String(emp.id);
    const c = callBy.get(key) || {};
    const l = summary.byEmployee.get(key) || { leads: 0, qualified: 0, meetings: 0, proposals: 0, closed: 0 };
    const cashVal = cashBy.get(key) || 0;
    const totalCalls = num(c.total_calls);
    const outbound = num(c.outbound_calls);
    const pickup = num(c.pickup_calls);
    return {
      id: emp.id,
      name: emp.name,
      leads: l.leads,
      totalCalls,
      outboundCalls: outbound,
      pickup,
      pickupRate: M.pct(pickup, outbound),
      meetings: l.meetings,
      proposals: l.proposals,
      closed: l.closed,
      advancePay: M.formatINR(cashVal),
      rawAdvancePay: cashVal,
      convR: `${M.pct(l.closed, l.leads)}%`,
      qualR: `${M.pct(l.qualified, l.leads)}%`,
      conv: l.closed,
      rev: M.formatINR(cashVal),
    };
  });

  board.sort(M.compareLeaderboard);
  return board.slice(0, limit).map((row, i) => ({ ...row, rank: i + 1 }));
}

/* ───────────────────────────── Filter range (whole Dashboard payload) ───────────────────────────── */

async function buildFilterRange(tenantId, periodInput = {}) {
  const period = M.resolvePeriod(periodInput);
  const [leads, calls, cash] = await Promise.all([
    loadLeadUniverse(tenantId, period),
    queryCallStats(tenantId, period),
    queryCashTotal(tenantId, period),
  ]);
  const summary = M.summarizeLeadUniverse(leads);
  const defs = M.buildDefinitions(period);
  const leaderboard = await queryLeaderboard(tenantId, period, summary, 3);
  return {
    kpis: buildKpis(summary, calls, cash, defs),
    leaderboard,
    leaderboardRule: M.LEADERBOARD_RANK_RULE,
    metrics: M.computeRates({ summary, calls }),
    pipeline: buildFunnelPayload(summary, period),
    definitions: defs,
    period,
    insights: [],
    activity: [],
  };
}

/* ───────────────────────────── Revenue trajectory (monthly history) ───────────────────────────── */

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Last 6 calendar months, one point per month that has data (leads created or cash recorded).
 * revenue / closedCount use the SAME definition as the KPI tiles (closed-deal value among leads created in the month),
 * cash uses recorded cash collections by payment month. Months without any data are NOT zero-filled.
 */
async function queryRevenueSeries(tenantId) {
  const windowStart = `DATE_SUB(DATE_FORMAT(${sqlTodayDate()}, '%Y-%m-01'), INTERVAL 5 MONTH)`;
  const [leadRes, cashRes] = await Promise.all([
    pool.query(
      `SELECT DATE_FORMAT(l.created_at, '%Y-%m') AS ym, l.pipeline_stage, l.status,
              COUNT(*) AS cnt, COALESCE(SUM(l.expected_revenue), 0) AS rev
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE (l.tenant_id = $1 OR l.tenant_id IS NULL) AND l.is_deleted = 0
         AND (l.assigned_to IS NULL OR LOWER(COALESCE(e.status, 'active')) = 'active')
         AND l.created_at >= ${windowStart}
       GROUP BY DATE_FORMAT(l.created_at, '%Y-%m'), l.pipeline_stage, l.status`,
      [tenantId],
    ),
    pool.query(
      `SELECT DATE_FORMAT(COALESCE(payment_at, created_at), '%Y-%m') AS ym, COALESCE(SUM(amount), 0) AS cash
       FROM cash_collections
       WHERE tenant_id = $1 AND COALESCE(payment_at, created_at) >= ${windowStart}
       GROUP BY DATE_FORMAT(COALESCE(payment_at, created_at), '%Y-%m')`,
      [tenantId],
    ),
  ]);

  const months = new Map();
  const slot = (ym) => {
    if (!months.has(ym)) months.set(ym, { rev: 0, cash: 0, closed: 0, leads: 0 });
    return months.get(ym);
  };
  for (const r of leadRes.rows) {
    const s = slot(r.ym);
    s.leads += num(r.cnt);
    if (M.mapLeadKanbanStage({ pipeline_stage: r.pipeline_stage, status: r.status }) === "payment_complete") {
      s.rev += num(r.rev);
      s.closed += num(r.cnt);
    }
  }
  for (const r of cashRes.rows) slot(r.ym).cash += num(r.cash);

  const lakhs = (n) => Math.round((n / 100000) * 100) / 100;
  return [...months.keys()].sort().map((ym) => {
    const s = months.get(ym);
    return {
      month: MONTH_NAMES[Number(ym.slice(5, 7)) - 1] || ym,
      monthKey: ym,
      revenue: lakhs(s.rev),
      cashCollected: lakhs(s.cash),
      closedCount: s.closed,
      leadCount: s.leads,
      rawRevenue: s.rev,
      rawCash: s.cash,
    };
  });
}

/* ───────────────────────────── AI insights (period-aware, validated against live lead stage) ───────────────────────────── */

/** Stage-specific next action. Closed / not-interested leads never get an entry (they are excluded from outreach). */
const NEXT_ACTION = {
  lead: { cta: "Contact Lead", text: "has not been contacted yet - place the first call", early: true },
  not_pick: { cta: "Retry Call", text: "has not answered previous calls - retry at a different time", early: true },
  short_call: { cta: "Follow Up", text: "only had a short call - follow up to qualify and book a meeting", early: true },
  conversation_2min: { cta: "Book Meeting", text: "has had a conversation above 2 min - book a meeting", early: false },
  meeting_booked: { cta: "Confirm Meeting", text: "has a meeting booked - confirm the slot and prepare", early: false },
  meeting_done: { cta: "Send Proposal", text: "has completed a meeting - send the proposal", early: false },
  proposal_sent: { cta: "Follow Up", text: "has a proposal out - follow up for a decision", early: false },
  objection: { cta: "Handle Objection", text: "raised objections - negotiate and address them", early: false },
  advance_paid: { cta: "Collect Balance", text: "paid an advance - collect the balance to close", early: false },
};

function periodPhrase(period) {
  if (period.period === "today") return "today";
  if (period.period === "week") return "this week";
  if (period.period === "month") return "this month";
  if (period.period === "custom") return period.startDate === period.endDate ? `on ${period.startDate}` : `from ${period.startDate} to ${period.endDate}`;
  return "overall";
}

/** Open (not closed, not lost) leads touched in the period, with the LIVE stage read from the lead record. */
async function loadOpenLeadFacts(tenantId, period, { employee, service, limit = 8 } = {}) {
  const rows = await loadLeadUniverse(tenantId, period, { employee, service, dateMode: "activity" });
  return rows
    .map((r) => {
      const stageId = M.mapLeadKanbanStage(r);
      return {
        id: r.id,
        name: r.lead_name,
        company: r.company_name,
        owner: r.assigned_employee || null,
        value: num(r.expected_revenue),
        stageId,
        stageLabel: normalizeStageLabel(r.pipeline_stage || r.status, r.status),
      };
    })
    .filter((l) => NEXT_ACTION[l.stageId] && l.owner && !/^(unknown|null)$/i.test(l.name))
    .sort((a, b) => b.value - a.value || a.id - b.id)
    .slice(0, limit);
}

async function queryTopCallers(tenantId, period, { employee } = {}) {
  const params = [tenantId];
  const clause = periodClause(period, "COALESCE(ec.started_at, ec.created_at)", params);
  let empFilter = "";
  if (employee && employee !== "All Employees") {
    params.push(employee);
    empFilter = `AND e.name = $${params.length}`;
  }
  const { rows } = await pool.query(
    `SELECT e.name, COUNT(*) AS total_calls,
            SUM(CASE WHEN ${M.ANSWERED_OUTBOUND_CALL_SQL("ec")} THEN 1 ELSE 0 END) AS pickup_calls
     FROM employee_calls ec
     INNER JOIN employees e ON e.id = ec.employee_id AND LOWER(COALESCE(e.status, 'active')) = 'active'
     WHERE ec.tenant_id = $1 AND ${clause} ${empFilter}
     GROUP BY e.id, e.name
     ORDER BY total_calls DESC, e.name ASC
     LIMIT 3`,
    params,
  );
  return rows.map((r) => ({ name: r.name, calls: num(r.total_calls), pickup: num(r.pickup_calls) }));
}

const money = (n) => (n > 0 ? ` (${M.formatINR(n)})` : "");

async function getDashboardInsights(tenantId, periodInput = {}, filters = {}) {
  const period = M.resolvePeriod(periodInput);
  const [callers, leads, universe] = await Promise.all([
    queryTopCallers(tenantId, period, filters),
    loadOpenLeadFacts(tenantId, period, filters),
    loadLeadUniverse(tenantId, period, filters),
  ]);
  const summary = M.summarizeLeadUniverse(universe);
  const when = periodPhrase(period);
  const insights = [];

  if (callers[0] && callers[0].calls > 0) {
    const c = callers[0];
    insights.push({
      type: "check",
      category: "Employee Performance",
      title: `${c.name} - top caller ${when}`,
      body: `${c.name} leads team activity ${when} with ${c.calls} calls, ${c.pickup} answered outbound.`,
      tone: "check",
    });
  }

  leads.slice(0, 2).forEach((l, i) => {
    const act = NEXT_ACTION[l.stageId];
    insights.push({
      type: act.early ? "warn" : "check",
      category: "Lead Detail",
      title: `${i === 0 ? "Highest-value open lead" : "Open lead"}: ${l.name}`,
      body: `Lead "${l.name}"${money(l.value)} assigned to ${l.owner} is in "${l.stageLabel}" stage and ${act.text}.`,
      tone: act.early ? "warn" : "check",
    });
  });

  if (summary.total > 0) {
    insights.push({
      type: summary.closed > 0 ? "check" : "warn",
      category: "Conversion",
      title: `Conversion ${M.pct(summary.closed, summary.total)}% ${when}`,
      body: `${summary.closed} of ${summary.total} leads created ${when} reached Payment Complete; ${summary.meetings} reached a meeting and ${summary.openLeads} are still open.`,
      tone: summary.closed > 0 ? "check" : "warn",
    });
  }

  return { period, insights };
}

/** Sales page "AI Insights Center" cards + a data-derived (non-predictive) funnel snapshot. */
async function getSalesInsights(tenantId, options = {}) {
  const period = M.resolvePeriod(options);
  const { employee, service } = options;
  const [leads, universe] = await Promise.all([
    loadOpenLeadFacts(tenantId, period, { employee, service, limit: 12 }),
    loadLeadUniverse(tenantId, period, { employee, service }),
  ]);
  const summary = M.summarizeLeadUniverse(universe);

  const cards = [];
  const used = new Set();
  const take = (pred) => {
    const l = leads.find((x) => !used.has(x.id) && pred(x));
    if (l) used.add(l.id);
    return l;
  };
  const describe = (l) => {
    const act = NEXT_ACTION[l.stageId];
    const who = l.company && l.company !== l.name ? `${l.company} - ` : "";
    return `${who}${M.formatINR(l.value)} open value. In "${l.stageLabel}" stage and ${act.text}. Owner: ${l.owner}.`;
  };

  const advanced = take((l) => !NEXT_ACTION[l.stageId].early);
  if (advanced) {
    cards.push({
      title: advanced.name,
      badge: advanced.stageLabel.toUpperCase(),
      tone: "purple",
      desc: describe(advanced),
      actionText: "Notify Rep",
      actionToast: `Notified ${advanced.owner} to act on ${advanced.name}`,
    });
  }
  const early = take((l) => NEXT_ACTION[l.stageId].early);
  if (early) {
    cards.push({
      title: early.name,
      badge: early.stageLabel.toUpperCase(),
      tone: "warn",
      desc: describe(early),
      actionText: NEXT_ACTION[early.stageId].cta,
      actionToast: `${NEXT_ACTION[early.stageId].cta}: ${early.name}`,
    });
  }
  const next = take(() => true);
  if (next) {
    const act = NEXT_ACTION[next.stageId];
    cards.push({
      title: next.name,
      badge: next.stageLabel.toUpperCase(),
      tone: act.early ? "warn" : "success",
      desc: describe(next),
      actionText: act.cta,
      actionToast: `${act.cta}: ${next.name}`,
    });
  }

  const winRate = M.pct(summary.closed, summary.total);
  const funnelData = {
    // Derived from live data only - no target / prediction model is configured, so none is shown.
    label: "Open pipeline value",
    value: M.formatINR(summary.pipelineValue),
    growth: `${winRate}%`,
    comparison: `${summary.openLeads} open leads`,
    pct: `${winRate}%`,
    matchText: `${summary.closed} of ${summary.total} closed`,
    inputs: `Sum of expected revenue of ${summary.openLeads} open leads; closed / total = ${summary.closed}/${summary.total} for leads created ${periodPhrase(period)}.`,
  };

  return { success: true, period, cards, funnelData };
}

module.exports = {
  loadLeadUniverse,
  getLeadSummary,
  queryDashboardStats,
  queryCallStats,
  queryCashTotal,
  queryLeaderboard,
  buildFilterRange,
  getPipelineStatus,
  queryRevenueSeries,
  getDashboardInsights,
  getSalesInsights,
};
