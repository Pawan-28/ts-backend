const {
  STAGE_BREAKDOWN,
  mapStageToId,
} = require("./pipelineStages");

const normalize = (value) => String(value || "").toLowerCase().trim();

function leadStage(lead) {
  return normalize(lead.pipeline_stage || lead.pipelineStage || lead.stage);
}

function leadStatus(lead) {
  return normalize(lead.status);
}

function isStillNewAssigned(lead) {
  if (lead.accepted_at || lead.acceptedAt) return false;
  const assignStatus = normalize(lead.assignment_status || lead.assignmentStatus);
  if (assignStatus === "accepted" || assignStatus === "in_progress") return false;
  const stage = leadStage(lead);
  if (!["new", "new lead", "lead"].includes(stage)) return false;
  return assignStatus === "assigned" || assignStatus === "pending" || assignStatus === "unassigned";
}

function isUnworked(lead) {
  const stage = leadStage(lead);
  const status = leadStatus(lead);
  if (isStillNewAssigned(lead)) return true;
  if (stage.includes("not pick") || status.includes("not pick") || status === "notpick") return true;
  if (["new", "new lead", "lead"].includes(stage) || ["new", "new lead"].includes(status)) return true;
  return false;
}

function isConverted(lead) {
  const stage = leadStage(lead);
  const status = leadStatus(lead);
  return (
    stage.includes("payment complete")
    || status.includes("payment complete")
    || stage === "converted"
    || status === "converted"
    || stage.includes("won")
  );
}

function isContacted(lead) {
  if (isUnworked(lead)) return false;
  if (isConverted(lead)) return true;
  const stageId = mapLeadKanbanStage(lead);
  return stageId !== "lead" && stageId !== "not_pick" && stageId !== "not_interested";
}

function isQualified(lead) {
  if (!isContacted(lead)) return false;
  const stage = leadStage(lead);
  const status = leadStatus(lead);
  const temp = normalize(lead.temperature);
  const stageKeys = [
    "conversation", "meeting", "booked", "proposal", "objection",
    "advance paid", "payment complete", "qualified", "contacted",
  ];
  if (stageKeys.some((k) => stage.includes(k) || status.includes(k))) return true;
  return ["warm", "hot", "warm lead", "hot lead"].includes(temp) || ["warm", "hot"].includes(status);
}

function isMeeting(lead) {
  if (!isContacted(lead)) return false;
  const stageId = mapLeadKanbanStage(lead);
  return [
    "meeting_booked",
    "meeting_done",
    "proposal_sent",
    "objection",
    "advance_paid",
    "payment_complete",
  ].includes(stageId);
}

/** Meeting Booked stage. */
function isBookedStage(lead) {
  return mapLeadKanbanStage(lead) === "meeting_booked";
}

/** Meeting Done stage (legacy showed up included). */
function isShowedUpStage(lead) {
  return mapLeadKanbanStage(lead) === "meeting_done";
}

function isPipelineQualified(lead) {
  return isBookedStage(lead) || isShowedUpStage(lead);
}

function computeLeadStats(leads = []) {
  const list = Array.isArray(leads) ? leads : [];
  const convertedLeads = list.filter(isConverted);
  const pipelineQualified = list.filter(isPipelineQualified).length;
  return {
    totalLeads: list.length,
    qualified: list.filter(isQualified).length,
    pipelineQualified,
    booked: list.filter(isBookedStage).length,
    meetingBooked: list.filter(isBookedStage).length,
    showedUp: list.filter(isShowedUpStage).length,
    meetingDone: list.filter(isShowedUpStage).length,
    totalMeetings: list.filter(isMeeting).length,
    converted: convertedLeads.length,
    revenue: convertedLeads.reduce(
      (sum, l) => sum + (Number(l.expected_revenue ?? l.revenue) || 0),
      0,
    ),
    contacted: list.filter(isContacted).length,
    followUps: list.filter((l) =>
      ["not interested", "not attending", "call back later", "ni"].includes(leadStatus(l)),
    ).length,
  };
}

function mapLeadKanbanStage(lead) {
  if (isStillNewAssigned(lead)) return "lead";
  return mapStageToId(
    lead.pipeline_stage || lead.pipelineStage || lead.stage,
    lead.status,
  );
}

function buildStageBreakdown(leads = []) {
  const counts = Object.fromEntries(STAGE_BREAKDOWN.map((s) => [s.id, 0]));
  for (const lead of leads) {
    const id = mapLeadKanbanStage(lead);
    if (counts[id] != null) counts[id] += 1;
  }
  const max = Math.max(1, ...Object.values(counts));
  return STAGE_BREAKDOWN.map((s) => ({
    label: s.label,
    count: counts[s.id] || 0,
    pct: Math.round(((counts[s.id] || 0) / max) * 100),
  }));
}

function buildLeadFunnel(stats) {
  return [
    { name: "Assigned", value: stats.totalLeads || 0 },
    { name: "Contacted", value: stats.contacted || 0 },
    { name: "Qualified", value: stats.pipelineQualified ?? stats.qualified ?? 0 },
    { name: "Meeting", value: stats.totalMeetings || stats.booked || 0 },
    { name: "Converted", value: stats.converted || 0 },
  ];
}

/** Funnel aligned with Callyzer Call Reporting (dials → 2min+ → meetings → won). */
function buildCallyzerFunnel(leadStats = {}, callStats = {}) {
  return [
    { name: "Assigned", value: Number(leadStats.totalLeads) || 0 },
    { name: "Contacted", value: Number(callStats.totalCalls) || 0 },
    { name: "Qualified", value: Number(callStats.conversations5MinPlus) || 0 },
    {
      name: "Meeting",
      value: Number(leadStats.booked ?? leadStats.meetingBooked ?? leadStats.pipelineQualified) || 0,
    },
    { name: "Converted", value: Number(leadStats.converted) || 0 },
  ];
}

/** SQL fragment: lead has been contacted (matches computeLeadStats). */
const CONTACTED_LEAD_SQL = `
  (
    LOWER(COALESCE(l.pipeline_stage, '')) IN (
      'conversation - 5 (inko follow up)', 'conversation', 'attempted', 'contacted',
      'booked', 'call booked', 'meeting booked', 'meeting done', 'showed up', 'showed_up',
      'qualified', 'proposal', 'proposal sent', 'objection', 'negotiation',
      'advance paid', 'payment complete', 'converted', 'meeting'
    )
    OR LOWER(COALESCE(l.status, '')) IN (
      'attempted', 'contacted', 'converted', 'warm', 'hot', 'qualified',
      'negotiation', 'proposal sent', 'meeting booked', 'meeting done', 'payment complete'
    )
  )
  AND LOWER(COALESCE(l.pipeline_stage, '')) NOT IN ('new', 'new lead', 'lead', 'not pick')
  AND LOWER(COALESCE(l.status, '')) NOT IN ('new', 'new lead', 'notpick', 'not pick')
  AND NOT (
    l.assignment_status = 'assigned'
    AND l.accepted_at IS NULL
    AND LOWER(COALESCE(l.pipeline_stage, '')) IN ('new lead', 'new', 'lead')
  )
`;

/** Open pipeline leads (assigned but not converted / closed lost). */
function isActiveLead(lead) {
  const stageId = mapLeadKanbanStage(lead);
  if (stageId === "payment_complete" || stageId === "not_interested") return false;
  if (isConverted(lead)) return false;
  return leadStatus(lead) !== "closed lost";
}

/** SQL fragment: active/open leads for workload (matches isActiveLead). */
const ACTIVE_LEAD_SQL = `
  LOWER(COALESCE(l.pipeline_stage, '')) NOT IN (
    'payment complete', 'converted', 'won', 'closed won', 'not interested'
  )
  AND LOWER(COALESCE(l.status, '')) NOT IN ('converted', 'won', 'payment complete', 'not interested')
  AND LOWER(COALESCE(l.pipeline_stage, '')) NOT LIKE '%won%'
  AND LOWER(COALESCE(l.status, '')) <> 'closed lost'
`;

/** SQL fragment: employee-aligned qualified = meeting booked + meeting done. */
const PIPELINE_QUALIFIED_LEAD_SQL = `
  (
    LOWER(COALESCE(l.pipeline_stage, '')) IN (
      'meeting booked', 'booked', 'call booked', 'meeting done', 'showed up', 'showed_up'
    )
    OR LOWER(REPLACE(COALESCE(l.pipeline_stage, ''), '_', ' ')) LIKE '%meeting booked%'
    OR LOWER(REPLACE(COALESCE(l.pipeline_stage, ''), '_', ' ')) LIKE '%meeting done%'
    OR LOWER(REPLACE(COALESCE(l.pipeline_stage, ''), '_', ' ')) LIKE '%showed up%'
    OR LOWER(REPLACE(COALESCE(l.pipeline_stage, ''), '_', ' ')) LIKE '%show up%'
    OR LOWER(COALESCE(l.status, '')) IN ('booked', 'meeting booked', 'meeting done', 'showed up', 'show up')
    OR LOWER(REPLACE(COALESCE(l.status, ''), '_', ' ')) LIKE '%meeting booked%'
    OR LOWER(REPLACE(COALESCE(l.status, ''), '_', ' ')) LIKE '%meeting done%'
    OR LOWER(REPLACE(COALESCE(l.status, ''), '_', ' ')) LIKE '%showed up%'
    OR LOWER(REPLACE(COALESCE(l.status, ''), '_', ' ')) LIKE '%show up%'
  )
`;

module.exports = {
  computeLeadStats,
  buildLeadFunnel,
  buildCallyzerFunnel,
  buildStageBreakdown,
  CONTACTED_LEAD_SQL,
  ACTIVE_LEAD_SQL,
  PIPELINE_QUALIFIED_LEAD_SQL,
  isContacted,
  isQualified,
  isPipelineQualified,
  isBookedStage,
  isShowedUpStage,
  isMeeting,
  isConverted,
  isActiveLead,
};
