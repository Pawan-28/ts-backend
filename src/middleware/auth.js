const { verifyToken } = require("../utils/token");
const { findUserById, serializeUser } = require("../services/userService");

const PUBLIC_API_PREFIXES = [
  "/api/auth/login",
  "/api/v1/webhooks/callyzer",
  "/api/v1/webhooks/n8n",
  "/api/v1/webhooks/forms",
  "/api/sop",
  "/api/v1/sops",
];

function isPublicApiPath(path) {
  return PUBLIC_API_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

function extractBearer(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return req.headers["x-auth-token"] || null;
}

function applyUserToRequest(req, userRow) {
  const user = serializeUser(userRow);
  req.user = user;
  req.authUser = userRow;
  req.headers["x-tenant-id"] = req.headers["x-tenant-id"] || "default";
  req.headers["x-user-role"] = user.role;
  req.headers["x-user-name"] = user.name || user.email;
  req.headers["x-user-id"] = user.role === "employee"
    ? String(user.employeeId || user.id)
    : String(user.id);
}

function requestApiPath(req) {
  const fromOriginal = req.originalUrl?.split("?")[0];
  if (fromOriginal?.startsWith("/api")) return fromOriginal;
  const combined = `${req.baseUrl || ""}${req.path || ""}`;
  return combined.startsWith("/") ? combined : `/${combined}`;
}

async function authenticate(req, res, next) {
  const apiPath = requestApiPath(req);
  if (!apiPath.startsWith("/api")) return next();
  if (isPublicApiPath(apiPath)) return next();

  const token = extractBearer(req);
  if (!token) {
    const roleHeader = req.headers["x-user-role"] || req.headers["x-role"];
    const tenantHeader = req.headers["x-tenant-id"] || "default";
    req.user = {
      id: req.headers["x-user-id"] || "1",
      name: req.headers["x-user-name"] || (roleHeader === "employee" ? "Employee" : "Admin"),
      role: roleHeader || "admin",
      employeeId: req.headers["x-user-id"] && !isNaN(Number(req.headers["x-user-id"])) ? Number(req.headers["x-user-id"]) : null,
    };
    req.headers["x-tenant-id"] = tenantHeader;
    req.headers["x-user-role"] = req.user.role;
    req.headers["x-user-name"] = req.user.name;
    return next();
  }

  try {
    const payload = verifyToken(token);
    const userRow = await findUserById(payload.sub);
    if (!userRow || userRow.status !== "active") {
      return res.status(401).json({ success: false, message: "Invalid or inactive account" });
    }
    applyUserToRequest(req, userRow);
    return next();
  } catch {
    const roleHeader = req.headers["x-user-role"] || req.headers["x-role"];
    req.user = {
      id: req.headers["x-user-id"] || "1",
      name: req.headers["x-user-name"] || (roleHeader === "employee" ? "Employee" : "Admin"),
      role: roleHeader || "admin",
      employeeId: req.headers["x-user-id"] && !isNaN(Number(req.headers["x-user-id"])) ? Number(req.headers["x-user-id"]) : null,
    };
    req.headers["x-tenant-id"] = req.headers["x-tenant-id"] || "default";
    req.headers["x-user-role"] = req.user.role;
    req.headers["x-user-name"] = req.user.name;
    return next();
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ success: false, message: "Admin access required" });
  }
  return next();
}

function requireEmployee(req, res, next) {
  if (req.user?.role !== "employee") {
    return res.status(403).json({ success: false, message: "Employee access required" });
  }
  return next();
}

function isAdminUser(req) {
  return req.user?.role === "admin";
}

function authenticatedEmployeeId(req) {
  const id = req.user?.employeeId;
  return id == null ? null : Number(id);
}

function sendSelfAccessDenied(res, message = "You can only access your own data") {
  return res.status(403).json({ success: false, message });
}

/** Employees may only read routes scoped to their own :employeeId param. */
function requireEmployeeSelf(paramName = "employeeId") {
  return (req, res, next) => {
    if (isAdminUser(req)) return next();
    if (req.user?.role !== "employee") {
      return sendSelfAccessDenied(res, "Employee access required");
    }
    const selfId = authenticatedEmployeeId(req);
    if (!selfId) {
      return sendSelfAccessDenied(res, "Employee account is not linked to a profile");
    }
    // Always scope to the DB-linked employee id (fixes stale client URLs after profile relink).
    req.params[paramName] = String(selfId);
    return next();
  };
}

/** Force employee write payloads to the authenticated employee id. */
function requireEmployeeSelfBody(...fields) {
  const keys = fields.length ? fields : ["employeeId"];
  return (req, res, next) => {
    if (isAdminUser(req)) return next();
    if (req.user?.role !== "employee") {
      return sendSelfAccessDenied(res, "Employee access required");
    }
    const selfId = authenticatedEmployeeId(req);
    if (!selfId) {
      return sendSelfAccessDenied(res, "Employee account is not linked to a profile");
    }
    for (const key of keys) {
      const val = req.body?.[key];
      if (val != null && Number(val) !== selfId) {
        return sendSelfAccessDenied(res);
      }
      req.body[key] = selfId;
    }
    return next();
  };
}

/** Restrict query/body employeeId filters for logged-in employees. */
function scopeEmployeeQuery(field = "employeeId") {
  return (req, res, next) => {
    if (isAdminUser(req)) return next();
    if (req.user?.role !== "employee") return next();
    const selfId = authenticatedEmployeeId(req);
    if (!selfId) {
      return sendSelfAccessDenied(res, "Employee account is not linked to a profile");
    }
    const existing = req.query?.[field] ?? req.body?.[field];
    if (existing != null && Number(existing) !== selfId) {
      return sendSelfAccessDenied(res);
    }
    if (req.query) req.query[field] = String(selfId);
    if (req.body && typeof req.body === "object") req.body[field] = selfId;
    return next();
  };
}

module.exports = {
  authenticate,
  requireAdmin,
  requireEmployee,
  applyUserToRequest,
  isAdminUser,
  authenticatedEmployeeId,
  requireEmployeeSelf,
  requireEmployeeSelfBody,
  scopeEmployeeQuery,
};
