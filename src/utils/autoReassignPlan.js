/** Pure helpers of the auto-reassign worker (no database): who gets the lead, and the admin's counts. */

const lc = (v) => String(v == null ? "" : v).toLowerCase().trim();

/** "[Service: Podcast Interview] SOP: ..." / "Service: X" / "X" -> the bare service name. */
function bareServiceName(raw) {
  const text = String(raw == null ? "" : raw).trim();
  const bracket = text.match(/^\[Service:\s*([^\]]+)\]/i);
  if (bracket) return bracket[1].trim();
  const prefixed = text.match(/^Service:\s*(.+)$/i);
  return prefixed ? prefixed[1].trim() : text;
}

/**
 * The service a lead belongs to, from the CRM's service list: the service code the sender gave (SRV-001) first, then an exact name,
 * then a name that contains / is contained. `lead` = { requirements, insights, service, sourceMeta }.
 * Among equally good matches the one with a distribution group wins.
 */
function matchServiceForLead(lead, services) {
  const meta = lead && typeof lead.sourceMeta === "object" && lead.sourceMeta ? lead.sourceMeta : {};
  const code = lc(meta.serviceId || meta.service_id || lead?.serviceId);
  const names = [lead?.service, meta.service, meta.services, bareServiceName(lead?.requirements), lead?.insights].map(lc).filter(Boolean);
  let best = null;
  for (const svc of services || []) {
    const name = lc(svc.name);
    let score = 0;
    if (code && lc(svc.serviceId) === code) score = 3;
    else if (name && names.some((n) => n === name)) score = 2;
    else if (name && names.some((n) => n.includes(name) || name.includes(n))) score = 1;
    if (!score) continue;
    const grouped = svc.distributionEnabled && Array.isArray(svc.distributionEmployeeIds) && svc.distributionEmployeeIds.length > 0 ? 1 : 0;
    const rank = score * 2 + grouped;
    if (!best || rank > best.rank) best = { svc, rank };
  }
  return best ? best.svc : null;
}

/**
 * Who may receive this lead: the employees of the lead's SERVICE GROUP (the same distribution list the CRM uses to hand out new leads
 * of that service), other than the current owner. A service with no group = every eligible employee except the owner.
 * @returns {{ candidates: object[], service: object|null, restricted: boolean }}
 */
function candidatesForLead(eligible, lead, services, currentId) {
  const svc = matchServiceForLead(lead, services);
  const ids = svc && svc.distributionEnabled && Array.isArray(svc.distributionEmployeeIds) ? svc.distributionEmployeeIds.map(String).filter(Boolean) : [];
  const restricted = ids.length > 0;
  const pool = (eligible || []).filter((e) => String(e.id) !== String(currentId) && (!restricted || ids.includes(String(e.id))));
  return { candidates: pool, service: svc, restricted };
}

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

module.exports = { summarizeClocks, pickTarget, bareServiceName, matchServiceForLead, candidatesForLead };
