const path = require("path");
const fs = require("fs");

// Load backend/.env
try {
  const envContent = fs.readFileSync(path.join(__dirname, "../../.env"), "utf8");
  envContent.split("\n").forEach((line) => {
    const parts = line.trim().split("=");
    if (parts.length >= 2 && !parts[0].startsWith("#")) {
      process.env[parts[0].trim()] = parts.slice(1).join("=").trim().replace(/^["']|["']$/g, "");
    }
  });
} catch (e) {}

const pool = require("../../config/db");

async function migrateUniqueIds() {
  console.log("=== STARTING UNIQUE IDS MIGRATION & BACKFILL ===");

  try {
    // 1. Add service_code column to services table if not exists
    console.log("Checking services table schema...");
    await pool.query(`
      ALTER TABLE services 
      ADD COLUMN IF NOT EXISTS service_code VARCHAR(50) NULL AFTER name
    `).catch(() => {
      // MySQL syntax fallback if ADD COLUMN IF NOT EXISTS fails in older versions
      return pool.query(`
        SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'services' AND COLUMN_NAME = 'service_code'
      `).then(async (res) => {
        if (res.rows?.[0]?.count == 0 || res.rows?.[0]?.['COUNT(*)'] == 0) {
          await pool.query(`ALTER TABLE services ADD COLUMN service_code VARCHAR(50) NULL AFTER name`);
        }
      });
    });

    // 2. Add sop_code column to sops table if not exists
    console.log("Checking sops table schema...");
    await pool.query(`
      ALTER TABLE sops 
      ADD COLUMN IF NOT EXISTS sop_code VARCHAR(50) NULL AFTER title
    `).catch(() => {
      return pool.query(`
        SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
        WHERE TABLE_NAME = 'sops' AND COLUMN_NAME = 'sop_code'
      `).then(async (res) => {
        if (res.rows?.[0]?.count == 0 || res.rows?.[0]?.['COUNT(*)'] == 0) {
          await pool.query(`ALTER TABLE sops ADD COLUMN sop_code VARCHAR(50) NULL AFTER title`);
        }
      });
    });

    // 3. Backfill services with SRV-001, SRV-002, etc.
    console.log("Backfilling Service IDs (SRV-XXX)...");
    const servicesRes = await pool.query(`SELECT id, service_code FROM services ORDER BY created_at ASC, id ASC`);
    const services = servicesRes.rows || [];
    let srvCounter = 1;

    for (const svc of services) {
      if (!svc.service_code || !svc.service_code.startsWith("SRV-")) {
        let code = `SRV-${String(srvCounter).padStart(3, "0")}`;
        // Ensure uniqueness
        while (services.some(s => s.service_code === code)) {
          srvCounter++;
          code = `SRV-${String(srvCounter).padStart(3, "0")}`;
        }
        await pool.query(`UPDATE services SET service_code = $1 WHERE id = $2`, [code, svc.id]);
        console.log(` -> Assigned ${code} to Service ID: ${svc.id}`);
        svc.service_code = code;
        srvCounter++;
      } else {
        const num = parseInt(svc.service_code.replace("SRV-", ""), 10);
        if (!isNaN(num) && num >= srvCounter) srvCounter = num + 1;
      }
    }

    // 4. Backfill SOPs with SOP-001, SOP-002, etc.
    console.log("Backfilling SOP IDs (SOP-XXX)...");
    const sopsRes = await pool.query(`SELECT id, sop_code FROM sops ORDER BY created_at ASC, id ASC`);
    const sops = sopsRes.rows || [];
    let sopCounter = 1;

    for (const sop of sops) {
      if (!sop.sop_code || !sop.sop_code.startsWith("SOP-")) {
        let code = `SOP-${String(sopCounter).padStart(3, "0")}`;
        while (sops.some(s => s.sop_code === code)) {
          sopCounter++;
          code = `SOP-${String(sopCounter).padStart(3, "0")}`;
        }
        await pool.query(`UPDATE sops SET sop_code = $1 WHERE id = $2`, [code, sop.id]);
        console.log(` -> Assigned ${code} to SOP ID: ${sop.id}`);
        sop.sop_code = code;
        sopCounter++;
      } else {
        const num = parseInt(sop.sop_code.replace("SOP-", ""), 10);
        if (!isNaN(num) && num >= sopCounter) sopCounter = num + 1;
      }
    }

    // 5. Normalize Employee Phone Numbers (Employee ID)
    console.log("Normalizing Employee Phone IDs...");
    const empRes = await pool.query(`SELECT id, name, phone FROM employees`);
    const employees = empRes.rows || [];

    for (const emp of employees) {
      if (emp.phone) {
        const cleaned = String(emp.phone).replace(/\D/g, "");
        const normPhone = cleaned.length >= 10 ? cleaned.slice(-10) : cleaned;
        if (normPhone && normPhone !== emp.phone) {
          await pool.query(`UPDATE employees SET phone = $1 WHERE id = $2`, [normPhone, emp.id]);
          console.log(` -> Normalized phone for Employee ${emp.name} (ID: ${emp.id}): ${normPhone}`);
        }
      }
    }

    console.log("=== MIGRATION & BACKFILL COMPLETED SUCCESSFULLY ===");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

migrateUniqueIds();
