const repo = require("../repositories/operationalRepo");
const { emitTenant, emitEmployee } = require("../realtime/socket");
const { cacheGet, cacheSet } = require("../config/redis");
const pool = require("../../config/db");
const googleMeet = require("./googleMeetService");

const { DEFAULT_TENANT_ID } = repo;

function tenant(req) {
  return req.headers["x-tenant-id"] || DEFAULT_TENANT_ID;
}

function actor(req) {
  return {
    actorId: req.headers["x-user-id"] || "system",
    actorName: req.headers["x-user-name"] || "System",
    actorRole: req.headers["x-user-role"] || "system",
    ip: req.ip,
  };
}

function normalizeLeadInput(input = {}) {
  const name = input.leadName || input.lead_name || input.name || input.contactName;
  const rawServices = input.services || input.service || input.serviceName || input.service_name || input.serviceTitle || input.service_title || input.serviceId || input.service_id || "";
  const servicesFormatted = Array.isArray(rawServices) ? rawServices.join(", ") : String(rawServices || "");
  
  const rawSop = input.sop || input.sopName || input.sop_name || input.sopTitle || input.sop_title || input.sopId || input.sop_id || "";
  
  const reqParts = [];
  if (input.requirements) reqParts.push(String(input.requirements));
  if (input.notes && String(input.notes) !== String(input.requirements)) reqParts.push(`Notes: ${input.notes}`);
  if (rawSop) reqParts.push(`SOP: ${rawSop}`);
  
  let notesAndReqs = reqParts.join(" | ");
  if (servicesFormatted && !notesAndReqs.includes(servicesFormatted)) {
    notesAndReqs = notesAndReqs ? `[Service: ${servicesFormatted}] ${notesAndReqs}` : `Service: ${servicesFormatted}`;
  }

  const utmSource = input.utm_source || input.utmSource || "";
  const utmMedium = input.utm_medium || input.utmMedium || "";
  const utmCampaign = input.utm_campaign || input.utmCampaign || "";
  const utmTerm = input.utm_term || input.utmTerm || "";
  const utmContent = input.utm_content || input.utmContent || "";
  const serviceId = input.serviceId || input.service_id || "";
  const sopId = input.sopId || input.sop_id || "";

  // Prioritize genuine marketing sources over generic "n8n"
  const candidateSource = (input.source && input.source !== "n8n") 
    ? input.source 
    : (utmSource || input.channel || input.source || "n8n");

  const sourceMetaObj = {
    ...(input.sourceMeta || input.rawPayload || {}),
    ...(input.channel ? { channel: input.channel } : {}),
    ...(candidateSource ? { source: candidateSource } : {}),
    ...(utmSource ? { utm_source: utmSource } : {}),
    ...(utmMedium ? { utm_medium: utmMedium } : {}),
    ...(utmCampaign ? { utm_campaign: utmCampaign } : {}),
    ...(utmTerm ? { utm_term: utmTerm } : {}),
    ...(utmContent ? { utm_content: utmContent } : {}),
    ...(serviceId ? { serviceId } : {}),
    ...(servicesFormatted ? { service: servicesFormatted, services: servicesFormatted } : {}),
    ...(sopId ? { sopId } : {}),
    ...(rawSop ? { sop: rawSop } : {}),
    ...(input.meetLink || input.meet_link ? { meetLink: input.meetLink || input.meet_link } : {}),
    ...(input.scheduledAt || input.scheduled_at ? { scheduledAt: input.scheduledAt || input.scheduled_at } : {}),
    ...(input.employeeName || input.employee_name ? { employeeName: input.employeeName || input.employee_name } : {}),
  };

  return {
    leadName: name || "Unknown Lead",
    companyName: input.companyName || input.company_name || input.company || input.business_name || "",
    phone: input.phone || input.mobile || input.contact || "",
    email: input.email || "",
    city: input.city || "",
    country: input.country || "India",
    source: normalizeSource(candidateSource),
    formName: input.formName || input.form_name || (servicesFormatted ? servicesFormatted : (utmCampaign ? utmCampaign : "n8n Webhook")),
    pipelineStage: input.pipelineStage || input.pipeline_stage || "new",
    temperature: normalizeTemperature(input.temperature || input.status || input.priority),
    status: input.status || "New Lead",
    winProbability: Number(input.winProbability ?? input.win_probability ?? 0),
    expectedRevenue: Number(input.expectedRevenue ?? input.expected_revenue ?? input.revenue ?? 0),
    priority: normalizePriority(input.priority),
    requirements: notesAndReqs,
    insights: input.insights || "",
    sourceMeta: sourceMetaObj,
  };
}

function normalizeSource(value) {
  const s = String(value || "").toLowerCase();
  if (s.includes("meta") || s.includes("facebook") || s.includes("instagram") || s.includes("fb") || s.includes("ig")) return "meta_ads";
  if (s.includes("google")) return "google_ads";
  if (s.includes("whatsapp")) return "whatsapp";
  if (s.includes("landing")) return "landing_page";
  if (s.includes("form")) return "form";
  if (s.includes("campaign")) return "campaign";
  if (s.includes("website") || s.includes("web")) return "website";
  if (s.includes("linkedin")) return "linkedin";
  if (s.includes("referral")) return "referral";
  if (s.includes("n8n") || s.includes("webhook")) return "n8n";
  if (s.includes("api")) return "api";
  if (s.includes("third")) return "third_party";
  return value ? String(value).trim() : "manual";
}

function normalizeTemperature(value) {
  const s = String(value || "").toLowerCase();
  if (s.includes("hot") || s.includes("critical") || s.includes("high")) return "hot";
  if (s.includes("cold") || s.includes("low")) return "cold";
  return "warm";
}

function normalizePriority(value) {
  const s = String(value || "").toLowerCase();
  if (["critical", "high", "medium", "low"].includes(s)) return s;
  if (s.includes("hot")) return "high";
  return "medium";
}

async function writeTimeline({ tenantId, leadId, type, summary, payload, actor: a = {} }) {
  const event = await repo.insertTimeline({
    tenantId,
    leadId,
    type,
    summary,
    payload,
    actorId: a.actorId,
    actorName: a.actorName,
    actorRole: a.actorRole,
  });
  emitTenant(tenantId, "lead.timeline", event);
  return event;
}

async function writeAudit({ tenantId, action, resource, resourceId, before, after, metadata, actor: a = {} }) {
  return repo.insertAudit({
    tenantId,
    action,
    resource,
    resourceId,
    before,
    after,
    metadata,
    actorId: a.actorId,
    ip: a.ip,
  });
}

async function notify({ tenantId, employeeId, userId, type, title, body, entityType, entityId }) {
  const notification = await repo.insertNotification({
    tenantId,
    employeeId,
    userId,
    type,
    title,
    body,
    entityType,
    entityId,
  });
  emitTenant(tenantId, "notification.new", notification);
  if (employeeId) emitEmployee(tenantId, employeeId, "notification.new", notification);
  return notification;
}

const dataService = require("./dataService");

async function createLead(input, options = {}) {
  const tenantId = options.tenantId || DEFAULT_TENANT_ID;

  // 1. Extract & Normalize Identifiers
  const rawEmail = input.email || input.email_address || input.mail;
  const rawPhone = input.phone || input.phone_number || input.mobile || input.contact;
  
  const normEmail = rawEmail ? String(rawEmail).trim().toLowerCase() : "";
  const normPhone = rawPhone ? String(rawPhone).replace(/\D/g, "") : "";

  let existingLead = null;

  // Step 1: Check Email First (Primary Identifier)
  if (normEmail && normEmail.includes("@")) {
    existingLead = await repo.findLeadByEmail(tenantId, normEmail);
    if (existingLead) {
      console.log(`[createLead] Duplicate match found via EMAIL: "${normEmail}" -> Existing Lead #${existingLead.id}`);
    }
  }

  // Step 2: ONLY if Email is NOT available, Check Phone (Fallback Identifier)
 if (!existingLead && normPhone && normPhone.length >= 10) {
    existingLead = await repo.findLeadByPhone(tenantId, normPhone);
    if (existingLead) {
      console.log(`[createLead] Duplicate match found via PHONE: "${normPhone}" -> Existing Lead #${existingLead.id}`);
    }
  }

  // =========================================================================
  // EXISTING LEAD UPDATE FLOW (No Duplicate Creation)
  // =========================================================================
  if (existingLead) {
    const updateFields = {};
    const patchField = (key, val) => {
      if (val !== undefined && val !== null && String(val).trim() !== "") {
        updateFields[key] = val;
      }
    };

    const rawLeadName = input.leadName || input.lead_name || input.name;
    const rawCompany = input.companyName || input.company_name || input.company;
    const rawCity = input.city;
    const rawCountry = input.country;
    const rawReqs = input.requirements || input.service || input.serviceName || input.service_name;
    const rawNotes = input.notes;
    const rawRev = input.expectedRevenue || input.expected_revenue || input.revenue;
    const rawWinProb = input.winProbability || input.win_probability;
    const rawStage = input.pipelineStage || input.pipeline_stage || input.stage;
    const rawTemp = input.temperature;
    const rawPriority = input.priority;

    patchField("leadName", rawLeadName);
    patchField("companyName", rawCompany);
    patchField("city", rawCity);
    patchField("country", rawCountry);
    if (rawEmail) patchField("email", normEmail);
    if (rawPhone) patchField("phone", rawPhone);
    patchField("requirements", rawReqs);
    patchField("notes", rawNotes);
    if (rawRev) patchField("expectedRevenue", Number(rawRev));
    if (rawWinProb) patchField("winProbability", Number(rawWinProb));
    // NOTE: pipelineStage is intentionally NOT patched here. It is applied further
    // down via updateLeadStage(), the same canonical stage-transition mechanism used
    // by manual Kanban drag moves, so a webhook-driven stage change (e.g. n8n booking
    // flow sending pipelineStage: "booked") also sets stage_is_manual = true. Without
    // that flag the frontend's period-scoped pipeline board filter drops the lead
    // instead of showing it in the mapped Kanban column (e.g. Meeting Booked).
    if (rawTemp) patchField("temperature", rawTemp);
    if (rawPriority) patchField("priority", rawPriority);

    // Merge source_meta cleanly
    let mergedSourceMeta = existingLead.sourceMeta || {};
    if (typeof mergedSourceMeta === "string") {
      try { mergedSourceMeta = JSON.parse(mergedSourceMeta); } catch {}
    }
    mergedSourceMeta = {
      ...mergedSourceMeta,
      ...(typeof input === "object" && input ? input : {}),
      lastUpdatedVia: input.source || "n8n",
      updatedAt: new Date().toISOString(),
    };
    updateFields.sourceMeta = mergedSourceMeta;
    updateFields.lastActivityAt = new Date();

    // Re-assign or update employee assignment if employeeId or employeeName is provided in input
    const rawEmpId = input.employeeId || input.employee_id;
    const rawEmpName = input.employeeName || input.employee_name || input.employee;
    if (rawEmpId || rawEmpName) {
      let targetEmp = null;
      if (rawEmpId) {
        targetEmp = await repo.findEmployeeById(tenantId, rawEmpId);
      }
      if (!targetEmp && rawEmpName) {
        try {
          const activeEmps = await repo.listActiveEmployees(tenantId);
          const needle = String(rawEmpName).trim().toLowerCase();
          targetEmp = activeEmps.find((e) => e.name.toLowerCase().includes(needle) || (e.email && e.email.toLowerCase().includes(needle)));
        } catch (e) {}
      }
      if (targetEmp) {
        updateFields.assignedTo = targetEmp.id;
        updateFields.assignmentStatus = "assigned";
        updateFields.assignedAt = new Date();
        updateFields.assignmentMethod = "n8n_direct";
      }
    }

    // Perform Update (Updating Lead ID & Employee Assignment)
    let updatedLead = await repo.updateLead(tenantId, existingLead.id, updateFields);
    if (!updatedLead) updatedLead = existingLead;

    // Apply any incoming pipeline stage change (e.g. n8n booking webhook sending
    // pipelineStage: "booked") through the existing stage-update mechanism instead of
    // a raw field patch. updateLeadStage() sets stage_is_manual = true (same as a
    // manual Kanban drag), writes its own stage_change timeline/audit entry, and emits
    // the realtime update — which is what keeps the lead visible in its mapped Kanban
    // column (e.g. Meeting Booked) regardless of the board's Today/Week/Month filter.
    if (rawStage) {
      try {
        updatedLead = await updateLeadStage({
          tenantId,
          leadId: existingLead.id,
          stage: rawStage,
          actor: options.actor,
        });
      } catch (stageErr) {
        console.error("[createLead] Failed to apply pipeline stage from webhook:", stageErr);
      }
    }

    // Check if meeting is provided in payload -> Link meeting to existing lead & assigned employee
    const meetLink = input.meetLink || input.meet_link || input.meetingLink || input.meeting_link || input.meeting_url || input.google_meet_link;
    const meetingTime = input.scheduledAt || input.scheduled_at || input.meetingTime || input.meeting_time || input.meeting_date;
    const serviceName = input.services || input.service || input.serviceName || input.service_name || rawReqs;

    if (meetLink || meetingTime) {
      try {
        const getEmpId = (val) => (val && typeof val === "object" ? val.id || val._id : val);
        const empId = getEmpId(updatedLead.assignedTo) || getEmpId(updatedLead.assigned_to) || getEmpId(existingLead.assignedTo) || getEmpId(existingLead.assigned_to);
        if (empId) {
          await createMeeting({
            tenantId,
            data: {
              leadId: updatedLead.id,
              employeeId: empId,
              title: input.meetingTitle || input.meeting_title || (serviceName ? `Discovery Meeting: ${serviceName}` : `Lead Meeting - ${updatedLead.leadName}`),
              scheduledAt: meetingTime ? new Date(meetingTime) : new Date(Date.now() + 3600 * 1000),
              durationMin: Number(input.durationMin || input.duration_min || 30),
              meetLink: meetLink || null,
              location: meetLink ? "Google Meet" : (input.location || "Online"),
              agenda: input.agenda || input.notes || `Initial discussion for ${updatedLead.leadName}`,
              source: "lead",
            },
            actor: options.actor,
          });
        }
      } catch (meetErr) {
        console.error("[createLead] Auto create meeting error on existing lead:", meetErr);
      }
    }

    await writeTimeline({
      tenantId,
      leadId: updatedLead.id,
      type: "lead_updated",
      summary: `Lead #${updatedLead.id} updated with new information from ${input.source || "n8n"}`,
      payload: { source: input.source || "n8n", updateFields },
      actor: options.actor,
    });

    emitTenant(tenantId, "lead.updated", updatedLead);
    const finalLead = await repo.findLeadById(tenantId, updatedLead.id, { populate: true });
    const resolvedLead = finalLead || updatedLead;
    return {
      ...(resolvedLead && typeof resolvedLead === "object" ? resolvedLead : {}),
      id: resolvedLead?.id,
      lead: resolvedLead,
      queueItem: null,
      isExisting: true,
    };
  }

  // =========================================================================
  // NEW LEAD CREATION FLOW (No Duplicate Found)
  // =========================================================================
  // 1. Resolve Unique IDs if passed in payload
  const rawServiceId = input.serviceId || input.service_id;
  const rawSopId = input.sopId || input.sop_id;
  const rawEmpId = input.employeeId || input.employee_id;
  const rawEmpName = input.employeeName || input.employee_name || input.assignedTo || input.assigned_to || input.employee || input.repName || input.rep_name;

  let resolvedService = null;
  let resolvedSop = null;
  let resolvedEmployee = null;
  let invalidServiceId = false;
  let invalidSopId = false;
  let invalidEmployeeId = false;

  if (rawServiceId) {
    resolvedService = await repo.findServiceByIdCode(tenantId, rawServiceId);
    if (!resolvedService) {
      console.warn(`[createLead] Invalid serviceId received: ${rawServiceId}. Strict mode: ignoring name fallback.`);
      invalidServiceId = true;
    }
  }

  if (rawSopId) {
    resolvedSop = await repo.findSopByIdCode(tenantId, rawSopId);
    if (!resolvedSop) {
      console.warn(`[createLead] Invalid sopId received: ${rawSopId}. Strict mode: ignoring name fallback.`);
      invalidSopId = true;
    }
  }

  if (rawEmpId) {
    resolvedEmployee = await repo.findEmployeeById(tenantId, rawEmpId);
    if (!resolvedEmployee) {
      console.warn(`[createLead] Invalid employeeId received: ${rawEmpId}. Strict mode: ignoring name fallback.`);
      invalidEmployeeId = true;
    }
  }

  const enrichedInput = {
    ...input,
    ...(resolvedService?.name ? { service: resolvedService.name, serviceName: resolvedService.name } : {}),
    ...(resolvedSop?.title ? { sop: resolvedSop.title, sopName: resolvedSop.title } : {}),
  };

  const normalized = normalizeLeadInput(enrichedInput);
  const lead = await repo.insertLead(tenantId, normalized);

  // Auto-create service in catalog if a service is specified for this lead
  const serviceName = resolvedService?.name || enrichedInput.services || enrichedInput.service || enrichedInput.serviceName || enrichedInput.service_name || normalized.requirements;
  if (serviceName) {
    dataService.ensureServiceExists(tenantId, serviceName).catch((e) => console.error("[createLead] ensureServiceExists error:", e));
  }

  const priority = lead.temperature === "hot" ? 100 : lead.temperature === "warm" ? 50 : 10;
  const queueItem = await repo.insertQueueItem(tenantId, lead.id, priority);

  await writeTimeline({
    tenantId,
    leadId: lead.id,
    type: "lead_created",
    summary: `Lead created from ${lead.source}`,
    payload: { source: lead.source, queueId: queueItem.id },
    actor: options.actor,
  });

  emitTenant(tenantId, "lead.created", lead);

  let assignedEmployeeId = null;

  // Check assignment configuration for n8n auto-assign toggle
  const assignmentConfig = await getOrCreateAssignmentConfig(tenantId);
  const n8nAutoAssignEnabled = assignmentConfig?.n8nAutoAssignEnabled !== false;

  if (rawEmpId) {
    resolvedEmployee = await repo.findEmployeeById(tenantId, rawEmpId);
    if (!resolvedEmployee) {
      console.warn(`[createLead] Invalid employeeId received: ${rawEmpId}. Strict mode: ignoring name fallback.`);
      invalidEmployeeId = true;
    }
  }

  // Fallback to employee name ONLY if explicit employeeId was NOT provided and invalid
  if (!resolvedEmployee && !invalidEmployeeId && rawEmpName && n8nAutoAssignEnabled) {
    try {
      const activeEmps = await repo.listActiveEmployees(tenantId);
      const needle = String(rawEmpName).trim().toLowerCase();
      resolvedEmployee = activeEmps.find((e) => e.name.toLowerCase().includes(needle) || (e.email && e.email.toLowerCase().includes(needle)));
    } catch (empErr) {
      console.error("[createLead] Direct employee name lookup failed:", empErr);
    }
  }

  // Priority 1: Direct Employee Assignment (via validated Employee ID or Name)
  if (n8nAutoAssignEnabled && resolvedEmployee) {
    try {
      // Validate relationship: If service is also provided, check if employee belongs to service distribution or department
      let isValidRelation = true;
      if (resolvedService) {
        const metaObj = (typeof resolvedService.metadata === "string" ? JSON.parse(resolvedService.metadata) : resolvedService.metadata) || {};
        const distIds = Array.isArray(metaObj.distributionEmployeeIds) ? metaObj.distributionEmployeeIds.map(Number) : [];
        if (distIds.length > 0 && !distIds.includes(Number(resolvedEmployee.id))) {
          console.warn(`[createLead] Employee ${resolvedEmployee.name} is not in Service distribution list for ${resolvedService.name}. Direct assignment enforced per explicit request.`);
        }
      }

      if (isValidRelation) {
        await assignLead({
          tenantId,
          leadId: lead.id,
          employeeId: resolvedEmployee.id,
          method: "n8n_direct",
          performedBy: options.actor?.actorId || "webhook:n8n",
          reason: `Direct assignment to ${resolvedEmployee.name} (ID: ${resolvedEmployee.phone || resolvedEmployee.id})`,
          actor: options.actor,
        });
        assignedEmployeeId = resolvedEmployee.id;
      }
    } catch (empErr) {
      console.error("[createLead] Direct employee assignment failed:", empErr);
    }
  }

  // Priority 2: Service-Based Assignment (via validated Service ID or Service Name)
  if (!assignedEmployeeId && (resolvedService || (serviceName && !invalidServiceId))) {
    try {
      const activeEmps = await repo.listActiveEmployees(tenantId);
      const targetSvcName = resolvedService ? resolvedService.name : serviceName;
      const { services = [] } = await dataService.listServices(tenantId);
      const matchedSvc = services.find((s) => s.id === resolvedService?.id || s.serviceId === rawServiceId || String(s.name).toLowerCase() === String(targetSvcName).toLowerCase());

      let serviceEmp = null;
      if (matchedSvc && matchedSvc.distributionEnabled && Array.isArray(matchedSvc.distributionEmployeeIds) && matchedSvc.distributionEmployeeIds.length > 0) {
        const eligibleIds = matchedSvc.distributionEmployeeIds.map(Number);
        const candidates = activeEmps.filter((e) => eligibleIds.includes(Number(e.id)));
        if (candidates.length > 0) {
          serviceEmp = candidates[Math.floor(Math.random() * candidates.length)];
        }
      }

      if (!serviceEmp && targetSvcName) {
        const needleService = String(targetSvcName).trim().toLowerCase();
        serviceEmp = activeEmps.find((e) => {
          const dept = String(e.department || e.role || "").toLowerCase();
          return dept && (dept.includes(needleService) || needleService.includes(dept));
        });
      }

      if (serviceEmp) {
        await assignLead({
          tenantId,
          leadId: lead.id,
          employeeId: serviceEmp.id,
          method: "service_based",
          performedBy: options.actor?.actorId || "system:service_router",
          reason: `Service-based assignment for ${targetSvcName} (${matchedSvc?.serviceId || "SRV"})`,
          actor: options.actor,
        });
        assignedEmployeeId = serviceEmp.id;
      }
    } catch (serviceErr) {
      console.error("[createLead] Service-based assignment failed:", serviceErr);
    }
  }

  // Priority 3: Fallback to default auto-assignment queue (Round-Robin / Workload) if not assigned by Priority 1 or 2
  if (!assignedEmployeeId && options.autoAssign !== false) {
    try {
      const assignRes = await processAssignmentQueue(tenantId, { limit: 1, actor: options.actor });
      if (assignRes && assignRes.assigned && assignRes.assigned.length > 0) {
        assignedEmployeeId = assignRes.assigned[0].employeeId;
      }
    } catch (qErr) {
      console.error("[createLead] Auto assignment error:", qErr);
    }
  }

  // Auto-schedule meeting if meeting link or meeting date is provided in payload
  const meetLink = input.meetLink || input.meet_link || input.meetingLink || input.meeting_link || input.meeting_url || input.google_meet_link;
  const meetingTime = input.scheduledAt || input.scheduled_at || input.meetingTime || input.meeting_time || input.meeting_date;
  if (meetLink || meetingTime) {
    try {
      const getEmpId = (val) => (val && typeof val === "object" ? val.id || val._id : val);
      const fetchedLead = await repo.findLeadById(tenantId, lead.id);
      const empId = assignedEmployeeId || getEmpId(fetchedLead?.assignedTo) || getEmpId(fetchedLead?.assigned_to);
      if (empId) {
        await createMeeting({
          tenantId,
          data: {
            leadId: lead.id,
            employeeId: empId,
            title: input.meetingTitle || input.meeting_title || (serviceName ? `Discovery Meeting: ${serviceName}` : `Lead Meeting - ${lead.leadName}`),
            scheduledAt: meetingTime ? new Date(meetingTime) : new Date(Date.now() + 3600 * 1000),
            durationMin: Number(input.durationMin || input.duration_min || 30),
            meetLink: meetLink || null,
            location: meetLink ? "Google Meet" : (input.location || "Online"),
            agenda: input.agenda || input.notes || `Initial discussion for ${lead.leadName}`,
            source: "lead",
          },
          actor: options.actor,
        });
      }
    } catch (meetErr) {
      console.error("[createLead] Auto create meeting error:", meetErr);
    }
  }

  const finalLead = await repo.findLeadById(tenantId, lead.id, { populate: true });
  const resolvedLead = finalLead || lead;
  return {
    ...(resolvedLead && typeof resolvedLead === "object" ? resolvedLead : {}),
    id: resolvedLead?.id,
    lead: resolvedLead,
    queueItem,
  };
}

async function getOrCreateAssignmentConfig(tenantId) {
  let config = await repo.getAssignmentConfig(tenantId);
  if (!config) {
    const employees = await repo.listActiveEmployees(tenantId);
    config = await repo.createAssignmentConfig(
      tenantId,
      employees.map((e) => e.id),
    );
  }
  return config;
}

async function resetDailyStatsIfNeeded(config) {
  const today = new Date().toISOString().slice(0, 10);
  if (config.todayKey !== today) {
    config.todayKey = today;
    config.todayStats = { total: 0, byEmployee: {} };
    await repo.saveAssignmentConfig(config);
  }
}

function todayCount(config, employeeId) {
  const map = config.todayStats?.byEmployee || {};
  return Number(map[String(employeeId)] || 0);
}

function setTodayCount(config, employeeId, nextValue) {
  if (!config.todayStats) config.todayStats = { total: 0, byEmployee: {} };
  if (!config.todayStats.byEmployee) config.todayStats.byEmployee = {};
  config.todayStats.byEmployee[String(employeeId)] = nextValue;
}

async function eligibleEmployees(tenantId, config) {
  const paused = new Set((config.pausedEmployees || []).map(String));
  const employees = await repo.listActiveEmployees(tenantId);
  return employees.filter((e) => {
    if (paused.has(String(e.id))) return false;
    if (e.capacity?.receivingPaused) return false;
    return true;
  });
}

async function pickEmployee(tenantId, config) {
  const employees = await eligibleEmployees(tenantId, config);
  const filtered = employees.filter((e) => {
    const active = e.capacity?.currentActiveLeads || 0;
    const maxActive = config.workloadRules?.maxActiveLeads || e.capacity?.maxActiveLeads || 40;
    const dailyLimit = config.workloadRules?.maxDailyAssignments || e.capacity?.dailyLimit || 25;
    return active < maxActive && todayCount(config, e.id) < dailyLimit;
  });

  if (!filtered.length) return null;

  if (config.mode === "workload") {
    return filtered.sort((a, b) => (a.capacity.currentActiveLeads || 0) - (b.capacity.currentActiveLeads || 0))[0];
  }

  const order = (config.roundRobinOrder?.length ? config.roundRobinOrder : filtered.map((e) => e.id)).map(String);
  for (let attempts = 0; attempts < order.length + filtered.length; attempts += 1) {
    const id = order[config.rrIndex % order.length];
    config.rrIndex = (config.rrIndex + 1) % order.length;
    const emp = filtered.find((e) => String(e.id) === id);
    if (emp) return emp;
  }

  return filtered[0];
}

async function assignLead({ tenantId, leadId, employeeId, method = "manual", performedBy = "system", actor: a, reason }) {
  const lead = await repo.findLeadById(tenantId, leadId);
  if (!lead) throw new Error("Lead not found");

  const employee = await repo.findEmployeeById(tenantId, employeeId);
  if (!employee || employee.status !== "active") throw new Error("Employee not found or inactive");

  const before = { ...lead };
  const fromEmployeeId = lead.assignedTo?.id ?? lead.assignedTo;

  const updated = await repo.updateLead(tenantId, leadId, {
    assignedTo: employee.id,
    assignedAt: new Date(),
    assignedBy: performedBy,
    assignmentMethod: method,
    assignmentStatus: method === "manual" || method === "bulk" ? "assigned" : "pending",
    acceptedAt: null,
    lastActivityAt: new Date(),
  });

  await repo.incrementEmployeeLeads(employee.id, 1);
  if (fromEmployeeId && String(fromEmployeeId) !== String(employee.id)) {
    await repo.incrementEmployeeLeads(fromEmployeeId, -1);
  }

  await repo.markQueueAssigned(tenantId, leadId);

  await repo.insertAssignmentHistory({
    tenantId,
    leadId,
    fromEmployeeId: fromEmployeeId || null,
    toEmployeeId: employee.id,
    method,
    performedBy,
    reason,
  });

  await writeTimeline({
    tenantId,
    leadId,
    type: "assignment",
    summary: `Lead assigned to ${employee.name}`,
    payload: { employeeId: employee.id, employeeName: employee.name, method },
    actor: a,
  });

  await writeAudit({
    tenantId,
    action: "lead.assigned",
    resource: "lead",
    resourceId: leadId,
    before,
    after: updated,
    metadata: { method, toEmployeeId: employee.id },
    actor: a,
  });

  await notify({
    tenantId,
    employeeId: employee.id,
    type: "lead_assigned",
    title: "New lead assigned",
    body: `${lead.leadName}${lead.companyName ? ` · ${lead.companyName}` : ""}`,
    entityType: "lead",
    entityId: leadId,
  });

  emitTenant(tenantId, "lead.assigned", updated);
  emitEmployee(tenantId, employee.id, "lead.assigned", updated);
  emitTenant(tenantId, "dashboard.refresh", { reason: "lead.assigned" });

  return updated;
}

async function processAssignmentQueue(tenantId, options = {}) {
  const config = await getOrCreateAssignmentConfig(tenantId);
  await resetDailyStatsIfNeeded(config);

  if (!config.autoAssign || config.mode === "manual_only") {
    return { processed: 0, skipped: "auto_assign_disabled" };
  }

  const limit = Number(options.limit || 25);
  const queueItems = await repo.getQueuedItems(tenantId, limit);

  let processed = 0;
  const failures = [];

  for (const item of queueItems) {
    await repo.updateQueueItem(item.id, { status: "processing", attempts: (item.attempts || 0) + 1 });

    const employee = await pickEmployee(tenantId, config);
    if (!employee) {
      await repo.updateQueueItem(item.id, { status: "failed", failureReason: "No eligible employees" });
      failures.push({ queueId: item.id, reason: "No eligible employees" });
      continue;
    }

    try {
      await assignLead({
        tenantId,
        leadId: item.leadId,
        employeeId: employee.id,
        method: config.mode === "workload" ? "workload" : "round_robin",
        performedBy: "assignment-engine",
        actor: options.actor,
      });
      setTodayCount(config, employee.id, todayCount(config, employee.id) + 1);
      config.todayStats.total = (config.todayStats.total || 0) + 1;
      processed += 1;
    } catch (err) {
      await repo.updateQueueItem(item.id, { status: "failed", failureReason: err.message });
      failures.push({ queueId: item.id, reason: err.message });
    }
  }

  await repo.saveAssignmentConfig(config);
  return { processed, failures };
}

async function bulkAssign({ tenantId, leadIds, employeeId, method = "bulk", actor: a }) {
  const results = [];
  for (const leadId of leadIds) {
    results.push(await assignLead({ tenantId, leadId, employeeId, method, performedBy: a?.actorId || "admin", actor: a }));
  }
  return results;
}

async function updateLeadStage({ tenantId, leadId, stage, status, actor: a }) {
  const lead = await repo.findLeadById(tenantId, leadId);
  if (!lead) throw new Error("Lead not found");
  const before = { ...lead };
  const from = lead.pipelineStage;

  const patch = {
    pipelineStage: stage,
    stageIsManual: true,
    lastActivityAt: new Date(),
  };
  if (status) patch.status = status;
  if (stage === "won") patch.convertedAt = new Date();
  if (stage === "lost") patch.lostAt = new Date();

  const leavingNewLead = !lead.acceptedAt
    && String(lead.assignmentStatus || "").toLowerCase() === "assigned"
    && !["new lead", "new"].includes(String(stage || "").toLowerCase().trim());
  if (leavingNewLead) {
    patch.assignmentStatus = "accepted";
    patch.acceptedAt = new Date();
  }

  const updated = await repo.updateLead(tenantId, leadId, patch);

  await writeTimeline({
    tenantId,
    leadId,
    type: "stage_change",
    summary: `Stage changed from ${from} to ${stage}`,
    payload: { from, to: stage, status },
    actor: a,
  });
  await writeAudit({ tenantId, action: "lead.stage_changed", resource: "lead", resourceId: leadId, before, after: updated, actor: a });
  emitTenant(tenantId, "lead.updated", updated);
  const assigneeId = updated.assignedTo?.id ?? updated.assignedTo;
  if (assigneeId) emitEmployee(tenantId, assigneeId, "lead.updated", updated);
  return updated;
}

async function addLeadNote({ tenantId, leadId, body, actor: a }) {
  const note = await repo.insertNote({
    tenantId,
    leadId,
    body,
    authorId: a?.actorId,
    authorType: a?.actorRole === "admin" ? "admin" : "employee",
  });
  await writeTimeline({ tenantId, leadId, type: "note", summary: "Note added", payload: { noteId: note.id, body }, actor: a });
  return note;
}

async function recordCall({ tenantId, data, actor: a }) {
  const call = await repo.insertCall({ tenantId, ...data });
  await repo.touchLeadActivity(tenantId, data.leadId);
  await writeTimeline({
    tenantId,
    leadId: data.leadId,
    type: "call",
    summary: `Call recorded: ${data.outcome || "logged"}`,
    payload: { callId: call.id, outcome: call.outcome, durationSec: call.durationSec },
    actor: a,
  });
  emitTenant(tenantId, "lead.updated", { leadId: data.leadId, reason: "call.recorded" });
  return call;
}

async function scheduleFollowup({ tenantId, data, actor: a }) {
  const task = await repo.insertTask({
    tenantId,
    assigneeId: data.employeeId,
    leadId: data.leadId,
    title: data.title || "Follow up with lead",
    description: data.note,
    priority: data.priority || "medium",
    dueAt: data.scheduledAt,
  });
  const followup = await repo.insertFollowup({ tenantId, ...data, taskId: task.id });
  await repo.updateTask(tenantId, task.id, { followUpId: followup.id });
  await repo.updateLead(tenantId, data.leadId, { nextFollowUpAt: data.scheduledAt, lastActivityAt: new Date() });
  await writeTimeline({
    tenantId,
    leadId: data.leadId,
    type: "followup",
    summary: "Follow-up scheduled",
    payload: { followupId: followup.id, scheduledAt: data.scheduledAt },
    actor: a,
  });
  await notify({
    tenantId,
    employeeId: data.employeeId,
    type: "followup_scheduled",
    title: "Follow-up scheduled",
    body: data.note,
    entityType: "followup",
    entityId: followup.id,
  });
  return followup;
}

async function completeFollowup({ tenantId, followupId, actor: a }) {
  const followup = await repo.updateFollowup(tenantId, followupId, {
    status: "completed",
    completedAt: new Date(),
  });
  if (!followup) throw new Error("Follow-up not found");
  if (followup.taskId) {
    await repo.updateTask(tenantId, followup.taskId, { status: "done", completedAt: new Date() });
  }
  await writeTimeline({ tenantId, leadId: followup.leadId, type: "followup", summary: "Follow-up completed", payload: { followupId }, actor: a });
  return followup;
}

async function createMeeting({ tenantId, data, actor: a }) {
  const payload = { ...data };
  const location = String(payload.location || "").toLowerCase();
  const isGoogleMeet = location.includes("google meet");
  const meetLink = String(payload.meetLink || "").trim();

  if (isGoogleMeet && !meetLink) {
    if (!googleMeet.isConfigured()) {
      const err = new Error("Google Meet is not configured on the server");
      err.status = 503;
      throw err;
    }
    payload.meetLink = await googleMeet.createMeetLink({
      employeeId: payload.employeeId,
      title: payload.title,
      scheduledAt: payload.scheduledAt,
      durationMin: payload.durationMin || 30,
    });
  }

  const meeting = await repo.insertMeeting({ tenantId, ...payload });
  await writeTimeline({
    tenantId,
    leadId: data.leadId,
    type: "meeting",
    summary: "Meeting scheduled",
    payload: { meetingId: meeting.id, scheduledAt: meeting.scheduledAt },
    actor: a,
  });
  try {
    await notify({
      tenantId,
      employeeId: payload.employeeId,
      type: "meeting_scheduled",
      title: "Meeting scheduled",
      body: payload.title,
      entityType: "meeting",
      entityId: meeting.id,
    });
  } catch {
    // Meeting is already saved — notification failure must not fail the request.
  }
  return meeting;
}

async function addMom({ tenantId, meetingId, mom, actor: a }) {
  const meeting = await repo.updateMeeting(tenantId, meetingId, {
    mom: { ...mom, recordedAt: new Date() },
    status: "completed",
  });
  if (!meeting) throw new Error("Meeting not found");
  await writeTimeline({ tenantId, leadId: meeting.leadId, type: "mom", summary: "Minutes of Meeting added", payload: { meetingId, mom }, actor: a });
  return meeting;
}

async function getAdminKpis(tenantId, range = {}) {
  const key = `analytics:admin:kpis:${tenantId}:${range.start || "all"}:${range.end || "now"}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  const data = await repo.getAdminKpis(tenantId, range);
  await cacheSet(key, data, 300);
  return data;
}

async function getPipelineGrouped(tenantId, filters = {}) {
  return repo.getPipelineGrouped(tenantId, filters);
}

async function scheduleLeadAssignments({ tenantId, leadIds, employeeId, startDate, leadsPerDay, actor }) {
  const parsedLeadsPerDay = parseInt(leadsPerDay) || 10;
  const start = new Date(startDate);
  
  let currentOffset = 0;
  for (let i = 0; i < leadIds.length; i += parsedLeadsPerDay) {
    const chunk = leadIds.slice(i, i + parsedLeadsPerDay);
    
    const d = new Date(start);
    d.setDate(d.getDate() + currentOffset);
    const dateStr = d.toISOString().split("T")[0];
    
    for (const leadId of chunk) {
      await pool.query(
        `INSERT INTO scheduled_lead_assignments (tenant_id, lead_id, employee_id, scheduled_date, status)
         VALUES ($1, $2, $3, $4, 'pending')`,
        [tenantId, leadId, employeeId, dateStr]
      );
    }
    currentOffset += 1;
  }
  return { success: true, count: leadIds.length, days: currentOffset };
}

async function processDueScheduledAssignments(tenantId = DEFAULT_TENANT_ID) {
  const result = await pool.query(
    `SELECT * FROM scheduled_lead_assignments
     WHERE tenant_id = $1 AND status = 'pending' AND scheduled_date <= CURRENT_DATE()`,
    [tenantId]
  );
  
  const processed = [];
  const failures = [];
  
  for (const row of result.rows) {
    try {
      await assignLead({
        tenantId,
        leadId: row.lead_id,
        employeeId: row.employee_id,
        method: "scheduled",
        performedBy: "system",
        reason: `Scheduled assignment for ${row.scheduled_date instanceof Date ? row.scheduled_date.toISOString().split("T")[0] : String(row.scheduled_date)}`
      });
      
      await pool.query(
        `UPDATE scheduled_lead_assignments
         SET status = 'completed', processed_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      processed.push(row.id);
    } catch (err) {
      console.error(`Scheduled assignment failed for lead ${row.lead_id}:`, err.message);
      await pool.query(
        `UPDATE scheduled_lead_assignments
         SET status = 'failed', failure_reason = $2
         WHERE id = $1`,
        [row.id, err.message]
      );
      failures.push({ id: row.id, reason: err.message });
    }
  }
  return { processed, failures };
}

function leadMatchesServiceName(lead, serviceName) {
  const needle = String(serviceName || "").trim().toLowerCase();
  if (!needle) return false;
  const fields = [
    lead.requirements,
    lead.insights,
    lead.sourceMeta?.service,
    lead.service,
  ].map((v) => String(v || "").toLowerCase().trim());
  return fields.some((h) => h && (h === needle || h.includes(needle) || needle.includes(h)));
}

function isLeadUnassignedForDistribution(lead) {
  const status = String(lead.assignmentStatus || "").toLowerCase();
  if (["assigned", "accepted", "in_progress"].includes(status)) return false;
  const assigned = lead.assignedTo;
  if (assigned == null || assigned === "") return true;
  if (typeof assigned === "object" && !assigned.id) return true;
  return false;
}

async function distributeServiceLeads(tenantId, { serviceId = null, actor: a } = {}) {
  const dataService = require("./dataService");
  const { services = [] } = await dataService.listServices(tenantId);
  const targets = (services || []).filter((svc) => {
    if (serviceId && String(svc.id) !== String(serviceId)) return false;
    return svc.distributionEnabled
      && Array.isArray(svc.distributionEmployeeIds)
      && svc.distributionEmployeeIds.length > 0;
  });

  if (!targets.length) {
    return { assigned: 0, services: 0, skipped: "no_enabled_services" };
  }

  const { items: allLeads } = await repo.listAllLeads(tenantId, { assignmentStatus: "unassigned" });
  let assigned = 0;
  const details = [];

  for (const svc of targets) {
    const employeeIds = svc.distributionEmployeeIds.map((id) => String(id)).filter(Boolean);
    if (!employeeIds.length) continue;

    let rrIndex = Number(svc.distributionRrIndex) || 0;
    const matching = allLeads.filter(
      (lead) => isLeadUnassignedForDistribution(lead) && leadMatchesServiceName(lead, svc.name),
    );

    let serviceAssigned = 0;
    for (const lead of matching) {
      const employeeId = employeeIds[rrIndex % employeeIds.length];
      rrIndex += 1;
      try {
        await assignLead({
          tenantId,
          leadId: lead.id,
          employeeId: Number(employeeId),
          method: "round_robin",
          performedBy: "service-distribution",
          actor: a,
          reason: `Auto-distributed for service: ${svc.name}`,
        });
        assigned += 1;
        serviceAssigned += 1;
      } catch {
        // skip failed assignment, continue round-robin
      }
    }

    await dataService.updateServiceDistributionIndex(tenantId, svc.id, rrIndex);
    details.push({ serviceId: svc.id, serviceName: svc.name, assigned: serviceAssigned, pending: matching.length - serviceAssigned });
  }

  return { assigned, services: targets.length, details };
}

module.exports = {
  tenant,
  actor,
  normalizeLeadInput,
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
  writeAudit,
  notify,
  scheduleLeadAssignments,
  processDueScheduledAssignments,
  distributeServiceLeads,
};
