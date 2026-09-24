require("dotenv").config();
const { processCallWithAi } = require("./src/services/aiService");

async function runRahulAiProcessing() {
  const callIds = [6056, 6057, 6058, 6071];

  for (const id of callIds) {
    try {
      console.log(`Processing call ID ${id}...`);
      const updated = await processCallWithAi("default", id);
      console.log(`Call ID ${id} processed successfully:`);
      console.log("  Outcome:", updated.outcome);
      console.log("  AI Summary length:", updated.ai_summary?.length);
      console.log("  Transcript snippet:", updated.transcript?.slice(0, 100));
    } catch (err) {
      console.error(`Failed to process call ID ${id}:`, err.message);
    }
  }

  process.exit(0);
}

runRahulAiProcessing();
