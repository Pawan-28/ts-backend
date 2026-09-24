const { logger } = require("../config/logger");
const pool = require("../../config/db");
const { CALL_CONVERSATION_MIN_SEC } = require("../utils/callMetrics");
const { formatUtcInstantAsAppSql, parseCallyzerCallInstant } = require("../utils/appTimezone");
const privateContactsRepo = require("../repositories/privateContactsRepo");

const BASE_URL = (process.env.CALLYZER_API_BASE_URL || "https://api1.callyzer.co/api/v2.1").replace(/\/$/, "");
const MIN_INTERVAL_MS = 2100;

let lastRequestAt = 0;
const historyCache = new Map();

function isConfigured() {
  return Boolean(process.env.CALLYZER_API_KEY?.trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_INTERVAL_MS) {
    await sleep(MIN_INTERVAL_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

async function callyzerPost(path, body = {}) {
  const key = process.env.CALLYZER_API_KEY?.trim();
  if (!key) {
    const err = new Error("Callyzer API key is not configured");
    err.status = 503;
    throw err;
  }

  await throttle();

  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: text };
  }

  if (!res.ok) {
    const err = new Error(payload.message || `Callyzer API error (${res.status})`);
    err.status = res.status;
    err.payload = payload;
    throw err;
  }

  return payload;
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizePhone(countryCode, number) {
  const num = digitsOnly(number);
  const cc = digitsOnly(countryCode);
  const full = cc && num ? `${cc}${num}` : num;
  return {
    full,
    last10: num.slice(-10),
    hyphen: cc && num ? `${cc}-${num}` : num,
  };
}

function phonesMatch(a, b) {
  if (!a || !b) return false;
  const da = digitsOnly(a);
  const db = digitsOnly(b);
  if (!da || !db) return false;
  if (da === db) return true;
  return da.slice(-10) === db.slice(-10);
}

/** Build Callyzer emp_numbers filter from CRM employee row. */
function employeeEmpNumbers(employee) {
  if (!employee) return [];

  const numbers = new Set();
  const callyser = employee.callyserId || employee.callyser_id;
  const phone = employee.phone;

  if (callyser) {
    const raw = String(callyser).trim().replace(/^\+/, "");
    if (raw.includes("-")) {
      numbers.add(raw);
    } else {
      const d = digitsOnly(raw);
      if (d.length === 10) numbers.add(`91-${d}`);
      else if (d.length > 10) numbers.add(`${d.slice(0, d.length - 10)}-${d.slice(-10)}`);
      else numbers.add(raw);
    }
  }

  if (phone) {
    const d = digitsOnly(phone);
    if (d.length === 10) numbers.add(`91-${d}`);
    else if (d.length > 10) numbers.add(`${d.slice(0, d.length - 10)}-${d.slice(-10)}`);
  }

  // NOTE: Do NOT fall back to empCode/emp_id — those are internal DB IDs,
  // not Callyzer phone numbers. An empty result triggers the guidance message.

  return [...numbers].filter(Boolean);
}

function callTypeToDirection(callType) {
  const t = String(callType || "").toLowerCase();
  if (t === "incoming") return "inbound";
  if (t === "outgoing" || t === "rejected") return "outbound";
  if (t === "missed") return "inbound";
  return "outbound";
}

function callTypeToOutcome(callType, duration) {
  const t = String(callType || "").toLowerCase();
  const dur = Number(duration) || 0;
  if (t === "missed") return "Missed";
  if (t === "rejected") return "Rejected";
  if (dur <= 2) return "Not connected";
  return "Connected";
}

function parseCallyzerTimestamp(callDate, callTime) {
  return parseCallyzerCallInstant(callDate, callTime);
}

function mapLogToCall(log, employeeId, leadId) {
  const startedAtUtc = parseCallyzerTimestamp(log.call_date, log.call_time);
  const durationSec = Number(log.duration) || 0;
  const startedAt = startedAtUtc ? formatUtcInstantAsAppSql(startedAtUtc) : null;
  const endedAt = startedAtUtc && durationSec
    ? formatUtcInstantAsAppSql(new Date(new Date(startedAtUtc).getTime() + durationSec * 1000))
    : startedAt;

  return {
    id: `cz-${log.id}`,
    tenantId: null,
    leadId: leadId || null,
    employeeId,
    direction: callTypeToDirection(log.call_type),
    outcome: callTypeToOutcome(log.call_type, durationSec),
    durationSec,
    startedAt,
    endedAt,
    sopId: null,
    checklistProgress: [],
    recordingUrl: log.call_recording_url || null,
    transcript: null,
    notes: log.note || null,
    aiSummary: log.note || null,
    createdAt: log.synced_at || startedAt,
    source: "callyzer",
    callyzerCallId: log.id,
    clientName: log.client_name || null,
    clientPhone: normalizePhone(log.client_country_code, log.client_number).full || null,
  };
}

function formatLeadContactNumber(phone) {
  const d = digitsOnly(phone);
  if (!d) return null;
  if (d.length === 10) return `91-${d}`;
  if (d.length > 10) return `${d.slice(0, d.length - 10)}-${d.slice(-10)}`;
  return null;
}

function buildDialUrl(phone) {
  let d = digitsOnly(phone);
  if (!d) return null;

  while (d.length > 10 && (d.startsWith("91") || d.startsWith("0"))) {
    if (d.startsWith("91") && d.length >= 12) {
      d = d.slice(2);
    } else if (d.startsWith("0")) {
      d = d.slice(1);
    } else {
      break;
    }
  }

  if (d.length === 12 && d.startsWith("91")) {
    d = d.slice(2);
  }
  if (d.length === 11 && d.startsWith("0")) {
    d = d.slice(1);
  }

  return `tel:${d}`;
}

function safeLeadFirstName(name) {
  const raw = String(name || "Lead").trim();
  if (raw.length >= 3) return raw.slice(0, 250);
  return `${raw} CRM`.slice(0, 250);
}

async function captureLeadForEmployee(lead, employee) {
  const contactNumber = formatLeadContactNumber(lead.phone || lead.clientPhone);
  if (!contactNumber) {
    const err = new Error("Lead phone number is required to start a Callyzer call");
    err.status = 400;
    throw err;
  }

  const empNumbers = employeeEmpNumbers(employee);
  if (!empNumbers.length) {
    const err = new Error("Employee Callyzer ID or phone is not configured in Team settings");
    err.status = 400;
    throw err;
  }

  const response = await callyzerPost("/lead/capture", {
    first_name: safeLeadFirstName(lead.leadName || lead.name),
    last_name: (lead.companyName || lead.company || "").trim() || undefined,
    contact_numbers: [contactNumber],
    assignment: {
      strategy: "Random",
      emp_numbers: empNumbers,
    },
    existing_lead: {
      lead_details: "UpdateBlankOnly",
      assignee: "Overwrite",
      lead_tags: "Ignore",
      is_map_existing_call_logs: true,
    },
  });

  const saved = response.result?.savedLeads?.[0];
  return saved?.id || null;
}

async function prepareLeadCall({ lead, employee }) {
  if (!isConfigured()) {
    const err = new Error("Callyzer is not configured on the server");
    err.status = 503;
    throw err;
  }

  let callyzerLeadId = lead.sourceMeta?.callyzerLeadId || null;
  try {
    const capturedId = await captureLeadForEmployee(lead, employee);
    if (capturedId) callyzerLeadId = capturedId;
  } catch (err) {
    logger.warn("Callyzer lead capture failed; continuing with dial only", {
      leadId: lead.id,
      message: err.message,
    });
  }

  return {
    leadId: lead.id,
    callyzerLeadId,
    dialUrl: buildDialUrl(lead.phone),
    contactNumber: formatLeadContactNumber(lead.phone),
    startedAt: new Date().toISOString(),
  };
}

function resolveLeadIdForLog(log, leads, leadPhoneIndex) {
  if (log.lead_id && Array.isArray(leads)) {
    const byCallyzer = leads.find((l) => {
      const meta = l.sourceMeta || l.source_meta || {};
      return meta.callyzerLeadId === log.lead_id;
    });
    if (byCallyzer) return byCallyzer.id;
  }

  const byPhone = findLeadForClient(leads, log.client_country_code, log.client_number);
  if (byPhone) return byPhone.id;

  if (leadPhoneIndex && log.client_number) {
    const client = normalizePhone(log.client_country_code, log.client_number);
    return leadPhoneIndex.get(client.last10) || null;
  }

  return null;
}

function buildLeadPhoneIndex(leads) {
  const index = new Map();
  if (!Array.isArray(leads)) return index;
  for (const lead of leads) {
    const d = digitsOnly(lead.phone);
    if (d.length >= 10) index.set(d.slice(-10), lead.id);
  }
  return index;
}

function attachLeadToCall(call, leads, phoneIndex) {
  if (call.leadId) return call;
  const leadId = findLeadForClient(leads, null, call.clientPhone)?.id
    || (call.clientPhone && phoneIndex?.get(digitsOnly(call.clientPhone).slice(-10)));
  if (!leadId) return call;
  return { ...call, leadId };
}

function findLeadForClient(leads, clientCountryCode, clientNumber) {
  if (!Array.isArray(leads) || !clientNumber) return null;
  const client = normalizePhone(clientCountryCode, clientNumber);
  return leads.find((lead) => {
    const leadPhone = digitsOnly(lead.phone);
    if (!leadPhone) return false;
    return phonesMatch(leadPhone, client.full) || phonesMatch(leadPhone, client.last10);
  }) || null;
}

function employeeMatchesWebhook(employee, payload) {
  if (!employee) return false;
  const callyser = String(employee.callyserId || employee.callyser_id || "").trim();
  const empCode = String(employee.empCode || employee.emp_id || "").trim();
  const payloadCode = String(payload.emp_code || "").trim();
  const payloadNumber = normalizePhone(payload.emp_country_code, payload.emp_number);

  if (callyser && payloadCode && callyser === payloadCode) return true;
  if (empCode && payloadCode && empCode === payloadCode) return true;

  if (callyser && callyser.includes("-") && payloadNumber.hyphen === callyser) return true;
  if (employee.phone && phonesMatch(employee.phone, payloadNumber.full)) return true;

  const callyserDigits = digitsOnly(callyser);
  if (callyserDigits && phonesMatch(callyserDigits, payloadNumber.full)) return true;

  return false;
}

async function fetchCallHistory({ empNumbers, days = 30, pageSize = 100, maxPages = 5 }) {
  if (!empNumbers?.length) return [];

  const cacheKey = `${empNumbers.sort().join(",")}:${days}:${maxPages}`;
  const cached = historyCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 120000) {
    return cached.logs;
  }

  const callTo = Math.floor(Date.now() / 1000);
  const callFrom = callTo - Math.min(Number(days) || 30, 90) * 86400;

  const allLogs = [];
  let pageNo = 1;
  let totalRecords = Infinity;

  while (allLogs.length < totalRecords && pageNo <= maxPages) {
    const response = await callyzerPost("/call-log/history", {
      call_from: callFrom,
      call_to: callTo,
      emp_numbers: empNumbers,
      page_no: pageNo,
      page_size: Math.min(pageSize, 100),
    });

    const batch = Array.isArray(response.result) ? response.result : [];
    totalRecords = Number(response.total_records) || batch.length;
    allLogs.push(...batch);

    if (batch.length < Math.min(pageSize, 100)) break;
    pageNo += 1;
  }

  historyCache.set(cacheKey, { at: Date.now(), logs: allLogs });
  return allLogs;
}

const statsCache = new Map();

function formatDurationHms(seconds) {
  const total = Number(seconds) || 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}h ${m}m ${s}s`;
}

function weekStartMonday(now = new Date()) {
  const s = new Date(now);
  s.setHours(0, 0, 0, 0);
  const day = s.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  s.setDate(s.getDate() + diff);
  return s;
}

function getPeriodRange(period) {
  const now = new Date();
  const callTo = Math.floor(now.getTime() / 1000);
  let callFrom;

  if (period === "week") {
    const start = weekStartMonday(now);
    callFrom = Math.floor(start.getTime() / 1000);
  } else if (period === "month") {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    callFrom = Math.floor(start.getTime() / 1000);
  } else {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    callFrom = Math.floor(start.getTime() / 1000);
  }

  return { callFrom, callTo, period: period || "today" };
}

function mapEmployeeSummaryRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    empName: row.emp_name || null,
    empCode: row.emp_code || null,
    empNumber: row.emp_number || null,
    empCountryCode: row.emp_country_code || null,
    totalCalls: Number(row.total_calls) || 0,
    totalDurationSec: Number(row.total_duration) || 0,
    totalDuration: formatDurationHms(row.total_duration),
    incomingCalls: Number(row.total_incoming_calls) || 0,
    incomingDurationSec: Number(row.total_incoming_duration) || 0,
    incomingDuration: formatDurationHms(row.total_incoming_duration),
    outgoingCalls: Number(row.total_outgoing_calls) || 0,
    outgoingDurationSec: Number(row.total_outgoing_duration) || 0,
    outgoingDuration: formatDurationHms(row.total_outgoing_duration),
    missedCalls: Number(row.total_missed_calls) || 0,
    rejectedCalls: Number(row.total_rejected_calls) || 0,
    neverAttended: Number(row.total_never_attended_calls) || 0,
    notPickupByClient: Number(row.total_not_pickup_by_clients_calls) || 0,
    uniqueClients: Number(row.total_unique_clients) || 0,
    connectedCalls: Number(row.total_connected_calls) || 0,
    workingHours: row.total_working_hours || "00:00:00",
    lastCallLog: row.last_call_log || null,
  };
}

function extractEmployeeSummaryRows(response) {
  if (!response?.result) return [];
  if (Array.isArray(response.result)) return response.result;
  if (Array.isArray(response.result.employees)) return response.result.employees;
  if (typeof response.result === "object") return [response.result];
  return [];
}

async function fetchEmployeeSummary({ empNumbers, period = "today" }) {
  if (!empNumbers?.length) return null;

  const range = getPeriodRange(period);
  const cacheKey = `stats:${empNumbers.sort().join(",")}:${range.period}:${range.callFrom}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 120000) {
    return cached.stats;
  }

  const response = await callyzerPost("/call-log/employee-summary", {
    call_from: range.callFrom,
    call_to: range.callTo,
    emp_numbers: empNumbers,
    page_no: 1,
    page_size: 1,
  });

  const rows = extractEmployeeSummaryRows(response);
  const stats = mapEmployeeSummaryRow(rows[0]);
  statsCache.set(cacheKey, { at: Date.now(), stats });
  return stats;
}

async function fetchLongConversationStats({ empNumbers, period = "today" }) {
  if (!empNumbers?.length) {
    return { conversations5MinPlus: 0, conversations5MinDuration: "0h 0m 0s" };
  }

  const range = getPeriodRange(period);
  const cacheKey = `long-conv:${empNumbers.sort().join(",")}:${range.period}:${range.callFrom}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 120000) {
    return cached.stats;
  }

  const response = await callyzerPost("/call-log/summary", {
    call_from: range.callFrom,
    call_to: range.callTo,
    emp_numbers: empNumbers,
    duration_grt_than: CALL_CONVERSATION_MIN_SEC - 1,
  });

  const result = response.result && !Array.isArray(response.result) ? response.result : {};
  const stats = {
    conversations5MinPlus: Number(result.total_connected_calls) || Number(result.total_calls) || 0,
    conversations5MinDuration: formatDurationHms(result.total_duration),
  };
  statsCache.set(cacheKey, { at: Date.now(), stats });
  return stats;
}

async function fetchTeamSummary(period = "today") {
  const range = getPeriodRange(period);
  const cacheKey = `team-stats:${range.period}:${range.callFrom}`;
  const cached = statsCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 120000) {
    return cached.stats;
  }

  const response = await callyzerPost("/call-log/employee-summary", {
    call_from: range.callFrom,
    call_to: range.callTo,
    page_no: 1,
    page_size: 100,
  });

  const stats = extractEmployeeSummaryRows(response).map(mapEmployeeSummaryRow).filter(Boolean);
  statsCache.set(cacheKey, { at: Date.now(), stats });
  return stats;
}

async function getStatsForEmployee(employee, period = "today") {
  if (!isConfigured() || !employee) {
    return { configured: false, stats: null, message: "Callyzer not configured" };
  }

  const empNumbers = employeeEmpNumbers(employee);
  if (!empNumbers.length) {
    return {
      configured: true,
      stats: null,
      message: "Set Callyser ID in Team (e.g. 91-9462265230 from Callyzer employee list)",
    };
  }

  try {
    const stats = await fetchEmployeeSummary({ empNumbers, period });
    const longConv = await fetchLongConversationStats({ empNumbers, period });
    return {
      configured: true,
      stats: { ...stats, ...longConv },
      period: getPeriodRange(period).period,
    };
  } catch (err) {
    logger.error("Callyzer stats fetch failed", { employeeId: employee.id, message: err.message });
    return { configured: true, stats: null, message: err.message };
  }
}

async function autoCreateLeadForPhone(tenantId, employeeId, phone, name) {
  try {
    const last10 = phone.replace(/\D/g, "").slice(-10);
    const existing = await pool.query(
      "SELECT id FROM leads WHERE tenant_id = $1 AND (phone = $2 OR (phone IS NOT NULL AND RIGHT(REPLACE(phone, '-', ''), 10) = $3)) AND is_deleted = 0 LIMIT 1",
      [tenantId, phone, last10]
    );
    if (existing.rows.length > 0) {
      return existing.rows[0].id;
    }

    const result = await pool.query(
      `INSERT INTO leads (tenant_id, lead_name, phone, pipeline_stage, status, temperature, assigned_to, source, company_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [tenantId, name || "Unknown Lead", phone, "new", "new", "warm", employeeId, "Callyzer", "Callyzer Call"]
    );
    const newId = result.rows[0].id;

    await pool.query(
      `INSERT INTO lead_timeline_events (tenant_id, lead_id, type, actor_id, actor_name, actor_role, summary, payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [tenantId, newId, "lead_created", "system", "System", "system", `Lead created from Callyzer call with ${name || "Unknown Lead"}`, JSON.stringify({ source: "Callyzer" })]
    );

    return newId;
  } catch (err) {
    logger.error("Auto lead creation failed", { phone, message: err.message });
    return null;
  }
}

const lastEmployeeSyncAt = new Map();
const EMPLOYEE_SYNC_MIN_INTERVAL_MS = Number(process.env.CALLYZER_SYNC_INTERVAL_MS || 15000);

async function syncEmployeeCallsIfStale(tenantId, employee, { dbCalls = [], leads = [], days = 30, force = false } = {}) {
  if (!isConfigured() || !employee) return false;

  const key = `${tenantId}:${employee.id}`;
  const now = Date.now();
  if (!force && lastEmployeeSyncAt.get(key) && now - lastEmployeeSyncAt.get(key) < EMPLOYEE_SYNC_MIN_INTERVAL_MS) {
    return false;
  }

  await getCallsForEmployee(tenantId, employee, { dbCalls, leads, days });
  lastEmployeeSyncAt.set(key, now);
  return true;
}

async function getCallsForEmployee(tenantId, employee, { dbCalls = [], leads = [], days = 30, maxPages = 5, limit = null } = {}) {
  if (!isConfigured() || !employee) return dbCalls;

  const empNumbers = employeeEmpNumbers(employee);
  if (!empNumbers.length) {
    logger.warn("Callyzer: employee has no callyser_id or phone mapped", { employeeId: employee.id });
    return dbCalls;
  }

  try {
    const [logs, privatePhonesList] = await Promise.all([
      fetchCallHistory({ empNumbers, days, maxPages }),
      privateContactsRepo.getPrivatePhoneNumbers(tenantId, employee.id).catch(() => []),
    ]);
    const privatePhones = new Set(privatePhonesList || []);
    
    // Filter to ensure we only include call logs belonging to this employee and NOT in private contacts
    const empNumbersDigits = empNumbers.map(n => digitsOnly(n).slice(-10));
    const filteredLogs = logs.filter((log) => {
      const clientLast10 = digitsOnly(log.client_number || "").slice(-10);
      if (clientLast10 && privatePhones.has(clientLast10)) {
        return false; // Skip private contact calls
      }

      const logEmpNum = digitsOnly(log.emp_number || "");
      const logEmpCode = String(log.emp_code || "").trim();
      
      const callyser = String(employee.callyserId || employee.callyser_id || "").trim();
      const empCode = String(employee.empCode || employee.emp_id || "").trim();
      
      if (callyser && logEmpCode && callyser === logEmpCode) return true;
      if (empCode && logEmpCode && empCode === logEmpCode) return true;
      
      if (logEmpNum) {
        const last10 = logEmpNum.slice(-10);
        if (empNumbersDigits.includes(last10)) return true;
        if (employee.phone && digitsOnly(employee.phone).slice(-10) === last10) return true;
      }
      
      if (!logEmpNum && !logEmpCode) return true;
      return false;
    });

    const sanitizedDbCalls = (dbCalls || []).filter((c) => {
      const p = digitsOnly(c.clientPhone || "").slice(-10);
      return !p || !privatePhones.has(p);
    });

    const dbCallyzerIds = new Set(
      sanitizedDbCalls.map((c) => c.callyzerCallId).filter(Boolean),
    );

    const phoneIndex = buildLeadPhoneIndex(leads);
    const callyzerCalls = [];

    for (const log of filteredLogs) {
      
      let leadId = resolveLeadIdForLog(log, leads, phoneIndex);
      
      if (!leadId) {
        const clientPhone = normalizePhone(log.client_country_code, log.client_number).full || log.client_number;
        const leadName = log.client_name || "Unknown Lead";
        leadId = await autoCreateLeadForPhone(tenantId, employee.id, clientPhone, leadName);
      }

      if (!dbCallyzerIds.has(log.id)) {
        const mapped = mapLogToCall(log, employee.id, leadId);
        
        try {
          const insertRes = await pool.query(
            `INSERT INTO employee_calls (
               tenant_id, lead_id, employee_id, callyzer_call_id, direction, outcome,
               duration_sec, started_at, ended_at, recording_url, notes, ai_summary
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              tenantId,
              leadId || null,
              employee.id,
              mapped.callyzerCallId || null,
              mapped.direction || "outbound",
              mapped.outcome || null,
              mapped.durationSec || null,
              mapped.startedAt || null,
              mapped.endedAt || null,
              mapped.recordingUrl || null,
              mapped.notes || null,
              mapped.aiSummary || null,
            ]
          );
          const newCallId = insertRes.insertId || insertRes.rows?.[0]?.id;
          if (newCallId) {
            const { processCallWithAi } = require("./aiService");
            processCallWithAi(tenantId, newCallId).catch((err) => {
              logger.warn("Auto AI call processing skipped/failed", { callId: newCallId, error: err.message });
            });
          }
        } catch (e) {
          logger.error("Failed to save synced call log", { callyzerCallId: mapped.callyzerCallId, message: e.message });
        }
        
        callyzerCalls.push({ ...mapped, leadId });
      } else {
        const dbCall = dbCalls.find((c) => c.callyzerCallId === log.id);
        if (dbCall) {
          const mappedDirection = callTypeToDirection(log.call_type);
          const mappedOutcome = callTypeToOutcome(log.call_type, Number(log.duration) || 0);
          const needsDirectionFix = dbCall.direction !== mappedDirection
            && (mappedDirection === "outbound" || mappedDirection === "inbound");
          if (needsDirectionFix || (dbCall.outcome !== mappedOutcome && mappedOutcome)) {
            dbCall.direction = mappedDirection;
            dbCall.outcome = mappedOutcome || dbCall.outcome;
            try {
              await pool.query(
                "UPDATE employee_calls SET direction = $1, outcome = $2 WHERE tenant_id = $3 AND callyzer_call_id = $4",
                [mappedDirection, mappedOutcome || dbCall.outcome, tenantId, log.id],
              );
            } catch (e) {
              logger.error("Failed to update call direction", { callyzerCallId: log.id, message: e.message });
            }
          }
          if (!dbCall.leadId && leadId) {
            dbCall.leadId = leadId;
            try {
              await pool.query(
                "UPDATE employee_calls SET lead_id = $1 WHERE tenant_id = $2 AND callyzer_call_id = $3",
                [leadId, tenantId, log.id]
              );
            } catch (e) {
              logger.error("Failed to update call leadId", { callyzerCallId: log.id, message: e.message });
            }
          }
          if (!dbCall.clientPhone || !dbCall.clientName) {
            const matchedLead = leads.find((l) => String(l.id) === String(leadId));
            if (matchedLead) {
              dbCall.clientPhone = matchedLead.phone || matchedLead.clientPhone || null;
              dbCall.clientName = matchedLead.leadName || matchedLead.name || null;
            } else {
              dbCall.clientPhone = normalizePhone(log.client_country_code, log.client_number).full || log.client_number;
              dbCall.clientName = log.client_name || "Unknown Lead";
            }
          }
        }
      }
    }

    const { ensureAllCallsProcessedWithAi } = require("./aiService");
    ensureAllCallsProcessedWithAi(tenantId).catch(() => {});

    const merged = [...sanitizedDbCalls, ...callyzerCalls].map((c) => attachLeadToCall(c, leads, phoneIndex));
    merged.sort((a, b) => {
      const ta = new Date(a.startedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.startedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });
    if (limit == null) return merged;
    const max = Math.max(Number(limit) || 0, 1);
    return merged.slice(0, max);
  } catch (err) {
    logger.error("Callyzer call fetch failed", { employeeId: employee.id, message: err.message });
    return dbCalls;
  }
}

function verifyWebhookSecret(req) {
  const expected = process.env.CALLYZER_WEBHOOK_SECRET?.trim();
  if (!expected) return true;

  const provided = (
    req.headers["x-callyzer-secret"]
    || req.headers["x-webhook-secret"]
    || req.headers.secret
    || req.query?.secret
    || ""
  ).toString().trim();

  return provided && provided === expected;
}

module.exports = {
  isConfigured,
  callyzerPost,
  employeeEmpNumbers,
  normalizePhone,
  phonesMatch,
  formatLeadContactNumber,
  buildDialUrl,
  mapLogToCall,
  findLeadForClient,
  resolveLeadIdForLog,
  buildLeadPhoneIndex,
  attachLeadToCall,
  employeeMatchesWebhook,
  captureLeadForEmployee,
  prepareLeadCall,
  fetchCallHistory,
  fetchEmployeeSummary,
  fetchLongConversationStats,
  fetchTeamSummary,
  getStatsForEmployee,
  getPeriodRange,
  mapEmployeeSummaryRow,
  getCallsForEmployee,
  syncEmployeeCallsIfStale,
  verifyWebhookSecret,
};
