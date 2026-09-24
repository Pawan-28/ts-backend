require("dotenv").config();
const pool = require("./config/db");
const { buildPeriodDateFilter, buildPreviousPeriodDateFilter } = require("./src/utils/periodFilter");
const { queryTeamServiceMetrics } = require("./src/utils/teamKpiMetrics");

async function testExactKpis() {
  const tenantId = "default";

  for (const period of ["day", "week", "month"]) {
    const callCurrentFilter = buildPeriodDateFilter({ period, column: "started_at" });
    const callPreviousFilter = buildPreviousPeriodDateFilter({ period, column: "started_at" });
    const leadCurrentFilter = buildPeriodDateFilter({ period, column: "created_at" });
    const leadPreviousFilter = buildPreviousPeriodDateFilter({ period, column: "created_at" });

    const metrics = await queryTeamServiceMetrics(
      pool,
      tenantId,
      callCurrentFilter,
      callPreviousFilter,
      leadCurrentFilter,
      leadPreviousFilter
    );

    console.log(`\n================ PERIOD: ${period} ================`);
    console.log("Returned Metrics:", JSON.stringify(metrics, null, 2));
  }

  process.exit(0);
}

testExactKpis();
