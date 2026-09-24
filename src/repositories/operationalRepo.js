const pool = require("../../config/db");
const { buildPeriodDateFilter } = require("../utils/periodFilter");
const { toLocalSqlString } = require("../utils/appTimezone");

const DEFAULT_TENANT_ID = "default";
const DEFAULT_CALL_LIST_LIMIT = Number(process.env.EMPLOYEE_CALLS_MAX || 10000);

function withId(row, mapper) {
  if (!row) return null;
  const mapped = mapper ? mapper(row) : row;
  const id = mapped.id ?? row.id;
  return { ...mapped, id, _id: id };
}

function mapLead(row, assignedEmployee) {
  if (!row) return null;
  const emp = assignedEmployee || joinEmployee(row);
  const empName = emp?.name || emp?.emp_name || row.assignee_name || row.employee_name || row.assigned_employee || "";
  const lead = {
    id: row.id,
    tenantId: row.tenant_id,
    leadName: row.lead_name,
    companyName: row.company_name,
    phone: row.phone,
    email: row.email,
    city: row.city,
    country: row.country,
    source: row.source,
    sourceMeta: typeof row.source_meta === "string" ? (() => { try { return JSON.parse(row.source_meta || "{}"); } catch { return {}; } })() : (row.source_meta || {}),
    formName: row.form_name,
    pipelineStage: row.pipeline_stage,
    stageIsManual: Boolean(row.stage_is_manual),
    temperature: row.temperature,
    status: row.status,
    winProbability: Number(row.win_probability || 0),
    expectedRevenue: Number(row.expected_revenue || 0),
    currency: row.currency,
    priority: row.priority,
    assignmentStatus: row.assignment_status,
    assignedTo: emp ? {
      id: emp.id ?? emp.emp_id,
      _id: emp.id ?? emp.emp_id,
      name: emp.name ?? emp.emp_name,
      email: emp.email ?? emp.emp_email,
      role: emp.role ?? emp.emp_role,
      department: emp.department ?? emp.emp_department,
    } : (empName ? { id: row.assigned_to || `emp-${empName}`, name: empName } : row.assigned_to),
    assignedAt: row.assigned_at,
    assignedBy: row.assigned_by,
    assignmentMethod: row.assignment_method,
    acceptedAt: row.accepted_at,
    qualification: row.qualification || {},
    budget: row.budget || {},
    requirements: row.requirements,
    insights: row.insights,
    tags: row.tags || [],
    lastActivityAt: row.last_activity_at,
    nextFollowUpAt: row.next_follow_up_at,
    convertedAt: row.converted_at,
    lostAt: row.lost_at,
    isDeleted: row.is_deleted,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    assigneeName: empName || "Unassigned",
    employeeName: empName || "Unassigned",
    assigned_employee: empName || "Unassigned",
    owner: empName || "Unassigned",
    assignee: empName || "Unassigned",
  };
  return withId(lead);
}

function mapEmployee(row) {
  if (!row) return null;
  const normPhone = row.phone ? String(row.phone).replace(/\D/g, "").slice(-10) : null;
  return withId({
    id: row.id,
    employeeId: normPhone || String(row.id),
    tenantId: row.tenant_id,
    name: row.name,
    email: row.email,
    phone: normPhone || row.phone,
    role: row.role,
    department: row.department,
    status: row.status,
    avatarUrl: row.avatar_url,
    initials: row.initials,
    salary: row.salary != null ? Number(row.salary) : null,
    joiningDate: row.joining_date,
    managerId: row.manager_id,
    territory: row.territory,
    city: row.city,
    callyserId: row.callyser_id || null,
    empCode: row.emp_id || null,
    capacity: {
      maxActiveLeads: row.max_active_leads ?? 40,
      currentActiveLeads: row.current_active_leads ?? 0,
      receivingPaused: row.receiving_paused ?? false,
      dailyLimit: row.daily_limit ?? 25,
    },
    metrics: row.metrics || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapQueueItem(row, leadRow) {
  if (!row) return null;
  const item = withId({
    id: row.id,
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    status: row.status,
    priority: row.priority,
    queuedAt: row.queued_at,
    processedAt: row.processed_at,
    failureReason: row.failure_reason,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  if (leadRow) item.lead = mapLead(leadRow);
  return item;
}

function mapConfig(row) {
  if (!row) return null;
  const todayStats = row.today_stats || { total: 0, byEmployee: {} };
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    mode: row.mode,
    autoAssign: row.auto_assign,
    roundRobinOrder: row.round_robin_order || [],
    rrIndex: row.rr_index,
    pausedEmployees: row.paused_employees || [],
    workloadRules: row.workload_rules || {},
    todayKey: row.today_key,
    todayStats,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapTimeline(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    type: row.type,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorRole: row.actor_role,
    summary: row.summary,
    payload: row.payload || {},
    createdAt: row.created_at,
  });
}

function mapNotification(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    employeeId: row.employee_id,
    type: row.type,
    title: row.title,
    body: row.body,
    entityType: row.entity_type,
    entityId: row.entity_id,
    isRead: row.is_read,
    createdAt: row.created_at,
  });
}

function mapNote(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    authorId: row.author_id,
    authorType: row.author_type,
    body: row.body,
    isPinned: row.is_pinned,
    createdAt: row.created_at,
  });
}

function mapCall(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    employeeId: row.employee_id,
    callyzerCallId: row.callyzer_call_id || null,
    direction: row.direction,
    outcome: row.outcome,
    durationSec: row.duration_sec,
    startedAt: toLocalSqlString(row.started_at),
    endedAt: toLocalSqlString(row.ended_at),
    sopId: row.sop_id,
    checklistProgress: (() => {
      const raw = row.checklist_progress;
      if (!raw) return [];
      if (typeof raw === "string") {
        try { return JSON.parse(raw); } catch { return []; }
      }
      return raw;
    })(),
    recordingUrl: row.recording_url,
    transcript: row.transcript,
    notes: row.notes,
    aiSummary: row.ai_summary,
    createdAt: toLocalSqlString(row.created_at),
    clientName: row.client_name || null,
    clientPhone: row.client_phone || null,
    clientCompany: row.client_company || null,
  });
}

function mapFollowup(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    employeeId: row.employee_id,
    taskId: row.task_id,
    scheduledAt: toLocalSqlString(row.scheduled_at),
    note: row.note,
    status: row.status,
    completedAt: toLocalSqlString(row.completed_at),
    createdAt: toLocalSqlString(row.created_at),
  });
}

function mapMeeting(row) {
  if (!row) return null;
  const leadId = row.lead_id || null;
  const source = row.source || (leadId ? "lead" : "direct");
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    leadId,
    employeeId: row.employee_id,
    employeeName: row.employee_name || null,
    title: row.title,
    scheduledAt: toLocalSqlString(row.scheduled_at),
    durationMin: row.duration_min,
    meetLink: row.meet_link,
    location: row.location,
    status: row.status,
    source,
    leadName: row.lead_name || null,
    leadPhone: row.lead_phone || null,
    leadEmail: row.lead_email || null,
    leadCompany: row.lead_company || null,
    leadService: row.lead_service || null,
    mom: row.mom || {},
    createdAt: toLocalSqlString(row.created_at),
  });
}

function mapTask(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    assigneeId: row.assignee_id,
    leadId: row.lead_id,
    followUpId: row.follow_up_id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    dueAt: toLocalSqlString(row.due_at),
    status: row.status,
    sopChecklist: row.sop_checklist || [],
    completedAt: toLocalSqlString(row.completed_at),
    createdAt: toLocalSqlString(row.created_at),
    updatedAt: toLocalSqlString(row.updated_at),
  });
}

function mapHistory(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    fromEmployeeId: row.from_employee_id,
    toEmployeeId: row.to_employee_id,
    method: row.method,
    performedBy: row.performed_by,
    reason: row.reason,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  });
}

function mapAudit(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    actorId: row.actor_id,
    action: row.action,
    resource: row.resource,
    resourceId: row.resource_id,
    before: row.before_state,
    after: row.after_state,
    ip: row.ip,
    metadata: row.metadata || {},
    createdAt: row.created_at,
  });
}

function mapFileAsset(row) {
  if (!row) return null;
  return withId({
    id: row.id,
    tenantId: row.tenant_id,
    uploadedBy: row.uploaded_by,
    entityType: row.entity_type,
    entityId: row.entity_id,
    filename: row.filename,
    originalName: row.original_name,
    mime: row.mime,
    size: row.size,
    storageKey: row.storage_key,
    url: row.url,
    createdAt: row.created_at,
  });
}

const LEAD_SELECT = `
  l.*,
  e.id AS emp_id, e.name AS emp_name, e.email AS emp_email, e.role AS emp_role, e.department AS emp_department
`;

function joinEmployee(row) {
  if (!row || !row.assigned_to) return null;
  return {
    id: row.emp_id,
    name: row.emp_name,
    email: row.emp_email,
    role: row.emp_role,
    department: row.emp_department,
  };
}

async function insertLead(tenantId, data) {
  const result = await pool.query(
    `INSERT INTO leads (
      tenant_id, lead_name, company_name, phone, email, city, country,
      source, source_meta, form_name, pipeline_stage, temperature, status,
      win_probability, expected_revenue, currency, priority, assignment_status,
      requirements, insights, last_activity_at, stage_is_manual
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'unassigned',$18,$19,NOW(),$20
    ) RETURNING *`,
    [
      tenantId,
      data.leadName,
      data.companyName || null,
      data.phone || null,
      data.email || null,
      data.city || null,
      data.country || "India",
      data.source || "manual",
      JSON.stringify(data.sourceMeta || {}),
      data.formName || null,
      data.pipelineStage || "new",
      data.temperature || "warm",
      data.status || "New Lead",
      data.winProbability ?? 0,
      data.expectedRevenue ?? 0,
      data.currency || "INR",
      data.priority || "medium",
      data.requirements || null,
      data.insights || null,
      data.pipelineStage && String(data.pipelineStage).toLowerCase() !== "new" ? 1 : 0,

    ],
  );
  return mapLead(result.rows[0]);
}

async function findLeadById(tenantId, leadId, { populate = false } = {}) {
  const result = await pool.query(
    populate
      ? `SELECT ${LEAD_SELECT} FROM leads l LEFT JOIN employees e ON e.id = l.assigned_to WHERE l.id = $1 AND l.tenant_id = $2 AND l.is_deleted = 0`
      : `SELECT * FROM leads WHERE id = $1 AND tenant_id = $2 AND is_deleted = 0`,
    [leadId, tenantId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return populate ? mapLead(row, joinEmployee(row)) : mapLead(row);
}

async function findLeadByEmail(tenantId, email, { assignedTo } = {}) {
  const normEmail = String(email || "").trim().toLowerCase();
  if (!normEmail || !normEmail.includes("@")) return null;

  const params = [tenantId, normEmail];
  let sql = `SELECT * FROM leads WHERE (tenant_id = $1 OR tenant_id IS NULL) AND is_deleted = 0 AND LOWER(email) = $2`;
  if (assignedTo != null) {
    sql += ` AND assigned_to = $3`;
    params.push(assignedTo);
  }
  sql += ` ORDER BY id DESC LIMIT 1`;

  const result = await pool.query(sql, params);
  return mapLead(result.rows[0]);
}

async function findLeadByPhone(tenantId, phone, { assignedTo } = {}) {
  const digits = String(phone || "").replace(/\D/g, "");
  const last10 = digits.slice(-10);
  if (!last10 || last10.length < 10) return null;

  const params = [tenantId, `%${last10}`];
  let sql = `SELECT * FROM leads WHERE (tenant_id = $1 OR tenant_id IS NULL) AND is_deleted = 0 AND phone LIKE $2`;
  if (assignedTo != null) {
    sql += ` AND assigned_to = $3`;
    params.push(assignedTo);
  }
  sql += ` ORDER BY id DESC LIMIT 1`;

  const result = await pool.query(sql, params);
  return mapLead(result.rows[0]);
}

async function listLeads(tenantId, filters = {}, { page = 1, limit = 50 } = {}) {
  const conditions = ["(l.tenant_id = $1 OR l.tenant_id = 'default' OR l.tenant_id = '1' OR l.tenant_id IS NULL)", "l.is_deleted = 0"];
  const params = [tenantId];
  let idx = 2;

  const add = (sql, val) => {
    conditions.push(sql.replace("?", `$${idx}`));
    params.push(val);
    idx += 1;
  };

  if (filters.assignmentStatus) add("l.assignment_status = ?", filters.assignmentStatus);
  if (filters.assignedTo) add("l.assigned_to = ?", filters.assignedTo);
  if (filters.status) add("l.status = ?", filters.status);
  if (filters.pipelineStage) add("l.pipeline_stage = ?", filters.pipelineStage);
  if (filters.source) add("l.source = ?", filters.source);
  if (filters.temperature) add("l.temperature = ?", filters.temperature);
  if (filters.q) {
    conditions.push(`(
      l.lead_name ILIKE $${idx} OR l.company_name ILIKE $${idx}
      OR l.phone ILIKE $${idx} OR l.email ILIKE $${idx}
    )`);
    params.push(`%${filters.q}%`);
    idx += 1;
  }

  const where = conditions.join(" AND ");
  const offset = (page - 1) * limit;

  const [itemsRes, countRes] = await Promise.all([
    pool.query(
      `SELECT ${LEAD_SELECT} FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE ${where}
       ORDER BY l.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset],
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM leads l WHERE ${where}`, params),
  ]);

  return {
    items: itemsRes.rows.map((r) => mapLead(r, joinEmployee(r))),
    total: countRes.rows[0].total,
  };
}

/** Paginate through listLeads until all matching rows are loaded (employee dashboards were capped at 500). */
async function listAllLeads(tenantId, filters = {}, { pageSize = 500, maxPages = 40 } = {}) {
  const all = [];
  let page = 1;
  let total = 0;

  while (page <= maxPages) {
    const result = await listLeads(tenantId, filters, { page, limit: pageSize });
    total = result.total;
    if (!result.items.length) break;
    all.push(...result.items);
    if (all.length >= total) break;
    if (result.items.length < pageSize) break;
    page += 1;
  }

  return { items: all, total: total || all.length };
}

async function findLeadsByIds(tenantId, ids = []) {
  const list = [...new Set((ids || []).map((id) => Number(id)).filter(Boolean))];
  if (!list.length) return [];
  const result = await pool.query(
    `SELECT ${LEAD_SELECT} FROM leads l
     LEFT JOIN employees e ON e.id = l.assigned_to
     WHERE l.tenant_id = $1 AND l.is_deleted = 0 AND l.id = ANY($2::int[])`,
    [tenantId, list],
  );
  return result.rows.map((r) => mapLead(r, joinEmployee(r)));
}

/** New/pending assignments for Lead column (pipeline loads these only, not full CRM). */
async function listAssignedNewLeadsForPipeline(tenantId, employeeId = null) {
  const params = [tenantId];
  let employeeSql = "";
  if (employeeId != null) {
    params.push(employeeId);
    employeeSql = " AND l.assigned_to = $2";
  }
  const result = await pool.query(
    `SELECT ${LEAD_SELECT} FROM leads l
     LEFT JOIN employees e ON e.id = l.assigned_to
     WHERE l.tenant_id = $1 AND l.is_deleted = 0 ${employeeSql}
       AND l.assignment_status IN ('assigned', 'pending', 'unassigned')
       AND (
         LOWER(COALESCE(l.status, '')) IN ('new', 'new lead')
         OR LOWER(COALESCE(l.pipeline_stage, '')) IN ('new', 'new lead', 'lead')
       )
     ORDER BY l.assigned_at IS NULL, l.assigned_at DESC, l.created_at DESC
     LIMIT 800`,
    params,
  );
  return result.rows.map((r) => mapLead(r, joinEmployee(r)));
}

async function updateLead(tenantId, leadId, patch) {
  const fields = [];
  const params = [tenantId, leadId];
  let idx = 3;

  const map = {
    leadName: "lead_name",
    companyName: "company_name",
    phone: "phone",
    email: "email",
    city: "city",
    country: "country",
    source: "source",
    sourceMeta: "source_meta",
    formName: "form_name",
    pipelineStage: "pipeline_stage",
    stageIsManual: "stage_is_manual",
    temperature: "temperature",
    status: "status",
    winProbability: "win_probability",
    expectedRevenue: "expected_revenue",
    currency: "currency",
    priority: "priority",
    assignmentStatus: "assignment_status",
    assignedTo: "assigned_to",
    assignedAt: "assigned_at",
    assignedBy: "assigned_by",
    assignmentMethod: "assignment_method",
    acceptedAt: "accepted_at",
    qualification: "qualification",
    budget: "budget",
    requirements: "requirements",
    insights: "insights",
    tags: "tags",
    lastActivityAt: "last_activity_at",
    nextFollowUpAt: "next_follow_up_at",
    convertedAt: "converted_at",
    lostAt: "lost_at",
    isDeleted: "is_deleted",
  };

  for (const [key, col] of Object.entries(map)) {
    if (patch[key] !== undefined) {
      let val = patch[key];
      if (["sourceMeta", "qualification", "budget", "tags"].includes(key)) {
        val = JSON.stringify(val);
      }
      fields.push(`${col} = $${idx}`);
      params.push(val);
      idx += 1;
    }
  }

  if (!fields.length) return findLeadById(tenantId, leadId);

  fields.push("updated_at = NOW()");
  const result = await pool.query(
    `UPDATE leads SET ${fields.join(", ")} WHERE tenant_id = $1 AND id = $2 AND is_deleted = 0 RETURNING *`,
    params,
  );
  return mapLead(result.rows[0]);
}

async function softDeleteLead(tenantId, leadId) {
  return updateLead(tenantId, leadId, { isDeleted: true });
}

async function touchLeadActivity(tenantId, leadId) {
  await pool.query(
    `UPDATE leads SET last_activity_at = NOW(), updated_at = NOW() WHERE tenant_id = $1 AND id = $2`,
    [tenantId, leadId],
  );
}

async function insertQueueItem(tenantId, leadId, priority) {
  const result = await pool.query(
    `INSERT INTO lead_assignment_queue (tenant_id, lead_id, priority, status, queued_at)
     VALUES ($1, $2, $3, 'queued', NOW()) RETURNING *`,
    [tenantId, leadId, priority],
  );
  return mapQueueItem(result.rows[0]);
}

async function listQueue(tenantId, { status } = {}) {
  const params = [tenantId];
  let sql = `
    SELECT
      q.id, q.tenant_id, q.lead_id, q.status, q.priority, q.queued_at,
      q.processed_at, q.failure_reason, q.attempts, q.created_at, q.updated_at,
      l.lead_name, l.company_name, l.phone, l.email, l.pipeline_stage,
      l.temperature, l.status AS lead_status, l.assignment_status, l.created_at AS lead_created_at
    FROM lead_assignment_queue q
    JOIN leads l ON l.id = q.lead_id
    WHERE q.tenant_id = $1
  `;
  if (status) {
    params.push(status);
    sql += ` AND q.status = $2`;
  }
  sql += ` ORDER BY q.priority DESC, q.queued_at ASC`;
  const result = await pool.query(sql, params);
  return result.rows.map((row) => {
    const q = {
      id: row.id,
      tenant_id: row.tenant_id,
      lead_id: row.lead_id,
      status: row.status,
      priority: row.priority,
      queued_at: row.queued_at,
      processed_at: row.processed_at,
      failure_reason: row.failure_reason,
      attempts: row.attempts,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const lead = {
      id: row.lead_id,
      tenant_id: row.tenant_id,
      lead_name: row.lead_name,
      company_name: row.company_name,
      phone: row.phone,
      email: row.email,
      pipeline_stage: row.pipeline_stage,
      temperature: row.temperature,
      status: row.lead_status,
      assignment_status: row.assignment_status,
      created_at: row.lead_created_at,
    };
    return mapQueueItem(q, lead);
  });
}

async function getQueuedItems(tenantId, limit) {
  const result = await pool.query(
    `SELECT * FROM lead_assignment_queue
     WHERE tenant_id = $1 AND status = 'queued'
     ORDER BY priority DESC, queued_at ASC
     LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows.map((r) => mapQueueItem(r));
}

async function updateQueueItem(id, patch) {
  const fields = [];
  const params = [id];
  let idx = 2;
  for (const [key, col] of Object.entries({
    status: "status",
    processedAt: "processed_at",
    failureReason: "failure_reason",
    attempts: "attempts",
  })) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = $${idx}`);
      params.push(patch[key]);
      idx += 1;
    }
  }
  if (!fields.length) return null;
  fields.push("updated_at = NOW()");
  const result = await pool.query(
    `UPDATE lead_assignment_queue SET ${fields.join(", ")} WHERE id = $1 RETURNING *`,
    params,
  );
  return mapQueueItem(result.rows[0]);
}

async function markQueueAssigned(tenantId, leadId) {
  await pool.query(
    `UPDATE lead_assignment_queue SET status = 'assigned', processed_at = NOW(), updated_at = NOW()
     WHERE tenant_id = $1 AND lead_id = $2`,
    [tenantId, leadId],
  );
}

async function getAssignmentConfig(tenantId) {
  const result = await pool.query(`SELECT * FROM assignment_config WHERE tenant_id = $1`, [tenantId]);
  return mapConfig(result.rows[0]);
}

async function createAssignmentConfig(tenantId, employeeIds) {
  const result = await pool.query(
    `INSERT INTO assignment_config (tenant_id, round_robin_order, today_key, today_stats)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [tenantId, JSON.stringify(employeeIds), new Date().toISOString().slice(0, 10), JSON.stringify({ total: 0, byEmployee: {} })],
  );
  return mapConfig(result.rows[0]);
}

async function saveAssignmentConfig(config) {
  const result = await pool.query(
    `UPDATE assignment_config SET
      mode = $2, auto_assign = $3, round_robin_order = $4, rr_index = $5,
      paused_employees = $6, workload_rules = $7, today_key = $8, today_stats = $9, updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [
      config.id,
      config.mode,
      config.autoAssign,
      JSON.stringify(config.roundRobinOrder || []),
      config.rrIndex ?? 0,
      JSON.stringify(config.pausedEmployees || []),
      JSON.stringify(config.workloadRules || {}),
      config.todayKey,
      JSON.stringify(config.todayStats || { total: 0, byEmployee: {} }),
    ],
  );
  return mapConfig(result.rows[0]);
}

async function upsertAssignmentConfig(tenantId, body) {
  const existing = await getAssignmentConfig(tenantId);
  if (!existing) {
    const result = await pool.query(
      `INSERT INTO assignment_config (tenant_id, mode, auto_assign, round_robin_order, rr_index, paused_employees, workload_rules)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        tenantId,
        body.mode || "round_robin",
        body.autoAssign !== false,
        JSON.stringify(body.roundRobinOrder || []),
        body.rrIndex ?? 0,
        JSON.stringify(body.pausedEmployees || []),
        JSON.stringify(body.workloadRules || {}),
      ],
    );
    return mapConfig(result.rows[0]);
  }

  const patch = { ...existing, ...body };
  return saveAssignmentConfig(patch);
}

async function listActiveEmployees(tenantId) {
  const result = await pool.query(
    `SELECT * FROM employees WHERE (tenant_id = $1 OR tenant_id IS NULL) AND (status IS NULL OR LOWER(status) = 'active' OR status = '') ORDER BY id ASC`,
    [tenantId],
  );
  return result.rows.map(mapEmployee);
}

async function listEmployees(tenantId, filters = {}) {
  const conditions = ["tenant_id = $1"];
  const params = [tenantId];
  let idx = 2;
  if (filters.status) {
    conditions.push(`status = $${idx}`);
    params.push(filters.status);
    idx += 1;
  }
  if (filters.q) {
    conditions.push(`(name ILIKE $${idx} OR email ILIKE $${idx} OR role ILIKE $${idx})`);
    params.push(`%${filters.q}%`);
    idx += 1;
  }
  const result = await pool.query(
    `SELECT * FROM employees WHERE ${conditions.join(" AND ")} ORDER BY name ASC`,
    params,
  );
  return result.rows.map(mapEmployee);
}

async function findEmployeeById(tenantId, employeeId) {
  if (!employeeId) return null;
  const cleanedPhone = String(employeeId).replace(/\D/g, "");
  const normPhone = cleanedPhone.length >= 10 ? cleanedPhone.slice(-10) : cleanedPhone;
  const result = await pool.query(
    `SELECT * FROM employees WHERE (id = $1 OR phone = $1 OR phone = $2) AND (tenant_id = $3 OR tenant_id IS NULL) LIMIT 1`,
    [isNaN(employeeId) ? -1 : Number(employeeId), normPhone || String(employeeId), tenantId],
  );
  return mapEmployee(result.rows[0]);
}

async function findServiceByIdCode(tenantId, codeOrId) {
  if (!codeOrId) return null;
  const result = await pool.query(
    `SELECT * FROM services WHERE (tenant_id = $1 OR tenant_id IS NULL) AND (service_code = $2 OR id = $2) LIMIT 1`,
    [tenantId, String(codeOrId).trim()],
  );
  return result.rows[0] || null;
}

async function findSopByIdCode(tenantId, codeOrId) {
  if (!codeOrId) return null;
  const result = await pool.query(
    `SELECT * FROM sops WHERE (sop_code = $1 OR CAST(id AS CHAR) = $1) LIMIT 1`,
    [String(codeOrId).trim()],
  );
  return result.rows[0] || null;
}

async function createEmployee(tenantId, data) {
  const result = await pool.query(
    `INSERT INTO employees (tenant_id, name, email, phone, role, department, status, city, avatar_url, initials, salary, joining_date, manager_id, territory)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      tenantId,
      data.name,
      data.email || null,
      data.phone || null,
      data.role || null,
      data.department || null,
      data.status || "active",
      data.city || null,
      data.avatarUrl || null,
      data.initials || null,
      data.salary ?? null,
      data.joiningDate || null,
      data.managerId || null,
      data.territory || null,
    ],
  );
  return mapEmployee(result.rows[0]);
}

async function updateEmployee(tenantId, employeeId, data) {
  const fields = [];
  const params = [employeeId, tenantId];
  let idx = 3;
  const map = {
    name: "name", email: "email", phone: "phone", role: "role", department: "department",
    status: "status", city: "city", avatarUrl: "avatar_url", initials: "initials",
    salary: "salary", joiningDate: "joining_date", managerId: "manager_id", territory: "territory",
    receivingPaused: "receiving_paused",
    maxActiveLeads: "max_active_leads", currentActiveLeads: "current_active_leads", dailyLimit: "daily_limit",
  };
  for (const [key, col] of Object.entries(map)) {
    if (data[key] !== undefined) {
      fields.push(`${col} = $${idx}`);
      params.push(data[key]);
      idx += 1;
    }
  }
  if (data.capacity) {
    if (data.capacity.receivingPaused !== undefined) {
      fields.push(`receiving_paused = $${idx}`);
      params.push(data.capacity.receivingPaused);
      idx += 1;
    }
    if (data.capacity.maxActiveLeads !== undefined) {
      fields.push(`max_active_leads = $${idx}`);
      params.push(data.capacity.maxActiveLeads);
      idx += 1;
    }
    if (data.capacity.currentActiveLeads !== undefined) {
      fields.push(`current_active_leads = $${idx}`);
      params.push(data.capacity.currentActiveLeads);
      idx += 1;
    }
    if (data.capacity.dailyLimit !== undefined) {
      fields.push(`daily_limit = $${idx}`);
      params.push(data.capacity.dailyLimit);
      idx += 1;
    }
  }
  if (!fields.length) return findEmployeeById(tenantId, employeeId);
  fields.push("updated_at = NOW()");
  const result = await pool.query(
    `UPDATE employees SET ${fields.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params,
  );
  return mapEmployee(result.rows[0]);
}

async function incrementEmployeeLeads(employeeId, delta) {
  await pool.query(
    `UPDATE employees SET current_active_leads = GREATEST(0, COALESCE(current_active_leads, 0) + $2), updated_at = NOW() WHERE id = $1`,
    [employeeId, delta],
  );
}

async function insertAssignmentHistory(data) {
  const result = await pool.query(
    `INSERT INTO assignment_history (tenant_id, lead_id, from_employee_id, to_employee_id, method, performed_by, reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      data.tenantId,
      data.leadId,
      data.fromEmployeeId || null,
      data.toEmployeeId || null,
      data.method,
      data.performedBy || null,
      data.reason || null,
      JSON.stringify(data.metadata || {}),
    ],
  );
  return mapHistory(result.rows[0]);
}

async function listAssignmentHistory(tenantId, limit) {
  const result = await pool.query(
    `SELECT h.*,
      l.lead_name, l.company_name,
      fe.name AS from_name, te.name AS to_name
     FROM assignment_history h
     LEFT JOIN leads l ON l.id = h.lead_id
     LEFT JOIN employees fe ON fe.id = h.from_employee_id
     LEFT JOIN employees te ON te.id = h.to_employee_id
     WHERE h.tenant_id = $1
     ORDER BY h.created_at DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows.map((row) => {
    const item = mapHistory(row);
    item.leadId = mapLead({ id: row.lead_id, lead_name: row.lead_name, company_name: row.company_name, tenant_id: tenantId });
    if (row.from_employee_id) item.fromEmployeeId = { id: row.from_employee_id, name: row.from_name };
    if (row.to_employee_id) item.toEmployeeId = { id: row.to_employee_id, name: row.to_name };
    return item;
  });
}

async function insertTimeline(data) {
  const result = await pool.query(
    `INSERT INTO lead_timeline_events (tenant_id, lead_id, type, actor_id, actor_name, actor_role, summary, payload)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      data.tenantId,
      data.leadId,
      data.type,
      data.actorId || null,
      data.actorName || null,
      data.actorRole || null,
      data.summary || null,
      JSON.stringify(data.payload || {}),
    ],
  );
  return mapTimeline(result.rows[0]);
}

async function listTimeline(tenantId, { leadId, limit = 100 } = {}) {
  const params = [tenantId];
  let sql = `SELECT * FROM lead_timeline_events WHERE tenant_id = $1`;
  if (leadId) {
    params.push(leadId);
    sql += ` AND lead_id = $2`;
  }
  params.push(limit);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;
  const result = await pool.query(sql, params);
  return result.rows.map(mapTimeline);
}

async function insertAudit(data) {
  const result = await pool.query(
    `INSERT INTO audit_logs (tenant_id, actor_id, action, resource, resource_id, before_state, after_state, ip, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [
      data.tenantId,
      data.actorId || null,
      data.action,
      data.resource,
      String(data.resourceId || ""),
      data.before ? JSON.stringify(data.before) : null,
      data.after ? JSON.stringify(data.after) : null,
      data.ip || null,
      JSON.stringify(data.metadata || {}),
    ],
  );
  return mapAudit(result.rows[0]);
}

async function listAudit(tenantId, limit) {
  const result = await pool.query(
    `SELECT * FROM audit_logs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows.map(mapAudit);
}

async function insertNotification(data) {
  const result = await pool.query(
    `INSERT INTO crm_notifications (tenant_id, user_id, employee_id, type, title, body, entity_type, entity_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      data.tenantId,
      data.userId || null,
      data.employeeId || null,
      data.type,
      data.title,
      data.body || null,
      data.entityType || null,
      String(data.entityId || ""),
    ],
  );
  return mapNotification(result.rows[0]);
}

async function listNotifications(tenantId, filters = {}, limit = 50) {
  const conditions = ["tenant_id = $1"];
  const params = [tenantId];
  let idx = 2;
  if (filters.employeeId) {
    conditions.push(`employee_id = $${idx}`);
    params.push(filters.employeeId);
    idx += 1;
  }
  if (filters.unread) {
    conditions.push("is_read = false");
  }
  params.push(limit);
  const result = await pool.query(
    `SELECT * FROM crm_notifications WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT $${idx}`,
    params,
  );
  return result.rows.map(mapNotification);
}

async function markNotificationsRead(tenantId, { ids, employeeId } = {}) {
  const conditions = ["tenant_id = $1"];
  const params = [tenantId];
  let idx = 2;
  if (ids?.length) {
    conditions.push(`id = ANY($${idx})`);
    params.push(ids);
    idx += 1;
  }
  if (employeeId) {
    conditions.push(`employee_id = $${idx}`);
    params.push(employeeId);
    idx += 1;
  }
  await pool.query(
    `UPDATE crm_notifications SET is_read = true WHERE ${conditions.join(" AND ")}`,
    params,
  );
}

async function notificationExists(tenantId, type, entityId) {
  const result = await pool.query(
    `SELECT 1 FROM crm_notifications WHERE tenant_id = $1 AND type = $2 AND entity_id = $3 LIMIT 1`,
    [tenantId, type, String(entityId)],
  );
  return result.rowCount > 0;
}

async function insertNote(data) {
  const result = await pool.query(
    `INSERT INTO lead_notes (tenant_id, lead_id, author_id, author_type, body)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [data.tenantId, data.leadId, data.authorId || null, data.authorType || "employee", data.body],
  );
  return mapNote(result.rows[0]);
}

async function listNotes(tenantId, leadId) {
  const result = await pool.query(
    `SELECT * FROM lead_notes WHERE tenant_id = $1 AND lead_id = $2 ORDER BY created_at DESC`,
    [tenantId, leadId],
  );
  return result.rows.map(mapNote);
}

async function insertCall(data) {
  const result = await pool.query(
    `INSERT INTO employee_calls (tenant_id, lead_id, employee_id, direction, outcome, duration_sec, started_at, ended_at, sop_id, notes, ai_summary, checklist_progress, recording_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
    [
      data.tenantId,
      data.leadId,
      data.employeeId,
      data.direction || "outbound",
      data.outcome || null,
      data.durationSec || null,
      data.startedAt || null,
      data.endedAt || null,
      data.sopId || null,
      data.notes || null,
      data.aiSummary || null,
      data.checklistProgress ? JSON.stringify(data.checklistProgress) : null,
      data.recordingUrl || null,
    ],
  );
  return mapCall(result.rows[0]);
}

async function listCalls(tenantId, employeeId, options = {}) {
  const period = options.period ? String(options.period).toLowerCase() : null;
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_CALL_LIST_LIMIT, 1), DEFAULT_CALL_LIST_LIMIT);
  const params = [tenantId, employeeId];
  let periodSql = "";

  if (period && period !== "all") {
    const filter = buildPeriodDateFilter({
      period,
      column: "COALESCE(ec.started_at, ec.created_at)",
      paramOffset: 3,
    });
    periodSql = ` AND ${filter.clause}`;
    params.push(...filter.params);
  }

  const result = await pool.query(
    `SELECT ec.*, l.lead_name AS client_name, l.phone AS client_phone, l.company_name AS client_company
     FROM employee_calls ec
     LEFT JOIN leads l ON ec.lead_id = l.id
     WHERE ec.tenant_id = $1 AND ec.employee_id = $2
       AND NOT EXISTS (
         SELECT 1 FROM employee_private_contacts epc
         WHERE epc.employee_id = ec.employee_id
           AND epc.tenant_id = ec.tenant_id
           AND l.phone IS NOT NULL
           AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '+', ''), '-', ''), '(', ''), 10) = epc.phone_normalized
       )
       ${periodSql}
     ORDER BY COALESCE(ec.started_at, ec.created_at) DESC
     LIMIT ${limit}`,
    params,
  );
  return result.rows.map(mapCall);
}

async function listCallsForLead(tenantId, lead, options = {}) {
  const leadId = Number(lead?.id);
  if (!leadId) return [];
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), DEFAULT_CALL_LIST_LIMIT);
  const phoneDigits = String(lead?.phone || "").replace(/\D/g, "").slice(-10);
  const params = [tenantId, leadId];
  let phoneSql = "";
  if (phoneDigits.length >= 10) {
    params.push(`%${phoneDigits}`);
    phoneSql = ` OR (
      ec.lead_id IS NULL
      AND l.phone IS NOT NULL
      AND REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '+', ''), '-', ''), '(', '') LIKE $3
    )`;
  }
  const result = await pool.query(
    `SELECT ec.*, l.lead_name AS client_name, l.phone AS client_phone, l.company_name AS client_company
     FROM employee_calls ec
     LEFT JOIN leads l ON ec.lead_id = l.id
     WHERE ec.tenant_id = $1
       AND (ec.lead_id = $2${phoneSql})
     ORDER BY COALESCE(ec.started_at, ec.created_at) DESC
     LIMIT ${limit}`,
    params,
  );
  return result.rows.map(mapCall);
}

async function findCallByCallyzerId(tenantId, callyzerCallId) {
  const result = await pool.query(
    `SELECT ec.*, l.lead_name AS client_name, l.phone AS client_phone, l.company_name AS client_company
     FROM employee_calls ec
     LEFT JOIN leads l ON ec.lead_id = l.id
     WHERE ec.tenant_id = $1 AND ec.callyzer_call_id = $2 LIMIT 1`,
    [tenantId, callyzerCallId],
  );
  return mapCall(result.rows[0]);
}

async function upsertCallyzerCall(data) {
  const existing = data.callyzerCallId
    ? await findCallByCallyzerId(data.tenantId, data.callyzerCallId)
    : null;

  if (existing) {
    // If the call now has a recording that it didn't before, update it
    // and clear the AI summary so it gets re-processed with real audio
    const hasNewRecording = data.recordingUrl && !existing.recordingUrl;
    const hadPlaceholderSummary =
      !existing.aiSummary ||
      existing.aiSummary === "" ||
      String(existing.aiSummary).includes("No call recording") ||
      String(existing.notes || "").includes("No call recording");

    if (hasNewRecording || (data.recordingUrl && hadPlaceholderSummary)) {
      await pool.query(
        `UPDATE employee_calls
         SET recording_url = $1, ai_summary = NULL, notes = NULL, transcript = NULL
         WHERE id = $2`,
        [data.recordingUrl, existing.id],
      );
      // Return the updated record so AI processing gets triggered
      const updated = await pool.query(
        "SELECT * FROM employee_calls WHERE id = $1 LIMIT 1",
        [existing.id],
      );
      return mapCall(updated.rows[0]);
    }
    return existing;
  }

  const result = await pool.query(
    `INSERT INTO employee_calls (
       tenant_id, lead_id, employee_id, callyzer_call_id, direction, outcome,
       duration_sec, started_at, ended_at, recording_url, notes, ai_summary
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [
      data.tenantId,
      data.leadId || null,
      data.employeeId,
      data.callyzerCallId || null,
      data.direction || "outbound",
      data.outcome || null,
      data.durationSec || null,
      data.startedAt || null,
      data.endedAt || null,
      data.recordingUrl || null,
      data.notes || null,
      data.aiSummary || null,
    ],
  );
  return mapCall(result.rows[0]);
}


async function insertTask(data) {
  const result = await pool.query(
    `INSERT INTO tasks (tenant_id, assignee_id, lead_id, title, description, priority, due_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [
      data.tenantId,
      data.assigneeId,
      data.leadId || null,
      data.title,
      data.description || null,
      data.priority || "medium",
      data.dueAt || null,
      data.status || "pending",
    ],
  );
  return mapTask(result.rows[0]);
}

async function findTaskById(tenantId, taskId) {
  const result = await pool.query(
    `SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [taskId, tenantId],
  );
  return mapTask(result.rows[0]);
}

async function findMeetingById(tenantId, meetingId) {
  const result = await pool.query(
    `SELECT * FROM meetings WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
    [meetingId, tenantId],
  );
  return mapMeeting(result.rows[0]);
}

async function updateTask(tenantId, taskId, patch) {
  const fields = [];
  const params = [taskId, tenantId];
  let idx = 3;
  for (const [key, col] of Object.entries({
    status: "status", completedAt: "completed_at", title: "title", description: "description",
    priority: "priority", dueAt: "due_at", followUpId: "follow_up_id",
  })) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = $${idx}`);
      params.push(patch[key]);
      idx += 1;
    }
  }
  if (!fields.length) return null;
  fields.push("updated_at = NOW()");
  const result = await pool.query(
    `UPDATE tasks SET ${fields.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params,
  );
  return mapTask(result.rows[0]);
}

async function listTasks(tenantId, filters = {}) {
  const conditions = ["tenant_id = $1", "status <> 'cancelled'"];
  const params = [tenantId];
  let idx = 2;
  if (filters.assigneeId) {
    conditions.push(`assignee_id = $${idx}`);
    params.push(filters.assigneeId);
    idx += 1;
  }
  if (filters.status) {
    conditions.push(`status = $${idx}`);
    params.push(filters.status);
    idx += 1;
  }
  if (filters.leadId) {
    conditions.push(`lead_id = $${idx}`);
    params.push(filters.leadId);
    idx += 1;
  }
  let sql = `SELECT * FROM tasks WHERE ${conditions.join(" AND ")} ORDER BY (due_at IS NULL), due_at ASC`;
  if (filters.limit) {
    params.push(filters.limit);
    sql += ` LIMIT $${idx}`;
  }
  const result = await pool.query(sql, params);
  return result.rows.map(mapTask);
}

async function insertFollowup(data) {
  const result = await pool.query(
    `INSERT INTO followups (tenant_id, lead_id, employee_id, task_id, scheduled_at, note, status)
     VALUES ($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,
    [data.tenantId, data.leadId, data.employeeId, data.taskId || null, data.scheduledAt, data.note || null],
  );
  return mapFollowup(result.rows[0]);
}

async function findFollowupById(tenantId, followupId) {
  const result = await pool.query(`SELECT * FROM followups WHERE id = $1 AND tenant_id = $2`, [followupId, tenantId]);
  return mapFollowup(result.rows[0]);
}

async function updateFollowup(tenantId, followupId, patch) {
  const fields = [];
  const params = [followupId, tenantId];
  let idx = 3;
  for (const [key, col] of Object.entries({ status: "status", completedAt: "completed_at", taskId: "task_id" })) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = $${idx}`);
      params.push(patch[key]);
      idx += 1;
    }
  }
  if (!fields.length) return findFollowupById(tenantId, followupId);
  const result = await pool.query(
    `UPDATE followups SET ${fields.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params,
  );
  return mapFollowup(result.rows[0]);
}

async function listFollowups(tenantId, employeeId) {
  const result = await pool.query(
    `SELECT * FROM followups WHERE tenant_id = $1 AND employee_id = $2 ORDER BY scheduled_at ASC`,
    [tenantId, employeeId],
  );
  return result.rows.map(mapFollowup);
}

async function listDueFollowups(tenantId, limit) {
  const result = await pool.query(
    `SELECT * FROM followups WHERE tenant_id = $1 AND status = 'pending' AND scheduled_at <= NOW() LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows.map(mapFollowup);
}

async function insertMeeting(data) {
  const mom = data.agenda ? JSON.stringify({ agenda: data.agenda }) : null;
  const result = await pool.query(
    `INSERT INTO meetings (tenant_id, lead_id, employee_id, title, scheduled_at, duration_min, meet_link, location, status, mom)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'scheduled',$9) RETURNING *`,
    [
      data.tenantId,
      data.leadId,
      data.employeeId,
      data.title || null,
      data.scheduledAt,
      data.durationMin || null,
      data.meetLink || null,
      data.location || null,
      mom,
    ],
  );
  return mapMeeting(result.rows[0]);
}

async function updateMeeting(tenantId, meetingId, patch) {
  const fields = [];
  const params = [meetingId, tenantId];
  let idx = 3;
  for (const [key, col] of Object.entries({ status: "status", mom: "mom" })) {
    if (patch[key] !== undefined) {
      fields.push(`${col} = $${idx}`);
      params.push(key === "mom" ? JSON.stringify(patch[key]) : patch[key]);
      idx += 1;
    }
  }
  if (!fields.length) return null;
  const result = await pool.query(
    `UPDATE meetings SET ${fields.join(", ")} WHERE id = $1 AND tenant_id = $2 RETURNING *`,
    params,
  );
  return mapMeeting(result.rows[0]);
}

async function listMeetings(tenantId, employeeId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 2000);
  const result = await pool.query(
    `SELECT m.*,
            l.lead_name, l.phone AS lead_phone, l.email AS lead_email, l.company_name AS lead_company, l.form_name AS lead_service,
            e.name AS employee_name
     FROM meetings m
     LEFT JOIN leads l ON l.id = m.lead_id
     LEFT JOIN employees e ON e.id = m.employee_id
     WHERE m.tenant_id = $1 AND m.employee_id = $2
     ORDER BY m.scheduled_at ASC LIMIT ${limit}`,
    [tenantId, employeeId],
  );
  return result.rows.map(mapMeeting);
}

async function listTenantMeetings(tenantId, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 1000, 1), 2000);
  const result = await pool.query(
    `SELECT m.*,
            l.lead_name, l.phone AS lead_phone, l.email AS lead_email, l.company_name AS lead_company, l.form_name AS lead_service,
            e.name AS employee_name
     FROM meetings m
     LEFT JOIN leads l ON l.id = m.lead_id
     LEFT JOIN employees e ON e.id = m.employee_id
     WHERE m.tenant_id = $1
     ORDER BY m.scheduled_at ASC LIMIT ${limit}`,
    [tenantId],
  );
  return result.rows.map(mapMeeting);
}

async function listTenantCalls(tenantId, options = {}) {
  const period = options.period ? String(options.period).toLowerCase() : null;
  const limit = Math.min(Math.max(Number(options.limit) || DEFAULT_CALL_LIST_LIMIT, 1), DEFAULT_CALL_LIST_LIMIT);
  const params = [tenantId];
  let periodSql = "";

  if (period && period !== "all") {
    const filter = buildPeriodDateFilter({
      period,
      column: "COALESCE(ec.started_at, ec.created_at)",
      paramOffset: 2,
    });
    periodSql = ` AND ${filter.clause}`;
    params.push(...filter.params);
  }

  const result = await pool.query(
    `SELECT ec.*, l.lead_name AS client_name, l.phone AS client_phone, l.company_name AS client_company
     FROM employee_calls ec
     LEFT JOIN leads l ON ec.lead_id = l.id
     WHERE ec.tenant_id = $1
       AND NOT EXISTS (
         SELECT 1 FROM employee_private_contacts epc
         WHERE epc.employee_id = ec.employee_id
           AND epc.tenant_id = ec.tenant_id
           AND l.phone IS NOT NULL
           AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '+', ''), '-', ''), '(', ''), 10) = epc.phone_normalized
       )
       ${periodSql}
     ORDER BY COALESCE(ec.started_at, ec.created_at) DESC
     LIMIT ${limit}`,
    params,
  );
  return result.rows.map(mapCall);
}

async function insertFileAsset(data) {
  const result = await pool.query(
    `INSERT INTO file_assets (tenant_id, uploaded_by, entity_type, entity_id, filename, original_name, mime, size, storage_key, url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [
      data.tenantId,
      data.uploadedBy || null,
      data.entityType || null,
      data.entityId || null,
      data.filename,
      data.originalName,
      data.mime,
      data.size,
      data.storageKey,
      data.url,
    ],
  );
  return mapFileAsset(result.rows[0]);
}

const TEAM_ASSET_TYPE = "team_asset";

async function listTeamAssets(tenantId) {
  const result = await pool.query(
    `SELECT * FROM file_assets
     WHERE tenant_id = $1 AND entity_type = $2
     ORDER BY created_at DESC`,
    [tenantId, TEAM_ASSET_TYPE],
  );
  return result.rows.map(mapFileAsset);
}

async function getAdminKpis(tenantId, range = {}) {
  const params = [tenantId];
  let dateFilter = "";
  if (range.start) {
    params.push(range.start);
    dateFilter += ` AND created_at >= $${params.length}`;
  }
  if (range.end) {
    params.push(range.end);
    dateFilter += ` AND created_at <= $${params.length}`;
  }

  const result = await pool.query(
    `SELECT
      COUNT(*)::int AS total_leads,
      COALESCE(SUM(expected_revenue), 0)::float AS pipeline_value,
      COUNT(*) FILTER (WHERE pipeline_stage IN ('qualified','meeting','proposal','negotiation','won'))::int AS qualified,
      COUNT(*) FILTER (WHERE pipeline_stage = 'won')::int AS conversions,
      COALESCE(SUM(expected_revenue) FILTER (WHERE pipeline_stage = 'won'), 0)::float AS revenue
     FROM leads
     WHERE tenant_id = $1 AND is_deleted = 0 ${dateFilter}`,
    params,
  );

  const cashResult = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS cash_collected
     FROM cash_collections
     WHERE tenant_id = $1`,
    [tenantId],
  );

  const row = result.rows[0];
  const cashCollected = cashResult.rows[0]?.cash_collected || 0;
  return {
    revenue: row.revenue || 0,
    cashCollected,
    conversionRate: row.total_leads ? Math.round(((row.conversions || 0) / row.total_leads) * 100) : 0,
    qualifiedLeads: row.qualified || 0,
    pipelineValue: row.pipeline_value || 0,
    totalLeads: row.total_leads || 0,
  };
}

async function getPipelineGrouped(tenantId, filters = {}) {
  const params = [tenantId];
  let sql = `
    SELECT pipeline_stage AS stage, COUNT(*)::int AS count, COALESCE(SUM(expected_revenue), 0)::float AS value
    FROM leads WHERE tenant_id = $1 AND is_deleted = 0
  `;
  let idx = 2;
  if (filters.assignedTo) {
    sql += ` AND assigned_to = $${idx}`;
    params.push(filters.assignedTo);
    idx += 1;
  }
  if (filters.temperature) {
    sql += ` AND temperature = $${idx}`;
    params.push(filters.temperature);
    idx += 1;
  }
  sql += ` GROUP BY pipeline_stage ORDER BY pipeline_stage`;
  const result = await pool.query(sql, params);
  return result.rows.map((r) => ({ _id: r.stage, count: r.count, value: r.value }));
}

function mapCashCollection(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    leadId: row.lead_id,
    employeeId: row.employee_id,
    amount: Number(row.amount) || 0,
    currency: row.currency || "INR",
    paymentMode: row.payment_mode,
    paymentAt: row.payment_at,
    transactionId: row.transaction_id,
    slipUrl: row.slip_url,
    slipFilename: row.slip_filename,
    notes: row.notes,
    recordedBy: row.recorded_by,
    leadName: row.lead_name,
    companyName: row.company_name,
    employeeName: row.employee_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function insertCashCollection(data) {
  const result = await pool.query(
    `INSERT INTO cash_collections
      (tenant_id, lead_id, employee_id, amount, currency, payment_mode, payment_at,
       transaction_id, slip_url, slip_filename, notes, recorded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      data.tenantId,
      data.leadId,
      data.employeeId || null,
      data.amount,
      data.currency || "INR",
      data.paymentMode,
      data.paymentAt,
      data.transactionId || null,
      data.slipUrl || null,
      data.slipFilename || null,
      data.notes || null,
      data.recordedBy || null,
    ],
  );
  return mapCashCollection(result.rows[0]);
}

async function listCashCollectionsByLead(tenantId, leadId) {
  const result = await pool.query(
    `SELECT cc.*, l.lead_name, l.company_name, e.name AS employee_name
     FROM cash_collections cc
     LEFT JOIN leads l ON l.id = cc.lead_id
     LEFT JOIN employees e ON e.id = cc.employee_id
     WHERE cc.tenant_id = $1 AND cc.lead_id = $2
     ORDER BY cc.payment_at DESC, cc.id DESC`,
    [tenantId, leadId],
  );
  return result.rows.map(mapCashCollection);
}

async function listCashCollectionsByEmployee(tenantId, employeeId, limit = 200) {
  const result = await pool.query(
    `SELECT cc.*, l.lead_name, l.company_name, e.name AS employee_name
     FROM cash_collections cc
     LEFT JOIN leads l ON l.id = cc.lead_id
     LEFT JOIN employees e ON e.id = cc.employee_id
     WHERE cc.tenant_id = $1 AND cc.employee_id = $2
     ORDER BY cc.payment_at DESC, cc.id DESC
     LIMIT $3`,
    [tenantId, employeeId, limit],
  );
  return result.rows.map(mapCashCollection);
}

async function sumCashByEmployee(tenantId, employeeId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
     FROM cash_collections
     WHERE tenant_id = $1 AND employee_id = $2`,
    [tenantId, employeeId],
  );
  return Number(result.rows[0]?.total) || 0;
}

async function sumCashByLead(tenantId, leadId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
     FROM cash_collections
     WHERE tenant_id = $1 AND lead_id = $2`,
    [tenantId, leadId],
  );
  return Number(result.rows[0]?.total) || 0;
}

async function sumCashByTenant(tenantId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0)::float AS total
     FROM cash_collections
     WHERE tenant_id = $1`,
    [tenantId],
  );
  return Number(result.rows[0]?.total) || 0;
}

async function getLeaderboard(tenantId, limit = 10) {
  const result = await pool.query(
    `SELECT l.assigned_to AS employee_id,
      COUNT(*)::int AS conversions,
      COALESCE(SUM(l.expected_revenue), 0)::float AS revenue,
      e.name, e.email, e.role, e.department
     FROM leads l
     JOIN employees e ON e.id = l.assigned_to
     WHERE l.tenant_id = $1 AND l.pipeline_stage = 'won' AND l.is_deleted = 0
     GROUP BY l.assigned_to, e.name, e.email, e.role, e.department
     ORDER BY conversions DESC, revenue DESC
     LIMIT $2`,
    [tenantId, limit],
  );
  return result.rows.map((r) => ({
    _id: r.employee_id,
    conversions: r.conversions,
    revenue: r.revenue,
    employee: mapEmployee({
      id: r.employee_id,
      name: r.name,
      email: r.email,
      role: r.role,
      department: r.department,
      tenant_id: tenantId,
      status: "active",
    }),
  }));
}

async function ping() {
  await pool.query("SELECT 1");
  return true;
}

function mapWhatsAppScript(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    title: row.title,
    body: row.body,
    category: row.category || "General",
    isActive: Boolean(row.is_active),
    createdAt: toLocalSqlString(row.created_at),
    updatedAt: toLocalSqlString(row.updated_at),
  };
}

async function listWhatsAppScripts(tenantId, employeeId, { includeInactive = false } = {}) {
  const params = [tenantId, employeeId];
  let sql = `SELECT * FROM whatsapp_scripts WHERE tenant_id = $1 AND employee_id = $2`;
  if (!includeInactive) sql += ` AND is_active = 1`;
  sql += ` ORDER BY updated_at DESC, id DESC`;
  const result = await pool.query(sql, params);
  return result.rows.map(mapWhatsAppScript);
}

async function findWhatsAppScriptById(tenantId, scriptId) {
  const result = await pool.query(
    `SELECT * FROM whatsapp_scripts WHERE id = $1 AND tenant_id = $2`,
    [scriptId, tenantId],
  );
  return mapWhatsAppScript(result.rows[0]);
}

async function insertWhatsAppScript(data) {
  const result = await pool.query(
    `INSERT INTO whatsapp_scripts (tenant_id, employee_id, title, body, category, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [
      data.tenantId,
      data.employeeId,
      data.title,
      data.body,
      data.category || "General",
      data.isActive === false ? 0 : 1,
    ],
  );
  return mapWhatsAppScript(result.rows[0]);
}

async function updateWhatsAppScript(tenantId, scriptId, employeeId, patch) {
  const fields = [];
  const values = [];
  let idx = 1;

  if (patch.title != null) {
    fields.push(`title = $${idx++}`);
    values.push(patch.title);
  }
  if (patch.body != null) {
    fields.push(`body = $${idx++}`);
    values.push(patch.body);
  }
  if (patch.category != null) {
    fields.push(`category = $${idx++}`);
    values.push(patch.category);
  }
  if (patch.isActive != null) {
    fields.push(`is_active = $${idx++}`);
    values.push(patch.isActive ? 1 : 0);
  }

  if (!fields.length) return findWhatsAppScriptById(tenantId, scriptId);

  values.push(scriptId, tenantId, employeeId);
  const result = await pool.query(
    `UPDATE whatsapp_scripts SET ${fields.join(", ")}, updated_at = CURRENT_TIMESTAMP
     WHERE id = $${idx++} AND tenant_id = $${idx++} AND employee_id = $${idx}
     RETURNING *`,
    values,
  );
  return mapWhatsAppScript(result.rows[0]);
}

async function deleteWhatsAppScript(tenantId, scriptId, employeeId) {
  const result = await pool.query(
    `DELETE FROM whatsapp_scripts WHERE id = $1 AND tenant_id = $2 AND employee_id = $3 RETURNING id`,
    [scriptId, tenantId, employeeId],
  );
  return result.rows[0]?.id ?? null;
}

module.exports = {
  DEFAULT_TENANT_ID,
  ping,
  insertLead,
  findLeadById,
  findLeadByEmail,
  findLeadByPhone,
  listLeads,
  listAllLeads,
  findLeadsByIds,
  listAssignedNewLeadsForPipeline,
  updateLead,
  softDeleteLead,
  touchLeadActivity,
  insertQueueItem,
  listQueue,
  getQueuedItems,
  updateQueueItem,
  markQueueAssigned,
  getAssignmentConfig,
  createAssignmentConfig,
  saveAssignmentConfig,
  upsertAssignmentConfig,
  listActiveEmployees,
  listEmployees,
  findEmployeeById,
  findServiceByIdCode,
  findSopByIdCode,
  createEmployee,
  updateEmployee,
  incrementEmployeeLeads,
  insertAssignmentHistory,
  listAssignmentHistory,
  insertTimeline,
  listTimeline,
  insertAudit,
  listAudit,
  insertNotification,
  listNotifications,
  markNotificationsRead,
  notificationExists,
  insertNote,
  listNotes,
  insertCall,
  listCalls,
  listCallsForLead,
  findCallByCallyzerId,
  upsertCallyzerCall,
  insertTask,
  findTaskById,
  updateTask,
  listTasks,
  insertFollowup,
  findFollowupById,
  updateFollowup,
  listFollowups,
  listDueFollowups,
  insertMeeting,
  findMeetingById,
  updateMeeting,
  listMeetings,
  listTenantMeetings,
  listTenantCalls,
  insertFileAsset,
  listTeamAssets,
  insertCashCollection,
  listCashCollectionsByLead,
  listCashCollectionsByEmployee,
  sumCashByEmployee,
  sumCashByLead,
  sumCashByTenant,
  getAdminKpis,
  getPipelineGrouped,
  getLeaderboard,
  listWhatsAppScripts,
  findWhatsAppScriptById,
  insertWhatsAppScript,
  updateWhatsAppScript,
  deleteWhatsAppScript,
};
