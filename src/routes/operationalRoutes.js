const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const xlsx = require("xlsx");
const repo = require("../repositories/operationalRepo");
const privateContactsRepo = require("../repositories/privateContactsRepo");
const privateContactsController = require("../controllers/privateContactsController");
const { listAllSops } = require("../controllers/sopController");
const {
  validate,
  createLeadSchema,
  assignSchema,
  bulkAssignSchema,
  stageSchema,
  noteSchema,
  callSchema,
  followupSchema,
  taskSchema,
  meetingSchema,
  meetingPatchSchema,
  momSchema,
  cashCollectionSchema,
  whatsappScriptSchema,
  whatsappScriptPatchSchema,
} = require("../validators/operationalSchemas");
const pool = require("../../config/db");
const { queryCallStats } = require("../utils/employeeCallStats");
const { requirePg } = require("../middleware/pgReady");
const {
  isAdminUser,
  authenticatedEmployeeId,
  requireEmployee,
  requireEmployeeSelf,
  requireEmployeeSelfBody,
  scopeEmployeeQuery,
} = require("../middleware/auth");
const {
  tenant,
  actor,
  createLead,
  assignLead,
  bulkAssign,
  processAssignmentQueue,
  getOrCreateAssignmentConfig,
  updateLeadStage,
  addLeadNote,
  recordCall,
  scheduleFollowup,
  completeFollowup,
  createMeeting,
  addMom,
  getAdminKpis,
  getPipelineGrouped,
  writeTimeline,
  scheduleLeadAssignments,
} = require("../services/operationalServices");
const callyzer = require("../services/callyzerService");
const {
  buildPipelineBoardPayload,
  formatDbCallsForEmployee,
} = require("../services/pipelineBoardService");

const router = express.Router();
const uploadDir = path.join(process.cwd(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({
  dest: uploadDir,
  limits: { fileSize: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 * 1024) },
});

router.use(requirePg);

function ok(res, data, extra = {}) {
  return res.json({ success: true, ...extra, data });
}

function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function parseRange(req) {
  return {
    start: req.query.from || req.query.start,
    end: req.query.to || req.query.end,
  };
}

function denyUnlessSelfOrAdmin(req, res, ownerEmployeeId) {
  if (isAdminUser(req)) return true;
  const selfId = authenticatedEmployeeId(req);
  if (!selfId) {
    res.status(403).json({ success: false, message: "Employee account is not linked to a profile" });
    return false;
  }
  if (Number(ownerEmployeeId) !== selfId) {
    res.status(403).json({ success: false, message: "You can only access your own data" });
    return false;
  }
  return true;
}

async function leadAssignedEmployeeId(tenantId, leadId) {
  const lead = await repo.findLeadById(tenantId, leadId);
  if (!lead) return { lead: null, assignedId: null };
  const raw = lead.assignedTo?.id ?? lead.assignedTo;
  return { lead, assignedId: raw != null ? Number(raw) : null };
}

function requireEmployeeOwnsLead(paramName = "id") {
  return asyncRoute(async (req, res, next) => {
    if (isAdminUser(req)) return next();
    if (req.user?.role !== "employee") return next();
    const selfId = authenticatedEmployeeId(req);
    if (!selfId) {
      return res.status(403).json({ success: false, message: "Employee account is not linked to a profile" });
    }
    const { lead, assignedId } = await leadAssignedEmployeeId(tenant(req), req.params[paramName]);
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (assignedId !== selfId) {
      try {
        await repo.updateLead(tenant(req), lead.id, { assignedTo: selfId, assignmentStatus: "assigned" });
      } catch (e) {
        console.error("Failed auto-assignment of lead to employee on access:", e);
      }
    }
    return next();
  });
}

function requireEmployeeOwnsLeadBody(field = "leadId") {
  return asyncRoute(async (req, res, next) => {
    if (isAdminUser(req)) return next();
    if (req.user?.role !== "employee") return next();
    const selfId = authenticatedEmployeeId(req);
    if (!selfId) {
      return res.status(403).json({ success: false, message: "Employee account is not linked to a profile" });
    }
    const leadId = req.body?.[field];
    if (!leadId) return next();
    const { lead, assignedId } = await leadAssignedEmployeeId(tenant(req), leadId);
    if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
    if (assignedId !== selfId) {
      try {
        await repo.updateLead(tenant(req), lead.id, { assignedTo: selfId, assignmentStatus: "assigned" });
      } catch (e) {
        console.error("Failed auto-assignment of lead to employee on meeting creation:", e);
      }
    }
    return next();
  });
}

function scopeEmployeeLeadList(req) {
  if (isAdminUser(req)) return;
  if (req.user?.role !== "employee") return;
  const selfId = authenticatedEmployeeId(req);
  if (selfId) req.query.assignedTo = String(selfId);
}

router.post("/leads", validate(createLeadSchema), asyncRoute(async (req, res) => {
  const result = await createLead(req.body, { tenantId: tenant(req), actor: actor(req) });
  const lead = result?.lead || result;
  return ok(res, {
    ...(lead && typeof lead === "object" ? lead : {}),
    id: lead?.id,
    lead: result?.lead || lead,
    queueItem: result?.queueItem,
    isExisting: result?.isExisting,
  });
}));

router.post("/leads/bulk-upload", upload.single("file"), asyncRoute(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, message: "No file uploaded" });
  }

  try {
    const workbook = xlsx.readFile(req.file.path);
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) {
      return res.status(400).json({ success: false, message: "Spreadsheet has no sheets" });
    }
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { defval: "" });

    // Clean up temporary uploaded file asynchronously
    fs.unlink(req.file.path, (err) => {
      if (err) console.error("Failed to delete temp file:", err);
    });

    const successRows = [];
    const errorRows = [];

    // Helper mapping function to normalise sheet headers
    function mapRowToLead(row) {
      const data = {};
      for (const [key, val] of Object.entries(row)) {
        const normalizedKey = String(key).trim().toLowerCase().replace(/[\s_-]+/g, "");
        const cleanedVal = val !== undefined && val !== null ? String(val).trim() : "";
        if (cleanedVal === "") continue; // Skip empty cells to prevent overwriting
        
        if (["leadname", "name", "fullname", "contactname"].includes(normalizedKey)) {
          data.lead_name = cleanedVal;
        } else if (["phone", "phonenumber", "mobile", "contact", "contactnumber"].includes(normalizedKey)) {
          data.phone = cleanedVal;
        } else if (["email", "emailaddress", "mail"].includes(normalizedKey)) {
          data.email = cleanedVal;
        } else if (["city"].includes(normalizedKey)) {
          data.city = cleanedVal;
        } else if (["company", "companyname", "businessname", "business"].includes(normalizedKey)) {
          data.company_name = cleanedVal;
        } else if (["source", "leadsource", "channel"].includes(normalizedKey)) {
          data.source = cleanedVal;
        } else if (["service", "product", "formname", "requirements"].includes(normalizedKey)) {
          data.service = cleanedVal;
        } else if (["expectedrevenue", "revenue", "dealvalue", "deal_value"].includes(normalizedKey)) {
          data.expected_revenue = cleanedVal;
        } else if (["temperature", "warmth", "status"].includes(normalizedKey)) {
          data.temperature = cleanedVal;
        } else if (["pipelinestage", "stage"].includes(normalizedKey)) {
          data.pipeline_stage = cleanedVal;
        } else if (["winprobability", "winprob"].includes(normalizedKey)) {
          data.win_probability = cleanedVal;
        } else if (["notes", "description", "comments"].includes(normalizedKey)) {
          data.notes = cleanedVal;
        } else if (["country"].includes(normalizedKey)) {
          data.country = cleanedVal;
        } else if (["currency"].includes(normalizedKey)) {
          data.currency = cleanedVal;
        } else if (["priority"].includes(normalizedKey)) {
          data.priority = cleanedVal;
        }
      }
      return data;
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Skip completely empty rows
      if (Object.values(row).every(v => v === "")) continue;

      const leadData = mapRowToLead(row);
      const rowNum = i + 2; // Excel row index is 1-indexed, and row 1 is headers.

      if (!leadData.lead_name) {
        errorRows.push({ rowNum, error: "Missing 'Lead Name' column value" });
        continue;
      }

      try {
        const input = {
          leadName: leadData.lead_name,
          companyName: leadData.company_name || "",
          phone: leadData.phone || "",
          email: leadData.email || "",
          city: leadData.city || "",
          source: leadData.source || "manual",
          formName: leadData.service || "",
          form_name: leadData.service || "",
          temperature: leadData.temperature || "warm",
          pipelineStage: leadData.pipeline_stage || "new",
          status: leadData.pipeline_stage || "New Lead",
          winProbability: leadData.win_probability ? parseInt(leadData.win_probability) : 50,
          expectedRevenue: leadData.expected_revenue ? parseFloat(leadData.expected_revenue) : 0,
          requirements: leadData.service || "",
          notes: leadData.notes || "",
          priority: leadData.priority || "medium",
          country: leadData.country || "India",
          currency: leadData.currency || "INR",
          sourceMeta: {
            integration: "bulk_upload",
            channel: leadData.source || "manual",
            service: leadData.service || "",
          }
        };

        const result = await createLead(input, { tenantId: tenant(req), actor: actor(req), autoAssign: false });
        successRows.push({ rowNum, id: result.lead.id, name: leadData.lead_name });
      } catch (err) {
        errorRows.push({ rowNum, name: leadData.lead_name || `Row ${rowNum}`, error: err.message });
      }
    }

    if (successRows.length > 0) {
      try {
        await processAssignmentQueue(tenant(req), { limit: successRows.length, actor: actor(req) });
      } catch (assignErr) {
        console.error("Bulk upload auto-assignment queue error:", assignErr);
      }
    }

    return res.json({
      success: true,
      total: rows.length,
      successCount: successRows.length,
      errorCount: errorRows.length,
      successes: successRows,
      errors: errorRows,
    });
  } catch (err) {
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    console.error("Bulk upload error:", err);
    return res.status(500).json({ success: false, message: "Failed to process spreadsheet file: " + err.message });
  }
}));

router.get("/leads", asyncRoute(async (req, res) => {
  scopeEmployeeLeadList(req);
  const page = Math.max(Number(req.query.page || 1), 1);
  const defaultLimit = isAdminUser(req) ? 500 : 100;
  const maxLimit = isAdminUser(req) ? 5000 : 5000;
  const limit = Math.min(Math.max(Number(req.query.limit || defaultLimit), 1), maxLimit);
  const { items, total } = await repo.listLeads(
    tenant(req),
    {
      assignmentStatus: req.query.assignmentStatus,
      assignedTo: req.query.assignedTo,
      status: req.query.status,
      pipelineStage: req.query.stage,
      source: req.query.source,
      temperature: req.query.temperature,
      q: req.query.q,
    },
    { page, limit },
  );
  return ok(res, items, { page, limit, total });
}));

router.get("/leads/:id", requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const lead = await repo.findLeadById(tenant(req), req.params.id, { populate: true });
  if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
  return ok(res, lead);
}));

router.put("/leads/:id", requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const lead = await repo.updateLead(tenant(req), req.params.id, { ...req.body, lastActivityAt: new Date() });
  if (!lead) return res.status(404).json({ success: false, message: "Lead not found" });
  await writeTimeline({ tenantId: tenant(req), leadId: lead.id, type: "status_change", summary: "Lead updated", payload: req.body, actor: actor(req) });
  return ok(res, lead);
}));

router.delete("/leads/:id", asyncRoute(async (req, res) => {
  if (req.user?.role === "employee") {
    return res.status(403).json({ success: false, message: "Employees cannot delete leads" });
  }
  const lead = await repo.softDeleteLead(tenant(req), req.params.id);
  return ok(res, lead);
}));

router.get("/leads/:id/timeline", requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const events = await repo.listTimeline(tenant(req), { leadId: req.params.id, limit: Number(req.query.limit || 100) });
  return ok(res, events);
}));

router.patch("/leads/:id/stage", validate(stageSchema), requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const lead = await updateLeadStage({ tenantId: tenant(req), leadId: req.params.id, stage: req.body.stage, status: req.body.status, actor: actor(req) });
  return ok(res, lead);
}));

router.patch("/leads/:id/qualification", requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const lead = await repo.updateLead(tenant(req), req.params.id, { qualification: req.body, lastActivityAt: new Date() });
  await writeTimeline({ tenantId: tenant(req), leadId: req.params.id, type: "qualification", summary: "Qualification updated", payload: req.body, actor: actor(req) });
  return ok(res, lead);
}));

router.patch("/leads/:id/budget", requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const lead = await repo.updateLead(tenant(req), req.params.id, { budget: req.body, lastActivityAt: new Date() });
  await writeTimeline({ tenantId: tenant(req), leadId: req.params.id, type: "budget", summary: "Budget updated", payload: req.body, actor: actor(req) });
  return ok(res, lead);
}));

router.post("/leads/:id/notes", validate(noteSchema), requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const note = await addLeadNote({ tenantId: tenant(req), leadId: req.params.id, body: req.body.body, actor: actor(req) });
  return ok(res, note);
}));

router.get("/leads/:id/notes", requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const notes = await repo.listNotes(tenant(req), req.params.id);
  return ok(res, notes);
}));

router.get("/leads/:id/calls", requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const lead = await repo.findLeadById(tenantId, req.params.id);
  if (!lead) {
    return res.status(404).json({ success: false, message: "Lead not found" });
  }
  const limit = Number(req.query.limit) || 200;
  const dbCalls = await repo.listCallsForLead(tenantId, lead, { limit });
  const calls = formatDbCallsForEmployee(dbCalls, [lead]);
  return ok(res, calls, { total: calls.length });
}));

router.get("/leads/:id/cash-collections", requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const items = await repo.listCashCollectionsByLead(tenant(req), req.params.id);
  const total = await repo.sumCashByLead(tenant(req), req.params.id);
  return ok(res, items, { total });
}));

router.post("/leads/:id/cash-collections", upload.single("slip"), requireEmployeeOwnsLead(), asyncRoute(async (req, res) => {
  const body = {
    amount: req.body.amount,
    paymentMode: req.body.paymentMode || req.body.payment_mode,
    paymentAt: req.body.paymentAt || req.body.payment_at,
    transactionId: req.body.transactionId || req.body.transaction_id,
    notes: req.body.notes,
    employeeId: req.body.employeeId || req.body.employee_id,
    currency: req.body.currency,
  };

  const parsed = cashCollectionSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({
      success: false,
      message: "Validation failed",
      errors: parsed.error.flatten(),
    });
  }

  const data = parsed.data;
  const transactionId = (data.transactionId || data.transaction_id || "").trim();
  const hasSlip = Boolean(req.file);
  if (!transactionId && !hasSlip) {
    return res.status(400).json({
      success: false,
      message: "Provide a transaction ID or upload a payment slip",
    });
  }

  const { lead, assignedId } = await leadAssignedEmployeeId(tenant(req), req.params.id);
  if (!lead) {
    return res.status(404).json({ success: false, message: "Lead not found" });
  }

  const employeeId = data.employeeId || data.employee_id || assignedId || authenticatedEmployeeId(req);
  const paymentAt = data.paymentAt || data.payment_at || new Date();
  const slipUrl = req.file ? `/uploads/${req.file.filename}` : null;
  const slipFilename = req.file ? req.file.originalname : null;

  const record = await repo.insertCashCollection({
    tenantId: tenant(req),
    leadId: Number(req.params.id),
    employeeId: employeeId ? Number(employeeId) : null,
    amount: data.amount,
    currency: data.currency || "INR",
    paymentMode: data.paymentMode || data.payment_mode,
    paymentAt,
    transactionId: transactionId || null,
    slipUrl,
    slipFilename,
    notes: data.notes || null,
    recordedBy: actor(req).actorName || actor(req).actorId,
  });

  await writeTimeline({
    tenantId: tenant(req),
    leadId: req.params.id,
    type: "payment",
    summary: `Cash collected: ₹${Number(data.amount).toLocaleString("en-IN")} via ${data.paymentMode || data.payment_mode}`,
    payload: { amount: data.amount, paymentMode: data.paymentMode || data.payment_mode, transactionId: transactionId || null },
    actor: actor(req),
  });

  const total = await repo.sumCashByLead(tenant(req), req.params.id);
  return ok(res, record, { total });
}));

router.get("/leads-queue", asyncRoute(async (req, res) => {
  const items = await repo.listQueue(tenant(req), { status: req.query.status });
  return ok(res, items);
}));

router.get("/assignment/config", asyncRoute(async (req, res) => {
  const config = await getOrCreateAssignmentConfig(tenant(req));
  return ok(res, config);
}));

router.put("/assignment/config", asyncRoute(async (req, res) => {
  const config = await repo.upsertAssignmentConfig(tenant(req), req.body);
  return ok(res, config);
}));

router.post("/assignment/assign", validate(assignSchema), asyncRoute(async (req, res) => {
  if (req.user?.role === "employee") {
    req.body.employeeId = authenticatedEmployeeId(req);
  }
  const lead = await assignLead({
    tenantId: tenant(req),
    leadId: req.body.leadId,
    employeeId: req.body.employeeId,
    method: req.body.method || "manual",
    reason: req.body.reason,
    performedBy: actor(req).actorId,
    actor: actor(req),
  });
  return ok(res, lead);
}));

router.post("/assignment/bulk-assign", validate(bulkAssignSchema), asyncRoute(async (req, res) => {
  if (req.user?.role === "employee") {
    return res.status(403).json({ success: false, message: "Only admins can bulk-assign leads" });
  }
  const results = await bulkAssign({
    tenantId: tenant(req),
    leadIds: req.body.leadIds,
    employeeId: req.body.employeeId,
    method: req.body.method || "bulk",
    actor: actor(req),
  });
  return ok(res, results, { count: results.length });
}));

router.post("/assignment/schedule-assign", asyncRoute(async (req, res) => {
  if (req.user?.role === "employee") {
    return res.status(403).json({ success: false, message: "Only admins can schedule lead assignments" });
  }
  const { leadIds, employeeId, startDate, leadsPerDay } = req.body;
  if (!leadIds || !employeeId || !startDate || !leadsPerDay) {
    return res.status(400).json({ success: false, message: "Missing required fields: leadIds, employeeId, startDate, leadsPerDay" });
  }
  const result = await scheduleLeadAssignments({
    tenantId: tenant(req),
    leadIds,
    employeeId,
    startDate,
    leadsPerDay,
    actor: actor(req),
  });
  return ok(res, result);
}));

router.post("/assignment/run-round-robin", asyncRoute(async (req, res) => {
  const result = await processAssignmentQueue(tenant(req), { limit: req.body.limit, actor: actor(req) });
  return ok(res, result);
}));

router.post("/assignment/employees/:id/pause", asyncRoute(async (req, res) => {
  const employee = await repo.updateEmployee(tenant(req), req.params.id, { receivingPaused: true });
  return ok(res, employee);
}));

router.post("/assignment/employees/:id/resume", asyncRoute(async (req, res) => {
  const employee = await repo.updateEmployee(tenant(req), req.params.id, { receivingPaused: false });
  return ok(res, employee);
}));

router.get("/assignment/audit", asyncRoute(async (req, res) => {
  const items = await repo.listAssignmentHistory(tenant(req), Number(req.query.limit || 200));
  return ok(res, items);
}));

router.get("/employees", asyncRoute(async (req, res) => {
  const employees = await repo.listEmployees(tenant(req), { status: req.query.status, q: req.query.q });
  return ok(res, employees);
}));

router.post("/employees", asyncRoute(async (req, res) => {
  const employee = await repo.createEmployee(tenant(req), req.body);
  return ok(res, employee);
}));

router.put("/employees/:id", asyncRoute(async (req, res) => {
  const employee = await repo.updateEmployee(tenant(req), req.params.id, req.body);
  return ok(res, employee);
}));

router.delete("/employees/:id", asyncRoute(async (req, res) => {
  const employee = await repo.updateEmployee(tenant(req), req.params.id, { status: "inactive" });
  return ok(res, employee);
}));

router.get("/employees/:id/leads", requireEmployeeSelf("id"), asyncRoute(async (req, res) => {
  const { items, total } = await repo.listAllLeads(tenant(req), { assignedTo: req.params.id });
  return ok(res, items, { total });
}));

router.get("/employees/:id/cash-collections", requireEmployeeSelf("id"), asyncRoute(async (req, res) => {
  const items = await repo.listCashCollectionsByEmployee(tenant(req), req.params.id);
  const total = await repo.sumCashByEmployee(tenant(req), req.params.id);
  return ok(res, items, { total });
}));

router.get("/employee/:employeeId/private-contacts", requireEmployeeSelf("employeeId"), privateContactsController.getPrivateContacts);
router.post("/employee/:employeeId/private-contacts", requireEmployeeSelf("employeeId"), privateContactsController.createPrivateContact);
router.delete("/employee/:employeeId/private-contacts/:id", requireEmployeeSelf("employeeId"), privateContactsController.removePrivateContact);

router.get("/employees/:employeeId/private-contacts", requireEmployeeSelf("employeeId"), privateContactsController.getPrivateContacts);
router.post("/employees/:employeeId/private-contacts", requireEmployeeSelf("employeeId"), privateContactsController.createPrivateContact);
router.delete("/employees/:employeeId/private-contacts/:id", requireEmployeeSelf("employeeId"), privateContactsController.removePrivateContact);

router.get("/sops", asyncRoute(async (req, res) => {
  const sops = await listAllSops();
  return ok(res, sops);
}));

function scheduleBackgroundCallyzerSync(tenantId, employee, dbCalls, leads) {
  if (!callyzer.isConfigured() || !employee) return;
  const days = Number(process.env.CALLYZER_HISTORY_DAYS || 30);
  callyzer.getCallsForEmployee(tenantId, employee, { dbCalls, leads, days }).catch(() => {
    /* background sync — failures are non-blocking */
  });
}

async function loadEmployeeDashboard(tenantId, employeeId, { syncCallyzer = false } = {}) {
  const [employee, leadsResult, tasks, followups, dbCalls, meetings, sops] = await Promise.all([
    repo.findEmployeeById(tenantId, employeeId),
    repo.listAllLeads(tenantId, { assignedTo: employeeId }),
    repo.listTasks(tenantId, { assigneeId: employeeId, limit: 20 }),
    repo.listFollowups(tenantId, employeeId),
    repo.listCalls(tenantId, employeeId),
    repo.listMeetings(tenantId, employeeId),
    listAllSops().catch(() => []),
  ]);
  const leads = leadsResult.items;
  let calls = formatDbCallsForEmployee(dbCalls.slice(0, 500), leads);

  if (syncCallyzer && callyzer.isConfigured() && employee) {
    await callyzer.getCallsForEmployee(tenantId, employee, {
      dbCalls,
      leads,
      days: Number(process.env.CALLYZER_HISTORY_DAYS || 30),
    });
    const refreshed = await repo.listCalls(tenantId, employeeId, { limit: 500 });
    calls = formatDbCallsForEmployee(refreshed, leads);
  } else {
    scheduleBackgroundCallyzerSync(tenantId, employee, dbCalls, leads);
  }
  return {
    employee,
    leads,
    tasks: tasks.slice(0, 20),
    followups: followups.slice(0, 20),
    calls,
    meetings,
    sops,
    integrations: {
      callyzer: callyzer.isConfigured(),
    },
  };
}

router.get("/employee/me/dashboard", requireEmployee, asyncRoute(async (req, res) => {
  const employeeId = authenticatedEmployeeId(req);
  if (!employeeId) {
    return res.status(403).json({ success: false, message: "Employee account is not linked to a profile" });
  }
  const syncCallyzer = req.query.syncCallyzer === "1" || req.query.sync === "1";
  const payload = await loadEmployeeDashboard(tenant(req), employeeId, { syncCallyzer });
  return ok(res, payload);
}));

router.get("/employee/:employeeId/dashboard", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const syncCallyzer = req.query.syncCallyzer === "1" || req.query.sync === "1";
  const payload = await loadEmployeeDashboard(tenant(req), req.params.employeeId, { syncCallyzer });
  return ok(res, payload);
}));

router.get("/employee/:employeeId/leads", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const filters = {
    assignedTo: req.params.employeeId,
    status: req.query.status,
    temperature: req.query.temperature,
  };
  if (req.query.page || req.query.limit) {
    const page = Math.max(Number(req.query.page || 1), 1);
    const limit = Math.min(Math.max(Number(req.query.limit || 500), 1), 5000);
    const { items, total } = await repo.listLeads(tenant(req), filters, { page, limit });
    return ok(res, items, { page, limit, total });
  }
  const { items, total } = await repo.listAllLeads(tenant(req), filters);
  return ok(res, items, { total });
}));

router.get("/employee/:employeeId/tasks", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const tasks = await repo.listTasks(tenant(req), { assigneeId: req.params.employeeId, status: req.query.status });
  return ok(res, tasks);
}));

router.post("/employee/tasks", validate(taskSchema), requireEmployeeSelfBody("assigneeId"), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const assignee = await repo.findEmployeeById(tenantId, req.body.assigneeId);
  if (!assignee) {
    return res.status(400).json({
      success: false,
      message: `Employee ${req.body.assigneeId} not found. Add employees in Team or run DB seed.`,
    });
  }
  const task = await repo.insertTask({ tenantId, ...req.body });
  if (!task?.id) {
    return res.status(500).json({ success: false, message: "Task insert failed — no id returned" });
  }
  return ok(res, task);
}));

router.patch("/employee/tasks/:id", asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const existing = await repo.findTaskById(tenantId, req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: "Task not found" });
  if (!denyUnlessSelfOrAdmin(req, res, existing.assigneeId)) return;
  const patch = { ...req.body };
  if (patch.status === "done" && !patch.completedAt) patch.completedAt = new Date();
  const task = await repo.updateTask(tenantId, req.params.id, patch);
  return ok(res, task);
}));

router.post("/employee/calls", validate(callSchema), requireEmployeeSelfBody("employeeId"), requireEmployeeOwnsLeadBody("leadId"), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const [lead, employee] = await Promise.all([
    repo.findLeadById(tenantId, req.body.leadId),
    repo.findEmployeeById(tenantId, req.body.employeeId),
  ]);
  if (!lead) {
    return res.status(400).json({ success: false, message: `Lead ${req.body.leadId} not found` });
  }
  if (!employee) {
    return res.status(400).json({ success: false, message: `Employee ${req.body.employeeId} not found` });
  }
  const call = await recordCall({ tenantId, data: req.body, actor: actor(req) });
  // Fire AI MoM generation immediately in background for every new call
  if (call?.id) {
    const { processCallWithAi } = require("../services/aiService");
    processCallWithAi(tenantId, call.id).catch((err) => {
      logger.warn("Auto AI processing failed for manual call", { callId: call.id, error: err.message });
    });
  }
  return ok(res, call);
}));

router.put("/employee/calls/:id", asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const callId = req.params.id;
  const { leadId, notes, aiSummary, rating } = req.body;
  
  if (leadId) {
    const lead = await repo.findLeadById(tenantId, leadId);
    if (!lead) {
      return res.status(400).json({ success: false, message: "Lead not found" });
    }
  }

  await pool.query(
    `UPDATE employee_calls 
     SET lead_id = COALESCE($1, lead_id),
         notes = COALESCE($2, notes),
         ai_summary = COALESCE($3, ai_summary),
         rating = COALESCE($4, rating)
     WHERE tenant_id = $5 AND id = $6`,
    [leadId || null, notes || null, aiSummary || null, rating !== undefined ? rating : null, tenantId, callId]
  );
  return ok(res, { success: true });
}));

router.post("/employee/callyzer/start-call", requireEmployeeSelfBody("employeeId"), requireEmployeeOwnsLeadBody("leadId"), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const [lead, employee] = await Promise.all([
    repo.findLeadById(tenantId, req.body.leadId),
    repo.findEmployeeById(tenantId, req.body.employeeId),
  ]);
  if (!lead) {
    return res.status(404).json({ success: false, message: "Lead not found" });
  }
  if (!employee) {
    return res.status(404).json({ success: false, message: "Employee not found" });
  }
  if (!lead.phone) {
    return res.status(400).json({ success: false, message: "Lead phone number is required before calling" });
  }

  const session = await callyzer.prepareLeadCall({ lead, employee });
  const sourceMeta = {
    ...(lead.sourceMeta || {}),
    callyzerLeadId: session.callyzerLeadId || lead.sourceMeta?.callyzerLeadId || null,
    lastCallyzerDialAt: session.startedAt,
    lastCallyzerDialBy: employee.id,
  };
  await repo.updateLead(tenantId, lead.id, { sourceMeta });

  return ok(res, {
    ...session,
    leadName: lead.leadName,
    message: "Lead synced to Callyzer. Place the call from your phone — Callyzer will record it under this lead.",
  });
}));

router.get("/employee/:employeeId/calls", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const employeeId = req.params.employeeId;
  const period = String(req.query.period || "all").toLowerCase();
  const limit = Number(req.query.limit) || Number(process.env.EMPLOYEE_CALLS_MAX || 10000);
  const [employee, leadsResult] = await Promise.all([
    repo.findEmployeeById(tenantId, employeeId),
    repo.listAllLeads(tenantId, { assignedTo: employeeId }),
  ]);
  const leads = leadsResult.items;
  const syncCallyzer = req.query.sync === "1" || req.query.syncCallyzer === "1";

  if (syncCallyzer && callyzer.isConfigured() && employee) {
    const allDbCalls = await repo.listCalls(tenantId, employeeId);
    await callyzer.getCallsForEmployee(tenantId, employee, {
      dbCalls: allDbCalls,
      leads,
      days: Number(req.query.days || process.env.CALLYZER_HISTORY_DAYS || 30),
    });
  }

  const dbCalls = await repo.listCalls(tenantId, employeeId, { period, limit });
  const calls = formatDbCallsForEmployee(dbCalls, leads);
  return ok(res, calls, { total: calls.length, period: period === "all" ? null : period });
}));

router.get("/pipeline/board", asyncRoute(async (req, res) => {
  if (!isAdminUser(req)) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  const tenantId = tenant(req);
  const period = String(req.query.period || "month").toLowerCase();
  const limit = Number(req.query.limit) || 5000;

  const leadsResult = await repo.listAllLeads(tenantId, {}, { pageSize: 2000, maxPages: 10 });

  if (req.query.sync === "1" && callyzer.isConfigured()) {
    const employees = await repo.listActiveEmployees(tenantId);
    const syncDays = Number(process.env.CALLYZER_HISTORY_DAYS || 30);
    const batchSize = 2;
    for (let i = 0; i < employees.length; i += batchSize) {
      const batch = employees.slice(i, i + batchSize);
      await Promise.all(batch.map(async (employee) => {
        const dbCalls = await repo.listCalls(tenantId, employee.id, { limit: 500 });
        await callyzer.syncEmployeeCallsIfStale(tenantId, employee, {
          dbCalls,
          leads: leadsResult.items,
          days: syncDays,
          force: true,
        });
      }));
    }
  }

  const payload = await buildPipelineBoardPayload(tenantId, {
    period,
    limit,
    attachLeads: leadsResult.items,
  });
  return ok(res, payload, { syncedAt: new Date().toISOString() });
}));

router.get("/employee/:employeeId/pipeline/board", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const employeeId = req.params.employeeId;
  const period = String(req.query.period || "month").toLowerCase();
  const limit = Number(req.query.limit) || 5000;

  const employee = await repo.findEmployeeById(tenantId, employeeId);
  let employeeLeads = [];
  if (employeeId != null) {
    const { items } = await repo.listAllLeads(tenantId, { assignedTo: employeeId }, { pageSize: 2000, maxPages: 10 });
    employeeLeads = items;
  }

  // Only sync when explicitly requested — period toggles use sync=0 for fast DB reads.
  if (req.query.sync === "1" && employee && callyzer.isConfigured()) {
    const dbCalls = await repo.listCalls(tenantId, employeeId, { limit: 500 });
    const leadsForSync = employeeLeads.length
      ? employeeLeads
      : (await repo.listAllLeads(tenantId, { assignedTo: employeeId }, { pageSize: 2000, maxPages: 10 })).items;
    await callyzer.getCallsForEmployee(tenantId, employee, {
      dbCalls,
      leads: leadsForSync,
      days: Number(process.env.CALLYZER_HISTORY_DAYS || 30),
    });
  }

  const payload = await buildPipelineBoardPayload(tenantId, {
    period,
    employeeId,
    limit,
    attachLeads: employeeLeads,
  });
  return ok(res, payload, { syncedAt: new Date().toISOString() });
}));

router.get("/calls", asyncRoute(async (req, res) => {
  if (!isAdminUser(req)) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  const tenantId = tenant(req);
  const period = String(req.query.period || "month").toLowerCase();
  const limit = Number(req.query.limit) || Number(process.env.EMPLOYEE_CALLS_MAX || 10000);
  const shouldSync = req.query.sync === "1";

  const { items: leads } = await repo.listAllLeads(tenantId, {}, { pageSize: 500, maxPages: 40 });

  if (shouldSync && callyzer.isConfigured()) {
    const employees = await repo.listActiveEmployees(tenantId);
    const syncDays = Number(process.env.CALLYZER_HISTORY_DAYS || 30);
    await Promise.all(
      employees.map(async (employee) => {
        const dbCalls = await repo.listCalls(tenantId, employee.id, { limit: 500 });
        await callyzer.syncEmployeeCallsIfStale(tenantId, employee, {
          dbCalls,
          leads,
          days: syncDays,
          force: true,
        });
      }),
    );
  }

  const dbCalls = await repo.listTenantCalls(tenantId, { period, limit });
  const calls = formatDbCallsForEmployee(dbCalls, leads);
  return ok(res, calls, { total: calls.length, period: period === "all" ? null : period });
}));

router.get("/meetings", asyncRoute(async (req, res) => {
  if (!isAdminUser(req)) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  const meetings = await repo.listTenantMeetings(tenant(req));
  return ok(res, meetings);
}));

router.get("/callyzer/stats", asyncRoute(async (req, res) => {
  if (!isAdminUser(req)) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  const tenantId = tenant(req);
  const month = req.query.month;
  const period = String(req.query.period || "month").toLowerCase();
  const stats = await queryCallStats(pool, { tenantId, period, month });
  return ok(res, {
    success: true,
    configured: true,
    syncedAt: new Date().toISOString(),
    stats,
    period: month || period,
  });
}));

router.get("/employee/:employeeId/callyzer/stats", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const employeeId = req.params.employeeId;
  const month = req.query.month; // e.g. "2026-07"
  const period = String(req.query.period || "today").toLowerCase();
  const shouldSync = req.query.sync !== "0";

  let synced = false;
  if (shouldSync && callyzer.isConfigured()) {
    const [employee, dbCalls, leadsResult] = await Promise.all([
      repo.findEmployeeById(tenantId, employeeId),
      repo.listCalls(tenantId, employeeId),
      repo.listAllLeads(tenantId, { assignedTo: employeeId }),
    ]);
    if (employee) {
      synced = await callyzer.syncEmployeeCallsIfStale(tenantId, employee, {
        dbCalls,
        leads: leadsResult.items,
        days: Number(req.query.days || process.env.CALLYZER_HISTORY_DAYS || 30),
        force: req.query.force === "1",
      });
    }
  }

  const stats = await queryCallStats(pool, { tenantId, employeeId, period, month });

  return ok(res, {
    success: true,
    configured: true,
    synced,
    syncedAt: new Date().toISOString(),
    stats,
    period: month || period,
  });
}));

router.post("/employee/followups", validate(followupSchema), requireEmployeeSelfBody("employeeId"), requireEmployeeOwnsLeadBody("leadId"), asyncRoute(async (req, res) => {
  const followup = await scheduleFollowup({ tenantId: tenant(req), data: req.body, actor: actor(req) });
  return ok(res, followup);
}));

router.patch("/employee/followups/:id/complete", asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const existing = await repo.findFollowupById(tenantId, req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: "Follow-up not found" });
  if (!denyUnlessSelfOrAdmin(req, res, existing.employeeId)) return;
  const followup = await completeFollowup({ tenantId, followupId: req.params.id, actor: actor(req) });
  return ok(res, followup);
}));

router.get("/employee/:employeeId/followups", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const followups = await repo.listFollowups(tenant(req), req.params.employeeId);
  return ok(res, followups);
}));

router.get("/employee/:employeeId/whatsapp-scripts", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const includeInactive = req.query.includeInactive === "1" || req.query.all === "1";
  const scripts = await repo.listWhatsAppScripts(tenant(req), req.params.employeeId, { includeInactive });
  return ok(res, scripts);
}));

router.post("/employee/:employeeId/whatsapp-scripts", requireEmployeeSelf(), validate(whatsappScriptSchema), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const employeeId = Number(req.params.employeeId);
  const employee = await repo.findEmployeeById(tenantId, employeeId);
  if (!employee) {
    return res.status(400).json({ success: false, message: "Employee not found" });
  }
  const script = await repo.insertWhatsAppScript({
    tenantId,
    employeeId,
    title: req.body.title.trim(),
    body: req.body.body.trim(),
    category: req.body.category?.trim() || "General",
    isActive: req.body.isActive !== false,
  });
  return ok(res, script);
}));

router.patch("/employee/whatsapp-scripts/:id", validate(whatsappScriptPatchSchema), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const scriptId = Number(req.params.id);
  const existing = await repo.findWhatsAppScriptById(tenantId, scriptId);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Script not found" });
  }
  if (!denyUnlessSelfOrAdmin(req, res, existing.employeeId)) return;
  const script = await repo.updateWhatsAppScript(tenantId, scriptId, existing.employeeId, req.body);
  return ok(res, script);
}));

router.delete("/employee/whatsapp-scripts/:id", asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const scriptId = Number(req.params.id);
  const existing = await repo.findWhatsAppScriptById(tenantId, scriptId);
  if (!existing) {
    return res.status(404).json({ success: false, message: "Script not found" });
  }
  if (!denyUnlessSelfOrAdmin(req, res, existing.employeeId)) return;
  await repo.deleteWhatsAppScript(tenantId, scriptId, existing.employeeId);
  return ok(res, { id: scriptId });
}));

router.post("/employee/meetings", validate(meetingSchema), requireEmployeeSelfBody("employeeId"), requireEmployeeOwnsLeadBody("leadId"), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const [lead, employee] = await Promise.all([
    repo.findLeadById(tenantId, req.body.leadId),
    repo.findEmployeeById(tenantId, req.body.employeeId),
  ]);
  if (!lead) {
    return res.status(400).json({ success: false, message: `Lead ${req.body.leadId} not found` });
  }
  if (!employee) {
    return res.status(400).json({ success: false, message: `Employee ${req.body.employeeId} not found` });
  }
  const meeting = await createMeeting({ tenantId, data: req.body, actor: actor(req) });
  if (!meeting?.id) {
    return res.status(500).json({ success: false, message: "Meeting insert failed — no id returned" });
  }
  return ok(res, meeting);
}));

router.patch("/employee/meetings/:id", validate(meetingPatchSchema), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const existing = await repo.findMeetingById(tenantId, req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: "Meeting not found" });
  if (!denyUnlessSelfOrAdmin(req, res, existing.employeeId)) return;
  const meeting = await repo.updateMeeting(tenantId, req.params.id, req.body);
  if (!meeting) return res.status(404).json({ success: false, message: "Meeting not found" });
  return ok(res, meeting);
}));

router.patch("/employee/meetings/:id/mom", validate(momSchema), asyncRoute(async (req, res) => {
  const tenantId = tenant(req);
  const existing = await repo.findMeetingById(tenantId, req.params.id);
  if (!existing) return res.status(404).json({ success: false, message: "Meeting not found" });
  if (!denyUnlessSelfOrAdmin(req, res, existing.employeeId)) return;
  const meeting = await addMom({ tenantId, meetingId: req.params.id, mom: req.body, actor: actor(req) });
  return ok(res, meeting);
}));

router.get("/employee/:employeeId/meetings", requireEmployeeSelf(), asyncRoute(async (req, res) => {
  const meetings = await repo.listMeetings(tenant(req), req.params.employeeId);
  return ok(res, meetings);
}));

router.get("/analytics/admin/kpis", asyncRoute(async (req, res) => {
  const data = await getAdminKpis(tenant(req), parseRange(req));
  return ok(res, data);
}));

router.get("/analytics/pipeline", asyncRoute(async (req, res) => {
  const data = await getPipelineGrouped(tenant(req), req.query);
  return ok(res, data);
}));

router.get("/analytics/leaderboard", asyncRoute(async (req, res) => {
  const rows = await repo.getLeaderboard(tenant(req), Number(req.query.limit || 10));
  return ok(res, rows);
}));

router.get("/notifications", scopeEmployeeQuery("employeeId"), asyncRoute(async (req, res) => {
  const items = await repo.listNotifications(
    tenant(req),
    { employeeId: req.query.employeeId, unread: req.query.unread === "true" },
    Number(req.query.limit || 50),
  );
  return ok(res, items);
}));

router.post("/notifications/read", scopeEmployeeQuery("employeeId"), asyncRoute(async (req, res) => {
  await repo.markNotificationsRead(tenant(req), { ids: req.body.ids, employeeId: req.body.employeeId });
  return ok(res, { read: true });
}));

router.get("/activity/timeline", asyncRoute(async (req, res) => {
  const items = await repo.listTimeline(tenant(req), { leadId: req.query.leadId, limit: Number(req.query.limit || 100) });
  return ok(res, items);
}));

router.get("/audit", asyncRoute(async (req, res) => {
  const items = await repo.listAudit(tenant(req), Number(req.query.limit || 200));
  return ok(res, items);
}));

router.post("/webhooks/n8n", asyncRoute(async (req, res) => {
  const body = req.body || {};
  const leadName = body.leadName || body.lead_name || body.name || body.fullName;
  const phone = body.phone || body.phone_number || body.mobile || body.contact;
  const email = body.email || body.email_address || body.mail;
  const employeeId = body.employeeId || body.employee_id || body.employeePhone;
  const serviceId = body.serviceId || body.service_id;
  const sopId = body.sopId || body.sop_id;

  const missingFields = [];
  if (!leadName) missingFields.push("leadName");
  if (!phone) missingFields.push("phone");
  if (!email) missingFields.push("email");
  if (!employeeId) missingFields.push("employeeId");
  if (!serviceId) missingFields.push("serviceId");
  if (!sopId) missingFields.push("sopId");

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      message: `Missing required n8n webhook fields: ${missingFields.join(", ")}`,
      missingFields,
      requiredFields: ["leadName", "phone", "email", "employeeId", "serviceId", "sopId"],
    });
  }

  const rawSource = body.source && body.source !== "n8n" ? body.source : (body.utm_source || body.channel || body.source || "n8n");
  const channel = body.channel || body.utm_source || rawSource;

  const result = await createLead(
    {
      ...body,
      source: rawSource,
      channel,
      sourceMeta: {
        integration: "n8n",
        channel,
        ...(typeof body === "object" && body ? body : {}),
      },
    },
    { tenantId: tenant(req), actor: { actorId: "webhook:n8n", actorName: "n8n Webhook", actorRole: "integration" } },
  );
  return res.status(202).json({ success: true, leadId: result?.lead?.id || null, queueId: result?.queueItem?.id || null, isExisting: Boolean(result?.isExisting) });
}));

router.post("/webhooks/callyzer", asyncRoute(async (req, res) => {
  if (!callyzer.verifyWebhookSecret(req)) {
    return res.status(401).json({ success: false, message: "Invalid webhook secret" });
  }

  const tenantId = process.env.CALLYZER_TENANT_ID || "default";
  const payloads = Array.isArray(req.body) ? req.body : [req.body];
  const employees = await repo.listEmployees(tenantId);
  let synced = 0;
  let skipped = 0;

  for (const block of payloads) {
    const employee = employees.find((emp) => callyzer.employeeMatchesWebhook(emp, block));
    if (!employee) {
      skipped += Array.isArray(block.call_logs) ? block.call_logs.length : 0;
      continue;
    }

    const { items: assignedLeads } = await repo.listAllLeads(
      tenantId,
      { assignedTo: employee.id },
    );
    const phoneIndex = callyzer.buildLeadPhoneIndex(assignedLeads);

    const logs = Array.isArray(block.call_logs) ? block.call_logs : [];
    for (const log of logs) {
      if (!log?.id) continue;

      // Privacy Check: Exclude calls to/from employee's private contacts
      const clientPhoneDigits = String(log.client_number || "").replace(/\D/g, "").slice(-10);
      if (clientPhoneDigits && await privateContactsRepo.isPhonePrivateForEmployee(tenantId, employee.id, clientPhoneDigits)) {
        skipped += 1;
        continue; // Strictly discard private calls
      }

      let lead = callyzer.findLeadForClient(assignedLeads, log.client_country_code, log.client_number);
      if (!lead) {
        lead = await repo.findLeadByPhone(tenantId, log.client_number, { assignedTo: employee.id });
      }

      if (!lead) {
        const clientPhone = callyzer.normalizePhone(log.client_country_code, log.client_number).full || log.client_number;
        const leadName = log.client_name || "Unknown Lead";

        const existingLead = await repo.findLeadByPhone(tenantId, clientPhone);
        if (existingLead) {
          lead = existingLead;
        } else {
          try {
            const { lead: newLead } = await createLead({
              leadName,
              phone: clientPhone,
              source: "Callyzer",
              temperature: "warm",
              assignedTo: employee.id,
            }, { tenantId, autoAssign: false, actor: { actorId: `employee:${employee.id}`, actorName: employee.name, actorRole: "employee" } });
            lead = newLead;
          } catch (e) {
            console.error("Failed to auto-create lead in webhook", e);
          }
        }
      }

      const leadId = lead?.id || callyzer.resolveLeadIdForLog(log, assignedLeads, phoneIndex);
      const mapped = callyzer.mapLogToCall(log, employee.id, leadId);
      try {
      const savedCall = await repo.upsertCallyzerCall({
          tenantId,
          leadId: mapped.leadId,
          employeeId: employee.id,
          callyzerCallId: mapped.callyzerCallId,
          direction: mapped.direction,
          outcome: mapped.outcome,
          durationSec: mapped.durationSec,
          startedAt: mapped.startedAt,
          endedAt: mapped.endedAt,
          recordingUrl: mapped.recordingUrl,
          notes: mapped.notes,
          aiSummary: mapped.aiSummary,
        });
        // Fire AI MoM immediately for every call (real MoM if recording, "No recording" if not)
        if (savedCall?.id) {
          const { processCallWithAi } = require("../services/aiService");
          processCallWithAi(tenantId, savedCall.id).catch((err) => {
            logger.warn("Auto AI processing failed for webhook call", { callId: savedCall.id, error: err.message });
          });
        }
        synced += 1;
      } catch {
        skipped += 1;
      }
    }
  }

  return res.status(200).json({ success: true, synced, skipped });
}));

router.get("/callyzer/status", asyncRoute(async (req, res) => {
  if (!isAdminUser(req)) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  return ok(res, {
    configured: callyzer.isConfigured(),
    webhookUrl: "/api/v1/webhooks/callyzer",
  });
}));

router.get("/callyzer/team-stats", asyncRoute(async (req, res) => {
  if (!isAdminUser(req)) {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  if (!callyzer.isConfigured()) {
    return ok(res, { configured: false, stats: [], message: "Callyzer API key not configured" });
  }
  const period = String(req.query.period || "today").toLowerCase();
  try {
    const stats = await callyzer.fetchTeamSummary(period);
    return ok(res, { configured: true, period, stats });
  } catch (err) {
    return res.status(502).json({ success: false, message: err.message || "Could not fetch Callyzer team stats" });
  }
}));

router.post("/webhooks/forms/:formId/submit", validate(createLeadSchema), asyncRoute(async (req, res) => {
  const result = await createLead(
    { ...req.body, source: "form", sourceMeta: { formId: req.params.formId, rawPayload: req.body } },
    { tenantId: tenant(req), actor: { actorId: `form:${req.params.formId}`, actorName: "Website Form", actorRole: "integration" } },
  );
  return res.status(202).json({ success: true, leadId: result?.lead?.id || null, queueId: result?.queueItem?.id || null, isExisting: Boolean(result?.isExisting) });
}));

/** Shared team assets — visible to every employee in the tenant. */
router.get("/assets", asyncRoute(async (req, res) => {
  const items = await repo.listTeamAssets(tenant(req));
  return ok(res, items);
}));

function optionalAssetUpload(req, res, next) {
  if (req.is("multipart/form-data")) {
    return upload.single("file")(req, res, next);
  }
  return next();
}

router.post("/assets", optionalAssetUpload, asyncRoute(async (req, res) => {
  const category = String(req.body.category || req.body.cat || "brochure").trim() || "brochure";
  const displayName = String(req.body.name || req.body.displayName || "").trim();
  const uploader = actor(req);

  if (req.file) {
    const asset = await repo.insertFileAsset({
      tenantId: tenant(req),
      uploadedBy: uploader.actorName || uploader.actorId,
      entityType: "team_asset",
      entityId: category,
      filename: req.file.filename,
      originalName: displayName || req.file.originalname,
      mime: req.file.mimetype,
      size: req.file.size,
      storageKey: req.file.path,
      url: `/uploads/${req.file.filename}`,
    });
    return ok(res, asset);
  }

  const text = String(req.body.content || req.body.text || "").trim();
  if (!text) {
    return res.status(400).json({ success: false, message: "file or text content is required" });
  }
  if (!displayName) {
    return res.status(400).json({ success: false, message: "Asset name is required" });
  }

  const filename = `team-note-${Date.now()}.txt`;
  const storageKey = path.join(uploadDir, filename);
  fs.writeFileSync(storageKey, text, "utf8");
  const size = Buffer.byteLength(text, "utf8");

  const asset = await repo.insertFileAsset({
    tenantId: tenant(req),
    uploadedBy: uploader.actorName || uploader.actorId,
    entityType: "team_asset",
    entityId: category,
    filename,
    originalName: displayName,
    mime: "text/plain",
    size,
    storageKey,
    url: `/uploads/${filename}`,
  });
  return ok(res, asset);
}));

router.post("/files/upload", upload.single("file"), asyncRoute(async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "file is required" });
  const asset = await repo.insertFileAsset({
    tenantId: tenant(req),
    uploadedBy: actor(req).actorId,
    entityType: req.body.entityType,
    entityId: req.body.entityId,
    filename: req.file.filename,
    originalName: req.file.originalname,
    mime: req.file.mimetype,
    size: req.file.size,
    storageKey: req.file.path,
    url: `/uploads/${req.file.filename}`,
  });
  return ok(res, asset);
}));

module.exports = router;
