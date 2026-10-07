/**
 * READ-ONLY. Run: node scripts/verify-lead-sources.js
 * Compares the backend source list (what every dropdown will offer) with the frontend grouping the admin Sources page uses, over
 * EVERY lead in the database. Writes nothing (SELECT only).
 */
require("dotenv").config({ path: require("path").resolve(__dirname, "../.env") });
const path = require("path");
const { pathToFileURL } = require("url");
const pool = require("../config/db");
const { listLeadSources } = require("../src/utils/leadSources");

(async () => {
  const FE = await import(pathToFileURL(path.resolve(__dirname, "../../frontend/src/lib/leadSource.js")).href);
  const rows = (await pool.query(
    "SELECT id, source, form_name, keyword, source_meta, lead_name, email, phone, assigned_by, created_at FROM leads WHERE tenant_id = 'default' AND is_deleted = 0",
  )).rows;
  const settingsRow = (await pool.query("SELECT settings_json FROM tenant_settings WHERE tenant_id = 'default' LIMIT 1")).rows[0];
  let settings = settingsRow && settingsRow.settings_json ? settingsRow.settings_json : {};
  if (typeof settings === "string") settings = JSON.parse(settings);
  const custom = Array.isArray(settings.customSources) ? settings.customSources : [];
  const dismissed = settings.dismissedSources || {};

  const be = listLeadSources(rows, { dismissed, customSources: custom });
  const feLeads = rows.map((r) => ({ ...r, createdAt: r.created_at, sourceMeta: typeof r.source_meta === "string" ? JSON.parse(r.source_meta || "{}") : (r.source_meta || {}), formName: r.form_name }));
  const feGroups = FE.aggregateLeadsBySource(FE.filterLeadsForSourceDashboard(feLeads, custom), custom).filter((g) => !FE.isSourceDismissed(g, dismissed[g.key]));
  console.log(`leads: ${rows.length} | custom sources saved: ${custom.length} | dismissed: ${Object.keys(dismissed).length}`);
  console.log("BACKEND list  :", be.map((s) => `${s.label}(${s.leadCount})`).join(", "));
  console.log("ADMIN PAGE    :", feGroups.map((g) => `${g.label}(${g.leadCount})`).join(", "));
  const a = JSON.stringify([...be].map((s) => [s.key, s.leadCount]).sort());
  const b = JSON.stringify([...feGroups].map((g) => [g.key, g.leadCount]).sort());
  console.log(a === b ? "ALL OK - dropdown list == admin Sources page" : "MISMATCH");
  process.exit(a === b ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
