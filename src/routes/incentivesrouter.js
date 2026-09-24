const express = require("express");

const router = express.Router();

const {
  getIncentiveDashboard,
  getLeaderboard,
  getCalculatorData
} = require("../controllers/incentivesController");

const pool = require("../../config/db");
const { tenant } = require("../services/operationalServices");
const { buildPeriodDateFilter } = require("../utils/periodFilter");

router.get("/dashboard", getIncentiveDashboard);

router.get("/leaderboard", getLeaderboard);

router.get("/calculator", getCalculatorData);

/**
 * GET /api/incentives/cash-total
 * Admin endpoint — total cash collected across ALL employees for a given month (YYYY-MM).
 * Defaults to current calendar month.
 * Uses COALESCE(payment_at, created_at) so rows with NULL payment_at still match.
 */
router.get("/cash-total", async (req, res) => {
  try {
    const tenantId = tenant(req);
    const month = req.query.month || new Date().toISOString().slice(0, 7);
    const result = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM cash_collections
       WHERE tenant_id = $1
         AND DATE_FORMAT(COALESCE(payment_at, created_at), '%Y-%m') = $2`,
      [tenantId, month],
    );
    const row = result.rows[0] || {};
    return res.json({
      success: true,
      month,
      cashCollected: Number(row.total) || 0,
      transactionCount: Number(row.count) || 0,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

/**
 * GET /api/incentives/employee/:id/cash-summary
 * Admin endpoint — returns cash collected for an employee,
 * optionally filtered by month (YYYY-MM).
 * Uses COALESCE(payment_at, created_at) so rows with NULL payment_at still match.
 */
router.get("/employee/:id/cash-summary", async (req, res) => {
  try {
    const tenantId = tenant(req);
    const employeeId = req.params.id;
    const month = req.query.month;
    const period = String(req.query.period || (month ? "month" : "month")).toLowerCase();

    const periodFilter = buildPeriodDateFilter({
      period: month ? "month" : period,
      month,
      column: "COALESCE(payment_at, created_at)",
      paramOffset: 3,
    });

    const params = [tenantId, employeeId, ...periodFilter.params];
    const query = `
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*) AS count
      FROM cash_collections
      WHERE tenant_id = $1
        AND employee_id = $2
        AND ${periodFilter.clause}
    `;

    const result = await pool.query(query, params);
    const row = result.rows[0] || {};

    return res.json({
      success: true,
      employeeId,
      month: month || null,
      period: periodFilter.period || period,
      label: periodFilter.label,
      cashCollected: Number(row.total) || 0,
      transactionCount: Number(row.count) || 0,
    });
  } catch (err) {
    console.error("Cash summary error:", err.message);
    return res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;