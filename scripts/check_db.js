const { Pool } = require('pg');
(async () => {
  const pool = new Pool({ host: '127.0.0.1', port: 6432, user: 'postgres', password: 'MangoDummy@11', database: 'uk_visa_compliance' });
  try {
    const t = await pool.query("SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema='security' AND table_name='credential';");
    console.log('table exists:', t.rows[0].cnt);
    const c = await pool.query("SELECT id,email FROM security.credential LIMIT 5;");
    console.log('sample rows:', c.rows);
  } catch (e) {
    console.error('error:', e.message);
  } finally {
    await pool.end();
  }
})();
