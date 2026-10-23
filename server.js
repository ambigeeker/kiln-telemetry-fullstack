require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT,
});

app.get("/api/kilns", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT kiln_id, unit_code, unit_name, fuel_type, fuel_lhv_mj_kg, location_bay FROM kiln_units ORDER BY kiln_id ASC"
        );
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching kilns:", err.message);
        res.status(500).json({ error: "Database error fetching kiln units" });
    }
});

app.get("/api/batches", async (req, res) => {
    try {
        const query = `
            SELECT 
                b.run_id, b.kiln_id, k.unit_code, k.unit_name, k.fuel_type,
                b.operator_name, b.product_type, b.initial_weight_kg,
                b.initial_mc_pct, b.final_mc_pct, b.fuel_consumed_kg,
                b.drying_duration_hrs, b.water_removed_kg,
                b.thermal_efficiency_pct, b.recorded_at
            FROM batch_runs b
            INNER JOIN kiln_units k ON b.kiln_id = k.kiln_id
            ORDER BY b.recorded_at DESC;
        `;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error("Error fetching batch runs:", err.message);
        res.status(500).json({ error: "Database error fetching batch runs" });
    }
});

app.post("/api/batches", async (req, res) => {
    try {
        const {
            kiln_id, operator_name, product_type, initial_weight_kg,
            initial_mc_pct, final_mc_pct, fuel_consumed_kg, drying_duration_hrs
        } = req.body;

        const kilnResult = await pool.query(
            "SELECT fuel_lhv_mj_kg FROM kiln_units WHERE kiln_id = $1",
            [kiln_id]
        );

        if (kilnResult.rows.length === 0) {
            return res.status(400).json({ error: "Invalid Kiln Unit ID" });
        }

        const lhv = parseFloat(kilnResult.rows[0].fuel_lhv_mj_kg);
        const W_i = parseFloat(initial_weight_kg);
        const MC_i = parseFloat(initial_mc_pct);
        const MC_f = parseFloat(final_mc_pct);
        const M_fuel = parseFloat(fuel_consumed_kg);

        const W_f = W_i * ((100 - MC_i) / (100 - MC_f));
        const waterRemovedKg = W_i - W_f;

        const sensibleHeatMj = waterRemovedKg * 0.004186 * 42;
        const latentHeatMj = waterRemovedKg * 2.26;
        const usefulHeatMj = sensibleHeatMj + latentHeatMj;

        const heatInputMj = M_fuel * lhv;
        const thermalEfficiencyPct = (usefulHeatMj / heatInputMj) * 100;

        const insertQuery = `
            INSERT INTO batch_runs (
                kiln_id, operator_name, product_type, initial_weight_kg,
                initial_mc_pct, final_mc_pct, fuel_consumed_kg,
                drying_duration_hrs, water_removed_kg, thermal_efficiency_pct
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            RETURNING *;
        `;

        const values = [
            kiln_id, operator_name, product_type,
            W_i.toFixed(2), MC_i.toFixed(2), MC_f.toFixed(2),
            M_fuel.toFixed(2), parseFloat(drying_duration_hrs).toFixed(2),
            waterRemovedKg.toFixed(2), thermalEfficiencyPct.toFixed(2)
        ];

        const newBatch = await pool.query(insertQuery, values);
        res.status(201).json(newBatch.rows[0]);
    } catch (err) {
        console.error("Error logging batch:", err.message);
        res.status(400).json({ error: err.message });
    }
});

app.delete("/api/batches/:id", async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query("DELETE FROM batch_runs WHERE run_id = $1", [id]);
        res.json({ message: `Batch run #${id} deleted` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const server = app.listen(PORT, () => {
    console.log(`🚀 Industrial Telemetry Server running on http://localhost:${PORT}`);
});

server.on("error", (err) => {
    console.error("❌ Server failed to start:", err.message);
});
// Middleware: Parse incoming JSON payloads
app.use(express.json());

// Serve static frontend files from the 'public' folder
app.use(express.static(path.join(__dirname, "public")));

// Explicit root route handler for maximum reliability
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});