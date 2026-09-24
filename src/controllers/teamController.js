const pool = require("../../config/db");
const { CALL_CONVERSATION_MIN_SEC } = require("../utils/callMetrics");
const {
  buildPeriodDateFilter,
  buildCustomDateFilter,
  buildPreviousPeriodDateFilter,
  rangeQueryToPeriod,
  comparisonLabelForPeriod,
} = require("../utils/periodFilter");
const { queryTeamServiceMetrics } = require("../utils/teamKpiMetrics");
const {
  mapCallStatsRow,
  CALL_STATS_AGG_SQL,
  callStatsAggSql,
  resolvePeriodFilter,
} = require("../utils/employeeCallStats");
const {
  logActivity,
  createNotification,
} = require("./activityController");
const {
  createUserForEmployee,
  deactivateUserForEmployee,
  resetEmployeePassword,
} = require("../services/userService");
const {
  computeLeadStats,
  buildLeadFunnel,
  buildCallyzerFunnel,
  buildStageBreakdown,
  CONTACTED_LEAD_SQL,
  ACTIVE_LEAD_SQL,
} = require("../utils/leadStats");
const { queryCallStats } = require("../utils/employeeCallStats");

function mapLeadRow(row) {
  return {
    id: row.id,
    lead_name: row.lead_name,
    business_name: row.business_name || row.company_name || "",
    email: row.email,
    phone: row.phone,
    city: row.city,
    form_name: row.form_name,
    temperature: row.temperature,
    expected_revenue: row.expected_revenue,
    revenue: row.expected_revenue,
    pipeline_stage: row.pipeline_stage,
    status: row.status,
    submitted_time: row.submitted_time || row.created_at,
    updated_at: row.updated_at,
    source: row.source,
    priority: row.priority,
    win_probability: row.win_probability,
    follow_up: row.follow_up || row.next_follow_up_at,
    assignment_status: row.assignment_status,
    accepted_at: row.accepted_at,
  };
}

const getTeamDashboard = (req, res) => {
  res.json({
    kpis: {
      totalEmployees: 48,
      activeEmployees: 42,
      onLeave: 3,
      remoteEmployees: 18,
      totalCalls: 1240,
      meetings: 186,
      convertedLeads: 84,
      revenue: "₹24.8L"
    },

    productivityTrend: [
      { month: "Jan", productivity: 68 },
      { month: "Feb", productivity: 72 },
      { month: "Mar", productivity: 76 },
      { month: "Apr", productivity: 81 },
      { month: "May", productivity: 86 }
    ],

    aiInsights: [
      "Sales team productivity increased by 12%",
      "3 employees exceeded monthly targets",
      "Support team response time improved by 18%"
    ],

    attendanceToday: {
      present: 42,
      absent: 3,
      leave: 3
    },

    workloadDistribution: [
      {
        department: "Sales",
        workload: 35
      },
      {
        department: "Support",
        workload: 25
      },
      {
        department: "Engineering",
        workload: 40
      }
    ]
  });
};

const getTeamPerformance = (req, res) => {
  res.json({
    topPerformers: [
      {
        id: 1,
        name: "Priya",
        revenue: "₹4.2L"
      },
      {
        id: 2,
        name: "Rahul",
        revenue: "₹3.8L"
      }
    ],

    monthlyTargets: [
      {
        employee: "Priya",
        target: "₹5L",
        achieved: "₹4.2L"
      },
      {
        employee: "Rahul",
        target: "₹4L",
        achieved: "₹3.8L"
      }
    ],

    recentClosedDeals: [
      {
        company: "Infosys",
        value: "₹2.4L"
      },
      {
        company: "TCS",
        value: "₹1.8L"
      }
    ],

    pipelineSnapshot: [
      {
        stage: "New",
        count: 120
      },
      {
        stage: "Qualified",
        count: 80
      },
      {
        stage: "Proposal",
        count: 42
      }
    ]
  });
};

const getEmployees = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*,
        m.name AS manager_name,
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = e.id AND l.is_deleted = 0) AS leads,
        (SELECT COUNT(*) FROM leads l WHERE l.assigned_to = e.id AND l.is_deleted = 0) AS total_leads,
        COALESCE((
          SELECT COUNT(*) FROM employee_calls ec WHERE ec.employee_id = e.id
        ), 0) AS total_calls,
        COALESCE((
          SELECT COUNT(*) FROM employee_calls ec 
          WHERE ec.employee_id = e.id AND (ec.duration_sec > 0 OR LOWER(COALESCE(ec.outcome, '')) IN ('connected', 'picked_up', 'answered'))
        ), 0) AS pickup_calls,
        COALESCE((
          SELECT COUNT(*) FROM meetings m WHERE m.employee_id = e.id
        ), 0) + (
          SELECT COUNT(*) FROM leads l 
          WHERE l.assigned_to = e.id AND l.is_deleted = 0 
          AND (LOWER(COALESCE(l.pipeline_stage, '')) IN ('meeting booked', 'meeting done', 'booked') OR LOWER(COALESCE(l.status, '')) IN ('meeting booked', 'meeting done', 'booked'))
        ) AS meetings_booked,
        (
          SELECT COUNT(*) FROM leads l 
          WHERE l.assigned_to = e.id AND l.is_deleted = 0 
          AND (LOWER(COALESCE(l.pipeline_stage, '')) LIKE '%proposal%' OR LOWER(COALESCE(l.status, '')) LIKE '%proposal%')
        ) AS proposals_sent,
        COALESCE((
          SELECT SUM(cc.amount) FROM cash_collections cc WHERE cc.employee_id = e.id
        ), 0) + COALESCE((
          SELECT SUM(l.expected_revenue) FROM leads l 
          WHERE l.assigned_to = e.id AND l.is_deleted = 0 
          AND (LOWER(COALESCE(l.pipeline_stage, '')) IN ('converted', 'won', 'closed won', 'payment complete') OR LOWER(COALESCE(l.status, '')) IN ('converted', 'won', 'payment complete', 'advance received', 'paid'))
        ), 0) AS cash_collected,
        (SELECT COUNT(*) FROM leads l
          WHERE l.assigned_to = e.id AND l.is_deleted = 0
            AND (
              LOWER(COALESCE(l.pipeline_stage, '')) IN ('converted', 'won', 'closed won')
              OR LOWER(COALESCE(l.status, '')) IN ('converted', 'won')
            )) AS conv,
        (SELECT COUNT(*) FROM leads l
          WHERE l.assigned_to = e.id AND l.is_deleted = 0
            AND ${CONTACTED_LEAD_SQL.replace(/\n\s*/g, " ")}) AS contacted,
        (SELECT COALESCE(SUM(l.expected_revenue), 0) FROM leads l
          WHERE l.assigned_to = e.id AND l.is_deleted = 0
            AND (
              LOWER(COALESCE(l.pipeline_stage, '')) IN ('converted', 'won', 'closed won')
              OR LOWER(COALESCE(l.status, '')) IN ('converted', 'won')
            )) AS revenue,
        (SELECT COUNT(*) FROM leads l
          WHERE l.assigned_to = e.id AND l.is_deleted = 0
            AND ${ACTIVE_LEAD_SQL.replace(/\n\s*/g, " ")}) AS active_leads
       FROM employees e
       LEFT JOIN employees m ON m.id = e.manager_id
       WHERE LOWER(COALESCE(e.status, 'active')) <> 'inactive'
       ORDER BY e.name ASC`,
    );
    res.json({
      success: true,
      employees: result.rows,
    });
  } catch (error) {
    console.error("Error fetching employees:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch employees",
      error: error.message,
    });
  }
};

const createEmployee = async (req, res) => {
  try {
    const {
      name, email, phone, city, department, role,
      status, work_location, access_level, notes,
      joining_date, callyser_id, emp_id,
      salary,
      incentive_kra,
      call_target, call_weightage,
      qualified_lead_target, qualified_lead_weightage,
      meeting_target, meeting_weightage,
      cash_target, cash_weightage,
    } = req.body;

    if (!email?.trim()) {
      return res.status(400).json({
        success: false,
        message: "Email is required — employees use it to log in",
      });
    }

    const result = await pool.query(
      `INSERT INTO employees (
        name, email, phone, city, department, role,
        status, work_location, access_level, notes,
        joining_date, callyser_id, emp_id,
        salary,
        incentive_kra,
        call_target, call_weightage,
        qualified_lead_target, qualified_lead_weightage,
        meeting_target, meeting_weightage,
        cash_target, cash_weightage
      ) VALUES (
        $1,$2,$3,$4,$5,$6,
        $7,$8,$9,$10,
        $11,$12,$13,
        $14,
        $15,
        $16,$17,
        $18,$19,
        $20,$21,
        $22,$23
      ) RETURNING *`,
      [
        name, email.trim(), phone || null, city || null,
        department || null, role || null,
        status || "active", work_location || "Office",
        access_level || "Member", notes || null,
        joining_date || null, callyser_id || null, emp_id || null,
        salary != null ? salary : null,
        incentive_kra || false,
        call_target || 0, call_weightage || 0,
        qualified_lead_target || 0, qualified_lead_weightage || 0,
        meeting_target || 0, meeting_weightage || 0,
        cash_target || 0, cash_weightage || 0,
      ]
    );

    const employee = result.rows[0];

    let credentials;
    try {
      credentials = await createUserForEmployee(employee, { empId: emp_id });
    } catch (authErr) {
      await pool.query(`DELETE FROM employees WHERE id = $1`, [employee.id]);
      return res.status(authErr.statusCode || 500).json({
        success: false,
        message: authErr.message || "Failed to create login account",
      });
    }

    await logActivity({
      action: `Added new employee: ${employee.name}`,
      entity: "employee",
      entity_id: employee.id,
    });

   await createNotification({
  title: `${employee.name} joined the team`,
  message: `${employee.name} was added as ${employee.role || "team member"} in ${employee.department || "the company"}`,
  type: "employee",
});

    res.status(201).json({
      success: true,
      employee,
      credentials: {
        loginId: credentials.loginId,
        email: credentials.email,
        password: credentials.tempPassword,
      },
    });

  } catch (error) {
    console.error("Error creating employee:", error);
    res.status(500).json({ success: false, message: "Failed to create employee", error: error.message });
  }
};

const getEmployeeDetails = async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT e.*, m.name AS manager_name
       FROM employees e
       LEFT JOIN employees m ON m.id = e.manager_id
       WHERE e.id = $1`,
      [id],
    );

    if (!result.rows.length) {
      return res.status(404).json({ success: false, message: "Employee not found" });
    }

    const employee = result.rows[0];
    const leadResult = await pool.query(
      `SELECT id, lead_name, company_name, email, phone, city, form_name, temperature,
              expected_revenue, pipeline_stage, status, created_at, updated_at, source,
              priority, win_probability, next_follow_up_at, assignment_status, accepted_at
       FROM leads
       WHERE assigned_to = $1 AND is_deleted = 0
       ORDER BY updated_at DESC`,
      [id],
    );

    const leads = leadResult.rows.map(mapLeadRow);
    const stats = computeLeadStats(leads);
    const totalLeads = stats.totalLeads || 0;
    const conversionRate = totalLeads ? Number(((stats.converted / totalLeads) * 100).toFixed(1)) : 0;
    const qualificationRate = totalLeads
      ? Math.round((stats.pipelineQualified / totalLeads) * 100)
      : 0;
    const pickupRate = totalLeads ? Math.round((stats.contacted / totalLeads) * 100) : 0;
    const followUpQuality = totalLeads
      ? Math.max(0, Math.min(99, Math.round(100 - (stats.followUps / totalLeads) * 100)))
      : 0;

    const cashResult = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total
       FROM cash_collections
       WHERE tenant_id = 'default' AND employee_id = $1`,
      [id],
    );
    const cashTotal = Number(cashResult.rows[0]?.total) || 0;

    const callsResult = await pool.query(
      `SELECT
         COUNT(*) AS total_calls,
         SUM(CASE WHEN duration_sec >= ${CALL_CONVERSATION_MIN_SEC} THEN 1 ELSE 0 END) AS conversations_5min_plus,
         SUM(CASE WHEN duration_sec > 0 THEN 1 ELSE 0 END) AS connected_calls
       FROM employee_calls
       WHERE tenant_id = 'default' AND employee_id = $1`,
      [id],
    );
    const callsRow = callsResult.rows[0] || {};
    const conversations5Min = Number(callsRow.conversations_5min_plus) || 0;
    const totalCalls = Number(callsRow.total_calls) || 0;
    const connectedCalls = Number(callsRow.connected_calls) || 0;
    const callPickupRate = totalCalls > 0
      ? Math.min(100, Math.round((connectedCalls / totalCalls) * 100))
      : 0;

    const cashRecordsResult = await pool.query(
      `SELECT cc.*, l.lead_name, l.company_name
       FROM cash_collections cc
       LEFT JOIN leads l ON l.id = cc.lead_id
       WHERE cc.employee_id = $1
       ORDER BY cc.payment_at DESC, cc.id DESC
       LIMIT 100`,
      [id],
    );

    res.json({
      success: true,
      employee: {
        ...employee,
        manager_name: employee.manager_name || null,
        stats,
        cashCollections: cashRecordsResult.rows.map((row) => ({
          id: row.id,
          leadId: row.lead_id,
          leadName: row.lead_name,
          companyName: row.company_name,
          amount: Number(row.amount) || 0,
          paymentMode: row.payment_mode,
          paymentAt: row.payment_at,
          transactionId: row.transaction_id,
          slipUrl: row.slip_url,
          slipFilename: row.slip_filename,
          notes: row.notes,
          recordedBy: row.recorded_by,
          createdAt: row.created_at,
        })),
        achieved: {
          calls: conversations5Min,
          totalCalls,
          qualifiedLeads: stats.pipelineQualified,
          meetings: stats.booked,
          cash: cashTotal,
        },
        performance: {
          responseTimeMin: 1.8,
          pickupRate: callPickupRate,
          qualificationRate,
          objectionHandling: Math.min(99, Math.round(qualificationRate * 0.95) || 0),
          conversionRate,
          followUpQuality: followUpQuality || pickupRate,
        },
        funnel: buildLeadFunnel(stats),
      },
    });
  } catch (error) {
    console.error("Error fetching employee details:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch employee details",
      error: error.message,
    });
  }
};

const getEmployeeLeads = async (req, res) => {
  try {
    const { employee_name, employee_id, period, month } = req.query;
    let empId = employee_id ? Number(employee_id) : null;
    let empName = employee_name ? String(employee_name).trim() : "";

    if (!empId && empName) {
      const empResult = await pool.query(
        `SELECT id, name FROM employees WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [empName],
      );
      if (empResult.rows.length) {
        empId = empResult.rows[0].id;
        empName = empResult.rows[0].name;
      }
    }

    if (!empId && !empName) {
      return res.json({ success: true, leads: [], stats: {}, activity: [], funnel: [] });
    }

    let leads = [];

    if (empId) {
      const result = await pool.query(
        `SELECT id, lead_name, company_name, email, phone, city, form_name, temperature,
                expected_revenue, pipeline_stage, status, created_at, updated_at, source,
                priority, win_probability, next_follow_up_at, assignment_status, accepted_at
         FROM leads
         WHERE assigned_to = $1 AND is_deleted = 0
         ORDER BY updated_at DESC`,
        [empId],
      );
      leads = result.rows.map(mapLeadRow);
    }

    if (!leads.length && empName && !empId) {
      const legacy = await pool.query(
        `SELECT id, lead_name, business_name, email, phone, city, form_name, temperature,
                expected_revenue, pipeline_stage, status, submitted_time, updated_at,
                source, employee_name
         FROM emp_leads
         WHERE LOWER(employee_name) = LOWER($1)
            OR LOWER(employee_name) LIKE LOWER($2)
         ORDER BY updated_at DESC`,
        [empName, `${empName.split(" ")[0]}%`],
      );
      leads = legacy.rows.map(mapLeadRow);
    }

    const stats = computeLeadStats(leads);
    const activity = leads
      .filter((l) => l.updated_at && l.status)
      .slice(0, 10)
      .map((l) => ({
        lead_name: l.lead_name,
        status: l.status,
        time: l.updated_at,
        business: l.business_name || "",
      }));

    let funnel = buildLeadFunnel(stats);
    if (empId && (period || month)) {
      const callStats = await queryCallStats(pool, {
        tenantId: "default",
        employeeId: empId,
        period: String(period || "month").toLowerCase(),
        month: month || null,
      });
      funnel = buildCallyzerFunnel(stats, callStats);
    }

    const stageBreakdown = buildStageBreakdown(leads);

    res.json({
      success: true,
      leads,
      stats,
      activity,
      funnel,
      stageBreakdown,
    });
  } catch (error) {
    console.error("Error fetching employee leads:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch leads",
      error: error.message,
    });
  }
};
const updateEmployee = async (req, res) => {
  try {
    const {
      id, name, email, phone, city, department, role,
      status, work_location, access_level, notes,
      joining_date, callyser_id, emp_id,
      salary,
      incentive_kra,
      call_target, call_weightage,
      qualified_lead_target, qualified_lead_weightage,
      meeting_target, meeting_weightage,
      cash_target, cash_weightage,
    } = req.body;

    if (!id) {
      return res.status(400).json({ success: false, message: "Employee ID is required" });
    }

    const result = await pool.query(
      `UPDATE employees SET
        name=$1, email=$2, phone=$3, city=$4, department=$5, role=$6,
        status=$7, work_location=$8, access_level=$9, notes=$10,
        joining_date=$11, callyser_id=$12, emp_id=$13,
        salary=$14,
        incentive_kra=$15,
        call_target=$16, call_weightage=$17,
        qualified_lead_target=$18, qualified_lead_weightage=$19,
        meeting_target=$20, meeting_weightage=$21,
        cash_target=$22, cash_weightage=$23,
        updated_at=NOW()
      WHERE id=$24 RETURNING *`,
      [
        name, email || null, phone || null, city || null,
        department || null, role || null,
        status || "active", work_location || "Office",
        access_level || "Member", notes || null,
        joining_date || null, callyser_id || null, emp_id || null,
        salary != null ? salary : null,
        incentive_kra || false,
        call_target || 0, call_weightage || 0,
        qualified_lead_target || 0, qualified_lead_weightage || 0,
        meeting_target || 0, meeting_weightage || 0,
        cash_target || 0, cash_weightage || 0,
        id,
      ]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ success: false, message: "Employee not found" });

    const employee = result.rows[0];

    await logActivity({
      action: `Updated employee: ${employee.name}`,
      entity: "employee",
      entity_id: employee.id,
    });

   await createNotification({
  title: `${employee.name}'s profile updated`,
  message: `${employee.name} (${employee.role || "team member"}) details were modified`,
  type: "employee",
});

    res.json({ success: true, employee });

  } catch (error) {
    console.error("Error updating employee:", error);
    res.status(500).json({ success: false, message: "Failed to update employee", error: error.message });
  }
};

const deleteEmployee = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id || id === "undefined") {
      return res.status(400).json({ success: false, message: "Invalid employee ID" });
    }

    // fetch name BEFORE deleting so logs have the actual name
    const findResult = await pool.query(
      "SELECT name, role FROM employees WHERE id=$1",
      [parseInt(id)]
    );

    if (findResult.rows.length === 0)
      return res.status(404).json({ success: false, message: "Employee not found" });

    const employeeName = findResult.rows[0].name;
    const employeeRole = findResult.rows[0].role;

    await deactivateUserForEmployee(parseInt(id));

    await logActivity({
      action: `Removed employee from team: ${employeeName}`,
      entity: "employee",
      entity_id: parseInt(id),
    });

   await createNotification({
  title: `${employeeName} was removed`,
  message: `${employeeName} (${employeeRole || "team member"}) login disabled and marked inactive`,
  type: "employee",
});

    res.json({ success: true, message: "Employee removed from team (login disabled)" });

  } catch (error) {
    console.error("Error deleting employee:", error);
    res.status(500).json({ success: false, message: "Failed to delete employee", error: error.message });
  }
};

const resetEmployeeCredentials = async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || id === "undefined") {
      return res.status(400).json({ success: false, message: "Invalid employee ID" });
    }

    const { password, newPassword, loginId, mustChangePassword } = req.body || {};

    const credentials = await resetEmployeePassword(parseInt(id, 10), {
      password: password || newPassword,
      loginId,
      mustChangePassword,
    });

    return res.json({
      success: true,
      message: `Credentials updated successfully for ${credentials.loginId}`,
      credentials: {
        loginId: credentials.loginId,
        email: credentials.email,
        password: credentials.newPassword || credentials.tempPassword,
      },
    });
  } catch (error) {
    console.error("Reset password error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Failed to reset password",
    });
  }
};

const getTeamKPIs = async (req, res) => {
  try {
    const tenantId = "default";
    const { range, startDate, endDate } = req.query;
    const period = rangeQueryToPeriod(range);
    const callColumn = "COALESCE(started_at, created_at)";
    const leadColumn = "COALESCE(assigned_at, created_at)";

    let leadCurrentFilter;
    let leadPreviousFilter;

    if (period === "custom" && startDate && endDate) {
      leadCurrentFilter = buildCustomDateFilter({
        startDate,
        endDate,
        column: leadColumn,
        paramOffset: 2,
      });
      leadPreviousFilter = buildPreviousPeriodDateFilter({
        period: "custom",
        startDate,
        endDate,
        column: leadColumn,
        paramOffset: 2,
      });
    } else {
      leadCurrentFilter = buildPeriodDateFilter({
        period,
        column: leadColumn,
        paramOffset: 2,
      });
      leadPreviousFilter = buildPreviousPeriodDateFilter({
        period: leadCurrentFilter.period,
        column: leadColumn,
        paramOffset: 2,
      });
    }

    const callCurrentFilter = period === "custom" && startDate && endDate
      ? buildCustomDateFilter({ startDate, endDate, column: callColumn, paramOffset: 2 })
      : buildPeriodDateFilter({ period, column: callColumn, paramOffset: 2 });
    const callPreviousFilter = period === "custom" && startDate && endDate
      ? buildPreviousPeriodDateFilter({ period: "custom", startDate, endDate, column: callColumn, paramOffset: 2 })
      : buildPreviousPeriodDateFilter({ period: callCurrentFilter.period, column: callColumn, paramOffset: 2 });

    const [empResult, leadsResult, serviceMetrics] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_employees FROM employees WHERE tenant_id = $1`, [tenantId]),
      pool.query(
        `SELECT
          COUNT(*) AS total_leads,
          SUM(CASE WHEN LOWER(TRIM(COALESCE(pipeline_stage, status))) LIKE '%meeting%' THEN 1 ELSE 0 END) AS total_meetings,
          SUM(CASE WHEN LOWER(TRIM(COALESCE(pipeline_stage, status))) IN ('converted', 'closed won', 'won') THEN 1 ELSE 0 END) AS total_converted
         FROM leads
         WHERE tenant_id = $1 AND is_deleted = 0 AND ${leadCurrentFilter.clause}`,
        [tenantId, ...leadCurrentFilter.params],
      ),
      queryTeamServiceMetrics(
        pool,
        tenantId,
        callCurrentFilter,
        callPreviousFilter,
        leadCurrentFilter,
        leadPreviousFilter,
      ),
    ]);


    const empRow = empResult.rows[0];
    const leadsRow = leadsResult.rows[0];
    const { current, trends } = serviceMetrics;

    res.json({
      success: true,
      kpis: {
        totalEmployees: parseInt(empRow.total_employees, 10) || 0,
        totalMeetings: parseInt(leadsRow.total_meetings, 10) || 0,
        convertedLeads: parseInt(leadsRow.total_converted, 10) || 0,
        totalLeads: parseInt(leadsRow.total_leads, 10) || 0,
        ...current,
        trends,
        comparisonLabel: comparisonLabelForPeriod(period === "custom" ? "custom" : leadCurrentFilter.period),
        period: leadCurrentFilter.period,
        periodLabel: leadCurrentFilter.label,
      },
    });
  } catch (error) {
    console.error("Error fetching KPIs:", error);
    res.status(500).json({
      success: false,
      message: "Failed to fetch KPIs",
      error: error.message,
    });
  }
};

function buildLegacyEmpLeadsDateFilter(range, startDate, endDate) {
  if (range === "Today") {
    return "AND DATE(submitted_time) = CURDATE()";
  }
  if (range === "This Week") {
    return `AND submitted_time >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
            AND submitted_time < DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY)`;
  }
  if (range === "Custom" && startDate && endDate) {
    return "AND DATE(submitted_time) >= $1 AND DATE(submitted_time) <= $2";
  }
  return `AND submitted_time >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND submitted_time < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)`;
}

function buildLegacyEmpLeadsParams(range, startDate, endDate) {
  if (range === "Custom" && startDate && endDate) {
    return [startDate, endDate];
  }
  return [];
}

const getChartData = async (req, res) => {
  try {
    const { range, startDate, endDate } = req.query;

    let query = "";
    let labels = [];

    if (range === "Today") {
      query = `
        SELECT 
          HOUR(submitted_time) AS period,
          COUNT(*) AS total_leads,
          SUM(CASE WHEN LOWER(TRIM(status)) IN ('warm lead','hot lead','contacted') THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN LOWER(TRIM(status)) LIKE '%meeting%' THEN 1 ELSE 0 END) AS meetings,
          SUM(CASE WHEN LOWER(TRIM(status)) = 'converted' THEN 1 ELSE 0 END) AS converted
        FROM emp_leads
        WHERE DATE(submitted_time) = CURDATE()
        GROUP BY period ORDER BY period
      `;
      labels = Array.from({ length: 13 }, (_, i) => {
        const h = i + 8;
        return {
          key: h,
          label: h < 12 ? `${h}am` : h === 12 ? "12pm" : `${h - 12}pm`,
        };
      });

    } else if (range === "This Week") {
      query = `
        SELECT 
          (DAYOFWEEK(submitted_time) - 1) AS period,
          COUNT(*) AS total_leads,
          SUM(CASE WHEN LOWER(TRIM(status)) IN ('warm lead','hot lead','contacted') THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN LOWER(TRIM(status)) LIKE '%meeting%' THEN 1 ELSE 0 END) AS meetings,
          SUM(CASE WHEN LOWER(TRIM(status)) = 'converted' THEN 1 ELSE 0 END) AS converted
        FROM emp_leads
        WHERE submitted_time >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)
          AND submitted_time < DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY)
        GROUP BY period ORDER BY period
      `;
      labels = [
        { key: 1, label: "Mon" },
        { key: 2, label: "Tue" },
        { key: 3, label: "Wed" },
        { key: 4, label: "Thu" },
        { key: 5, label: "Fri" },
        { key: 6, label: "Sat" },
        { key: 0, label: "Sun" },
      ];

    } else if (range === "Custom" && startDate && endDate) {
      query = `
        SELECT 
          DATE(submitted_time) AS period,
          COUNT(*) AS total_leads,
          SUM(CASE WHEN LOWER(TRIM(status)) IN ('warm lead','hot lead','contacted') THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN LOWER(TRIM(status)) LIKE '%meeting%' THEN 1 ELSE 0 END) AS meetings,
          SUM(CASE WHEN LOWER(TRIM(status)) = 'converted' THEN 1 ELSE 0 END) AS converted
        FROM emp_leads
        WHERE DATE(submitted_time) >= $1
          AND DATE(submitted_time) <= $2
        GROUP BY period ORDER BY period
      `;

      // Build all dates in range
      const start = new Date(startDate);
      const end   = new Date(endDate);
      const dates = [];
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const copy = new Date(d);
        dates.push({
          key: copy.toISOString().split("T")[0],
          label: copy.toLocaleDateString("en-IN", { day: "numeric", month: "short" }),
        });
      }
      labels = dates;

      const result = await pool.query(query, [startDate, endDate]);
      const dataMap = {};
      result.rows.forEach(r => {
        const key = new Date(r.period).toISOString().split("T")[0];
        dataMap[key] = {
          total_leads: parseInt(r.total_leads) || 0,
          qualified:   parseInt(r.qualified)   || 0,
          meetings:    parseInt(r.meetings)     || 0,
          converted:   parseInt(r.converted)   || 0,
        };
      });

      const chartData = labels.map(({ key, label }) => {
        const d = dataMap[key] || {};
        return {
          t:          label,
          totalLeads: d.total_leads || 0,
          qualified:  d.qualified   || 0,
          meetings:   d.meetings    || 0,
          converted:  d.converted   || 0,
        };
      });

      const hasData = chartData.some(d => d.totalLeads > 0);
      return res.json({ success: true, chartData, hasData });

    } else {
      // This Month — group by day
      query = `
        SELECT 
          DAY(submitted_time) AS period,
          COUNT(*) AS total_leads,
          SUM(CASE WHEN LOWER(TRIM(status)) IN ('warm lead','hot lead','contacted') THEN 1 ELSE 0 END) AS qualified,
          SUM(CASE WHEN LOWER(TRIM(status)) LIKE '%meeting%' THEN 1 ELSE 0 END) AS meetings,
          SUM(CASE WHEN LOWER(TRIM(status)) = 'converted' THEN 1 ELSE 0 END) AS converted
        FROM emp_leads
        WHERE submitted_time >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
          AND submitted_time < DATE_ADD(DATE_FORMAT(CURDATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
        GROUP BY period ORDER BY period
      `;
      const now = new Date();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      labels = Array.from({ length: daysInMonth }, (_, i) => ({
        key:   i + 1,
        label: `${i + 1}`,
      }));
    }

    // For Today, This Week, This Month
    const result = await pool.query(query);
    const dataMap = {};
    result.rows.forEach(r => {
      dataMap[parseInt(r.period)] = {
        total_leads: parseInt(r.total_leads) || 0,
        qualified:   parseInt(r.qualified)   || 0,
        meetings:    parseInt(r.meetings)    || 0,
        converted:   parseInt(r.converted)  || 0,
      };
    });

    const chartData = labels.map(({ key, label }) => {
      const d = dataMap[key] || {};
      return {
        t:          label,
        totalLeads: d.total_leads || 0,
        qualified:  d.qualified   || 0,
        meetings:   d.meetings    || 0,
        converted:  d.converted   || 0,
      };
    });

    const hasData = chartData.some(d => d.totalLeads > 0);
    res.json({ success: true, chartData, hasData });

  } catch (error) {
    console.error("Chart data error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const getEmployeeCallyzerStats = async (req, res) => {
  try {
    const { id } = req.params;
    const month = req.query.month;
    const period = String(req.query.period || "month").toLowerCase();

    const periodFilter = buildPeriodDateFilter({
      period: month ? "month" : period,
      month,
      column: "COALESCE(started_at, created_at)",
      paramOffset: 3,
    });

    const params = ["default", id, ...periodFilter.params];

    const [statsResult, empResult] = await Promise.all([
      pool.query(
        `SELECT ${CALL_STATS_AGG_SQL}
         FROM employee_calls
         WHERE tenant_id = $1 AND employee_id = $2 AND ${periodFilter.clause}`,
        params,
      ),
      pool.query(
        `SELECT id, name, callyser_id, emp_id FROM employees WHERE id = $1 AND tenant_id = 'default' LIMIT 1`,
        [id],
      ),
    ]);

    const employee = empResult.rows[0];
    const stats = mapCallStatsRow(statsResult.rows[0] || {});
    if (employee?.name) stats.empName = employee.name;

    res.json({
      success: true,
      configured: true,
      employeeId: Number(id),
      employeeName: employee?.name || null,
      stats,
      period: periodFilter.period || period,
      label: periodFilter.label,
    });
  } catch (error) {
    console.error("Employee Callyzer stats error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const COMPETENCY_DIMENSIONS = [
  "Product Value Alignment",
  "Call Control",
  "Listening Skills",
  "KYC Questioning",
  "Objection Handling",
];

/** Average the per-call AI competency scores (radar chart on the incentive page). */
const getEmployeeCompetencyScores = async (req, res) => {
  try {
    const { id } = req.params;
    const month = req.query.month;
    const period = String(req.query.period || "month").toLowerCase();

    const periodFilter = buildPeriodDateFilter({
      period: month ? "month" : period,
      month,
      column: "COALESCE(started_at, created_at)",
      paramOffset: 3,
    });

    const params = ["default", id, ...periodFilter.params];
    const result = await pool.query(
      `SELECT competency_scores FROM employee_calls
       WHERE tenant_id = $1 AND employee_id = $2 AND ${periodFilter.clause}
         AND competency_scores IS NOT NULL AND competency_scores <> '{}'`,
      params,
    );

    const sums = Object.fromEntries(COMPETENCY_DIMENSIONS.map((d) => [d, 0]));
    const counts = Object.fromEntries(COMPETENCY_DIMENSIONS.map((d) => [d, 0]));
    let callsScored = 0;

    for (const row of result.rows) {
      let scores = row.competency_scores;
      if (typeof scores === "string") {
        try { scores = JSON.parse(scores); } catch { scores = {}; }
      }
      if (!scores || typeof scores !== "object") continue;
      let hadAny = false;
      for (const dim of COMPETENCY_DIMENSIONS) {
        const val = Number(scores[dim]);
        if (Number.isFinite(val) && val > 0) {
          sums[dim] += val;
          counts[dim] += 1;
          hadAny = true;
        }
      }
      if (hadAny) callsScored += 1;
    }

    const competency = Object.fromEntries(
      COMPETENCY_DIMENSIONS.map((d) => [d, counts[d] ? Math.round(sums[d] / counts[d]) : 0]),
    );

    res.json({
      success: true,
      employeeId: Number(id),
      competency,
      callsScored,
      period: periodFilter.period || period,
      label: periodFilter.label,
    });
  } catch (error) {
    console.error("Employee competency scores error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

const getTeamCallyzerStatsByEmployee = async (req, res) => {
  try {
    const month = req.query.month;
    const period = String(req.query.period || "today").toLowerCase();
    const periodFilter = resolvePeriodFilter(month ? "month" : period, month, 2);
    const params = ["default", ...periodFilter.params];

    const result = await pool.query(
      `SELECT
         ec.employee_id,
         e.name AS employee_name,
         e.callyser_id,
         e.emp_id AS emp_code,
         ${callStatsAggSql("ec")}
       FROM employee_calls ec
       INNER JOIN employees e ON e.id = ec.employee_id AND e.tenant_id = ec.tenant_id
       WHERE ec.tenant_id = $1 AND e.status = 'active' AND ${periodFilter.clause}
       GROUP BY ec.employee_id, e.name, e.callyser_id, e.emp_id
       ORDER BY total_calls DESC, e.name ASC`,
      params,
    );

    const stats = result.rows.map((row) => ({
      employeeId: row.employee_id,
      empName: row.employee_name,
      empCode: row.emp_code,
      empNumber: row.callyser_id,
      ...mapCallStatsRow(row),
    }));

    res.json({
      success: true,
      configured: true,
      period: periodFilter.period || period,
      label: periodFilter.label,
      stats,
    });
  } catch (error) {
    console.error("Team Callyzer stats error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

module.exports = {
  getTeamDashboard,
  getTeamPerformance,
  getEmployees,
  getEmployeeDetails,
  getEmployeeLeads,
  getEmployeeCallyzerStats,
  getEmployeeCompetencyScores,
  getTeamCallyzerStatsByEmployee,
  createEmployee,
  updateEmployee,
  deleteEmployee,
  resetEmployeeCredentials,
  getTeamKPIs,
  getChartData,
};