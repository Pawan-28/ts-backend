const pool = require("../../config/db");

// ── Activity Logs ──────────────────────────────────────────
const getRecentActivity = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM activity_logs ORDER BY created_at DESC LIMIT 20`
    );
    res.json({ success: true, activities: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const logActivity = async ({ action, entity, entity_id, user_name = "Admin" }) => {
  try {
    await pool.query(
      `INSERT INTO activity_logs (action, entity, entity_id, user_name)
       VALUES ($1, $2, $3, $4)`,
      [action, entity, entity_id, user_name]
    );
  } catch (err) {
    console.error("Failed to log activity:", err.message);
  }
};

// ── Notifications ──────────────────────────────────────────
const getNotifications = async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, title, body, type, is_read, created_at
       FROM notifications 
       ORDER BY created_at DESC 
       LIMIT 30`
    );
    const unread = result.rows.filter(n => !n.is_read).length;
    res.json({ success: true, notifications: result.rows, unreadCount: unread });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const markAllRead = async (req, res) => {
  try {
    await pool.query(`UPDATE notifications SET is_read = TRUE`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

const createNotification = async ({ title, message, type = "info" }) => {
  try {
    await pool.query(
      `INSERT INTO notifications (title, body, type, is_read)
       VALUES ($1, $2, $3, false)`,
      [title, message, type]  // parameter stays "message", column is "body"
    );
  } catch (err) {
    console.error("Failed to create notification:", err.message);
  }
};

// ── Global Search ──────────────────────────────────────────
const globalSearch = async (req, res) => {
  const { q } = req.query;
  if (!q || q.trim().length < 2) {
    return res.json({ success: true, results: [] });
  }

  const term = `%${q.toLowerCase()}%`;

  try {
    // ── Employees ──
    const emps = await pool.query(
      `SELECT 
         id,
         name,
         COALESCE(role, '') AS role,
         COALESCE(email, '') AS email,
         'employee' AS type
       FROM employees
       WHERE LOWER(name) LIKE $1
          OR LOWER(COALESCE(email, '')) LIKE $1
          OR LOWER(COALESCE(role, '')) LIKE $1
       LIMIT 5`,
      [term]
    );

    // ── Leads — using lead_name (your actual column) ──
    const leads = await pool.query(
      `SELECT
         id,
         lead_name AS name,
         COALESCE(company_name, '') AS sub,
         COALESCE(status, '') AS status,
         'lead' AS type
       FROM leads
       WHERE (LOWER(COALESCE(lead_name, '')) LIKE $1
          OR LOWER(COALESCE(company_name, '')) LIKE $1)
          AND is_deleted = 0
       LIMIT 5`,
      [term]
    );

    // ── SOPs ──
    const sops = await pool.query(
      `SELECT
         id,
         title AS name,
         COALESCE(description, '') AS sub,
         COALESCE(status, '') AS status,
         'sop' AS type
       FROM sops
       WHERE LOWER(title) LIKE $1
          OR LOWER(COALESCE(description, '')) LIKE $1
       LIMIT 5`,
      [term]
    );

    res.json({
      success: true,
      results: [...emps.rows, ...leads.rows, ...sops.rows],
    });

  } catch (err) {
    console.error("Search error:", err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getRecentActivity,
  logActivity,
  getNotifications,
  markAllRead,
  createNotification,
  globalSearch,
};