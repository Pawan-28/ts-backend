/**
 * One-time clean-up: Hot / Warm / Cold must be BLANK until Gemini (after a connected call) or a person sets it.
 * Until now every new lead was stored with temperature = "warm" automatically, so 4,000+ leads show "Warm" that nobody chose.
 *
 *   node scripts/blank-default-temperature.js            -> DRY RUN (default): prints what WOULD change, writes nothing
 *   node scripts/blank-default-temperature.js --apply    -> backs the rows up to backups/temperature-<time>.csv, then blanks them
 *   node scripts/blank-default-temperature.js --restore backups/temperature-<time>.csv   -> puts the old values back
 *
 * Only rows whose temperature is EXACTLY the bare lower-case "warm" are touched - that is the automatic default. Values written by
 * Gemini or by the Hot/Warm/Cold buttons in the "Hot Lead" / "Warm Lead" / "Cold Lead" form, and every bare "hot" / "cold", are left alone.
 * (A person who picked Warm by hand before this change is stored the same way as the default, so that choice cannot be told apart
 * and is blanked too - they can pick it again.)
 */
const fs = require("fs");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../.env") });
const pool = require("../config/db");

const TENANT = process.env.BLANK_TEMP_TENANT || "default";
const APPLY = process.argv.includes("--apply");
const restoreIdx = process.argv.indexOf("--restore");
const RESTORE = restoreIdx > -1 ? process.argv[restoreIdx + 1] : null;

(async () => {
  console.log(`DB ${process.env.DB_HOST}/${process.env.DB_NAME} - tenant ${TENANT} - ${RESTORE ? "RESTORE" : APPLY ? "APPLY" : "DRY RUN (nothing is written)"}`);

  if (RESTORE) {
    const lines = fs.readFileSync(RESTORE, "utf8").trim().split(/\r?\n/).slice(1);
    let n = 0;
    for (const line of lines) {
      const [id, value] = line.split(",");
      const r = await pool.query("UPDATE leads SET temperature = $1 WHERE id = $2 AND tenant_id = $3 AND temperature IS NULL", [value || null, Number(id), TENANT]);
      n += r.rowCount || 0;
    }
    console.log(`restored ${n} of ${lines.length} rows (rows that got a new temperature since are left as they are)`);
    process.exit(0);
  }

  const dist = (await pool.query(
    "SELECT COALESCE(temperature, '(blank)') AS t, COUNT(*) AS n FROM leads WHERE tenant_id = $1 AND is_deleted = 0 GROUP BY t ORDER BY n DESC", [TENANT],
  )).rows;
  console.log("\ntemperature now:");
  console.table(dist.map((r) => ({ temperature: r.t, leads: Number(r.n) })));

  const rows = (await pool.query("SELECT id, temperature FROM leads WHERE tenant_id = $1 AND temperature = BINARY 'warm'", [TENANT])).rows;
  const withCall = (await pool.query(
    `SELECT COUNT(DISTINCT l.id) AS n FROM leads l JOIN employee_calls ec ON ec.lead_id = l.id
     WHERE l.tenant_id = $1 AND l.temperature = BINARY 'warm' AND COALESCE(ec.duration_sec, 0) > 0`, [TENANT],
  )).rows[0];
  console.log(`\nWOULD BLANK: ${rows.length} leads with the bare default "warm"  (${Number(withCall.n)} of them have an answered call - Gemini will classify them when their next call is processed)`);
  console.log("NOT touched: 'Hot Lead' / 'Warm Lead' / 'Cold Lead' (Gemini or the buttons), bare 'hot' / 'cold', 'Not Pick', 'Converted'.");

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to blank them (a backup CSV is written first).");
    process.exit(0);
  }

  const dir = path.resolve(__dirname, "../backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `temperature-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`);
  fs.writeFileSync(file, `id,temperature\n${rows.map((r) => `${r.id},${r.temperature}`).join("\n")}\n`);
  console.log(`backup written: ${file}`);
  const res = await pool.query("UPDATE leads SET temperature = NULL WHERE tenant_id = $1 AND temperature = BINARY 'warm'", [TENANT]);
  console.log(`blanked ${res.rowCount} leads. Undo: node scripts/blank-default-temperature.js --restore "${file}"`);
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
