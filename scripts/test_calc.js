// Node sanity test for the calculation engine in app.js (no DOM needed).
const C = require("../js/engine.js");

function approx(name, v, lo, hi) {
  const ok = isFinite(v) && v >= lo && v <= hi;
  console.log((ok ? "PASS" : "FAIL") + "  " + name + " = " + (Math.round(v * 100) / 100));
  if (!ok) process.exitCode = 1;
}

// Synthetic year of hourly outdoor temps (deterministic).
function makeWeather() {
  const temps = [];
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 8760; i++) {
    // seasonal sinusoid + noise, centered ~50F, range ~ -10..75
    const day = i / 24;
    const base = 50 - 32 * Math.cos((day / 365) * 2 * Math.PI);
    temps.push(Math.round((base + (rnd() - 0.5) * 30) * 10) / 10);
  }
  return { temps, year: 2024, p1cold: -5, min: -12, max: 92, avg: 52, hdd65: 8000 };
}

const spec = {
  brand: "LENNOX", model: "SL25XPV-024", modelSeries: "Signature",
  cap47: 22000, cap17: 15840, cap5: 16900, cop5: 2.0, hspf2: 9.0,
  lockout: NaN, refrigerant: "R-410A", ahri: "123", source: "test"
};

const params = { indoor: 70, afue: 0.95, designLoad: 30000, designTemp: 0, elec: 0.15, gas: 1.40, copOverride: {} };

console.log("== COP curve ==");
const copFn = C.buildCOPCurve(spec, {});
approx("COP@47", copFn(47), 3.4, 3.8);
approx("COP@17", copFn(17), 2.3, 2.7);
approx("COP@5", copFn(5), 1.9, 2.1);
approx("COP@-10 (>=1)", copFn(-10), 1.0, 2.0);

console.log("== Capacity curve ==");
const capFn = C.buildCapacityCurve(spec);
approx("cap@47", capFn(47), 21000, 23000);
approx("cap@17", capFn(17), 15000, 16500);
approx("cap@5", capFn(5), 16000, 17500);

console.log("== Economic break-even ==");
const be = C.economicBreakEven(copFn, params.elec, params.gas, params.afue);
console.log("  mode =", be.mode, " temp =", be.temp);
approx("break-even COP req", be.copReq, 2.8, 3.1);
if (be.mode === "normal") approx("break-even temp (F)", be.temp, 20, 40);
else { console.log("FAIL  expected normal mode"); process.exitCode = 1; }

console.log("== Capacity balance point ==");
const UA = params.designLoad / (params.indoor - params.designTemp);
const capBP = C.capacityBalancePoint(capFn, UA, params.indoor);
approx("capacity BP (F)", capBP, -10, 40);

console.log("== Full analyze ==");
const w = makeWeather();
const R = C.analyze(spec, w, params);
console.log("  setpointMode =", R.setpointMode, " setpointTemp =", R.setpointTemp);
approx("annual dual cost ($)", R.annual.dualCost, 500, 5000);
approx("annual furnace cost ($)", R.annual.furnaceCost, 500, 6000);
approx("annual hp-only cost ($)", R.annual.hpCost, 500, 8000);
console.log("  hoursBelow =", Math.round(R.annual.hoursBelow), "/", R.annual.hoursTotal);
if (R.annual.dualCost <= R.annual.furnaceCost && R.annual.dualCost <= R.annual.hpCost) {
  console.log("PASS  dual is cheapest");
} else { console.log("FAIL  dual not cheapest"); process.exitCode = 1; }

console.log("== normalizeRecord ==");
const rec = { brand: "LENNOX", model_number: "", outdoor_unit_number: "SL25XPV-024-230A**",
  model_series: "SL25XPV", heating_capacity_rated_47: 22000, heating_capacity_max_5: 16900,
  maintenance_capacity_rated17_rated47: 72, cop_max_5: 2.0, hspf_region_iv_2: 9.0,
  lock_out_temp: null, refrigerant: "R-410A" };
const ns = C.normalizeRecord(rec);
console.log("  valid =", C.specValid(ns), " cap17 =", Math.round(ns.cap17));
if (!C.specValid(ns)) { console.log("FAIL  normalize should be valid"); process.exitCode = 1; }

console.log("== afueFromModel (dual-fuel furnace pairing) ==");
const afueCases = [
  ["*96VTN1002122B*", 0.96],   // ICP: standalone 96
  ["926TC66100V21***", 0.92],  // Bryant: 926T family -> 92
  ["GMVC960804CNA", 0.96],     // Goodman: AFUE+capacity concatenated
  ["59TP6C100V21**22", NaN],   // Carrier: no AFUE digits -> safe NaN
  ["TM9V080B12MP11", NaN],     // York: leading-zero capacity run ignored
  ["", NaN]
];
for (const [model, want] of afueCases) {
  const got = C.afueFromModel(model);
  const ok = isNaN(want) ? isNaN(got) : Math.abs(got - want) < 1e-9;
  console.log((ok ? "PASS" : "FAIL") + "  afueFromModel(\"" + model + "\") = " + got);
  if (!ok) process.exitCode = 1;
}
const recDF = { ...rec, furnace_unit_number: "*96VTN1002122B*" };
const nsDF = C.normalizeRecord(recDF);
if (nsDF.furnaceModel === "*96VTN1002122B*" && Math.abs(nsDF.furnaceAfue - 0.96) < 1e-9) {
  console.log("PASS  normalizeRecord carries furnace pairing + parsed AFUE");
} else { console.log("FAIL  furnace pairing not normalized"); process.exitCode = 1; }

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");

// ---------------------------------------------------------------------------
// Manual-entry scenario: only @47 / @17 points provided (no @5), plus real
// COP@47 / COP@17 — exactly the inputs from the Inputs file.
console.log("\n== Manual entry (cap @47/@17, COP @47/@17, no @5) ==");
const mSpec = {
  brand: "Manual", model: "Manual entry", modelSeries: "",
  cap47: 22000, cap17: 15840, cap5: NaN, cop47: 3.5, cop17: 2.4, cop5: NaN, hspf2: 9.0,
  lockout: NaN, source: "Manual entry"
};
if (!C.specValid(mSpec)) { console.log("FAIL  manual spec should be valid"); process.exitCode = 1; }
else console.log("PASS  manual spec valid");
const mCop = C.buildCOPCurve(mSpec, {});
approx("manual COP@47", mCop(47), 3.4, 3.6);
approx("manual COP@17", mCop(17), 2.3, 2.5);
approx("manual COP@5 (extrapolated)", mCop(5), 1.8, 2.2);
const mCap = C.buildCapacityCurve(mSpec);
approx("manual cap@47", mCap(47), 21500, 22500);
approx("manual cap@17", mCap(17), 15500, 16200);
approx("manual cap@5 (extrapolated, < cap@17)", mCap(5), 12000, 15840);
const mR = C.analyze(mSpec, makeWeather(), { ...params });
if (isFinite(mR.setpointTemp)) console.log("PASS  manual setpoint =", mR.setpointTemp);
  else { console.log("FAIL  manual setpoint not finite"); process.exitCode = 1; }

// ---------------------------------------------------------------------------
// Step 1: multi-stage data model + demand-responsive stage selection.
console.log("\n== Multi-stage stages + activeStageForHour ==");

const lowStage = { cap47: 11000, cap17: 8000, cap5: 6000, cop47: 5.0, cop17: 4.0, cop5: 3.0, hspf2: 12, lockout: NaN };
const highStage = { cap47: 22000, cap17: 15840, cap5: 16900, cop47: 3.5, cop17: 2.5, cop5: 2.0, hspf2: 9, lockout: NaN };
C.prepStages({ stages: [lowStage, highStage] });

approx("low stage cap@47", lowStage.capFn(47), 10500, 11500);
approx("low stage cap@17", lowStage.capFn(17), 7500, 8500);
approx("high stage cop@47", highStage.copFn(47), 3.3, 3.7);

// At 40F the low stage delivers ~3.0kW, high stage ~6.0kW. activeStageForHour
// must return the LOWEST stage that meets the hourly demand.
const Tsel = 40;
const lowCapKW = lowStage.capFn(Tsel) / C.BTU_PER_KWH;
const highCapKW = highStage.capFn(Tsel) / C.BTU_PER_KWH;
console.log("  capKW @40F low=" + lowCapKW.toFixed(2) + " high=" + highCapKW.toFixed(2));
if (C.activeStageForHour(1.0, Tsel, [lowStage, highStage]) === lowStage) console.log("PASS  picks low stage when adequate");
else { console.log("FAIL  should pick low stage"); process.exitCode = 1; }
if (C.activeStageForHour(4.0, Tsel, [lowStage, highStage]) === highStage) console.log("PASS  steps up when low inadequate");
else { console.log("FAIL  should step to high stage"); process.exitCode = 1; }
if (C.activeStageForHour(9.0, Tsel, [lowStage, highStage]) === highStage) console.log("PASS  returns highest when none adequate");
else { console.log("FAIL  should return highest stage"); process.exitCode = 1; }

// Bounds: demand-responsive 2-stage cost must be <= each single-stage cost
// (it never falls back to resistance, and prefers the cheaper low stage).
function stageAnnualCost(stages, weather, p) {
  C.prepStages({ stages: stages });
  const UA = p.designLoad / (p.indoor - p.designTemp);
  let cost = 0;
  for (const T of weather.temps) {
    if (T >= p.indoor) continue;
    const demandKWh = UA * (p.indoor - T) / C.BTU_PER_KWH;
    const st = C.activeStageForHour(demandKWh, T, stages);
    const capKW = st.capFn(T) / C.BTU_PER_KWH;
    const hpDeliver = Math.min(demandKWh, capKW);
    const hpC = hpDeliver * p.elec / st.copFn(T);
    const resistKWh = demandKWh - hpDeliver;
    cost += hpC + resistKWh * p.elec;
  }
  return cost;
}
const w2 = makeWeather();
const lowOnly = stageAnnualCost([lowStage], w2, params);
const highOnly = stageAnnualCost([highStage], w2, params);
const twoStage = stageAnnualCost([lowStage, highStage], w2, params);
console.log("  lowOnly=$" + Math.round(lowOnly) + " highOnly=$" + Math.round(highOnly) + " twoStage=$" + Math.round(twoStage));
if (twoStage <= lowOnly + 1 && twoStage <= highOnly + 1) console.log("PASS  2-stage cost <= both single-stage costs");
else { console.log("FAIL  2-stage not bounded by single-stage"); process.exitCode = 1; }
if (twoStage < lowOnly) console.log("PASS  2-stage cheaper than low-only (no resistance penalty)");
  else { console.log("FAIL  2-stage not cheaper than low-only"); process.exitCode = 1; }

// ---------------------------------------------------------------------------
// Step 2: scenario engine with dual / hp-only / furnace-only modes.
console.log("\n== Scenario engine (dual / hp / furnace) ==");

// furnace-only: 100% gas, dualCost == furnaceCost, no HP therms
const furScn = { name: "Furnace only", stages: [highStage], backup: "furnace", furnace: { afue: 0.95 } };
const Rf = C.analyzeScenario(furScn, makeWeather(), params);
console.log("  furnace dual=$" + Math.round(Rf.annual.dualCost) + " therm=" + Math.round(Rf.annual.dualTherm));
if (Math.abs(Rf.annual.dualCost - Rf.annual.furnaceCost) < 1) console.log("PASS  furnace-only: dual == furnace cost");
else { console.log("FAIL  furnace dual != furnace"); process.exitCode = 1; }
if (Rf.annual.dualKWh < 1) console.log("PASS  furnace-only: no electric heat (HP/resistance)");
else { console.log("FAIL  furnace used electric heat"); process.exitCode = 1; }
if (Rf.setpointMode === "furnace_always") console.log("PASS  furnace mode flagged");
else { console.log("FAIL  furnace mode not flagged"); process.exitCode = 1; }

// hp-only: no gas at all
const hpScn = { name: "HP only", stages: [highStage], backup: "hp", furnace: { afue: 0.95 } };
const Rh = C.analyzeScenario(hpScn, makeWeather(), params);
console.log("  hp-only dual=$" + Math.round(Rh.annual.dualCost) + " kWh=" + Math.round(Rh.annual.dualKWh));
if (Math.abs(Rh.annual.dualCost - Rh.annual.hpCost) < 1) console.log("PASS  hp-only: dual == hp cost");
else { console.log("FAIL  hp dual != hp"); process.exitCode = 1; }
if (Rh.annual.dualTherm < 1) console.log("PASS  hp-only: no gas therms");
else { console.log("FAIL  hp used gas"); process.exitCode = 1; }

// dual (single stage) must reproduce the legacy analyze() result
const legacySpec = { brand: "X", model: "Y", cap47: 22000, cap17: 15840, cap5: 16900, cop5: 2.0, hspf2: 9.0, lockout: NaN };
C.prepStages(legacySpec);
const Rlegacy = C.analyze(legacySpec, makeWeather(), params);
const dualScn = { name: "Dual", stages: legacySpec.stages, backup: "dual", furnace: { afue: params.afue } };
const Rd = C.analyzeScenario(dualScn, makeWeather(), params);
if (Math.abs(Rlegacy.annual.dualCost - Rd.annual.dualCost) < 1) console.log("PASS  dual scenario == legacy analyze");
else { console.log("FAIL  dual != legacy (" + Math.round(Rlegacy.annual.dualCost) + " vs " + Math.round(Rd.annual.dualCost) + ")"); process.exitCode = 1; }

// 2-stage dual: finite, positive cost
const twoScn = { name: "2-stage dual", stages: [lowStage, highStage], backup: "dual", furnace: { afue: 0.95 } };
const R2 = C.analyzeScenario(twoScn, makeWeather(), params);
if (isFinite(R2.annual.dualCost) && R2.annual.dualCost > 0) console.log("PASS  2-stage dual cost = $" + Math.round(R2.annual.dualCost));
  else { console.log("FAIL  2-stage dual cost invalid"); process.exitCode = 1; }

// ---------------------------------------------------------------------------
// Step 3: specValid is stage-aware (stage 1 required, stage 2 complete-or-absent).
console.log("\n== specValid (stage-aware) ==");
const twoOk = { brand: "A", model: "B", stages: [
  { cap47: 22000, cap17: 15840, cop47: 3.5, cop17: 2.4 },
  { cap47: 28000, cap17: 20000, cop47: 2.8, cop17: 2.0 }
] };
if (C.specValid(twoOk)) console.log("PASS  2-stage spec valid");
else { console.log("FAIL  2-stage spec should be valid"); process.exitCode = 1; }

const twoBad = { brand: "A", model: "B", stages: [
  { cap47: 22000, cap17: 15840, cop47: 3.5, cop17: 2.4 },
  { cap47: 28000, cap17: 20000 } // stage 2 missing COP
] };
if (!C.specValid(twoBad)) console.log("PASS  2-stage with incomplete stage 2 rejected");
else { console.log("FAIL  incomplete stage 2 accepted"); process.exitCode = 1; }

const oneOk = { cap47: 22000, cap17: 15840, cop47: 3.5, cop17: 2.4 }; // legacy flat form
if (C.specValid(oneOk)) console.log("PASS  legacy flat spec valid");
else { console.log("FAIL  legacy flat spec rejected"); process.exitCode = 1; }

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");

// ---------------------------------------------------------------------------
// Energy accounting: kWh columns are ELECTRICITY consumed (input), therm
// columns are FUEL INPUT (AFUE included) — so cost must equal quantity × price.
console.log("\n== Energy accounting (electricity in, fuel in) ==");

const wE = makeWeather();

// 1. hp-only: hpCost == hpKWh × elec price (kWh is electricity in, not heat out)
const eHp = C.analyzeScenario({ name: "HP only", stages: [highStage], backup: "hp", furnace: { afue: 0.95 } }, wE, params);
const eHpExpect = eHp.annual.hpKWh * params.elec;
approx("hp-only: hpCost == hpKWh × $/kWh ($)", eHp.annual.hpCost, eHpExpect - 1, eHpExpect + 1);

// 2. furnace-only: furnaceCost == gasTherm × gas price (therms are fuel input incl. AFUE)
const eFur = C.analyzeScenario({ name: "Furnace only", stages: [highStage], backup: "furnace", furnace: { afue: 0.95 } }, wE, params);
const eFurExpect = eFur.annual.gasTherm * params.gas;
approx("furnace-only: furnaceCost == gasTherm × $/therm ($)", eFur.annual.furnaceCost, eFurExpect - 1, eFurExpect + 1);

// 3. dual: dualCost == dualKWh × elec + dualTherm × gas
const eDual = C.analyzeScenario({ name: "Dual", stages: [highStage], backup: "dual", furnace: { afue: 0.95 } }, wE, params);
const eDualExpect = eDual.annual.dualKWh * params.elec + eDual.annual.dualTherm * params.gas;
approx("dual: dualCost == dualKWh × elec + dualTherm × gas ($)", eDual.annual.dualCost, eDualExpect - 1, eDualExpect + 1);

// 4. hp-only: electricity consumed < heat delivered (COP > 1). Total thermal
// demand kWh = Σ UA × (indoor − T) / 3412.142 over hours below indoor.
const uaE = params.designLoad / (params.indoor - params.designTemp);
let demandKWhTotal = 0;
for (const T of wE.temps) if (T < params.indoor) demandKWhTotal += uaE * (params.indoor - T) / 3412.142;
console.log("  hpKWh=" + Math.round(eHp.annual.hpKWh) + " demandKWh=" + Math.round(demandKWhTotal));
if (eHp.annual.hpKWh < demandKWhTotal) console.log("PASS  hp-only: electricity in < thermal demand (COP>1)");
else { console.log("FAIL  hpKWh >= thermal demand — kWh column is not electricity"); process.exitCode = 1; }

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
