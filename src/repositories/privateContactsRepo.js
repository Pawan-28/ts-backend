const pool = require("../../config/db");
const { logger } = require("../config/logger");

function normalizePhone10(rawPhone) {
  if (!rawPhone) return "";
  const digits = String(rawPhone).replace(/\D/g, "");
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

function mapContact(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    employeeId: row.employee_id,
    name: row.name,
    phone: row.phone,
    phoneNormalized: row.phone_normalized,
    relation: row.relation || "Personal",
    notes: row.notes || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function listPrivateContacts(tenantId, employeeId) {
  const empId = Number(employeeId);
  const result = await pool.query(
    `SELECT * FROM employee_private_contacts
     WHERE tenant_id = $1 AND employee_id = $2
     ORDER BY created_at DESC`,
    [tenantId || "default", empId]
  );
  return result.rows.map(mapContact);
}

async function getPrivatePhoneNumbers(tenantId, employeeId) {
  const empId = Number(employeeId);
  const result = await pool.query(
    `SELECT phone_normalized FROM employee_private_contacts
     WHERE tenant_id = $1 AND employee_id = $2`,
    [tenantId || "default", empId]
  );
  return result.rows.map((r) => r.phone_normalized).filter(Boolean);
}

async function isPhonePrivateForEmployee(tenantId, employeeId, rawPhone) {
  const last10 = normalizePhone10(rawPhone);
  if (!last10 || last10.length < 10) return false;
  const empId = Number(employeeId);
  const result = await pool.query(
    `SELECT id FROM employee_private_contacts
     WHERE tenant_id = $1 AND employee_id = $2 AND phone_normalized = $3
     LIMIT 1`,
    [tenantId || "default", empId, last10]
  );
  return result.rows.length > 0;
}

async function purgePrivateCallsAndLeads(tenantId, employeeId, phoneNormalized) {
  if (!phoneNormalized || phoneNormalized.length < 10) return { deletedCalls: 0, deletedLeads: 0 };
  const empId = Number(employeeId);
  const tid = tenantId || "default";

  try {
    // 1. Find and delete calls for this employee matching this private number
    const deleteCallsRes = await pool.query(
      `DELETE ec FROM employee_calls ec
       LEFT JOIN leads l ON ec.lead_id = l.id
       WHERE ec.tenant_id = $1
         AND ec.employee_id = $2
         AND (
           (l.phone IS NOT NULL AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(l.phone, ' ', ''), '+', ''), '-', ''), '(', ''), 10) = $3)
           OR (ec.recording_url IS NOT NULL AND ec.recording_url LIKE $4)
         )`,
      [tid, empId, phoneNormalized, `%${phoneNormalized}%`]
    );

    // 2. Also delete any auto-created Callyzer leads solely created for this private number for this employee
    const deleteLeadsRes = await pool.query(
      `DELETE FROM leads
       WHERE tenant_id = $1
         AND assigned_to = $2
         AND RIGHT(REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '+', ''), '-', ''), '(', ''), 10) = $3
         AND (source = 'Callyzer' OR company_name = 'Callyzer Call' OR lead_name LIKE 'Unknown%')
         AND (pipeline_stage = 'new' OR pipeline_stage IS NULL)`,
      [tid, empId, phoneNormalized]
    );

    const deletedCalls = deleteCallsRes.affectedRows || deleteCallsRes.rowCount || 0;
    const deletedLeads = deleteLeadsRes.affectedRows || deleteLeadsRes.rowCount || 0;

    logger.info("Purged private calls and placeholder leads", {
      employeeId: empId,
      phoneNormalized,
      deletedCalls,
      deletedLeads,
    });

    return { deletedCalls, deletedLeads };
  } catch (err) {
    logger.error("Failed to purge private calls", {
      employeeId: empId,
      phoneNormalized,
      error: err.message,
    });
    return { deletedCalls: 0, deletedLeads: 0 };
  }
}

async function addPrivateContact(tenantId, employeeId, data) {
  const empId = Number(employeeId);
  const tid = tenantId || "default";
  const name = String(data.name || "").trim();
  const phone = String(data.phone || "").trim();
  const relation = String(data.relation || "Personal").trim();
  const notes = data.notes ? String(data.notes).trim() : null;

  if (!name) {
    const err = new Error("Contact name is required");
    err.status = 400;
    throw err;
  }

  const phoneNormalized = normalizePhone10(phone);
  if (!phoneNormalized || phoneNormalized.length < 10) {
    const err = new Error("A valid 10-digit phone number is required");
    err.status = 400;
    throw err;
  }

  // Check duplicate
  const existing = await pool.query(
    `SELECT id FROM employee_private_contacts
     WHERE tenant_id = $1 AND employee_id = $2 AND phone_normalized = $3
     LIMIT 1`,
    [tid, empId, phoneNormalized]
  );

  if (existing.rows.length > 0) {
    const err = new Error("This phone number is already in your private contacts list");
    err.status = 409;
    throw err;
  }

  const insertRes = await pool.query(
    `INSERT INTO employee_private_contacts (tenant_id, employee_id, name, phone, phone_normalized, relation, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tid, empId, name, phone, phoneNormalized, relation, notes]
  );

  const newId = insertRes.insertId || insertRes.rows?.[0]?.id;

  // Immediately purge any existing calls & placeholder leads
  await purgePrivateCallsAndLeads(tid, empId, phoneNormalized);

  const fetchRes = await pool.query(
    `SELECT * FROM employee_private_contacts WHERE id = $1 LIMIT 1`,
    [newId]
  );
  return mapContact(fetchRes.rows[0]);
}

async function deletePrivateContact(tenantId, employeeId, contactId) {
  const empId = Number(employeeId);
  const cId = Number(contactId);
  const tid = tenantId || "default";

  const result = await pool.query(
    `DELETE FROM employee_private_contacts
     WHERE id = $1 AND tenant_id = $2 AND employee_id = $3`,
    [cId, tid, empId]
  );

  return (result.affectedRows || result.rowCount || 0) > 0;
}

module.exports = {
  normalizePhone10,
  listPrivateContacts,
  getPrivatePhoneNumbers,
  isPhonePrivateForEmployee,
  purgePrivateCallsAndLeads,
  addPrivateContact,
  deletePrivateContact,
};
