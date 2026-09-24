const pool = require("../../config/db");

let pgReady = false;

async function checkPgConnection() {
  try {
    await pool.query("SELECT 1");
    pgReady = true;
  } catch {
    pgReady = false;
  }
  return pgReady;
}

function isPgReady() {
  return pgReady;
}

function requirePg(req, res, next) {
  if (!pgReady) {
    return res.status(503).json({
      success: false,
      message: "MySQL is not connected. Set DB_* env vars in Hostinger and restart the backend.",
    });
  }
  return next();
}

module.exports = { checkPgConnection, isPgReady, requirePg };
