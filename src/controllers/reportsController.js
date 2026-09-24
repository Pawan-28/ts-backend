const dataService = require("../services/dataService");

function periodOptionsFromQuery(query = {}) {
  return {
    period: query.period || query.range || "month",
    rangeKey: query.range || query.period,
    startDate: query.startDate,
    endDate: query.endDate,
  };
}

const getReportsDashboard = async (req, res) => {
  const bundle = await dataService.getReportsBundle(undefined, periodOptionsFromQuery(req.query));
  res.json({
    success: true,
    source: bundle.source,
    kpis: bundle.kpis,
    aiSummary: bundle.aiSummary,
    goalCompletion: {
      revenueTarget: { achieved: "0", target: "0", percentage: 0 },
      closedDeals: { achieved: 0, target: 0, percentage: 0 },
      qualifiedLeads: { achieved: 0, target: 0, percentage: 0 },
      customerNps: { score: 0, target: 0, percentage: 0 },
    },
  });
};

const getReportsAnalytics = async (req, res) => {
  const bundle = await dataService.getReportsBundle(undefined, periodOptionsFromQuery(req.query));
  res.json({
    success: true,
    source: bundle.source,
    revenueAnalytics: bundle.revenueAnalytics,
    leadSources: bundle.leadSources,
    conversionByStage: bundle.conversionByStage,
  });
};

const getTeamComparison = async (req, res) => {
  const bundle = await dataService.getReportsBundle(undefined, periodOptionsFromQuery(req.query));
  res.json({ success: true, team: bundle.team || [] });
};

module.exports = {
  getReportsDashboard,
  getReportsAnalytics,
  getTeamComparison,
};
