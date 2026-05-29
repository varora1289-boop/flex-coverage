#!/usr/bin/env node
// Builds data/territories_full.csv from a raw Redash JSON dump.
// Usage: node scripts/build-territories-csv.js [path-to-redash-json]
const fs = require("fs");
const path = require("path");

const SRC = process.argv[2] || path.join(__dirname, "..", "redash-source.json");
const OUT = path.join(__dirname, "..", "data", "territories_full.csv");

if (!fs.existsSync(SRC)) {
  console.error("Source JSON not found:", SRC);
  process.exit(1);
}

console.log("Reading", SRC, "...");
const raw = JSON.parse(fs.readFileSync(SRC, "utf8"));
const rows = raw?.query_result?.data?.rows;
if (!Array.isArray(rows)) {
  console.error("Unexpected JSON shape — no query_result.data.rows array");
  process.exit(2);
}
console.log("  rows:", rows.length.toLocaleString());

const tierMap = {
  "CORE MARKET": "core",
  "ADJACENT MARKET": "adj",
  "SEGMENTED MARKET": "seg",
  "EXPANSION MARKET": "exp",
  "OUT OF COVERAGE": "ooc",
  "NON-COMPLIANT": "nc",
};

const out = ["zip,market,tier,state,lat,lng"];
let kept = 0, skipped = 0;
const seenZip = new Set();

for (const r of rows) {
  const country = (r.COUNTRY || "").toUpperCase().trim();
  if (country !== "US") { skipped++; continue; } // server only handles US for now
  const rawZip = r.POSTCODE != null ? String(r.POSTCODE) : "";
  const zip = rawZip.replace(/\D/g, "").padStart(5, "0");
  if (zip.length !== 5 || zip === "00000") { skipped++; continue; }
  const cov = (r.MARKET_COVERAGE || "").toUpperCase().trim();
  const tier = tierMap[cov];
  if (!tier) { skipped++; continue; }
  if (seenZip.has(zip)) { skipped++; continue; } // dedupe
  seenZip.add(zip);
  const market = (r.MARKET || "").replace(/[",\r\n]/g, " ").trim();
  const state = (r.STATE_ABREVIATION || r.STATE || "").toUpperCase().trim().slice(0, 2);
  const lat = Number.isFinite(+r.LATITUDE) ? Number(r.LATITUDE).toFixed(4) : "";
  const lng = Number.isFinite(+r.LONGITUDE) ? Number(r.LONGITUDE).toFixed(4) : "";
  out.push(`${zip},"${market}",${tier},${state},${lat},${lng}`);
  kept++;
}

fs.writeFileSync(OUT, out.join("\n"));
const sizeMB = (fs.statSync(OUT).size / 1024 / 1024).toFixed(2);
console.log(`  kept: ${kept.toLocaleString()} rows  |  skipped: ${skipped.toLocaleString()}`);
console.log(`  wrote: ${OUT} (${sizeMB} MB)`);
