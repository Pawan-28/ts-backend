const jwt = require("jsonwebtoken");

const DEV_FALLBACK_SECRET = "ts-crm-dev-only-secret";

function isProduction() {
  return String(process.env.NODE_ENV || "").toLowerCase() === "production";
}

function resolveJwtSecret() {
  const secret = String(process.env.JWT_SECRET || "").trim();
  if (secret) {
    if (secret.length < 32) {
      console.warn("[auth] JWT_SECRET is shorter than 32 chars — use a longer random value.");
    }
    return secret;
  }
  if (isProduction()) {
    // Fail fast: without a real secret, anyone who reads the source can forge tokens.
    throw new Error(
      "JWT_SECRET environment variable is required in production. "
      + "Set it in the Hostinger environment variables panel and restart the app.",
    );
  }
  console.warn("[auth] JWT_SECRET not set — using an insecure dev-only fallback. Never use this in production.");
  return DEV_FALLBACK_SECRET;
}

const JWT_SECRET = resolveJwtSecret();
const JWT_EXPIRES = process.env.JWT_EXPIRES || "7d";

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { signToken, verifyToken, JWT_SECRET };
