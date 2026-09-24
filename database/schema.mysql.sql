-- TS Publications CRM — MySQL schema for Hostinger
-- Database: u259882081_CRM_dashboard (change USE line if your DB name differs)
--
-- How to run in Hostinger:
-- 1. hPanel → Databases → phpMyAdmin
-- 2. Select your database on the left
-- 3. Open the SQL tab
-- 4. Paste this entire file and click Go

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- Core / SOP
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sops (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sop_code VARCHAR(50) UNIQUE,
  title VARCHAR(255) NOT NULL,
  description TEXT NOT NULL,
  category VARCHAR(100) DEFAULT 'Sales Call',
  status VARCHAR(50) DEFAULT 'Draft',
  priority VARCHAR(50) DEFAULT 'Medium',
  department VARCHAR(100) DEFAULT '',
  estimated_time VARCHAR(50) DEFAULT '',
  script TEXT,
  scripts JSON DEFAULT ('[]'),
  questions JSON DEFAULT ('[]'),
  frameworks JSON DEFAULT ('[]'),
  tags JSON DEFAULT ('[]'),
  instruction_steps JSON DEFAULT ('[]'),
  attachment_url TEXT,
  version VARCHAR(20) DEFAULT 'v1.0',
  creator VARCHAR(100) DEFAULT 'Admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS sop_comments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sop_id INT NOT NULL,
  author VARCHAR(100) DEFAULT 'Current User',
  text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (sop_id) REFERENCES sops(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Employees & leads
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS employees (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255),
  phone VARCHAR(50),
  city VARCHAR(100),
  department VARCHAR(100),
  role VARCHAR(100),
  status VARCHAR(50) DEFAULT 'active',
  work_location VARCHAR(50) DEFAULT 'Office',
  access_level VARCHAR(50) DEFAULT 'Member',
  notes TEXT,
  joining_date DATE,
  callyser_id VARCHAR(100),
  emp_id VARCHAR(100),
  salary DECIMAL(12, 2),
  incentive_kra TINYINT(1) DEFAULT 0,
  call_target INT DEFAULT 0,
  call_weightage INT DEFAULT 0,
  qualified_lead_target INT DEFAULT 0,
  qualified_lead_weightage INT DEFAULT 0,
  meeting_target INT DEFAULT 0,
  meeting_weightage INT DEFAULT 0,
  cash_target INT DEFAULT 0,
  cash_weightage INT DEFAULT 0,
  tenant_id VARCHAR(50) DEFAULT 'default',
  avatar_url TEXT,
  initials VARCHAR(10),
  manager_id INT NULL,
  territory VARCHAR(100),
  max_active_leads INT DEFAULT 40,
  current_active_leads INT DEFAULT 0,
  receiving_paused TINYINT(1) DEFAULT 0,
  daily_limit INT DEFAULT 25,
  metrics JSON DEFAULT ('{}'),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_name VARCHAR(255) NOT NULL,
  phone VARCHAR(50),
  email VARCHAR(255),
  city VARCHAR(100),
  company_name VARCHAR(255),
  source VARCHAR(100),
  keyword VARCHAR(255),
  ad_content TEXT,
  campaign_notes TEXT,
  win_probability INT DEFAULT 50,
  purchased VARCHAR(50),
  expected_close_date DATE,
  interactions INT DEFAULT 0,
  next_followup_date DATE,
  mom TEXT,
  call_summary TEXT,
  notes TEXT,
  temperature VARCHAR(50) DEFAULT 'warm',
  pipeline_stage VARCHAR(100) DEFAULT 'new',
  status VARCHAR(100) DEFAULT 'New Lead',
  expected_revenue DECIMAL(12, 2) DEFAULT 0,
  form_name VARCHAR(255),
  tenant_id VARCHAR(50) DEFAULT 'default',
  country VARCHAR(100) DEFAULT 'India',
  source_meta JSON DEFAULT ('{}'),
  currency VARCHAR(10) DEFAULT 'INR',
  priority VARCHAR(20) DEFAULT 'medium',
  assignment_status VARCHAR(30) DEFAULT 'unassigned',
  assigned_to INT NULL,
  assigned_at DATETIME NULL,
  assigned_by VARCHAR(100),
  assignment_method VARCHAR(30),
  accepted_at DATETIME NULL,
  qualification JSON DEFAULT ('{}'),
  budget JSON DEFAULT ('{}'),
  requirements TEXT,
  insights TEXT,
  tags JSON DEFAULT ('[]'),
  last_activity_at DATETIME NULL,
  next_follow_up_at DATETIME NULL,
  converted_at DATETIME NULL,
  lost_at DATETIME NULL,
  is_deleted TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Assignment & operations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lead_assignment_queue (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NOT NULL,
  status VARCHAR(30) DEFAULT 'queued',
  priority INT DEFAULT 0,
  queued_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  processed_at DATETIME NULL,
  failure_reason TEXT,
  attempts INT DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS assignment_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NOT NULL,
  from_employee_id INT NULL,
  to_employee_id INT NULL,
  method VARCHAR(30) NOT NULL,
  performed_by VARCHAR(100),
  reason TEXT,
  metadata JSON DEFAULT ('{}'),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS assignment_config (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  mode VARCHAR(30) DEFAULT 'round_robin',
  auto_assign TINYINT(1) DEFAULT 1,
  round_robin_order JSON DEFAULT ('[]'),
  rr_index INT DEFAULT 0,
  paused_employees JSON DEFAULT ('[]'),
  workload_rules JSON DEFAULT ('{}'),
  today_key VARCHAR(10),
  today_stats JSON DEFAULT ('{"total":0,"byEmployee":{}}'),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_assignment_config_tenant (tenant_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lead_timeline_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NOT NULL,
  type VARCHAR(50) NOT NULL,
  actor_id VARCHAR(100),
  actor_name VARCHAR(255),
  actor_role VARCHAR(50),
  summary TEXT,
  payload JSON DEFAULT ('{}'),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS crm_notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  user_id VARCHAR(100),
  employee_id INT NULL,
  type VARCHAR(50),
  title VARCHAR(255),
  body TEXT,
  entity_type VARCHAR(50),
  entity_id VARCHAR(100),
  is_read TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS audit_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  actor_id VARCHAR(100),
  action VARCHAR(100),
  resource VARCHAR(50),
  resource_id VARCHAR(100),
  before_state JSON,
  after_state JSON,
  ip VARCHAR(50),
  metadata JSON DEFAULT ('{}'),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS lead_notes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NOT NULL,
  author_id VARCHAR(100),
  author_type VARCHAR(20) DEFAULT 'employee',
  body TEXT NOT NULL,
  is_pinned TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS employee_calls (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NULL,
  employee_id INT NOT NULL,
  callyzer_call_id VARCHAR(100) NULL,
  direction VARCHAR(20) DEFAULT 'outbound',
  outcome VARCHAR(100),
  duration_sec INT,
  started_at DATETIME NULL,
  ended_at DATETIME NULL,
  sop_id INT NULL,
  checklist_progress JSON DEFAULT ('[]'),
  recording_url TEXT,
  transcript TEXT,
  notes TEXT,
  ai_summary TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id),
  FOREIGN KEY (sop_id) REFERENCES sops(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS followups (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NOT NULL,
  employee_id INT NOT NULL,
  task_id INT NULL,
  scheduled_at DATETIME NOT NULL,
  note TEXT,
  status VARCHAR(30) DEFAULT 'pending',
  completed_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS meetings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NOT NULL,
  employee_id INT NOT NULL,
  title VARCHAR(255),
  scheduled_at DATETIME NOT NULL,
  duration_min INT,
  meet_link TEXT,
  location TEXT,
  status VARCHAR(30) DEFAULT 'scheduled',
  mom JSON DEFAULT ('{}'),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tasks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  assignee_id INT NOT NULL,
  lead_id INT NULL,
  follow_up_id INT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  priority VARCHAR(20) DEFAULT 'medium',
  due_at DATETIME NULL,
  status VARCHAR(30) DEFAULT 'pending',
  sop_checklist JSON DEFAULT ('[]'),
  completed_at DATETIME NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (assignee_id) REFERENCES employees(id),
  FOREIGN KEY (lead_id) REFERENCES leads(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS file_assets (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  uploaded_by VARCHAR(100),
  entity_type VARCHAR(50),
  entity_id VARCHAR(100),
  filename VARCHAR(255),
  original_name VARCHAR(255),
  mime VARCHAR(100),
  size INT,
  storage_key TEXT,
  url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

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

-- ---------------------------------------------------------------------------
-- Legacy / dashboard tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS emp_leads (
  id INT AUTO_INCREMENT PRIMARY KEY,
  lead_id VARCHAR(100),
  form_id VARCHAR(100),
  form_name VARCHAR(255),
  lead_name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  city VARCHAR(100),
  business_name VARCHAR(255),
  source VARCHAR(100),
  platform VARCHAR(100),
  employee_id INT NULL,
  employee_name VARCHAR(255),
  round_robin_code VARCHAR(100),
  sheet_name VARCHAR(255),
  status VARCHAR(100) DEFAULT 'New Lead',
  pipeline_stage VARCHAR(100),
  temperature VARCHAR(50),
  submitted_time DATETIME DEFAULT CURRENT_TIMESTAMP,
  form_data JSON DEFAULT ('{}'),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS emp_lead_status_history (
  id INT AUTO_INCREMENT PRIMARY KEY,
  emp_lead_id INT NULL,
  lead_id VARCHAR(100),
  phone VARCHAR(50),
  old_status VARCHAR(100),
  new_status VARCHAR(100),
  changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activity_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  action VARCHAR(255) NOT NULL,
  entity VARCHAR(100),
  entity_id VARCHAR(100),
  user_name VARCHAR(100) DEFAULT 'Admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notifications (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  type VARCHAR(50) DEFAULT 'info',
  is_read TINYINT(1) DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS scheduled_lead_assignments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  lead_id INT NOT NULL,
  employee_id INT NOT NULL,
  scheduled_date DATE NOT NULL,
  status VARCHAR(30) DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE CASCADE,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_scheduled_date_status (tenant_id, scheduled_date, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS whatsapp_scripts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id VARCHAR(50) DEFAULT 'default',
  employee_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  category VARCHAR(100) DEFAULT 'General',
  is_active TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
  INDEX idx_wa_scripts_employee (tenant_id, employee_id, is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX idx_leads_tenant_assignment ON leads(tenant_id, assignment_status, created_at);
CREATE INDEX idx_leads_tenant_assigned ON leads(tenant_id, assigned_to, pipeline_stage);
CREATE INDEX idx_lead_queue_status ON lead_assignment_queue(tenant_id, status, priority, queued_at);
CREATE INDEX idx_timeline_lead ON lead_timeline_events(tenant_id, lead_id, created_at);
CREATE INDEX idx_emp_leads_submitted ON emp_leads(submitted_time);
CREATE INDEX idx_emp_leads_employee ON emp_leads(employee_name);

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- Optional: demo employees (remove this block if you don't want sample data)
-- ---------------------------------------------------------------------------

INSERT INTO employees (name, email, role, department, status, tenant_id, initials, current_active_leads)
SELECT * FROM (
  SELECT 'Amit Kumar', 'amit.kumar@techsales.in', 'Sales Manager', 'Sales', 'active', 'default', 'AK', 0
  UNION ALL SELECT 'Priya Sharma', 'priya.sharma@techsales.in', 'Sales Executive', 'Sales', 'active', 'default', 'PS', 0
  UNION ALL SELECT 'Rohan Verma', 'rohan.verma@techsales.in', 'Sales Executive', 'Sales', 'active', 'default', 'RV', 0
  UNION ALL SELECT 'Neha Patel', 'neha.patel@techsales.in', 'Sales Executive', 'Sales', 'active', 'default', 'NP', 0
) AS seed_employees
WHERE NOT EXISTS (
  SELECT 1 FROM employees WHERE tenant_id = 'default' LIMIT 1
);

INSERT INTO assignment_config (tenant_id, mode, auto_assign)
SELECT 'default', 'round_robin', 1
WHERE NOT EXISTS (
  SELECT 1 FROM assignment_config WHERE tenant_id = 'default'
);
