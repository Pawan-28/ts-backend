const dataService = require("../services/dataService");

const getInsights = async (req, res) => {
  const context = req.query.context || "dashboard";
  // Period-aware path: same period object (preset or custom From/To) as the Dashboard KPI tiles.
  if (req.query.period || req.query.range) {
    const data = await dataService.getDashboardInsightsForPeriod(undefined, {
      period: req.query.period || req.query.range,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      employee: req.query.employee,
      service: req.query.service,
    });
    return res.json(data);
  }
  const dbInsights = await dataService.getAiInsightsFromDb(dataService.TENANT, context);
  if (dbInsights.length) {
    res.json({ success: true, source: "database", insights: dbInsights });
    return;
  }
  const generated = await dataService.generateAiInsights(dataService.TENANT, context);
  res.json(generated);
};

const generateInsights = async (req, res) => {
  const context = req.body?.context || "dashboard";
  const result = await dataService.generateAiInsights(dataService.TENANT, context);
  res.json(result);
};

const createInsight = async (req, res) => {
  try {
    await dataService.saveAiInsight(dataService.TENANT, req.body);
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
};

const { processCallWithAi } = require("../services/aiService");
const { createJobRunner } = require("../utils/aiJobs");
const { logger } = require("../config/logger");

// A long recording (47 min) takes minutes - longer than a browser request or a proxy will wait. The page asks for a background job
// ({ async: true }) and polls /process-call/:callId/status; callers that do not ask still get the old one-request answer.
const aiJobs = createJobRunner();
const jobKey = (tenantId, callId) => `${tenantId}:${callId}`;
const tenantOf = (req) => req.user?.tenant_id || dataService.TENANT || "default";

const SKIPPED_MESSAGE = "No AI summary is generated for calls that did not connect.";

const processCallAi = async (req, res) => {
  try {
    const tenantId = tenantOf(req);
    const callId = req.params.callId || req.body.callId;
    if (!callId) {
      return res.status(400).json({ success: false, message: "callId is required" });
    }
    if (req.body?.async === true || req.query?.async === "1") {
      const { job } = aiJobs.start(jobKey(tenantId, callId), async () => {
        try {
          return await processCallWithAi(tenantId, callId);
        } catch (err) {
          logger.warn("Background AI MoM failed", { callId, error: err.message });
          throw err;
        }
      });
      return res.status(202).json({ success: true, status: "processing", startedAt: job.startedAt });
    }
    const updatedCall = await processCallWithAi(tenantId, callId);
    if (updatedCall?.skipped) {
      // Calls that never connected (or have nothing to summarize) get no AI MoM — refuse politely.
      return res.status(422).json({
        success: false,
        skipped: true,
        message: updatedCall.skipReason || SKIPPED_MESSAGE,
      });
    }
    res.json({ success: true, call: updatedCall });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
};

/** Where the background MoM job of a call stands: idle | processing | done | skipped | failed (always HTTP 200). */
const processCallStatus = (req, res) => {
  const callId = req.params.callId;
  const job = aiJobs.get(jobKey(tenantOf(req), callId));
  if (!job) return res.json({ success: true, status: "idle" });
  if (job.state === "running") {
    return res.json({ success: true, status: "processing", startedAt: job.startedAt, elapsedSec: Math.round((Date.now() - job.startedAt) / 1000) });
  }
  if (job.state === "failed") {
    return res.json({ success: false, status: "failed", message: job.error?.message || "AI processing failed", code: job.error?.status || 500 });
  }
  if (job.result?.skipped) {
    return res.json({ success: false, status: "skipped", skipped: true, message: job.result.skipReason || SKIPPED_MESSAGE });
  }
  return res.json({ success: true, status: "done", call: job.result });
};

module.exports = { getInsights, generateInsights, createInsight, processCallAi, processCallStatus };

