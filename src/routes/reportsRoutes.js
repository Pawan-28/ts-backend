const express = require("express");

const router = express.Router();

const {
  getReportsDashboard,
  getReportsAnalytics,
  getTeamComparison
} = require("../controllers/reportsController");


// KPI + AI SUMMARY + GOALS
router.get("/dashboard", getReportsDashboard);


// REVENUE + LEAD SOURCES + CONVERSION CHARTS
router.get("/analytics", getReportsAnalytics);


// TEAM COMPARISON
router.get("/team-comparison", getTeamComparison);

module.exports = router;