require('dotenv').config();
const pool = require('./config/db');
async function check() {
  try {
    // 1. Check distinct pipeline_stage values in leads
    const stages = await pool.query(
      `SELECT pipeline_stage, status, COUNT(*) as cnt 
       FROM leads WHERE tenant_id='default' AND is_deleted=0 
       GROUP BY pipeline_stage, status ORDER BY cnt DESC LIMIT 30`
    );
    console.log('\n=== LEAD PIPELINE_STAGE + STATUS VALUES IN DB ===');
    stages.rows.forEach(r => console.log(JSON.stringify(r)));

    // 2. Check if meetings table exists
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables 
       WHERE table_schema = DATABASE() AND table_name = 'meetings'`
    );
    console.log('\n=== MEETINGS TABLE EXISTS:', tables.rows.length > 0 ? 'YES' : 'NO');

    if (tables.rows.length > 0) {
      const cols = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'meetings' LIMIT 20`
      );
      console.log('=== MEETINGS COLUMNS:', cols.rows.map(r => r.COLUMN_NAME || r.column_name));
      const mtg = await pool.query('SELECT * FROM meetings LIMIT 5');
      console.log('=== MEETINGS SAMPLE:', JSON.stringify(mtg.rows, null, 2));
    }

    // 3. Check employee_calls columns
    const ecCols = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employee_calls' LIMIT 20`
    );
    console.log('\n=== EMPLOYEE_CALLS COLUMNS:', ecCols.rows.map(r => r.COLUMN_NAME || r.column_name));

    // 4. Check employees table columns
    const empCols = await pool.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'employees' LIMIT 30`
    );
    console.log('\n=== EMPLOYEES COLUMNS:', empCols.rows.map(r => r.COLUMN_NAME || r.column_name));

    // 5. Count meetings per employee from leads table
    const meetingCounts = await pool.query(
      `SELECT e.name, 
              SUM(CASE WHEN LOWER(COALESCE(l.pipeline_stage,'')) IN ('meeting','meeting booked','meeting done','demo') 
                       OR LOWER(COALESCE(l.status,'')) LIKE '%meeting%' THEN 1 ELSE 0 END) as meetings_done
       FROM leads l
       LEFT JOIN employees e ON e.id = l.assigned_to
       WHERE l.tenant_id='default' AND l.is_deleted=0
       GROUP BY e.name`
    );
    console.log('\n=== MEETINGS DONE PER EMPLOYEE (from leads) ===');
    meetingCounts.rows.forEach(r => console.log(JSON.stringify(r)));

    process.exit(0);
  } catch(e) {
    console.error('ERROR:', e.message);
    process.exit(1);
  }
}

check();
