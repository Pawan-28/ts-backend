/**
 * The 3-day "stuck lead" clock.
 *
 * A lead sitting in the same pipeline stage for 3 days without moving to the next one is taken from the employee and auto-assigned to
 * another. This module only DECIDES (pure, no database): when did the lead enter its current stage, when does the window end, and how
 * long is left. The worker (services/autoReassignService) and the cards / lead panel all use the same answer.
 *
 * The clock only runs for the leads that have NOT been talked to properly:
 *   Lead, Not Pick, Short Call
 * Conversation (answered above 2 min) and everything after it (Meeting Booked / Done / Proposal / Objection / paid / Not Interested)
 * have no clock. A lead the AI marked "Not Interested" has no clock either - recycling it to another rep would be pointless.
 *
 * The 3 days are WORKING days: the clock stops on Sunday (India time), so a Sunday inside the window adds one day (utils/workingTime).
 *
 * "Entered the stage" =
 *   - the time of the stage move (stored stage), or
 *   - the FIRST call that put the person in the stage the call history says (Not Pick / Short Call / Conversation). Further calls
 *     that leave it in the same stage do NOT restart the clock - the lead has not moved forward.
 *   - a lead with no call and no stage move: the time it was assigned (or created).
 * The window starts again whenever the lead is (re)assigned, and never starts before `floorAt` (the moment the admin switched the
 * feature on - leads that were already old then get a full window instead of being recycled at once).
 */
const { mapStageToId } = require("./pipelineStages");
const { callBucket } = require("./callMetrics");
const { normalizeTemperature } = require("./leadTemperature");
const { addWorkingMs, workingMsBetween, isSunday } = require("./workingTime");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 3;

// Conversation keeps its rank (the calls can lift a lead into it), but it is NOT a timed stage.
const COLUMN_RANK = { lead: 0, not_pick: 1, short_call: 2, conversation_2min: 3 };
const TIMED_COLUMNS = new Set(["lead", "not_pick", "short_call"]);

/** One call -> the pipeline column it puts the person in (same mapping as the Pipeline), or null when it counts for nothing. */
function callColumn(call) {
  switch (callBucket(call || {})) {
    case "conversation": return "conversation_2min";
    case "short":
    case "incoming_short": return "short_call";
    case "no_pickup":
    case "missed_incoming":
    case "rejected": return "not_pick";
    default: return null;
  }
}

const toMs = (v) => {
  if (v == null || v === "") return null;
  const ms = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
};

/** The furthest column the calls reach, and when the FIRST call in that column happened. */
function entryFromCalls(calls) {
  let best = null;
  for (const c of Array.isArray(calls) ? calls : []) {
    const col = callColumn(c);
    const at = toMs(c.startedAt ?? c.started_at ?? c.callAt ?? c.createdAt ?? c.created_at);
    if (!col || at == null) continue;
    const rank = COLUMN_RANK[col];
    if (!best || rank > best.rank || (rank === best.rank && at < best.at)) best = { column: col, rank, at };
  }
  return best ? { column: best.column, enteredAtMs: best.at } : null;
}

/**
 * @param {object} p
 * @param {string} p.stage / p.status   the stored pipeline stage / status
 * @param {string} [p.temperature]
 * @param {Array}  p.calls              every call of this person (any employee, any date)
 * @param {*} [p.stageEnteredAt]        when the stored stage was last changed (leads.source_meta.stageClock), if known
 * @param {*} [p.assignedAt] [p.createdAt] [p.floorAt]
 * @param {number|Date} [p.now]
 * @param {number} [p.days]
 * @returns {{ timed: boolean, reason?: string, column: string, enteredAt?: Date, deadlineAt?: Date, msLeft?: number, daysLeft?: number, due?: boolean }}
 */
function computeStageClock({ stage, status, temperature, calls = [], stageEnteredAt, assignedAt, createdAt, floorAt, now = Date.now(), days = DEFAULT_WINDOW_DAYS }) {
  const storedId = mapStageToId(stage, status);
  if (!TIMED_COLUMNS.has(storedId)) return { timed: false, reason: "stage", column: storedId };
  if (normalizeTemperature(temperature) === "not_interested") return { timed: false, reason: "not_interested", column: storedId };

  const fromCalls = entryFromCalls(calls);
  const storedRank = COLUMN_RANK[storedId];
  const callRank = fromCalls ? COLUMN_RANK[fromCalls.column] : -1;
  const storedMs = toMs(stageEnteredAt);

  let column;
  let entered;
  if (callRank > storedRank) {
    column = fromCalls.column;
    entered = fromCalls.enteredAtMs;                         // the calls moved it further than the stored stage
  } else if (callRank === storedRank) {
    column = storedId;
    const known = [storedMs, fromCalls.enteredAtMs].filter((v) => v != null);
    entered = known.length ? Math.min(...known) : null;      // in this stage since the earlier of the two
  } else {
    column = storedId;
    entered = storedMs;                                      // a stage move with no later call
  }
  // The calls can lift a lead into Conversation: from then on it has no clock.
  if (!TIMED_COLUMNS.has(column)) return { timed: false, reason: "stage", column };
  if (entered == null) entered = toMs(assignedAt) ?? toMs(createdAt);

  // The window restarts when the lead is (re)assigned and never starts before the feature was switched on.
  const anchorMs = Math.max(entered ?? 0, toMs(assignedAt) ?? 0, toMs(floorAt) ?? 0);
  if (!anchorMs) return { timed: false, reason: "no_time", column };

  const nowMs = toMs(now);
  // `days` of WORKING time (Sunday does not count): the deadline already includes any Sunday in between.
  const deadlineMs = addWorkingMs(anchorMs, days * DAY_MS);
  const due = nowMs >= deadlineMs;
  // working time left; frozen while it is Sunday; negative once overdue
  const msLeft = due ? deadlineMs - nowMs : workingMsBetween(nowMs, deadlineMs);
  return {
    timed: true,
    column,
    enteredAt: new Date(anchorMs),
    deadlineAt: new Date(deadlineMs),
    msLeft,
    daysLeft: Math.max(0, Math.ceil(msLeft / DAY_MS)),
    due,
    paused: !due && isSunday(nowMs),
  };
}

/** "3 days to auto-assign" / "2 days ..." / "1 day ..." / "Paused on Sunday · 2 days left" / "Auto-assigning soon". null = no clock. */
function autoAssignLabel(clock) {
  if (!clock || !clock.timed) return null;
  if (clock.due || clock.daysLeft <= 0) return "Auto-assigning soon";
  const left = `${clock.daysLeft} ${clock.daysLeft === 1 ? "day" : "days"}`;
  return clock.paused ? `Paused on Sunday · ${left} left` : `${left} to auto-assign`;
}

module.exports = {
  DAY_MS, DEFAULT_WINDOW_DAYS, COLUMN_RANK, TIMED_COLUMNS,
  callColumn, entryFromCalls, computeStageClock, autoAssignLabel,
};
