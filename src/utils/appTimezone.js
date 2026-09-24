/** App timezone — Callyzer + CRM users are in India (IST). Hostinger servers default to UTC. */

const APP_TZ_OFFSET = process.env.APP_TZ_OFFSET || "+05:30";
const APP_TZ = process.env.APP_TZ || "Asia/Kolkata";

function parseOffsetMinutes(offset = APP_TZ_OFFSET) {
  const m = String(offset).trim().match(/^([+-])(\d{1,2}):(\d{2})$/);
  if (!m) return 330;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Format a UTC instant as naive `YYYY-MM-DDTHH:mm:ss` in APP_TZ (for API + frontend). */
function formatUtcInstantAsAppSql(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const offMin = parseOffsetMinutes();
  const shifted = new Date(d.getTime() + offMin * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}T${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}:${pad2(shifted.getUTCSeconds())}`;
}

const NAIVE_SQL_DATETIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;

/** MySQL DATETIME on UTC hosts stores UTC wall clock with no tz marker. */
function parseNaiveDbDateTimeAsUtcInstant(value) {
  const iso = String(value || "").trim().replace(" ", "T");
  if (!NAIVE_SQL_DATETIME.test(iso)) return null;
  const d = new Date(`${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Legacy helper — only if mysql2 returns Dates without pool timezone config.
 * With db pool `timezone: +05:30`, Date values are already correct instants.
 */
function mysqlDatetimeToUtcInstant(val) {
  if (!(val instanceof Date) || Number.isNaN(val.getTime())) return null;
  return new Date(val.getTime() + parseOffsetMinutes() * 60 * 1000);
}

/** Normalize DB/API datetimes to IST wall-clock strings (no Z suffix). */
function toLocalSqlString(val) {
  if (val == null || val === "") return null;
  if (typeof val === "string") {
    const s = val.trim();
    if (!s) return null;
    if (s.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(s)) {
      return formatUtcInstantAsAppSql(new Date(s)) || s;
    }
    // Naive SQL datetimes are already IST wall clock (Callyzer sync + CRM inserts).
    if (NAIVE_SQL_DATETIME.test(s)) {
      return s.replace(" ", "T");
    }
    return s.replace(" ", "T");
  }
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    // mysql2 pool uses APP_TZ_OFFSET — do not add offset again.
    return formatUtcInstantAsAppSql(val);
  }
  return val;
}

/** Parse Callyzer call_date + call_time as IST → ISO UTC instant. */
function parseCallyzerCallInstant(callDate, callTime) {
  if (!callDate) return null;
  const time = callTime || "00:00:00";
  const iso = `${callDate}T${time}${APP_TZ_OFFSET}`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function applyProcessTimezone() {
  if (!process.env.TZ) {
    process.env.TZ = APP_TZ;
  }
}

module.exports = {
  APP_TZ,
  APP_TZ_OFFSET,
  parseOffsetMinutes,
  formatUtcInstantAsAppSql,
  toLocalSqlString,
  parseCallyzerCallInstant,
  applyProcessTimezone,
};
