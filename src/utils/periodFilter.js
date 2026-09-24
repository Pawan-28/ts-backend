/** Build SQL date filter for employee activity periods (day / week / month). Uses APP timezone (IST default). */

const APP_TZ_OFFSET = process.env.APP_TZ_OFFSET || "+05:30";

function resolveMonth(month) {
  if (month && /^\d{4}-\d{2}$/.test(String(month))) return String(month);
  return null;
}

/** Current calendar date in app timezone (India by default). */
function sqlTodayDate() {
  return `DATE(CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '${APP_TZ_OFFSET}'))`;
}

/**
 * @returns {{ clause: string, params: string[], label: string }}
 */
function buildPeriodDateFilter({
  period = "month",
  month = null,
  column = "COALESCE(started_at, created_at)",
  paramOffset = 3,
  clipWeekToMonth = false,
} = {}) {
  const p = String(period || "month").toLowerCase();
  const resolvedMonth = resolveMonth(month);
  const today = sqlTodayDate();
  const colDate = `DATE(${column})`;

  if (p === "day" || p === "today") {
    return {
      clause: `${colDate} = ${today}`,
      params: [],
      label: "Today",
      period: "day",
    };
  }

  const weekStart = `DATE_SUB(${today}, INTERVAL WEEKDAY(${today}) DAY)`;

  if (p === "week" || p === "this_week") {
    return {
      clause: `${colDate} >= ${weekStart} AND ${colDate} <= ${today}`,
      params: [],
      label: "This week",
      period: "week",
    };
  }

  if (resolvedMonth) {
    return {
      clause: `DATE_FORMAT(${column}, '%Y-%m') = $${paramOffset}`,
      params: [resolvedMonth],
      label: resolvedMonth,
      period: "month",
    };
  }

  const monthStart = `DATE_FORMAT(${today}, '%Y-%m-01')`;
  const hierMonthStart = `LEAST(${weekStart}, ${monthStart})`;
  return {
    clause: `(${colDate} >= ${hierMonthStart} AND (${colDate} <= ${today} OR DATE_FORMAT(${column}, '%Y-%m') = DATE_FORMAT(${today}, '%Y-%m')))`,
    params: [],
    label: "This month",
    period: "month",
  };
}

/** Map Team page / API range query to internal period key. */
function rangeQueryToPeriod(range) {
  const r = String(range || "").trim().toLowerCase();
  if (r === "today" || r === "day") return "day";
  if (r === "this week" || r === "this_week" || r === "week") return "week";
  if (r === "custom") return "custom";
  return "month";
}


/** Comparison sub-label for KPI trend rows. */
function comparisonLabelForPeriod(period) {
  const p = String(period || "month").toLowerCase();
  if (p === "day" || p === "today") return "vs yesterday";
  if (p === "week" || p === "this_week") return "vs last week";
  if (p === "custom") return "vs prior period";
  return "vs last month";
}

function buildCustomDateFilter({
  startDate,
  endDate,
  column = "created_at",
  paramOffset = 2,
} = {}) {
  return {
    clause: `DATE(${column}) >= $${paramOffset} AND DATE(${column}) <= $${paramOffset + 1}`,
    params: [startDate, endDate],
    label: `${startDate} – ${endDate}`,
    period: "custom",
  };
}

/** Previous period of equal length (day / week / month / custom). */
function buildPreviousPeriodDateFilter({
  period = "month",
  month = null,
  column = "created_at",
  startDate = null,
  endDate = null,
  paramOffset = 2,
} = {}) {
  const p = String(period || "month").toLowerCase();
  const resolvedMonth = resolveMonth(month);
  const today = sqlTodayDate();
  const colDate = `DATE(${column})`;

  if (p === "day" || p === "today") {
    const yesterday = `DATE_SUB(${today}, INTERVAL 1 DAY)`;
    return {
      clause: `${colDate} = ${yesterday}`,
      params: [],
      label: "Yesterday",
      period: "day",
    };
  }

  if (p === "week" || p === "this_week") {
    const weekStart = `DATE_SUB(${today}, INTERVAL WEEKDAY(${today}) DAY)`;
    const prevWeekStart = `DATE_SUB(${weekStart}, INTERVAL 7 DAY)`;
    const prevWeekEnd = `DATE_SUB(${weekStart}, INTERVAL 1 DAY)`;
    return {
      clause: `${colDate} >= ${prevWeekStart} AND ${colDate} <= ${prevWeekEnd}`,
      params: [],
      label: "Last week",
      period: "week",
    };
  }

  if (p === "custom" && startDate && endDate) {
    return {
      clause: `${colDate} >= DATE_SUB($${paramOffset}, INTERVAL DATEDIFF($${paramOffset + 1}, $${paramOffset}) + 1 DAY) AND ${colDate} <= DATE_SUB($${paramOffset}, INTERVAL 1 DAY)`,
      params: [startDate, endDate],
      label: "Prior period",
      period: "custom",
    };
  }

  if (resolvedMonth) {
    const prevMonth = `DATE_FORMAT(DATE_SUB(STR_TO_DATE(CONCAT($${paramOffset}, '-01'), '%Y-%m-%d'), INTERVAL 1 MONTH), '%Y-%m')`;
    return {
      clause: `DATE_FORMAT(${column}, '%Y-%m') = ${prevMonth}`,
      params: [resolvedMonth],
      label: "Prior month",
      period: "month",
    };
  }

  return {
    clause: `DATE_FORMAT(${column}, '%Y-%m') = DATE_FORMAT(DATE_SUB(${today}, INTERVAL 1 MONTH), '%Y-%m')`,
    params: [],
    label: "Last month",
    period: "month",
  };
}

module.exports = {
  buildPeriodDateFilter,
  buildCustomDateFilter,
  buildPreviousPeriodDateFilter,
  rangeQueryToPeriod,
  comparisonLabelForPeriod,
  resolveMonth,
  APP_TZ_OFFSET,
  sqlTodayDate,
};
