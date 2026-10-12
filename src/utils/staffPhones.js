/**
 * Employees' own phone numbers. A call between two colleagues is not a lead call: it must not auto-create a "lead" for a staff member
 * (or count towards pickup / conversation numbers). Same idea as the private-contact exclusion, but for the whole team.
 */
const pool = require("../../config/db");

const TTL_MS = 60_000;
let cache = { at: 0, tenantId: null, set: new Set() };

const last10 = (value) => {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : "";
};

/** Set of last-10-digit phone numbers of every employee (active or not). */
async function loadStaffPhoneSet(tenantId = "default") {
  const now = Date.now();
  if (cache.tenantId === tenantId && now - cache.at < TTL_MS) return cache.set;
  try {
    const res = await pool.query(
      "SELECT phone FROM employees WHERE phone IS NOT NULL AND phone <> '' AND (tenant_id = $1 OR tenant_id IS NULL)",
      [tenantId],
    );
    const set = new Set(res.rows.map((r) => last10(r.phone)).filter(Boolean));
    cache = { at: now, tenantId, set };
    return set;
  } catch {
    return cache.tenantId === tenantId ? cache.set : new Set(); // never block call sync because of this lookup
  }
}

const isStaffPhone = (set, phone) => {
  const key = last10(phone);
  return Boolean(key) && set.has(key);
};

module.exports = { loadStaffPhoneSet, isStaffPhone, last10 };
