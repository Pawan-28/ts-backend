const dotenv = require("dotenv");
dotenv.config();

const pool = require("./config/db");
const callyzer = require("./src/services/callyzerService");
const repo = require("./src/repositories/operationalRepo");

async function run() {
  console.log("Syncing all active employees Callyzer calls...");
  const employeesRes = await pool.query("SELECT * FROM employees WHERE status = 'active'");
  const employees = employeesRes.rows;
  console.log(`Found ${employees.length} active employees.`);

  for (const employee of employees) {
    const empNumbers = callyzer.employeeEmpNumbers(employee);
    if (!empNumbers.length) {
      console.log(`Skipping employee ${employee.name} (no Callyzer ID/phone).`);
      continue;
    }

    console.log(`Syncing call history from Callyzer for ${employee.name}...`);
    try {
      const dbCalls = await repo.listCalls("default", employee.id);
      const leadsResult = await repo.listAllLeads("default", { assignedTo: employee.id });
      
      const calls = await callyzer.getCallsForEmployee("default", employee, {
        dbCalls,
        leads: leadsResult.items,
        days: 30,
        maxPages: 30
      });
      
      console.log(`Successfully synced for ${employee.name}: retrieved ${calls.length} calls.`);
    } catch (err) {
      console.error(`Sync failed for ${employee.name}:`, err);
    }
  }

  console.log("Sync complete!");
  process.exit(0);
}

run();
