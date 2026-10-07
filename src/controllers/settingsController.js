const dataService = require("../services/dataService");
const pool = require("../../config/db");

const num = (v) => {
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
};

/** Server-side mirror of the Settings page rules: baseline <= Bronze, min <= max, no overlap, non-decreasing rates. */
function validateIncentiveConfig(body = {}) {
  const errors = [];
  const slabs = Array.isArray(body.incentiveSlabs) ? body.incentiveSlabs : null;
  const hasBase = body.baseIncentiveRate !== undefined && body.baseIncentiveRate !== null;

  if (hasBase && (Number.isNaN(Number(body.baseIncentiveRate)) || Number(body.baseIncentiveRate) < 0)) {
    errors.push("Baseline incentive rate must be 0% or more");
  }

  if (slabs) {
    slabs.forEach((slab, i) => {
      const label = slab.tier || `Slab ${i + 1}`;
      if (num(slab.min) < 0) errors.push(`${label}: min collection must be 0 or more`);
      if (num(slab.min) > num(slab.max)) errors.push(`${label}: min cannot be greater than max`);
      if (num(slab.rate) < 0 || num(slab.rate) > 100) errors.push(`${label}: commission rate must be between 0% and 100%`);
      const prev = slabs[i - 1];
      if (prev) {
        if (num(slab.min) < num(prev.max)) errors.push(`${label}: slab overlaps ${prev.tier || "the previous slab"}`);
        if (num(slab.rate) < num(prev.rate)) errors.push(`${label}: rate cannot be lower than ${prev.tier || "the previous slab"}`);
      }
    });
  }

  const base = hasBase ? Number(body.baseIncentiveRate) : null;
  if (slabs && slabs.length && base !== null && !Number.isNaN(base)) {
    const bronze = slabs.find((s) => /bronze/i.test(String(s.tier || "")))
      || [...slabs].sort((a, b) => num(a.min) - num(b.min))[0];
    if (base > num(bronze.rate)) {
      errors.push(`Baseline incentive rate (${base}%) cannot be higher than the ${bronze.tier || "Bronze"} rate (${num(bronze.rate)}%)`);
    }
  }
  return errors;
}

/** Keep the employee records (used by Team page + Incentives) in step with published Settings targets. */
async function syncEmployeeTargets(tenantId, employeeTargets) {
  if (!Array.isArray(employeeTargets)) return;
  for (const row of employeeTargets) {
    const id = Number(row?.id);
    if (!id) continue;
    await pool.query(
      `UPDATE employees
       SET call_target = $1, qualified_lead_target = $2, meeting_target = $3, cash_target = $4
       WHERE id = $5 AND tenant_id = $6`,
      [
        Math.max(0, num(row.calls)),
        Math.max(0, num(row.leads)),
        Math.max(0, num(row.meetings)),
        Math.max(0, num(row.revenue)),
        id,
        tenantId,
      ],
    );
  }
}

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
    const touchesIncentives = req.body && (req.body.incentiveSlabs !== undefined || req.body.baseIncentiveRate !== undefined);
    const configErrors = touchesIncentives ? validateIncentiveConfig(merged) : [];
    if (configErrors.length) {
      return res.status(400).json({
        success: false,
        message: `Invalid incentive configuration: ${configErrors[0]}`,
        errors: configErrors,
      });
    }
    await dataService.saveSettings(dataService.TENANT, merged);
    try {
      await syncEmployeeTargets(dataService.TENANT, req.body?.employeeTargets);
    } catch (syncErr) {
      console.error("Settings: employee target sync failed:", syncErr.message);
    }
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
