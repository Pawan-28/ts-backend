/** Period date-key helpers — aligned with frontend periodFilter.js. */

function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function weekStartMonday(now = new Date()) {
  const s = new Date(now);
  s.setHours(0, 0, 0, 0);
  const day = s.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  s.setDate(s.getDate() + diff);
  return s;
}

function monthStartLocal(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth(), 1);
}

function isDateKeyInPeriod(dateKey, period, now = new Date()) {
  if (!dateKey) return false;
  const p = String(period || "month").toLowerCase();
  const todayKey = localDateKey(now);
  if (!todayKey) return false;

  if (p === "today" || p === "day") {
    return dateKey === todayKey;
  }

  if (p === "week" || p === "this_week") {
    const weekStartKey = localDateKey(weekStartMonday(now));
    return Boolean(weekStartKey && dateKey >= weekStartKey && dateKey <= todayKey);
  }

  if (p === "custom" && arguments[3]?.startDate && arguments[3]?.endDate) {
    const { startDate, endDate } = arguments[3];
    return dateKey >= startDate && dateKey <= endDate;
  }

  const monthStartKey = localDateKey(monthStartLocal(now));
  return Boolean(monthStartKey && dateKey >= monthStartKey && dateKey <= todayKey);
}

/**
 * Meetings are scheduled ahead of time, so "week" / "month" cover the WHOLE calendar week (Mon–Sun)
 * / month. Calls and lead activity (isDateKeyInPeriod) are capped at today. Mirrors the frontend.
 */
function isMeetingDateKeyInPeriod(dateKey, period, now = new Date(), customRange = null) {
  if (!dateKey) return false;
  const p = String(period || "month").toLowerCase();
  if (p === "custom" || p === "today" || p === "day") {
    return isDateKeyInPeriod(dateKey, period, now, customRange);
  }
  if (p === "week" || p === "this_week") {
    const start = weekStartMonday(now);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    return dateKey >= localDateKey(start) && dateKey <= localDateKey(end);
  }
  const monthStart = monthStartLocal(now);
  const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
  return dateKey >= localDateKey(monthStart) && dateKey <= localDateKey(monthEnd);
}

function resolveCallDateKey(call) {
  if (!call || typeof call !== "object") return null;
  if (call.callDay) return call.callDay;
  for (const raw of [call.startedAt, call.callAt, call.createdAt, call.endedAt]) {
    if (!raw) continue;
    const key = localDateKey(new Date(raw));
    if (key) return key;
  }
  return null;
}

function filterCallsForPeriod(calls, period, now = new Date(), customRange = null) {
  const list = Array.isArray(calls) ? calls : [];
  if (!period || period === "all") return list;
  const p = String(period).toLowerCase();
  if (p === "custom" && customRange?.startDate && customRange?.endDate) {
    return list.filter((c) => {
      const key = resolveCallDateKey(c);
      return key && key >= customRange.startDate && key <= customRange.endDate;
    });
  }
  return list.filter((c) => isDateKeyInPeriod(resolveCallDateKey(c), period, now));
}

module.exports = {
  localDateKey,
  weekStartMonday,
  monthStartLocal,
  isDateKeyInPeriod,
  isMeetingDateKeyInPeriod,
  resolveCallDateKey,
  filterCallsForPeriod,
};
