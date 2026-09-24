-- Per-employee Google OAuth tokens for Calendar / Meet link generation.
-- Run once on Hostinger MySQL (phpMyAdmin → SQL) or via migration script.

CREATE TABLE IF NOT EXISTS employee_google_oauth (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) NOT NULL DEFAULT 'default',
  employee_id INT NOT NULL,
  google_email VARCHAR(255) NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  token_expiry DATETIME NULL,
  scopes TEXT NULL,
  connected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_employee_google (employee_id),
  KEY idx_employee_google_tenant (tenant_id, employee_id),
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
