/**
 * Who may call what, in ONE table (S-06). It runs right after `authenticate`, so `req.user` is always a real, logged-in user.
 *
 *   admin    -> everything
 *   employee -> everything EXCEPT the rules below (company-wide reports, settings, other people's data, admin tooling)
 *
 * Employee-only data scoping (own leads, own calls ...) still lives in the routes (requireEmployeeSelf, requireEmployeeOwnsLead ...).
 * `decideAccess` is a pure function so it can be tested without a server.
 */
const { isPublicApiPath } = require("./auth");

// Fields an employee may change on their OWN profile (PUT /api/v1/employees/:id). Never salary, targets, role, status, email ...
const SELF_EDITABLE_EMPLOYEE_FIELDS = new Set(["avatarUrl", "avatar_url", "avatar"]);

const norm = (p) => String(p || "").split("?")[0].replace(/\/+$/, "").toLowerCase() || "/";

const ADMIN_ONLY_ANY_METHOD = [
  /^\/api\/dashboard(\/|$)/,
  /^\/api\/sales(\/|$)/,
  /^\/api\/reports(\/|$)/,
  /^\/api\/settings(\/|$)/,
  /^\/api\/forms(\/|$)/,
  /^\/api\/team\/(dashboard|performance|kpis|chart-data|callyzer-stats)$/,
  /^\/api\/team\/employees\/(details|leads)(\/|$)/,
  /^\/api\/team\/employees\/(create|update)$/,
  /^\/api\/team\/employees\/[^/]+\/reset-password$/,
  /^\/api\/v1\/assignment\/(config|run-round-robin|audit|bulk-assign|schedule-assign)$/,
  /^\/api\/v1\/assignment\/employees(\/|$)/,
  /^\/api\/v1\/leads-queue$/,
  /^\/api\/v1\/audit$/,
  /^\/api\/v1\/analytics(\/|$)/,
];

// Employees may READ these (the catalogue, the SOP library, the SOP comments) but not change them.
const ADMIN_ONLY_WRITES = [
  /^\/api\/services(\/|$)/,
  /^\/api\/sop(\/|$)/,
  /^\/api\/v1\/sops(\/|$)/,
];
const SOP_COMMENT = /^\/api\/(sop|v1\/sops)\/[^/]+\/comment(\/[^/]+)?$/;

const EMPLOYEE_SELF_ONLY = [
  // GET only; the id in the URL must be the logged-in employee's own
  { re: /^\/api\/team\/employees\/([^/]+)\/(callyzer-stats|competency-scores)$/, methods: ["GET"] },
  { re: /^\/api\/incentives\/employee\/([^/]+)\/cash-summary$/, methods: ["GET"] },
];

const deny = (status, message) => ({ allowed: false, status, message });
const ALLOW = { allowed: true };

function decideAccess({ method = "GET", path = "", user = null, body = null } = {}) {
  if (!user) return deny(401, "Please log in to continue");
  if (user.role === "admin") return ALLOW;
  if (user.role !== "employee") return deny(403, "Access denied");

  const p = norm(path);
  const m = String(method).toUpperCase();
  const selfId = user.employeeId == null ? null : String(user.employeeId);

  // 1. the few company-wide reads an employee may do for THEMSELVES
  for (const rule of EMPLOYEE_SELF_ONLY) {
    const hit = rule.re.exec(p);
    if (hit) {
      if (!rule.methods.includes(m)) return deny(403, "Admin access required");
      if (!selfId || String(hit[1]) !== selfId) return deny(403, "You can only access your own data");
      return ALLOW;
    }
  }

  // 2. everything company-wide / admin tooling
  if (ADMIN_ONLY_ANY_METHOD.some((re) => re.test(p))) return deny(403, "Admin access required");
  if (/^\/api\/incentives(\/|$)/.test(p)) return deny(403, "Admin access required");

  // 3. library data: read yes, change no (SOP comments are open to everybody)
  if (ADMIN_ONLY_WRITES.some((re) => re.test(p)) && m !== "GET" && m !== "HEAD" && !SOP_COMMENT.test(p)) {
    return deny(403, "Admin access required");
  }

  // 4. employees and leads in the operational API
  if (m === "POST" && p === "/api/v1/employees") return deny(403, "Admin access required");
  if (m === "DELETE" && /^\/api\/v1\/employees\/[^/]+$/.test(p)) return deny(403, "Admin access required");
  if (m === "DELETE" && /^\/api\/v1\/leads\/[^/]+$/.test(p)) return deny(403, "Admin access required");
  if (m === "DELETE" && /^\/api\/team\/employees\/[^/]+$/.test(p)) return deny(403, "Admin access required");
  const own = /^\/api\/v1\/employees\/([^/]+)$/.exec(p);
  if (own && (m === "PUT" || m === "PATCH")) {
    if (!selfId || own[1] !== selfId) return deny(403, "You can only edit your own profile");
    const keys = Object.keys(body && typeof body === "object" ? body : {});
    const forbidden = keys.filter((k) => !SELF_EDITABLE_EMPLOYEE_FIELDS.has(k));
    if (forbidden.length) return deny(403, `You cannot change: ${forbidden.join(", ")}`);
    return ALLOW;
  }

  return ALLOW;
}

function enforceAccessPolicy(req, res, next) {
  const apiPath = String(req.originalUrl || "").split("?")[0];
  if (!apiPath.startsWith("/api")) return next();
  if (isPublicApiPath(apiPath)) return next(); // login + machine-to-machine webhooks
  // `authenticate` has already answered 401 for anyone not logged in; if it somehow did not run, fail closed.
  const verdict = decideAccess({ method: req.method, path: apiPath, user: req.user, body: req.body });
  if (verdict.allowed) return next();
  return res.status(verdict.status).json({ success: false, message: verdict.message });
}

module.exports = { decideAccess, enforceAccessPolicy, SELF_EDITABLE_EMPLOYEE_FIELDS };
