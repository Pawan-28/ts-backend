/** Shared pipeline stages — admin kanban, employee kanban, and DB labels. */
const PIPELINE_STAGE_DEFINITIONS = [
  { id: "lead", label: "Lead" },
  { id: "not_pick", label: "Not Pick" },
  { id: "short_call", label: "Short Call" },
  { id: "conversation_2min", label: "Conversation 2 min+" },
  { id: "meeting_booked", label: "Meeting Booked" },
  { id: "meeting_done", label: "Meeting Done" },
  { id: "proposal_sent", label: "Proposal Sent" },
  { id: "objection", label: "Objection" },
  { id: "advance_paid", label: "Advance Paid" },
  { id: "payment_complete", label: "Payment Complete" },
  { id: "not_interested", label: "Not Interested" },
];

const DEFAULT_PIPELINE_STAGE_ID = "lead";
const DEFAULT_PIPELINE_STAGE_LABEL = "Lead";

function getStageLabelById(stageId) {
  if (stageId === "conversation_5") return "Conversation 2 min+";
  const meta = PIPELINE_STAGE_DEFINITIONS.find((s) => s.id === stageId);
  return meta ? meta.label : DEFAULT_PIPELINE_STAGE_LABEL;
}

function mapStageToId(stage, status = "") {
  const raw = String(stage || "").trim();
  const s = raw.toLowerCase();
  const normalized = s.replace(/_/g, " ");
  const st = String(status || "").toLowerCase();

  if (s === "conversation_5") return "conversation_2min";

  const direct = PIPELINE_STAGE_DEFINITIONS.find(
    (item) => item.id === s
      || item.id === raw
      || item.label.toLowerCase() === s
      || item.label.toLowerCase() === normalized,
  );
  if (direct) return direct.id;

  if (normalized.includes("not interested") || st === "ni" || st.includes("not interested")) {
    return "not_interested";
  }
  if (
    normalized.includes("payment complete")
    || normalized.includes("converted")
    || normalized === "won"
    || normalized.includes("closed won")
  ) {
    return "payment_complete";
  }
  if (normalized.includes("advance paid")) return "advance_paid";
  if (normalized.includes("objection") || normalized.includes("negotiation")) return "objection";
  if (normalized.includes("proposal sent") || normalized.includes("proposal")) return "proposal_sent";
  if (
    normalized.includes("meeting done")
    || normalized.includes("showed up")
    || normalized.includes("show up")
  ) {
    return "meeting_done";
  }
  if (
    normalized.includes("meeting booked")
    || normalized.includes("booked")
    || normalized.includes("call booked")
  ) {
    return "meeting_booked";
  }
  if (
    s === "conversation_2min"
    || normalized.includes("conversation 2 min")
    || normalized.includes("conversation - 5")
    || normalized.includes("conversation 5")
    || (normalized.includes("conversation") && normalized.includes("2 min"))
    || normalized.includes("follow up")
    || normalized.includes("follow-up")
    || normalized === "conversation"
    || s.includes("contacted")
    || s.includes("qualified")
  ) {
    return "conversation_2min";
  }
  if (
    s === "short_call"
    || normalized.includes("short call")
    || (normalized.includes("connected") && normalized.includes("2 min"))
    || s.includes("attempted")
  ) {
    return "short_call";
  }
  if (normalized.includes("not pick") || st === "notpick" || st.includes("not pick")) {
    return "not_pick";
  }
  if (s === "new" || s.includes("new lead") || st === "new" || st.includes("new lead")) {
    return "lead";
  }
  if (s === "lead") return "lead";

  if (s === "closed_won") return "payment_complete";
  if (s === "negotiation") return "objection";
  if (s === "proposal") return "proposal_sent";
  if (s === "qualified") return "meeting_booked";
  if (s === "contacted") return "conversation_2min";

  return DEFAULT_PIPELINE_STAGE_ID;
}

function normalizeStageLabel(stage, status = "") {
  const raw = String(stage || "").trim();
  if (!raw) return DEFAULT_PIPELINE_STAGE_LABEL;
  const byId = PIPELINE_STAGE_DEFINITIONS.find((item) => item.id === raw);
  if (byId) return byId.label;
  const byLabel = PIPELINE_STAGE_DEFINITIONS.find(
    (item) => item.label.toLowerCase() === raw.toLowerCase(),
  );
  if (byLabel) return byLabel.label;
  return getStageLabelById(mapStageToId(raw, status));
}

const STAGE_BREAKDOWN = PIPELINE_STAGE_DEFINITIONS.map((s) => ({ id: s.id, label: s.label }));

const ADMIN_PIPELINE_TO_DB_STAGE = Object.fromEntries(
  PIPELINE_STAGE_DEFINITIONS.map((s) => [s.id, s.label]),
);
ADMIN_PIPELINE_TO_DB_STAGE.conversation_5 = "Conversation 2 min+";

module.exports = {
  PIPELINE_STAGE_DEFINITIONS,
  DEFAULT_PIPELINE_STAGE_ID,
  DEFAULT_PIPELINE_STAGE_LABEL,
  STAGE_BREAKDOWN,
  ADMIN_PIPELINE_TO_DB_STAGE,
  getStageLabelById,
  mapStageToId,
  normalizeStageLabel,
};
