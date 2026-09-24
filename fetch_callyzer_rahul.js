require("dotenv").config();
const { callyzerPost } = require("./src/services/callyzerService");

async function fetchCallyzerRahul() {
  try {
    const callTo = Math.floor(Date.now() / 1000);
    const callFrom = callTo - 7 * 86400; // last 7 days

    const result = await callyzerPost("/call-log/history", {
      call_from: callFrom,
      call_to: callTo,
      page_no: 1,
      page_size: 100,
    });

    console.log("TOTAL RECORDS IN CALLYZER:", result.total_records);
    const logs = result.result || [];
    const rahulLogs = logs.filter(l => String(l.client_number).includes("7208577151") || String(l.client_name).toLowerCase().includes("rahul"));
    
    console.log("\n=== RAHUL CALL LOGS FROM CALLYZER ===");
    console.log(JSON.stringify(rahulLogs, null, 2));
  } catch (err) {
    console.error("Callyzer Error:", err.message, err.payload || "");
  }
  process.exit(0);
}

fetchCallyzerRahul();
