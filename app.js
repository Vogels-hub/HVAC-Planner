/* Dual Fuel Balance Point - application logic (vanilla JS, no build step). */
(function () {
  "use strict";

  // ---------- constants ----------
  var BTU_PER_KWH = 3412.142;     // 1 kWh = 3412 BTU
  var KWH_PER_THERM = 29.3001;    // 1 therm = 29.3 kWh of heat
  var NEEP_BASE = "https://ashp.neep.org/api/products/";

  // Default proxy used for live NEEP lookups. This is the Cloudflare Worker
  // in /worker (worker/proxy.js), deployed once. It is allowlist-only
  // (ashp.neep.org) and adds open CORS headers, so end users never configure
  // anything. Falls back to the bundled catalog + manual entry if it fails.
  var DEFAULT_PROXY = "https://dualfuel-proxy.dualfuel-balance.workers.dev/";

  // Fallback public CORS proxies (NEEP blocks browser CORS). Unreliable; the
  // app also lets the user supply their own. Live lookup degrades gracefully
  // to the bundled catalog + manual entry if all fail.
  var BUILTIN_PROXIES = [
    "https://api.allorigins.win/raw?url=",
    "https://corsproxy.io/?url=",
    "https://api.codetabs.com/v1/proxy/?quest="
  ];

  // ---------- tiny helpers ----------
  function $(id) { return document.getElementById(id); }
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
  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return "—";
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 0 : d });
  }
  function money(v) {
    if (v === null || !isFinite(v)) return "—";
    return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function lerp(a, b, t) { return a + (b - a) * t; }

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("dfbp_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("dfbp_" + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- state ----------
  var selectedSpec = null;   // current spec used for calculation
  var currentWeather = null; // { temps:[], year, p1cold, min, max, avg, hdd65 }
  var currentParams = null;

  // =====================================================================
  //  GEOCODE: zip -> lat/lon/state
  // =====================================================================
  async function geocodeZip(zip) {
    var r = await fetch("https://api.zippopotam.us/us/" + encodeURIComponent(zip));
    if (!r.ok) throw new Error("Zip not found");
    var d = await r.json();
    var p = d.places && d.places[0];
    if (!p) throw new Error("No place for that zip");
    return {
      zip: zip,
      place: p["place name"],
      state: p.state,
      stateAbbr: p["state abbreviation"],
      lat: parseFloat(p.latitude),
      lon: parseFloat(p.longitude)
    };
  }

  // =====================================================================
  //  WEATHER: Open-Meteo archive, full prior year hourly temps
  // =====================================================================
  async function fetchWeather(lat, lon) {
    var year = new Date().getFullYear() - 1;
    var url = "https://archive-api.open-meteo.com/v1/archive?latitude=" + lat +
      "&longitude=" + lon + "&start_date=" + year + "-01-01&end_date=" + year +
      "-12-31&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=auto";
    var res = await fetch(url);
    if (!res.ok) throw new Error("Weather request failed");
    var d = await res.json();
    var temps = (d.hourly && d.hourly.temperature_2m) || [];
    temps = temps.filter(function (t) { return typeof t === "number" && isFinite(t); });
    if (!temps.length) throw new Error("No weather data returned");
    var min = Math.min.apply(null, temps), max = Math.max.apply(null, temps);
    var sum = temps.reduce(function (a, b) { return a + b; }, 0);
    var avg = sum / temps.length;
    // 1% cold design temp (~exceeded 99% of hours): sort ascending, take index ~1%
    var sorted = temps.slice().sort(function (a, b) { return a - b; });
    var p1cold = sorted[Math.floor(sorted.length * 0.01)];
    // heating degree hours base 65F
    var hdd65 = 0;
    for (var i = 0; i < temps.length; i++) { if (temps[i] < 65) hdd65 += (65 - temps[i]); }
    return { temps: temps, year: year, min: min, max: max, avg: avg, p1cold: p1cold, hdd65: hdd65 };
  }

  // =====================================================================
  //  NEEP LOOKUP (live via proxy) + local bundled catalog
  // =====================================================================
  function proxyFetch(target, proxyUrl, timeoutMs) {
    var sep = proxyUrl.indexOf("?") >= 0 ? "&url=" : "?url=";
    var ctrl = new AbortController();
    var to = setTimeout(function () { ctrl.abort(); }, timeoutMs || 8000);
    return fetch(proxyUrl + sep + encodeURIComponent(target), { signal: ctrl.signal })
      .then(function (r) {
        if (!r.ok) throw new Error("proxy " + r.status);
        return r.json();
      })
      .finally(function () { clearTimeout(to); });
  }

  async function neepLiveSearch(query) {
    var cfg = store.get("settings", {});
    var proxies = [];
    if (DEFAULT_PROXY) proxies.push(DEFAULT_PROXY);
    if (cfg.proxyUrl) proxies.push(cfg.proxyUrl);
    proxies = proxies.concat(BUILTIN_PROXIES);
    var fields = ["outdoor_unit_number", "indoor_unit_number", "model_number", "model_series"];
    var out = {};
    for (var pi = 0; pi < proxies.length; pi++) {
      var proxy = proxies[pi];
      // Run the four field queries in parallel; each aborts after 8s so a
      // dead proxy can never hang the UI.
      var results = await Promise.allSettled(fields.map(function (f) {
        var u = NEEP_BASE + "?" + f + "__icontains=" + encodeURIComponent(query) +
          "&page=1&page_size=100";
        return proxyFetch(u, proxy, 8000);
      }));
      var found = false;
      results.forEach(function (res) {
        if (res.status === "fulfilled" && Array.isArray(res.value)) {
          found = true;
          res.value.forEach(function (r) { if (r && r.id) out[r.id] = r; });
        }
      });
      if (found) break; // first proxy that returns anything wins
    }
    return Object.keys(out).map(function (k) { return out[k]; });
  }

  // Lazy catalog loader: data/heatpumps.js (~630 KB) is no longer parsed at
  // startup; it is injected on first lookup (and precached by the service
  // worker for offline use).
  var catalogPromise = null;
  function loadCatalog() {
    if (window.HEAT_PUMP_DB) return Promise.resolve();
    if (!catalogPromise) {
      catalogPromise = new Promise(function (resolve) {
        var s = document.createElement("script");
        s.src = "data/heatpumps.js";
        s.onload = resolve;
        s.onerror = function () { catalogPromise = null; resolve(); };
        document.head.appendChild(s);
      });
    }
    return catalogPromise;
  }

  function localSearch(query) {
    var q = query.toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!q || !window.HEAT_PUMP_DB) return [];
    return window.HEAT_PUMP_DB.filter(function (r) {
      if (r._hay === undefined) {
        r._hay = [r.model_number, r.outdoor_unit_number, r.indoor_unit_number, r.model_series, r.brand]
          .join(" ").toUpperCase().replace(/[^A-Z0-9]/g, "");
      }
      return r._hay.indexOf(q) >= 0;
    });
  }

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
  // Piecewise-linear curve from (temp, value) anchors; linear extrapolation
  // outside the known range. Used for both capacity and COP so the manual
  // inputs (which only provide @47 and @17) work without a @5 point.
  function piecewise(anchors, floor) {
    anchors = anchors.filter(function (a) { return isFinite(a[1]); })
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
    var cop5 = isFinite(ov.cop5) ? ov.cop5 : s.cop5;
    var cop47 = isFinite(ov.cop47) ? ov.cop47
      : isFinite(s.hspf2) && s.hspf2 > 0 ? s.hspf2 / 2.5
      : (isFinite(cop5) ? cop5 + 1.7 : 2.5);
    var cop17 = isFinite(ov.cop17) ? ov.cop17 : s.cop17;
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

  // Thin wrapper: a single heat pump + furnace is one "dual" scenario. Keeps
  // the legacy result shape so the existing single-result UI keeps working.
  function analyze(spec, weather, p) {
    prepStages(spec);
    spec.stages[0].copFn = buildCOPCurve(spec.stages[0], p.copOverride || {});
    var scenario = {
      name: (spec.brand + " " + spec.model).trim() || "Heat pump",
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

  // =====================================================================
  //  RENDER
  // =====================================================================
  function showError(msg) {
    var b = $("errorBox");
    b.textContent = msg; b.hidden = false;
    b.scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function clearError() { $("errorBox").hidden = true; }

  function renderResults(R, p) {
    clearError();
    $("results").hidden = false;
    var s = R.spec;

    // ---- KPI cards ----
    var bpText, bpClass = "accent";
    if (R.setpointMode === "furnace_always") { bpText = "Gas always cheaper"; bpClass = "warn"; }
    else if (R.setpointMode === "hp_always") { bpText = "Heat pump always"; bpClass = "accent"; }
    else if (R.setpointTemp === null) { bpText = "No switchover"; bpClass = "accent"; }
    else { bpText = round(R.setpointTemp, 1) + "°F"; bpClass = "accent"; }

    var beText;
    if (R.be.mode === "hp_always") beText = "HP always";
    else if (R.be.mode === "furnace_always") beText = "Gas always";
    else beText = round(R.be.temp, 1) + "°F";

    var cards = "";
    cards += kpi("Dual-fuel setpoint", bpText, bpClass);
    cards += kpi("Economic break-even", beText, "blue");
    cards += kpi("Capacity balance pt", isFinite(R.capBP) ? round(R.capBP, 1) + "°F" : "n/a", "warn");
    cards += kpi("Furnace AFUE", round(p.afue * 100, 0) + "%", "");

    var note = "";
    if (isFinite(p.furnaceBtu) && isFinite(p.designLoad) && p.furnaceBtu < p.designLoad) {
      note = "⚠ Furnace output (" + fmt(p.furnaceBtu) + " BTU/h) is below the design heat load (" +
        fmt(p.designLoad) + " BTU/h). It may not keep up at the coldest temperatures even with the heat pump locked out.";
    }

    $("resultCards").innerHTML =
      '<div class="kpis">' + cards + "</div>" +
      (note ? '<p class="note">' + note + "</p>" : "") +
      specTable(s, p) + weatherTable(currentWeather, p);

    drawPerfChart($("perfChart"), R);
    drawCostChart($("costChart"), R, p);

    if (R.annual) {
      $("annualCard").hidden = false;
      $("annualBody").innerHTML = annualTable(R, p);
    } else {
      $("annualCard").hidden = true;
    }
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function kpi(label, value, cls) {
    return '<div class="kpi ' + cls + '"><div class="v">' + value + '</div><div class="l">' + label + "</div></div>";
  }
  function specTable(s, p) {
    function row(l, v) { return "<tr><td>" + l + "</td><td>" + v + "</td></tr>"; }
    var html = '<div class="card"><h2>Heat pump: ' + esc(s.brand + " " + s.model) + "</h2>" +
      "<table>" +
      row("Heating capacity @47°F", fmt(s.cap47) + " BTU/h") +
      row("Heating capacity @17°F", isFinite(s.cap17) ? fmt(s.cap17) + " BTU/h" : "—") +
      row("COP @47°F", isFinite(s.cop47) ? round(s.cop47, 2) : "—") +
      row("COP @17°F", isFinite(s.cop17) ? round(s.cop17, 2) : "—") +
      row("HSPF2", isFinite(s.hspf2) ? round(s.hspf2, 1) : "—") +
      row("Lockout temp", isFinite(s.lockout) ? s.lockout + "°F" : "—") +
      row("Refrigerant", s.refrigerant || "—") +
      row("Source", esc(s.source || "—")) +
      "</table></div>";
    if (p) {
      html += '<div class="card"><h2>Furnace</h2><table>' +
        row("Output capacity", isFinite(p.furnaceBtu) ? fmt(p.furnaceBtu) + " BTU/h" : "—") +
        row("Efficiency (AFUE)", round(p.afue * 100, 0) + "%") +
        "</table></div>";
    }
    return html;
  }
  function weatherTable(w, p) {
    function row(l, v) { return "<tr><td>" + l + "</td><td>" + v + "</td></tr>"; }
    return '<div class="card"><h2>Weather: ' + esc((w.place || "") + ", " + (w.stateAbbr || "")) + "</h2>" +
      "<table>" +
      row("Year used", w.year) +
      row("1% cold design temp", round(w.p1cold, 1) + "°F") +
      row("Annual min / avg", round(w.min, 1) + "°F / " + round(w.avg, 1) + "°F") +
      row("Heating deg-hrs (65°F)", fmt(round(w.hdd65, 0))) +
      row("Indoor setpoint", p.indoor + "°F") +
      "</table></div>";
  }
  function annualTable(R, p) {
    var a = R.annual;
    var best = Math.min(a.hpCost, a.furnaceCost, a.dualCost);
    function r(name, cost, energyStr, isBest) {
      return "<tr" + (isBest ? ' class="best"' : "") + "><td>" + name + "</td><td>" +
        money(cost) + "</td><td>" + energyStr + "</td></tr>";
    }
    var vsFurnace = a.furnaceCost > 0 ? (1 - a.dualCost / a.furnaceCost) * 100 : 0;
    var vsHP = a.hpCost > 0 ? (1 - a.dualCost / a.hpCost) * 100 : 0;
    var note = "Furnace runs when outdoor temp &lt; " +
      (R.setpointTemp === null ? "setpoint" : round(R.setpointTemp, 1) + "°F") +
      " (" + fmt(a.hoursBelow) + " of " + fmt(a.hoursTotal) + " heating hrs/yr). ";
    note += "Dual fuel saves " + round(vsFurnace, 0) + "% vs gas-only and " +
      round(vsHP, 0) + "% vs heat-pump-only (with electric-resistance backup).";
    return "<table>" +
      "<tr><th>Strategy</th><th>Annual cost</th><th>Energy</th></tr>" +
      r("Heat pump only*", a.hpCost, fmt(round(a.hpKWh, 0)) + " kWh", best === a.hpCost) +
      r("Furnace only", a.furnaceCost, fmt(round(a.gasTherm, 0)) + " therm", best === a.furnaceCost) +
      r("Dual fuel (optimal)", a.dualCost, fmt(round(a.dualKWh, 0)) + " kWh + " + fmt(round(a.dualTherm, 0)) + " therm", best === a.dualCost) +
      "</table><p class='hint'>" + note + "</p>" +
      "<p class='hint'>*Heat-pump-only assumes electric-resistance backup when the heat pump can't meet load. " +
      "Estimates only; real savings depend on actual rates, usage and equipment.</p>";
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ---------- canvas charts ----------
  function setupCanvas(cv) {
    var lw = cv.dataset.lw ? +cv.dataset.lw : cv.width;
    var lh = cv.dataset.lh ? +cv.dataset.lh : cv.height;
    cv.dataset.lw = lw; cv.dataset.lh = lh;
    var dpr = window.devicePixelRatio || 1;
    cv.width = lw * dpr; cv.height = lh * dpr;
    cv.style.height = lh + "px";
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: lw, h: lh };
  }

  function drawPerfChart(cv, R) {
    var c = setupCanvas(cv), ctx = c.ctx, w = c.w, h = c.h;
    ctx.clearRect(0, 0, w, h);
    var padL = 46, padR = 42, padT = 14, padB = 28;
    var x0 = -10, x1 = 70;
    function X(T) { return padL + (T - x0) / (x1 - x0) * (w - padL - padR); }
    var stages = (R.spec && R.spec.stages) || [];
    var maxC = 0, maxCop = 6;
    stages.forEach(function (st) {
      for (var t = x0; t <= x1; t += 10) {
        maxC = Math.max(maxC, st.capFn(t));
        maxCop = Math.max(maxCop, st.copFn(t));
      }
    });
    maxC = (maxC || R.spec.cap47 || 1) * 1.1;
    maxCop *= maxCop > 6 ? 1.1 : 1;
    function Yc(v) { return h - padB - v / maxC * (h - padT - padB); }
    function Ycop(v) { return h - padB - v / maxCop * (h - padT - padB); }
    // grid: vertical temp lines + horizontal lines with dual-axis tick labels
    ctx.strokeStyle = "#2a3a32"; ctx.lineWidth = 1;
    ctx.fillStyle = "#9fb3a8"; ctx.font = "10px system-ui";
    for (var T = -10; T <= 70; T += 20) {
      ctx.beginPath(); ctx.moveTo(X(T), padT); ctx.lineTo(X(T), h - padB); ctx.stroke();
      ctx.fillText(T + "°", X(T) - 8, h - 10);
    }
    for (var g = 0; g <= 4; g++) {
      var gy = h - padB - g / 4 * (h - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
      ctx.fillStyle = "#34d399";
      ctx.fillText(Math.round(maxC * g / 4 / 1000) + "k", 6, gy + 3);
      ctx.fillStyle = "#38bdf8";
      ctx.fillText((maxCop * g / 4).toFixed(1), w - padR + 8, gy + 3);
      ctx.fillStyle = "#9fb3a8";
    }
    // capacity + COP for every stage (stage 2+ dashed) so the chart matches
    // the balance-point math, which uses the highest stage.
    stages.forEach(function (st, i) {
      if (i > 0) ctx.setLineDash([6, 4]);
      plot(ctx, X, Yc, st.capFn, x0, x1, "#34d399", i === 0 ? 2.5 : 1.8);
      plot(ctx, X, Ycop, st.copFn, x0, x1, "#38bdf8", i === 0 ? 2.5 : 1.8);
      ctx.setLineDash([]);
    });
    // setpoint marker
    if (R.setpointTemp !== null) {
      ctx.strokeStyle = "#fbbf24"; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(X(R.setpointTemp), padT); ctx.lineTo(X(R.setpointTemp), h - padB); ctx.stroke();
      ctx.setLineDash([]);
    }
    // legend
    ctx.fillStyle = "#34d399";
    ctx.fillText("Capacity (BTU/h)" + (stages.length > 1 ? " — stage 2 dashed" : ""), padL + 4, padT + 2);
    ctx.fillStyle = "#38bdf8"; ctx.fillText("COP", w - padR - 36, padT + 2);
  }

  function drawCostChart(cv, R, p) {
    var c = setupCanvas(cv), ctx = c.ctx, w = c.w, h = c.h;
    ctx.clearRect(0, 0, w, h);
    var padL = 46, padR = 14, padT = 14, padB = 28;
    var x0 = -10, x1 = 70;
    function X(T) { return padL + (T - x0) / (x1 - x0) * (w - padL - padR); }
    var furnCost = (p.gas / KWH_PER_THERM) / p.afue; // $/kWh heat, constant
    function hpCostFn(T) { return p.elec / R.copFn(T); }
    var maxY = Math.max(hpCostFn(x0), furnCost) * 1.15;
    function Y(v) { return h - padB - v / maxY * (h - padT - padB); }
    ctx.strokeStyle = "#2a3a32"; ctx.lineWidth = 1; ctx.fillStyle = "#9fb3a8"; ctx.font = "10px system-ui";
    for (var T = -10; T <= 70; T += 20) {
      ctx.beginPath(); ctx.moveTo(X(T), padT); ctx.lineTo(X(T), h - padB); ctx.stroke();
      ctx.fillText(T + "°", X(T) - 8, h - 10);
    }
    for (var g = 0; g <= 4; g++) {
      var gy = Y(maxY * g / 4);
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
      ctx.fillText("$" + (maxY * g / 4).toFixed(2), 4, gy + 3);
    }
    // furnace constant line (warn)
    ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(X(x0), Y(furnCost)); ctx.lineTo(X(x1), Y(furnCost)); ctx.stroke();
    // hp cost line (accent)
    plot(ctx, X, Y, hpCostFn, x0, x1, "#34d399", 2.5);
    // break-even marker
    if (R.be.mode === "normal" && R.be.temp !== null) {
      ctx.strokeStyle = "#eaf3ee"; ctx.setLineDash([4, 4]);
      ctx.beginPath(); ctx.moveTo(X(R.be.temp), padT); ctx.lineTo(X(R.be.temp), h - padB); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = "#34d399"; ctx.fillText("Heat pump $/kWh", padL, padT + 2);
    ctx.fillStyle = "#fbbf24"; ctx.fillText("Gas furnace $/kWh", X(30), Y(furnCost) - 4);
  }

  function plot(ctx, X, Y, fn, x0, x1, color, lw) {
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
    var first = true;
    for (var T = x0; T <= x1; T += 0.5) {
      var x = X(T), y = Y(fn(T));
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  // =====================================================================
  //  FLOW
  // =====================================================================
  function renderMatches(recs, statusText) {
    var st = $("lookupStatus");
    var list = $("matchList");
    list.innerHTML = "";
    if (!recs.length) {
      st.textContent = statusText || "No match found.";
      st.className = "status err";
      $("matchArea").hidden = true;
      return;
    }
    st.textContent = statusText;
    st.className = "status ok";
    recs.slice(0, 40).forEach(function (r) {
      var spec = normalizeRecord(r);
      var b = document.createElement("button");
      b.className = "match";
      b.innerHTML = '<div class="m-brand">' + esc(spec.brand + " " + spec.model) + "</div>" +
        '<div class="m-sub">' + esc(spec.modelSeries || "") + "</div>" +
        (specValid(spec)
          ? '<div class="m-spec">@47°F ' + fmt(spec.cap47) + ' BTU/h · @17°F ' + fmt(spec.cap17) +
            " BTU/h · COP@47 " + (isFinite(spec.cop47) ? round(spec.cop47, 2) : "—") +
            " · COP@17 " + (isFinite(spec.cop17) ? round(spec.cop17, 2) : "—") +
            " · HSPF2 " + (isFinite(spec.hspf2) ? round(spec.hspf2, 1) : "—") + "</div>"
          : '<div class="m-spec">missing capacity/COP fields — cannot calculate</div>');
      if (selectedSpec && spec.brand === selectedSpec.brand && spec.model === selectedSpec.model) b.classList.add("sel");
      b.onclick = function () {
        Array.prototype.forEach.call(list.children, function (c) { c.classList.remove("sel"); });
        b.classList.add("sel");
        if (!specValid(spec)) { st.textContent = "That model lacks the capacity/COP fields needed."; st.className = "status err"; return; }
        selectedSpec = spec;
        st.textContent = "Selected: " + spec.brand + " " + spec.model;
        st.className = "status ok";
      };
      list.appendChild(b);
    });
    $("matchArea").hidden = false;
  }

  async function doLookup() {
    var q = $("model").value.trim();
    var st = $("lookupStatus");
    if (!q) { st.textContent = "Enter a model number."; st.className = "status err"; return; }
    st.textContent = "Searching…"; st.className = "status";
    $("matchArea").hidden = true; $("matchList").innerHTML = "";

    await loadCatalog();

    // Show bundled-catalog matches instantly (no network needed).
    var local = localSearch(q);
    if (local.length) {
      renderMatches(local, local.length + " match" + (local.length > 1 ? "es" : "") +
        " in bundled catalog. Picking one (live NEEP also checking…):");
    } else {
      st.textContent = "Not in bundled catalog — checking live NEEP…";
    }

    // Live NEEP lookup runs in the background and can never hang the UI:
    // each request aborts after 8s and the whole thing is capped at 20s.
    var live = [];
    try {
      live = await Promise.race([
        neepLiveSearch(q),
        new Promise(function (res) { setTimeout(function () { res([]); }, 20000); })
      ]);
    } catch (e) { live = []; }

    var byId = {};
    local.concat(live).forEach(function (r) {
      var id = r.id || ("L" + (r.model_number || r.outdoor_unit_number || Math.random()));
      if (!byId[id]) byId[id] = r;
    });
    var recs = Object.keys(byId).map(function (k) { return byId[k]; });

    if (!recs.length) {
      renderMatches([], "No match in bundled catalog or live NEEP. Check the model number, " +
        "add a working CORS proxy in Settings (NEEP blocks direct browser access), or enter specs manually below.");
      return;
    }
    var label = recs.length + " match" + (recs.length > 1 ? "es" : "") +
      (live.length ? " (live NEEP + bundled)" : " (bundled)") + ". Pick one:";
    renderMatches(recs, label);
  }


  // Read one stage's capacity/COP fields by id prefix (e.g. "m", "m2", "cm", "cm2").
  function readStage(prefix, withLockout) {
    function f(id) { return num($(prefix + "_" + id).value); }
    return {
      cap47: f("cap47"), cap17: f("cap17"), cap5: NaN,
      cop47: f("cop47"), cop17: f("cop17"), cop5: NaN,
      hspf2: f("hspf2"),
      lockout: withLockout ? f("lockout") : NaN
    };
  }

  function specFromManual() {
    var stage1 = readStage("m", true);
    var stages = [stage1];
    if (num($("m_stages").value) === 2) stages.push(readStage("m2", false));
    return {
      brand: $("m_brand").value || "Manual",
      model: $("m_model").value || "Manual entry",
      modelSeries: "",
      cap47: stage1.cap47, cap17: stage1.cap17, cap5: NaN,
      cop47: stage1.cop47, cop17: stage1.cop17, cop5: NaN,
      hspf2: stage1.hspf2, lockout: stage1.lockout,
      refrigerant: "", ahri: "", source: "Manual entry",
      stages: stages
    };
  }

  // Mirror of specFromManual for the "Add heat pump" comparison modal.
  function specFromModal() {
    var stage1 = readStage("cm", true);
    var stages = [stage1];
    if (num($("cm_stages").value) === 2) stages.push(readStage("cm2", false));
    return {
      brand: $("cm_brand").value || "Manual",
      model: $("cm_model").value || "Manual entry",
      modelSeries: "",
      cap47: stage1.cap47, cap17: stage1.cap17, cap5: NaN,
      cop47: stage1.cop47, cop17: stage1.cop17, cop5: NaN,
      hspf2: stage1.hspf2, lockout: stage1.lockout,
      refrigerant: "", ahri: "", source: "Manual entry",
      stages: stages
    };
  }

  function statePrice(abbr) { return (window.STATE_PRICES || {})[abbr]; }
  function autofillPrices(geo) {
    var sp = statePrice(geo.stateAbbr);
    if (!sp) return;
    if (!isFinite(num($("elec").value))) $("elec").value = sp.electricity;
    if (!isFinite(num($("gas").value))) $("gas").value = sp.gas;
  }

  function readParams(geo) {
    var elec = num($("elec").value);
    var gas = num($("gas").value);
    var sp = geo ? statePrice(geo.stateAbbr) : null;
    if (!isFinite(elec) && sp) elec = sp.electricity;
    if (!isFinite(gas) && sp) gas = sp.gas;
    return {
      indoor: num($("indoor").value) || 70,
      afue: clamp(num($("afue").value) || 0.95, 0.4, 1),
      furnaceBtu: num($("furnaceBtu").value),
      designLoad: num($("designLoad").value),
      designTemp: num($("designTemp").value),
      elec: elec, gas: gas,
      copOverride: {}
    };
  }

  async function doCalculate() {
    clearError();
    if (!selectedSpec) {
      // allow manual-only calc if manual fields filled
      var man = specFromManual();
      if (specValid(man)) selectedSpec = man;
      else { showError("Look up and select a model, or fill in the manual specs."); return; }
    }
    var zip = $("zip").value.trim();
    if (!/^\d{5}$/.test(zip)) { showError("Enter a valid 5-digit zip code."); return; }
    var zipSt = $("zipStatus"); zipSt.textContent = "Locating zip…"; zipSt.className = "status";

    var geo;
    try { geo = await geocodeZip(zip); }
    catch (e) { zipSt.textContent = "Could not find that zip."; zipSt.className = "status err"; showError("Zip lookup failed: " + e.message); return; }

    zipSt.textContent = geo.place + ", " + geo.state + " (" + geo.lat.toFixed(2) + "," + geo.lon.toFixed(2) + ")";
    zipSt.className = "status ok";

    // auto-fill prices if blank
    autofillPrices(geo);

    var p = readParams(geo);
    if (!isFinite(p.elec) || !isFinite(p.gas)) { showError("Set electricity and gas prices (auto-fill failed for this state)."); return; }

    var wSt = $("weatherStatus");
    wSt.textContent = "Fetching weather…"; wSt.className = "status";

    try { currentWeather = await fetchWeather(geo.lat, geo.lon); }
    catch (e) { wSt.textContent = "Weather failed: " + e.message; wSt.className = "status err"; showError("Weather fetch failed: " + e.message); return; }
    currentWeather.place = geo.place; currentWeather.stateAbbr = geo.stateAbbr;
    wSt.textContent = "Weather loaded (" + currentWeather.year + ").";
    wSt.className = "status ok";

    currentParams = p;

    var R = analyze(selectedSpec, currentWeather, p);
    renderResults(R, p);
  }

  // =====================================================================
  //  COMPARE
  // =====================================================================
  function uid() { return "s" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function cloneStages(sts) {
    return (sts || []).map(function (s) {
      return {
        cap47: s.cap47, cap17: s.cap17, cap5: s.cap5,
        cop47: s.cop47, cop17: s.cop17, cop5: s.cop5,
        hspf2: s.hspf2, lockout: s.lockout
      };
    });
  }

  // Snapshot the currently-selected heat pump (or valid manual entry) as a
  // plain { brand, model, stages } object, or null if nothing usable.
  function snapshotSpec() {
    if (selectedSpec && specValid(selectedSpec)) {
      return { brand: selectedSpec.brand, model: selectedSpec.model, stages: cloneStages(selectedSpec.stages) };
    }
    var m = specFromManual();
    if (specValid(m)) return { brand: m.brand, model: m.model, stages: cloneStages(m.stages) };
    return null;
  }

  function currentFurnace() {
    return { afue: num($("afue").value) || 0.95, btu: num($("furnaceBtu").value) };
  }

  var scenarios = (function () { try { return store.get("scenarios", []); } catch (e) { return []; } })();
  function persist() { store.set("scenarios", scenarios); }

  function renderScenarioList() {
    var wrap = $("scenarioList");
    wrap.innerHTML = "";
    if (!scenarios.length) {
      wrap.innerHTML = '<p class="hint">No scenarios yet. Tap “Compare current system” to auto-build dual-fuel vs heat-pump-only vs furnace-only, or “Add heat pump” to compare a different model.</p>';
      return;
    }
    scenarios.forEach(function (sc) {
      var card = document.createElement("div"); card.className = "scn";

      var name = document.createElement("input"); name.className = "scn-name"; name.value = sc.name || "";
      name.addEventListener("input", function () { sc.name = name.value; persist(); });

      var sel = document.createElement("select"); sel.className = "scn-backup";
      [["dual", "Dual fuel"], ["hp", "Heat pump only"], ["furnace", "Furnace only"]].forEach(function (o) {
        var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1];
        if (sc.backup === o[0]) op.selected = true; sel.appendChild(op);
      });
      sel.addEventListener("change", function () { sc.backup = sel.value; persist(); });

      var meta = document.createElement("div"); meta.className = "scn-meta";
      var nb = (sc.brand || "") + " " + (sc.model || "");
      var nst = sc.stages ? sc.stages.length : 0;
      var who = nb.trim() || (sc.backup === "furnace" ? "No heat pump (gas only)" : "Heat pump");
      meta.textContent = who + (nst ? " · " + nst + " stage" + (nst > 1 ? "s" : "") : "");

      var del = document.createElement("button"); del.className = "scn-del secondary"; del.textContent = "Remove";
      del.addEventListener("click", function () {
        scenarios = scenarios.filter(function (x) { return x !== sc; }); persist(); renderScenarioList();
      });

      card.appendChild(name); card.appendChild(sel); card.appendChild(meta); card.appendChild(del);
      wrap.appendChild(card);
    });
  }

  function seedCurrentSystem() {
    var snap = snapshotSpec();
    if (!snap) { showError("Look up or enter a heat pump first — the Compare tab reuses the current equipment."); return; }
    var fur = currentFurnace();
    scenarios = [
      { id: uid(), name: (snap.brand + " " + snap.model + " — Dual fuel").trim(), brand: snap.brand, model: snap.model, stages: snap.stages, backup: "dual", furnace: fur },
      { id: uid(), name: (snap.brand + " " + snap.model + " — Heat pump only").trim(), brand: snap.brand, model: snap.model, stages: snap.stages, backup: "hp", furnace: fur },
      { id: uid(), name: "Furnace only (" + Math.round(fur.afue * 100) + "% AFUE)", brand: "", model: "", stages: [], backup: "furnace", furnace: fur }
    ];
    persist(); renderScenarioList();
  }

  // Reuse the main flow's weather + prices; if the user already ran Calculate,
  // currentWeather/currentParams are set and this is instant.
  async function ensureContext() {
    if (currentWeather && currentParams) return { weather: currentWeather, params: currentParams };
    var zip = $("zip").value.trim();
    if (!/^\d{5}$/.test(zip)) { showError("Enter a zip code — the Compare tool reuses your weather & prices. Or run Calculate first."); return null; }
    var geo;
    try { geo = await geocodeZip(zip); }
    catch (e) { showError("Zip lookup failed: " + e.message); return null; }
    autofillPrices(geo);
    var p = readParams(geo);
    if (!isFinite(p.elec) || !isFinite(p.gas)) { showError("Set electricity and gas prices."); return null; }
    try { currentWeather = await fetchWeather(geo.lat, geo.lon); }
    catch (e) { showError("Weather fetch failed: " + e.message); return null; }
    currentWeather.place = geo.place; currentWeather.stateAbbr = geo.stateAbbr;
    currentParams = p;
    return { weather: currentWeather, params: p };
  }

  async function runComparison() {
    if (!scenarios.length) { showError("Add at least one scenario to compare."); return; }
    var ctx = await ensureContext();
    if (!ctx) return;
    var results = [];
    for (var i = 0; i < scenarios.length; i++) {
      try { results.push(analyzeScenario(scenarios[i], ctx.weather, ctx.params)); }
      catch (e) { /* skip unanalyzable scenario */ }
    }
    if (!results.length) { showError("Could not analyze any scenarios."); return; }
    renderComparison(results);
    $("compareResults").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderComparison(results) {
    $("compareResults").hidden = false;
    var withAnnual = results.filter(function (r) { return r.annual; });
    var maxCost = 0;
    withAnnual.forEach(function (r) { if (r.annual.dualCost > maxCost) maxCost = r.annual.dualCost; });
    var mostExpensive = withAnnual.length ? withAnnual.reduce(function (a, b) { return b.annual.dualCost > a.annual.dualCost ? b : a; }).annual.dualCost : 0;
    var cheapest = withAnnual.length
      ? withAnnual.reduce(function (mn, rr) { return rr.annual.dualCost < mn.annual.dualCost ? rr : mn; })
      : null;

    var rows = results.map(function (r) {
      var sc = r.scenario;
      var a = r.annual;
      var setpoint = r.setpointTemp === null
        ? (r.setpointMode === "hp_always" ? "HP always" : r.setpointMode === "furnace_always" ? "Gas always" : "—")
        : round(r.setpointTemp, 1) + "°F";
      var cost = a ? a.dualCost : null;
      var save = (a && mostExpensive > 0) ? mostExpensive - a.dualCost : null;
      var modeLabel = sc.backup === "dual" ? "Dual fuel" : sc.backup === "hp" ? "HP only" : "Furnace only";
      var best = (a && results.length > 1 && cheapest && Math.abs(a.dualCost - cheapest.annual.dualCost) < 1e-6);
      return "<tr" + (best ? ' class="best"' : "") + ">" +
        "<td>" + esc(sc.name || "(unnamed)") + "</td>" +
        "<td>" + modeLabel + "</td>" +
        "<td>" + setpoint + "</td>" +
        "<td>" + (cost !== null ? money(cost) : "—") + "</td>" +
        "<td>" + (a ? fmt(round(a.dualKWh, 0)) : "—") + "</td>" +
        "<td>" + (a ? fmt(round(a.dualTherm, 0)) : "—") + "</td>" +
        "<td>" + (save !== null && save > 0.5 ? money(save) : "—") + "</td>" +
        "</tr>";
    }).join("");
    $("cmpTableBody").innerHTML = rows;

    $("cmpRec").innerHTML = recommendation(results, mostExpensive);

    if (withAnnual.length) drawCompareChart($("cmpChart"), results, maxCost);
    else $("cmpChart").getContext("2d").clearRect(0, 0, 640, 340);
  }

  function recommendation(results, mostExpensive) {
    var withAnnual = results.filter(function (r) { return r.annual; });
    if (!withAnnual.length) {
      return "Enter a home design heat load and design outdoor temp (Home &amp; prices) to see yearly costs and savings.";
    }
    var sorted = withAnnual.slice().sort(function (a, b) { return a.annual.dualCost - b.annual.dualCost; });
    var best = sorted[0], worst = sorted[sorted.length - 1];
    var save = worst.annual.dualCost - best.annual.dualCost;
    var s = "<strong>" + esc(best.scenario.name) + "</strong> is the lowest-cost option at <strong>" +
      money(best.annual.dualCost) + "/yr</strong>";
    if (save > 1) s += ", saving <strong>" + money(save) + "/yr</strong> vs " + esc(worst.scenario.name) + " (" + money(worst.annual.dualCost) + ").";
    else s += ".";
    if (best.scenario.backup === "dual") {
      s += " Run the " + esc(best.scenario.brand + " " + best.scenario.model).trim() +
        " down to " + (best.setpointTemp === null ? "its capacity limit" : round(best.setpointTemp, 1) + "°F") +
        ", then switch to gas.";
    } else if (best.scenario.backup === "hp") {
      s += " Going heat-pump-only avoids gas but uses about " + fmt(round(best.annual.dualKWh, 0)) + " kWh/yr of electricity.";
    }
    return s;
  }

  function drawCompareChart(cv, results, maxCost) {
    var c = setupCanvas(cv), ctx = c.ctx, w = c.w, h = c.h;
    ctx.clearRect(0, 0, w, h);
    var padL = 48, padR = 12, padT = 16, padB = 48;
    var plotW = w - padL - padR, plotH = h - padT - padB;
    var data = results.map(function (r) { return r.annual ? r.annual.dualCost : 0; });
    var maxC = (maxCost && maxCost > 0 ? maxCost : Math.max.apply(null, data.concat([1]))) * 1.12;
    function Y(v) { return h - padB - v / maxC * plotH; }

    ctx.strokeStyle = "#2a3a32"; ctx.fillStyle = "#9fb3a8"; ctx.font = "10px system-ui"; ctx.lineWidth = 1;
    for (var g = 0; g <= 4; g++) {
      var v = maxC * g / 4, y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
      ctx.fillText(money(v), 4, y + 3);
    }

    var colors = { dual: "#34d399", hp: "#38bdf8", furnace: "#fbbf24" };
    var bw = plotW / results.length;
    for (var i = 0; i < results.length; i++) {
      var r = results[i], cost = r.annual ? r.annual.dualCost : 0;
      var bx = padL + i * bw + bw * 0.16, bwid = bw * 0.68;
      var by = Y(cost), bh = (h - padB) - by;
      ctx.fillStyle = colors[r.scenario.backup] || "#34d399";
      ctx.fillRect(bx, by, bwid, Math.max(0, bh));
      ctx.fillStyle = "#eaf3ee"; ctx.font = "bold 11px system-ui";
      ctx.fillText(money(cost), bx, by - 5);
      ctx.fillStyle = "#9fb3a8"; ctx.font = "9px system-ui";
      var nm = (r.scenario.name || "").replace(/\s*—\s*/g, " ");
      if (nm.length > 16) nm = nm.slice(0, 15) + "…";
      ctx.fillText(nm, padL + i * bw + 4, h - padB + 14);
    }

    // legend
    ctx.font = "10px system-ui";
    ctx.fillStyle = colors.dual; ctx.fillRect(padL, 4, 9, 9); ctx.fillStyle = "#9fb3a8"; ctx.fillText("Dual fuel", padL + 13, 13);
    ctx.fillStyle = colors.hp; ctx.fillRect(padL + 70, 4, 9, 9); ctx.fillStyle = "#9fb3a8"; ctx.fillText("HP only", padL + 83, 13);
    ctx.fillStyle = colors.furnace; ctx.fillRect(padL + 140, 4, 9, 9); ctx.fillStyle = "#9fb3a8"; ctx.fillText("Furnace only", padL + 153, 13);
  }

  // ---------- compare modal ----------
  function openCmpModal() {
    $("cm_name").value = "";
    $("cm_backup").value = "dual";
    var cur = document.querySelector('input[name="cm_src"][value="current"]');
    if (cur) cur.checked = true;
    $("cmManual").hidden = true;
    $("cm_stages").value = "1";
    $("cmStage2Wrap").hidden = true;
    $("cmpModal").hidden = false;
    $("cm_name").focus();
  }
  function closeCmpModal() { $("cmpModal").hidden = true; }

  function addFromModal() {
    var name = $("cm_name").value.trim() || "Scenario";
    var backup = $("cm_backup").value;
    var srcEl = document.querySelector('input[name="cm_src"]:checked');
    var src = srcEl ? srcEl.value : "current";
    var brand, model, stages;
    if (src === "current") {
      var snap = snapshotSpec();
      if (!snap) { showError("Look up or enter a heat pump first, or choose “Enter manually”."); return; }
      brand = snap.brand; model = snap.model; stages = snap.stages;
    } else {
      var m = specFromModal();
      if (!specValid(m)) { showError("Manual heat pump needs capacity @47°F & @17°F plus a COP (COP@47, COP@17, or HSPF2)."); return; }
      brand = m.brand; model = m.model; stages = m.stages;
    }
    scenarios.push({ id: uid(), name: name, brand: brand, model: model, stages: cloneStages(stages), backup: backup, furnace: currentFurnace() });
    persist(); renderScenarioList(); closeCmpModal();
  }

  // =====================================================================
  //  SETTINGS
  // =====================================================================
  function openSettings() {
    var cfg = store.get("settings", {});
    $("proxyUrl").value = cfg.proxyUrl || "";
    $("eiaKey").value = cfg.eiaKey || "";
    $("settingsModal").hidden = false;
    $("proxyUrl").focus();
  }
  function saveSettings() {
    store.set("settings", { proxyUrl: $("proxyUrl").value.trim(), eiaKey: $("eiaKey").value.trim() });
    $("settingsModal").hidden = true;
  }

  // =====================================================================
  //  INIT
  // =====================================================================
  function init() {
    $("lookupBtn").onclick = doLookup;
    $("calcBtn").onclick = doCalculate;
    $("model").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doLookup(); }
    });
    $("zip").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); doCalculate(); }
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeCmpModal(); $("settingsModal").hidden = true; }
    });
    function toggleStage2() {
      $("stage2Wrap").hidden = (num($("m_stages").value) !== 2);
    }
    $("m_stages").addEventListener("change", toggleStage2);
    toggleStage2();
    $("useManualBtn").onclick = function () {
      var s = specFromManual();
      var mSt = $("manualStatus");
      if (!specValid(s)) {
        mSt.textContent = "Needs capacity @47°F and @17°F plus a COP (COP@47, COP@17, or HSPF2)" +
          (num($("m_stages").value) === 2 ? " for both stages." : ".");
        mSt.className = "status err";
        return;
      }
      selectedSpec = s; clearError();
      mSt.textContent = "Using these specs: " + s.brand + " " + s.model;
      mSt.className = "status ok";
      $("lookupStatus").textContent = "Using manual specs: " + s.brand + " " + s.model;
      $("lookupStatus").className = "status ok";
    };
    $("settingsBtn").onclick = openSettings;
    $("settingsClose").onclick = function () { $("settingsModal").hidden = true; };
    $("settingsSave").onclick = saveSettings;
    $("settingsModal").addEventListener("click", function (e) { if (e.target === $("settingsModal")) $("settingsModal").hidden = true; });

    // ---- compare ----
    $("cmpSeedBtn").onclick = seedCurrentSystem;
    $("cmpAddBtn").onclick = openCmpModal;
    $("cmpRunBtn").onclick = runComparison;
    $("cmpClearBtn").onclick = function () {
      scenarios = []; persist(); renderScenarioList(); $("compareResults").hidden = true;
    };
    $("cmCancel").onclick = closeCmpModal;
    $("cmAdd").onclick = addFromModal;
    $("cmpModal").addEventListener("click", function (e) { if (e.target === $("cmpModal")) closeCmpModal(); });
    $("cm_stages").addEventListener("change", function () {
      $("cmStage2Wrap").hidden = (num($("cm_stages").value) !== 2);
    });
    Array.prototype.forEach.call(document.querySelectorAll('input[name="cm_src"]'), function (r) {
      r.addEventListener("change", function () { $("cmManual").hidden = (r.value !== "manual"); });
    });
    renderScenarioList();
    if (!scenarios.length && snapshotSpec()) seedCurrentSystem();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      });
    }
  }
  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      BTU_PER_KWH: BTU_PER_KWH, KWH_PER_THERM: KWH_PER_THERM,
      buildCapacityCurve: buildCapacityCurve, buildCOPCurve: buildCOPCurve,
      economicBreakEven: economicBreakEven, capacityBalancePoint: capacityBalancePoint,
      analyze: analyze, analyzeScenario: analyzeScenario, integrateScenario: integrateScenario,
      normalizeRecord: normalizeRecord, specValid: specValid, specFromManual: specFromManual,
      prepStages: prepStages, activeStageForHour: activeStageForHour
    };
  }
})();
