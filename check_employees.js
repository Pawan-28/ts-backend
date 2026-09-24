require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  });
  
  console.log('\n=== ALL employees ===');
  const [all] = await conn.query('SELECT id, name, status FROM employees ORDER BY name ASC');
  all.forEach(r => console.log(`  id=${r.id} name="${r.name}" status="${r.status}"`));
  
  console.log('\n=== ACTIVE only (status=active) ===');
  const [active] = await conn.query("SELECT id, name, status FROM employees WHERE status = 'active' ORDER BY name ASC");
  active.forEach(r => console.log(`  id=${r.id} name="${r.name}" status="${r.status}"`));
  
  console.log('\n=== Filter used in getEmployees (not inactive) ===');
  const [notInactive] = await conn.query("SELECT id, name, status FROM employees WHERE LOWER(COALESCE(status, 'active')) != 'inactive' ORDER BY name ASC");
  notInactive.forEach(r => console.log(`  id=${r.id} name="${r.name}" status="${r.status}"`));
  
  await conn.end();
})().catch(e => console.error('ERROR:', e.message));
