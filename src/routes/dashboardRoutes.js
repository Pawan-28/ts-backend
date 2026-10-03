const express = require("express");

const router = express.Router();

const {
  getAiCost,
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
  getLeadById
} = require("../controllers/dashboardController");


// MAIN DASHBOARD
router.get("/", getDashboard);


// AI (Gemini) transcript + MoM cost
router.get("/ai-cost", getAiCost);

// REVENUE CHART
router.get("/revenue", getRevenue);


// PIPELINE + SERVICE BREAKDOWN
router.get("/pipeline", getPipeline);
router.get("/pipeline-status", getPipelineStatus);
router.get("/filter-range", getFilterRange);

// KANBAN LEADS
router.get("/pipeline/leads", getPipelineLeads);
router.get("/pipeline/leads/:id/tasks", getLeadTasks);
router.post("/pipeline/leads/:id/tasks", createLeadTask);
router.patch("/pipeline/leads/:id/tasks/:taskId", patchLeadTask);
router.patch("/pipeline/leads/:id", patchPipelineLead);

// RECENT LEADS
router.get("/leads/recent", getRecentLeads);


// SINGLE LEAD DETAILS
router.get("/leads/:id", getLeadById);


module.exports = router;