const pool = require("../config/db");

async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sops (
        id INT AUTO_INCREMENT PRIMARY KEY,
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
        service VARCHAR(100) DEFAULT 'All Services',
        version VARCHAR(20) DEFAULT 'v1.0',
        creator VARCHAR(100) DEFAULT 'Admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    try {
      await pool.query("ALTER TABLE sops ADD COLUMN service VARCHAR(100) DEFAULT 'All Services'");
    } catch (e) {
      // Ignore if column already exists
    }

    // A SOP can now apply to more than one service — keeps the legacy single
    // `service` column (first value) for any code that hasn't been updated yet.
    try {
      await pool.query("ALTER TABLE sops ADD COLUMN services JSON DEFAULT ('[]')");
    } catch (e) {
      // Ignore if column already exists
    }

    try {
      await pool.query("ALTER TABLE sops ADD COLUMN attachment_name VARCHAR(255) NULL");
    } catch (e) {
      // Ignore if column already exists
    }

    try {
      await pool.query("ALTER TABLE sops ADD COLUMN full_content LONGTEXT NULL");
    } catch (e) {
      // Ignore if column already exists
    }

    try {
      await pool.query("ALTER TABLE sops ADD COLUMN questions_answers JSON DEFAULT ('[]')");
    } catch (e) {
      // Ignore if column already exists
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sop_comments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        sop_id INT NOT NULL,
        author VARCHAR(100) DEFAULT 'Current User',
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sop_id) REFERENCES sops(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    try {
      await pool.query("ALTER TABLE leads ADD COLUMN stage_is_manual TINYINT(1) DEFAULT 0");
    } catch (e) {
      // Ignore if column already exists
    }

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS employee_calls (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(50) DEFAULT 'default',
        lead_id INT NOT NULL,
        employee_id INT NOT NULL,
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS emp_lead_status_history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        emp_lead_id INT NULL,
        lead_id VARCHAR(100),
        phone VARCHAR(50),
        old_status VARCHAR(100),
        new_status VARCHAR(100),
        changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        action VARCHAR(255) NOT NULL,
        entity VARCHAR(100),
        entity_id VARCHAR(100),
        user_name VARCHAR(100) DEFAULT 'Admin',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        body TEXT,
        type VARCHAR(50) DEFAULT 'info',
        is_read TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS services (
        id VARCHAR(100) PRIMARY KEY,
        tenant_id VARCHAR(50) DEFAULT 'default',
        name VARCHAR(255) NOT NULL,
        category VARCHAR(50) DEFAULT 'ai',
        category_label VARCHAR(100),
        status VARCHAR(50) DEFAULT 'ACTIVE',
        description TEXT,
        revenue DECIMAL(14, 2) DEFAULT 0,
        leads INT DEFAULT 0,
        converted INT DEFAULT 0,
        conv_rate DECIMAL(6, 2) DEFAULT 0,
        price_num DECIMAL(12, 2) DEFAULT 0,
        price_label VARCHAR(50),
        icon VARCHAR(50) DEFAULT 'bot',
        metadata JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS employee_private_contacts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(50) DEFAULT 'default',
        employee_id INT NOT NULL,
        name VARCHAR(255) NOT NULL,
        phone VARCHAR(50) NOT NULL,
        phone_normalized VARCHAR(20) NOT NULL,
        relation VARCHAR(100) DEFAULT 'Personal',
        notes TEXT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE,
        INDEX idx_emp_private_phone (tenant_id, employee_id, phone_normalized)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS forms (
        id VARCHAR(100) PRIMARY KEY,
        tenant_id VARCHAR(50) DEFAULT 'default',
        name VARCHAR(255) NOT NULL,
        source VARCHAR(100),
        source_key VARCHAR(50),
        status VARCHAR(50) DEFAULT 'ACTIVE',
        service VARCHAR(255),
        fields JSON,
        leads INT DEFAULT 0,
        revenue DECIMAL(14, 2) DEFAULT 0,
        conversion INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS tenant_settings (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(50) NOT NULL UNIQUE,
        settings_json JSON NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS ai_insights (
        id INT AUTO_INCREMENT PRIMARY KEY,
        tenant_id VARCHAR(50) DEFAULT 'default',
        context VARCHAR(100) DEFAULT 'dashboard',
        type VARCHAR(50) DEFAULT 'rec',
        title VARCHAR(255),
        body TEXT,
        tone VARCHAR(50) DEFAULT 'info',
        metadata JSON,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        login_id VARCHAR(64) NOT NULL,
        email VARCHAR(255) NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role ENUM('admin', 'employee') NOT NULL DEFAULT 'employee',
        employee_id INT NULL,
        status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
        must_change_password TINYINT(1) NOT NULL DEFAULT 1,
        last_login_at DATETIME NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_users_login_id (login_id),
        UNIQUE KEY uq_users_email (email),
        KEY idx_users_employee_id (employee_id),
        CONSTRAINT fk_users_employee FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await pool.query(`
      ALTER TABLE employees ADD COLUMN user_id INT NULL
    `).catch((error) => {
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    });

    // Profile photo lives on the auth identity — same for admin and employee,
    // returned by /login and /auth/me on every device, so it isn't lost on re-login.
    await pool.query(`
      ALTER TABLE users ADD COLUMN avatar_url TEXT NULL
    `).catch((error) => {
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    });

    // Per-call AI scoring on the five fixed sales-competency dimensions shown
    // on the incentive radar chart (Product Value Alignment, Call Control, etc.).
    await pool.query(`
      ALTER TABLE employee_calls ADD COLUMN competency_scores JSON DEFAULT ('{}')
    `).catch((error) => {
      if (error.code !== "ER_DUP_FIELDNAME") throw error;
    });

    await pool.query(`
      ALTER TABLE sops ADD COLUMN scripts JSON DEFAULT ('[]')
    `).catch((error) => {
      if (error.code !== "ER_DUP_FIELDNAME" && error.code !== "ER_CANT_ADD_TO_INDEX") throw error;
    });

    const indexes = [
      "CREATE INDEX idx_leads_tenant_assignment ON leads(tenant_id, assignment_status, created_at)",
      "CREATE INDEX idx_leads_tenant_assigned ON leads(tenant_id, assigned_to, pipeline_stage)",
      "CREATE INDEX idx_leads_perf ON leads(tenant_id, is_deleted, created_at)",
      "CREATE INDEX idx_leads_stage_perf ON leads(tenant_id, is_deleted, pipeline_stage)",
      "CREATE INDEX idx_calls_perf ON employee_calls(tenant_id, started_at)",
      "CREATE INDEX idx_calls_emp_perf ON employee_calls(tenant_id, employee_id, started_at)",
      "CREATE INDEX idx_meetings_perf ON meetings(tenant_id, scheduled_at)",
      "CREATE INDEX idx_cash_perf ON cash_collections(tenant_id, payment_at)",
      "CREATE INDEX idx_lead_queue_status ON lead_assignment_queue(tenant_id, status, priority, queued_at)",
      "CREATE INDEX idx_timeline_lead ON lead_timeline_events(tenant_id, lead_id, created_at)",
      "CREATE INDEX idx_emp_leads_submitted ON emp_leads(submitted_time)",
      "CREATE INDEX idx_emp_leads_employee ON emp_leads(employee_name)",
    ];

    for (const sql of indexes) {
      await pool.query(sql).catch((error) => {
        if (error.code !== "ER_DUP_KEYNAME") throw error;
      });
    }

    console.log("Database tables ready (MySQL schema)");
    await seedOperationalData(pool);
    await seedCatalogData(pool);
    try {
      const { ensureAdminUser } = require("../src/services/userService");
      await ensureAdminUser();
    } catch (authErr) {
      console.warn("Auth seed skipped:", authErr.message);
    }
  } catch (error) {
    console.error("Database init error:", error.message || error);
    throw error;
  }
}

async function seedOperationalData(pool) {
  const employeeRows = [
    { name: "Amit Kumar", email: "amit.kumar@techsales.in", role: "Sales Manager", department: "Sales", initials: "AK" },
    { name: "Priya Sharma", email: "priya.sharma@techsales.in", role: "Sales Executive", department: "Sales", initials: "PS" },
    { name: "Rohan Verma", email: "rohan.verma@techsales.in", role: "Sales Executive", department: "Sales", initials: "RV" },
    { name: "Neha Patel", email: "neha.patel@techsales.in", role: "Sales Executive", department: "Sales", initials: "NP" },
  ];

  const employeeIds = {};
  for (const emp of employeeRows) {
    const existing = await pool.query(
      `SELECT id FROM employees WHERE tenant_id = 'default' AND email = $1 LIMIT 1`,
      [emp.email],
    );
    if (existing.rows[0]) {
      employeeIds[emp.name] = existing.rows[0].id;
      continue;
    }
    const inserted = await pool.query(
      `INSERT INTO employees (name, email, role, department, status, tenant_id, initials, current_active_leads)
       VALUES ($1, $2, $3, $4, 'active', 'default', $5, 0)`,
      [emp.name, emp.email, emp.role, emp.department, emp.initials],
    );
    employeeIds[emp.name] = inserted.rows[0]?.id ?? inserted.insertId;
  }

  const leadCount = await pool.query(`SELECT COUNT(*) AS c FROM leads WHERE tenant_id = 'default' AND is_deleted = 0`);
  if ((leadCount.rows[0]?.c ?? 0) > 0) return;

  const amitId = employeeIds["Amit Kumar"];
  const priyaId = employeeIds["Priya Sharma"];
  const rohanId = employeeIds["Rohan Verma"];

  const leads = [
    { name: "Rajesh Mehta", company: "Tech Corp India", temp: "Hot Lead", stage: "Proposal Sent", status: "Proposal Sent", source: "LinkedIn", revenue: 800000, service: "AI Automation Suite", assignee: amitId },
    { name: "Priya Sharma", company: "InfoSystems Ltd", temp: "Hot Lead", stage: "Converted", status: "Converted", source: "Referral", revenue: 1200000, service: "CRM Setup & Onboarding", assignee: priyaId },
    { name: "Suresh Jain", company: "BuildNext Pvt", temp: "Warm Lead", stage: "Attempted", status: "Attempted", source: "Facebook", revenue: 300000, service: "Lead Gen Engine", assignee: amitId },
    { name: "Kavitha Nair", company: "EduTech Hub", temp: "Warm Lead", stage: "Call Booked", status: "Call Booked", source: "Website", revenue: 600000, service: "Strategic Consulting", assignee: priyaId },
    { name: "Deepak Singh", company: "RetailMax", temp: "Cold Lead", stage: "Attempted", status: "Attempted", source: "Cold Call", revenue: 400000, service: "Custom Software Dev", assignee: amitId },
    { name: "Anjali Gupta", company: "MediCare Plus", temp: "Hot Lead", stage: "Negotiation", status: "Negotiation", source: "Exhibition", revenue: 1500000, service: "AI Automation Suite", assignee: priyaId },
    { name: "Meena Pillai", company: "FinServe India", temp: "Hot Lead", stage: "Proposal Sent", status: "Proposal Sent", source: "Referral", revenue: 2000000, service: "CRM Setup & Onboarding", assignee: amitId },
    { name: "Arun Kumar", company: "LogiTrans", temp: "Warm Lead", stage: "Call Booked", status: "Call Booked", source: "Website", revenue: 500000, service: "Lead Gen Engine", assignee: amitId },
    { name: "Sneha Verma", company: "FoodChain", temp: "Cold Lead", stage: "Attempted", status: "Attempted", source: "Facebook", revenue: 100000, service: "Strategic Consulting", assignee: amitId },
    { name: "Vikram Rao", company: "SmartHome Co", temp: "Cold Lead", stage: "Not Pick", status: "Not Pick", source: "LinkedIn", revenue: 200000, service: "Custom Software Dev", assignee: amitId },
    { name: "Ritu Arora", company: "MediaPlus", temp: "Cold Lead", stage: "Closed", status: "Not Interested", source: "Instagram", revenue: 300000, service: "AI Automation Suite", assignee: rohanId },
    { name: "Siddharth Roy", company: "DataPro Pvt", temp: "Cold Lead", stage: "Closed", status: "Not Interested", source: "Cold Call", revenue: 200000, service: "CRM Setup & Onboarding", assignee: rohanId },
  ];

  for (const lead of leads) {
    await pool.query(
      `INSERT INTO leads (
        lead_name, company_name, phone, email, city, source, temperature, pipeline_stage, status,
        expected_revenue, requirements, tenant_id, assignment_status, assigned_to, assigned_at,
        assigned_by, assignment_method, last_activity_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, 'Mumbai', $5, $6, $7, $8,
        $9, $10, 'default', 'assigned', $11, NOW(),
        'seed', 'manual', NOW(), NOW(), NOW()
      )`,
      [
        lead.name,
        lead.company,
        "+91 90000" + String(Math.floor(Math.random() * 90000)).padStart(5, "0"),
        lead.name.toLowerCase().replace(/\s+/g, ".") + "@example.com",
        lead.source,
        lead.temp,
        lead.stage,
        lead.status,
        lead.revenue,
        lead.service,
        lead.assignee,
      ],
    );
  }

  if (amitId) {
    await pool.query(
      `UPDATE employees e
       SET e.current_active_leads = (
         SELECT COUNT(*) FROM leads l WHERE l.assigned_to = e.id AND l.is_deleted = 0
       )
       WHERE e.id = $1`,
      [amitId],
    );
  }

  console.log("Seeded demo employees and leads with assignments");
}

async function seedCatalogData(pool) {
  const mock = require("../src/data/mockFallback");

  const svcCount = await pool.query(`SELECT COUNT(*) AS c FROM services WHERE tenant_id = 'default'`);
  if ((svcCount.rows[0]?.c ?? 0) === 0) {
    for (const svc of mock.SERVICES) {
      await pool.query(
        `INSERT INTO services (id, tenant_id, name, category, category_label, status, description, revenue, leads, converted, conv_rate, price_num, price_label, icon, metadata)
         VALUES ($1, 'default', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          svc.id, svc.name, svc.category, svc.categoryLabel, svc.status, svc.description,
          svc.revenue, svc.leads, svc.converted, svc.convRate, svc.priceNum, svc.price, svc.icon,
          JSON.stringify(svc),
        ],
      );
    }
    console.log("Seeded services catalog");
  }

  const formCount = await pool.query(`SELECT COUNT(*) AS c FROM forms WHERE tenant_id = 'default'`);
  if ((formCount.rows[0]?.c ?? 0) === 0) {
    for (const form of mock.FORMS) {
      await pool.query(
        `INSERT INTO forms (id, tenant_id, name, source, source_key, status, service, fields, leads, revenue, conversion)
         VALUES ($1, 'default', $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          form.id, form.name, form.source, form.sourceKey, form.status, form.service,
          JSON.stringify(form.fields || []), form.leads, form.revenue, form.conversion,
        ],
      );
    }
    console.log("Seeded forms catalog");
  }

  const settingsCount = await pool.query(`SELECT COUNT(*) AS c FROM tenant_settings WHERE tenant_id = 'default'`);
  if ((settingsCount.rows[0]?.c ?? 0) === 0) {
    await pool.query(
      `INSERT INTO tenant_settings (tenant_id, settings_json) VALUES ('default', $1)`,
      [JSON.stringify(mock.DEFAULT_SETTINGS)],
    );
    console.log("Seeded tenant settings");
  }

  const insightCount = await pool.query(`SELECT COUNT(*) AS c FROM ai_insights WHERE tenant_id = 'default'`);
  if ((insightCount.rows[0]?.c ?? 0) === 0) {
    for (const insight of mock.aiInsights) {
      await pool.query(
        `INSERT INTO ai_insights (tenant_id, context, type, title, body, tone) VALUES ('default', 'dashboard', $1, $2, $3, $4)`,
        [insight.type, insight.title, insight.body, insight.tone],
      );
    }
    console.log("Seeded AI insights");
  }
}

module.exports = { initDatabase };
