const {
  callBucket,
  isNotPickupByClientCall,
  isNotPickColumnCall,
  isOutboundCall,
  isShortConnectedCall,
  phonesMatchLoose,
} = require("./callMetrics");
const { mapStageToId, PIPELINE_STAGE_DEFINITIONS } = require("./pipelineStages");
const { isDateKeyInPeriod, isMeetingDateKeyInPeriod, localDateKey } = require("./periodDateKeys");

const ADVANCED_KANBAN_STAGES = new Set([
  "meeting_booked",
  "meeting_done",
  "proposal_sent",
  "objection",
  "advance_paid",
  "payment_complete",
  "not_interested",
]);

function leadStage(lead) {
  return lead?.pipelineStage || lead?.stage || lead?.pipeline_stage || "";
}

function resolveLeadAssigneeId(lead) {
  if (!lead) return null;
  const raw = lead.assigneeId ?? lead.assigned_to ?? lead.assignedTo;
  if (raw == null) return null;
  if (typeof raw === "object") return raw.id ?? raw._id ?? null;
  return raw;
}

function isEmployeeNewAssignedLead(lead) {
  if (!lead) return false;
  if (lead.acceptedAt || lead.accepted_at) return false;
  const assignStatus = String(lead.assignmentStatus || lead.assignment_status || "").toLowerCase();
  if (assignStatus === "accepted" || assignStatus === "in_progress") return false;
  if (!(assignStatus === "assigned" || assignStatus === "pending" || assignStatus === "unassigned")) {
    if (!(lead.assignedAt || lead.assigned_at) || !resolveLeadAssigneeId(lead)) return false;
  }
  const stageId = mapStageToId(leadStage(lead), lead.status);
  if (ADVANCED_KANBAN_STAGES.has(stageId)) return false;
  if (stageId === "meeting_booked" || stageId === "meeting_done") return false;
  return assignStatus === "assigned" || assignStatus === "pending" || assignStatus === "unassigned";
}

function isNewPipelineLead(lead) {
  if (!lead) return false;
  if (isEmployeeNewAssignedLead(lead)) return true;
  const st = String(lead.status || "").toLowerCase();
  if (st === "new" || st.includes("new lead")) return true;
  return mapStageToId(leadStage(lead), lead.status) === "lead";
}

function isLeadAssignedInPeriod(lead, period = "month", now = new Date(), options = {}) {
  const raw = options.assignedOnly
    ? (lead?.assignedAt || lead?.assigned_at)
    : (lead?.assignedAt || lead?.assigned_at || lead?.createdAt || lead?.created_at);
  if (!raw) return false;
  const key = localDateKey(new Date(raw));
  return isDateKeyInPeriod(key, period, now);
}

function callMatchesSince(call, since) {
  if (!since) return true;
  const sinceMs = new Date(since).getTime();
  if (Number.isNaN(sinceMs)) return true;
  const raw = call.callAt || call.startedAt || call.createdAt || call.date;
  if (!raw) return false;
  return new Date(raw).getTime() >= sinceMs;
}

function leadContactOptions(lead, options = {}) {
  const since = options.sinceAssignment
    ? (lead?.assignedAt || lead?.assigned_at)
    : (options.since ?? null);
  return {
    outboundOnly: options.outboundOnly ?? true,
    scopeByAssignee: options.scopeByAssignee ?? false,
    since,
  };
}

function isAdminPanelAssignedLead(lead, employeeId = null) {
  if (!isEmployeeNewAssignedLead(lead)) return false;
  const method = String(lead.assignmentMethod || lead.assignment_method || "").toLowerCase();
  if (["bulk", "round_robin", "round-robin", "auto", "automatic"].includes(method)) return true;
  const assignStatus = String(lead.assignmentStatus || lead.assignment_status || "").toLowerCase();
  if (assignStatus !== "assigned" && assignStatus !== "pending") return false;
  const assignedBy = lead.assignedBy ?? lead.assigned_by;
  if (assignedBy != null && employeeId != null && String(assignedBy) === String(employeeId)) {
    return false;
  }
  if (lead.assignedAt || lead.assigned_at) return true;
  return assignStatus === "assigned" || assignStatus === "pending";
}

function phoneLast10(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function buildLeadLookupIndex(leads = []) {
  const byId = new Map();
  const byPhone = new Map();
  for (const lead of leads) {
    if (!lead) continue;
    byId.set(String(lead.id), lead);
    const key = phoneLast10(lead.phone || lead.clientPhone);
    if (key) byPhone.set(key, lead);
  }
  return { byId, byPhone };
}

/** Match leads to calls by leadId or phone only — never by name (many leads share "Unknown"). */
function resolveLeadByPhone(callPhone, index, leads = []) {
  if (!callPhone) return null;
  const key = phoneLast10(callPhone);
  if (key) {
    const hit = index.byPhone.get(key);
    if (hit) return hit;
  }
  const list = Array.isArray(leads) ? leads : [];
  return list.find((l) => {
    const leadPhone = l.phone || l.clientPhone;
    return leadPhone && phonesMatchLoose(leadPhone, callPhone);
  }) || null;
}

function resolveLeadForCallFromIndex(call, index, leads = []) {
  if (!call) return null;
  if (call.leadId != null) {
    const byId = index.byId.get(String(call.leadId));
    if (byId) return byId;
  }
  const callPhone = call.phone || call.clientPhone;
  return resolveLeadByPhone(callPhone, index, leads);
}

function buildPipelineKanbanIndex(allLeads = [], periodCalls = []) {
  const leadIndex = buildLeadLookupIndex(allLeads);
  const callsByLeadId = new Map();
  const outboundLeadIds = new Set();
  const callActiveIds = new Set();

  for (const call of periodCalls) {
    const lead = resolveLeadForCallFromIndex(call, leadIndex, allLeads);
    if (!lead?.id) continue;
    const id = String(lead.id);
    callActiveIds.add(id);
    if (!callsByLeadId.has(id)) callsByLeadId.set(id, []);
    callsByLeadId.get(id).push(call);
    if (isOutboundCall(call)) outboundLeadIds.add(id);
  }

  return { leadIndex, callsByLeadId, outboundLeadIds, callActiveIds };
}

function getCallsForLead(lead, calls = [], options = {}) {
  if (!lead || !Array.isArray(calls)) return [];
  const { scopeByAssignee = false, since = null } = options;
  let matched = calls.filter((c) => {
    if (String(c.leadId) === String(lead.id)) return true;
    const leadPhone = lead.phone || lead.clientPhone;
    const callPhone = c.phone || c.clientPhone;
    if (leadPhone && callPhone && phonesMatchLoose(leadPhone, callPhone)) return true;
    return false;
  });
  if (scopeByAssignee) {
    const assigneeId = resolveLeadAssigneeId(lead);
    if (assigneeId != null) {
      matched = matched.filter((c) => String(c.employeeId) === String(assigneeId));
    }
  }
  if (since) {
    matched = matched.filter((c) => callMatchesSince(c, since));
  }
  return matched;
}

function getLeadOutboundCalls(lead, periodCalls = [], options = {}) {
  const opts = leadContactOptions(lead, options);
  const leadCalls = getCallsForLead(lead, periodCalls, opts);
  if (!opts.outboundOnly) return leadCalls;
  return leadCalls.filter(isOutboundCall);
}

function leadHasOutboundCalls(lead, periodCalls = [], options = {}) {
  return getLeadOutboundCalls(lead, periodCalls, options).length > 0;
}

function isUncontactedNewLead(lead, periodCalls = [], options = {}) {
  if (!lead) return false;
  const contactOpts = {
    outboundOnly: options.outboundOnly ?? true,
    scopeByAssignee: options.scopeByAssignee ?? false,
    sinceAssignment: options.sinceAssignment ?? false,
  };
  if (leadHasOutboundCalls(lead, periodCalls, contactOpts)) return false;
  return isEmployeeNewAssignedLead(lead);
}

// Pipeline column rules = the shared call definitions (utils/callMetrics.js):
//   Conversation = answered, above 2 min (> 120 s), any direction
//   Short Call   = answered OUTBOUND, 1-120 s (exactly 120 s is Short)
//   Not Pick     = OUTBOUND call the client did not answer (Rejected is NOT Not Pick)
// Rejected, Missed (incoming) and Incoming short calls never create a Not Pick / Short Call card.
function leadHasConversation2MinPlus(calls = [], { outboundOnly = false } = {}) {
  return calls.some((c) => {
    if (outboundOnly && !isOutboundCall(c)) return false;
    return callBucket(c) === "conversation";
  });
}

function leadHasNotPickCall(calls = [], { outboundOnly = false } = {}) {
  return calls.some((c) => {
    if (outboundOnly && !isOutboundCall(c)) return false;
    return isNotPickColumnCall(c);
  });
}

function leadHasShortCall(calls = [], { outboundOnly = false } = {}) {
  return calls.some((c) => {
    if (outboundOnly && !isOutboundCall(c)) return false;
    return isShortConnectedCall(c);
  });
}

function resolveEarlyFunnelColumn(lead, periodCalls = [], options = {}) {
  const contactOpts = {
    outboundOnly: options.outboundOnly ?? true,
    scopeByAssignee: options.scopeByAssignee ?? false,
  };
  const allCalls = getCallsForLead(lead, periodCalls, {
    scopeByAssignee: contactOpts.scopeByAssignee,
  });
  const outboundCalls = getLeadOutboundCalls(lead, periodCalls, contactOpts);

  if (leadHasConversation2MinPlus(allCalls, { outboundOnly: false })) return "conversation_2min";
  if (leadHasShortCall(outboundCalls, { outboundOnly: true })) return "short_call";
  if (leadHasNotPickCall(outboundCalls, { outboundOnly: true })) return "not_pick";
  if (isUncontactedNewLead(lead, periodCalls, {
    ...contactOpts,
    sinceAssignment: options.sinceAssignment ?? false,
  })) return "lead";
  return null;
}

function callKanbanColumn(call) {
  switch (callBucket(call || {})) {
    case "conversation": return "conversation_2min";
    case "short": return "short_call";
    case "no_pickup": return "not_pick";
    // a dial the CUSTOMER rejected (outbound Rejected) -> Not Pick; a rejected INCOMING call (rep declined) moves nothing
    case "rejected": return isOutboundCall(call || {}) ? "not_pick" : null;
    default: return null; // missed incoming / incoming short: no stage move
  }
}

function filterMeetingsForPeriod(meetings = [], period = "month", now = new Date(), customRange = null) {
  const list = Array.isArray(meetings) ? meetings : [];
  const p = String(period).toLowerCase();
  return list.filter((m) => {
    if (m.status === "cancelled") return false;
    const raw = m.scheduledAt || m.date || m.scheduled_at;
    if (!raw) return p === "month";
    const key = localDateKey(new Date(raw));
    if (p === "custom" && customRange?.startDate && customRange?.endDate) {
      return key && key >= customRange.startDate && key <= customRange.endDate;
    }
    return isMeetingDateKeyInPeriod(key, period, now);
  });
}

function resolveLeadKanbanColumn(lead, calls = [], options = {}) {
  if (!lead) return "lead";
  if (lead._fromCall && lead._callCol) return lead._callCol;

  const dbStageId = mapStageToId(leadStage(lead), lead.status);
  if (ADVANCED_KANBAN_STAGES.has(dbStageId)) return dbStageId;
  if (dbStageId === "meeting_booked" || dbStageId === "meeting_done") return dbStageId;

  return resolveEarlyFunnelColumn(lead, calls, {
    outboundOnly: true,
    scopeByAssignee: options.scopeByAssignee ?? false,
  }) || "lead";
}

function filterPipelineLeadsForPeriod(leads = [], periodCalls = [], period = "month", meetings = [], kanbanIndex = null, options = {}) {
  const {
    adminScope = false,
    includeUncontactedAssignments = true,
    employeeId = null,
    scopeCallsByAssignee = false,
  } = options;
  const list = Array.isArray(leads) ? leads : [];
  if (adminScope) return list;

  const periodMeetings = filterMeetingsForPeriod(meetings, period, new Date(), options.customRange);
  const meetingLeadIds = new Set(
    periodMeetings.map((m) => String(m.leadId)).filter(Boolean),
  );

  const index = kanbanIndex || buildPipelineKanbanIndex(list, periodCalls);
  const { callActiveIds } = index;

  return list.filter((lead) => {
    const id = String(lead.id);
    if (meetingLeadIds.has(id)) return true;
    if (callActiveIds.has(id)) return true;
    if (includeUncontactedAssignments) {
      const periodKey = String(period).toLowerCase();
      if (isAdminPanelAssignedLead(lead, employeeId)) {
        const contacted = leadHasOutboundCalls(lead, periodCalls, {
          outboundOnly: true,
          scopeByAssignee: scopeCallsByAssignee,
          sinceAssignment: true,
        });
        if (!contacted) {
          if (periodKey === "today" || periodKey === "week" || periodKey === "month") {
            if (isLeadAssignedInPeriod(lead, periodKey, undefined, { assignedOnly: true })) return true;
          } else {
            return true;
          }
        }
      }
    }
    if (adminScope && isNewPipelineLead(lead)) return true;
    return false;
  });
}

function leadFromMeeting(meeting) {
  return {
    id: meeting.leadId || `meeting-${meeting.id}`,
    name: meeting.lead || meeting.title || "Meeting lead",
    company: meeting.company || "—",
    stage: "Meeting Booked",
    status: "warm",
    budget: "—",
    last: meeting.time || "Scheduled",
    source: "Meeting",
    _fromMeeting: true,
    _meetingId: meeting.id,
  };
}

function resolveMeetingLead(meeting, allLeads = []) {
  if (!meeting) return null;
  const list = Array.isArray(allLeads) ? allLeads : [];
  if (meeting.leadId != null) {
    const byId = list.find((l) => String(l.id) === String(meeting.leadId));
    if (byId) return byId;
  }
  const meetingPhone = meeting.phone || meeting.leadPhone || meeting.clientPhone;
  if (meetingPhone) {
    const index = buildLeadLookupIndex(list);
    const byPhone = resolveLeadByPhone(meetingPhone, index, list);
    if (byPhone) return byPhone;
  }
  return leadFromMeeting(meeting);
}

function resolveMeetingKanbanColumn(meeting, now = new Date()) {
  if (!meeting || meeting.status === "cancelled") return null;
  if (meeting.status === "completed") return "meeting_done";
  const outcome = String(meeting.outcome || "").toLowerCase();
  if (outcome.includes("completed") || outcome.includes("showed") || outcome.includes("done")) {
    return "meeting_done";
  }
  const at = new Date(meeting.scheduledAt || meeting.date || meeting.scheduled_at);
  if (!Number.isNaN(at.getTime()) && at.getTime() < now.getTime()) {
    return "meeting_booked";
  }
  return "meeting_booked";
}

/** Last-10-digit phone key, or "" when the number is missing/too short to identify a person. */
function personPhoneKey(lead) {
  const key = phoneLast10(lead?.phone || lead?.clientPhone);
  return key.length >= 10 ? key : "";
}

function leadUpdatedMs(lead) {
  const raw = lead?.updatedAt || lead?.updated_at || lead?.createdAt || lead?.created_at;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

/**
 * One person = one card. Several CRM lead rows can share a phone and each carries its own stage,
 * so the same person used to land in two columns (e.g. Meeting Done + Not Interested). The winning
 * row is the manually staged one, then the most recently updated. Mirrors frontend/src/lib/leadKanban.js.
 * @returns {Map<string, object>} losing lead id -> winning lead
 */
function buildPhoneCanonicalMap(leads = []) {
  const winners = new Map();
  for (const lead of leads) {
    if (!lead) continue;
    const key = personPhoneKey(lead);
    if (!key) continue;
    const cur = winners.get(key);
    const manual = (l) => Boolean(l.stageOverride || l.stageIsManual || l.stage_is_manual);
    if (!cur
      || (manual(lead) !== manual(cur) ? manual(lead) : leadUpdatedMs(lead) >= leadUpdatedMs(cur))) {
      winners.set(key, lead);
    }
  }
  const canonicalById = new Map();
  for (const lead of leads) {
    if (!lead) continue;
    const key = personPhoneKey(lead);
    const winner = key ? winners.get(key) : null;
    if (winner && String(winner.id) !== String(lead.id)) canonicalById.set(String(lead.id), winner);
  }
  return canonicalById;
}

function placeMeetingsOnKanban(map, pushLead, allLeads, meetings, period, showLead, customRange = null, canonicalize = (l) => l) {
  const periodMeetings = filterMeetingsForPeriod(meetings, period, new Date(), customRange);
  for (const meeting of periodMeetings) {
    const lead = canonicalize(resolveMeetingLead(meeting, allLeads));
    const col = resolveMeetingKanbanColumn(meeting);
    if (!col || !lead || !map[col]) continue;
    if (!showLead(lead)) continue;
    pushLead(col, lead);
  }
  return periodMeetings;
}

function leadFromOrphanCall(call, col = "lead") {
  const phone = call.phone || call.clientPhone || "";
  const name = call.name || call.clientName || (phone ? phone.slice(-10) : "Unknown");
  const callAt = call.callAt || call.startedAt || call.createdAt || null;
  return {
    id: `call-${call.id}`,
    name,
    company: call.company || call.clientCompany || "Callyzer Call",
    phone,
    stage: col === "conversation_2min"
      ? "Conversation"
      : col === "short_call"
        ? "Short Call"
        : col === "not_pick"
          ? "Not Pick"
          : "Lead",
    status: col === "conversation_2min"
      ? "contacted"
      : col === "short_call"
        ? "contacted"
        : col === "not_pick"
          ? "notpick"
          : "new",
    budget: "—",
    callAt,
    startedAt: callAt,
    date: callAt,
    last: call.date || callAt || "Today",
    source: "Callyzer",
    _fromCall: true,
    _callId: call.id,
    _callCol: col,
  };
}

function groupKanbanSyncedWithCallyzer(allLeads = [], periodCalls = [], meetings = [], options = {}) {
  const {
    period = "month",
    visibleLeads = null,
    customRange = null,
  } = options;
  const periodKey = String(period).toLowerCase();
  const map = Object.fromEntries(PIPELINE_STAGE_DEFINITIONS.map((s) => [s.id, []]));
  const placed = new Set();
  const kanbanIndex = buildPipelineKanbanIndex(allLeads, periodCalls);
  const { leadIndex, outboundLeadIds } = kanbanIndex;
  const scopeCallsByAssignee = options.scopeCallsByAssignee ?? false;

  const getLeadCalls = (lead) => getCallsForLead(lead, periodCalls, {
    scopeByAssignee: scopeCallsByAssignee,
  });
  const getOutboundCalls = (lead) => getLeadOutboundCalls(lead, periodCalls, {
    outboundOnly: true,
    scopeByAssignee: scopeCallsByAssignee,
  });

  const scopedVisible = visibleLeads ?? filterPipelineLeadsForPeriod(
    allLeads,
    periodCalls,
    periodKey,
    meetings,
    kanbanIndex,
    { ...options, customRange },
  );
  const visibleIds = new Set(scopedVisible.map((l) => String(l.id)));
  const canonicalById = buildPhoneCanonicalMap(scopedVisible);
  const canonicalize = (lead) => (lead ? (canonicalById.get(String(lead.id)) || lead) : lead);
  const placedPhones = new Set();

  const showLead = (lead) => {
    if (!lead) return false;
    if (canonicalById.has(String(lead.id))) return false; // losing duplicate — its winner is shown
    if (lead._fromCall || lead._fromMeeting) return true;
    return visibleIds.has(String(lead.id));
  };

  const pushLead = (col, lead) => {
    if (!lead || !map[col]) return;
    const id = String(lead.id);
    if (placed.has(id)) return;
    // Same phone never sits in two columns, whichever route the card took.
    const phoneKey = personPhoneKey(lead);
    if (phoneKey && placedPhones.has(phoneKey)) return;
    map[col].push(lead);
    placed.add(id);
    if (phoneKey) placedPhones.add(phoneKey);
  };

  placeMeetingsOnKanban(map, pushLead, allLeads, meetings, periodKey, showLead, customRange, canonicalize);

  for (const lead of scopedVisible) {
    if (!showLead(lead)) continue;
    const dbStageId = mapStageToId(leadStage(lead), lead.status);
    if (!ADVANCED_KANBAN_STAGES.has(dbStageId)) continue;
    pushLead(dbStageId, lead);
  }

  const leadsToEvaluate = new Set();
  for (const lead of scopedVisible) {
    if (getLeadCalls(lead).length > 0) leadsToEvaluate.add(String(lead.id));
  }
  for (const leadId of outboundLeadIds) leadsToEvaluate.add(leadId);
  for (const call of periodCalls) {
    const col = callKanbanColumn(call);
    if (!col) continue;
    const lead = resolveLeadForCallFromIndex(call, leadIndex, allLeads);
    if (lead?.id) leadsToEvaluate.add(String(lead.id));
  }

  for (const leadId of leadsToEvaluate) {
    const lead = canonicalize(leadIndex.byId.get(leadId));
    if (!lead || !showLead(lead)) continue;
    const leadCalls = getLeadCalls(lead);
    const outboundCalls = getOutboundCalls(lead);
    let col = null;
    if (leadHasConversation2MinPlus(leadCalls, { outboundOnly: false })) col = "conversation_2min";
    else if (leadHasShortCall(outboundCalls, { outboundOnly: true })) col = "short_call";
    else if (leadHasNotPickCall(outboundCalls, { outboundOnly: true })) col = "not_pick";
    if (col && col !== "lead") pushLead(col, lead);
  }

  // One card per unmatched phone: keep the call whose column is furthest along.
  const ORPHAN_COL_RANK = { conversation_2min: 3, short_call: 2, not_pick: 1 };
  const orphanBest = new Map();
  for (const call of periodCalls) {
    const col = callKanbanColumn(call);
    if (!col) continue;
    if (resolveLeadForCallFromIndex(call, leadIndex, allLeads)) continue;
    const phoneKey = phoneLast10(call.phone || call.clientPhone);
    const groupKey = phoneKey.length >= 10 ? `p:${phoneKey}` : `c:${call.id}`;
    const cur = orphanBest.get(groupKey);
    if (!cur || (ORPHAN_COL_RANK[col] || 0) > (ORPHAN_COL_RANK[cur.col] || 0)) {
      orphanBest.set(groupKey, { call, col });
    }
  }
  for (const { call, col } of orphanBest.values()) {
    pushLead(col, leadFromOrphanCall(call, col));
  }

  for (const lead of scopedVisible) {
    const id = String(lead.id);
    if (placed.has(id) || canonicalById.has(id)) continue;
    const allowUncontacted = options.includeUncontactedAssignments !== false;
    const periodKey = String(period).toLowerCase();
    const uncontactedNew = isAdminPanelAssignedLead(lead, options.employeeId)
      && !leadHasOutboundCalls(lead, periodCalls, {
        outboundOnly: true,
        scopeByAssignee: scopeCallsByAssignee,
        sinceAssignment: true,
      });
    const inAssignPeriod = !["today", "week", "month"].includes(periodKey)
      || isLeadAssignedInPeriod(lead, periodKey, undefined, { assignedOnly: true });
    if (!allowUncontacted || !uncontactedNew || !inAssignPeriod) {
      if (!(options.adminScope && isNewPipelineLead(lead))) continue;
    }
    pushLead("lead", lead);
  }

  return map;
}

function groupEmpLeadsKanban(leads, calls = [], options = {}) {
  const meetings = options.meetings || [];
  const period = String(options.period || "month").toLowerCase();
  const searchFiltered = options.searchFiltered ?? null;

  const scoped = filterPipelineLeadsForPeriod(leads, calls, period, meetings, null, options);
  let visibleLeads = scoped;
  if (Array.isArray(searchFiltered)) {
    const scopedIds = new Set(scoped.map((l) => String(l.id)));
    visibleLeads = searchFiltered.filter((l) => scopedIds.has(String(l.id)));
  } else if (options.visibleLeads) {
    const scopedIds = new Set(scoped.map((l) => String(l.id)));
    visibleLeads = options.visibleLeads.filter((l) => scopedIds.has(String(l.id)));
  }

  return groupKanbanSyncedWithCallyzer(leads, calls, meetings, {
    ...options,
    period,
    visibleLeads,
  });
}

const OPP_STAGE_BUCKETS = {
  not_contacted: ["not_pick", "short_call"],
  no_meeting: ["conversation_2min"],
  stuck_pipeline: ["meeting_booked", "meeting_done", "proposal_sent", "objection"],
};

/** Kanban column → Sales funnel temperature grid column (aligned with Pipeline board). */
const KANBAN_TO_FUNNEL_COL = {
  lead: "Contacted",
  not_pick: "Contacted",
  short_call: "Contacted",
  conversation_2min: "Contacted",
  meeting_booked: "Qualified",
  meeting_done: "Qualified",
  proposal_sent: "Meeting",
  objection: "Negotiation",
  advance_paid: "Conversion",
  payment_complete: "Conversion",
};

function mapLeadToTemperature(lead) {
  const t = String(lead?.temperature || lead?.priority || lead?.status || "").toLowerCase();
  if (t.includes("hot")) return "Hot";
  if (t.includes("cold")) return "Cold";
  return "Warm";
}

function buildPipelineStatusGridFromKanban(grouped = {}) {
  const stages = ["Contacted", "Qualified", "Meeting", "Negotiation", "Conversion"];
  const temps = ["Hot", "Warm", "Cold"];
  const grid = {};
  temps.forEach((t) => {
    grid[t] = {};
    stages.forEach((s) => {
      grid[t][s] = 0;
    });
  });

  for (const [kanbanCol, leads] of Object.entries(grouped || {})) {
    const funnelCol = KANBAN_TO_FUNNEL_COL[kanbanCol];
    if (!funnelCol || !Array.isArray(leads)) continue;
    for (const lead of leads) {
      const temp = mapLeadToTemperature(lead);
      grid[temp][funnelCol] += 1;
    }
  }

  const stageTotals = {};
  stages.forEach((s) => {
    stageTotals[s] = temps.reduce((acc, t) => acc + grid[t][s], 0);
  });

  const tempTotals = {};
  temps.forEach((t) => {
    tempTotals[t] = stages.reduce((acc, s) => acc + grid[t][s], 0);
  });

  const totalLeads = Object.values(tempTotals).reduce((a, b) => a + b, 0);
  const conversions = stageTotals.Conversion || 0;
  const overallConv = totalLeads > 0 ? Math.round((conversions / totalLeads) * 100) : 0;

  return {
    grid,
    stages,
    stageTotals,
    tempTotals,
    totalLeads,
    conversions,
    overallConv,
  };
}

function aggregateOppCountsFromKanban(grouped = {}) {
  const totals = { not_contacted: 0, no_meeting: 0, stuck_pipeline: 0 };
  for (const [bucket, stageIds] of Object.entries(OPP_STAGE_BUCKETS)) {
    totals[bucket] = stageIds.reduce((sum, stageId) => sum + (grouped[stageId]?.length ?? 0), 0);
  }
  return totals;
}

function getOppLeadsFromKanban(grouped = {}, category) {
  const stageIds = OPP_STAGE_BUCKETS[category];
  if (!stageIds) return [];
  const seen = new Set();
  const out = [];
  for (const stageId of stageIds) {
    for (const lead of grouped[stageId] || []) {
      const id = String(lead.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(lead);
    }
  }
  return out;
}

module.exports = {
  ADVANCED_KANBAN_STAGES,
  groupEmpLeadsKanban,
  callKanbanColumn,
  groupKanbanSyncedWithCallyzer,
  resolveLeadKanbanColumn,
  aggregateOppCountsFromKanban,
  getOppLeadsFromKanban,
  buildPipelineStatusGridFromKanban,
  OPP_STAGE_BUCKETS,
  KANBAN_TO_FUNNEL_COL,
};
