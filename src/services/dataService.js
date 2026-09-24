const pool = require("../../config/db");
const mock = require("../data/mockFallback");
const { PIPELINE_QUALIFIED_LEAD_SQL, CONTACTED_LEAD_SQL } = require("../utils/leadStats");
const { CALL_CONVERSATION_MIN_SEC } = require("../utils/callMetrics");
const { buildPeriodDateFilter } = require("../utils/periodFilter");
const {
  mapStageToId,
  normalizeStageLabel,
  ADMIN_PIPELINE_TO_DB_STAGE,
} = require("../utils/pipelineStages");
const { loadKanbanOppData } = require("./pipelineBoardService");
const { buildPipelineStatusGridFromKanban, KANBAN_TO_FUNNEL_COL } = require("../utils/leadKanban");

const TENANT = "default";

const CONVERTED_LEAD_SQL = `
  LOWER(COALESCE(pipeline_stage, '')) IN ('payment complete', 'converted', 'won', 'closed won')
    OR LOWER(COALESCE(status, '')) IN ('payment complete', 'converted', 'won')
`;

const CONVERTED_LEAD_SQL_ALIASED = `
  LOWER(COALESCE(l.pipeline_stage, '')) IN ('payment complete', 'converted', 'won', 'closed won')
  OR LOWER(COALESCE(l.status, '')) IN ('payment complete', 'converted', 'won')
`;

function formatINR(amount) {
  const n = Number(amount) || 0;
  if (n >= 10000000) return `₹${(n / 10000000).toFixed(1)}Cr`;
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
}

function rangeToDates(rangeKey) {
  const now = new Date();
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  let start = new Date(now);
  if (rangeKey === "today") {
    start.setHours(0, 0, 0, 0);
  } else if (rangeKey === "week") {
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
  } else if (rangeKey === "month") {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    start.setHours(0, 0, 0, 0);
  } else {
    start = null;
  }
  return { start, end };
}

function normalizeRangeKey(rangeKey = "month") {
  const raw = String(rangeKey || "month").toLowerCase();
  if (raw === "day" || raw === "today") return "today";
  if (raw === "this week" || raw === "this_week" || raw === "week") return "week";
  if (raw === "this month" || raw === "this_month" || raw === "month") return "month";
  if (raw === "custom") return "custom";
  return raw;
}

/** Period filter on leads — activity for pipeline views, created_at for lead-count KPIs. */
function appendLeadPeriodFilter(whereParts, params, options = {}, alias = "l") {
  const rangeKey = normalizeRangeKey(options.period || options.rangeKey || "month");
  const prefix = alias ? `${alias}.` : "";
  const dateMode = options.dateMode === "created" ? "created" : "activity";
  const dateCol = dateMode === "created"
    ? `${prefix}created_at`
    : `COALESCE(${prefix}last_activity_at, ${prefix}updated_at, ${prefix}created_at)`;
  const clipWeekToMonth = dateMode === "created" && options.clipWeekToMonth !== false;

  if (rangeKey === "custom" && options.startDate && options.endDate) {
    params.push(options.startDate, options.endDate);
    const a = params.length - 1;
    const b = params.length;
    whereParts.push(`DATE(${dateCol}) >= $${a} AND DATE(${dateCol}) <= $${b}`);
    return;
  }

  if (rangeKey === "all") return;

  const filter = buildPeriodDateFilter({
    period: rangeKey,
    column: dateCol,
    paramOffset: params.length + 1,
    clipWeekToMonth,
  });
  whereParts.push(filter.clause);
  params.push(...filter.params);
}

function appendColumnPeriodFilter(whereParts, params, options = {}, columnExpr) {
  const rangeKey = normalizeRangeKey(options.period || options.rangeKey || "month");

  if (rangeKey === "custom" && options.startDate && options.endDate) {
    params.push(options.startDate, options.endDate);
    const a = params.length - 1;
    const b = params.length;
    whereParts.push(`DATE(${columnExpr}) >= $${a} AND DATE(${columnExpr}) <= $${b}`);
    return;
  }

  if (rangeKey === "all") return;

  const filter = buildPeriodDateFilter({
    period: rangeKey,
    column: columnExpr,
    paramOffset: params.length + 1,
  });
  whereParts.push(filter.clause);
  params.push(...filter.params);
}

function mapStageToPipeline(stage, status = "") {
  return mapStageToId(stage, status);
}

function tempToPriority(temp) {
  const t = String(temp || "").toLowerCase();
  if (t.includes("hot")) return "HOT";
  if (t.includes("cold")) return "COLD";
  return "WARM";
}

function normalizeLeadText(value) {
  return String(value || "").toLowerCase().trim();
}

function mapLeadToPipelineColumn(row) {
  const stageId = mapStageToId(row.pipeline_stage || row.status, row.status);
  if (stageId === "not_interested") return null;
  return KANBAN_TO_FUNNEL_COL[stageId] || "Contacted";
}

function mapLeadToTemperature(row) {
  const priority = tempToPriority(row.temperature || row.priority);
  if (priority === "HOT") return "Hot";
  if (priority === "COLD") return "Cold";
  return "Warm";
}

function buildPipelineStatusGrid(rows) {
  const stages = ["Contacted", "Qualified", "Meeting", "Negotiation", "Conversion"];
  const temps = ["Hot", "Warm", "Cold"];
  const grid = {};
  temps.forEach((t) => {
    grid[t] = {};
    stages.forEach((s) => {
      grid[t][s] = 0;
    });
  });

  rows.forEach((row) => {
    const col = mapLeadToPipelineColumn(row);
    if (!col) return;
    const temp = mapLeadToTemperature(row);
    grid[temp][col] += 1;
  });

  const stageTotals = {};
  stages.forEach((s) => {
    stageTotals[s] = temps.reduce((acc, t) => acc + grid[t][s], 0);
  });

  const tempTotals = {};
  temps.forEach((t) => {
    tempTotals[t] = stages.reduce((acc, s) => acc + grid[t][s], 0);
  });

  const totalLeads = Object.values(tempTotals).reduce((a, b) => a + b, 0);
  const conversions = stageTotals.Conversion || 0;
  const overallConv = totalLeads > 0 ? Math.round((conversions / totalLeads) * 100) : 0;

  return {
    grid,
    stages,
    stageTotals,
    tempTotals,
    totalLeads,
    conversions,
    overallConv,
  };
}

async function queryPipelineLeadRows(tenantId, rangeKey = "week", service = "All Services", employee = "All Employees", periodOptions = {}) {
  const params = [tenantId];
  const whereParts = ["l.tenant_id = $1 AND l.is_deleted = 0"];

  if (service && service !== "All Services") {
    params.push(`%${service}%`);
    const idx = params.length;
    whereParts.push(`(l.form_name LIKE $${idx} OR l.keyword LIKE $${idx} OR l.source LIKE $${idx})`);
  }

  if (employee && employee !== "All Employees") {
    params.push(employee);
    const idx = params.length;
    whereParts.push(`l.assigned_to = (SELECT id FROM employees WHERE tenant_id = $1 AND name = $${idx} LIMIT 1)`);
  }

  appendLeadPeriodFilter(whereParts, params, {
    period: periodOptions.period || rangeKey,
    rangeKey,
    startDate: periodOptions.startDate,
    endDate: periodOptions.endDate,
    dateMode: periodOptions.dateMode,
    clipWeekToMonth: periodOptions.clipWeekToMonth,
  });

  const result = await pool.query(
    `SELECT l.pipeline_stage, l.status, l.temperature, l.priority, l.form_name
     FROM leads l
     WHERE ${whereParts.join(" AND ")}`,
    params,
  );

  if (result.rows.length) return result.rows;

  let legacyWhere = "1=1";
  const legacyParams = [];
  if (employee && employee !== "All Employees") {
    legacyParams.push(employee);
    legacyWhere += ` AND employee_name = $1`;
  }
  const legacy = await pool.query(
    `SELECT pipeline_stage, status, temperature, NULL AS priority, form_name
     FROM emp_leads
     WHERE ${legacyWhere}`,
    legacyParams,
  );
  return legacy.rows;
}

async function getPipelineStatusGrid(tenantId = TENANT, options = {}) {
  const {
    rangeKey = "week",
    service = "All Services",
    employee = "All Employees",
    period,
    startDate,
    endDate,
  } = options;
  const emptyGrid = buildPipelineStatusGrid([]);

  if (!(await dbReady())) {
    const empLower = String(employee || "").toLowerCase();
    if (empLower.includes("aryan")) {
      return { success: true, source: "mock", ...emptyGrid };
    }
    if (empLower.includes("ritik")) {
      const ritikGrid = buildPipelineStatusGrid([
        { pipeline_stage: "New", status: "New", temperature: "Warm Lead", form_name: "AI Automation Suite" }
      ]);
      return { success: true, source: "mock", ...ritikGrid };
    }
    const allMockLeads = [
      { pipeline_stage: "New", status: "New", temperature: "Hot Lead" },
      { pipeline_stage: "New", status: "New", temperature: "Warm Lead" },
      { pipeline_stage: "New", status: "New", temperature: "Warm Lead" },
      { pipeline_stage: "New", status: "New", temperature: "Cold Lead" },
      { pipeline_stage: "New", status: "New", temperature: "Cold Lead" },
      { pipeline_stage: "New", status: "New", temperature: "Cold Lead" },
      { pipeline_stage: "New", status: "New", temperature: "Cold Lead" },
      { pipeline_stage: "Contacted", status: "Contacted", temperature: "Warm Lead" },
      { pipeline_stage: "Contacted", status: "Contacted", temperature: "Cold Lead" },
      { pipeline_stage: "Qualified", status: "Qualified", temperature: "Warm Lead" },
      { pipeline_stage: "Qualified", status: "Qualified", temperature: "Cold Lead" },
      { pipeline_stage: "Negotiation", status: "Negotiation", temperature: "Warm Lead" },
      { pipeline_stage: "Converted", status: "Converted", temperature: "Warm Lead" },
      { pipeline_stage: "Converted", status: "Converted", temperature: "Warm Lead" }
    ];
    const allGrid = buildPipelineStatusGrid(allMockLeads);
    return { success: true, source: "mock", ...allGrid };
  }

  try {
    // Match Total Leads KPI: all leads created in the period, bucketed by CRM pipeline stage.
    const rows = await queryPipelineLeadRows(tenantId, rangeKey, service, employee, {
      period: period || rangeKey,
      startDate,
      endDate,
      dateMode: "created",
      clipWeekToMonth: true,
    });
    const built = buildPipelineStatusGrid(rows);
    return {
      success: true,
      source: rows.length ? "database" : "empty",
      ...built,
    };
  } catch (err) {
    console.error("getPipelineStatusGrid error:", err.message);
    return { success: true, source: "mock", ...emptyGrid };
  }
}

async function dbReady() {
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

async function queryLeadsStats(tenantId, periodOptions = null) {
  const periodOpts = periodOptions || { period: "all" };
  const leadCountOpts = { ...periodOpts, dateMode: "created", clipWeekToMonth: true };
  const leadParams = [tenantId];
  const leadWhere = ["(l.tenant_id = $1 OR l.tenant_id IS NULL) AND l.is_deleted = 0 AND (l.assigned_to IS NULL OR LOWER(COALESCE(e.status, 'active')) = 'active')"];
  appendLeadPeriodFilter(leadWhere, leadParams, leadCountOpts, "l");

  const callParams = [tenantId];
  const callWhere = ["tenant_id = $1"];
  appendColumnPeriodFilter(callWhere, callParams, periodOpts, "COALESCE(started_at, created_at)");

  const cashParams = [tenantId];
  const cashWhere = ["tenant_id = $1"];
  appendColumnPeriodFilter(cashWhere, cashParams, periodOpts, "COALESCE(payment_at, created_at)");

  const [result, cashResult, callsResult] = await Promise.all([
    pool.query(
      `SELECT
        COUNT(*) AS total_leads,
        COALESCE(SUM(l.expected_revenue), 0) AS pipeline_value,
        SUM(CASE WHEN ${PIPELINE_QUALIFIED_LEAD_SQL} THEN 1 ELSE 0 END) AS qualified,
        SUM(CASE WHEN ${CONTACTED_LEAD_SQL} THEN 1 ELSE 0 END) AS contacted,
        SUM(CASE WHEN ${CONVERTED_LEAD_SQL_ALIASED} THEN 1 ELSE 0 END) AS conversions,
        COALESCE(SUM(CASE WHEN ${CONVERTED_LEAD_SQL_ALIASED} THEN l.expected_revenue ELSE 0 END), 0) AS revenue
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE ${leadWhere.join(" AND ")}`,
      leadParams,
    ),
    pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS cash_collected
       FROM cash_collections
       WHERE ${cashWhere.join(" AND ")}`,
      cashParams,
    ),
    pool.query(
      `SELECT
         COUNT(*) AS total_calls,
         SUM(CASE WHEN duration_sec > 0 THEN 1 ELSE 0 END) AS connected_calls,
         SUM(CASE WHEN LOWER(direction) IN ('out', 'outbound', 'outgoing')
           AND duration_sec >= ${CALL_CONVERSATION_MIN_SEC} THEN 1 ELSE 0 END) AS conversation_calls,
         COUNT(DISTINCT CASE
           WHEN lead_id IS NOT NULL
             AND LOWER(direction) IN ('out', 'outbound', 'outgoing')
             AND duration_sec >= ${CALL_CONVERSATION_MIN_SEC}
           THEN lead_id END) AS conversation_leads
       FROM employee_calls
       WHERE ${callWhere.join(" AND ")}`,
      callParams,
    ),
  ]);

  const row = result.rows[0] || {};
  row.cash_collected = cashResult.rows[0]?.cash_collected || 0;
  row.total_calls = callsResult.rows[0]?.total_calls || 0;
  row.connected_calls = callsResult.rows[0]?.connected_calls || 0;
  row.conversation_calls = callsResult.rows[0]?.conversation_calls || 0;
  row.conversation_leads = callsResult.rows[0]?.conversation_leads || 0;
  return row;
}

function formatFilterRangeFromStats(stats, leaderboard = []) {
  const total = Number(stats.total_leads) || 0;
  const qualified = Number(stats.qualified) || 0;
  const contacted = Number(stats.contacted) || 0;
  const conversationLeads = Number(stats.conversation_leads) || 0;
  const conversions = Number(stats.conversions) || 0;
  const revenue = Number(stats.revenue) || 0;
  const pipeline = Number(stats.pipeline_value) || 0;
  const cashCollected = Number(stats.cash_collected) || 0;
  const totalCalls = Number(stats.total_calls) || 0;
  const connectedCalls = Number(stats.connected_calls) || 0;

  const pickup = totalCalls > 0
    ? Math.min(100, Math.round((connectedCalls / totalCalls) * 100))
    : 0;

  const qualNumerator = Math.max(qualified, conversationLeads);
  let qualification = total > 0
    ? Math.min(100, Math.round((qualNumerator / total) * 100))
    : 0;
  if (qualification === 0 && contacted > 0 && total > 0) {
    qualification = Math.min(100, Math.round((contacted / total) * 100));
  }

  const conversion = total > 0 ? Math.min(100, Math.round((conversions / total) * 100)) : 0;

  return {
    kpis: [
      { label: "Total Revenue", value: formatINR(revenue), icon: "DollarSign" },
      { label: "Cash Collected", value: formatINR(cashCollected), icon: "DollarSign" },
      { label: "Total Leads", value: String(total), icon: "Users" },
      { label: "Total Calls", value: String(stats.total_calls || 0), icon: "Phone" },
      { label: "Qualified Leads", value: String(qualified), icon: "FileText" },
      { label: "Pipeline Value", value: formatINR(pipeline), icon: "DollarSign" },
      { label: "Closings", value: String(conversions), icon: "Trophy" },
    ],
    leaderboard,
    metrics: {
      pickup,
      qualification,
      conversion,
    },
    insights: [],
    activity: [],
  };
}

async function buildFilterRangeForPeriod(tenantId, periodKey, options = {}) {
  const leadCountOpts = { period: periodKey, ...options, dateMode: "created", clipWeekToMonth: true };
  const [stats, leaderboard] = await Promise.all([
    queryLeadsStats(tenantId, leadCountOpts),
    queryLeaderboard(tenantId, periodKey, 3, leadCountOpts),
  ]);
  return formatFilterRangeFromStats(stats, leaderboard);
}

async function queryLeaderboard(tenantId, rangeKey = "month", limit = 3, options = {}) {
  const periodOpts = { period: rangeKey, ...options };
  const leadParams = [tenantId];
  const leadWhere = ["l.assigned_to = e.id", "l.is_deleted = 0", "l.tenant_id = $1"];
  appendLeadPeriodFilter(leadWhere, leadParams, { ...periodOpts, dateMode: "created" }, "l");

  const callParams = [tenantId];
  const callWhere = ["ec.employee_id = e.id", "ec.tenant_id = $1"];
  appendColumnPeriodFilter(callWhere, callParams, periodOpts, "COALESCE(ec.started_at, ec.created_at)");

  const meetingParams = [tenantId];
  const meetingWhere = ["m.employee_id = e.id", "m.tenant_id = $1"];
  appendColumnPeriodFilter(meetingWhere, meetingParams, periodOpts, "COALESCE(m.scheduled_at, m.created_at)");

  const cashParams = [tenantId];
  const cashWhere = ["cc.employee_id = e.id", "cc.tenant_id = $1"];
  appendColumnPeriodFilter(cashWhere, cashParams, periodOpts, "COALESCE(cc.payment_at, cc.created_at)");

  const result = await pool.query(
    `SELECT 
      e.id, 
      e.name,
      COUNT(DISTINCT l.id) AS total_leads,
      COALESCE((
        SELECT COUNT(*) FROM employee_calls ec 
        WHERE ${callWhere.join(" AND ")}
      ), 0) AS total_calls,
      COALESCE((
        SELECT COUNT(*) FROM employee_calls ec 
        WHERE ${callWhere.join(" AND ")} AND (ec.duration_sec > 0 OR LOWER(COALESCE(ec.outcome, '')) IN ('connected', 'picked_up', 'answered'))
      ), 0) AS pickup_calls,
      COALESCE((
        SELECT COUNT(*) FROM meetings m 
        WHERE ${meetingWhere.join(" AND ")}
      ), 0) + SUM(CASE WHEN LOWER(COALESCE(l.pipeline_stage, '')) IN ('meeting booked', 'meeting done', 'booked') OR LOWER(COALESCE(l.status, '')) IN ('meeting booked', 'meeting done', 'booked') THEN 1 ELSE 0 END) AS meetings_booked,
      SUM(CASE WHEN LOWER(COALESCE(l.pipeline_stage, '')) LIKE '%proposal%' OR LOWER(COALESCE(l.status, '')) LIKE '%proposal%' THEN 1 ELSE 0 END) AS proposals_sent,
      COALESCE((
        SELECT SUM(cc.amount) FROM cash_collections cc 
        WHERE ${cashWhere.join(" AND ")}
      ), 0) + COALESCE(SUM(CASE WHEN LOWER(COALESCE(l.pipeline_stage, '')) IN ('closed won', 'converted', 'payment complete') OR LOWER(COALESCE(l.status, '')) IN ('closed won', 'converted', 'payment complete', 'advance received', 'paid') THEN COALESCE(l.expected_revenue, 0) ELSE 0 END), 0) AS advance_pay
     FROM employees e
     LEFT JOIN leads l ON ${leadWhere.join(" AND ")}
     WHERE e.tenant_id = $1 AND (LOWER(COALESCE(e.status, 'active')) = 'active')
     GROUP BY e.id, e.name
     ORDER BY total_leads DESC, pickup_calls DESC, e.name ASC`,
    leadParams,
  );

  let rows = result.rows.slice(0, limit);
  if (!rows.length) {
    const emps = await pool.query(
      `SELECT name, id FROM employees WHERE tenant_id = $1 AND LOWER(COALESCE(status, 'active')) = 'active' ORDER BY name ASC LIMIT $2`,
      [tenantId, limit],
    );
    rows = emps.rows.map((r) => ({ ...r, total_leads: 0, total_calls: 0, pickup_calls: 0, meetings_booked: 0, proposals_sent: 0, advance_pay: 0 }));
  }

  return rows.map((r) => {
    const leads = Number(r.total_leads || r.leads) || 0;
    const totalCalls = Number(r.total_calls) || 0;
    const pickup = Number(r.pickup_calls) || 0;
    const meetings = Number(r.meetings_booked) || 0;
    const proposals = Number(r.proposals_sent) || 0;
    const advancePay = Number(r.advance_pay) || 0;
    return {
      id: r.id,
      name: r.name,
      leads,
      totalCalls,
      pickup,
      meetings,
      proposals,
      advancePay: formatINR(advancePay),
      rawAdvancePay: advancePay,
      convR: leads ? `${Math.round((proposals / leads) * 100)}%` : "0%",
      qualR: leads ? `${Math.min(99, Math.round(((pickup) / leads) * 100))}%` : "0%",
      conv: proposals,
      rev: formatINR(advancePay),
    };
  });
}

async function buildFilterDataFromDb(tenantId) {
  const [today, week, month] = await Promise.all([
    buildFilterRangeForPeriod(tenantId, "today"),
    buildFilterRangeForPeriod(tenantId, "week"),
    buildFilterRangeForPeriod(tenantId, "month"),
  ]);

  return { today, week, month };
}

async function getFilterRangeForPeriod(tenantId = TENANT, options = {}) {
  const period = normalizeRangeKey(options.period || options.rangeKey || "month");
  if (!(await dbReady())) {
    return { success: true, source: "empty", ...emptyFilterRange() };
  }
  try {
    const range = await buildFilterRangeForPeriod(tenantId, period, options);
    return { success: true, source: "database", ...range };
  } catch (err) {
    console.error("getFilterRangeForPeriod error:", err.message);
    return { success: true, source: "error", ...emptyFilterRange() };
  }
}

async function generateRealAiInsights(tenantId = TENANT) {
  try {
    const [leadsRes, empsRes] = await Promise.all([
      pool.query(
        `SELECT l.id, 
          COALESCE(NULLIF(TRIM(l.lead_name), ''), NULLIF(TRIM(l.company_name), ''), CONCAT('Lead #', l.id)) AS lead_name,
          COALESCE(NULLIF(TRIM(l.company_name), ''), 'Client') AS company_name,
          l.pipeline_stage, l.status, COALESCE(l.expected_revenue, 0) as revenue,
          e.name AS assigned_employee
         FROM leads l
         INNER JOIN employees e ON e.id = l.assigned_to AND LOWER(COALESCE(e.status, 'active')) = 'active'
         WHERE (l.tenant_id = $1 OR l.tenant_id IS NULL) 
           AND l.is_deleted = 0
           AND LOWER(COALESCE(l.lead_name, '')) NOT IN ('unknown', 'null', '')
         ORDER BY COALESCE(l.expected_revenue, 0) DESC, l.id DESC LIMIT 10`,
        [tenantId]
      ),
      pool.query(
        `SELECT e.id, e.name,
          (SELECT COUNT(*) FROM employee_calls ec WHERE ec.employee_id = e.id) AS total_calls,
          (SELECT COUNT(*) FROM employee_calls ec WHERE ec.employee_id = e.id AND (ec.duration_sec > 0 OR LOWER(COALESCE(ec.outcome, '')) IN ('connected', 'picked_up', 'answered'))) AS pickup_calls,
          (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = e.id AND l.is_deleted = 0) AS total_leads
         FROM employees e
         WHERE (e.tenant_id = $1 OR e.tenant_id IS NULL) 
           AND LOWER(COALESCE(e.status, 'active')) = 'active'
         ORDER BY total_calls DESC LIMIT 5`,
        [tenantId]
      ),
    ]);

    const leads = leadsRes.rows;
    const emps = empsRes.rows;

    const empNames = emps.map(e => e.name).join(", ");
    const leadNames = leads.map(l => l.lead_name).slice(0, 6).join(", ");

    const apiKey = process.env.OPENAI_API_KEY;

    if (apiKey) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1500);
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: `You are the AI Sales Performance Director for TS Publications CRM.
Analyze the active employee and lead records provided in the payload.

STRICT MANDATORY RULES:
1. You MUST focus ONLY on the exact active employees provided in the payload: ${empNames || "Sarita, Ritik Verma, Sushmit Verma, Piyush Dhingra"}.
2. You MUST use ONLY active lead names provided in the payload: ${leadNames || "Narayana Farmers AgriTech, Farlex Pharmaceuticals, Chaitanya Agarwal"}.
3. CRITICAL: Do NOT mention any inactive or former employees (e.g. Sourav, Rohan, Priya Sharma, Amit Kumar).
4. Reference exact numbers: call counts, pickups, and revenue figures (₹).

Return a JSON object:
{
  "insights": [
    {
      "type": "check" or "warn",
      "category": "Lead Detail" or "Employee Performance",
      "title": "Short title focusing on active employee or lead",
      "body": "1-2 sentence detailed summary referencing active names, revenue (₹), and call counts."
    }
  ]
}`
              },
              {
                role: "user",
                content: `Real Active Database Telemetry:\nActive Employees: ${JSON.stringify(emps)}\nActive Assigned Leads: ${JSON.stringify(leads)}`
              }
            ],
          }),
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const json = await response.json();
          const parsed = JSON.parse(json.choices[0].message.content);
          if (Array.isArray(parsed.insights) && parsed.insights.length) {
            const filtered = parsed.insights.filter(i => {
              const text = `${i.title || ""} ${i.body || ""}`.toLowerCase();
              return !text.includes("sourav") && !text.includes("rohan") && !text.includes("inactive");
            });
            if (filtered.length) {
              return filtered.map(i => ({
                type: i.type || "check",
                category: i.category || "AI Insight",
                title: i.title || "Insight",
                body: i.body || i.text || "",
                tone: i.type || "check"
              }));
            }
          }
        }
      } catch (err) {
        console.warn("OpenAI API execution fallback:", err.message);
      }
    }

    // High-Precision Telemetry Fallback (Always includes real active lead and employee names & numbers)
    const insights = [];

    if (emps.length > 0) {
      const topEmp = emps[0];
      insights.push({
        type: "check",
        category: "Employee Performance",
        title: `${topEmp.name} - Sales Activity Leader`,
        body: `${topEmp.name} leads team activity with ${topEmp.total_calls} calls logged and ${topEmp.pickup_calls} connected calls across ${topEmp.total_leads} assigned leads.`,
        tone: "check",
      });
    }

    if (leads.length > 0) {
      const topLead = leads[0];
      const leadTitle = topLead.lead_name;
      const revStr = topLead.revenue > 0 ? ` (₹${Number(topLead.revenue).toLocaleString('en-IN')})` : "";
      const empStr = topLead.assigned_employee ? ` assigned to ${topLead.assigned_employee}` : "";
      const stageStr = topLead.pipeline_stage || topLead.status || "Active";
      insights.push({
        type: "check",
        category: "Lead Detail",
        title: `High-Value Deal: ${leadTitle}`,
        body: `Lead "${leadTitle}"${revStr}${empStr} is currently in "${stageStr}" stage. Prioritize high-touch follow-up.`,
        tone: "check",
      });
    }

    if (emps.length > 1) {
      const secEmp = emps[1];
      insights.push({
        type: "check",
        category: "Employee Performance",
        title: `${secEmp.name} - High Call Volume`,
        body: `${secEmp.name} achieved ${secEmp.total_calls} calls with ${secEmp.pickup_calls} connected calls, driving active pipeline progression.`,
        tone: "check",
      });
    }

    if (leads.length > 1) {
      const secLead = leads[1];
      const leadTitle = secLead.lead_name;
      const empStr = secLead.assigned_employee ? ` assigned to ${secLead.assigned_employee}` : "";
      const stageStr = secLead.pipeline_stage || secLead.status || "New Lead";
      insights.push({
        type: "warn",
        category: "Lead Detail",
        title: `Action Required: ${leadTitle}`,
        body: `Lead "${leadTitle}"${empStr} is in "${stageStr}" stage. Schedule an immediate outreach call.`,
        tone: "warn",
      });
    }

    return insights;
  } catch (err) {
    console.error("generateRealAiInsights error:", err.message);
    return [];
  }
}

async function getAiInsightsFromDb(tenantId, context = "dashboard") {
  const result = await pool.query(
    `SELECT type, title, body, tone FROM ai_insights
     WHERE tenant_id = $1 AND (context = $2 OR context = 'all')
     ORDER BY created_at DESC LIMIT 10`,
    [tenantId, context],
  );
  if (result.rows.length) return result.rows;
  return await generateRealAiInsights(tenantId);
}

async function getActivityFromDb(limit = 10) {
  const result = await pool.query(
    `SELECT action, entity, user_name, created_at FROM activity_logs ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((r) => ({
    type: "check",
    text: r.action || `${r.entity} updated`,
  }));
}

function emptyFilterRange() {
  return {
    kpis: [
      { label: "Total Revenue", value: "₹0", icon: "DollarSign" },
      { label: "Cash Collected", value: "₹0", icon: "DollarSign" },
      { label: "Total Leads", value: "0", icon: "Users" },
      { label: "Total Calls", value: "0", icon: "Phone" },
      { label: "Qualified Leads", value: "0", icon: "FileText" },
      { label: "Pipeline Value", value: "₹0", icon: "DollarSign" },
      { label: "Closings", value: "0", icon: "Trophy" },
    ],
    leaderboard: [],
    metrics: { pickup: 0, qualification: 0, conversion: 0 },
    insights: [],
    activity: [],
  };
}

function emptyFilterData() {
  return {
    today: emptyFilterRange(),
    week: emptyFilterRange(),
    month: emptyFilterRange(),
  };
}

let dashboardBundleCache = {};

async function getDashboardBundle(tenantId = TENANT) {
  const now = Date.now();
  const cacheKey = tenantId || "default";
  if (dashboardBundleCache[cacheKey] && (now - dashboardBundleCache[cacheKey].timestamp < 15000)) {
    return dashboardBundleCache[cacheKey].data;
  }

  const empty = emptyFilterData();

  if (!(await dbReady())) {
    return {
      source: "empty",
      filterData: empty,
      revenueSeries: [],
      aiInsights: [],
      success: true,
    };
  }

  try {
    const [filterData, liveAiInsights, activity, revenueResult] = await Promise.all([
      buildFilterDataFromDb(tenantId),
      generateRealAiInsights(tenantId),
      getActivityFromDb(8),
      pool.query(
        `SELECT 
          DATE_FORMAT(c.m_date, '%b') AS month,
          COALESCE(SUM(c.rev), 0) AS revenue,
          COALESCE(SUM(c.cash), 0) AS cash_collected,
          COALESCE(SUM(c.closed_count), 0) AS closed_count
         FROM (
           SELECT l.created_at AS m_date, 
             CASE WHEN ${CONVERTED_LEAD_SQL_ALIASED.replace(/\n/g, " ")} THEN l.expected_revenue ELSE 0 END AS rev,
             0 AS cash,
             CASE WHEN ${CONVERTED_LEAD_SQL_ALIASED.replace(/\n/g, " ")} THEN 1 ELSE 0 END AS closed_count
           FROM leads l
           LEFT JOIN employees e ON e.id = l.assigned_to
           WHERE (l.tenant_id = $1 OR l.tenant_id IS NULL) 
             AND l.is_deleted = 0 
             AND (l.assigned_to IS NULL OR LOWER(COALESCE(e.status, 'active')) = 'active')
             AND l.created_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
           UNION ALL
           SELECT cc.payment_at AS m_date,
             0 AS rev,
             cc.amount AS cash,
             0 AS closed_count
           FROM cash_collections cc
           INNER JOIN employees e ON e.id = cc.employee_id AND LOWER(COALESCE(e.status, 'active')) = 'active'
           WHERE (cc.tenant_id = $1 OR cc.tenant_id IS NULL) 
             AND cc.payment_at >= DATE_SUB(NOW(), INTERVAL 6 MONTH)
         ) c
         GROUP BY DATE_FORMAT(c.m_date, '%Y-%m'), DATE_FORMAT(c.m_date, '%b')
         ORDER BY DATE_FORMAT(c.m_date, '%Y-%m')`,
        [tenantId],
      )
    ]);

    const aiInsights = liveAiInsights.length
      ? liveAiInsights.map((row) => ({
          type: row.tone || row.type || "check",
          category: row.category || "AI Insight",
          title: row.title || "Insight",
          body: row.body || "",
          tone: row.tone || row.type || "check",
        }))
      : [];

    if (activity.length) {
      for (const key of ["today", "week", "month"]) {
        if (filterData[key]) filterData[key].activity = activity;
      }
    }

    const revenueSeries = revenueResult.rows.map((r) => ({
      month: r.month,
      revenue: Math.round(Number(r.revenue) / 100000 * 10) / 10 || 0,
      cashCollected: Math.round(Number(r.cash_collected) / 100000 * 10) / 10 || 0,
      closedCount: Number(r.closed_count) || 0,
      rawRevenue: Number(r.revenue) || 0,
      rawCash: Number(r.cash_collected) || 0,
    }));

    const result = { source: "database", filterData, revenueSeries, aiInsights, success: true };
    dashboardBundleCache[cacheKey] = { timestamp: Date.now(), data: result };
    return result;
  } catch (err) {
    console.error("getDashboardBundle error:", err.message);
    return { source: "error", filterData: empty, revenueSeries: [], aiInsights: mock.aiInsights, success: true };
  }
}

function mapPipelineTaskRow(row) {
  return {
    id: row.id,
    text: row.title,
    done: row.status === "done" || row.status === "completed",
  };
}

async function loadTasksByLeadIds(tenantId, leadIds) {
  const ids = leadIds.map(Number).filter(Boolean);
  if (!ids.length) return {};

  const placeholders = ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `SELECT id, lead_id, title, status FROM tasks
     WHERE tenant_id = $1 AND lead_id IN (${placeholders}) AND status <> 'cancelled'
     ORDER BY created_at ASC`,
    [tenantId, ...ids],
  );

  const grouped = {};
  for (const row of result.rows) {
    const key = String(row.lead_id);
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(mapPipelineTaskRow(row));
  }
  return grouped;
}

async function listLeadTasks(leadId, tenantId = TENANT) {
  if (!(await dbReady())) return [];
  const result = await pool.query(
    `SELECT id, lead_id, title, status FROM tasks
     WHERE tenant_id = $1 AND lead_id = $2 AND status <> 'cancelled'
     ORDER BY created_at ASC`,
    [tenantId, leadId],
  );
  return result.rows.map(mapPipelineTaskRow);
}

async function createLeadTask(leadId, { title, assigneeId, tenantId = TENANT }) {
  if (!(await dbReady())) {
    throw new Error("Database not connected");
  }
  if (!assigneeId) {
    throw new Error("Lead must be assigned to an employee before adding tasks");
  }

  const result = await pool.query(
    `INSERT INTO tasks (tenant_id, assignee_id, lead_id, title, priority, status, due_at)
     VALUES ($1, $2, $3, $4, 'medium', 'pending', NOW()) RETURNING id, lead_id, title, status`,
    [tenantId, assigneeId, leadId, title],
  );

  const row = result.rows[0];
  if (row) return mapPipelineTaskRow(row);
  return { id: result.insertId, text: title, done: false };
}

async function updateLeadTask(taskId, patch, tenantId = TENANT) {
  if (!(await dbReady())) {
    throw new Error("Database not connected");
  }

  const fields = [];
  const params = [taskId, tenantId];
  let idx = 3;

  if (patch.status !== undefined) {
    fields.push(`status = $${idx}`);
    params.push(patch.status);
    idx += 1;
  }
  if (patch.status === "done") {
    fields.push("completed_at = NOW()");
  }
  if (patch.status === "pending") {
    fields.push("completed_at = NULL");
  }

  if (!fields.length) return null;

  fields.push("updated_at = NOW()");
  const result = await pool.query(
    `UPDATE tasks SET ${fields.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING id, lead_id, title, status`,
    params,
  );

  const row = result.rows[0];
  return row ? mapPipelineTaskRow(row) : null;
}

async function getPipelineLeads(tenantId = TENANT) {
  if (!(await dbReady())) return { source: "mock", leads: [] };

  try {
    const result = await pool.query(
      `SELECT l.*, e.name AS assignee_name, e.initials AS assignee_initials
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE l.tenant_id = $1 AND l.is_deleted = 0
       ORDER BY l.updated_at DESC`,
      [tenantId],
    );

    if (!result.rows.length) return { source: "mock", leads: [] };

    const tasksByLead = await loadTasksByLeadIds(
      tenantId,
      result.rows.map((row) => row.id),
    );

    const leads = result.rows.map((row) => {
      const assigneeName = row.assignee_name || null;
      return {
      id: String(row.id),
      stage: mapStageToPipeline(row.pipeline_stage || row.status, row.status),
      name: row.lead_name,
      company: row.company_name || "—",
      value: Number(row.expected_revenue) || 0,
      priority: tempToPriority(row.temperature),
      updatedAt: row.updated_at || row.created_at,
      city: row.city,
      source: row.source,
      winProbability: row.win_probability || 50,
      phone: row.phone,
      email: row.email,
      owner: assigneeName,
      assignee: assigneeName,
      assignee_name: assigneeName,
      employeeName: assigneeName,
      assigneeId: row.assigned_to || null,
      assignedTo: assigneeName && row.assigned_to
        ? { id: row.assigned_to, name: assigneeName, initials: row.assignee_initials }
        : null,
      nextFollowUp: row.next_follow_up_at
        ? new Date(row.next_follow_up_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
        : "",
      activities: [],
      tasks: tasksByLead[String(row.id)] || [],
      _dbId: row.id,
    };
    });

    return { source: "database", leads, success: true };
  } catch (err) {
    console.error("getPipelineLeads error:", err.message);
    return { source: "mock", leads: [] };
  }
}

async function updatePipelineLeadStage(leadId, stage, tenantId = TENANT) {
  const dbStage = ADMIN_PIPELINE_TO_DB_STAGE[stage] || normalizeStageLabel(stage);

  await pool.query(
    `UPDATE leads SET pipeline_stage = $1, status = $1, updated_at = NOW(), last_activity_at = NOW()
     WHERE id = $2 AND tenant_id = $3`,
    [dbStage, leadId, tenantId],
  );
  return { success: true };
}

async function getReportsBundle(tenantId = TENANT, options = {}) {
  const periodOpts = {
    period: options.period || options.rangeKey || "month",
    startDate: options.startDate,
    endDate: options.endDate,
  };
  const empty = {
    kpis: {
      totalRevenue: { value: "₹0", growth: "—", comparison: "vs last month" },
      conversionRate: { value: "0%", growth: "—", comparison: "vs last month" },
      momGrowth: { value: "0%", growth: "—", comparison: "vs last month" },
      forecastQ3: { value: "₹0", growth: "—", comparison: "vs last month" },
    },
    aiSummary: [],
    revenueAnalytics: [],
    leadSources: [],
    conversionByStage: [],
    team: [],
  };

  if (!(await dbReady())) return { source: "empty", ...empty, success: true };

  try {
    const stats = await queryLeadsStats(tenantId, periodOpts);
    const total = Number(stats.total_leads) || 0;
    const conversions = Number(stats.conversions) || 0;
    const revenue = Number(stats.revenue) || 0;

    const sourceParams = [tenantId];
    const sourceWhere = ["tenant_id = $1 AND is_deleted = 0"];
    appendLeadPeriodFilter(sourceWhere, sourceParams, periodOpts, null);

    const stageParams = [tenantId];
    const stageWhere = ["tenant_id = $1 AND is_deleted = 0"];
    appendLeadPeriodFilter(stageWhere, stageParams, periodOpts, null);

    const teamParams = [tenantId];
    const leadJoinParts = ["l.assigned_to = e.id", "l.is_deleted = 0", "l.tenant_id = $1"];
    appendLeadPeriodFilter(leadJoinParts, teamParams, periodOpts, "l");
    const teamLeadJoin = leadJoinParts.join(" AND ");

    const [sources, stages, team] = await Promise.all([
      pool.query(
        `SELECT source, COUNT(*) AS leads FROM leads WHERE ${sourceWhere.join(" AND ")} GROUP BY source ORDER BY leads DESC LIMIT 8`,
        sourceParams,
      ),
      pool.query(
        `SELECT pipeline_stage AS stage, COUNT(*) AS count FROM leads WHERE ${stageWhere.join(" AND ")} GROUP BY pipeline_stage`,
        stageParams,
      ),
      pool.query(
        `SELECT e.id, e.name,
          COALESCE(SUM(CASE WHEN (${CONVERTED_LEAD_SQL_ALIASED.replace(/\n/g, " ")}) THEN l.expected_revenue ELSE 0 END), 0) AS revenue,
          SUM(CASE WHEN (${CONVERTED_LEAD_SQL_ALIASED.replace(/\n/g, " ")}) THEN 1 ELSE 0 END) AS deals
         FROM employees e
         LEFT JOIN leads l ON ${teamLeadJoin}
         WHERE e.tenant_id = $1
         GROUP BY e.id, e.name ORDER BY revenue DESC LIMIT 10`,
        teamParams,
      ),
    ]);

    const dbInsights = await getAiInsightsFromDb(tenantId, "reports");

    return {
      source: total > 0 ? "database" : "empty",
      success: true,
      kpis: {
        totalRevenue: { value: formatINR(revenue), growth: "—", comparison: "vs last month" },
        conversionRate: { value: `${total ? Math.round((conversions / total) * 100) : 0}%`, growth: "—", comparison: "vs last month" },
        momGrowth: { value: "0%", growth: "—", comparison: "vs last month" },
        forecastQ3: { value: formatINR(revenue * 1.3), growth: "—", comparison: "vs last month" },
      },
      aiSummary: dbInsights.length ? dbInsights.map((i) => i.body || i.title) : [],
      revenueAnalytics: [],
      leadSources: sources.rows.map((r) => ({ source: r.source || "Unknown", leads: Number(r.leads) })),
      conversionByStage: stages.rows.map((r) => ({ stage: r.stage, count: Number(r.count) })),
      team: team.rows.map((r) => ({
        id: r.id,
        name: r.name,
        revenue: formatINR(r.revenue),
        dealsClosed: Number(r.deals) || 0,
        conversionRate: `${total ? Math.round(((Number(r.deals) || 0) / total) * 100) : 0}%`,
      })),
    };
  } catch (err) {
    console.error("getReportsBundle error:", err.message);
    return { source: "empty", ...empty, success: true };
  }
}

async function getSettings(tenantId = TENANT) {
  if (!(await dbReady())) return { source: "mock", settings: mock.DEFAULT_SETTINGS, success: true };

  try {
    const result = await pool.query(
      `SELECT settings_json FROM tenant_settings WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );
    if (result.rows[0]?.settings_json) {
      const settings = typeof result.rows[0].settings_json === "string"
        ? JSON.parse(result.rows[0].settings_json)
        : result.rows[0].settings_json;
      return { source: "database", settings, success: true };
    }
    return { source: "mock", settings: mock.DEFAULT_SETTINGS, success: true };
  } catch {
    return { source: "mock", settings: mock.DEFAULT_SETTINGS, success: true };
  }
}

async function saveSettings(tenantId, payload) {
  const json = JSON.stringify(payload);
  await pool.query(
    `INSERT INTO tenant_settings (tenant_id, settings_json) VALUES ($1, $2)
     ON DUPLICATE KEY UPDATE settings_json = VALUES(settings_json), updated_at = NOW()`,
    [tenantId, json],
  );
  return { success: true, settings: payload };
}

function isValidServiceName(name) {
  if (!name || typeof name !== "string") return false;
  const str = name.trim();
  if (!str || str === "—" || str === "undefined" || str === "null") return false;
  if (str.length > 45) return false;

  const lower = str.toLowerCase();
  const sentenceJunk = [
    "karwaega", "karwaege", "agar", "he it self", "itself", "has ", "have ",
    "will ", "want ", "because ", "asking ", "called ", "said ", "told ",
    "thinks ", "wants ", "looking for ", "need ", "needed ", "book publishing karwaega"
  ];
  if (sentenceJunk.some((word) => lower.includes(word))) return false;

  const words = str.split(/\s+/);
  if (words.length > 6) return false;

  return true;
}

function cleanServiceName(raw) {
  if (!raw || typeof raw !== "string") return "";
  let str = raw.trim();
  if (!str || str === "—" || str === "undefined" || str === "null") return "";

  const matchBracket = str.match(/\[Service:\s*([^\]]+)\]/i);
  if (matchBracket && matchBracket[1]) {
    const candidate = matchBracket[1].trim();
    if (isValidServiceName(candidate)) return candidate;
  }

  const matchColon = str.match(/^Service:\s*([^\n\r\]]+)/i);
  if (matchColon && matchColon[1]) {
    const candidate = matchColon[1].trim();
    if (isValidServiceName(candidate)) return candidate;
  }

  const matchInline = str.match(/Service:\s*([^\n\r\]]+)/i);
  if (matchInline && matchInline[1]) {
    const candidate = matchInline[1].trim();
    if (isValidServiceName(candidate)) return candidate;
  }

  if (isValidServiceName(str)) {
    return str;
  }
  return "";
}

async function generateNextServiceId(tenantId = TENANT) {
  try {
    const res = await pool.query(
      `SELECT service_code FROM services WHERE (tenant_id = $1 OR tenant_id IS NULL) AND service_code LIKE 'SRV-%'`,
      [tenantId]
    );
    const codes = (res.rows || []).map(r => parseInt((r.service_code || "").replace("SRV-", ""), 10)).filter(n => !isNaN(n));
    const nextNum = codes.length > 0 ? Math.max(...codes) + 1 : 1;
    return `SRV-${String(nextNum).padStart(3, "0")}`;
  } catch {
    return `SRV-${String(Date.now()).slice(-3)}`;
  }
}

async function generateNextSopId(tenantId = TENANT) {
  try {
    const res = await pool.query(
      `SELECT sop_code FROM sops WHERE sop_code LIKE 'SOP-%'`
    );
    const codes = (res.rows || []).map(r => parseInt((r.sop_code || "").replace("SOP-", ""), 10)).filter(n => !isNaN(n));
    const nextNum = codes.length > 0 ? Math.max(...codes) + 1 : 1;
    return `SOP-${String(nextNum).padStart(3, "0")}`;
  } catch {
    return `SOP-${String(Date.now()).slice(-3)}`;
  }
}

function normalizePhoneId(rawPhone) {
  if (!rawPhone) return "";
  const cleaned = String(rawPhone).replace(/\D/g, "");
  return cleaned.length >= 10 ? cleaned.slice(-10) : cleaned;
}

async function ensureServiceExists(tenantId = TENANT, serviceNameInput) {
  const name = cleanServiceName(serviceNameInput);
  if (!name || !isValidServiceName(name)) return null;

  try {
    // Ensure deleted_services table exists
    await pool.query(
      `CREATE TABLE IF NOT EXISTS deleted_services (
        tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
        service_id VARCHAR(128) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, name)
      )`
    );

    // Get list of permanently deleted service names
    const deletedRes = await pool.query(
      `SELECT LOWER(name) AS name, LOWER(service_id) AS service_id FROM deleted_services WHERE (tenant_id = $1 OR tenant_id IS NULL)`,
      [tenantId]
    );
    const deletedNamesSet = new Set();
    (deletedRes.rows || []).forEach(r => {
      if (r.name) deletedNamesSet.add(r.name.toLowerCase());
      if (r.service_id) deletedNamesSet.add(r.service_id.toLowerCase());
    });

    if (deletedNamesSet.has(name.toLowerCase())) {
      return null; // Do NOT recreate deleted service!
    }

    const existing = await pool.query(
      `SELECT * FROM services WHERE (tenant_id = $1 OR tenant_id IS NULL) AND (LOWER(name) = LOWER($2) OR service_code = $2) LIMIT 1`,
      [tenantId, name],
    );
    if (existing.rows && existing.rows.length > 0) {
      return existing.rows[0];
    }

    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const id = `svc-${slug || Date.now()}`;
    const serviceCode = await generateNextServiceId(tenantId);
    const newService = {
      id,
      serviceCode,
      serviceId: serviceCode,
      name,
      category: "general",
      categoryLabel: "General Services",
      status: "ACTIVE",
      badge: "POPULAR",
      description: `Auto-created service offering for ${name}`,
      revenue: 0,
      leads: 1,
      converted: 0,
      convRate: 0,
      priceNum: 0,
      price: "Custom",
      icon: "briefcase",
    };
    await createService(tenantId, newService);
    return newService;
  } catch (err) {
    console.error("[dataService] ensureServiceExists failed:", err);
    return null;
  }
}

async function listServices(tenantId = TENANT) {
  if (!(await dbReady())) return { source: "empty", services: [], success: true };

  try {
    // 1) Auto-scan leads to populate catalog with active lead services
    const deletedRes = await pool.query(
      `SELECT LOWER(name) AS name, LOWER(service_id) AS service_id FROM deleted_services WHERE (tenant_id = $1 OR tenant_id IS NULL)`,
      [tenantId]
    ).catch(() => ({ rows: [] }));
    const deletedNamesSet = new Set();
    (deletedRes.rows || []).forEach(r => {
      if (r.name) deletedNamesSet.add(r.name.toLowerCase());
      if (r.service_id) deletedNamesSet.add(r.service_id.toLowerCase());
    });

    const leadRows = await pool.query(
      `SELECT requirements, source_meta FROM leads WHERE (tenant_id = $1 OR tenant_id IS NULL) AND is_deleted = 0`,
      [tenantId],
    );
    const leadServicesFound = new Set();
    (leadRows.rows || []).forEach((row) => {
      const extracted = cleanServiceName(row.requirements);
      if (extracted && !deletedNamesSet.has(extracted.toLowerCase())) leadServicesFound.add(extracted);
      if (row.source_meta) {
        const meta = typeof row.source_meta === "string" ? JSON.parse(row.source_meta) : row.source_meta;
        if (meta?.service) {
          const metaExtracted = cleanServiceName(meta.service);
          if (metaExtracted && !deletedNamesSet.has(metaExtracted.toLowerCase())) leadServicesFound.add(metaExtracted);
        }
      }
    });

    for (const svcName of leadServicesFound) {
      await ensureServiceExists(tenantId, svcName);
    }

    // 2) Query all services from catalog
    const result = await pool.query(
      `SELECT * FROM services WHERE (tenant_id = $1 OR tenant_id IS NULL) ORDER BY created_at DESC`,
      [tenantId],
    );
    let baseServices = result.rows.length
      ? result.rows.filter((r) => isValidServiceName(r.name) && !deletedNamesSet.has((r.name || "").toLowerCase()) && !deletedNamesSet.has((r.id || "").toLowerCase()) && !deletedNamesSet.has((r.service_code || "").toLowerCase()))
      : mock.SERVICES.filter((r) => !deletedNamesSet.has((r.name || "").toLowerCase()) && !deletedNamesSet.has((r.id || "").toLowerCase()));

    // 3) Calculate actual lead metrics for each service
    const allLeadsResult = await pool.query(
      `SELECT requirements, source_meta, status, expected_revenue FROM leads WHERE (tenant_id = $1 OR tenant_id IS NULL) AND is_deleted = 0`,
      [tenantId],
    );
    const allLeads = allLeadsResult.rows || [];

    const services = baseServices.map((r) => {
      const metaObj = (typeof r.metadata === "string" ? JSON.parse(r.metadata) : r.metadata) || {};
      const svcName = r.name || metaObj.name;
      const sCode = r.service_code || metaObj.serviceCode || metaObj.serviceId || r.id;
      
      // Filter leads belonging to this service
      const matchingLeads = allLeads.filter((l) => {
        const reqSvc = cleanServiceName(l.requirements);
        if (reqSvc && reqSvc.toLowerCase() === String(svcName).toLowerCase()) return true;
        if (l.source_meta) {
          const m = typeof l.source_meta === "string" ? JSON.parse(l.source_meta) : l.source_meta;
          if (m?.service && cleanServiceName(m.service).toLowerCase() === String(svcName).toLowerCase()) return true;
        }
        return String(l.requirements || "").toLowerCase().includes(String(svcName).toLowerCase());
      });

      const leadsCount = matchingLeads.length > 0 ? matchingLeads.length : Number(r.leads) || 0;
      const convertedCount = matchingLeads.length > 0 
        ? matchingLeads.filter(l => String(l.status || "").toLowerCase().includes("converted") || String(l.status || "").toLowerCase().includes("payment")).length 
        : Number(r.converted) || 0;
      const revenueSum = matchingLeads.length > 0
        ? matchingLeads.reduce((acc, l) => acc + (Number(l.expected_revenue) || 0), 0)
        : Number(r.revenue) || 0;
      const convRate = leadsCount > 0 ? Math.round((convertedCount / leadsCount) * 100) : Number(r.conv_rate) || 0;

      return {
        ...metaObj,
        id: r.id,
        serviceId: sCode,
        serviceCode: sCode,
        name: svcName,
        category: r.category || "general",
        categoryLabel: r.category_label || "General Services",
        status: r.status || "ACTIVE",
        revenue: revenueSum,
        leads: leadsCount,
        converted: convertedCount,
        convRate: convRate,
        priceNum: Number(r.price_num) || 0,
        price: r.price_label || r.price || "Custom",
        distributionEnabled: metaObj.distributionEnabled !== undefined ? Boolean(metaObj.distributionEnabled) : true,
        distributionEmployeeIds: Array.isArray(metaObj.distributionEmployeeIds) ? metaObj.distributionEmployeeIds : [],
        distributionEmployeeNames: Array.isArray(metaObj.distributionEmployeeNames) ? metaObj.distributionEmployeeNames : [],
        description: r.description || `Service catalog offering for ${svcName}`,
        icon: r.icon || "briefcase",
      };
    });

    return { source: "database", services, success: true };
  } catch (err) {
    console.error("[dataService] listServices error:", err);
    return { source: "empty", services: [], success: true };
  }
}

async function createService(tenantId, data) {
  const id = data.id || `svc-${Date.now()}`;
  const serviceCode = data.serviceCode || data.serviceId || await generateNextServiceId(tenantId);
  const metadata = JSON.stringify({ ...data, serviceCode, serviceId: serviceCode });
  await pool.query(
    `INSERT INTO services (id, service_code, tenant_id, name, category, category_label, status, description, revenue, leads, converted, conv_rate, price_num, price_label, icon, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
     ON DUPLICATE KEY UPDATE
       service_code = COALESCE(services.service_code, VALUES(service_code)),
       name = VALUES(name),
       category = VALUES(category),
       category_label = VALUES(category_label),
       status = VALUES(status),
       description = VALUES(description),
       revenue = VALUES(revenue),
       leads = VALUES(leads),
       converted = VALUES(converted),
       conv_rate = VALUES(conv_rate),
       price_num = VALUES(price_num),
       price_label = VALUES(price_label),
       icon = VALUES(icon),
       metadata = VALUES(metadata),
       updated_at = NOW()`,
    [
      id, serviceCode, tenantId, data.name, data.category || "general", data.categoryLabel || "General Services",
      data.status || "ACTIVE", data.description || "", data.revenue || 0,
      data.leads || 0, data.converted || 0, data.convRate || 0,
      data.priceNum || 0, data.price || "Custom", data.icon || "briefcase", metadata,
    ],
  );
  return { success: true, service: { ...data, id, serviceCode, serviceId: serviceCode } };
}

async function deleteService(tenantId = TENANT, serviceId) {
  if (!(await dbReady())) return { success: false, message: "DB not available" };

  try {
    // 1) Find target service to record name & id
    const findRes = await pool.query(
      `SELECT id, name FROM services WHERE (tenant_id = $1 OR tenant_id IS NULL) AND (id = $2 OR LOWER(name) = LOWER($2) OR LOWER(id) = LOWER($2)) LIMIT 1`,
      [tenantId, serviceId]
    );
    const svcObj = findRes.rows[0];
    const targetName = svcObj?.name || serviceId;
    const targetId = svcObj?.id || serviceId;

    // 2) Delete from services table
    await pool.query(
      `DELETE FROM services WHERE (tenant_id = $1 OR tenant_id IS NULL) AND (id = $2 OR LOWER(name) = LOWER($2) OR LOWER(id) = LOWER($2))`,
      [tenantId, serviceId],
    );

    // 3) Create deleted_services table and insert blacklist record
    await pool.query(
      `CREATE TABLE IF NOT EXISTS deleted_services (
        tenant_id VARCHAR(64) NOT NULL DEFAULT 'default',
        service_id VARCHAR(128) NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (tenant_id, name)
      )`
    );

    await pool.query(
      `INSERT INTO deleted_services (tenant_id, service_id, name) VALUES ($1, $2, LOWER($3))
       ON DUPLICATE KEY UPDATE service_id = VALUES(service_id), created_at = NOW()`,
      [tenantId, targetId, targetName]
    );

    return { success: true, message: "Service permanently deleted", serviceId: targetId };
  } catch (err) {
    console.error("[dataService] deleteService error:", err);
    return { success: false, message: err.message };
  }
}

async function updateServiceDistributionIndex(tenantId, serviceId, rrIndex) {
  if (!(await dbReady())) return null;
  const result = await pool.query(
    `SELECT metadata FROM services WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenantId, serviceId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata) : (row.metadata || {});
  meta.distributionRrIndex = rrIndex;
  meta.lastDistributedAt = new Date().toISOString();
  await pool.query(
    `UPDATE services SET metadata = $1, updated_at = NOW() WHERE tenant_id = $2 AND id = $3`,
    [JSON.stringify(meta), tenantId, serviceId],
  );
  return meta;
}

async function updateServiceDistributionConfig(tenantId = TENANT, serviceId, { enabled, employeeIds, employeeNames }) {
  if (!(await dbReady())) return { success: false, message: "DB not available" };
  try {
    let result = await pool.query(
      `SELECT id, metadata FROM services WHERE tenant_id = $1 AND (id = $2 OR LOWER(name) = LOWER($2)) LIMIT 1`,
      [tenantId, serviceId],
    );
    if (!result.rows.length) {
      await ensureServiceExists(tenantId, serviceId);
      result = await pool.query(
        `SELECT id, metadata FROM services WHERE tenant_id = $1 AND (id = $2 OR LOWER(name) = LOWER($2)) LIMIT 1`,
        [tenantId, serviceId],
      );
    }
    const targetRow = result.rows[0];
    if (!targetRow) return { success: false, message: "Service record not found" };

    const meta = typeof targetRow.metadata === "string" ? JSON.parse(targetRow.metadata) : (targetRow.metadata || {});
    if (enabled !== undefined) meta.distributionEnabled = Boolean(enabled);
    if (employeeIds !== undefined) meta.distributionEmployeeIds = Array.isArray(employeeIds) ? employeeIds : [];
    if (employeeNames !== undefined) meta.distributionEmployeeNames = Array.isArray(employeeNames) ? employeeNames : [];

    await pool.query(
      `UPDATE services SET metadata = $1, updated_at = NOW() WHERE tenant_id = $2 AND id = $3`,
      [JSON.stringify(meta), tenantId, targetRow.id],
    );
    return {
      success: true,
      serviceId: targetRow.id,
      distributionEnabled: meta.distributionEnabled,
      distributionEmployeeIds: meta.distributionEmployeeIds,
      distributionEmployeeNames: meta.distributionEmployeeNames,
    };
  } catch (err) {
    console.error("[dataService] updateServiceDistributionConfig error:", err);
    return { success: false, message: err.message };
  }
}

async function listForms(tenantId = TENANT) {
  if (!(await dbReady())) return { source: "empty", forms: [], success: true };

  try {
    const result = await pool.query(
      `SELECT * FROM forms WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    const forms = result.rows.map((r) => ({
      id: r.id,
      name: r.name,
      source: r.source,
      sourceKey: r.source_key,
      status: r.status,
      leads: Number(r.leads) || 0,
      revenue: Number(r.revenue) || 0,
      conversion: Number(r.conversion) || 0,
      service: r.service,
      fields: typeof r.fields === "string" ? JSON.parse(r.fields) : r.fields || [],
    }));
    return { source: "database", forms, success: true };
  } catch {
    return { source: "empty", forms: [], success: true };
  }
}

const SOURCE_LABELS = {
  google_ads: "Google Ads",
  instagram: "Instagram",
  website: "Website",
  linkedin: "LinkedIn",
  whatsapp: "WhatsApp",
};

function normalizeFormRow(data, id) {
  const sourceKey = data.sourceKey || data.source_key || "website";
  return {
    id,
    name: data.name,
    source: data.source || SOURCE_LABELS[sourceKey] || "Website",
    sourceKey,
    status: data.status || "ACTIVE",
    service: data.service || "",
    fields: Array.isArray(data.fields) ? data.fields : [],
    leads: Number(data.leads) || 0,
    revenue: Number(data.revenue) || 0,
    conversion: Number(data.conversion) || 0,
  };
}

async function createForm(tenantId, data) {
  const id = data.id || `form-${Date.now()}`;
  const form = normalizeFormRow(data, id);
  await pool.query(
    `INSERT INTO forms (id, tenant_id, name, source, source_key, status, service, fields, leads, revenue, conversion)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      id, tenantId, form.name, form.source, form.sourceKey,
      form.status, form.service, JSON.stringify(form.fields),
      form.leads, form.revenue, form.conversion,
    ],
  );
  return { success: true, form };
}

async function updateForm(tenantId, id, data) {
  const form = normalizeFormRow({ ...data, id }, id);
  const result = await pool.query(
    `UPDATE forms SET
      name = $3, source = $4, source_key = $5, status = $6, service = $7,
      fields = $8, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [
      tenantId, id, form.name, form.source, form.sourceKey,
      form.status, form.service, JSON.stringify(form.fields),
    ],
  );
  if ((result.rowCount ?? 0) === 0) {
    const err = new Error("Form not found");
    err.statusCode = 404;
    throw err;
  }
  return { success: true, form };
}

async function saveAiInsight(tenantId, insight) {
  await pool.query(
    `INSERT INTO ai_insights (tenant_id, context, type, title, body, tone) VALUES ($1, $2, $3, $4, $5, $6)`,
    [tenantId, insight.context || "dashboard", insight.type || "rec", insight.title, insight.body, insight.tone || "info"],
  );
  return { success: true };
}

async function generateAiInsights(tenantId, context = "dashboard") {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return {
      success: true,
      source: "mock",
      message: "OpenAI API key not configured. Set OPENAI_API_KEY in backend .env when ready.",
      insights: mock.aiInsights,
    };
  }
  return {
    success: true,
    source: "mock",
    message: "OpenAI integration pending full prompt wiring.",
    insights: mock.aiInsights,
  };
}

async function getIncentivesData(tenantId = TENANT, month) {
  const settingsRes = await getSettings(tenantId);
  const settings = settingsRes.settings || mock.DEFAULT_SETTINGS;
  const targetMonth = month || new Date().toISOString().slice(0, 7);

  let teammates = [];
  if (await dbReady()) {
    try {
      const [empRes, callsRes, meetingsRes, leadsRes, cashRes] = await Promise.all([
        pool.query(
          `SELECT id, name, email, role, department, salary, call_target, qualified_lead_target, meeting_target, cash_target,
            incentive_kra, call_weightage, qualified_lead_weightage, meeting_weightage, cash_weightage
           FROM employees WHERE tenant_id = $1 AND status = 'active'`,
          [tenantId],
        ),
        pool.query(
          `SELECT employee_id, COUNT(*) AS total_calls,
             SUM(CASE WHEN duration_sec > 0 THEN 1 ELSE 0 END) AS connected_calls,
             SUM(CASE WHEN duration_sec >= ${CALL_CONVERSATION_MIN_SEC} THEN 1 ELSE 0 END) AS conversations_5min_plus
           FROM employee_calls
           WHERE tenant_id = $1 AND DATE_FORMAT(COALESCE(started_at, created_at), '%Y-%m') = $2
           GROUP BY employee_id`,
          [tenantId, targetMonth]
        ),
        pool.query(
          `SELECT employee_id, COUNT(*) AS total_meetings
           FROM meetings
           WHERE tenant_id = $1 AND DATE_FORMAT(COALESCE(scheduled_at, created_at), '%Y-%m') = $2
           GROUP BY employee_id`,
          [tenantId, targetMonth]
        ),
        pool.query(
          `SELECT assigned_to AS employee_id,
             COUNT(*) AS total_leads,
             SUM(CASE WHEN LOWER(COALESCE(pipeline_stage,'')) IN ('booked','call booked','showed up','showed_up')
                 OR LOWER(REPLACE(COALESCE(pipeline_stage,''), '_', ' ')) LIKE '%showed up%'
                 OR LOWER(REPLACE(COALESCE(pipeline_stage,''), '_', ' ')) LIKE '%show up%'
                 OR LOWER(COALESCE(status,'')) IN ('booked','showed up','show up')
                 OR LOWER(REPLACE(COALESCE(status,''), '_', ' ')) LIKE '%showed up%'
                 OR LOWER(REPLACE(COALESCE(status,''), '_', ' ')) LIKE '%show up%'
                 THEN 1 ELSE 0 END) AS qualified_leads,
             SUM(CASE WHEN LOWER(COALESCE(pipeline_stage,'')) IN ('booked','call booked')
                 OR LOWER(COALESCE(status,'')) IN ('booked')
                 THEN 1 ELSE 0 END) AS booked_leads,
             SUM(CASE WHEN LOWER(COALESCE(pipeline_stage,'')) IN ('converted','won','closed won')
                 OR   LOWER(COALESCE(status,''))  IN ('converted','won')
                 THEN 1 ELSE 0 END) AS converted_leads
           FROM leads
           WHERE tenant_id = $1 AND is_deleted = 0
             AND DATE_FORMAT(created_at, '%Y-%m') = $2
           GROUP BY assigned_to`,
          [tenantId, targetMonth]
        ),
        pool.query(
          `SELECT employee_id, COALESCE(SUM(amount), 0) AS total_cash
           FROM cash_collections
           WHERE tenant_id = $1 AND DATE_FORMAT(COALESCE(payment_at, created_at), '%Y-%m') = $2
           GROUP BY employee_id`,
          [tenantId, targetMonth]
        )
      ]);

      const callsMap = {};
      callsRes.rows.forEach(r => {
        callsMap[r.employee_id] = {
          total: Number(r.total_calls) || 0,
          connected: Number(r.connected_calls) || 0,
          conversations5Min: Number(r.conversations_5min_plus) || 0,
        };
      });

      const meetingsMap = {};
      meetingsRes.rows.forEach(r => { meetingsMap[r.employee_id] = Number(r.total_meetings) || 0; });

      const leadsMap = {};
      leadsRes.rows.forEach(r => {
        leadsMap[r.employee_id] = {
          total: Number(r.total_leads) || 0,
          qualified: Number(r.qualified_leads) || 0,
          booked: Number(r.booked_leads) || 0,
          converted: Number(r.converted_leads) || 0
        };
      });

      const cashMap = {};
      cashRes.rows.forEach(r => { cashMap[r.employee_id] = Number(r.total_cash) || 0; });

      teammates = empRes.rows.map((e) => {
        const empCalls = callsMap[e.id] || { total: 0, connected: 0, conversations5Min: 0 };
        const empLeads = leadsMap[e.id] || { total: 0, qualified: 0, booked: 0, converted: 0 };

        const pickupRate = empCalls.total > 0 ? Math.min(100, Math.round((empCalls.connected / empCalls.total) * 100)) : 0;
        const qualificationRate = empLeads.total > 0 ? Math.min(100, Math.round((empLeads.qualified / empLeads.total) * 100)) : 0;
        const conversionRate = empLeads.total > 0 ? Math.min(100, Math.round((empLeads.converted / empLeads.total) * 100)) : 0;
        const objectionHandling = Math.min(99, Math.round(qualificationRate * 0.95) || 0);
        const followUpQuality = pickupRate;

        return {
          id: e.id,
          name: e.name,
          role: e.role || e.department || "Sales Manager",
          department: e.department || "Sales & Growth",
          salary: e.salary || 0,
          callsCompleted: empCalls.conversations5Min,
          callsTarget: e.call_target || 50,
          qualifiedLeads: empLeads.qualified,
          qualifiedTarget: e.qualified_lead_target || 20,
          meetingsScheduled: empLeads.booked || meetingsMap[e.id] || 0,
          meetingsTarget: e.meeting_target || 15,
          cashCollected: cashMap[e.id] || 0,
          cashTarget: e.cash_target || 100000,
          responseTimeMin: 1.8,
          pickupRate,
          qualificationRate,
          objectionHandling,
          conversionRate,
          followUpQuality,
          targets: {
            calls: e.call_target || 50,
            qualifiedLeads: e.qualified_lead_target || 20,
            meetings: e.meeting_target || 15,
            cash: e.cash_target || 100000,
          },
          weightages: {
            calls: e.call_weightage || 0,
            qualifiedLeads: e.qualified_lead_weightage || 0,
            meetings: e.meeting_weightage || 0,
            cash: e.cash_weightage || 0,
          },
        };
      });
    } catch (err) {
      console.error("Error fetching incentives teammates data:", err);
    }
  }

  return {
    success: true,
    source: teammates.length ? "database" : "mock",
    incentiveSlabs: settings.incentiveSlabs || mock.DEFAULT_SETTINGS.incentiveSlabs,
    kpiWeights: settings.kpiWeights || mock.DEFAULT_SETTINGS.kpiWeights,
    baseIncentiveRate: settings.baseIncentiveRate ?? 2.5,
    targetBonusAmount: settings.targetBonusAmount ?? 2500,
    teammates,
    month: targetMonth,
  };
}

let salesFunnelKpiCache = {};

async function getSalesFunnelKPIs(tenantId = TENANT, options = {}) {
  const {
    employee = "All Employees",
    service = "All Services",
    period = "month",
    rangeKey,
    startDate,
    endDate,
  } = options;

  const cacheKey = `${tenantId}_${employee}_${service}_${period}_${rangeKey}_${startDate}_${endDate}`;
  const now = Date.now();
  if (salesFunnelKpiCache[cacheKey] && (now - salesFunnelKpiCache[cacheKey].timestamp < 15000)) {
    return salesFunnelKpiCache[cacheKey].data;
  }

  // If DB not available, return empty zeros — no mock data
  if (!(await dbReady())) {
    const emptyMetrics = [
      { label: "Pickup Rate",        shortLabel: "Pickup",   value: 0, rgb: "124,58,237",  desc: "Calls answered vs dialed",       trend: "—" },
      { label: "Qualification Rate", shortLabel: "Qualify",  value: 0, rgb: "220,38,120",  desc: "Qualified vs total leads",        trend: "—" },
      { label: "Conversion Rate",    shortLabel: "Convert",  value: 0, rgb: "16,185,129",  desc: "Closed deals vs total leads",     trend: "—" },
    ];
    return {
      success: true,
      source: "offline",
      kpiData: [
        { label: "Leads Assigned",  value: "0"  },
        { label: "Calls Done",      value: "0"  },
        { label: "Qualified Leads", value: "0"  },
        { label: "Meetings Done",   value: "0"  },
        { label: "Proposal Sent",   value: "0"  },
        { label: "Revenue",         value: "₹0" },
      ],
      oppData: { notContacted: 0, noMeeting: 0, stuckPipeline: 0 },
      metrics: emptyMetrics,
    };
  }

  // ── Build WHERE filters ──────────────────────────────────────────────────────
  let leadsParams = [tenantId];
  const leadsWhereParts = ["l.tenant_id = $1 AND l.is_deleted = 0"];

  if (employee && employee !== "All Employees") {
    leadsParams.push(employee);
    leadsWhereParts.push(`l.assigned_to = (SELECT id FROM employees WHERE tenant_id = $1 AND name = $${leadsParams.length} LIMIT 1)`);
  }
  if (service && service !== "All Services") {
    leadsParams.push(`%${service}%`);
    const si = leadsParams.length;
    leadsWhereParts.push(`(l.form_name LIKE $${si} OR l.keyword LIKE $${si} OR l.source LIKE $${si})`);
  }

  appendLeadPeriodFilter(leadsWhereParts, leadsParams, {
    period: period || rangeKey || "month",
    rangeKey,
    startDate,
    endDate,
  });
  const leadsWhere = leadsWhereParts.join(" AND ");

  let callsParams = [tenantId];
  let callsWhere  = "tenant_id = $1";
  const callsPeriod = normalizeRangeKey(period || rangeKey || "month");
  const callActivityCol = "COALESCE(started_at, created_at)";
  if (callsPeriod === "custom" && startDate && endDate) {
    callsParams.push(startDate, endDate);
    callsWhere += ` AND DATE(${callActivityCol}) >= $2 AND DATE(${callActivityCol}) <= $3`;
  } else if (callsPeriod !== "all") {
    const callFilter = buildPeriodDateFilter({
      period: callsPeriod,
      column: callActivityCol,
      paramOffset: 2,
    });
    callsWhere += ` AND ${callFilter.clause}`;
    callsParams.push(...callFilter.params);
  }
  if (employee && employee !== "All Employees") {
    callsParams.push(employee);
    callsWhere += ` AND employee_id = (SELECT id FROM employees WHERE tenant_id = $1 AND name = $${callsParams.length} LIMIT 1)`;
  }

  let meetingsParams = [tenantId];
  let meetingsWhere  = "tenant_id = $1";
  const meetingActivityCol = "COALESCE(scheduled_at, created_at)";
  if (callsPeriod === "custom" && startDate && endDate) {
    meetingsParams.push(startDate, endDate);
    meetingsWhere += ` AND DATE(${meetingActivityCol}) >= $2 AND DATE(${meetingActivityCol}) <= $3`;
  } else if (callsPeriod !== "all") {
    const meetingFilter = buildPeriodDateFilter({
      period: callsPeriod,
      column: meetingActivityCol,
      paramOffset: 2,
    });
    meetingsWhere += ` AND ${meetingFilter.clause}`;
    meetingsParams.push(...meetingFilter.params);
  }
  if (employee && employee !== "All Employees") {
    meetingsParams.push(employee);
    meetingsWhere += ` AND employee_id = (SELECT id FROM employees WHERE tenant_id = $1 AND name = $${meetingsParams.length} LIMIT 1)`;
  }

  // ── Run SQL KPI queries in parallel; kanban opp is best-effort ─────────────
  const [leadsResult, callsResult, meetingsResult] = await Promise.all([
    pool.query(
      `SELECT
         COUNT(*)                                                                         AS total_leads,
         SUM(CASE WHEN LOWER(COALESCE(pipeline_stage,'')) IN ('booked','call booked','showed up','showed_up')
             OR LOWER(REPLACE(COALESCE(pipeline_stage,''), '_', ' ')) LIKE '%showed up%'
             OR LOWER(REPLACE(COALESCE(pipeline_stage,''), '_', ' ')) LIKE '%show up%'
             OR LOWER(COALESCE(status,'')) IN ('booked','showed up','show up')
             OR LOWER(REPLACE(COALESCE(status,''), '_', ' ')) LIKE '%showed up%'
             OR LOWER(REPLACE(COALESCE(status,''), '_', ' ')) LIKE '%show up%'
             THEN 1 ELSE 0 END)                                                          AS qualified_leads,
         SUM(CASE WHEN LOWER(COALESCE(pipeline_stage,'')) IN ('converted','won','closed won')
             OR   LOWER(COALESCE(status,''))  IN ('converted','won')
             THEN 1 ELSE 0 END)                                                          AS converted_leads,
         SUM(CASE WHEN LOWER(COALESCE(pipeline_stage,'')) IN ('proposal sent','negotiation')
             OR   LOWER(COALESCE(status,''))  LIKE '%proposal%'
             THEN 1 ELSE 0 END)                                                          AS proposal_sent
        FROM leads l
        WHERE ${leadsWhere}`,
      leadsParams
    ),
    pool.query(
      `SELECT
         COUNT(*)                                             AS total_calls,
         SUM(CASE WHEN duration_sec > 0 THEN 1 ELSE 0 END)  AS connected_calls
       FROM employee_calls WHERE ${callsWhere}`,
      callsParams
    ),
    pool.query(
      `SELECT COUNT(*) AS meetings_done FROM meetings WHERE ${meetingsWhere}`,
      meetingsParams
    ),
  ]);

  let kanbanOpp = { totals: { not_contacted: 0, no_meeting: 0, stuck_pipeline: 0 }, grouped: {} };
  try {
    kanbanOpp = await loadKanbanOppData(tenantId, {
      employee,
      service,
      period: period || rangeKey || "month",
      rangeKey,
      startDate,
      endDate,
    });
  } catch (err) {
    console.error("loadKanbanOppData error (sales-kpis):", err);
  }

  const funnelGrid = buildPipelineStatusGridFromKanban(kanbanOpp.grouped || {});
  const kanbanScopedLeads = funnelGrid.totalLeads || 0;
  const kanbanQualified = funnelGrid.stageTotals?.Qualified || 0;
  const kanbanConversions = funnelGrid.conversions || 0;

  // ── Compute values ──────────────────────────────────────────────────────────
  const row            = leadsResult.rows[0]   || {};
  const oppTotals      = kanbanOpp.totals || { not_contacted: 0, no_meeting: 0, stuck_pipeline: 0 };
  const totalLeads     = Number(row.total_leads     || 0);
  const qualifiedLeads = Number(row.qualified_leads || 0);
  const convertedLeads = Number(row.converted_leads || 0);
  const totalCalls     = Number(callsResult.rows[0]?.total_calls     || 0);
  const connectedCalls = Number(callsResult.rows[0]?.connected_calls || 0);
  const meetingsDone   = Number(meetingsResult.rows[0]?.meetings_done || 0);

  // Rates — kanban-scoped when available so Sales funnel matches Pipeline board
  const pickupRate = totalCalls > 0 ? Math.min(100, Math.round((connectedCalls / totalCalls) * 100)) : 0;
  const qualRate = totalCalls > 0 ? Math.min(100, Math.round((meetingsDone / totalCalls) * 100)) : 0;
  const convRate = kanbanScopedLeads > 0
    ? Math.min(100, Math.round((kanbanConversions / kanbanScopedLeads) * 100))
    : (totalLeads > 0 ? Math.min(100, Math.round((convertedLeads / totalLeads) * 100)) : 0);

  const funnelResult = {
    success: true,
    source: "database",
    kpiData: [
      { label: "Leads Assigned",  value: String(totalLeads)                       },
      { label: "Calls Done",      value: String(totalCalls)                        },
      { label: "Qualified Leads", value: String(qualifiedLeads)                    },
      { label: "Meetings Done",   value: String(meetingsDone)                      },
      { label: "Proposal Sent",   value: String(row.proposal_sent || 0)            },
      { label: "Revenue",         value: formatINR(row.revenue    || 0)            },
    ],
    oppData: {
      notContacted:  oppTotals.not_contacted,
      noMeeting:     oppTotals.no_meeting,
      stuckPipeline: oppTotals.stuck_pipeline,
    },
    metrics: [
      { label: "Pickup Rate",        shortLabel: "Pickup",  value: pickupRate, rgb: "124,58,237", desc: "Calls answered vs dialed",   trend: `${pickupRate}% pickup` },
      { label: "Qualification Rate", shortLabel: "Qualify", value: qualRate,   rgb: "220,38,120", desc: "Meetings done vs total calls", trend: `${qualRate}% qualified` },
      { label: "Conversion Rate",    shortLabel: "Convert", value: convRate,   rgb: "16,185,129", desc: "Closed deals vs total leads", trend: `${convRate}% converted` },
    ],
  };

  salesFunnelKpiCache[cacheKey] = { timestamp: Date.now(), data: funnelResult };
  return funnelResult;
}


async function getOppCategoryLeads(tenantId = TENANT, options = {}) {
  const { category, employee, service, period = "month", rangeKey, startDate, endDate } = options;

  if (!(await dbReady())) {
    return { success: true, leads: [] };
  }

  const { leads } = await loadKanbanOppData(tenantId, {
    category,
    employee,
    service,
    period: period || rangeKey || "month",
    rangeKey,
    startDate,
    endDate,
  });

  return { success: true, leads };
}

async function getSalesAiInsights(tenantId = TENANT, options = {}) {
  const { employee, service } = options;
  const isSpecificEmp = employee && employee !== "All Employees";

  if (!(await dbReady())) {
    return {
      success: true,
      cards: [],
      funnelData: { value: "₹0", growth: "0%", comparison: "0% vs Target", pct: "0%", matchText: "0% target match" }
    };
  }

  try {
    let leadsWhere = ["(l.tenant_id = $1 OR l.tenant_id IS NULL)", "l.is_deleted = 0", "LOWER(COALESCE(e.status, 'active')) = 'active'"];
    let leadsParams = [tenantId];

    if (isSpecificEmp) {
      leadsParams.push(employee);
      leadsWhere.push(`e.name = $${leadsParams.length}`);
    }
    if (service && service !== "All Services") {
      leadsParams.push(`%${service}%`);
      const si = leadsParams.length;
      leadsWhere.push(`(l.requirements LIKE $${si} OR l.source_meta LIKE $${si})`);
    }

    const leadsQuery = `
      SELECT l.id, 
        COALESCE(NULLIF(TRIM(l.lead_name), ''), NULLIF(TRIM(l.company_name), ''), CONCAT('Lead #', l.id)) AS lead_name,
        COALESCE(NULLIF(TRIM(l.company_name), ''), 'Client') AS company_name,
        l.pipeline_stage, l.status, COALESCE(l.expected_revenue, 0) as revenue,
        e.name AS assigned_employee
      FROM leads l
      INNER JOIN employees e ON e.id = l.assigned_to
      WHERE ${leadsWhere.join(" AND ")}
      ORDER BY COALESCE(l.expected_revenue, 0) DESC, l.id DESC LIMIT 15
    `;

    const leadsRes = await pool.query(leadsQuery, leadsParams);
    const leads = leadsRes.rows || [];

    // Calculate real Predictive Win Funnel telemetry
    const totalRev = leads.reduce((acc, l) => acc + Number(l.revenue || 0), 0);
    const convertedLeads = leads.filter(l => {
      const st = String(l.pipeline_stage || l.status || "").toLowerCase();
      return st.includes("converted") || st.includes("won") || st.includes("closed") || st.includes("showed");
    });
    const convPct = leads.length > 0 ? Math.round((convertedLeads.length / leads.length) * 100) : 0;

    const funnelData = {
      value: formatINR(totalRev),
      growth: `${convPct}%`,
      comparison: `${convPct}% vs Target`,
      pct: `${Math.min(100, convPct || (totalRev > 0 ? 65 : 0))}%`,
      matchText: `${convPct || (totalRev > 0 ? 65 : 0)}% target match`
    };

    const apiKey = process.env.OPENAI_API_KEY;
    if (apiKey && leads.length > 0) {
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4o-mini",
            response_format: { type: "json_object" },
            messages: [
              {
                role: "system",
                content: `You are the AI Sales Performance Director for TS Publications.
Generate 3 realistic deal action insight cards based strictly on the active lead database payload provided.
Target scope: ${isSpecificEmp ? `Employee: ${employee}` : "All Active Sales Reps"}.

STRICT MANDATORY RULES:
1. ONLY reference lead names and employee names present in the payload. Do NOT use fake names like 'Nimbus Labs' or 'Pylon Corp'.
2. If payload has leads, pick top 3 real leads and construct:
   - Card 1 (High Win Probability): badge e.g. "92% WIN PROB", tone "purple", title: real lead name, desc: concise 1-sentence prediction with assigned rep name and revenue ₹, actionText: "Notify Rep", actionToast: "Rep notified"
   - Card 2 (Risk Assessment): badge e.g. "HIGH RISK", tone "warn", title: real lead name, desc: concise 1-sentence stalled pipeline alert with revenue ₹, actionText: "Send Reminder", actionToast: "Reminder sent"
   - Card 3 (Hot Lead / Action): badge e.g. "98% HOT", tone "success", title: real lead name, desc: concise 1-sentence touchpoint action, actionText: "Contact Lead", actionToast: "Initiating contact"
3. Do NOT mention any deleted/inactive employees (Sourav, Rohan, Priya Sharma).

Return JSON format:
{
  "cards": [
    { "title": "Lead Name", "badge": "92% WIN PROB", "tone": "purple"|"warn"|"success"|"info", "desc": "Text", "actionText": "Btn Text", "actionToast": "Toast Text" }
  ]
}`
              },
              {
                role: "user",
                content: `Telemetry Payload:\nLeads: ${JSON.stringify(leads.slice(0, 8))}`
              }
            ],
          }),
        });

        if (response.ok) {
          const json = await response.json();
          const parsed = JSON.parse(json.choices[0].message.content);
          if (Array.isArray(parsed.cards) && parsed.cards.length > 0) {
            const filteredCards = parsed.cards.filter(c => {
              const text = `${c.title || ""} ${c.desc || ""}`.toLowerCase();
              return !text.includes("sourav") && !text.includes("rohan") && !text.includes("nimbus");
            });
            if (filteredCards.length > 0) {
              return {
                success: true,
                cards: filteredCards,
                funnelData
              };
            }
          }
        }
      } catch (err) {
        console.warn("OpenAI Sales AI Insights error:", err.message);
      }
    }

    // Telemetry fallback built dynamically from real SQL rows
    const cards = [];
    if (leads.length > 0) {
      const l1 = leads[0];
      cards.push({
        title: l1.lead_name,
        badge: "HIGH WIN PROB",
        tone: "purple",
        desc: `Proposal & negotiation active for ${l1.company_name || l1.lead_name} (${formatINR(l1.revenue)}). Assigned to ${l1.assigned_employee}.`,
        actionText: "Notify Rep",
        actionToast: `Notified ${l1.assigned_employee} for deal follow-up`
      });

      if (leads.length > 1) {
        const l2 = leads[1];
        cards.push({
          title: l2.lead_name,
          badge: "HIGH RISK",
          tone: "warn",
          desc: `Stalled in ${l2.pipeline_stage || "pipeline"} stage. High lead value (${formatINR(l2.revenue)}) requires rep intervention.`,
          actionText: "Send Reminder",
          actionToast: `Follow-up reminder sent to ${l2.assigned_employee}`
        });
      }

      if (leads.length > 2) {
        const l3 = leads[2];
        cards.push({
          title: l3.lead_name,
          badge: "98% HOT",
          tone: "success",
          desc: `High engagement recorded for ${l3.lead_name} in ${l3.pipeline_stage || "new lead"} stage. Assigned to ${l3.assigned_employee}.`,
          actionText: "Contact Lead",
          actionToast: `Contacting ${l3.lead_name}...`
        });
      }
    }

    return {
      success: true,
      cards,
      funnelData
    };
  } catch (err) {
    console.error("getSalesAiInsights error:", err);
    return {
      success: false,
      cards: [],
      funnelData: { value: "₹0", growth: "0%", comparison: "0% vs Target", pct: "0%", matchText: "0% target match" }
    };
  }
}

module.exports = {
  TENANT,
  formatINR,
  dbReady,
  getDashboardBundle,
  getFilterRangeForPeriod,
  getPipelineLeads,
  listLeadTasks,
  createLeadTask,
  updateLeadTask,
  getPipelineStatusGrid,
  updatePipelineLeadStage,
  getReportsBundle,
  getSettings,
  saveSettings,
  listServices,
  createService,
  deleteService,
  ensureServiceExists,
  cleanServiceName,
  updateServiceDistributionIndex,
  updateServiceDistributionConfig,
  listForms,
  createForm,
  updateForm,
  saveAiInsight,
  generateAiInsights,
  getIncentivesData,
  getAiInsightsFromDb,
  getSalesFunnelKPIs,
  getOppCategoryLeads,
  getSalesAiInsights,
};
