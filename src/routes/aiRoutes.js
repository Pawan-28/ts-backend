const express = require("express");
const router = express.Router();
const { getInsights, generateInsights, createInsight, processCallAi, processCallStatus } = require("../controllers/aiController");

router.get("/insights", getInsights);
router.post("/generate", generateInsights);
router.post("/insights", createInsight);
router.post("/process-call/:callId?", processCallAi);
router.get("/process-call/:callId/status", processCallStatus);

module.exports = router;

