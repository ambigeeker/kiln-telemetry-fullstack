require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool(
  process.env.DATABASE_URL
    ? {
        connectionString: process.env.DATABASE_URL,
        ssl: { rejectUnauthorized: false }
      }
    : {
        user: process.env.DB_USER || 'postgres',
        host: process.env.DB_HOST || 'localhost',
        database: process.env.DB_NAME || 'kiln_telemetry',
        password: process.env.DB_PASSWORD || 'postgres',
        port: process.env.DB_PORT || 5432,
      }
);

async function initDatabase() {
  try {
    // Test if both tables exist with the exact columns needed for INNER JOIN
    await pool.query(`
      SELECT k.kiln_id, k.kiln_name, k.location, b.run_id, b.water_removed_kg, b.thermal_efficiency_pct
      FROM kiln_units k
      LEFT JOIN batch_runs b ON k.kiln_id = b.kiln_id
      LIMIT 1;
    `);
    console.log('✅ Existing schema matches 100%');
  } catch (err) {
    console.log('🔄 Rebuilding database tables to match exact schema...');
    await pool.query('DROP TABLE IF EXISTS batch_runs CASCADE;');
    await pool.query('DROP TABLE IF EXISTS kiln_units CASCADE;');

    await pool.query(`
      CREATE TABLE kiln_units (
        kiln_id SERIAL PRIMARY KEY,
        kiln_name VARCHAR(120) NOT NULL,
        location VARCHAR(100),
        max_capacity_kg NUMERIC(10, 2)
      );
    `);

    await pool.query(`
      CREATE TABLE batch_runs (
        run_id SERIAL PRIMARY KEY,
        kiln_id INTEGER REFERENCES kiln_units(kiln_id) ON DELETE CASCADE,
        operator_name VARCHAR(100),
        product_species VARCHAR(100),
        initial_wet_weight_kg NUMERIC(10, 2),
        fuel_consumed_kg NUMERIC(10, 2),
        initial_moisture_pct NUMERIC(5, 2),
        final_moisture_pct NUMERIC(5, 2),
        duration_hours NUMERIC(5, 2),
        water_removed_kg NUMERIC(10, 2),
        thermal_efficiency_pct NUMERIC(5, 2),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  // Ensure kiln units are seeded
  const countRes = await pool.query('SELECT COUNT(*) FROM kiln_units');
  if (parseInt(countRes.rows[0].count, 10) === 0) {
    await pool.query(`
      INSERT INTO kiln_units (kiln_name, location, max_capacity_kg) VALUES
      ('NIOMR-FAO Prototype Kiln A (250kg)', 'Fish Tech Lab 1', 250.00),
      ('NIOMR-FAO Prototype Kiln B (500kg)', 'Fish Tech Lab 2', 500.00),
      ('Mechanical Dryer Unit C (150kg)', 'Pilot Plant Wing', 150.00);
    `);
    console.log('✅ Seeded default kiln_units');
  }
}

initDatabase();

app.get('/api/kilns', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM kiln_units ORDER BY kiln_id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching kilns:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/batches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT b.*, k.kiln_name, k.location
      FROM batch_runs b
      INNER JOIN kiln_units k ON b.kiln_id = k.kiln_id
      ORDER BY b.run_id DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching batches:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/batches', async (req, res) => {
  try {
    const {
      kiln_id,
      operator_name,
      product_species,
      initial_wet_weight_kg,
      fuel_consumed_kg,
      initial_moisture_pct,
      final_moisture_pct,
      duration_hours
    } = req.body;

    const wetWt = parseFloat(initial_wet_weight_kg) || 0;
    const fuelKg = parseFloat(fuel_consumed_kg) || 1;
    const mInit = parseFloat(initial_moisture_pct) || 0;
    const mFinal = parseFloat(final_moisture_pct) || 0;
    const dur = parseFloat(duration_hours) || 0;

    const waterRemoved = Math.max(0, wetWt * ((mInit - mFinal) / (100 - mFinal)));
    const thermalEfficiency = Math.min(100, Math.max(0, ((waterRemoved * 2.26) / (fuelKg * 16.5)) * 100));

    const result = await pool.query(
      `INSERT INTO batch_runs (
        kiln_id, operator_name, product_species, initial_wet_weight_kg,
        fuel_consumed_kg, initial_moisture_pct, final_moisture_pct,
        duration_hours, water_removed_kg, thermal_efficiency_pct
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *;`,
      [
        parseInt(kiln_id, 10),
        operator_name || 'Engr. Qudus',
        product_species || 'Catfish',
        wetWt,
        fuelKg,
        mInit,
        mFinal,
        dur,
        waterRemoved.toFixed(2),
        thermalEfficiency.toFixed(2)
      ]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error logging batch:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/batches/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM batch_runs WHERE run_id = $1', [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Industrial Telemetry Server running on http://localhost:${PORT}`);
});