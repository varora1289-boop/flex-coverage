// Quick smoke test for the smartParse + classify logic.
// Extracts the relevant chunk of inline JS from public/index.html and runs it
// against the user-reported list. Not used in production.
const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// Find the main inline script (the one without `src=`)
const lines = html.split("\n");
let start = -1, end = -1, depth = 0;
for (let i = 0; i < lines.length; i++) {
  if (start < 0 && lines[i].trim() === "<script>") { start = i + 1; continue; }
  if (start >= 0) {
    if (/^<\/script>/.test(lines[i].trim())) { end = i; break; }
  }
}
if (start < 0 || end < 0) { console.error("Could not locate inline <script>"); process.exit(1); }
let inner = lines.slice(start, end).join("\n");
console.log("Extracted inline script:", inner.length, "chars,", end - start, "lines");
// Hoist all top-level `let` / `const` declarations to globalThis so we can interact with them post-eval.
// Replace the first occurrence of each declaration with a globalThis assignment.
const HOISTED = ["ZM","HUBS","OOC_STATES","STATE_NAMES","STA","TC","SLBL","SMOD","SHEX","HR"];
for (const name of HOISTED) {
  const reLet = new RegExp("\\blet\\s+" + name + "\\b", "g");
  const reConst = new RegExp("\\bconst\\s+" + name + "\\b", "g");
  inner = inner.replace(reLet, "globalThis." + name + " = globalThis." + name + " === undefined ? undefined : globalThis." + name + "; globalThis." + name);
  inner = inner.replace(reConst, "globalThis." + name);
}
// Also hoist the functions we want to call from outside
for (const fname of ["smartParse","classify","normState","cellZip","eZip","findStateInText"]) {
  inner += `\nglobalThis.${fname} = (typeof ${fname} === 'function') ? ${fname} : globalThis.${fname};`;
}

// Stub minimal browser globals
global.window = {};
global.document = {
  addEventListener: () => {},
  getElementById: () => ({ value: "", style: {}, classList: { toggle: () => {} } }),
  querySelectorAll: () => [],
  querySelector: () => null,
};
global.fetch = async () => ({ ok: false });
global.localStorage = { getItem: () => null, setItem: () => {} };
global.location = { origin: "https://test" };
global.requestAnimationFrame = (cb) => cb();
global.URL = { createObjectURL: () => "", revokeObjectURL: () => {} };
global.Blob = function () {};

// Wrap in a function to avoid block-scoping issues, then auto-bind globals.
(0, eval)(inner);

const ZM = globalThis.ZM || {};
const OOC_STATES = globalThis.OOC_STATES || new Set();
// Simulate ZM (territories) and OOC_STATES for classify
const csv = fs.readFileSync(path.join(__dirname, "..", "data", "territories_full.csv"), "utf8");
const csvLines = csv.split("\n");
for (let i = 1; i < csvLines.length; i++) {
  // Simple CSV split (the only quoted field is the second one — market)
  const ln = csvLines[i];
  if (!ln) continue;
  const m = ln.match(/^(\d{5}),"([^"]*)",([a-z]+),([A-Z]*),([0-9.\-]*),([0-9.\-]*)$/);
  if (!m) continue;
  const [, zip, market, tier, state, lat, lng] = m;
  ZM[zip] = { market, type: tier, lat: +lat, lng: +lng };
}
globalThis.ZM = ZM;
// Compliant states from CSV
const cs = fs.readFileSync(path.join(__dirname, "..", "data", "compliant_states.csv"), "utf8");
OOC_STATES.clear();
for (const ln of cs.split("\n").slice(1)) {
  const [st, status] = ln.split(",");
  if (st && status && status.trim().toLowerCase() === "compliant") OOC_STATES.add(st.trim().toUpperCase());
}
globalThis.OOC_STATES = OOC_STATES;
console.log("Loaded", Object.keys(ZM).length, "territories,", OOC_STATES.size, "compliant states");

const userInput = `Arkansas\tJonesboro\t72401\tPost Cereal Manufacturing\t
California\tVisalia\t93291\tPet Food & Treats\t
Georgia\tFitzgerald\t31750\tPeanut Butter & Nut Processing\t
Idaho\tRigby\t83442\tBob Evans Potato Products\t
Illinois\tLansing\t60438\tFoodservice Food Processing\t
Iowa\tBritt\t50423\tMichael Foods Egg Processing\t
Maine\tMars Hill\t4758\tPineland Farms Potato Facility\t
Michigan\tBattle Creek\t49014\tPost Cereal Manufacturing\t
Minnesota\tChaska\t55318\tFoodservice & Egg Processing\t
Nebraska\tBloomfield\t68718\tCommercial Egg Facility\t
Nevada\tSparks\t89431\tWest Coast Cereal Processing\t
New Jersey\tElizabeth\t7201\tFoodservice Product Processing\t
North Carolina\tAsheboro\t27203\tPost Cereal Manufacturing\t
Ohio\tLima\t45804\tBob Evans Sides (Mashed Potatoes)\t
Ohio\tXenia\t45385\tBob Evans Sausage Manufacturing\t
Oregon\tEugene\t97402\tSpecialty Cereal & Granola\t
Pennsylvania\tBloomsburg\t17815\tPet Food Production\t
Pennsylvania\tKlingerstown\t17941\tEgg Processing Plant\t
Pennsylvania\tMeadville\t16335\tPet Food Production\t
Texas\tSulphur Springs\t75482\tBob Evans Refrigerated Sides\t
Utah\tTremonton\t84337\tWest Coast Cereal Plant\t
Washington\tBlaine\t98230\tPremium Nut Butter Plant`;

const rows = globalThis.smartParse(userInput);
const classify = globalThis.classify;
console.log("\nParsed " + rows.length + " rows:\n");
console.log("STATE  ZIP    TIER                  MARKET                 ADDR");
console.log("─────  ─────  ────────────────────  ─────────────────────  ───────────");
for (const r of rows) {
  const nz = String(r.zip || "").replace(/\D/g, "").padStart(5, "0");
  const cl = classify(null, null, nz, r.state);
  const mkt = cl.market || "—";
  const tierPad = (cl.tier || "?").padEnd(20);
  const mktPad = mkt.padEnd(21).slice(0, 21);
  const stPad = (r.state || "??").padEnd(5);
  const addrShort = r.addr.slice(0, 38);
  console.log(`${stPad}  ${nz}  ${tierPad}  ${mktPad}  ${addrShort}`);
}
