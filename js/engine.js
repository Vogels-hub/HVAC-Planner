/* Dual Fuel Optimizer — pure calculation engine.
 * No DOM, no network. Runs in the browser (window.Engine) and Node (module.exports).
 * The math is the load-bearing part of this app: change with tests (scripts/test_calc.js). */
(function (root, factory) {
  var api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.Engine = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";

  // ---------- constants ----------
  var BTU_PER_KWH = 3412.142;     // 1 kWh = 3412 BTU
  var KWH_PER_THERM = 29.3001;    // 1 therm = 29.3 kWh of heat

  // ---------- helpers ----------
  function num(v) {
    if (v === null || v === undefined || v === "") return NaN;
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : NaN;
  }
  function round(v, d) {
    if (!isFinite(v)) return null;
    var f = Math.pow(10, d || 0);
    return Math.round(v * f) / f;
  }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // Furnace model numbers usually encode the AFUE as the leading digits of a
  // digit group: "*96VTN1002122B*" -> 96%, "926TC66100..." -> 92%,
  // "GMVC960804CNA" -> 96% (AFUE + capacity concatenated). Take the first
  // two digits of each digit run — but not when the run starts with 0
  // (that's a capacity code like "080") — and accept the first value in the
  // plausible AFUE range. Returns a fraction (0.80-0.98) or NaN.
  function afueFromModel(model) {
    if (!model) return NaN;
    var m, re = /\d+/g;
    while ((m = re.exec(String(model))) !== null) {
      var run = m[0];
      if (run.length < 2 || run.charAt(0) === "0") continue;
      var v = parseInt(run.slice(0, 2), 10);
      if (v >= 80 && v <= 98) return v / 100;
    }
    return NaN;
  }

  // =====================================================================
  //  NEEP record -> spec
  // =====================================================================
  function normalizeRecord(rec) {
    var cap47 = num(rec.heating_capacity_rated_47);
    var cap5raw = num(rec.heating_capacity_max_5);
    var pct17 = num(rec.maintenance_capacity_rated17_rated47);
    var pct5 = num(rec.maintenance_capacity_5_47);
    var cap17 = (cap47 && pct17) ? cap47 * pct17 / 100 : NaN;
    var cap5 = cap5raw;
    if (!isFinite(cap5) && cap47 && pct5) cap5 = cap47 * pct5 / 100;
    if (!isFinite(cap17) && isFinite(cap5) && cap47) {
      cap17 = lerp(cap5, cap47, (17 - 5) / (47 - 5));
    }
    var hspf2 = num(rec.hspf_region_iv_2) || num(rec.hspf_region_v_2);
    var cop47 = (isFinite(hspf2) && hspf2 > 0) ? hspf2 / 2.5 : NaN;
    var cop17 = (isFinite(cop47) && isFinite(cap17) && isFinite(cap47) && cap47 > 0)
      ? cop47 * (cap17 / cap47) : NaN; // rough COP@17 from capacity ratio
    return {
      brand: rec.brand || "",
      model: rec.model_number || rec.outdoor_unit_number || rec.indoor_unit_number || "",
      modelSeries: rec.model_series || "",
      cap47: cap47, cap17: cap17, cap5: cap5,
      cop47: cop47, cop17: cop17, cop5: num(rec.cop_max_5),
      hspf2: hspf2,
      stages: [{
        cap47: cap47, cap17: cap17, cap5: cap5,
        cop47: cop47, cop17: cop17, cop5: num(rec.cop_max_5),
        hspf2: hspf2, lockout: num(rec.lock_out_temp)
      }],
      lockout: num(rec.lock_out_temp),
      refrigerant: rec.refrigerant || "",
      ahri: rec.ahri_certificate_number || "",
      seer2: num(rec.seer_2),
      furnaceModel: rec.furnace_unit_number || "",
      furnaceAfue: afueFromModel(rec.furnace_unit_number),
      source: "NEEP ASHP DB"
    };
  }

  function stageValid(st) {
    if (!isFinite(st.cap47) || st.cap47 <= 0) return false;
    if (!isFinite(st.cap17) || st.cap17 <= 0) return false;
    return (isFinite(st.cop47) && st.cop47 > 0) ||
           (isFinite(st.cop17) && st.cop17 > 0) ||
           (isFinite(st.cop5) && st.cop5 > 0) ||
           (isFinite(st.hspf2) && st.hspf2 > 0);
  }

  function specValid(s) {
    if (!s) return false;
    // Support both the stage-array form and legacy flat fields.
    var sts = (s.stages && s.stages.length)
      ? s.stages
      : [{ cap47: s.cap47, cap17: s.cap17, cap5: s.cap5,
           cop47: s.cop47, cop17: s.cop17, cop5: s.cop5, hspf2: s.hspf2 }];
    for (var i = 0; i < sts.length; i++) {
      if (!stageValid(sts[i])) return false;
    }
    return true;
  }

  // =====================================================================
  //  CURVES
  // =====================================================================
  // Strict numeric check: unlike the global isFinite(), null/"" do NOT pass.
  // Specs restored from JSON storage carry null where NaN used to be.
  function fin(v) { return typeof v === "number" && isFinite(v); }

  // Piecewise-linear curve from (temp, value) anchors; linear extrapolation
  // outside the known range. Used for both capacity and COP so the manual
  // inputs (which only provide @47 and @17) work without a @5 point.
  function piecewise(anchors, floor) {
    anchors = anchors.filter(function (a) { return fin(a[1]); })
      .sort(function (a, b) { return a[0] - b[0]; });
    if (!anchors.length) return function () { return 0; };
    return function (T) {
      if (T <= anchors[0][0]) {
        if (anchors.length === 1) return Math.max(0, anchors[0][1]);
        var s0 = (anchors[1][1] - anchors[0][1]) / (anchors[1][0] - anchors[0][0]);
        var v = anchors[0][1] + s0 * (T - anchors[0][0]);
        return floor != null ? Math.max(floor, v) : Math.max(0, v);
      }
      var n = anchors.length;
      if (T >= anchors[n - 1][0]) {
        if (n === 1) return Math.max(0, anchors[n - 1][1]);
        var sn = (anchors[n - 1][1] - anchors[n - 2][1]) / (anchors[n - 1][0] - anchors[n - 2][0]);
        var v2 = anchors[n - 1][1] + sn * (T - anchors[n - 1][0]);
        return floor != null ? Math.max(floor, v2) : Math.max(0, v2);
      }
      for (var i = 0; i < n - 1; i++) {
        if (T >= anchors[i][0] && T <= anchors[i + 1][0]) {
          var u = (T - anchors[i][0]) / (anchors[i + 1][0] - anchors[i][0]);
          return lerp(anchors[i][1], anchors[i + 1][1], u);
        }
      }
      return anchors[n - 1][1];
    };
  }

  function buildCapacityCurve(s) {
    var anchors = [[5, s.cap5], [17, s.cap17], [47, s.cap47]];
    return piecewise(anchors, 0);
  }

  function buildCOPCurve(s, ov) {
    ov = ov || {};
    var cop5 = fin(ov.cop5) ? ov.cop5 : s.cop5;
    var cop47 = fin(ov.cop47) ? ov.cop47
      : fin(s.cop47) && s.cop47 > 0 ? s.cop47
      : fin(s.hspf2) && s.hspf2 > 0 ? s.hspf2 / 2.5
      : (fin(cop5) ? cop5 + 1.7 : 2.5);
    var cop17 = fin(ov.cop17) ? ov.cop17 : s.cop17;
    var anchors = [[5, cop5], [17, cop17], [47, cop47]];
    return piecewise(anchors, 1.0);
  }

  // Ensure a spec exposes an array of stage objects, each with precomputed
  // capacity/COP curves. A single-stage unit becomes one element, so all
  // downstream logic can treat every heat pump uniformly as multi-stage.
  function prepStages(spec) {
    if (!spec.stages || !spec.stages.length) {
      spec.stages = [{
        cap47: spec.cap47, cap17: spec.cap17, cap5: spec.cap5,
        cop47: spec.cop47, cop17: spec.cop17, cop5: spec.cop5,
        hspf2: spec.hspf2, lockout: spec.lockout
      }];
    }
    for (var i = 0; i < spec.stages.length; i++) {
      var st = spec.stages[i];
      if (!st.capFn) st.capFn = buildCapacityCurve(st);
      if (!st.copFn) st.copFn = buildCOPCurve(st, {});
    }
    return spec.stages;
  }

  // Demand-responsive stage selection: return the LOWEST stage whose capacity
  // (in kW) at outdoor temp T meets the hourly demand. If no stage can meet
  // the demand, return the highest stage (it delivers what it can; the remainder
  // is covered by backup heat). Stages are assumed ordered low -> high capacity.
  function activeStageForHour(demandKW, T, stages) {
    var best = stages[stages.length - 1];
    for (var i = 0; i < stages.length; i++) {
      if (stages[i].capFn(T) / BTU_PER_KWH >= demandKW) return stages[i];
    }
    return best;
  }

  // =====================================================================
  //  CALCULATIONS
  // =====================================================================
  // COP of heat pump equals required COP -> find outdoor temp where
  // elec/COP(T) == gas/(KWH_PER_THERM*AFUE).
  function economicBreakEven(copFn, elec, gas, afue) {
    var copReq = elec * KWH_PER_THERM * afue / gas; // COP at break-even
    var warm = copFn(70), cold = copFn(-20);
    if (copReq <= cold) return { temp: null, mode: "hp_always" };     // HP cheaper even at coldest
    if (copReq >= warm) return { temp: null, mode: "furnace_always" }; // gas cheaper even at warmest
    // sample and find crossing
    var prevT = 70, prevC = copFn(70) - copReq;
    for (var T = 69.5; T >= -20; T -= 0.5) {
      var cur = copFn(T) - copReq;
      if ((prevC > 0 && cur <= 0) || (prevC < 0 && cur >= 0)) {
        var frac = prevC / (prevC - cur);
        return { temp: round(prevT + (T - prevT) * frac, 1), mode: "normal", copReq: copReq };
      }
      prevT = T; prevC = cur;
    }
    return { temp: null, mode: "normal" };
  }

  function capacityBalancePoint(capFn, UA, Tin) {
    function f(T) { return capFn(T) - UA * (Tin - T); }
    var prevT = Tin, prevF = f(Tin);
    for (var T = Tin - 0.5; T >= -30; T -= 0.5) {
      var cur = f(T);
      if ((prevF > 0 && cur <= 0) || (prevF < 0 && cur >= 0)) {
        var frac = prevF / (prevF - cur);
        return round(prevT + (T - prevT) * frac, 1);
      }
      prevT = T; prevF = cur;
    }
    return null;
  }

  function effectiveAfue(scenario, p) {
    if (scenario.furnace && isFinite(scenario.furnace.afue)) return scenario.furnace.afue;
    return p.afue;
  }

  // Orchestrator for one compared system (scenario). Computes the dual-fuel
  // setpoint (for "dual") or simply runs the HP ("hp") / furnace ("furnace"),
  // then integrates the year. A scenario = { name, stages, backup, furnace }.
  function analyzeScenario(scenario, weather, p) {
    prepStages(scenario);
    var stages = scenario.stages;
    var maxCapFn = stages[stages.length - 1].capFn; // highest stage = limiting capacity
    var UA = null;
    if (isFinite(p.designLoad) && isFinite(p.designTemp) && p.designTemp < p.indoor) {
      UA = p.designLoad / (p.indoor - p.designTemp);
    }

    var be = { mode: "furnace_always", temp: null };
    var capBP = null;
    var setpointTemp = null, setpointMode = "furnace_always";
    var effCopFn = null;
    var usesHP = (scenario.backup === "dual" || scenario.backup === "hp");

    if (usesHP) {
      // Effective COP at each temp = COP of the stage that meets the actual
      // demand at that temp (demand-responsive staging).
      effCopFn = UA ? function (T) {
        var d = UA * (p.indoor - T) / BTU_PER_KWH;
        return activeStageForHour(d, T, stages).copFn(T);
      } : stages[0].copFn;
      be = economicBreakEven(effCopFn, p.elec, p.gas, effectiveAfue(scenario, p));
      if (UA) capBP = capacityBalancePoint(maxCapFn, UA, p.indoor);

      if (scenario.backup === "dual") {
        setpointMode = be.mode;
        if (be.mode === "normal") {
          setpointTemp = isFinite(capBP) ? Math.max(be.temp, capBP) : be.temp;
        } else if (be.mode === "hp_always") {
          setpointTemp = isFinite(capBP) ? capBP : null;
          setpointMode = isFinite(capBP) ? "capacity" : "hp_always";
        }
      } else { // hp only: never uses the furnace
        setpointMode = be.mode;
        setpointTemp = null;
      }
    }

    var annual = null;
    if (UA) {
      annual = integrateScenario(scenario, weather, p, setpointTemp, setpointMode, UA, usesHP);
    }
    return {
      scenario: scenario, stages: stages,
      effCopFn: effCopFn,
      be: be, UA: UA, capBP: capBP,
      setpointTemp: setpointTemp, setpointMode: setpointMode,
      annual: annual
    };
  }

  // Per-hour cost integration for a scenario. "dual" = HP (demand-responsive
  // staging) with furnace backup below the setpoint; "hp" = HP + resistance
  // only (no gas); "furnace" = 100% gas.
  function integrateScenario(scenario, weather, p, setpointTemp, setpointMode, UA, usesHP) {
    var stages = scenario.stages;
    var afue = effectiveAfue(scenario, p);
    var dualCost = 0, hpCost = 0, furnaceCost = 0, hpKWh = 0, gasTherm = 0, dualKWh = 0, dualTherm = 0;
    var hoursBelow = 0, hoursTotal = 0;
    var Temps = weather.temps;
    var backup = scenario.backup;
    for (var j = 0; j < Temps.length; j++) {
      var T = Temps[j];
      if (T >= p.indoor) continue;
      hoursTotal++;
      var demandKWh = UA * (p.indoor - T) / BTU_PER_KWH;
      var furnC = demandKWh * (p.gas / KWH_PER_THERM) / afue;
      furnaceCost += furnC; gasTherm += demandKWh / (KWH_PER_THERM * afue);

      if (backup === "furnace") {
        dualCost += furnC; dualTherm += demandKWh / (KWH_PER_THERM * afue);
        continue;
      }

      // Heat pump (dual or hp-only), demand-responsive stage selection.
      var st = activeStageForHour(demandKWh, T, stages);
      var capKW = st.capFn(T) / BTU_PER_KWH;
      var hpDeliver = Math.min(demandKWh, capKW);
      var resistKWh = demandKWh - hpDeliver;
      var hpElecKWh = hpDeliver / st.copFn(T) + resistKWh; // electricity consumed (input kWh)
      var hpOnly = hpElecKWh * p.elec;                     // HP + electric resistance backup
      hpCost += hpOnly; hpKWh += hpElecKWh;

      var useDual;
      if (backup === "hp") useDual = true;            // no furnace
      else if (setpointMode === "furnace_always") useDual = false;
      else if (setpointTemp === null) useDual = true; // hp always
      else useDual = T >= setpointTemp;

      if (useDual) { dualCost += hpOnly; dualKWh += hpElecKWh; }
      else { dualCost += furnC; dualTherm += demandKWh / (KWH_PER_THERM * afue); }
      if (setpointTemp !== null && T < setpointTemp) hoursBelow++;
    }
    return {
      hpCost: hpCost, furnaceCost: furnaceCost, dualCost: dualCost,
      hpKWh: hpKWh, gasTherm: gasTherm, dualKWh: dualKWh, dualTherm: dualTherm,
      hoursTotal: hoursTotal, hoursBelow: hoursBelow
    };
  }

  // Thin wrapper: a single heat pump + furnace is one "dual" scenario.
  function analyze(spec, weather, p) {
    prepStages(spec);
    spec.stages[0].copFn = buildCOPCurve(spec.stages[0], p.copOverride || {});
    var scenario = {
      name: ((spec.brand || "") + " " + (spec.model || "")).trim() || "Heat pump",
      stages: spec.stages,
      backup: "dual",
      furnace: { afue: p.afue, btu: p.furnaceBtu }
    };
    var R = analyzeScenario(scenario, weather, p);
    return {
      spec: spec,
      capFn: spec.stages[0].capFn,
      copFn: R.effCopFn || spec.stages[0].copFn,
      be: R.be,
      UA: R.UA, capBP: R.capBP,
      setpointTemp: R.setpointTemp, setpointMode: R.setpointMode,
      annual: R.annual,
      scenario: R.scenario
    };
  }

  return {
    BTU_PER_KWH: BTU_PER_KWH, KWH_PER_THERM: KWH_PER_THERM,
    buildCapacityCurve: buildCapacityCurve, buildCOPCurve: buildCOPCurve,
    economicBreakEven: economicBreakEven, capacityBalancePoint: capacityBalancePoint,
    analyze: analyze, analyzeScenario: analyzeScenario, integrateScenario: integrateScenario,
    normalizeRecord: normalizeRecord, specValid: specValid, afueFromModel: afueFromModel,
    prepStages: prepStages, activeStageForHour: activeStageForHour
  };
});
