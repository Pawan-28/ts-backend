/**
 * Pull a meeting (link + start time) out of an inbound lead webhook / form payload.
 *
 * Customers book through forms and n8n flows that don't all use the same field names or date
 * formats: one sends `scheduledAt` as an ISO string, another sends `meeting_date` ("2026-10-07")
 * and `meeting_time` ("14:00" / "2:00 PM") separately. Anything without an explicit timezone is
 * read as IST (APP_TZ_OFFSET) — the wall clock the customer picked.
 */
const { APP_TZ_OFFSET } = require("./appTimezone");

// Keys are compared case/space/underscore-insensitively ("Start Time" == start_time == startTime),
// because n8n "Set" nodes often emit human-readable names like "Google Meet Link" / "Booked Date".
const norm = (k) => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
const keySet = (list) => list.map(norm);

const LINK_KEYS = keySet([
  "meetLink", "meetingLink", "meetingUrl", "meetUrl", "google_meet_link", "googleMeetLink",
  "hangoutLink", "joinUrl", "zoomLink",
]);
// Full date-time first, then date-only, then time-only — order is the lookup priority.
// NOTE: deliberately no "booking time/date" — in n8n that is usually $now (when the booking was
// MADE), not when the meeting happens.
const DATETIME_KEYS = keySet([
  "scheduledAt", "scheduled_at_utciso", "scheduledAtIso", "meetingDateTime", "meetingAt",
  "startAt", "startDateTime", "appointmentDateTime", "slot",
]);
const DATE_KEYS = keySet([
  "meetingDate", "bookedDate", "appointmentDate", "slotDate",
]);
const TIME_KEYS = keySet([
  "meetingTime", "appointmentTime", "slotTime", "startTime",
]);
// Who the customer booked with (Amelia "provider") — used only when the lead has no assignee.
const PROVIDER_KEYS = keySet(["assignedEmployee", "providerName", "provider", "employeeName", "employee"]);

const TIME_ONLY = /^\s*\d{1,2}(?::\d{2})?(?::\d{2})?\s*(?:am|pm)?\s*$/i;
const HAS_TZ = /(?:Z|[+-]\d{2}:?\d{2})$/i;

const pad2 = (n) => String(n).padStart(2, "0");

function pick(sources, keys) {
  for (const src of sources) {
    const byNorm = new Map();
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined || v === null || typeof v === "object") continue;
      if (String(v).trim() === "") continue;
      const nk = norm(k);
      if (!byNorm.has(nk)) byNorm.set(nk, v);
    }
    for (const key of keys) {
      if (byNorm.has(key)) return byNorm.get(key);
    }
  }
  return undefined;
}

/** "14:00", "2:30 PM", "2pm", "14:00:00" → { h, m } or null. */
function parseClock(value) {
  const m = String(value ?? "").match(/^\s*(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?\s*$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const mer = (m[3] || "").toLowerCase();
  if (mer === "pm" && h < 12) h += 12;
  if (mer === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

function istDate(y, mo, d, h, mi) {
  const date = new Date(`${y}-${pad2(mo)}-${pad2(d)}T${pad2(h)}:${pad2(mi)}:00${APP_TZ_OFFSET}`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Today's calendar date in IST as [y, m, d]. */
function todayIst() {
  const shifted = new Date(Date.now() + 330 * 60 * 1000);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()];
}

/** One date/date-time string (optionally with a separate clock) → Date, or null. */
function parseDateValue(raw, clock) {
  if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw;
  if (typeof raw === "number") {
    const ms = raw < 1e11 ? raw * 1000 : raw; // seconds vs milliseconds
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{10}$|^\d{13}$/.test(s)) return parseDateValue(Number(s));

  // Explicit timezone / "Z" → trust it as-is.
  if (/\d[T ]\d/.test(s) && HAS_TZ.test(s)) {
    const d = new Date(s.replace(" ", "T"));
    if (!Number.isNaN(d.getTime())) return d;
  }

  // YYYY-MM-DD [HH:mm[:ss] [am|pm]]
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ,]+(.+))?$/);
  // DD/MM/YYYY (Indian order) [HH:mm …]
  if (!m) {
    const dm = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T ,]+(.+))?$/);
    if (dm) m = [dm[0], dm[3], dm[2], dm[1], dm[4]];
  }
  if (m) {
    const own = m[4] ? parseClock(m[4].replace(/(?:Z|[+-]\d{2}:?\d{2})$/i, "")) : null;
    const c = own || clock || { h: 9, m: 0 }; // date with no time → start of business day
    return istDate(Number(m[1]), Number(m[2]), Number(m[3]), c.h, c.m);
  }

  // Free text such as "7 Oct 2026 2:00 PM" — let Date try; treat as IST unless it carries a zone.
  const free = new Date(s);
  if (!Number.isNaN(free.getTime())) {
    return HAS_TZ.test(s) || /GMT|UTC/i.test(s)
      ? free
      : istDate(free.getFullYear(), free.getMonth() + 1, free.getDate(), free.getHours(), free.getMinutes());
  }
  return null;
}

/**
 * @returns {null | { meetLink: string|null, scheduledAt: Date|null, rawTime: string|null, providerName: string|null }}
 *   null → payload carries no meeting at all. `scheduledAt: null` with a `rawTime` → the sender
 *   gave a time we couldn't parse (caller still creates the meeting and records the raw value).
 */
function extractWebhookMeeting(input) {
  if (!input || typeof input !== "object") return null;
  const nested = [input.meeting, input.booking, input.appointment]
    .filter((v) => v && typeof v === "object" && !Array.isArray(v));
  const sources = [input, ...nested];

  const link = pick(sources, LINK_KEYS);
  const meetLink = link ? String(link).trim() : null;

  const full = pick(sources, DATETIME_KEYS);
  const dateVal = pick(sources, DATE_KEYS);
  const timeVal = pick(sources, TIME_KEYS);

  // A "time" key may hold a whole date-time ("2026-10-07 14:00") or just a clock ("14:00").
  const values = [full, dateVal, timeVal].filter((v) => v !== undefined);
  if (!meetLink && !values.length) return null;

  const isClock = (v) => typeof v !== "number" && TIME_ONLY.test(String(v));
  const clockOnly = values.find(isClock);
  const nonClock = values.filter((v) => !isClock(v));
  // Prefer a value that already carries a time ("2026-10-07T14:00…") over a bare date.
  const dated = nonClock.find((v) => typeof v === "number" || /\d{1,2}:\d{2}/.test(String(v))) ?? nonClock[0];
  const clock = clockOnly !== undefined ? parseClock(clockOnly) : null;

  let scheduledAt = null;
  if (dated !== undefined) {
    scheduledAt = parseDateValue(dated, clock);
  } else if (clock) {
    const [y, mo, d] = todayIst();
    scheduledAt = istDate(y, mo, d, clock.h, clock.m);
  }

  const rawTime = values.length ? values.map(String).join(" ").trim() : null;
  const provider = pick(sources, PROVIDER_KEYS);
  return { meetLink, scheduledAt, rawTime, providerName: provider ? String(provider).trim() : null };
}

module.exports = { extractWebhookMeeting, parseDateValue };
