require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.json());

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
    await pool.query(`
      SELECT k.kiln_id, k.kiln_name, k.location, b.run_id, b.water_removed_kg, b.thermal_efficiency_pct
      FROM kiln_units k
      LEFT JOIN batch_runs b ON k.kiln_id = b.kiln_id
      LIMIT 1;
    `);
  } catch (err) {
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

  const countRes = await pool.query('SELECT COUNT(*) FROM kiln_units');
  if (parseInt(countRes.rows[0].count, 10) === 0) {
    await pool.query(`
      INSERT INTO kiln_units (kiln_name, location, max_capacity_kg) VALUES
      ('NIOMR-FAO Prototype Kiln A (250kg)', 'Fish Tech Lab 1', 250.00),
      ('NIOMR-FAO Prototype Kiln B (500kg)', 'Fish Tech Lab 2', 500.00),
      ('Mechanical Dryer Unit C (150kg)', 'Pilot Plant Wing', 150.00);
    `);
  }
}

initDatabase();

app.get('/api/kilns', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM kiln_units ORDER BY kiln_id ASC');
    res.json(result.rows);
  } catch (err) {
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

// Serve the entire updated UI directly from '/' so no static cache or wrong path can block it
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Centralized Kiln Telemetry & Batch Run Database</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    :root {
      --bg-dark: #0b1120;
      --card-bg: #111827;
      --border: #1e293b;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --accent-blue: #38bdf8;
      --btn-blue: #0284c7;
      --badge-green-bg: rgba(16, 185, 129, 0.15);
      --badge-green-text: #34d399;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', system-ui, -apple-system, sans-serif; }
    body { background-color: var(--bg-dark); color: var(--text-main); padding: 32px 48px; }
    .status-pill {
      display: inline-block;
      background: var(--badge-green-bg);
      color: var(--badge-green-text);
      border: 1px solid rgba(52, 211, 153, 0.3);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.8px;
      padding: 5px 12px;
      border-radius: 999px;
      margin-bottom: 12px;
      text-transform: uppercase;
    }
    h1 { font-size: 28px; font-weight: 700; margin-bottom: 6px; }
    .subtitle { color: var(--text-muted); font-size: 14px; margin-bottom: 28px; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 20px; margin-bottom: 28px; }
    .kpi-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
    .kpi-title { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 10px; }
    .kpi-value { font-size: 28px; font-weight: 800; color: var(--accent-blue); }
    .main-grid { display: grid; grid-template-columns: 360px 1fr; gap: 24px; align-items: start; }
    .right-column { display: flex; flex-direction: column; gap: 24px; }
    .panel { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 24px; }
    .panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .panel h2 { font-size: 17px; font-weight: 700; margin: 0; }
    .form-group { margin-bottom: 16px; }
    .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px; }
    label { display: block; font-size: 12px; color: var(--text-muted); margin-bottom: 6px; }
    input, select {
      width: 100%; background: #090d16; border: 1px solid #1e293b; color: var(--text-main);
      padding: 10px 12px; border-radius: 8px; font-size: 14px;
    }
    .btn-submit {
      width: 100%; background: var(--btn-blue); color: white; border: none; padding: 12px;
      border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer;
    }
    .btn-export {
      background: rgba(16, 185, 129, 0.15); color: #34d399; border: 1px solid rgba(52, 211, 153, 0.4);
      padding: 8px 14px; border-radius: 8px; font-weight: 600; font-size: 12px; cursor: pointer;
    }
    .btn-export:hover { background: rgba(16, 185, 129, 0.3); }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th {
      background: #0d1322; color: var(--text-muted); font-size: 11px; text-transform: uppercase;
      text-align: left; padding: 12px; border-bottom: 1px solid var(--border);
    }
    td { padding: 14px 12px; border-bottom: 1px solid var(--border); color: #e2e8f0; }
    .btn-del {
      background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.3);
      padding: 4px 10px; border-radius: 6px; cursor: pointer; font-size: 12px;
    }
    .chart-container { position: relative; height: 260px; width: 100%; }
  </style>
</head>
<body>
  <div class="status-pill">POSTGRESQL + NODE.JS EXPRESS LIVE CONNECTED</div>
  <h1>Centralized Kiln Telemetry & Batch Run Database 🔥🗄️</h1>
  <p class="subtitle">Multi-unit relational drying logs with server-side thermodynamic computation and ACID persistence</p>

  <div class="kpi-grid">
    <div class="kpi-card"><div class="kpi-title">TOTAL LOGGED BATCHES (DB)</div><div class="kpi-value" id="kpi-batches">0</div></div>
    <div class="kpi-card"><div class="kpi-title">CUMULATIVE WATER REMOVED</div><div class="kpi-value" id="kpi-water">0.0 kg</div></div>
    <div class="kpi-card"><div class="kpi-title">MEAN THERMAL EFFICIENCY</div><div class="kpi-value" id="kpi-eff">0.0 %</div></div>
    <div class="kpi-card"><div class="kpi-title">TOTAL BIOMASS FUEL LOGGED</div><div class="kpi-value" id="kpi-fuel">0.0 kg</div></div>
  </div>

  <div class="main-grid">
    <div class="panel">
      <div class="panel-header"><h2>Log New Drying Batch Run</h2></div>
      <form id="batch-form">
        <div class="form-group">
          <label>Select Physical Kiln Unit (Foreign Key)</label>
          <select id="kiln_id" required></select>
        </div>
        <div class="form-row">
          <div><label>Operator / Engineer</label><input type="text" id="operator_name" value="Engr. Qudus" required /></div>
          <div><label>Product / Species</label><input type="text" id="product_species" placeholder="e.g., Catfish / Tilapia" required /></div>
        </div>
        <div class="form-row">
          <div><label>Initial Wet Batch Weight (kg)</label><input type="number" step="0.1" id="initial_wet_weight_kg" value="100" required /></div>
          <div><label>Fuel Consumed (kg)</label><input type="number" step="0.1" id="fuel_consumed_kg" value="25" required /></div>
        </div>
        <div class="form-row">
          <div><label>Initial Moisture (%)</label><input type="number" step="0.1" id="initial_moisture_pct" value="75" required /></div>
          <div><label>Final Target Moisture (%)</label><input type="number" step="0.1" id="final_moisture_pct" value="12" required /></div>
        </div>
        <div class="form-group">
          <label>Total Drying Duration (Hours)</label>
          <input type="number" step="0.1" id="duration_hours" value="6.0" required />
        </div>
        <button type="submit" class="btn-submit">Commit Batch to PostgreSQL Database ➔</button>
      </form>
    </div>

    <div class="right-column">
      <div class="panel">
        <div class="panel-header">
          <h2>Relational Batch Records (\`batch_runs\` INNER JOIN \`kiln_units\`)</h2>
          <button type="button" class="btn-export" onclick="exportToCSV()">⬇ Export CSV (Excel)</button>
        </div>
        <table>
          <thead>
            <tr>
              <th>RUN ID</th><th>KILN UNIT</th><th>OPERATOR & PRODUCT</th><th>WET WT (KG)</th>
              <th>MC DROP</th><th>WATER OUT</th><th>FUEL USED</th><th>THERMAL EFF.</th><th>ACTION</th>
            </tr>
          </thead>
          <tbody id="batch-table-body"></tbody>
        </table>
      </div>

      <div class="panel">
        <div class="panel-header">
          <h2>Thermodynamic Performance Analytics (Water Removed vs. Thermal Efficiency)</h2>
        </div>
        <div class="chart-container"><canvas id="telemetryChart"></canvas></div>
      </div>
    </div>
  </div>

  <script>
    let cachedBatches = [];
    let telemetryChartInstance = null;

    async function loadKilns() {
      const res = await fetch('/api/kilns');
      const kilns = await res.json();
      const select = document.getElementById('kiln_id');
      select.innerHTML = '';
      kilns.forEach(k => {
        const opt = document.createElement('option');
        opt.value = k.kiln_id;
        opt.textContent = k.kiln_name + ' — [' + k.location + ']';
        select.appendChild(opt);
      });
    }

    async function loadBatches() {
      const res = await fetch('/api/batches');
      const batches = await res.json();
      cachedBatches = batches;
      const tbody = document.getElementById('batch-table-body');
      tbody.innerHTML = '';

      let totalWater = 0, totalFuel = 0, sumEff = 0;

      batches.forEach(b => {
        const water = parseFloat(b.water_removed_kg) || 0;
        const fuel = parseFloat(b.fuel_consumed_kg) || 0;
        const eff = parseFloat(b.thermal_efficiency_pct) || 0;
        totalWater += water; totalFuel += fuel; sumEff += eff;

        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td>#' + b.run_id + '</td>' +
          '<td><strong>' + b.kiln_name + '</strong></td>' +
          '<td>' + b.operator_name + ' (' + b.product_species + ')</td>' +
          '<td>' + parseFloat(b.initial_wet_weight_kg).toFixed(1) + ' kg</td>' +
          '<td>' + b.initial_moisture_pct + '% ➔ ' + b.final_moisture_pct + '%</td>' +
          '<td style="color:#38bdf8;font-weight:600;">' + water.toFixed(1) + ' kg</td>' +
          '<td>' + fuel.toFixed(1) + ' kg</td>' +
          '<td style="color:#34d399;font-weight:600;">' + eff.toFixed(1) + '%</td>' +
          '<td><button class="btn-del" onclick="deleteBatch(' + b.run_id + ')">Delete</button></td>';
        tbody.appendChild(tr);
      });

      document.getElementById('kpi-batches').textContent = batches.length;
      document.getElementById('kpi-water').textContent = totalWater.toFixed(1) + ' kg';
      document.getElementById('kpi-fuel').textContent = totalFuel.toFixed(1) + ' kg';
      const meanEff = batches.length > 0 ? (sumEff / batches.length) : 0;
      document.getElementById('kpi-eff').textContent = meanEff.toFixed(1) + ' %';

      renderChart(batches);
    }

    function renderChart(batches) {
      const ctx = document.getElementById('telemetryChart').getContext('2d');
      const chronological = [...batches].reverse();
      const labels = chronological.map(b => 'Run #' + b.run_id + ' (' + b.product_species + ')');
      const waterData = chronological.map(b => parseFloat(b.water_removed_kg) || 0);
      const effData = chronological.map(b => parseFloat(b.thermal_efficiency_pct) || 0);

      if (telemetryChartInstance) telemetryChartInstance.destroy();

      telemetryChartInstance = new Chart(ctx, {
        type: 'bar',
        data: {
          labels,
          datasets: [
            {
              label: 'Water Removed (kg)',
              data: waterData,
              backgroundColor: 'rgba(56, 189, 248, 0.65)',
              borderColor: '#38bdf8',
              borderWidth: 1,
              borderRadius: 6,
              yAxisID: 'y'
            },
            {
              label: 'Thermal Efficiency (%)',
              data: effData,
              type: 'line',
              borderColor: '#34d399',
              backgroundColor: '#34d399',
              borderWidth: 2,
              tension: 0.3,
              pointRadius: 4,
              yAxisID: 'y1'
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { labels: { color: '#cbd5e1' } } },
          scales: {
            x: { ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' } },
            y: {
              type: 'linear', position: 'left',
              title: { display: true, text: 'Water Removed (kg)', color: '#38bdf8' },
              ticks: { color: '#94a3b8' }, grid: { color: '#1e293b' }
            },
            y1: {
              type: 'linear', position: 'right',
              title: { display: true, text: 'Thermal Efficiency (%)', color: '#34d399' },
              ticks: { color: '#94a3b8' }, grid: { drawOnChartArea: false }
            }
          }
        }
      });
    }

    function exportToCSV() {
      if (!cachedBatches.length) return alert('No batch records available to export.');
      const headers = ['Run ID','Kiln Unit','Location','Operator','Product Species','Wet Weight (kg)','Initial MC (%)','Final MC (%)','Duration (h)','Water Removed (kg)','Fuel Used (kg)','Thermal Eff (%)','Timestamp'];
      const rows = cachedBatches.map(b => [
        b.run_id, '"' + b.kiln_name + '"', '"' + b.location + '"', '"' + b.operator_name + '"', '"' + b.product_species + '"',
        b.initial_wet_weight_kg, b.initial_moisture_pct, b.final_moisture_pct, b.duration_hours,
        b.water_removed_kg, b.fuel_consumed_kg, b.thermal_efficiency_pct, '"' + new Date(b.created_at).toLocaleString() + '"'
      ]);
      const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\\n');
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.setAttribute('download', 'kiln_telemetry_batches.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    document.getElementById('batch-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const payload = {
        kiln_id: document.getElementById('kiln_id').value,
        operator_name: document.getElementById('operator_name').value,
        product_species: document.getElementById('product_species').value,
        initial_wet_weight_kg: document.getElementById('initial_wet_weight_kg').value,
        fuel_consumed_kg: document.getElementById('fuel_consumed_kg').value,
        initial_moisture_pct: document.getElementById('initial_moisture_pct').value,
        final_moisture_pct: document.getElementById('final_moisture_pct').value,
        duration_hours: document.getElementById('duration_hours').value
      };
      const res = await fetch('/api/batches', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        document.getElementById('product_species').value = '';
        await loadBatches();
      }
    });

    async function deleteBatch(id) {
      await fetch('/api/batches/' + id, { method: 'DELETE' });
      await loadBatches();
    }

    loadKilns();
    loadBatches();
  </script>
</body>
</html>`);
});

app.listen(PORT, () => {
  console.log(`🚀 Industrial Telemetry Server running on http://localhost:${PORT}`);
});