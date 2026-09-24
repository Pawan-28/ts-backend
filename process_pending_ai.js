require("dotenv").config();
const pool = require("./config/db");
const { processCallWithAi } = require("./src/services/aiService");

const TENANT_ID = process.env.DEFAULT_TENANT_ID || "default";

async function processAllPending() {
  console.log("Finding calls with recordings but no real AI summary...");

  const pending = await pool.query(`
    SELECT id, outcome, duration_sec, recording_url, ai_summary
    FROM employee_calls
    WHERE recording_url IS NOT NULL AND recording_url <> ''
      AND (
        ai_summary IS NULL OR ai_summary = ''
        OR ai_summary LIKE '%No call recording%'
        OR ai_summary LIKE '%no_summary%'
        OR notes IS NULL OR notes = ''
        OR notes LIKE '%No call recording%'
      )
    ORDER BY id DESC
    LIMIT 100
  `);

  console.log(`Found ${pending.rows.length} calls to process with AI...\n`);

  let processed = 0;
  let failed = 0;

  for (const row of pending.rows) {
    try {
      console.log(`Processing call ID ${row.id} (${row.outcome}, ${row.duration_sec}s, recording present)...`);
      await processCallWithAi(TENANT_ID, row.id);
      processed++;
      console.log(`  ✓ Done (${processed}/${pending.rows.length})`);
    } catch (e) {
      failed++;
      console.error(`  ✗ Failed: ${e.message}`);
    }
  }

  console.log(`\n=== COMPLETE ===`);
  console.log(`Processed: ${processed}, Failed: ${failed}`);
  process.exit(0);
}

processAllPending().catch(e => {
  console.error("Fatal:", e.message);
  process.exit(1);
});
