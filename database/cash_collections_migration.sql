-- Run once in phpMyAdmin if cash_collections table does not exist yet.
SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS cash_collections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NOT NULL,
  employee_id INT NULL,
  amount DECIMAL(12, 2) NOT NULL,
  currency VARCHAR(10) DEFAULT 'INR',
  payment_mode VARCHAR(50) NOT NULL,
  payment_at DATETIME NOT NULL,
  transaction_id VARCHAR(255) NULL,
  slip_url TEXT NULL,
  slip_filename VARCHAR(255) NULL,
  notes TEXT NULL,
  recorded_by VARCHAR(100) NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
