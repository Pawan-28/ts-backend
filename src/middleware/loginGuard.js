/** Per-account failed login tracking (not IP-based — safe for concurrent employees). */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 20;

const failures = new Map();

function normalizeKey(loginId) {
  return String(loginId || "").trim().toLowerCase();
}

function getEntry(loginId) {
  const key = normalizeKey(loginId);
  if (!key) return null;
  const entry = failures.get(key);
  if (!entry || Date.now() > entry.resetAt) {
    failures.delete(key);
    return null;
  }
  return entry;
}

function isLoginAllowed(loginId) {
  const entry = getEntry(loginId);
  if (!entry) return true;
  return entry.count < MAX_FAILURES;
}

function recordLoginFailure(loginId) {
  const key = normalizeKey(loginId);
  if (!key) return;
  const now = Date.now();
  const entry = failures.get(key);
  if (!entry || now > entry.resetAt) {
    failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

function clearLoginFailures(loginId) {
  failures.delete(normalizeKey(loginId));
}

module.exports = {
  isLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
};
