const mysql = require("mysql2/promise");
const { promisify } = require("util");

function resolveDbHost(host) {
  const value = (host || "127.0.0.1").trim();
  // Hostinger MySQL grants are often for 127.0.0.1, not IPv6 ::1.
  return value === "localhost" ? "127.0.0.1" : value;
}

function env(name) {
  const value = process.env[name];
  return typeof value === "string" ? value.trim() : value;
}

function logDbEnv(label = "mysql env") {
  const host = resolveDbHost(env("DB_HOST"));

  console.error(`[startup] ${label}`, JSON.stringify({
    DB_HOST_raw: env("DB_HOST") || "(unset)",
    DB_HOST_resolved: host,
    DB_PORT: Number(env("DB_PORT") || 3306),
    DB_USER: env("DB_USER") || "(unset)",
    DB_NAME: env("DB_NAME") || "(unset)",
    DB_SSL: env("DB_SSL") || "(unset)",
    DB_PASSWORD: env("DB_PASSWORD") ? "(set)" : "(unset)",
  }));
}

const pool = mysql.createPool({
  host: resolveDbHost(env("DB_HOST")),
  port: Number(env("DB_PORT") || 3306),
  user: env("DB_USER"),
  password: env("DB_PASSWORD"),
  database: env("DB_NAME"),
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_MAX || 10),
  queueLimit: 0,
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 8000),
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : undefined,
  dateStrings: false,
  timezone: process.env.APP_TZ_OFFSET || "+05:30",
});

// Ensure each connection uses IST for CURRENT_DATE / NOW (Hostinger defaults to UTC).
const tzOffset = process.env.APP_TZ_OFFSET || "+05:30";
if (pool.pool && typeof pool.pool.on === "function") {
  pool.pool.on("connection", (conn) => {
    conn.query(`SET time_zone = '${tzOffset}'`, (err) => {
      if (err) console.warn("[db] SET time_zone failed:", err.message);
    });
  });
}

logDbEnv("mysql env used by pool");

// Pre-warm DB connection pool on boot to eliminate initial cold connection latency
(async () => {
  try {
    await pool.query("SELECT 1");
    console.error("[db] Connection pool pre-warmed successfully");
  } catch (err) {
    console.warn("[db] Connection pool pre-warming ping failed:", err.message);
  }
})();

const coreQuery = promisify(pool.pool.query.bind(pool.pool));

function transformSql(sql) {
  let s = sql;

  s = s.replace(/\bILIKE\b/gi, "LIKE");
  s = s.replace(/::\w+\[\]/gi, "");
  s = s.replace(/::int\b/gi, "");
  s = s.replace(/::float\b/gi, "");
  s = s.replace(/(\w+\.\w+|\w+)::date/gi, "DATE($1)");

  s = s.replace(
    /COUNT\(\*\)\s*FILTER\s*\(\s*WHERE\s+([^)]+)\)/gi,
    "SUM(CASE WHEN $1 THEN 1 ELSE 0 END)",
  );

  s = s.replace(
    /COALESCE\s*\(\s*SUM\(([^)]+)\)\s*FILTER\s*\(\s*WHERE\s+([^)]+)\)\s*,\s*([^)]+)\)/gi,
    "COALESCE(SUM(CASE WHEN $2 THEN $1 ELSE 0 END), $3)",
  );

  // PostgreSQL REGEXP_REPLACE 4th 'g' flag
  s = s.replace(/REGEXP_REPLACE\(([^,]+),\s*([^,]+),\s*([^,]+),\s*'g'\)/gi, "REGEXP_REPLACE($1, $2, $3)");

  // PostgreSQL NULLS LAST / NULLS FIRST (MariaDB/MySQL)
  s = s.replace(
    /(\w+(?:\.\w+)?)\s+(ASC|DESC)\s+NULLS\s+LAST/gi,
    (_, col, dir) => `${col} IS NULL ASC, ${col} ${dir}`,
  );
  s = s.replace(
    /(\w+(?:\.\w+)?)\s+(ASC|DESC)\s+NULLS\s+FIRST/gi,
    (_, col, dir) => `${col} IS NULL DESC, ${col} ${dir}`,
  );

  return s;
}

function convertPlaceholders(sql, params = []) {
  let workingSql = sql;
  let workingParams = [...params];

  const anyRegex = /= ANY\(\$(\d+)(?:::\w+\[\])?\)/gi;
  let match;
  while ((match = anyRegex.exec(workingSql)) !== null) {
    const paramIndex = Number(match[1]) - 1;
    const arr = workingParams[paramIndex];
    if (Array.isArray(arr)) {
      if (!arr.length) {
        workingSql = workingSql.replace(match[0], "IN (NULL)");
        workingParams.splice(paramIndex, 1);
      } else {
        const inPlaceholders = arr.map((_, i) => `$${paramIndex + 1 + i}`).join(", ");
        workingSql = workingSql.replace(match[0], `IN (${inPlaceholders})`);
        workingParams.splice(paramIndex, 1, ...arr);
      }
      anyRegex.lastIndex = 0;
    }
  }

  const ordered = [];
  const mysqlSql = workingSql.replace(/\$(\d+)/g, (_, n) => {
    ordered.push(workingParams[Number(n) - 1]);
    return "?";
  });

  return [mysqlSql, ordered];
}

function serializeParams(params) {
  return params.map((p) => {
    if (p === null || p === undefined) return p;
    if (p instanceof Date || Buffer.isBuffer(p)) return p;
    if (typeof p === "object") return JSON.stringify(p);
    return p;
  });
}

function parseJsonFields(row) {
  if (!row || typeof row !== "object") return row;
  const out = { ...row };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
      try {
        out[key] = JSON.parse(value);
      } catch {
        // keep string
      }
    }
  }
  return out;
}

function mapRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(parseJsonFields);
}

async function queryReturningFallback(baseSql, mysqlParams, header) {
  if (/^INSERT/i.test(baseSql)) {
    const table = baseSql.match(/INTO\s+`?(\w+)`?/i)?.[1];
    const insertId = header?.insertId;
    if (table && insertId) {
      const rows = await coreQuery(`SELECT * FROM \`${table}\` WHERE id = ?`, [insertId]);
      return { rows: mapRows(rows), rowCount: rows.length };
    }
  }

  if (/^UPDATE/i.test(baseSql)) {
    const table = baseSql.match(/UPDATE\s+`?(\w+)`?/i)?.[1];
    const idMatch = baseSql.match(/\bid\s*=\s*\?/i);
    if (table && idMatch) {
      const idVal = mysqlParams[mysqlParams.length - 1];
      const rows = await coreQuery(`SELECT * FROM \`${table}\` WHERE id = ? LIMIT 1`, [idVal]);
      if (rows.length) return { rows: mapRows(rows), rowCount: header?.affectedRows ?? rows.length };
    }
  }

  if (/^DELETE/i.test(baseSql)) {
    return { rows: [], rowCount: header?.affectedRows ?? 0 };
  }

  return { rows: [], rowCount: header?.affectedRows ?? 0 };
}

async function query(text, params = []) {
  const hasReturning = /\sRETURNING\s+/i.test(text);
  let sql = transformSql(text);
  let [mysqlSql, mysqlParams] = convertPlaceholders(sql, params);
  mysqlParams = serializeParams(mysqlParams);

  if (hasReturning) {
    const baseSql = mysqlSql.replace(/\sRETURNING\s+.+$/i, "");
    try {
      const result = await coreQuery(mysqlSql, mysqlParams);
      if (Array.isArray(result) && result.length > 0) {
        return { rows: mapRows(result), rowCount: result.length };
      }
      if (result && result.insertId !== undefined) {
        return queryReturningFallback(baseSql, mysqlParams, result);
      }
      return { rows: mapRows(Array.isArray(result) ? result : []), rowCount: result?.affectedRows ?? 0 };
    } catch (err) {
      if (!/RETURNING/i.test(String(err.message))) throw err;
      const header = await coreQuery(baseSql, mysqlParams);
      return queryReturningFallback(baseSql, mysqlParams, header);
    }
  }

  const result = await coreQuery(mysqlSql, mysqlParams);

  if (Array.isArray(result)) {
    return { rows: mapRows(result), rowCount: result.length };
  }

  const insertId = result?.insertId;
  if (insertId && /^INSERT/i.test(mysqlSql)) {
    return {
      rows: [{ id: insertId }],
      rowCount: result?.affectedRows ?? 0,
      insertId,
    };
  }

  return { rows: [], rowCount: result?.affectedRows ?? 0, insertId };
}

pool.query = query;

module.exports = pool;
module.exports.query = query;
module.exports.pool = pool;
module.exports.logDbEnv = logDbEnv;
