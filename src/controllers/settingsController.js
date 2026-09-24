const dataService = require("../services/dataService");

const getSettings = async (req, res) => {
  const result = await dataService.getSettings();
  const s = result.settings;
  res.json({
    success: true,
    source: result.source,
    profile: s.profile,
    auth: s.auth,
    notifications: s.notifications,
    appearance: s.appearance,
    employeeTargets: s.employeeTargets,
    kpiWeights: s.kpiWeights,
    incentiveSlabs: s.incentiveSlabs,
    baseIncentiveRate: s.baseIncentiveRate,
    targetBonusAmount: s.targetBonusAmount,
    formulaType: s.formulaType,
    ratingThresholds: s.ratingThresholds,
    currentVersion: s.currentVersion,
    dismissedSources: s.dismissedSources || {},
    integrations: [
      { id: 1, name: "Google Sign-In", connected: false, type: "auth" },
      { id: 2, name: "Google Calendar", connected: true, type: "calendar" },
    ],
    billing: { plan: "Enterprise", users: 48, renewalDate: "2026-01-01", monthlyCost: "₹41,500" },
  });
};

const updateSettings = async (req, res) => {
  try {
    const current = await dataService.getSettings();
    const merged = { ...current.settings, ...req.body };
    await dataService.saveSettings(dataService.TENANT, merged);
    res.json({ success: true, message: "Settings saved to database", settings: merged });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const connectGoogle = (req, res) => {
  res.json({
    success: true,
    message: "Google OAuth placeholder — wire /api/auth/google callback",
    auth: { provider: "google", googleConnected: true, googleEmail: req.body?.email || "" },
  });
};

const disconnectGoogle = (req, res) => {
  res.json({
    success: true,
    message: "Google account disconnected",
    auth: { provider: "google", googleConnected: false, googleEmail: "" },
  });
};

module.exports = {
  getSettings,
  updateSettings,
  connectGoogle,
  disconnectGoogle,
};
