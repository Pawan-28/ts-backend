// Run: node --test src/middleware/accessPolicy.test.js
// S-02 / S-06 / E-05: no login = 401 (never "admin"), employees cannot reach admin routes, colleagues' private fields are hidden.
// The real Express app is started on a random port with real signed tokens; only the user lookup is replaced by two fake users.
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");

process.env.NODE_ENV = "test";
delete process.env.ALLOW_HEADER_AUTH;

const userServicePath = require.resolve("../services/userService");
const USERS = {
  1: { id: 1, role: "admin", status: "active", email: "admin@x.com", login_id: "admin" },
  2: { id: 2, role: "employee", status: "active", employee_id: 7, email: "emp@x.com", login_id: "emp", employee_name: "Emp Seven" },
  3: { id: 3, role: "admin", status: "inactive", email: "old@x.com", login_id: "old" },
};
require.cache[userServicePath] = {
  id: userServicePath,
  filename: userServicePath,
  loaded: true,
  exports: {
    findUserById: async (id) => USERS[id] || null,
    serializeUser: (row) => ({ id: row.id, role: row.role, employeeId: row.employee_id ?? null, name: row.employee_name || "Admin", email: row.email }),
  },
};

const { signToken } = require("../utils/token");
const { decideAccess } = require("./accessPolicy");
const { redactEmployee, redactEmployees } = require("../utils/employeePrivacy");
const app = require("../app");

let server;
let base;
test.before(async () => {
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const adminToken = signToken({ sub: 1 });
const empToken = signToken({ sub: 2 });
const inactiveToken = signToken({ sub: 3 });

async function call(method, url, { token, headers = {}, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.status;
}

test("no token / bad token = 401, even when the request claims to be the admin by headers", async () => {
  const spoof = { "x-user-role": "admin", "x-user-id": "1" };
  for (const url of ["/api/settings", "/api/team/employees", "/api/v1/employees", "/api/sop/all", "/api/v1/sops", "/api/sales/dashboard", "/api/dashboard"]) {
    assert.equal(await call("GET", url), 401, `${url} without a token`);
    assert.equal(await call("GET", url, { headers: spoof }), 401, `${url} with spoofed headers`);
    assert.equal(await call("GET", url, { token: "not.a.token", headers: spoof }), 401, `${url} with a garbage token`);
  }
  assert.equal(await call("PUT", "/api/settings", { body: { x: 1 }, headers: spoof }), 401);
  assert.equal(await call("POST", "/api/sop/create", { body: { title: "x" } }), 401, "public SOP writes are closed");
  assert.equal(await call("GET", "/api/dashboard", { token: inactiveToken }), 401, "an inactive account is refused");
});

test("login and the webhooks stay reachable without a token", async () => {
  assert.notEqual(await call("POST", "/api/auth/login", { body: {} }), 401);
  assert.notEqual(await call("POST", "/api/v1/webhooks/n8n", { body: {} }), 401);
  assert.notEqual(await call("POST", "/api/v1/webhooks/callyzer", { body: {} }), 401);
  assert.equal((await fetch(`${base}/health`)).status, 200);
});

test("an employee cannot reach admin routes", async () => {
  const deny = [
    ["GET", "/api/settings"], ["PUT", "/api/settings"], ["GET", "/api/sales/dashboard"], ["GET", "/api/reports/dashboard"],
    ["GET", "/api/dashboard"], ["GET", "/api/incentives/dashboard"], ["GET", "/api/forms"], ["POST", "/api/forms"],
    ["POST", "/api/services"], ["DELETE", "/api/services/5"], ["POST", "/api/sop/create"], ["PUT", "/api/sop/3"], ["DELETE", "/api/sop/3"],
    ["POST", "/api/sop/generate-ai"], ["GET", "/api/team/kpis"], ["GET", "/api/team/callyzer-stats"], ["GET", "/api/team/employees/leads"],
    ["POST", "/api/team/employees/update"], ["POST", "/api/team/employees/create"], ["GET", "/api/team/employees/9/callyzer-stats"],
    ["GET", "/api/incentives/employee/9/cash-summary"], ["PUT", "/api/v1/assignment/config"], ["POST", "/api/v1/assignment/run-round-robin"],
    ["POST", "/api/v1/assignment/employees/3/pause"], ["GET", "/api/v1/assignment/audit"], ["POST", "/api/v1/assignment/bulk-assign"],
    ["POST", "/api/v1/employees"], ["DELETE", "/api/v1/employees/3"], ["PUT", "/api/v1/employees/3"], ["GET", "/api/v1/audit"],
    ["DELETE", "/api/v1/leads/5"], ["GET", "/api/v1/leads-queue"],
  ];
  for (const [m, url] of deny) assert.equal(await call(m, url, { token: empToken, body: m === "GET" || m === "DELETE" ? undefined : { a: 1 } }), 403, `${m} ${url}`);
});

test("an employee keeps what the employee panel needs", async () => {
  const allow = [
    ["GET", "/api/services"], ["GET", "/api/sop/all"], ["GET", "/api/v1/sops"], ["GET", "/api/team/employees"], ["GET", "/api/v1/employees"],
    ["GET", "/api/team/employees/7/callyzer-stats"], ["GET", "/api/team/employees/7/competency-scores"], ["GET", "/api/incentives/employee/7/cash-summary"],
    ["GET", "/api/activity/notifications"], ["POST", "/api/sop/12/comment"],
  ];
  for (const [m, url] of allow) {
    const status = await call(m, url, { token: empToken, body: m === "POST" ? { text: "x" } : undefined });
    assert.ok(status !== 401 && status !== 403, `${m} ${url} -> ${status}`);
  }
  // own profile: only the avatar
  const own = await call("PUT", "/api/v1/employees/7", { token: empToken, body: { avatarUrl: "https://x/y.png" } });
  assert.ok(own !== 401 && own !== 403, `own avatar -> ${own}`);
  assert.equal(await call("PUT", "/api/v1/employees/7", { token: empToken, body: { salary: 999999 } }), 403, "no self-service raise");
  assert.equal(await call("PUT", "/api/v1/employees/7", { token: empToken, body: { avatarUrl: "x", role: "admin" } }), 403);
});

test("an admin passes the policy everywhere", async () => {
  for (const [m, url] of [["GET", "/api/settings"], ["GET", "/api/dashboard"], ["DELETE", "/api/v1/employees/3"], ["GET", "/api/team/kpis"], ["POST", "/api/sop/create"]]) {
    const status = await call(m, url, { token: adminToken, body: m === "POST" ? { a: 1 } : undefined });
    assert.ok(status !== 401 && status !== 403, `${m} ${url} -> ${status}`);
  }
});

test("decideAccess: pure rules", () => {
  const emp = { role: "employee", employeeId: 7 };
  assert.equal(decideAccess({ method: "GET", path: "/api/settings", user: null }).status, 401);
  assert.equal(decideAccess({ method: "GET", path: "/api/team/employees/8/callyzer-stats", user: emp }).allowed, false, "someone else's stats");
  assert.equal(decideAccess({ method: "GET", path: "/api/team/employees/7/callyzer-stats", user: emp }).allowed, true);
  assert.equal(decideAccess({ method: "GET", path: "/api/incentives/employee/8/cash-summary", user: emp }).allowed, false);
  assert.equal(decideAccess({ method: "GET", path: "/api/services/?x=1", user: emp }).allowed, true);
  assert.equal(decideAccess({ method: "POST", path: "/api/v1/employee/calls", user: emp }).allowed, true);
  assert.equal(decideAccess({ method: "GET", path: "/api/x", user: { role: "ghost" } }).allowed, false);
});

test("E-05: colleagues' private fields are removed, your own row is whole", () => {
  const rows = [
    { id: 7, name: "Me", email: "me@x.com", phone: "9000000007", salary: 30000, call_target: 100, status: "active" },
    { id: 8, name: "Other", email: "o@x.com", phone: "9000000008", salary: 50000, call_target: 200, cash_target: 5, qualified_lead_weightage: 10, callyserId: "c8", role: "Sales", status: "active", total_calls: 40, avatarUrl: "a.png" },
  ];
  const [me, other] = redactEmployees(rows, { role: "employee", employeeId: 7 });
  assert.deepEqual(me, rows[0]);
  for (const k of ["email", "phone", "salary", "call_target", "cash_target", "qualified_lead_weightage", "callyserId"]) assert.equal(k in other, false, k);
  for (const k of ["id", "name", "role", "status", "total_calls", "avatarUrl"]) assert.equal(k in other, true, k);
  assert.deepEqual(redactEmployees(rows, { role: "admin" }), rows, "the admin sees everything");
  assert.equal(redactEmployee(null, { role: "employee" }), null);
});

test("the dev-only header login stays off unless explicitly enabled, and never in production", () => {
  const src = require("fs").readFileSync(path.join(__dirname, "auth.js"), "utf8");
  assert.match(src, /process\.env\.ALLOW_HEADER_AUTH === "true" && process\.env\.NODE_ENV !== "production"/);
  assert.ok(!/role: roleHeader \|\| "admin"/.test(src), "the old default-to-admin is gone");
});
