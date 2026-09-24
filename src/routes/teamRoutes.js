const express = require("express");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

const {
  getTeamDashboard,
  getTeamPerformance,
  getEmployees,
  getEmployeeDetails,
  getEmployeeLeads,
  getEmployeeCallyzerStats,
  getEmployeeCompetencyScores,
  getTeamCallyzerStatsByEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  resetEmployeeCredentials,
  getTeamKPIs,
  getChartData,
} = require("../controllers/teamController");

router.get("/dashboard", getTeamDashboard);
router.get("/performance", getTeamPerformance);
router.get("/employees", getEmployees);
router.get("/employees/details/:id", getEmployeeDetails);
router.get("/employees/leads", getEmployeeLeads);
router.get("/callyzer-stats", getTeamCallyzerStatsByEmployee);
router.get("/employees/:id/callyzer-stats", getEmployeeCallyzerStats);
router.get("/employees/:id/competency-scores", getEmployeeCompetencyScores);
router.post("/employees/create", requireAdmin, createEmployee);
router.post("/employees/update", updateEmployee);
router.delete("/employees/:id", requireAdmin, deleteEmployee);
router.post("/employees/:id/reset-password", requireAdmin, resetEmployeeCredentials);
router.get("/kpis", getTeamKPIs);
router.get("/chart-data", getChartData);

module.exports = router;
