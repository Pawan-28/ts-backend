// Usage: node backfill_pipeline_stages.js [tenantId]
require("dotenv").config();
const { backfillFromStoredCalls } = require("./src/services/autoPipelineStageService");
backfillFromStoredCalls(process.argv[2] || process.env.CALLYZER_TENANT_ID || "default")
  .then((r) => { console.log("Backfill done:", r); process.exit(0); })
  .catch((e) => { console.error(e); process.exit(1); });
