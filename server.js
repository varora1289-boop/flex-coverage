const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));

// ─── Redash Configuration ───
const REDASH_CSV_URL = "https://flex-redash.indeed.tech/api/queries/53035/results.csv?api_key=MmtR1TQ5JCSJ6rZoJP0ABQBhtQiItYkalkuN9ySb";
const REFRESH_INTERVAL = 4 * 60 * 60 * 1000; // 4 hours

// In-memory data
let cachedTerritories = {};
let cachedStates = new Set();
let dataSource = "not loaded";
let lastRefresh = null;

// ─── Fetch URL ───
function fetchURL(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchURL(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => resolve(data));
      res.on("error", reject);
    }).on("error", reject);
  });
}

// ─── Parse Redash CSV ───
// Columns: COUNTRY, REGION, POSTCODE, CITY, STATE, STATE_ABREVIATION,
//          CITY_STATE, AREA, METRO, METRO_STATE, LATITUDE, LONGITUDE,
//          MARKET_COVERAGE, MARKET, CORE_MARKET, INDUSTRIAL, HOSPITALITY,
//          FACILITIES_MANAGEMENT, RETAIL, CLERICAL, HEALTHCARE, HARD_SERVICES,
//          OWNER_1, OWNER_2, OWNER_3
function parseRedashCSV(csv) {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return { territories: {}, states: new Set() };

  // Parse header
  const header = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, "").toUpperCase());
  const col = (name) => header.indexOf(name);

  const iPostcode = col("POSTCODE");
  const iCountry = col("COUNTRY");
  const iMarketCov = col("MARKET_COVERAGE");
  const iMarket = col("MARKET");
  const iState = col("STATE_ABREVIATION") >= 0 ? col("STATE_ABREVIATION") : col("STATE");

  if (iPostcode < 0 || iMarketCov < 0) {
    console.log("  ⚠ Redash CSV missing POSTCODE or MARKET_COVERAGE columns");
    console.log("    Found headers:", header.join(", "));
    return { territories: {}, states: new Set() };
  }

  // Map Redash MARKET_COVERAGE values to our tier codes
  const tierMap = {
    "CORE MARKET": "core",
    "ADJACENT MARKET": "adj",
    "SEGMENTED MARKET": "seg",
    "EXPANSION MARKET": "exp",
  };

  const territories = {};
  const coreAdjStates = new Set(); // states that have core or adj markets

  for (let i = 1; i < lines.length; i++) {
    // Parse CSV row (handle quoted fields)
    const vals = lines[i].match(/(".*?"|[^,]*)/g) || [];
    const clean = vals.map(v => v.replace(/^"|"$/g, "").trim());

    const country = iCountry >= 0 ? clean[iCountry] : "US";
    if (country !== "US") continue; // skip UK for now

    const postcode = (clean[iPostcode] || "").replace(/\D/g, "").padStart(5, "0");
    if (postcode.length !== 5 || postcode === "00000") continue;

    const coverage = (clean[iMarketCov] || "").toUpperCase().trim();
    const market = iMarket >= 0 ? (clean[iMarket] || "") : "";
    const state = iState >= 0 ? (clean[iState] || "").toUpperCase().trim() : "";

    const type = tierMap[coverage];

    if (type) {
      // Core, Adjacent, Segmented, or Expansion — add to territories
      territories[postcode] = { market, type };

      // Track which states have core or adjacent markets
      if ((type === "core" || type === "adj") && state.length === 2) {
        coreAdjStates.add(state);
      }
    }
    // Out of Coverage and Non-compliant are handled by state fallback
    // but we still track states that have core/adj for the fallback logic
  }

  return { territories, states: coreAdjStates };
}

// ─── Load from local CSV (fallback) ───
function loadLocalTerritories() {
  const csv = fs.readFileSync(path.join(__dirname, "data", "territories.csv"), "utf8");
  const lines = csv.trim().split("\n").slice(1);
  const map = {};
  for (const line of lines) {
    const [zip, market, tier] = line.split(",");
    if (zip && market && tier) {
      map[zip.trim().padStart(5, "0")] = { market: market.trim(), type: tier.trim() };
    }
  }
  return map;
}

function loadCompliantStates() {
  const csv = fs.readFileSync(path.join(__dirname, "data", "compliant_states.csv"), "utf8");
  const lines = csv.trim().split("\n").slice(1);
  const states = new Set();
  for (const line of lines) {
    const [st, status] = line.split(",");
    if (st && status && status.trim().toLowerCase() === "compliant") {
      states.add(st.trim().toUpperCase());
    }
  }
  return states;
}

// ─── Refresh data ───
async function refreshData() {
  // Try Redash first
  try {
    console.log("  ↻ Fetching territory data from Redash...");
    const csv = await fetchURL(REDASH_CSV_URL);
    const result = parseRedashCSV(csv);
    const count = Object.keys(result.territories).length;

    if (count > 100) {
      cachedTerritories = result.territories;
      // Use states derived from Redash data, plus any from local config
      try {
        const localStates = loadCompliantStates();
        cachedStates = new Set([...result.states, ...localStates]);
      } catch (_) {
        cachedStates = result.states;
      }
      dataSource = "Redash (live)";
      lastRefresh = new Date().toISOString();
      console.log(`  ✓ Loaded ${count} ZIP territories from Redash`);
      console.log(`  ✓ ${cachedStates.size} compliant states (${[...cachedStates].sort().join(", ")})`);

      // Save backup
      try {
        const rows = ["zip,market,tier"];
        for (const [zip, data] of Object.entries(result.territories)) {
          rows.push(`${zip},${data.market},${data.type}`);
        }
        fs.writeFileSync(path.join(__dirname, "data", "territories_redash_backup.csv"), rows.join("\n"));
      } catch (_) {}
      return;
    } else {
      console.log(`  ⚠ Redash returned only ${count} records, falling back to local CSV`);
    }
  } catch (err) {
    console.log(`  ⚠ Redash unavailable (${err.message}), falling back to local CSV`);
  }

  // Fallback
  try {
    cachedTerritories = loadLocalTerritories();
    cachedStates = loadCompliantStates();
    dataSource = "Local CSV (fallback)";
    lastRefresh = new Date().toISOString();
    console.log(`  ✓ Loaded ${Object.keys(cachedTerritories).length} ZIP territories from local CSV`);
    console.log(`  ✓ ${cachedStates.size} compliant states`);
  } catch (err) {
    console.log("  ✗ Could not load local data:", err.message);
  }
}

// ─── API Routes ───

app.get("/api/territories", (req, res) => {
  res.json({
    territories: cachedTerritories,
    compliantStates: [...cachedStates],
    dataSource, lastRefresh,
    zipCount: Object.keys(cachedTerritories).length
  });
});

app.get("/api/refresh", async (req, res) => {
  await refreshData();
  res.json({
    message: "Data refreshed", dataSource, lastRefresh,
    zipCount: Object.keys(cachedTerritories).length,
    compliantStates: [...cachedStates]
  });
});

app.get("/api/status", (req, res) => {
  res.json({
    dataSource, lastRefresh,
    zipCount: Object.keys(cachedTerritories).length,
    compliantStates: cachedStates.size,
    uptime: Math.round(process.uptime()) + "s"
  });
});

app.post("/api/log", (req, res) => {
  try {
    const logsDir = path.join(__dirname, "logs");
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const entry = {
      ...req.body,
      serverTimestamp: new Date().toISOString(),
      ip: req.ip || req.headers["x-forwarded-for"] || "unknown"
    };
    const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}_${(entry.clientName || "unknown").replace(/[^a-zA-Z0-9]/g, "_")}.json`;
    fs.writeFileSync(path.join(logsDir, filename), JSON.stringify(entry, null, 2));
    res.json({ saved: true, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/logs", (req, res) => {
  try {
    const logsDir = path.join(__dirname, "logs");
    if (!fs.existsSync(logsDir)) return res.json([]);
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith(".json")).sort().reverse();
    const logs = files.map(f => {
      try { return { filename: f, ...JSON.parse(fs.readFileSync(path.join(logsDir, f), "utf8")) }; }
      catch (_) { return { filename: f, error: true }; }
    });
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/logs/:filename", (req, res) => {
  try {
    const logPath = path.join(__dirname, "logs", req.params.filename);
    if (!fs.existsSync(logPath)) return res.status(404).json({ error: "Not found" });
    res.json(JSON.parse(fs.readFileSync(logPath, "utf8")));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ───
async function start() {
  await refreshData();
  setInterval(refreshData, REFRESH_INTERVAL);
  console.log(`  ↻ Auto-refresh every 4 hours\n`);

  app.listen(PORT, () => {
    console.log(`  ✦ Indeed Flex Coverage Tool → http://localhost:${PORT}`);
    console.log(`  ✦ Data: ${dataSource} (${Object.keys(cachedTerritories).length} ZIPs)`);
    console.log(`  ✦ States: ${[...cachedStates].sort().join(", ")}`);
    console.log(`\n  /api/status  → data source info`);
    console.log(`  /api/refresh → force Redash pull`);
    console.log(`  /api/logs    → all analysis logs\n`);
  });
}
start();
