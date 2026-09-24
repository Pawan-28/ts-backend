const dataService = require("../services/dataService");
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
  const bundle = await dataService.getDashboardBundle();
  res.json({ revenue: bundle.revenueSeries, revenueSeries: bundle.revenueSeries });
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
    const rangeKey = req.query.range || req.query.period || "week";
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
    res.status(500).json({ success: false, message: err.message });
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

module.exports = {
  getDashboard,
  getRevenue,
  getPipeline,
  getPipelineStatus,
  getFilterRange,
  getPipelineLeads,
  patchPipelineLead,
  getLeadTasks,
  createLeadTask,
  patchLeadTask,
  getRecentLeads,
  getLeadById,
};
