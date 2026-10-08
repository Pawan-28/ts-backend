/**
 * Settings of the 3-day auto-reassign feature, kept in tenant settings as `autoReassign`:
 *   { enabled: boolean, days: 1..30 (default 3), enabledAt: ISO string | null }
 *
 * OFF by default. `enabledAt` is set by the SERVER the moment an admin switches it on: every lead's window starts no earlier than that
 * moment, so switching it on never recycles the whole backlog at once - each lead first gets a full window.
 */
const DEFAULT_DAYS = 3;
const MIN_DAYS = 1;
const MAX_DAYS = 30;

function readAutoReassign(settings) {
  const raw = settings && typeof settings === "object" ? settings.autoReassign : null;
  const days = Math.round(Number(raw?.days));
  return {
    enabled: raw?.enabled === true,
    days: Number.isFinite(days) ? Math.min(MAX_DAYS, Math.max(MIN_DAYS, days)) : DEFAULT_DAYS,
    enabledAt: raw?.enabled === true && raw?.enabledAt ? new Date(raw.enabledAt).toISOString() : null,
  };
}

/** What to store after an admin change. `incoming` = req.body.autoReassign. enabledAt is never taken from the client. */
function nextAutoReassign(previousSettings, incoming, now = new Date()) {
  const prev = readAutoReassign(previousSettings);
  const wantEnabled = incoming && typeof incoming === "object" && "enabled" in incoming ? incoming.enabled === true : prev.enabled;
  const days = incoming && typeof incoming === "object" && "days" in incoming ? readAutoReassign({ autoReassign: { days: incoming.days } }).days : prev.days;
  if (!wantEnabled) return { enabled: false, days, enabledAt: null };
  return { enabled: true, days, enabledAt: prev.enabled && prev.enabledAt ? prev.enabledAt : new Date(now).toISOString() };
}

module.exports = { DEFAULT_DAYS, MIN_DAYS, MAX_DAYS, readAutoReassign, nextAutoReassign };
