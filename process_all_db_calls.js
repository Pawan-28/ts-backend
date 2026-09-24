require("dotenv").config();
const pool = require("./config/db");
const { processCallWithAi } = require("./src/services/aiService");

async function processRecentCalls() {
  try {
    const res = await pool.query(
      "SELECT id, duration_sec, outcome, notes, callyzer_call_id FROM employee_calls ORDER BY id DESC LIMIT 20"
    );
    console.log(`Processing top ${res.rows.length} recent call logs...`);

    for (const call of res.rows) {
      try {
        console.log(`Processing call ID ${call.id} (callyzer_id: ${call.callyzer_call_id}, duration: ${call.duration_sec}s, outcome: ${call.outcome})...`);
        const updated = await processCallWithAi("default", call.id);
        console.log(`  -> SUCCESS: ID ${call.id} | Outcome: ${updated.outcome} | AI Summary length: ${updated.ai_summary?.length}`);
      } catch (err) {
        console.error(`  -> FAILED call ID ${call.id}:`, err.message);
      }
    }
    console.log("Recent calls successfully re-processed!");
    process.exit(0);
  } catch (err) {
    console.error("Batch processing failed:", err);
    process.exit(1);
  }
}

processRecentCalls();
