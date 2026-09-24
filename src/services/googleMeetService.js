const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { google } = require("googleapis");
const pool = require("../../config/db");
const { verifyToken, JWT_SECRET } = require("../utils/token");
const { APP_TZ } = require("../utils/appTimezone");
const { logger } = require("../config/logger");

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "openid",
];
const OAUTH_STATE_PURPOSE = "google_oauth";

function isConfigured() {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID
    && process.env.GOOGLE_CLIENT_SECRET
    && process.env.GOOGLE_REDIRECT_URI,
  );
}

function getOAuthClient() {
  if (!isConfigured()) {
    const err = new Error("Google OAuth is not configured on the server");
    err.status = 503;
    throw err;
  }
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI,
  );
}

function signOAuthState(employeeId, tenantId = "default") {
  return jwt.sign({
    purpose: OAUTH_STATE_PURPOSE,
    employeeId: Number(employeeId),
    tenantId: String(tenantId || "default"),
  }, JWT_SECRET, { expiresIn: "5m" });
}

function verifyOAuthState(state) {
  const payload = verifyToken(String(state || ""));
  if (payload.purpose !== OAUTH_STATE_PURPOSE || !payload.employeeId) {
    const err = new Error("Invalid OAuth state");
    err.status = 400;
    throw err;
  }
  return {
    employeeId: Number(payload.employeeId),
    tenantId: String(payload.tenantId || "default"),
  };
}

function buildConnectUrl(employeeId, tenantId = "default") {
  const client = getOAuthClient();
  const state = signOAuthState(employeeId, tenantId);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    state,
  });
}

async function findOAuthRow(employeeId) {
  const result = await pool.query(
    `SELECT * FROM employee_google_oauth WHERE employee_id = $1 LIMIT 1`,
    [Number(employeeId)],
  );
  return result.rows[0] || null;
}

async function upsertOAuthRow({
  tenantId,
  employeeId,
  googleEmail,
  accessToken,
  refreshToken,
  tokenExpiry,
  scopes,
}) {
  await pool.query(
    `INSERT INTO employee_google_oauth (
       tenant_id, employee_id, google_email, access_token, refresh_token, token_expiry, scopes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON DUPLICATE KEY UPDATE
       google_email = VALUES(google_email),
       access_token = VALUES(access_token),
       refresh_token = VALUES(refresh_token),
       token_expiry = VALUES(token_expiry),
       scopes = VALUES(scopes),
       updated_at = CURRENT_TIMESTAMP`,
    [
      tenantId || "default",
      Number(employeeId),
      googleEmail,
      accessToken,
      refreshToken,
      tokenExpiry || null,
      scopes || SCOPES.join(" "),
    ],
  );
}

async function handleOAuthCallback(code, state) {
  const { employeeId, tenantId } = verifyOAuthState(state);
  const client = getOAuthClient();
  const { tokens } = await client.getToken(code);
  client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: client });
  const profile = await oauth2.userinfo.get();
  const googleEmail = profile.data.email;
  if (!googleEmail) {
    const err = new Error("Could not read Google account email");
    err.status = 400;
    throw err;
  }

  const tokenExpiry = tokens.expiry_date
    ? new Date(tokens.expiry_date)
    : null;

  await upsertOAuthRow({
    tenantId,
    employeeId,
    googleEmail,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || (await findOAuthRow(employeeId))?.refresh_token,
    tokenExpiry,
    scopes: SCOPES.join(" "),
  });

  if (!tokens.refresh_token) {
    logger.warn("Google OAuth completed without refresh_token", { employeeId });
  }

  return { employeeId, googleEmail };
}

async function getConnectionStatus(employeeId) {
  if (!isConfigured()) {
    return { configured: false, connected: false, googleEmail: null };
  }
  const row = await findOAuthRow(employeeId);
  if (!row) {
    return { configured: true, connected: false, googleEmail: null };
  }
  return {
    configured: true,
    connected: true,
    googleEmail: row.google_email,
    connectedAt: row.connected_at,
  };
}

async function disconnectGoogle(employeeId) {
  const row = await findOAuthRow(employeeId);
  if (row?.access_token) {
    try {
      const client = getOAuthClient();
      await client.revokeToken(row.access_token);
    } catch (err) {
      logger.warn("Google token revoke failed", { employeeId, message: err.message });
    }
  }
  await pool.query(
    `DELETE FROM employee_google_oauth WHERE employee_id = $1`,
    [Number(employeeId)],
  );
  return { connected: false };
}

function parseScheduledInstant(scheduledAt) {
  if (scheduledAt instanceof Date && !Number.isNaN(scheduledAt.getTime())) {
    return scheduledAt;
  }
  const raw = String(scheduledAt || "").trim();
  if (!raw) {
    const err = new Error("Meeting date and time are required");
    err.status = 400;
    throw err;
  }
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withTz = /[Zz]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}+05:30`;
  const d = new Date(withTz);
  if (Number.isNaN(d.getTime())) {
    const err = new Error("Invalid meeting date or time");
    err.status = 400;
    throw err;
  }
  return d;
}

async function refreshAccessTokenIfNeeded(row) {
  const client = getOAuthClient();
  client.setCredentials({
    access_token: row.access_token,
    refresh_token: row.refresh_token,
    expiry_date: row.token_expiry ? new Date(row.token_expiry).getTime() : null,
  });

  const expiryMs = row.token_expiry ? new Date(row.token_expiry).getTime() : 0;
  const needsRefresh = !expiryMs || expiryMs <= Date.now() + 60_000;
  if (needsRefresh && row.refresh_token) {
    const { credentials } = await client.refreshAccessToken();
    client.setCredentials(credentials);
    const tokenExpiry = credentials.expiry_date
      ? new Date(credentials.expiry_date)
      : null;
    await pool.query(
      `UPDATE employee_google_oauth
       SET access_token = $1, token_expiry = $2, updated_at = CURRENT_TIMESTAMP
       WHERE employee_id = $3`,
      [
        credentials.access_token,
        tokenExpiry,
        Number(row.employee_id),
      ],
    );
  }

  return client;
}

async function createMeetLink({ employeeId, title, scheduledAt, durationMin = 30 }) {
  const row = await findOAuthRow(employeeId);
  if (!row) {
    const err = new Error("Connect Google in Profile → Preferences before creating a Google Meet link");
    err.status = 400;
    throw err;
  }

  const auth = await refreshAccessTokenIfNeeded(row);
  const calendar = google.calendar({ version: "v3", auth });
  const start = parseScheduledInstant(scheduledAt);
  const end = new Date(start.getTime() + Math.max(Number(durationMin) || 30, 15) * 60 * 1000);

  const event = {
    summary: String(title || "CRM Meeting").trim() || "CRM Meeting",
    start: { dateTime: start.toISOString(), timeZone: APP_TZ },
    end: { dateTime: end.toISOString(), timeZone: APP_TZ },
    conferenceData: {
      createRequest: {
        requestId: crypto.randomUUID(),
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  const response = await calendar.events.insert({
    calendarId: "primary",
    resource: event,
    conferenceDataVersion: 1,
  });

  const meetLink = response.data.hangoutLink
    || response.data.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri;

  if (!meetLink) {
    const err = new Error("Google did not return a Meet link — try again");
    err.status = 502;
    throw err;
  }

  return meetLink;
}

function oauthSuccessRedirect() {
  return process.env.GOOGLE_OAUTH_SUCCESS_URL
    || `${process.env.FRONTEND_URL?.split(",")[0]?.trim() || "http://localhost:8080"}/employee/profile?google=connected`;
}

function oauthErrorRedirect(message) {
  const base = process.env.GOOGLE_OAUTH_ERROR_URL
    || `${process.env.FRONTEND_URL?.split(",")[0]?.trim() || "http://localhost:8080"}/employee/profile?google=error`;
  const url = new URL(base);
  if (message) url.searchParams.set("reason", String(message).slice(0, 120));
  return url.toString();
}

module.exports = {
  SCOPES,
  isConfigured,
  buildConnectUrl,
  handleOAuthCallback,
  getConnectionStatus,
  disconnectGoogle,
  createMeetLink,
  oauthSuccessRedirect,
  oauthErrorRedirect,
};
