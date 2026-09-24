-- =============================================================================
-- Employee login + per-employee data isolation (Hostinger MySQL / phpMyAdmin)
-- Run sections in order. Safe to re-run CREATE IF NOT EXISTS / UPDATE fixes.
--
-- YOU DO NOT NEED NEW TABLES for leads/tasks/meetings isolation.
-- Existing columns already handle it:
--   leads.assigned_to          → which employee owns the lead
--   tasks.assignee_id          → who the task belongs to
--   meetings.employee_id       → who owns the meeting
--   followups.employee_id      → who owns the follow-up
--   employee_calls.employee_id → who logged the call
--   users.employee_id          → links login account → employee row
-- =============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- 1) LOGIN TABLE (required — run if `users` does not exist)
-- Requires `employees` table first. Full file: backend/database/auth_schema.sql
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  login_id VARCHAR(64) NOT NULL COMMENT 'e.g. EMP-0001, SOURAV, ADMIN',
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'employee') NOT NULL DEFAULT 'employee',
  employee_id INT NULL COMMENT 'Must match employees.id for employee logins',
  status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
  must_change_password TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_login_id (login_id),
  UNIQUE KEY uq_users_email (email),
  KEY idx_users_employee_id (employee_id),
  KEY idx_users_role_status (role, status),
  CONSTRAINT fk_users_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Optional back-link (ignore error if column already exists)
-- ALTER TABLE employees ADD COLUMN user_id INT NULL;
-- ALTER TABLE employees ADD KEY idx_employees_user_id (user_id);

-- -----------------------------------------------------------------------------
-- 2) SPEED INDEXES for employee panel (ignore "Duplicate key name" if exists)
-- -----------------------------------------------------------------------------

CREATE INDEX idx_tasks_assignee_status ON tasks(tenant_id, assignee_id, status);
CREATE INDEX idx_meetings_employee ON meetings(tenant_id, employee_id, scheduled_at);
CREATE INDEX idx_followups_employee ON followups(tenant_id, employee_id, scheduled_at);
CREATE INDEX idx_calls_employee ON employee_calls(tenant_id, employee_id, created_at);

SET FOREIGN_KEY_CHECKS = 1;

-- =============================================================================
-- 3) FIX: Link each employee login to the correct employees row (by email)
--    Run this after employees + users rows exist.
--    Example: Amit login email must match Amit row in employees.
-- =============================================================================

UPDATE users u
INNER JOIN employees e ON LOWER(TRIM(e.email)) = LOWER(TRIM(u.email))
SET
  u.employee_id = e.id,
  u.updated_at = NOW()
WHERE u.role = 'employee'
  AND u.status = 'active'
  AND e.status = 'active'
  AND (u.employee_id IS NULL OR u.employee_id <> e.id);

UPDATE employees e
INNER JOIN users u ON u.employee_id = e.id AND u.role = 'employee'
SET e.user_id = u.id
WHERE e.user_id IS NULL OR e.user_id <> u.id;

-- =============================================================================
-- 4) CHECK queries (run and read results)
-- =============================================================================

-- A) Every employee login must have employee_id matching email
SELECT
  u.id AS user_id,
  u.login_id,
  u.email AS user_email,
  u.employee_id,
  e.name AS employee_name,
  e.email AS employee_email,
  CASE
    WHEN u.employee_id IS NULL THEN 'MISSING LINK — fix email or use Team → reset credentials'
    WHEN LOWER(u.email) <> LOWER(e.email) THEN 'WRONG LINK — emails do not match'
    ELSE 'OK'
  END AS link_status
FROM users u
LEFT JOIN employees e ON e.id = u.employee_id
WHERE u.role = 'employee'
ORDER BY u.login_id;

-- B) Leads per employee (admin assign → assigned_to must be set)
SELECT
  e.id AS employee_id,
  e.name AS employee_name,
  COUNT(l.id) AS assigned_leads
FROM employees e
LEFT JOIN leads l ON l.assigned_to = e.id AND l.is_deleted = 0
WHERE e.status = 'active'
GROUP BY e.id, e.name
ORDER BY e.name;

-- C) Unassigned leads (won't show in any employee panel until admin assigns)
SELECT id, lead_name, company_name, assignment_status, assigned_to
FROM leads
WHERE is_deleted = 0 AND (assigned_to IS NULL OR assignment_status = 'unassigned')
ORDER BY created_at DESC
LIMIT 50;

-- D) Tasks / meetings / follow-ups per employee
SELECT 'tasks' AS kind, assignee_id AS employee_id, COUNT(*) AS cnt FROM tasks WHERE status <> 'cancelled' GROUP BY assignee_id
UNION ALL
SELECT 'meetings', employee_id, COUNT(*) FROM meetings GROUP BY employee_id
UNION ALL
SELECT 'followups', employee_id, COUNT(*) FROM followups GROUP BY employee_id
UNION ALL
SELECT 'calls', employee_id, COUNT(*) FROM employee_calls GROUP BY employee_id;

-- =============================================================================
-- 5) MANUAL: Assign one lead to Sourav (change IDs/names for your DB)
-- =============================================================================
-- Step 1 — find Sourav's employee id:
--   SELECT id, name, email FROM employees WHERE name LIKE '%Sourav%';
-- Step 2 — assign lead (replace 5 = lead id, 2 = sourav employee id):
--
-- UPDATE leads
-- SET assigned_to = 2,
--     assignment_status = 'assigned',
--     assigned_at = NOW(),
--     assigned_by = 'admin',
--     assignment_method = 'manual',
--     updated_at = NOW()
-- WHERE id = 5 AND is_deleted = 0;

-- =============================================================================
-- 6) Admin user (if users table is empty)
-- Do NOT paste plain passwords here — use on server:
--   cd backend && npm run seed:admin
-- Set ADMIN_PASSWORD env first, or a random one-time password is printed once.
-- =============================================================================

-- =============================================================================
-- 7) Employee logins — DO NOT insert passwords manually in SQL
-- Use Admin dashboard → Team Management → Add Member (creates users row + password)
-- OR Team → Reset credentials for existing employees.
-- =============================================================================
