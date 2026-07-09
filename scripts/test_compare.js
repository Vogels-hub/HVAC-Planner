// DOM smoke test for the Compare UI (Step 4). Uses jsdom; stubs canvas 2d ctx.
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.com/" });
const { window } = dom;
global.window = window;
global.document = window.document;
global.localStorage = window.localStorage;

// ---- stub canvas 2d context (jsdom has no canvas) ----
const noop = () => {};
const ctxStub = new Proxy({}, { get: (t, p) => (p === "setTransform" || typeof p === "string" ? noop : noop) });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLElement.prototype.scrollIntoView = () => {}; // jsdom lacks this; browsers have it

// ---- expose bundled data + prices as globals (normally <script src>) ----
function inject(file) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  const fn = new window.Function(code);
  fn.call(window);
}
inject("data/prices.js");
inject("data/heatpumps.js");
const A = require("../app.js"); // runs the IIFE; init() attaches handlers on DOMContentLoaded
window.document.dispatchEvent(new window.Event("DOMContentLoaded")); // fire init synchronously for the test

const $ = (id) => window.document.getElementById(id);
function setVal(id, v) { const el = $(id); el.value = v; }

(async () => {
  let fail = 0;
  const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fail++; };

  // 1) Manual heat pump entry
  setVal("m_brand", "Test"); setVal("m_model", "HP1");
  setVal("m_cap47", "24000"); setVal("m_cap17", "17000");
  setVal("m_cop47", "3.2"); setVal("m_cop17", "2.2");
  setVal("afue", "0.95"); setVal("furnaceBtu", "60000");
  setVal("designLoad", "24000"); setVal("designTemp", "0");
  setVal("indoor", "70");
  window.addEventListener("error", (e) => console.log("WINDOW ERROR:", e.error && e.error.stack || e.message));
  $("useManualBtn").click();

  // 2) Seed current-system comparison
  $("cmpSeedBtn").click();
  const scn = $("scenarioList").querySelectorAll(".scn");
  ok(scn.length === 3, "seedCurrentSystem built 3 scenarios (got " + scn.length + ")");

  // 3) Run comparison (uses built-in weather/geocode -> network). Stub fetch to avoid net.
  //    Replace geocode/fetchWeather via monkeypatch is hard (inside closure); instead
  //    provide currentWeather/currentParams by running doCalculate with stubbed fetch.
  const fetchStub = async (url) => {
    if (/zippopotam/.test(url)) return { ok: true, json: async () => ({ places: [{ "place name": "Boston", state: "Massachusetts", "state abbreviation": "MA", latitude: "42.3", longitude: "-71.1" }] }) };
    if (/archive-api\.open-meteo/.test(url)) {
      const temps = [];
      for (let d = 0; d < 365; d++) for (let h = 0; h < 24; h++) temps.push(35 + 30 * Math.sin((d / 365) * 2 * Math.PI) - 15 * Math.cos((h / 24) * 2 * Math.PI));
      return { ok: true, json: async () => ({ hourly: { temperature_2m: temps } }) };
    }
    throw new Error("unexpected fetch " + url);
  };
  global.fetch = fetchStub;
  window.fetch = fetchStub;
  setVal("zip", "02118");
  setVal("elec", "0.15"); setVal("gas", "2.00");
  await $("calcBtn").onclick();   // doCalculate is async; await it
  await $("cmpRunBtn").onclick(); // runComparison is async; await it

  ok($("compareResults").hidden === false, "compare results revealed after run");
  const rows = $("cmpTableBody").querySelectorAll("tr");
  ok(rows.length === 3, "comparison table has 3 rows (got " + rows.length + ")");
  const rec = $("cmpRec").textContent;
  ok(/lowest-cost option/.test(rec), "recommendation text present");

  // 4) Add a second heat pump via modal (manual)
  $("cmpAddBtn").click();
  ok($("cmpModal").hidden === false, "compare modal opened");
  setVal("cm_name", "Proposed HP2");
  const manualRadio = window.document.querySelector('input[name="cm_src"][value="manual"]');
  manualRadio.checked = true;
  manualRadio.dispatchEvent(new window.Event("change"));
  ok($("cmManual").hidden === false, "manual fields shown when manual radio selected");
  setVal("cm_brand", "Other"); setVal("cm_model", "HP2");
  setVal("cm_cap47", "28000"); setVal("cm_cap17", "20000");
  setVal("cm_cop47", "2.8"); setVal("cm_cop17", "2.0");
  $("cmAdd").click();
  ok($("cmpModal").hidden === true, "modal closed after add");
  ok($("scenarioList").querySelectorAll(".scn").length === 4, "4 scenarios after add");

  // 5) Clear
  $("cmpClearBtn").click();
  ok($("scenarioList").querySelectorAll(".scn").length === 0, "scenarios cleared");
  ok($("compareResults").hidden === true, "results hidden after clear");

  console.log(fail === 0 ? "\nALL COMPARE TESTS PASSED" : "\n" + fail + " FAILED");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
