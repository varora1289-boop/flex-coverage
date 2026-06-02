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
let cachedHubs = {};
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
  const iLat = col("LATITUDE");
  const iLng = col("LONGITUDE");

  if (iPostcode < 0 || iMarketCov < 0) {
    console.log("  ⚠ Redash CSV missing POSTCODE or MARKET_COVERAGE columns");
    console.log("    Found headers:", header.join(", "));
    return { territories: {}, states: new Set() };
  }

  // Map Redash MARKET_COVERAGE values to our tier codes.
  // We keep all six tiers (including OOC and NC) so that ZIP-level classification
  // wins over the coarser state-level fallback — important when a compliant state
  // contains a mix of OOC and NC ZIPs (e.g. PA, OH, TX).
  const tierMap = {
    "CORE MARKET": "core",
    "ADJACENT MARKET": "adj",
    "SEGMENTED MARKET": "seg",
    "EXPANSION MARKET": "exp",
    "OUT OF COVERAGE": "ooc",
    "NON-COMPLIANT": "nc",
  };

  const territories = {};
  const coreAdjStates = new Set(); // states that have core or adj markets
  const hubAcc = {}; // market -> {sumLat, sumLng, n} for Core Market centroids

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
    const lat = iLat >= 0 ? parseFloat(clean[iLat]) : NaN;
    const lng = iLng >= 0 ? parseFloat(clean[iLng]) : NaN;

    const type = tierMap[coverage];

    if (type) {
      // Core, Adjacent, Segmented, or Expansion — add to territories
      const entry = { market, type };
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        entry.lat = lat;
        entry.lng = lng;
      }
      territories[postcode] = entry;

      // Track which states have core or adjacent markets
      if ((type === "core" || type === "adj") && state.length === 2) {
        coreAdjStates.add(state);
      }

      // Build market hub centroids from Core Market only (these are the actual coverage hubs)
      if (type === "core" && market && Number.isFinite(lat) && Number.isFinite(lng)) {
        if (!hubAcc[market]) hubAcc[market] = { sumLat: 0, sumLng: 0, n: 0 };
        hubAcc[market].sumLat += lat;
        hubAcc[market].sumLng += lng;
        hubAcc[market].n += 1;
      }
    }
    // Out of Coverage and Non-compliant are handled by state fallback
  }

  // Compute centroid lat/lng per Core Market name
  const hubs = {};
  for (const [m, a] of Object.entries(hubAcc)) {
    if (a.n > 0) {
      hubs[m] = { lat: a.sumLat / a.n, lng: a.sumLng / a.n, count: a.n };
    }
  }

  return { territories, states: coreAdjStates, hubs };
}

// ─── Load from local CSV (fallback) ───
function loadLocalTerritories() {
  // Prefer the full CSV (zip,market,tier,state,lat,lng) when present — bundled in the repo.
  // Falls back to the legacy compact CSV (zip,market,tier).
  const fullPath = path.join(__dirname, "data", "territories_full.csv");
  const legacyPath = path.join(__dirname, "data", "territories.csv");
  const csvPath = fs.existsSync(fullPath) ? fullPath : legacyPath;
  const csv = fs.readFileSync(csvPath, "utf8");
  const lines = csv.trim().split("\n");
  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const idx = name => header.indexOf(name);
  const iZip = idx("zip"), iMarket = idx("market"), iTier = idx("tier"),
        iState = idx("state"), iLat = idx("lat"), iLng = idx("lng");

  const territories = {};
  const coreAdjStates = new Set();
  const hubAcc = {};

  for (let i = 1; i < lines.length; i++) {
    // Handle quoted market field (in full CSV); legacy CSV is unquoted.
    const vals = (lines[i].match(/(".*?"|[^,]*)/g) || []).filter(v => v !== "");
    if (vals.length < 3) continue;
    const clean = vals.map(v => v.replace(/^"|"$/g, "").trim());

    const zip = (clean[iZip] || "").replace(/\D/g, "").padStart(5, "0");
    if (zip.length !== 5 || zip === "00000") continue;
    const market = clean[iMarket] || "";
    const tier = (clean[iTier] || "").toLowerCase();
    if (!tier) continue;

    const state = iState >= 0 ? (clean[iState] || "").toUpperCase() : "";
    const lat = iLat >= 0 ? parseFloat(clean[iLat]) : NaN;
    const lng = iLng >= 0 ? parseFloat(clean[iLng]) : NaN;

    // Keep all six tiers so per-ZIP lookup wins over coarse state fallback
    if (!["core","adj","seg","exp","ooc","nc"].includes(tier)) continue;

    const entry = { market, type: tier };
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      entry.lat = lat;
      entry.lng = lng;
    }
    territories[zip] = entry;

    if ((tier === "core" || tier === "adj") && state.length === 2) {
      coreAdjStates.add(state);
    }
    if (tier === "core" && market && Number.isFinite(lat) && Number.isFinite(lng)) {
      if (!hubAcc[market]) hubAcc[market] = { sumLat: 0, sumLng: 0, n: 0 };
      hubAcc[market].sumLat += lat;
      hubAcc[market].sumLng += lng;
      hubAcc[market].n += 1;
    }
  }

  const hubs = {};
  for (const [m, a] of Object.entries(hubAcc)) {
    if (a.n > 0) hubs[m] = { lat: a.sumLat / a.n, lng: a.sumLng / a.n, count: a.n };
  }

  return { territories, states: coreAdjStates, hubs, sourceFile: path.basename(csvPath) };
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
  // Try Redash first (only works on networks that can reach flex-redash.indeed.tech)
  try {
    console.log("  ↻ Fetching territory data from Redash...");
    const csv = await fetchURL(REDASH_CSV_URL);
    const result = parseRedashCSV(csv);
    const count = Object.keys(result.territories).length;

    if (count > 100) {
      cachedTerritories = result.territories;
      cachedHubs = result.hubs || {};
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
      console.log(`  ✓ ${Object.keys(cachedHubs).length} Core Market hubs (centroids)`);
      console.log(`  ✓ ${cachedStates.size} compliant states (${[...cachedStates].sort().join(", ")})`);

      // Save backup
      try {
        const rows = ["zip,market,tier,lat,lng"];
        for (const [zip, data] of Object.entries(result.territories)) {
          rows.push(`${zip},${data.market},${data.type},${data.lat ?? ""},${data.lng ?? ""}`);
        }
        fs.writeFileSync(path.join(__dirname, "data", "territories_redash_backup.csv"), rows.join("\n"));
      } catch (_) {}
      return;
    } else {
      console.log(`  ⚠ Redash returned only ${count} records, falling back to bundled CSV`);
    }
  } catch (err) {
    console.log(`  ⚠ Redash unavailable (${err.message}), falling back to bundled CSV`);
  }

  // Fallback — bundled territories_full.csv (zip,market,tier,state,lat,lng) or legacy territories.csv
  try {
    const result = loadLocalTerritories();
    cachedTerritories = result.territories;
    cachedHubs = result.hubs || {};
    try {
      const localStates = loadCompliantStates();
      cachedStates = new Set([...(result.states || []), ...localStates]);
    } catch (_) {
      cachedStates = result.states || new Set();
    }
    dataSource = `Bundled CSV (${result.sourceFile || "fallback"})`;
    lastRefresh = new Date().toISOString();
    console.log(`  ✓ Loaded ${Object.keys(cachedTerritories).length} ZIP territories from ${result.sourceFile}`);
    console.log(`  ✓ ${Object.keys(cachedHubs).length} Core Market hubs (centroids)`);
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
    marketHubs: cachedHubs,
    dataSource, lastRefresh,
    zipCount: Object.keys(cachedTerritories).length,
    hubCount: Object.keys(cachedHubs).length
  });
});

app.get("/api/refresh", async (req, res) => {
  await refreshData();
  res.json({
    message: "Data refreshed", dataSource, lastRefresh,
    zipCount: Object.keys(cachedTerritories).length,
    hubCount: Object.keys(cachedHubs).length,
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

// Forward analysis log to an external Google Apps Script "doPost" web app, if configured.
// Set SHEETS_WEBHOOK_URL on Render to make every analysis append a row to a Google Sheet
// (deploy https://script.google.com web app, paste URL into env var). Failures are non-fatal.
function forwardToSheetWebhook(entry) {
  const url = process.env.SHEETS_WEBHOOK_URL;
  if (!url) return;
  try {
    const u = new URL(url);
    const body = JSON.stringify({
      date: entry.serverTimestamp || new Date().toISOString(),
      salesRep: entry.requester || "",
      clientName: entry.clientName || "",
      clientStatus: entry.clientStatus || "",
      goLive: entry.goLive || "",
      total: entry.total || 0,
      core: entry.core || 0,
      adjacent: entry.adjacent || 0,
      segmented: entry.segmented || 0,
      expansion: entry.expansion || 0,
      outOf: entry.outOf || 0,
      nonComp: entry.nonComp || 0,
      totalSpend: entry.totalSpend || 0,
      serviceablePct: entry.total ? Math.round(((entry.core || 0) + (entry.adjacent || 0)) / entry.total * 100) : 0,
      analysisId: entry.id || "",
    });
    const opts = {
      method: "POST",
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    };
    const client = u.protocol === "https:" ? https : http;
    const req = client.request(opts, (resp) => {
      // Apps Script returns 302 → follow once
      if (resp.statusCode === 302 && resp.headers.location) {
        client.get(resp.headers.location, () => {}).on("error", () => {});
      }
      resp.on("data", () => {}); resp.on("end", () => {});
    });
    req.on("error", (err) => console.log("  ⚠ Sheet webhook error:", err.message));
    req.write(body);
    req.end();
  } catch (err) {
    console.log("  ⚠ Sheet webhook setup error:", err.message);
  }
}

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
    // Best-effort: forward to a Google Sheets Apps Script webhook (if configured).
    forwardToSheetWebhook(entry);
    res.json({ saved: true, filename, forwarded: !!process.env.SHEETS_WEBHOOK_URL });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Lightweight summary of all logs (no per-location results) — used by the All Analyses page.
app.get("/api/logs/summary", (req, res) => {
  try {
    const logsDir = path.join(__dirname, "logs");
    if (!fs.existsSync(logsDir)) return res.json([]);
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith(".json")).sort().reverse();
    const out = files.map(f => {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(logsDir, f), "utf8"));
        return {
          filename: f,
          id: e.id || null,
          date: e.serverTimestamp || e.date || null,
          displayDate: e.date || "",
          salesRep: e.requester || "",
          clientName: e.clientName || "",
          clientStatus: e.clientStatus || "",
          goLive: e.goLive || "",
          total: e.total || 0,
          core: e.core || 0,
          adjacent: e.adjacent || 0,
          segmented: e.segmented || 0,
          expansion: e.expansion || 0,
          outOf: e.outOf || 0,
          nonComp: e.nonComp || 0,
          totalSpend: e.totalSpend || 0,
          serviceablePct: e.total ? Math.round(((e.core || 0) + (e.adjacent || 0)) / e.total * 100) : 0,
        };
      } catch (_) { return { filename: f, error: true }; }
    });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CSV export of all logged analyses (one row per analysis), for import into Google Sheets/Excel.
app.get("/api/logs.csv", (req, res) => {
  try {
    const logsDir = path.join(__dirname, "logs");
    const header = ["Date","Sales Rep","Client","Client Status","Go-Live","Total Locations","Core","Adjacent","Segmented","Expansion","Out of Coverage","Non-compliant","Serviceable %","Total Spend ($)","Analysis ID"];
    const lines = [header.map(q).join(",")];
    if (fs.existsSync(logsDir)) {
      const files = fs.readdirSync(logsDir).filter(f => f.endsWith(".json")).sort().reverse();
      for (const f of files) {
        try {
          const e = JSON.parse(fs.readFileSync(path.join(logsDir, f), "utf8"));
          const svc = e.total ? Math.round(((e.core || 0) + (e.adjacent || 0)) / e.total * 100) : 0;
          lines.push([
            e.serverTimestamp || e.date || "",
            e.requester || "",
            e.clientName || "",
            e.clientStatus || "",
            e.goLive || "",
            e.total || 0, e.core || 0, e.adjacent || 0, e.segmented || 0, e.expansion || 0, e.outOf || 0, e.nonComp || 0,
            svc, e.totalSpend || 0, e.id || ""
          ].map(q).join(","));
        } catch (_) {}
      }
    }
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="flex-coverage-history-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(lines.join("\n"));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Tiny CSV-escape helper for the routes above.
function q(v) {
  if (v == null) return "";
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

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
