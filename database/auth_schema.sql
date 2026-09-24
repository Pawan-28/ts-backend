-- ---------------------------------------------------------------------------
-- Authentication schema for Admin + Employee login
-- Run on Hostinger MySQL (phpMyAdmin → SQL tab) or: mysql -u USER -p DB < auth_schema.sql
-- Requires `employees` table to exist first.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  login_id VARCHAR(64) NOT NULL COMMENT 'Employee login ID e.g. EMP-0001 or ADMIN',
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('admin', 'employee') NOT NULL DEFAULT 'employee',
  employee_id INT NULL COMMENT 'FK to employees.id when role=employee',
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

-- Optional link from employees → users (safe to re-run; ignore duplicate column error)
ALTER TABLE employees ADD COLUMN user_id INT NULL;
ALTER TABLE employees ADD KEY idx_employees_user_id (user_id);

-- ---------------------------------------------------------------------------
-- Default admin is seeded automatically on backend startup via ensureAdminUser.
-- Set ADMIN_LOGIN_ID, ADMIN_EMAIL, ADMIN_PASSWORD, JWT_SECRET env vars first.
-- If ADMIN_PASSWORD is not set, a random one-time password is generated and
-- printed once to the server log. Change it immediately after first login.
-- ---------------------------------------------------------------------------
