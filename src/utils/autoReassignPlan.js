/** Pure helpers of the auto-reassign worker (no database): who gets the lead, and the admin's counts. */

/** Counts for the admin: how many leads are due now / in 1 / 2 / 3+ days, from a Map of stage clocks. */
function summarizeClocks(clocks) {
  const out = { total: 0, due: 0, in1Day: 0, in2Days: 0, in3PlusDays: 0 };
  for (const c of clocks.values()) {
    if (!c || !c.timed) continue;
    out.total += 1;
    if (c.due) out.due += 1;
    else if (c.daysLeft <= 1) out.in1Day += 1;
    else if (c.daysLeft === 2) out.in2Days += 1;
    else out.in3PlusDays += 1;
  }
  return out;
}

/**
 * The least-loaded eligible employee OTHER than the current owner. `load` (Map id -> count) is bumped by the caller as leads are
 * handed out, so one run spreads leads out instead of giving them all to the same person. Ties: lowest employee id.
 */
function pickTarget(candidates, currentId, load = new Map()) {
  const others = (candidates || []).filter((e) => String(e.id) !== String(currentId));
  if (!others.length) return null;
  const loadOf = (e) => (load.get(String(e.id)) ?? (e.capacity?.currentActiveLeads || 0));
  others.sort((a, b) => loadOf(a) - loadOf(b) || Number(a.id) - Number(b.id));
  return others[0];
}

module.exports = { summarizeClocks, pickTarget };
