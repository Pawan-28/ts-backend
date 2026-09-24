const express = require("express");
const router = express.Router();

const {
  getSalesDashboard,
  getAllLeads,
  getLeadDetails,
  createLead,
  updateLead,
  deleteLead,
  createEmpLead,
  syncLeadStatus,
  getEmpLeads,
  getEmpLeadStatusHistory,
  getEmpLeadsPipelineStats,
  getSalesFunnelKPIs,
  getOppCategoryLeads,
  getSalesAiInsights,
} = require("../controllers/salesController");

/* ─────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────── */
router.get("/dashboard", getSalesDashboard);

/* ─────────────────────────────────────────
   LEADS  (old leads table)
───────────────────────────────────────── */
router.post("/leads/create",        createLead);
router.get("/leads",                getAllLeads);
router.get("/leads/details/:id",    getLeadDetails);
router.put("/leads/:id",            updateLead);
router.delete("/leads/:id",         deleteLead);

/* ─────────────────────────────────────────
   EMP LEADS  — static / collection routes FIRST,
               param routes LAST
───────────────────────────────────────── */
router.get("/emp-leads/pipeline-stats",        getEmpLeadsPipelineStats);
router.get("/emp-leads/sales-kpis",            getSalesFunnelKPIs);
router.get("/emp-leads/opp-leads",             getOppCategoryLeads);
router.get("/emp-leads/sales-ai-insights",     getSalesAiInsights);
router.get("/emp-leads",                        getEmpLeads);
router.post("/emp-leads/create",               createEmpLead);
router.get("/emp-leads/:id/status-history",    getEmpLeadStatusHistory);    // ← /:id route, but has extra segment so safe

/* ─────────────────────────────────────────
   SYNC
───────────────────────────────────────── */
router.post("/sync-lead-status", syncLeadStatus);

module.exports = router;