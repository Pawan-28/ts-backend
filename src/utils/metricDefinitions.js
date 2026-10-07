/**
 * Single source of truth for dashboard / sales-funnel metric definitions.
 *
 * Everything on the admin Dashboard (KPI tiles, Sales Pipeline Status funnel, Leader Board,
 * Key Metrics rings, Revenue Trajectory, AI insights) is derived from the helpers in this file so
 * the numbers on one screen cannot drift apart. Other modules (Reports, Sales funnel, ...) can
 * require this file to reuse the same definitions.
 *
 *   PERIOD            one period object (preset or custom From/To) shared by every widget
 *   LEAD UNIVERSE     leads created inside the period (and unassigned or owned by an active employee)
 *   FUNNEL            cumulative "reached stage" counts over the lead universe (see STAGE_TO_FUNNEL)
 *   REVENUE / CASH    realised revenue (closed deals) vs recorded cash collections vs open pipeline value
 */
const { mapLeadKanbanStage } = require("./leadStats");
const { getStageLabelById } = require("./pipelineStages");
const { CALL_CONVERSATION_MIN_SEC } = require("./callMetrics");
const { isValidDateKey } = require("./periodFilter");

/* ───────────────────────────── Period ───────────────────────────── */

const PERIOD_LABELS = { today: "Today", week: "This week", month: "This month" };

function normalizePeriodKey(raw) {
  const p = String(raw || "month").toLowerCase().trim().replace(/\s+/g, "_");
  if (p === "day" || p === "today") return "today";
  if (p === "week" || p === "this_week") return "week";
  if (p === "month" || p === "this_month") return "month";
  if (p === "custom") return "custom";
  if (p === "all") return "all";
  return "month";
}

/**
 * Normalise an Express query (or options object) into ONE period object used by every query.
 * { period: today|week|month|custom|all, startDate, endDate, label, fellBack }
 * A "custom" period without a valid From/To falls back to "month" (and says so via fellBack).
 */
function resolvePeriod(source = {}) {
  const period = normalizePeriodKey(source.period || source.range || source.rangeKey);
  if (period === "custom") {
    const startDate = isValidDateKey(source.startDate) ? source.startDate : null;
    const endDate = isValidDateKey(source.endDate) ? source.endDate : null;
    if (startDate && endDate) {
      const [a, b] = startDate <= endDate ? [startDate, endDate] : [endDate, startDate];
      return {
        period: "custom",
        startDate: a,
        endDate: b,
        label: a === b ? a : `${a} to ${b}`,
        fellBack: false,
      };
    }
    return { period: "month", startDate: null, endDate: null, label: PERIOD_LABELS.month, fellBack: true };
  }
  return { period, startDate: null, endDate: null, label: PERIOD_LABELS[period] || "All time", fellBack: false };
}

/* ───────────────────────────── Formatting ───────────────────────────── */

function trimUnit(value) {
  return String(Math.round(value * 10) / 10);
}

/** Same compact rupee format as frontend/src/lib/indianFormat.js formatINR. */
function formatINR(amount) {
  const n = Number(amount) || 0;
  if (n >= 10000000) return `₹${trimUnit(n / 10000000)}Cr`;
  if (n >= 100000) return `₹${trimUnit(n / 100000)}L`;
  if (n >= 1000) {
    const k = trimUnit(n / 1000);
    return Number(k) >= 100 ? "₹1L" : `₹${k}K`;
  }
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}

const pct = (num, den) => (den > 0 ? Math.min(100, Math.round((num / den) * 100)) : 0);

/* ───────────────────────────── Stage -> funnel mapping ───────────────────────────── */

const FUNNEL_STAGES = ["Contacted", "Qualified", "Meeting", "Negotiation", "Conversion"];

/**
 * Explicit mapping: pipeline stage id (PIPELINE_STAGE_DEFINITIONS) -> deepest funnel stage reached.
 * The funnel is CUMULATIVE: a lead whose deepest stage is "Meeting" is also counted in Contacted and Qualified.
 * `funnelStage: null` means the lead is not (yet) in the funnel but is still part of Total Leads.
 */
const STAGE_TO_FUNNEL = [
  { stageId: "lead", funnelStage: null, note: "New lead, not contacted yet" },
  { stageId: "not_pick", funnelStage: null, note: "Dialled but never answered" },
  { stageId: "short_call", funnelStage: "Contacted", note: "Answered, conversation under 2 min" },
  { stageId: "conversation_2min", funnelStage: "Qualified", note: "2 min+ conversation" },
  { stageId: "meeting_booked", funnelStage: "Meeting", note: "Meeting booked" },
  { stageId: "meeting_done", funnelStage: "Meeting", note: "Meeting held" },
  { stageId: "proposal_sent", funnelStage: "Negotiation", note: "Proposal sent" },
  { stageId: "objection", funnelStage: "Negotiation", note: "Objection / negotiation" },
  { stageId: "advance_paid", funnelStage: "Negotiation", note: "Advance paid, deal not closed" },
  { stageId: "payment_complete", funnelStage: "Conversion", note: "Payment complete / converted / won" },
  { stageId: "not_interested", funnelStage: null, note: "Closed lost - not counted in funnel stages" },
];

const STAGE_TO_FUNNEL_INDEX = Object.fromEntries(
  STAGE_TO_FUNNEL.map((m) => [m.stageId, m.funnelStage ? FUNNEL_STAGES.indexOf(m.funnelStage) : -1]),
);

const TEMPS = ["Hot", "Warm", "Cold"];

function leadTemperature(row) {
  const t = String(row?.temperature || row?.priority || "").toLowerCase();
  if (t.includes("hot")) return "Hot";
  if (t.includes("cold")) return "Cold";
  return "Warm";
}

/** Deepest funnel index (0..4) a lead has reached, or -1. Meeting/conversation records can lift stale stages. */
function funnelIndexForLead(row) {
  const stageId = mapLeadKanbanStage(row);
  const hasMeeting = Number(row?.has_meeting) > 0;
  const hasConversation = Number(row?.has_conversation) > 0;
  // The stage mapping in utils/pipelineStages.js is the single source of truth: a legacy "Contacted" stage
  // maps to conversation_2min and is counted as such here (no special case).
  let idx = STAGE_TO_FUNNEL_INDEX[stageId] ?? -1;
  if (hasMeeting) idx = Math.max(idx, FUNNEL_STAGES.indexOf("Meeting"));
  if (hasConversation) idx = Math.max(idx, FUNNEL_STAGES.indexOf("Qualified"));
  return { stageId, idx };
}

/**
 * Summarise one lead universe. Tiles, funnel and leaderboard all read from this object.
 * rows: { id, assigned_to, pipeline_stage, status, temperature, priority, expected_revenue,
 *         assignment_status, accepted_at, has_meeting, has_conversation }
 */
function summarizeLeadUniverse(rows = []) {
  const funnel = Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0]));
  const grid = Object.fromEntries(TEMPS.map((t) => [t, Object.fromEntries(FUNNEL_STAGES.map((s) => [s, 0]))]));
  const tempTotals = Object.fromEntries(TEMPS.map((t) => [t, 0]));
  const byEmployee = new Map();
  let pipelineValue = 0;
  let revenue = 0;
  let closed = 0;
  let openLeads = 0;

  for (const row of rows) {
    const { stageId, idx } = funnelIndexForLead(row);
    const temp = leadTemperature(row);
    const value = Number(row.expected_revenue) || 0;
    tempTotals[temp] += 1;

    const isClosed = stageId === "payment_complete";
    const isOpen = !isClosed && stageId !== "not_interested";
    if (isClosed) {
      closed += 1;
      revenue += value;
    }
    if (isOpen) {
      openLeads += 1;
      pipelineValue += value;
    }
    for (let i = 0; i <= idx; i += 1) {
      funnel[FUNNEL_STAGES[i]] += 1;
      grid[temp][FUNNEL_STAGES[i]] += 1;
    }

    const empId = row.assigned_to;
    if (empId != null) {
      const e = byEmployee.get(String(empId)) || { leads: 0, qualified: 0, meetings: 0, proposals: 0, closed: 0 };
      e.leads += 1;
      if (idx >= 1) e.qualified += 1;
      if (idx >= 2) e.meetings += 1;
      if (idx >= 3) e.proposals += 1;
      if (isClosed) e.closed += 1;
      byEmployee.set(String(empId), e);
    }
  }

  const total = rows.length;
  return {
    total,
    funnel,
    grid,
    tempTotals,
    stageTotals: funnel,
    contacted: funnel.Contacted,
    qualified: funnel.Qualified,
    meetings: funnel.Meeting,
    negotiation: funnel.Negotiation,
    closed,
    openLeads,
    notInFunnel: total - funnel.Contacted,
    pipelineValue,
    revenue,
    byEmployee,
  };
}

/* ───────────────────────────── Rates ───────────────────────────── */

/**
 * Pickup = answered outbound calls / dialled outbound calls (period).
 * Qualification = leads that reached a 2 min+ conversation or a booked meeting / total leads (period).
 * Conversion = payment-complete leads / total leads (period).
 */
function computeRates({ summary, calls }) {
  return {
    pickup: pct(Number(calls?.answered_outbound) || 0, Number(calls?.outbound_calls) || 0),
    qualification: pct(summary.qualified, summary.total),
    conversion: pct(summary.closed, summary.total),
  };
}

/* ───────────────────────────── Leaderboard ranking ───────────────────────────── */

const LEADERBOARD_RANK_RULE = "Ranked by total calls (high to low). Ties: meetings booked, then name (A-Z).";

function compareLeaderboard(a, b) {
  return (
    (Number(b.totalCalls) || 0) - (Number(a.totalCalls) || 0)
    || (Number(b.meetings) || 0) - (Number(a.meetings) || 0)
    || String(a.name || "").localeCompare(String(b.name || ""))
  );
}

/* ───────────────────────────── SQL fragments ───────────────────────────── */

const OUTBOUND_CALL_SQL = (alias = "") => `LOWER(${alias ? `${alias}.` : ""}direction) IN ('out', 'outbound', 'outgoing')`;
const ANSWERED_CALL_SQL = (alias = "") => `${alias ? `${alias}.` : ""}duration_sec > 0`;
const CONVERSATION_CALL_SQL = (alias = "") =>
  `${alias ? `${alias}.` : ""}duration_sec >= ${CALL_CONVERSATION_MIN_SEC}`;

/* ───────────────────────────── Human-readable definitions ───────────────────────────── */

function periodBasis(period) {
  if (!period) return "the selected period";
  if (period.period === "custom") return `the custom range ${period.label}`;
  return period.label ? period.label.toLowerCase() : "the selected period";
}

/** Definitions shown as tooltips; `basis` always states the date basis of the current period. */
function buildDefinitions(period) {
  const basis = periodBasis(period);
  const created = `leads created in ${basis}`;
  return {
    totalRevenue: {
      label: "Revenue",
      formula: "Sum of deal value (expected revenue) of leads at Payment Complete / Converted / Won",
      basis: `Among ${created}`,
    },
    cashCollected: {
      label: "Cash Collected",
      formula: "Sum of recorded cash collections (payments logged against leads)",
      basis: `Payment date within ${basis}`,
    },
    totalLeads: {
      label: "Total Leads",
      formula: "All leads created in the period (unassigned or owned by an active employee)",
      basis: `Created date within ${basis}`,
    },
    totalCalls: {
      label: "Total Calls",
      formula: "All logged calls (inbound + outbound)",
      basis: `Call date within ${basis}`,
    },
    qualifiedLeads: {
      label: "Qualified Leads",
      formula: "Leads that reached a 2 min+ conversation, a booked meeting or any later stage",
      basis: `Among ${created}`,
    },
    pipelineValue: {
      label: "Pipeline Value",
      formula: "Sum of expected revenue of OPEN leads (not Payment Complete, not Not Interested)",
      basis: `Among ${created}`,
    },
    closings: {
      label: "Closings",
      formula: "Leads at Payment Complete / Converted / Won",
      basis: `Among ${created}`,
    },
    pickup: {
      label: "Pickup Rate",
      formula: "Answered outbound calls / dialled outbound calls",
      basis: `Call date within ${basis}`,
    },
    qualification: {
      label: "Qualification Rate",
      formula: "Leads with a 2 min+ conversation or meeting booked (or later) / total leads",
      basis: `Among ${created}`,
    },
    conversion: {
      label: "Conversion Rate",
      formula: "Payment-complete leads / total leads",
      basis: `Among ${created}`,
    },
    funnel: {
      label: "Sales Pipeline Status",
      formula: "Cumulative: a lead counts in every stage up to the deepest one it reached (see stageMapping)",
      basis: `Same lead universe as Total Leads: ${created}`,
    },
    leaderboard: {
      label: "Leader Board",
      formula: LEADERBOARD_RANK_RULE,
      basis: `Calls and cash by date within ${basis}; meetings/proposals from ${created} assigned to the rep`,
    },
  };
}

module.exports = {
  PERIOD_LABELS,
  FUNNEL_STAGES,
  STAGE_TO_FUNNEL,
  STAGE_TO_FUNNEL_INDEX,
  TEMPS,
  LEADERBOARD_RANK_RULE,
  CALL_CONVERSATION_MIN_SEC,
  OUTBOUND_CALL_SQL,
  ANSWERED_CALL_SQL,
  CONVERSATION_CALL_SQL,
  normalizePeriodKey,
  resolvePeriod,
  formatINR,
  pct,
  leadTemperature,
  funnelIndexForLead,
  summarizeLeadUniverse,
  computeRates,
  compareLeaderboard,
  buildDefinitions,
  periodBasis,
  getStageLabelById,
  mapLeadKanbanStage,
};
