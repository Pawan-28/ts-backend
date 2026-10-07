const dataService = require("../services/dataService");
const dashboardMetrics = require("../services/dashboardMetricsService");
const mock = require("../data/mockFallback");

const getDashboard = async (req, res) => {
  try {
    const bundle = await dataService.getDashboardBundle();
    res.json({
      success: true,
      source: bundle.source,
      profile: { name: "Alex", role: "Sales Manager", growth: "18.4%" },
      filterData: bundle.filterData,
      revenueSeries: bundle.revenueSeries,
      aiInsights: bundle.aiInsights,
      kpis: bundle.filterData?.week?.kpis,
      insights: bundle.filterData?.week?.insights?.map((i) => i.text) || [],
      leaderboard: bundle.filterData?.week?.leaderboard,
      metrics: bundle.filterData?.week?.metrics,
    });
  } catch (err) {
    res.json({
      success: true,
      source: "error",
      filterData: {
        today: { kpis: [], leaderboard: [], metrics: { pickup: 0, qualification: 0, conversion: 0 }, insights: [], activity: [] },
        week: { kpis: [], leaderboard: [], metrics: { pickup: 0, qualification: 0, conversion: 0 }, insights: [], activity: [] },
        month: { kpis: [], leaderboard: [], metrics: { pickup: 0, qualification: 0, conversion: 0 }, insights: [], activity: [] },
      },
      revenueSeries: [],
      aiInsights: [],
    });
  }
};

const getRevenue = async (req, res) => {
  try {
    // Monthly HISTORY (last 6 months, by lead-created / payment month) - not the selected period.
    const revenueSeries = await dataService.getRevenueSeries();
    res.json({ success: true, revenue: revenueSeries, revenueSeries, basis: "monthly-history" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

// AI insights for the SAME period object as the KPI tiles (preset or custom From/To).
const getDashboardInsights = async (req, res) => {
  try {
    const data = await dataService.getDashboardInsightsForPeriod(undefined, {
      period: req.query.period || req.query.range,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      employee: req.query.employee,
      service: req.query.service,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getPipeline = async (req, res) => {
  const { leads, source } = await dataService.getPipelineLeads();
  const stageCounts = {};
  leads.forEach((l) => {
    stageCounts[l.stage] = (stageCounts[l.stage] || 0) + 1;
  });
  res.json({
    source,
    pipeline: Object.entries(stageCounts).map(([stage, count]) => ({ stage, count })),
    leads,
    serviceBreakdown: mock.FILTER_DATA.week ? [] : [],
  });
};

const getPipelineStatus = async (req, res) => {
  try {
    const rangeKey = req.query.period || req.query.range || "week";
    const service = req.query.service || "All Services";
    const data = await dataService.getPipelineStatusGrid(undefined, {
      rangeKey,
      period: rangeKey,
      service,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getFilterRange = async (req, res) => {
  try {
    const data = await dataService.getFilterRangeForPeriod(undefined, {
      period: req.query.period || req.query.range || "month",
      rangeKey: req.query.range || req.query.period,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json(data);
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getLeadSummary = async (req, res) => {
  try {
    const data = await dashboardMetrics.getLeadSummary(
      "default", // same default tenant the other dashboard endpoints use (dataService TENANT)
      {
        period: req.query.period || req.query.range || "month",
        startDate: req.query.startDate,
        endDate: req.query.endDate,
      },
      { employee: req.query.employee, service: req.query.service },
    );
    res.json({ success: true, ...data });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getPipelineLeads = async (req, res) => {
  const result = await dataService.getPipelineLeads();
  res.json(result);
};

const patchPipelineLead = async (req, res) => {
  try {
    const { stage } = req.body;
    await dataService.updatePipelineLeadStage(req.params.id, stage);
    res.json({ success: true });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
};

const getLeadTasks = async (req, res) => {
  try {
    const tasks = await dataService.listLeadTasks(req.params.id);
    res.json({ success: true, tasks });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const createLeadTask = async (req, res) => {
  try {
    const { title, assigneeId } = req.body;
    if (!title?.trim()) {
      return res.status(400).json({ success: false, message: "Task title is required" });
    }
    const task = await dataService.createLeadTask(req.params.id, {
      title: title.trim(),
      assigneeId: assigneeId || req.body.assignee_id,
    });
    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const patchLeadTask = async (req, res) => {
  try {
    const task = await dataService.updateLeadTask(req.params.taskId, req.body);
    if (!task) {
      return res.status(404).json({ success: false, message: "Task not found" });
    }
    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const getRecentLeads = async (req, res) => {
  const { leads } = await dataService.getPipelineLeads();
  if (leads.length) {
    res.json({
      leads: leads.slice(0, 10).map((l) => ({
        id: l._dbId || l.id,
        name: l.name,
        company: l.company,
        status: l.stage,
        revenue: dataService.formatINR(l.value),
      })),
    });
    return;
  }
  res.json({
    leads: [
      { id: 1, name: "Rohit Sharma", company: "Infosys", status: "Qualified", revenue: "₹1.2L" },
    ],
  });
};

const getLeadById = async (req, res) => {
  const { id } = req.params;
  const { leads } = await dataService.getPipelineLeads();
  const found = leads.find((l) => String(l._dbId || l.id) === String(id));
  if (found) {
    res.json({
      id,
      company: found.company,
      contact: found.name,
      email: found.email,
      phone: found.phone,
      revenue: dataService.formatINR(found.value),
      stage: found.stage,
      priority: found.priority,
      aiSuggestions: mock.aiInsights.map((i) => i.title),
    });
    return;
  }
  res.json({
    id,
    company: "Infosys",
    contact: "Rohit Sharma",
    aiSuggestions: mock.aiInsights.map((i) => i.title),
  });
};

// ── AI (Gemini) cost for call transcripts + MoM summaries ───────────────────────────
// Each processed call stores a "[GEMINI CHARGES]" block at the top of employee_calls.ai_summary
// (see aiService.buildGeminiChargesBlock). This reads those blocks back and totals them.
const pool = require("../../config/db");
const { buildPeriodOrCustomDateFilter, isValidDateKey } = require("../utils/periodFilter");

const APP_TZ_MIN = (() => {
  const m = String(process.env.APP_TZ_OFFSET || "+05:30").match(/^([+-])(\d{2}):(\d{2})$/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 330;
})();

const istToday = () => new Date(Date.now() + APP_TZ_MIN * 60000).toISOString().slice(0, 10);
const addDays = (key, n) => new Date(new Date(`${key}T00:00:00Z`).getTime() + n * 86400000).toISOString().slice(0, 10);

function parseGeminiCharges(summary) {
  const text = String(summary || "");
  const at = text.indexOf("[GEMINI CHARGES]");
  if (at < 0) return null;
  const block = text.slice(at, at + 700);
  const total = block.match(/Total:\s*₹\s*([\d,.]+)\s*\(\$\s*([\d.]+)\)/);
  if (!total) return null;
  const inr = (re) => { const m = block.match(re); return m ? Number(m[1].replace(/,/g, "")) : 0; };
  return {
    inr: Number(total[1].replace(/,/g, "")),
    usd: Number(total[2]),
    transcriptInr: inr(/Transcript:\s*₹\s*([\d,.]+)/),
    momInr: inr(/MoM:\s*₹\s*([\d,.]+)/),
  };
}

async function aiCostForFilter(filter) {
  const col = "COALESCE(started_at, created_at)";
  const { rows } = await pool.query(
    `SELECT DATE_FORMAT(${col}, '%Y-%m-%d') AS day, SUBSTRING(ai_summary, 1, 900) AS head
     FROM employee_calls
     WHERE ai_summary LIKE '%[GEMINI CHARGES]%' AND ${filter.clause}`,
    filter.params,
  );
  const out = { inr: 0, usd: 0, transcriptInr: 0, momInr: 0, calls: 0, byDay: {} };
  for (const r of rows) {
    const c = parseGeminiCharges(r.head);
    if (!c) continue;
    out.inr += c.inr; out.usd += c.usd; out.transcriptInr += c.transcriptInr; out.momInr += c.momInr; out.calls += 1;
    const d = (out.byDay[r.day] ||= { inr: 0, usd: 0, calls: 0 });
    d.inr += c.inr; d.usd += c.usd; d.calls += 1;
  }
  return out;
}

const round2 = (n) => Math.round(n * 100) / 100;
const shape = (t) => ({ inr: round2(t.inr), usd: Math.round(t.usd * 10000) / 10000, transcriptInr: round2(t.transcriptInr), momInr: round2(t.momInr), calls: t.calls });

const getAiCost = async (req, res) => {
  try {
    if (req.user?.role === "employee") {
      return res.status(403).json({ success: false, message: "Admin access required" });
    }
    const period = String(req.query.period || req.query.range || "month").toLowerCase();
    const startDate = isValidDateKey(req.query.startDate) ? req.query.startDate : null;
    const endDate = isValidDateKey(req.query.endDate) ? req.query.endDate : null;
    const mk = (opts) => buildPeriodOrCustomDateFilter({ ...opts, column: "COALESCE(started_at, created_at)", paramOffset: 1 });

    const [selected, today, week, month] = await Promise.all([
      aiCostForFilter(mk({ period, startDate, endDate })),
      aiCostForFilter(mk({ period: "today" })),
      aiCostForFilter(mk({ period: "week" })),
      aiCostForFilter(mk({ period: "month" })),
    ]);

    // Daily series: custom → From–To (max 92 days); week → Mon..today; month → 1st..today; today → last 7 days.
    const t = istToday();
    let from; let to = t;
    if (period === "custom" && startDate && endDate) { from = startDate; to = endDate; if (new Date(to) - new Date(from) > 92 * 86400000) from = addDays(to, -92); }
    else if (period === "week" || period === "this_week") { const dow = (new Date(`${t}T00:00:00Z`).getUTCDay() + 6) % 7; from = addDays(t, -dow); }
    else if (period === "today" || period === "day") from = addDays(t, -6);
    else from = `${t.slice(0, 7)}-01`;
    const daily = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const v = selected.byDay[d] || { inr: 0, usd: 0, calls: 0 };
      daily.push({ date: d, inr: round2(v.inr), usd: Math.round(v.usd * 10000) / 10000, calls: v.calls });
    }

    res.json({
      success: true,
      period,
      selected: shape(selected),
      today: shape(today),
      week: shape(week),
      month: shape(month),
      daily,
      note: "Estimated from Gemini token usage stored with each call's AI summary.",
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

module.exports = {
  getDashboardInsights,
  getAiCost,
  getDashboard,
  getRevenue,
  getPipeline,
  getPipelineStatus,
  getFilterRange,
  getLeadSummary,
  getPipelineLeads,
  patchPipelineLead,
  getLeadTasks,
  createLeadTask,
  patchLeadTask,
  getRecentLeads,
  getLeadById,
};
