require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Single, unified PostgreSQL connection pool (Cloud + Local compatible)
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

// Auto-initialize and seed database tables on startup
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS kiln_units (
        kiln_id SERIAL PRIMARY KEY,
        kiln_name VARCHAR(120) NOT NULL,
        location VARCHAR(100),
        max_capacity_kg NUMERIC(10, 2)
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS batch_runs (
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

    // Check if kiln_units is empty or missing 'kiln_name', and repair/seed automatically
    const countRes = await pool.query('SELECT COUNT(*) FROM kiln_units');
    if (parseInt(countRes.rows[0].count, 10) === 0) {
      await pool.query(`
        INSERT INTO kiln_units (kiln_name, location, max_capacity_kg) VALUES
        ('NIOMR-FAO Prototype Kiln A (250kg)', 'Fish Tech Lab 1', 250.00),
        ('NIOMR-FAO Prototype Kiln B (500kg)', 'Fish Tech Lab 2', 500.00),
        ('Mechanical Dryer Unit C (150kg)', 'Pilot Plant Wing', 150.00);
      `);
      console.log('✅ Seeded default kiln_units into PostgreSQL');
    }
    console.log('✅ Database schema verified and ready');
  } catch (err) {
    console.warn('⚠️ Schema mismatch detected, rebuilding clean tables...', err.message);
    try {
      await pool.query('DROP TABLE IF EXISTS batch_runs CASCADE;');
      await pool.query('DROP TABLE IF EXISTS kiln_units CASCADE;');
      await initDatabase();
    } catch (rebuildErr) {
      console.error('❌ Database rebuild error:', rebuildErr.message);
    }
  }
}

initDatabase();

// GET all physical kiln units for the dropdown
app.get('/api/kilns', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM kiln_units ORDER BY kiln_id ASC');
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching kilns:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET all logged batch runs with INNER JOIN on kiln_units
app.get('/api/batches', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        b.*, 
        k.kiln_name, 
        k.location 
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

// POST a new drying batch run with server-side thermodynamic calculations
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

    // Mass balance: Water removed (kg) = W_i * (M_i - M_f) / (100 - M_f)
    const waterRemoved = Math.max(0, wetWt * ((mInit - mFinal) / (100 - mFinal)));

    // Thermal Efficiency (%) = (Water Removed * Latent Heat 2.26 MJ/kg) / (Fuel * Calorific Value 16.5 MJ/kg) * 100
    const latentHeatMJ = 2.26;
    const biomassCalorificMJ = 16.5;
    const thermalEfficiency = Math.min(100, Math.max(0, ((waterRemoved * latentHeatMJ) / (fuelKg * biomassCalorificMJ)) * 100));

    const insertQuery = `
      INSERT INTO batch_runs (
        kiln_id, operator_name, product_species, initial_wet_weight_kg,
        fuel_consumed_kg, initial_moisture_pct, final_moisture_pct,
        duration_hours, water_removed_kg, thermal_efficiency_pct
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
    `;

    const values = [
      parseInt(kiln_id, 10),
      operator_name,
      product_species,
      wetWt,
      fuelKg,
      mInit,
      mFinal,
      dur,
      waterRemoved.toFixed(2),
      thermalEfficiency.toFixed(2)
    ];

    const result = await pool.query(insertQuery, values);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error logging batch:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// DELETE a batch run record
app.delete('/api/batches/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM batch_runs WHERE run_id = $1', [id]);
    res.json({ message: 'Batch deleted successfully' });
  } catch (err) {
    console.error('Error deleting batch:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Industrial Telemetry Server running on http://localhost:${PORT}`);
});