const dataService = require("../services/dataService");

const getIncentiveDashboard = async (req, res) => {
  const data = await dataService.getIncentivesData(dataService.TENANT, req.query.month);
  res.json({
    success: true,
    source: data.source,
    kpis: {
      totalPayouts: { value: "$62,220", growth: "+14.2%" },
      avgPerRep: { value: "$15,555", growth: "+8.1%" },
      topEarner: { name: data.teammates[0]?.name || "Alex", payout: "$22,740" },
      projectedQ3: { value: "$96k", growth: "+22%" },
    },
    trendData: [
      { month: "Jan", payout: 12000 },
      { month: "Feb", payout: 18000 },
      { month: "Mar", payout: 22000 },
      { month: "Apr", payout: 28000 },
      { month: "May", payout: 35000 },
      { month: "Jun", payout: 45000 },
    ],
    slabs: (data.incentiveSlabs || []).map((s) => ({
      level: s.tier,
      target: `₹${s.min}+`,
      incentive: `${s.rate}%`,
    })),
    teammates: data.teammates,
    incentiveSlabs: data.incentiveSlabs,
    kpiWeights: data.kpiWeights,
    baseIncentiveRate: data.baseIncentiveRate,
    targetBonusAmount: data.targetBonusAmount,
  });
};

const getLeaderboard = async (req, res) => {
  const data = await dataService.getIncentivesData(dataService.TENANT, req.query.month);
  const leaderboard = (data.teammates || []).slice(0, 5).map((t, i) => ({
    rank: i + 1,
    name: t.name,
    payout: `$${((i + 1) * 4200).toLocaleString()}`,
  }));
  res.json({ success: true, leaderboard, payouts: leaderboard.map((l) => ({ id: l.rank, employee: l.name, incentive: l.payout })) });
};

const getCalculatorData = async (req, res) => {
  const data = await dataService.getIncentivesData(dataService.TENANT, req.query.month);
  res.json({
    success: true,
    slabs: (data.incentiveSlabs || []).map((s) => ({ level: s.tier, incentive: `${s.rate}%` })),
    exampleCalculation: { salesAmount: 100000, slab: "Silver", incentive: 8000 },
    incentiveSlabs: data.incentiveSlabs,
    kpiWeights: data.kpiWeights,
    baseIncentiveRate: data.baseIncentiveRate,
    targetBonusAmount: data.targetBonusAmount,
    teammates: data.teammates,
  });
};

module.exports = {
  getIncentiveDashboard,
  getLeaderboard,
  getCalculatorData,
};
