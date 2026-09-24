const pool = require("./config/db");

async function run() {
  console.log("Cleaning up Callyzer duplicate calls and leads from database...");
  
  // 1. Delete timeline events for Callyzer-created leads
  const timelineDelete = await pool.query(`
    DELETE FROM lead_timeline_events 
    WHERE lead_id IN (SELECT id FROM leads WHERE source = 'Callyzer')
  `);
  console.log(`Deleted ${timelineDelete.affectedRows || timelineDelete.rowCount || 0} timeline events.`);

  // 2. Delete Callyzer call logs from employee_calls
  const callsDelete = await pool.query(`
    DELETE FROM employee_calls 
    WHERE callyzer_call_id IS NOT NULL
  `);
  console.log(`Deleted ${callsDelete.affectedRows || callsDelete.rowCount || 0} call logs.`);

  // 3. Delete leads created from Callyzer calls
  const leadsDelete = await pool.query(`
    DELETE FROM leads 
    WHERE source = 'Callyzer'
  `);
  console.log(`Deleted ${leadsDelete.affectedRows || leadsDelete.rowCount || 0} leads.`);

  console.log("Cleanup complete!");
  process.exit(0);
}

run().catch(err => {
  console.error("Cleanup failed:", err);
  process.exit(1);
});
