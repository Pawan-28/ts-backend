const {
  buildConnectUrl,
  handleOAuthCallback,
  getConnectionStatus,
  disconnectGoogle,
  createMeetLink,
  oauthSuccessRedirect,
  oauthErrorRedirect,
  isConfigured,
} = require("../services/googleMeetService");
const { authenticatedEmployeeId } = require("../middleware/auth");
const { logger } = require("../config/logger");

async function googleCallback(req, res) {
  const { code, state, error } = req.query;
  if (error) {
    logger.warn("Google OAuth denied", { error });
    return res.redirect(oauthErrorRedirect(error));
  }
  if (!code || !state) {
    return res.redirect(oauthErrorRedirect("missing_code"));
  }
  try {
    await handleOAuthCallback(String(code), String(state));
    return res.redirect(oauthSuccessRedirect());
  } catch (err) {
    logger.error("Google OAuth callback failed", { message: err.message });
    return res.redirect(oauthErrorRedirect(err.message));
  }
}

async function googleConnectUrl(req, res) {
  const employeeId = authenticatedEmployeeId(req);
  if (!employeeId) {
    return res.status(403).json({ success: false, message: "Employee account is not linked to a profile" });
  }
  if (!isConfigured()) {
    return res.status(503).json({
      success: false,
      message: "Google integration is not configured. Ask your admin to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
    });
  }
  const tenantId = req.headers["x-tenant-id"] || "default";
  const url = buildConnectUrl(employeeId, tenantId);
  return res.json({ success: true, url });
}

async function googleStatus(req, res) {
  const employeeId = authenticatedEmployeeId(req);
  if (!employeeId) {
    return res.status(403).json({ success: false, message: "Employee account is not linked to a profile" });
  }
  const status = await getConnectionStatus(employeeId);
  return res.json({ success: true, ...status });
}

async function googleDisconnect(req, res) {
  const employeeId = authenticatedEmployeeId(req);
  if (!employeeId) {
    return res.status(403).json({ success: false, message: "Employee account is not linked to a profile" });
  }
  await disconnectGoogle(employeeId);
  return res.json({ success: true, connected: false, googleEmail: null });
}

async function generateMeetLink(req, res) {
  const employeeId = authenticatedEmployeeId(req);
  if (!employeeId) {
    return res.status(403).json({ success: false, message: "Employee account is not linked to a profile" });
  }
  if (!isConfigured()) {
    return res.status(503).json({
      success: false,
      message: "Google integration is not configured on the server",
    });
  }

  const { title, date, time, durationMin, scheduledAt } = req.body || {};
  let when = scheduledAt;
  if (!when && date) {
    when = `${date}T${time || "09:00"}:00`;
  }
  if (!when) {
    return res.status(400).json({ success: false, message: "Meeting date and time are required" });
  }

  try {
    const meetLink = await createMeetLink({
      employeeId,
      title: title || "CRM Meeting",
      scheduledAt: when,
      durationMin: durationMin || 30,
    });
    return res.json({ success: true, meetLink });
  } catch (err) {
    return res.status(err.status || 500).json({
      success: false,
      message: err.message || "Could not generate Google Meet link",
    });
  }
}

module.exports = {
  googleCallback,
  googleConnectUrl,
  googleStatus,
  googleDisconnect,
  generateMeetLink,
};
