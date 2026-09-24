const dotenv = require("dotenv");
dotenv.config();

const pool = require("../../config/db");
const callyzer = require("../services/callyzerService");
const { logger } = require("../config/logger");

async function migrate() {
  console.log("Starting Callyzer call log to Lead migration...");
  
  // 1. Fetch all employees
  const employeesRes = await pool.query("SELECT * FROM employees WHERE status = 'active'");
  const employees = employeesRes.rows;
  console.log(`Found ${employees.length} active employees.`);

  for (const employee of employees) {
    const empNumbers = callyzer.employeeEmpNumbers(employee);
    if (!empNumbers.length) {
      console.log(`Skipping employee ${employee.name} (no Callyzer ID/phone).`);
      continue;
    }

    console.log(`Fetching last 30 days call history from Callyzer for ${employee.name}...`);
    try {
      const logs = await callyzer.fetchCallHistory({ empNumbers, days: 30 });
      console.log(`Retrieved ${logs.length} calls from Callyzer API for ${employee.name}.`);

      // Build map of call_id -> client details
      const logMap = new Map();
      for (const log of logs) {
        if (log?.id) {
          const clientPhone = callyzer.normalizePhone(log.client_country_code, log.client_number).full || log.client_number;
          logMap.set(log.id, {
            phone: clientPhone,
            name: log.client_name || "Unknown Lead"
          });
        }
      }

      // Fetch calls in DB with NULL lead_id for this employee
      const dbCallsRes = await pool.query(
        "SELECT id, callyzer_call_id FROM employee_calls WHERE employee_id = $1 AND lead_id IS NULL AND callyzer_call_id IS NOT NULL",
        [employee.id]
      );
      const dbCalls = dbCallsRes.rows;
      console.log(`Found ${dbCalls.length} calls in database with NULL lead_id for ${employee.name}.`);

      let createdLeadsCount = 0;
      let linkedCallsCount = 0;

      for (const dbCall of dbCalls) {
        const callyzerInfo = logMap.get(dbCall.callyzer_call_id);
        if (!callyzerInfo) continue;

        const { phone, name } = callyzerInfo;
        const last10 = phone.replace(/\D/g, "").slice(-10);

        // Check if lead already exists in DB
        const existingLeadRes = await pool.query(
          "SELECT id FROM leads WHERE tenant_id = 'default' AND (phone = $1 OR (phone IS NOT NULL AND RIGHT(REPLACE(phone, '-', ''), 10) = $2)) AND is_deleted = 0 LIMIT 1",
          [phone, last10]
        );

        let leadId;
        if (existingLeadRes.rows.length > 0) {
          leadId = existingLeadRes.rows[0].id;
        } else {
          // Insert new lead under 'Contacted' stage
          const insertRes = await pool.query(
            `INSERT INTO leads (tenant_id, lead_name, phone, pipeline_stage, status, temperature, assigned_to, source, company_name)
             VALUES ('default', $1, $2, 'Contacted', 'Contacted', 'warm', $3, 'Callyzer', 'Callyzer Call')
             RETURNING id`,
            [name, phone, employee.id]
          );
          leadId = insertRes.rows[0].id;
          createdLeadsCount++;

          // Write timeline
          await pool.query(
            `INSERT INTO lead_timeline_events (tenant_id, lead_id, type, actor_id, actor_name, actor_role, summary, payload)
             VALUES ('default', $1, 'lead_created', 'system', 'System', 'system', $2, $3)`,
            [leadId, `Lead created from Callyzer call with ${name}`, JSON.stringify({ source: "Callyzer" })]
          );
        }

        // Link the call log to the lead
        await pool.query(
          "UPDATE employee_calls SET lead_id = $1 WHERE id = $2",
          [leadId, dbCall.id]
        );
        linkedCallsCount++;
      }

      console.log(`Successfully migrated for ${employee.name}: Created ${createdLeadsCount} new leads, linked ${linkedCallsCount} calls.`);
    } catch (err) {
      console.error(`Migration failed for ${employee.name}:`, err);
    }
  }

  console.log("Migration complete!");
  process.exit(0);
}

migrate();
