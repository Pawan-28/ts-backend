const pool = require("../../config/db");
const { hashPassword, verifyPassword, generateTempPassword } = require("../utils/password");

function normalizeLoginKey(value) {
  return String(value || "").trim().toLowerCase();
}

function buildLoginId(employeeRow, formEmpId) {
  const fromForm = String(formEmpId || employeeRow?.emp_id || "").trim();
  if (fromForm) {
    return fromForm.replace(/\s+/g, "-").toUpperCase().slice(0, 64);
  }
  return `EMP-${String(employeeRow.id).padStart(4, "0")}`;
}

async function findUserById(id) {
  const result = await pool.query(
    `SELECT u.*, e.name AS employee_name, e.department AS employee_department, e.role AS employee_role_title
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE u.id = $1 LIMIT 1`,
    [id],
  );
  const row = result.rows[0] || null;
  return row ? resolveEmployeeUserLink(row) : null;
}

/** Keep users.employee_id aligned with the employee row that shares the same email. */
async function resolveEmployeeUserLink(userRow) {
  if (!userRow || userRow.role !== "employee") return userRow;

  const userEmail = normalizeLoginKey(userRow.email);
  if (!userEmail) return userRow;

  const byEmail = await pool.query(
    `SELECT id, name, department, role, email
     FROM employees
     WHERE LOWER(email) = $1 AND status = 'active'
     ORDER BY id ASC
     LIMIT 1`,
    [userEmail],
  );
  const employee = byEmail.rows[0];
  if (!employee) return userRow;

  const linkedId = userRow.employee_id != null ? Number(userRow.employee_id) : null;
  const correctId = Number(employee.id);

  if (linkedId !== correctId) {
    await pool.query(
      `UPDATE users SET employee_id = $1, updated_at = NOW() WHERE id = $2`,
      [correctId, userRow.id],
    );
    await pool.query(
      `UPDATE employees SET user_id = $1 WHERE id = $2`,
      [userRow.id, correctId],
    );
    userRow.employee_id = correctId;
    userRow.employee_name = employee.name;
    userRow.employee_department = employee.department;
    userRow.employee_role_title = employee.role;
  }

  return userRow;
}

async function findUserByLogin(loginId) {
  const key = normalizeLoginKey(loginId);
  const result = await pool.query(
    `SELECT u.*, e.name AS employee_name, e.department AS employee_department, e.role AS employee_role_title
     FROM users u
     LEFT JOIN employees e ON e.id = u.employee_id
     WHERE LOWER(u.login_id) = $1 OR LOWER(u.email) = $1
     LIMIT 1`,
    [key],
  );
  const row = result.rows[0] || null;
  return row ? resolveEmployeeUserLink(row) : null;
}

async function createUserForEmployee(employee, options = {}) {
  const email = String(employee.email || "").trim().toLowerCase();
  if (!email) {
    const err = new Error("Employee email is required to create login credentials");
    err.statusCode = 400;
    throw err;
  }

  const loginId = buildLoginId(employee, options.empId);
  const tempPassword = options.password || generateTempPassword();
  const passwordHash = await hashPassword(tempPassword);

  const existing = await pool.query(
    `SELECT id FROM users WHERE LOWER(login_id) = $1 OR LOWER(email) = $2 LIMIT 1`,
    [loginId.toLowerCase(), email],
  );
  if (existing.rows.length) {
    const err = new Error("Login ID or email already exists for another user");
    err.statusCode = 409;
    throw err;
  }

  const insert = await pool.query(
    `INSERT INTO users (login_id, email, password_hash, role, employee_id, status, must_change_password)
     VALUES ($1, $2, $3, 'employee', $4, 'active', 1)`,
    [loginId, email, passwordHash, employee.id],
  );

  const userId = insert.insertId || insert.rows?.[0]?.id;
  if (userId) {
    await pool.query(`UPDATE employees SET user_id = $1 WHERE id = $2`, [userId, employee.id]);
  }

  return {
    loginId,
    email,
    tempPassword,
    userId,
  };
}

async function deactivateUserForEmployee(employeeId) {
  await pool.query(
    `UPDATE users SET status = 'inactive', updated_at = NOW() WHERE employee_id = $1`,
    [employeeId],
  );
  await pool.query(
    `UPDATE employees SET status = 'inactive', updated_at = NOW() WHERE id = $1`,
    [employeeId],
  );
}

async function resetEmployeePassword(employeeId, customOptions = {}) {
  let userRes = await pool.query(
    `SELECT * FROM users WHERE employee_id = $1 AND role = 'employee' LIMIT 1`,
    [employeeId],
  );
  let user = userRes.rows[0];

  if (!user) {
    const empRes = await pool.query(`SELECT * FROM employees WHERE id = $1 LIMIT 1`, [employeeId]);
    const emp = empRes.rows[0];
    if (emp && emp.email) {
      const byEmail = await pool.query(`SELECT * FROM users WHERE LOWER(email) = $1 LIMIT 1`, [emp.email.toLowerCase()]);
      user = byEmail.rows[0];
      if (user) {
        await pool.query(`UPDATE users SET employee_id = $1 WHERE id = $2`, [employeeId, user.id]);
        user.employee_id = employeeId;
      } else {
        return await createUserForEmployee(emp, customOptions);
      }
    } else if (emp) {
      const fallbackEmp = { ...emp, email: emp.email || `emp_${emp.id}@tspublication.in` };
      return await createUserForEmployee(fallbackEmp, customOptions);
    } else {
      const err = new Error("Employee not found");
      err.statusCode = 404;
      throw err;
    }
  }

  const newPassword = customOptions.password || customOptions.newPassword || generateTempPassword();
  if (String(newPassword).length < 4) {
    const err = new Error("Password must be at least 4 characters");
    err.statusCode = 400;
    throw err;
  }
  const passwordHash = await hashPassword(newPassword);

  let newLoginId = user.login_id;
  if (customOptions.loginId && String(customOptions.loginId).trim() !== "") {
    const requestedLogin = String(customOptions.loginId).trim();
    const checkTaken = await pool.query(
      `SELECT id FROM users WHERE LOWER(login_id) = $1 AND id != $2 LIMIT 1`,
      [requestedLogin.toLowerCase(), user.id]
    );
    if (checkTaken.rows.length > 0) {
      const err = new Error(`Login ID "${requestedLogin}" is already taken by another account`);
      err.statusCode = 409;
      throw err;
    }
    newLoginId = requestedLogin;
  }

  const mustChange = customOptions.mustChangePassword ? 1 : 0;

  await pool.query(
    `UPDATE users 
     SET password_hash = $1, login_id = $2, must_change_password = $3, status = 'active', updated_at = NOW() 
     WHERE id = $4`,
    [passwordHash, newLoginId, mustChange, user.id],
  );

  return {
    loginId: newLoginId,
    email: user.email,
    newPassword,
    tempPassword: newPassword,
    userId: user.id,
  };
}

async function changePassword(userId, currentPassword, newPassword) {
  const user = await findUserById(userId);
  if (!user) {
    const err = new Error("User not found");
    err.statusCode = 404;
    throw err;
  }
  const ok = await verifyPassword(currentPassword, user.password_hash);
  if (!ok) {
    const err = new Error("Current password is incorrect");
    err.statusCode = 400;
    throw err;
  }
  if (String(newPassword).length < 6) {
    const err = new Error("New password must be at least 6 characters");
    err.statusCode = 400;
    throw err;
  }
  const passwordHash = await hashPassword(newPassword);
  await pool.query(
    `UPDATE users SET password_hash = $1, must_change_password = 0, updated_at = NOW() WHERE id = $2`,
    [passwordHash, userId],
  );
  return true;
}

async function ensureAdminUser() {
  const loginId = process.env.ADMIN_LOGIN_ID || "ADMIN";
  const email = (process.env.ADMIN_EMAIL || "admin@tspublication.in").toLowerCase();

  const existing = await pool.query(
    `SELECT id FROM users WHERE role = 'admin' LIMIT 1`,
  );
  if (existing.rows.length) {
    return { created: false, loginId, email };
  }

  // No hardcoded default password: use ADMIN_PASSWORD env or a random one-time
  // password. The account is flagged must_change_password either way.
  const envPassword = String(process.env.ADMIN_PASSWORD || "").trim();
  const plain = envPassword || generateTempPassword(16);

  const passwordHash = await hashPassword(plain);
  await pool.query(
    `INSERT INTO users (login_id, email, password_hash, role, employee_id, status, must_change_password)
     VALUES ($1, $2, $3, 'admin', NULL, 'active', 1)`,
    [loginId, email, passwordHash],
  );
  console.log(`[auth] Seeded admin user login_id=${loginId} email=${email}`);
  if (!envPassword) {
    // Printed once at seed time only — set ADMIN_PASSWORD to avoid this.
    console.log(`[auth] Generated one-time admin password: ${plain}`);
    console.log("[auth] Sign in and change it immediately, or set ADMIN_PASSWORD and re-seed.");
  }
  return { created: true, loginId, email, tempPassword: envPassword ? null : plain };
}

function serializeUser(row) {
  if (!row) return null;
  const adminLabel = row.login_id || row.email?.split("@")[0] || "Admin";
  return {
    id: row.id,
    loginId: row.login_id,
    email: row.email,
    role: row.role,
    employeeId: row.employee_id != null ? Number(row.employee_id) : null,
    status: row.status,
    mustChangePassword: Boolean(row.must_change_password),
    name: row.role === "employee" ? (row.employee_name || row.email) : adminLabel,
    department: row.employee_department || null,
    employeeRole: row.employee_role_title || null,
    avatarUrl: row.avatar_url || null,
    lastLoginAt: row.last_login_at || null,
    createdAt: row.created_at || null,
  };
}

module.exports = {
  buildLoginId,
  findUserByLogin,
  findUserById,
  createUserForEmployee,
  deactivateUserForEmployee,
  resetEmployeePassword,
  changePassword,
  ensureAdminUser,
  verifyPassword,
  serializeUser,
};
