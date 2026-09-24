require("dotenv").config();

const pool = require("./config/db");

async function testConnection() {
  try {
    const result = await pool.query("SELECT NOW()");
    console.log("Database Connected Successfully!");
    console.log(result.rows[0]);
  } catch (error) {
    console.error("Connection Error:", error.message);
  }
}

testConnection();