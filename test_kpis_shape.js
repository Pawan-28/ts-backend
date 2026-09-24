require("dotenv").config();
const pool = require("./config/db");
const { getTeamKPIs } = require("./src/controllers/teamController");

async function checkKpiResponseShape() {
  const ranges = ["Today", "This Week", "This Month"];

  for (const range of ranges) {
    const req = { query: { range }, user: { tenant_id: "default" } };
    const res = {
      json: (data) => {
        console.log(`\n================ RANGE: ${range} ================`);
        console.log("Full response data.kpis:\n", JSON.stringify(data.kpis, null, 2));
      },
      status: (code) => ({ json: (d) => console.log(`Error ${code}:`, d) })
    };

    await getTeamKPIs(req, res);
  }
  process.exit(0);
}

checkKpiResponseShape();
