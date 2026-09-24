const privateContactsRepo = require("../repositories/privateContactsRepo");
const { logger } = require("../config/logger");

function getTenantId(req) {
  return req.headers["x-tenant-id"] || req.query.tenantId || req.tenantId || "default";
}

async function getPrivateContacts(req, res) {
  try {
    const tenantId = getTenantId(req);
    const employeeId = req.params.employeeId || req.params.id;
    if (!employeeId) {
      return res.status(400).json({ success: false, message: "Employee ID is required" });
    }

    const contacts = await privateContactsRepo.listPrivateContacts(tenantId, employeeId);
    return res.json({
      success: true,
      data: contacts,
      count: contacts.length,
    });
  } catch (error) {
    logger.error("Error fetching private contacts", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
}

async function createPrivateContact(req, res) {
  try {
    const tenantId = getTenantId(req);
    const employeeId = req.params.employeeId || req.params.id;
    if (!employeeId) {
      return res.status(400).json({ success: false, message: "Employee ID is required" });
    }

    const { name, phone, relation, notes } = req.body;
    if (!name || !phone) {
      return res.status(400).json({ success: false, message: "Name and phone number are required" });
    }

    const contact = await privateContactsRepo.addPrivateContact(tenantId, employeeId, {
      name,
      phone,
      relation,
      notes,
    });

    return res.status(201).json({
      success: true,
      message: "Private contact added successfully. Related call data will remain strictly excluded from all dashboards.",
      data: contact,
    });
  } catch (error) {
    const status = error.status || 500;
    logger.error("Error creating private contact", { error: error.message });
    return res.status(status).json({ success: false, message: error.message });
  }
}

async function removePrivateContact(req, res) {
  try {
    const tenantId = getTenantId(req);
    const employeeId = req.params.employeeId;
    const contactId = req.params.id;

    if (!employeeId || !contactId) {
      return res.status(400).json({ success: false, message: "Employee ID and Contact ID are required" });
    }

    const deleted = await privateContactsRepo.deletePrivateContact(tenantId, employeeId, contactId);
    if (!deleted) {
      return res.status(404).json({ success: false, message: "Private contact not found" });
    }

    return res.json({
      success: true,
      message: "Private contact removed successfully",
    });
  } catch (error) {
    logger.error("Error deleting private contact", { error: error.message });
    return res.status(500).json({ success: false, message: error.message });
  }
}

module.exports = {
  getPrivateContacts,
  createPrivateContact,
  removePrivateContact,
};
