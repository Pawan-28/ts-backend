/** Optional shared secret for the inbound n8n webhook (same idea as CALLYZER_WEBHOOK_SECRET). Unset = no check. */
const crypto = require("crypto");

function verifyN8nSecret(req) {
  const expected = String(process.env.N8N_INBOUND_SECRET || "").trim();
  if (!expected) return true;
  const provided = String(
    req.headers["x-n8n-secret"] || req.headers["x-webhook-secret"] || req.headers.secret || req.query?.secret || "",
  ).trim();
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { verifyN8nSecret };
