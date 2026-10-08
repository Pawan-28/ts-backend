/**
 * Working time = every hour EXCEPT Sunday (India time). The 3-day stuck-lead timer runs on working time: it stops on Sunday, so a
 * Sunday that falls inside the window simply adds one day to the deadline.
 *
 *   addWorkingMs(startMs, durMs)   the moment `durMs` of working time after `startMs`
 *   workingMsBetween(aMs, bMs)     working time between two moments (0 when b <= a)
 *   isSunday(ms)                   is this moment inside a Sunday (IST)?
 *
 * Mirrored 1:1 in frontend/src/lib/workingTime.js (a parity test keeps them identical).
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 330 * 60 * 1000; // UTC+05:30, no daylight saving

const dayIndex = (ms) => Math.floor((ms + IST_OFFSET_MS) / DAY_MS); // days since 1970-01-01 in IST
const dayStartMs = (index) => index * DAY_MS - IST_OFFSET_MS;
const weekdayOf = (index) => (((index + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday; 0 = Sunday

function isSunday(ms) {
  return weekdayOf(dayIndex(ms)) === 0;
}

function addWorkingMs(startMs, durMs) {
  let cur = startMs;
  let remaining = Math.max(0, durMs);
  while (remaining > 0) {
    const idx = dayIndex(cur);
    const nextStart = dayStartMs(idx + 1);
    if (weekdayOf(idx) === 0) {
      cur = nextStart; // Sunday: the clock is stopped
    } else {
      const take = Math.min(nextStart - cur, remaining);
      cur += take;
      remaining -= take;
    }
  }
  return cur;
}

function workingMsBetween(aMs, bMs) {
  if (!(bMs > aMs)) return 0;
  let cur = aMs;
  let total = 0;
  while (cur < bMs) {
    const idx = dayIndex(cur);
    const nextStart = dayStartMs(idx + 1);
    const end = Math.min(nextStart, bMs);
    if (weekdayOf(idx) !== 0) total += end - cur;
    cur = end;
  }
  return total;
}

module.exports = { DAY_MS, IST_OFFSET_MS, isSunday, addWorkingMs, workingMsBetween };
