// DOM smoke test for the new UI (jsdom; canvas 2d + network stubbed).
// Covers: manual specs -> calculate -> results, compare seed/run/add/clear.
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

// ---- stub browser APIs jsdom lacks ----
const noop = () => {};
const ctxStub = new Proxy({}, { get: () => noop });
window.HTMLCanvasElement.prototype.getContext = () => ctxStub;
window.HTMLCanvasElement.prototype.toDataURL = () => "data:image/png;base64,";
window.HTMLElement.prototype.scrollIntoView = noop;
window.scrollTo = noop;

// ---- stub network before the app loads ----
const fetchStub = async (url) => {
  if (/zippopotam/.test(url)) {
    return { ok: true, json: async () => ({ places: [{ "place name": "Boston", state: "Massachusetts", "state abbreviation": "MA", latitude: "42.3", longitude: "-71.1" }] }) };
  }
  if (/archive-api\.open-meteo/.test(url)) {
    const temps = [];
    for (let d = 0; d < 365; d++) for (let h = 0; h < 24; h++) temps.push(35 + 30 * Math.sin((d / 365) * 2 * Math.PI) - 15 * Math.cos((h / 24) * 2 * Math.PI));
    return { ok: true, json: async () => ({ hourly: { temperature_2m: temps } }) };
  }
  throw new Error("unexpected fetch " + url);
};
global.fetch = fetchStub;
window.fetch = fetchStub;

// ---- load data + app scripts (normally <script src>) ----
function inject(file) {
  const code = fs.readFileSync(path.join(root, file), "utf8");
  new window.Function(code).call(window);
}
inject("data/prices.js");
inject("data/heatpumps.js");
window.Engine = require("../js/engine.js");
inject("js/data.js");
inject("js/app.js");
// jsdom may still be "loading" at inject time; fire init synchronously if so.
if (window.document.readyState === "loading") {
  window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
}

const $ = (id) => window.document.getElementById(id);
const setVal = (id, v) => { $(id).value = v; };
window.addEventListener("error", (e) => console.log("WINDOW ERROR:", (e.error && e.error.stack) || e.message));

(async () => {
  let fail = 0;
  const ok = (c, m) => { console.log((c ? "PASS  " : "FAIL  ") + m); if (!c) fail++; };

  // 1) Manual heat pump entry via the sheet
  $("manualBtn").onclick();
  ok($("sheetManual").hidden === false, "manual sheet opens");
  setVal("m_brand", "Test"); setVal("m_model", "HP1");
  setVal("m_cap47", "24000"); setVal("m_cap17", "17000");
  setVal("m_cop47", "3.2"); setVal("m_cop17", "2.2");
  $("useManualBtn").onclick();
  ok($("sheetManual").hidden === true, "manual sheet closes after valid specs");
  ok($("hpSelected").hidden === false, "selected-unit card shown");
  ok(/Test HP1/.test($("hpSelected").textContent), "selected card names the unit");

  // 2) Calculate end-to-end (stubbed geocode + weather)
  setVal("zip", "02118");
  setVal("afue", "95"); setVal("furnaceBtu", "60000");
  setVal("designLoad", "24000"); setVal("designTemp", "0");
  setVal("indoor", "70");
  setVal("elec", "0.15"); setVal("gas", "2.00");
  await $("calcBtn").onclick();
  ok(window.document.body.dataset.tab === "results", "calculate switches to Results tab");
  ok($("resultsBody").hidden === false, "results body revealed");
  ok(/\u00B0F/.test($("heroValue").textContent), "hero shows a switchover temperature (" + $("heroValue").textContent + ")");
  ok($("annualCard").hidden === false, "annual cost card shown (design load present)");
  ok($("annualBars").querySelectorAll(".abar").length === 3, "annual card compares 3 strategies");

  // 3) Compare: seed from current setup
  window.document.querySelector('.tabbtn[data-tab="compare"]').onclick();
  $("cmpSeedBtn").onclick();
  ok($("scenarioList").querySelectorAll(".scn").length === 3, "seeding builds 3 scenarios");

  // 4) Run comparison
  await $("cmpRunBtn").onclick();
  ok($("compareResults").hidden === false, "compare results revealed after run");
  ok($("cmpRanking").querySelectorAll(".rank-card").length === 3, "ranking has 3 cards");
  ok(/wins at/.test($("cmpRec").textContent), "recommendation text present");

  // 5) Add a second heat pump via the sheet (manual source)
  $("cmpAddBtn").onclick();
  ok($("sheetScenario").hidden === false, "scenario sheet opened");
  setVal("cm_name", "Proposed HP2");
  window.document.querySelector('#cmSrcSeg .seg-btn[data-src="manual"]').onclick();
  ok($("cmManual").hidden === false, "manual fields shown for manual source");
  setVal("cm_brand", "Other"); setVal("cm_model", "HP2");
  setVal("cm_cap47", "28000"); setVal("cm_cap17", "20000");
  setVal("cm_cop47", "2.8"); setVal("cm_cop17", "2.0");
  $("cmAddBtn").onclick();
  ok($("sheetScenario").hidden === true, "sheet closed after add");
  ok($("scenarioList").querySelectorAll(".scn").length === 4, "4 scenarios after add");

  // 6) Invalid manual scenario is rejected
  $("cmpAddBtn").onclick();
  window.document.querySelector('#cmSrcSeg .seg-btn[data-src="manual"]').onclick();
  setVal("cm_cap47", ""); setVal("cm_cap17", ""); setVal("cm_cop47", ""); setVal("cm_cop17", ""); setVal("cm_hspf2", "");
  $("cmAddBtn").onclick();
  ok($("sheetScenario").hidden === false, "invalid specs keep the sheet open");
  ok($("cmStatus").textContent.length > 0, "validation message shown");
  window.document.querySelector('[data-close="sheetScenario"]').onclick();

  // 7) Clear
  $("cmpClearBtn").onclick();
  ok($("scenarioList").querySelectorAll(".scn").length === 0, "scenarios cleared");
  ok($("compareResults").hidden === true, "results hidden after clear");

  console.log(fail === 0 ? "\nALL COMPARE TESTS PASSED" : "\n" + fail + " FAILED");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERROR", e); process.exit(2); });
