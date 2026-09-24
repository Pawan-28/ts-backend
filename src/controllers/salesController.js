const pool = require("../../config/db");
const dataService = require("../services/dataService");
const getSalesDashboard = (req, res) => {
  res.json({
    kpis: {
      revenue: "₹7.9L",
      cashCollected: "₹5.1L",
      conversionRate: "24%",
      qualifiedLeads: 721,
      pipelineValue: "₹12.4L"
    },

    aiInsights: [
      "12 leads inactive for more than 7 days",
      "3 enterprise deals require follow-up",
      "Conversion rate increased by 14%"
    ],

    revenueOpportunities: [
      {
        id: 1,
        company: "Infosys",
        value: "₹2.5L",
        probability: "85%"
      },
      {
        id: 2,
        company: "TCS",
        value: "₹1.8L",
        probability: "70%"
      }
    ],

    pipelineStatus: [
      {
        stage: "New Leads",
        count: 120
      },
      {
        stage: "Qualified",
        count: 80
      },
      {
        stage: "Proposal Sent",
        count: 42
      },
      {
        stage: "Negotiation",
        count: 26
      },
      {
        stage: "Closed Won",
        count: 19
      }
    ],

    importantMetrics: {
      avgResponseTime: "2 Hours",
      customerSatisfaction: "92%",
      meetingsScheduled: 48,
      tasksCompleted: 121
    },

    recentActivities: [
      "Lead moved to negotiation stage",
      "Proposal sent to Infosys",
      "Meeting scheduled with TCS",
      "Payment received from Wipro"
    ],

    conversionFunnel: [
      {
        stage: "Visitors",
        count: 5000
      },
      {
        stage: "Leads",
        count: 1200
      },
      {
        stage: "Qualified",
        count: 700
      },
      {
        stage: "Proposal",
        count: 300
      },
      {
        stage: "Customers",
        count: 120
      }
    ]
  });
};

const getAllLeads = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*, e.name AS assignee_name, e.name AS employee_name, e.name AS assigned_employee, e.initials AS assignee_initials
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE l.is_deleted = 0
       ORDER BY l.id DESC`
    );

    const leads = result.rows.map((row) => ({
      ...row,
      assignedTo: row.assignee_name && row.assigned_to
        ? { id: row.assigned_to, name: row.assignee_name, initials: row.assignee_initials }
        : (row.assignee_name ? { id: row.assigned_to || `emp-${row.assignee_name}`, name: row.assignee_name } : null),
      assigneeName: row.assignee_name || "Unassigned",
      assignee_name: row.assignee_name || "Unassigned",
      employeeName: row.assignee_name || "Unassigned",
      assigned_employee: row.assignee_name || "Unassigned",
      owner: row.assignee_name || "Unassigned",
      assignee: row.assignee_name || "Unassigned",
    }));

    res.json({
      success: true,
      leads,
    });
  } catch (error) {
    console.error("Error fetching leads:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch leads",
      error: error.message,
    });
  }
};

const getLeadDetails = (req, res) => {
  const { id } = req.params;

  res.json({
    id,

    company: "Infosys",

    contact: "Rohit Sharma",

    email: "rohit@infosys.com",

    phone: "+91 9876543210",

    revenue: "₹1.2L",

    stage: "Qualified",

    priority: "High",

    assignee: "Priya",

    followUp: "Tomorrow 4 PM",

    notes:
      "Client interested in enterprise POSH training package. Waiting for final approval.",

    timeline: [
      "Lead Created",
      "Discovery Call Completed",
      "Proposal Shared",
      "Follow-up Pending"
    ],

    aiSuggestions: [
      "Send enterprise case study",
      "Schedule technical demo",
      "Follow up within 48 hours"
    ]
  });
};

const createLead = async (req, res) => {
  try {
    const {
      lead_name, phone, email, city, company_name, source,
      keyword, ad_content, campaign_notes, win_probability,
      purchased, expected_close_date, interactions,
      next_followup_date, mom, call_summary, notes,
      temperature, pipeline_stage, status, expected_revenue,
    } = req.body;

    if (!lead_name || lead_name.trim() === "" || lead_name === "undefined") {
      return res.status(400).json({
        success: false,
        message: "lead_name is required and cannot be empty",
      });
    }

    const result = await pool.query(
      `INSERT INTO leads (
        lead_name, phone, email, city, company_name, source,
        keyword, ad_content, campaign_notes, win_probability,
        purchased, expected_close_date, interactions,
        next_followup_date, mom, call_summary, notes,
        temperature, pipeline_stage, status, expected_revenue
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
      ) RETURNING *`,
      [
        lead_name, phone, email || null, city || null, company_name || null,
        source || null, keyword || null, ad_content || null, campaign_notes || null,
        win_probability || 50, purchased || null,
        expected_close_date || null, interactions || 0,
        next_followup_date || null, mom || null, call_summary || null,
        notes || null, temperature || "Cold Lead",
        pipeline_stage || "New Lead", status || "New Lead",
        expected_revenue || 0,
      ]
    );

    const lead = result.rows[0];

    const serviceName = req.body.service || req.body.service_name || req.body.requirements || req.body.notes;
    if (serviceName) {
      dataService.ensureServiceExists("default", serviceName).catch((e) => console.error("[salesController] ensureServiceExists error:", e));
    }

    await logActivity({
      action: `New lead added: ${lead.company_name || lead.lead_name}`,
      entity: "lead",
      entity_id: lead.id,
    });

    await createNotification({
      title: `New lead added`,
      message: `${lead.lead_name} from ${lead.company_name || "unknown company"} was added to ${lead.pipeline_stage || "pipeline"}`,
      type: "lead",
    });

    return res.status(201).json({ success: true, lead });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({ success: false, message: "Lead already exists" });
    }
    console.error("Error creating lead:", error);
    res.status(500).json({ success: false, message: "Failed to create lead", error: error.message });
  }
};
const updateLead = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      lead_name, phone, email, city, company_name, source,
      keyword, ad_content, campaign_notes, win_probability,
      purchased, expected_close_date, interactions,
      next_followup_date, mom, call_summary, notes,
      temperature, pipeline_stage, status, expected_revenue,
    } = req.body;

    const result = await pool.query(
      `UPDATE leads SET
        lead_name=$1, phone=$2, email=$3, city=$4, company_name=$5,
        source=$6, keyword=$7, ad_content=$8, campaign_notes=$9,
        win_probability=$10, purchased=$11, expected_close_date=$12,
        interactions=$13, next_followup_date=$14, mom=$15,
        call_summary=$16, notes=$17, temperature=$18,
        pipeline_stage=$19, status=$20, expected_revenue=$21,
        updated_at=NOW()
      WHERE id=$22 RETURNING *`,
      [
        lead_name, phone, email || null, city || null, company_name || null,
        source || null, keyword || null, ad_content || null, campaign_notes || null,
        win_probability || 50, purchased || null, expected_close_date || null,
        interactions || 0, next_followup_date || null, mom || null,
        call_summary || null, notes || null, temperature || "Cold Lead",
        pipeline_stage || "New Lead", status || "New Lead",
        expected_revenue || 0, id,
      ]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: "Lead not found" });

    const lead = result.rows[0];

    await logActivity({
      action: `Updated lead: ${lead.company_name || lead.lead_name}`,
      entity: "lead",
      entity_id: lead.id,
    });

    await createNotification({
      title: `Lead updated`,
      message: `${lead.lead_name} (${lead.company_name || "no company"}) is now in ${lead.pipeline_stage || lead.status} stage`,
      type: "lead",
    });

    res.json({ success: true, lead });

  } catch (error) {
    console.error("Error updating lead:", error);
    res.status(500).json({ success: false, message: "Failed to update lead", error: error.message });
  }
};

const deleteLead = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || id === "undefined") {
      return res.status(400).json({ success: false, message: "Invalid lead ID" });
    }

    // fetch name BEFORE deleting so we can use it in logs
    const findResult = await pool.query(
      "SELECT lead_name, company_name FROM leads WHERE id=$1",
      [parseInt(id)]
    );

    if (findResult.rows.length === 0)
      return res.status(404).json({ success: false, message: "Lead not found" });

    const leadName = findResult.rows[0].company_name || findResult.rows[0].lead_name;

    await pool.query("DELETE FROM leads WHERE id=$1", [parseInt(id)]);

    await logActivity({
      action: `Deleted lead: ${leadName}`,
      entity: "lead",
      entity_id: parseInt(id),
    });

    await createNotification({
      title: `Lead removed`,
      message: `${leadName} was removed from the pipeline`,
      type: "lead",
    });

    res.json({ success: true, message: "Lead deleted successfully" });

  } catch (error) {
    console.error("Error deleting lead:", error);
    res.status(500).json({ success: false, message: "Failed to delete lead", error: error.message });
  }
};
const createEmpLead = async (req, res) => {

  try {

    const {

      lead_id,

      form_id,

      form_name,

      lead_name,

      email,

      phone,

      city,

      business_name,

      source,
      platform,

      employee_id,

      employee_name,

      round_robin_code,

      sheet_name,

      status,

      pipeline_stage,

      temperature,

      submitted_time,

      form_data

    } = req.body;



    const result = await pool.query(

      `INSERT INTO emp_leads (

        lead_id,

        form_id,

        form_name,

        lead_name,

        email,

        phone,

        city,

        business_name,

        source,
 platform,
        employee_id,

        employee_name,

        round_robin_code,

        sheet_name,

        status,

        pipeline_stage,

        temperature,

        submitted_time,

        form_data

      )

    VALUES (
  $1,$2,$3,$4,$5,$6,$7,$8,$9,
  $10,$11,$12,$13,$14,$15,$16,$17,$18,$19
)

      RETURNING *`,

      [

        lead_id,

        form_id,

        form_name,

        lead_name,

        email,

        phone,

        city,

        business_name,

        source,
        platform,
        employee_id,

        employee_name,

        round_robin_code,

        sheet_name,

        status,

        pipeline_stage,

        temperature,

        submitted_time,

        form_data

      ]

    );



    res.status(201).json({

      success: true,

      data: result.rows[0]

    });



  } catch (err) {

    console.error(err);

    res.status(500).json({

      success: false,

      message: err.message

    });

  }

};
const syncLeadStatus = async (req, res) => {
  try {
     console.log("HEADERS:", req.headers);
    console.log("BODY:", req.body);
    const { phone, status } = req.body;

    if (!phone || !status) {
      return res.status(400).json({
        success: false,
        message: "Phone and status are required"
      });
    }

    // Check if lead exists
    const leadCheck = await pool.query(
      `
      SELECT
        lead_id,
        lead_name,
        phone,
        status
      FROM emp_leads
      WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10)
            =
            RIGHT(REGEXP_REPLACE($1, '[^0-9]', '', 'g'), 10)
      `,
      [phone]
    );

    console.log("PHONE RECEIVED:", phone);
    console.log("MATCHES FOUND:", leadCheck.rowCount);
    console.log("LEAD:", leadCheck.rows);

    if (leadCheck.rowCount === 0) {
      return res.status(404).json({
        success: false,
        message: "No matching lead found",
        phone
      });
    }

    // Update status
   const result = await pool.query(
  `
  UPDATE emp_leads
  SET status = $1, updated_at = NOW()
  WHERE RIGHT(REGEXP_REPLACE(phone, '[^0-9]', '', 'g'), 10)
        =
        RIGHT(REGEXP_REPLACE($2, '[^0-9]', '', 'g'), 10)
  `,
  [status, phone]
);

    return res.status(200).json({
      success: true,
      updatedRows: result.rowCount,
      matchedLead: leadCheck.rows[0]
    });

  } catch (error) {
    console.error("Sync Lead Status Error:", error);

    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
};
const getEmpLeads = async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM emp_leads ORDER BY id DESC"
    );
    res.json({ success: true, leads: result.rows });
  } catch (error) {
    console.error("Error fetching emp_leads:", error);
    res.status(500).json({ success: false, message: "Failed to fetch emp_leads", error: error.message });
  }
};
const getEmpLeadStatusHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT * FROM emp_lead_status_history WHERE lead_id = $1 ORDER BY changed_at DESC`,
      [id]
    );
    res.json({ success: true, history: result.rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
};
const getEmpLeadsPipelineStats = async (req, res) => {
  try {
    const rangeKey = req.query.range || req.query.period || "month";
    const service = req.query.service || "All Services";
    const employee = req.query.employee || "All Employees";
    const data = await dataService.getPipelineStatusGrid(undefined, {
      rangeKey,
      period: rangeKey,
      service,
      employee,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
    });
    res.json(data);
  } catch (error) {
    console.error("pipeline-stats error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const getSalesFunnelKPIs = async (req, res) => {
  try {
    const { employee, service, period, range, startDate, endDate } = req.query;
    const data = await dataService.getSalesFunnelKPIs(undefined, {
      employee,
      service,
      period: period || range || "month",
      rangeKey: range || period,
      startDate,
      endDate,
    });
    res.json(data);
  } catch (error) {
    console.error("sales-kpis error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const getOppCategoryLeads = async (req, res) => {
  try {
    const { category, employee, service, period, range, startDate, endDate } = req.query;
    const data = await dataService.getOppCategoryLeads(undefined, {
      category,
      employee,
      service,
      period: period || range || "month",
      rangeKey: range || period,
      startDate,
      endDate,
    });
    res.json(data);
  } catch (error) {
    console.error("opp-leads error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};
const getSalesAiInsights = async (req, res) => {
  try {
    const { employee, service } = req.query;
    const data = await dataService.getSalesAiInsights(undefined, { employee, service });
    res.json(data);
  } catch (error) {
    console.error("sales-ai-insights error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getSalesDashboard,
  getAllLeads,
  getLeadDetails,
  createLead,
  syncLeadStatus,
  updateLead,   // ← add
  deleteLead,
  createEmpLead,
  getEmpLeads,
  getEmpLeadStatusHistory,
  getEmpLeadsPipelineStats,
  getSalesFunnelKPIs,
  getOppCategoryLeads,
  getSalesAiInsights,
};