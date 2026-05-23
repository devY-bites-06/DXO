const { Client } = require('pg');

async function checkPort(port, password) {
  const client = new Client({
    host: 'localhost',
    port: '1221',
    user: 'postgres',
    password: 'postPASS3000',
    database: 'postgres'
  });
  try {
    await client.connect();
    const res = await client.query('SELECT version()');
    console.log(`Port ${port} (Password: "${password}"): Connected! Version: ${res.rows[0].version}`);
    
    // Check if pgvector is enabled
    try {
      const extRes = await client.query("SELECT extname FROM pg_extension WHERE extname = 'vector'");
      if (extRes.rows.length > 0) {
        console.log("  -> pgvector is INSTALLED and ENABLED in 'postgres' database.");
      } else {
        console.log("  -> pgvector is NOT enabled in 'postgres' database.");
      }
    } catch (e) {
      console.log(`  -> Failed to check pgvector extension: ${e.message}`);
    }
    
    await client.end();
    return true;
  } catch (err) {
    console.log(`Port ${port} (Password: "${password}"): Failed. Reason: ${err.message}`);
    return false;
  }
}

async function run() {
  console.log("Checking port 1221...");
  const passwords = ["postgres", "admin", "", "root"];
  for (const pwd of passwords) {
    const ok = await checkPort(1221, pwd);
    if (ok) break;
  }
}
run();
