const express = require("express");
const router = express.Router();
const { getInsights, generateInsights, createInsight, processCallAi } = require("../controllers/aiController");

router.get("/insights", getInsights);
router.post("/generate", generateInsights);
router.post("/insights", createInsight);
router.post("/process-call/:callId?", processCallAi);

module.exports = router;

