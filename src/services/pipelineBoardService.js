const pool = require("../../config/db");
const repo = require("../repositories/operationalRepo");
const callyzer = require("./callyzerService");
const { queryCallStats } = require("../utils/employeeCallStats");
const { dedupePeriodCalls } = require("../utils/callMetrics");
const { filterCallsForPeriod } = require("../utils/periodDateKeys");
const {
  groupEmpLeadsKanban,
  aggregateOppCountsFromKanban,
  getOppLeadsFromKanban,
} = require("../utils/leadKanban");

function normalizePeriodKey(period = "month") {
  const raw = String(period || "month").toLowerCase();
  if (raw === "day" || raw === "today") return "today";
  if (raw === "this week" || raw === "this_week" || raw === "week") return "week";
  if (raw === "this month" || raw === "this_month" || raw === "month") return "month";
  if (raw === "custom") return "custom";
  return raw;
}

function formatDbCallsForEmployee(dbCalls, leads, { limit } = {}) {
  const phoneIndex = callyzer.buildLeadPhoneIndex(leads);
  const sorted = dbCalls
    .map((c) => callyzer.attachLeadToCall(c, leads, phoneIndex))
    .sort((a, b) => {
      const ta = new Date(a.startedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.startedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
  if (limit == null) return sorted;
  return sorted.slice(0, Math.max(Number(limit) || 0, 1));
}

async function resolveEmployeeId(tenantId, employeeName) {
  if (!employeeName || employeeName === "All Employees") return null;
  const trimmed = String(employeeName).trim();
  const exact = await pool.query(
    "SELECT id FROM employees WHERE tenant_id = $1 AND name = $2 LIMIT 1",
    [tenantId, trimmed],
  );
  if (exact.rows[0]?.id != null) return exact.rows[0].id;

  const ci = await pool.query(
    "SELECT id FROM employees WHERE tenant_id = $1 AND LOWER(name) = LOWER($2) LIMIT 1",
    [tenantId, trimmed],
  );
  if (ci.rows[0]?.id != null) return ci.rows[0].id;

  const fuzzy = await pool.query(
    "SELECT id FROM employees WHERE tenant_id = $1 AND LOWER(name) LIKE $2 ORDER BY LENGTH(name) ASC LIMIT 1",
    [tenantId, `%${trimmed.toLowerCase()}%`],
  );
  return fuzzy.rows[0]?.id ?? null;
}

function leadMatchesService(lead, service) {
  if (!service || service === "All Services") return true;
  const s = String(service).toLowerCase();
  const candidates = [
    lead.formName,
    lead.form_name,
    lead.source,
    lead.keyword,
    lead.requirements,
  ];
  return candidates.some((v) => String(v || "").toLowerCase().includes(s));
}

function leadMatchesEmployee(lead, employeeName) {
  if (!employeeName || employeeName === "All Employees") return true;
  const name = String(employeeName).toLowerCase();
  const candidates = [
    typeof lead.assignedTo === "object" ? lead.assignedTo?.name : "",
    lead.assignedToName,
    lead.assigned_to_name,
    lead.employeeName,
  ].map((v) => String(v || "").toLowerCase());
  return candidates.some((c) => c && c.includes(name));
}

function formatOppLeadForApi(lead) {
  const assignedTo = lead.assignedTo;
  return {
    id: lead.id,
    lead_name: lead.leadName || lead.name || lead.lead_name || "Unknown",
    phone: lead.phone || lead.clientPhone || null,
    email: lead.email || null,
    city: lead.city || null,
    pipeline_stage: lead.pipelineStage || lead.stage || lead.pipeline_stage || null,
    status: lead.status || null,
    temperature: lead.temperature || null,
    expected_revenue: lead.expectedRevenue ?? lead.expected_revenue ?? null,
    interactions: lead.interactions || null,
    created_at: lead.createdAt || lead.created_at || null,
    assigned_to_name: typeof assignedTo === "object" ? assignedTo?.name : (assignedTo || null),
  };
}

async function buildPipelineBoardPayload(tenantId, {
  period = "month",
  employeeId = null,
  limit = 5000,
  attachLeads = null,
  startDate = null,
  endDate = null,
} = {}) {
  const periodKey = normalizePeriodKey(period);
  const callLimit = Math.min(Math.max(Number(limit) || 5000, 1), 10000);
  const useFullAttach = employeeId == null && Array.isArray(attachLeads) && attachLeads.length > 0;
  const customRange = periodKey === "custom" && startDate && endDate
    ? { startDate, endDate }
    : null;

  const callPeriod = periodKey === "custom" ? "month" : periodKey;

  const [stats, dbCalls, meetings, assignedNewLeads] = await Promise.all([
    queryCallStats(pool, {
      tenantId,
      period: callPeriod,
      employeeId: employeeId ?? undefined,
    }),
    employeeId != null
      ? repo.listCalls(tenantId, employeeId, { period: callPeriod, limit: callLimit })
      : repo.listTenantCalls(tenantId, { period: callPeriod, limit: callLimit }),
    employeeId != null
      ? repo.listMeetings(tenantId, employeeId, { limit: 1000 })
      : repo.listTenantMeetings(tenantId, { limit: 1000 }),
    useFullAttach ? Promise.resolve([]) : repo.listAssignedNewLeadsForPipeline(tenantId, employeeId),
  ]);

  let leads;
  if (useFullAttach) {
    leads = attachLeads;
  } else {
    const leadIds = new Set();
    for (const call of dbCalls) {
      if (call.leadId != null) leadIds.add(Number(call.leadId));
    }
    for (const meeting of meetings) {
      if (meeting.leadId != null) leadIds.add(Number(meeting.leadId));
    }
    for (const lead of assignedNewLeads) {
      if (lead?.id != null) leadIds.add(Number(lead.id));
    }

    const callLinkedLeads = await repo.findLeadsByIds(tenantId, [...leadIds]);
    const leadMap = new Map();
    for (const lead of callLinkedLeads) leadMap.set(Number(lead.id), lead);
    for (const lead of assignedNewLeads) leadMap.set(Number(lead.id), lead);
    leads = [...leadMap.values()];
  }

  const leadsForAttach = Array.isArray(attachLeads) && attachLeads.length
    ? attachLeads
    : leads;

  let calls = formatDbCallsForEmployee(dbCalls, leadsForAttach);
  if (customRange) {
    calls = filterCallsForPeriod(calls, "custom", new Date(), customRange);
  }
  calls = dedupePeriodCalls(calls);

  return {
    period: periodKey,
    stats,
    calls,
    leads,
    meetings,
    totals: {
      calls: calls.length,
      leads: leads.length,
      meetings: meetings.length,
    },
  };
}

async function loadKanbanOppData(tenantId, options = {}) {
  const {
    employee,
    service,
    period = "month",
    rangeKey,
    startDate,
    endDate,
    category = null,
    includeUncontactedAssignments: includeUncontactedOpt,
  } = options;

  const periodKey = normalizePeriodKey(period || rangeKey || "month");
  const hasEmployeeFilter = Boolean(employee && employee !== "All Employees");
  const employeeId = hasEmployeeFilter ? await resolveEmployeeId(tenantId, employee) : null;
  const isAllEmployees = !hasEmployeeFilter;
  const customRange = periodKey === "custom" && startDate && endDate
    ? { startDate, endDate }
    : null;

  // Load full lead list (same as admin Pipeline board) so call→lead phone matching works.
  let attachLeads = [];
  if (employeeId != null) {
    const { items } = await repo.listAllLeads(tenantId, { assignedTo: employeeId }, { pageSize: 2000, maxPages: 10 });
    attachLeads = items;
  } else {
    const { items } = await repo.listAllLeads(tenantId, {}, { pageSize: 2000, maxPages: 10 });
    attachLeads = items;
  }

  // Match frontend usePipelineSync: fetch month calls once, slice Today/Week client-side.
  const fetchPeriod = periodKey === "custom" ? "custom" : "month";

  const board = await buildPipelineBoardPayload(tenantId, {
    period: fetchPeriod,
    employeeId: employeeId ?? undefined,
    startDate,
    endDate,
    attachLeads,
  });

  let kanbanLeads = attachLeads.filter((lead) => leadMatchesService(lead, service));
  if (hasEmployeeFilter && employeeId == null) {
    kanbanLeads = kanbanLeads.filter((lead) => leadMatchesEmployee(lead, employee));
  }

  let periodCalls = board.calls;
  if (periodKey === "custom" && customRange) {
    periodCalls = filterCallsForPeriod(board.calls, "custom", new Date(), customRange);
  } else if (periodKey !== "month" && periodKey !== "all") {
    periodCalls = filterCallsForPeriod(board.calls, periodKey, new Date());
  }
  periodCalls = dedupePeriodCalls(periodCalls);

  if (hasEmployeeFilter && employeeId == null) {
    const empLower = String(employee).toLowerCase();
    periodCalls = periodCalls.filter((call) => {
      const names = [
        call.employeeName,
        call.agentName,
        call.userName,
        call.callerName,
      ].map((v) => String(v || "").toLowerCase());
      return names.some((n) => n && (n.includes(empLower) || empLower.includes(n)));
    });
    const callLeadIds = new Set(
      periodCalls.map((c) => c.leadId).filter((id) => id != null).map(String),
    );
    kanbanLeads = kanbanLeads.filter(
      (lead) => callLeadIds.has(String(lead.id)) || leadMatchesEmployee(lead, employee),
    );
  }

  const grouped = groupEmpLeadsKanban(kanbanLeads, periodCalls, {
    period: periodKey,
    meetings: board.meetings,
    adminScope: false,
    includeUncontactedAssignments: true,
    scopeCallsByAssignee: true,
    employeeId: employeeId ?? undefined,
    customRange,
  });

  const totals = aggregateOppCountsFromKanban(grouped);

  let leads = [];
  if (category) {
    leads = getOppLeadsFromKanban(grouped, category)
      .map(formatOppLeadForApi)
      .slice(0, 100);
  }

  return { totals, leads, grouped };
}

module.exports = {
  buildPipelineBoardPayload,
  loadKanbanOppData,
  formatDbCallsForEmployee,
  resolveEmployeeId,
};
