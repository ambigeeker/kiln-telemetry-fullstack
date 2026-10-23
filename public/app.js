async function loadKilnUnits() {
    const res = await fetch("/api/kilns");
    const kilns = await res.json();
    const select = document.getElementById("kiln_id");
    select.innerHTML = kilns.map(k =>
        `<option value="${k.kiln_id}">${k.unit_code} — ${k.unit_name} (${k.fuel_type}, ${k.fuel_lhv_mj_kg} MJ/kg)</option>`
    ).join("");
}

async function loadBatches() {
    const res = await fetch("/api/batches");
    const batches = await res.json();

    const tbody = document.getElementById("batch_tbody");
    tbody.innerHTML = "";

    let totalWater = 0;
    let totalFuel = 0;
    let sumEff = 0;

    batches.forEach(b => {
        const water = parseFloat(b.water_removed_kg);
        const fuel = parseFloat(b.fuel_consumed_kg);
        const eff = parseFloat(b.thermal_efficiency_pct);

        totalWater += water;
        totalFuel += fuel;
        sumEff += eff;

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><strong>#${b.run_id}</strong></td>
            <td><strong>${b.unit_code}</strong><br><small style="color:#94a3b8">${b.fuel_type}</small></td>
            <td><strong>${b.product_type}</strong><br><small style="color:#94a3b8">${b.operator_name}</small></td>
            <td>${b.initial_weight_kg} kg</td>
            <td>${b.initial_mc_pct}% ➔ ${b.final_mc_pct}%</td>
            <td>${b.water_removed_kg} kg</td>
            <td>${b.fuel_consumed_kg} kg</td>
            <td><span class="eff-pill">${b.thermal_efficiency_pct}%</span></td>
            <td><button class="btn-del" onclick="deleteBatch(${b.run_id})">✕</button></td>
        `;
        tbody.appendChild(tr);
    });

    const avgEff = batches.length > 0 ? (sumEff / batches.length) : 0;

    document.getElementById("kpi_total_runs").innerText = batches.length;
    document.getElementById("kpi_total_water").innerHTML = `${totalWater.toFixed(1)} <small>kg</small>`;
    document.getElementById("kpi_avg_eff").innerHTML = `${avgEff.toFixed(2)} <small>%</small>`;
    document.getElementById("kpi_total_fuel").innerHTML = `${totalFuel.toFixed(1)} <small>kg</small>`;
}

document.getElementById("batch_form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorBox = document.getElementById("error_box");
    errorBox.style.display = "none";

    const payload = {
        kiln_id: parseInt(document.getElementById("kiln_id").value, 10),
        operator_name: document.getElementById("operator_name").value.trim(),
        product_type: document.getElementById("product_type").value.trim(),
        initial_weight_kg: parseFloat(document.getElementById("initial_weight_kg").value),
        initial_mc_pct: parseFloat(document.getElementById("initial_mc_pct").value),
        final_mc_pct: parseFloat(document.getElementById("final_mc_pct").value),
        fuel_consumed_kg: parseFloat(document.getElementById("fuel_consumed_kg").value),
        drying_duration_hrs: parseFloat(document.getElementById("drying_duration_hrs").value)
    };

    const res = await fetch("/api/batches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
    });

    const data = await res.json();

    if (!res.ok) {
        errorBox.innerText = `PostgreSQL Constraint Error: ${data.error}`;
        errorBox.style.display = "block";
        return;
    }

    document.getElementById("product_type").value = "";
    await loadBatches();
});

window.deleteBatch = async function(id) {
    await fetch(`/api/batches/${id}`, { method: "DELETE" });
    await loadBatches();
};

document.addEventListener("DOMContentLoaded", async () => {
    await loadKilnUnits();
    await loadBatches();
});