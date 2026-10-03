// Backfills UTM fields + canonical SOP code into leads.source_meta.
//   node backfill_lead_tracking.js          -> dry run (prints what would change)
//   node backfill_lead_tracking.js --apply  -> writes the changes
require("dotenv").config();
const pool = require("./config/db");
const { extractTracking } = require("./src/utils/leadMeta");

const APPLY = process.argv.includes("--apply");
const UTM = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];

const norm = (v) => String(v ?? "").trim().toLowerCase();
const parse = (v) => { if (!v) return {}; if (typeof v === "object") return v; try { return JSON.parse(v); } catch { return {}; } };

(async () => {
  const sopsRes = await pool.query("SELECT id, sop_code, title, service, services, status FROM sops");
  const sops = sopsRes.rows.filter((s) => norm(s.status) !== "archived").map((s) => {
    let services = parse(s.services);
    if (!Array.isArray(services) || !services.length) services = [s.service || "All Services"];
    return { ...s, services };
  });
  const sopFor = (meta, requirements) => {
    const idNeedle = norm(meta.sopId || meta.sop_id);
    const nameNeedle = norm(meta.sop || meta.sopName);
    const byId = idNeedle && sops.find((s) => norm(s.sop_code) === idNeedle || norm(s.id) === idNeedle || norm(s.title) === idNeedle);
    if (byId) return byId;
    const byName = nameNeedle && sops.find((s) => norm(s.title) === nameNeedle);
    if (byName) return byName;
    const svc = String(meta.service || meta.services || requirements || "").replace(/^\[?service:?\s*/i, "").split(/[|\]]/)[0].trim();
    return (svc && sops.find((s) => s.services.some((x) => norm(x) === norm(svc)))) || sops.find((s) => s.services.includes("All Services")) || null;
  };

  const { rows } = await pool.query("SELECT id, source_meta, requirements FROM leads WHERE is_deleted = 0");
  let changed = 0;
  for (const row of rows) {
    const meta = parse(row.source_meta);
    const t = extractTracking(meta);
    const next = { ...meta };
    let dirty = false;
    for (const k of UTM) if (t[k] && next[k] !== t[k]) { next[k] = t[k]; dirty = true; }
    const sop = sopFor(meta, row.requirements);
    if (sop) {
      const code = sop.sop_code || String(sop.id);
      if (next.sopId !== code) { next.sopId = code; dirty = true; }
      if (!next.sop && sop.title) { next.sop = sop.title; dirty = true; }
    }
    if (!dirty) continue;
    changed += 1;
    if (APPLY) await pool.query("UPDATE leads SET source_meta = $1 WHERE id = $2", [JSON.stringify(next), row.id]);
    else if (changed <= 10) console.log(`lead ${row.id}:`, JSON.stringify({ utm: UTM.map((k) => next[k] || ""), sopId: next.sopId }));
  }
  console.log(`${APPLY ? "Updated" : "Would update"} ${changed} of ${rows.length} leads.`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
