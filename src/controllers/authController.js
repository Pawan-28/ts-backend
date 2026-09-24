const {
  findUserByLogin,
  findUserById,
  serializeUser,
  changePassword,
  verifyPassword,
} = require("../services/userService");
const { signToken } = require("../utils/token");
const pool = require("../../config/db");
const {
  isLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
} = require("../middleware/loginGuard");

const login = async (req, res) => {
  try {
    const loginId = String(req.body?.loginId || req.body?.email || req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!loginId || !password) {
      return res.status(400).json({ success: false, message: "Login ID and password are required" });
    }

    if (!isLoginAllowed(loginId)) {
      return res.status(401).json({
        success: false,
        message: "Too many failed attempts for this account. Wait a few minutes or contact admin.",
      });
    }

    const userRow = await findUserByLogin(loginId);
    if (!userRow || userRow.status !== "active") {
      recordLoginFailure(loginId);
      return res.status(401).json({ success: false, message: "Invalid login ID or password" });
    }

    const valid = await verifyPassword(password, userRow.password_hash);
    if (!valid) {
      recordLoginFailure(loginId);
      return res.status(401).json({ success: false, message: "Invalid login ID or password" });
    }

    clearLoginFailures(loginId);

    await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [userRow.id]);

    const user = serializeUser({ ...userRow, last_login_at: new Date() });
    const token = signToken({
      sub: userRow.id,
      role: userRow.role,
      employeeId: userRow.employee_id,
    });

    return res.json({
      success: true,
      token,
      user,
    });
  } catch (err) {
    console.error("Login error:", err);
    if (err.code === "ER_NO_SUCH_TABLE") {
      return res.status(503).json({
        success: false,
        message: "Users table missing — run backend/database/auth_schema.sql on MySQL",
      });
    }
    if (err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.code === "ENOTFOUND") {
      return res.status(503).json({
        success: false,
        message: "Database unavailable — check DB_HOST and credentials on the server",
      });
    }
    return res.status(500).json({
      success: false,
      message: err.message || "Login failed",
    });
  }
};

const me = async (req, res) => {
  try {
    const userRow = await findUserById(req.user?.id);
    if (!userRow) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.json({ success: true, user: serializeUser(userRow) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const updateMyAvatar = async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const avatarUrl = String(req.body?.avatarUrl || "").trim();
    if (!avatarUrl) {
      return res.status(400).json({ success: false, message: "avatarUrl is required" });
    }
    await pool.query(`UPDATE users SET avatar_url = $1 WHERE id = $2`, [avatarUrl, req.user.id]);
    const userRow = await findUserById(req.user.id);
    return res.json({ success: true, user: serializeUser(userRow) });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
};

const changePasswordHandler = async (req, res) => {
  try {
    if (!req.user?.id) {
      return res.status(401).json({ success: false, message: "Authentication required" });
    }
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }
    await changePassword(req.user.id, currentPassword, newPassword);
    const userRow = await findUserById(req.user.id);
    return res.json({ success: true, user: serializeUser(userRow) });
  } catch (err) {
    return res.status(err.statusCode || 500).json({ success: false, message: err.message });
  }
};

module.exports = { login, me, changePasswordHandler, updateMyAvatar };
