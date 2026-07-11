/* Dual Fuel Optimizer — UI layer.
 * Depends on window.Engine (js/engine.js) and window.Data (js/data.js). */
(function () {
  "use strict";

  var E = window.Engine, D = window.Data;

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
    if (v === null || v === undefined || !isFinite(v)) return "\u2014";
    return Number(v).toLocaleString(undefined, { maximumFractionDigits: d === undefined ? 0 : d });
  }
  function money(v) {
    if (v === null || !isFinite(v)) return "\u2014";
    return "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var el = $("toast");
    el.textContent = msg;
    el.className = "toast" + (kind === "info" ? " info" : "");
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 4000);
  }

  // ---------- state ----------
  var state = {
    geo: null,           // { zip, place, state, stateAbbr, lat, lon }
    weather: null,       // { temps, year, p1cold, ... }
    weatherZip: null,
    weatherPromise: null,
    spec: null,          // current heat pump spec
    R: null, p: null,    // last analysis + params
    cmpResults: null,    // last comparison results
    cmPicked: null       // spec picked in the scenario sheet's search
  };
  var scenarios = D.store.get("scenarios", []) || [];

  // ---------- tabs ----------
  function gotoTab(name) {
    document.body.dataset.tab = name;
    ["setup", "results", "compare"].forEach(function (t) {
      $("tab-" + t).classList.toggle("active", t === name);
    });
    Array.prototype.forEach.call(document.querySelectorAll(".tabbtn"), function (b) {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    window.scrollTo({ top: 0 });
    if (name === "compare") renderScenarioList();
  }

  // ---------- sheets ----------
  function openSheet(id) { $(id).hidden = false; }
  function closeSheet(id) { $(id).hidden = true; }
  function wireSheets() {
    Array.prototype.forEach.call(document.querySelectorAll(".sheet"), function (sh) {
      sh.addEventListener("click", function (e) { if (e.target === sh) sh.hidden = true; });
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-close]"), function (b) {
      b.onclick = function () { closeSheet(b.dataset.close); };
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        Array.prototype.forEach.call(document.querySelectorAll(".sheet"), function (sh) { sh.hidden = true; });
      }
    });
  }

  // ---------- persistence ----------
  var INPUT_IDS = ["zip", "indoor", "afue", "designLoad", "designTemp", "furnaceBtu", "elec", "gas"];
  function saveInputs() {
    var o = {};
    INPUT_IDS.forEach(function (id) { o[id] = $(id).value; });
    o.elecAuto = $("elec").dataset.auto === "1";
    o.gasAuto = $("gas").dataset.auto === "1";
    o.afueUser = $("afue").dataset.auto === "0";
    D.store.set("inputs", o);
  }
  var saveInputsSoon = debounce(saveInputs, 300);
  function restoreInputs() {
    var o = D.store.get("inputs", null);
    if (!o) return;
    INPUT_IDS.forEach(function (id) { if (o[id] !== undefined && o[id] !== "") $(id).value = o[id]; });
    if (o.elecAuto) $("elec").dataset.auto = "1";
    if (o.gasAuto) $("gas").dataset.auto = "1";
    if (o.afueUser) $("afue").dataset.auto = "0";
  }
  function persistSpec() {
    if (!state.spec) return;
    try { D.store.set("spec", JSON.parse(JSON.stringify(state.spec))); } catch (e) {}
  }
  function persistScenarios() {
    try { D.store.set("scenarios", JSON.parse(JSON.stringify(scenarios))); } catch (e) {}
  }
  // JSON storage turns NaN into null; restore the NaN convention on load so
  // numeric guards and curve builders treat missing values as missing.
  function nullToNaN(o) {
    for (var k in o) if (o[k] === null) o[k] = NaN;
    return o;
  }
  function sanitizeSpec(s) {
    nullToNaN(s);
    (s.stages || []).forEach(nullToNaN);
    if (s.furnace) nullToNaN(s.furnace);
    return s;
  }

  // ---------- step badges ----------
  function setBadge(id, n, done) {
    var b = $(id);
    b.classList.toggle("done", !!done);
    b.textContent = done ? "\u2713" : String(n);
  }
  function updateBadges() {
    setBadge("badgeZip", 1, !!state.geo);
    setBadge("badgeHP", 2, !!(state.spec && E.specValid(state.spec)));
    setBadge("badgeHome", 3, isFinite(num($("designLoad").value)));
    setBadge("badgePrices", 4, isFinite(num($("elec").value)) && isFinite(num($("gas").value)));
  }

  // =====================================================================
  //  STEP 1: location
  // =====================================================================
  async function lookupZip() {
    var zip = $("zip").value.trim();
    var info = $("zipInfo");
    if (!/^\d{5}$/.test(zip)) { state.geo = null; info.textContent = ""; updateBadges(); return null; }
    if (state.geo && state.geo.zip === zip) return state.geo;
    info.textContent = "Locating\u2026"; info.className = "field-note";
    try {
      var geo = await D.geocodeZip(zip);
      state.geo = geo;
      info.textContent = "\uD83D\uDCCD " + geo.place + ", " + geo.stateAbbr;
      info.className = "field-note ok";
      autofillPrices(geo);
      prefetchWeather(geo);
      updateBadges();
      return geo;
    } catch (e) {
      state.geo = null;
      info.textContent = "Couldn't find that zip code.";
      info.className = "field-note err";
      updateBadges();
      return null;
    }
  }

  function prefetchWeather(geo) {
    if (state.weather && state.weatherZip === geo.zip) return state.weatherPromise;
    state.weather = null;
    state.weatherZip = geo.zip;
    state.weatherPromise = D.fetchWeather(geo.lat, geo.lon).then(function (w) {
      w.place = geo.place; w.stateAbbr = geo.stateAbbr;
      state.weather = w;
      var dt = $("designTemp");
      dt.placeholder = "auto (" + round(w.p1cold, 0) + "\u00B0F)";
      return w;
    }).catch(function (e) {
      state.weatherPromise = null;
      throw e;
    });
    state.weatherPromise.catch(function () {}); // avoid unhandled rejection; calc retries
    return state.weatherPromise;
  }

  function autofillPrices(geo) {
    var sp = D.statePrice(geo.stateAbbr);
    var note = $("priceNote");
    if (!sp) { note.textContent = ""; return; }
    var elecEl = $("elec"), gasEl = $("gas");
    if (elecEl.value === "" || elecEl.dataset.auto === "1") { elecEl.value = sp.electricity; elecEl.dataset.auto = "1"; }
    if (gasEl.value === "" || gasEl.dataset.auto === "1") { gasEl.value = sp.gas; gasEl.dataset.auto = "1"; }
    var parts = [];
    if (elecEl.dataset.auto === "1") parts.push("electricity");
    if (gasEl.dataset.auto === "1") parts.push("gas");
    note.textContent = parts.length
      ? geo.stateAbbr + " average " + parts.join(" & ") + " rates \u2014 edit them if you know your bill."
      : "Using your custom rates.";
    saveInputsSoon();
    updateBadges();
  }

  // =====================================================================
  //  STEP 2: heat pump search
  // =====================================================================
  function specChips(spec) {
    var chips = [];
    if (isFinite(spec.cap47)) chips.push("<span class='chip'><b>" + fmt(spec.cap47) + "</b> BTU/h @47\u00B0</span>");
    if (isFinite(spec.cap17)) chips.push("<span class='chip'><b>" + fmt(spec.cap17) + "</b> BTU/h @17\u00B0</span>");
    if (isFinite(spec.hspf2)) chips.push("<span class='chip'>HSPF2 <b>" + round(spec.hspf2, 1) + "</b></span>");
    if (isFinite(spec.cop17)) chips.push("<span class='chip'>COP@17 <b>" + round(spec.cop17, 2) + "</b></span>");
    if (spec.stages && spec.stages.length > 1) chips.push("<span class='chip'><b>" + spec.stages.length + "</b> stages</span>");
    if (spec.furnaceModel) {
      chips.push("<span class='chip hot'>Dual fuel \u00B7 " + esc(spec.furnaceModel) +
        (isFinite(spec.furnaceAfue) ? " (" + Math.round(spec.furnaceAfue * 100) + "% AFUE)" : "") + "</span>");
    }
    return chips.join("");
  }

  function renderSelectedUnit() {
    var el = $("hpSelected");
    var s = state.spec;
    if (!s) { el.hidden = true; return; }
    el.innerHTML =
      "<div class='su-head'>" +
        "<div class='su-name'>" + esc(((s.brand || "") + " " + (s.model || "")).trim()) +
          (s.modelSeries ? "<div class='su-series'>" + esc(s.modelSeries) + "</div>" : "") +
          "<div class='su-series'>" + esc(s.source || "") + "</div>" +
        "</div>" +
        "<span class='chip'>Selected</span>" +
      "</div>" +
      "<div class='spec-chips'>" + specChips(s) + "</div>";
    el.hidden = false;
  }

  // NEEP lists some units as dual-fuel pairings (heat pump + gas furnace).
  // When the paired furnace's model number encodes its AFUE, auto-fill the
  // furnace-efficiency field — unless the user has typed their own value.
  function applyPairedFurnace(spec) {
    if (!spec.furnaceModel) return;
    var afueEl = $("afue");
    var pct = isFinite(spec.furnaceAfue) ? Math.round(spec.furnaceAfue * 100) : NaN;
    if (isFinite(pct) && afueEl.dataset.auto !== "0") {
      afueEl.value = pct;
      saveInputsSoon();
      toast("Dual-fuel unit \u2014 furnace efficiency set to " + pct + "% from the paired furnace " + spec.furnaceModel + ".", "info");
    } else {
      toast("Dual-fuel unit \u2014 pairs with furnace " + spec.furnaceModel + ".", "info");
    }
  }

  function selectSpec(spec) {
    if (!E.specValid(spec)) {
      toast("That model is missing the capacity/COP data needed to calculate.");
      return;
    }
    state.spec = spec;
    persistSpec();
    applyPairedFurnace(spec);
    $("hpResults").hidden = true;
    $("hpSearch").value = "";
    $("hpSearchNote").textContent = "";
    renderSelectedUnit();
    updateBadges();
  }

  function matchButton(rec, onPick) {
    var spec = E.normalizeRecord(rec);
    var valid = E.specValid(spec);
    var b = document.createElement("button");
    b.type = "button";
    b.className = "match" + (valid ? "" : " invalid");
    b.innerHTML =
      "<div class='m-brand'>" + esc((spec.brand + " " + spec.model).trim()) + "</div>" +
      (spec.modelSeries ? "<div class='m-sub'>" + esc(spec.modelSeries) + "</div>" : "") +
      (valid
        ? "<div class='m-spec'>" + fmt(spec.cap47) + " BTU/h @47\u00B0 \u00B7 " + fmt(spec.cap17) +
          " @17\u00B0 \u00B7 HSPF2 " + (isFinite(spec.hspf2) ? round(spec.hspf2, 1) : "\u2014") + "</div>"
        : "<div class='m-spec'>no performance data \u2014 can't be calculated</div>");
    b.onclick = function () { if (valid) onPick(spec); };
    return b;
  }

  function renderHPResults(recs, q, liveChecked) {
    var box = $("hpResults");
    var note = $("hpSearchNote");
    box.innerHTML = "";
    recs.slice(0, 30).forEach(function (rec) {
      box.appendChild(matchButton(rec, selectSpec));
    });
    if (!liveChecked) {
      var more = document.createElement("button");
      more.type = "button";
      more.className = "match more-row";
      more.textContent = recs.length
        ? "Not it? Search the live NEEP database"
        : "Search the live NEEP database";
      more.onclick = function () { liveSearch(q); };
      box.appendChild(more);
    }
    box.hidden = false;
    note.className = "field-note";
    note.textContent = recs.length
      ? recs.length + " match" + (recs.length > 1 ? "es" : "") + (liveChecked ? " (catalog + live)" : " in the offline catalog")
      : (liveChecked ? "No match anywhere \u2014 check the model number or enter specs manually." : "No match in the offline catalog.");
  }

  var hpSearchRun = 0;
  var doHPSearch = debounce(async function () {
    var q = $("hpSearch").value.trim();
    var run = ++hpSearchRun;
    if (q.length < 2) { $("hpResults").hidden = true; $("hpSearchNote").textContent = ""; return; }
    await D.loadCatalog();
    if (run !== hpSearchRun) return;
    renderHPResults(D.localSearch(q), q, false);
  }, 220);

  async function liveSearch(q) {
    var note = $("hpSearchNote");
    note.textContent = "Searching the live NEEP database\u2026";
    note.className = "field-note";
    var live = [];
    try {
      live = await Promise.race([
        D.neepLiveSearch(q),
        new Promise(function (res) { setTimeout(function () { res([]); }, 20000); })
      ]);
    } catch (e) { live = []; }
    var byId = {};
    D.localSearch(q).concat(live).forEach(function (r) {
      var id = r.id || ("L" + (r.model_number || r.outdoor_unit_number || Math.random()));
      if (!byId[id]) byId[id] = r;
    });
    var recs = Object.keys(byId).map(function (k) { return byId[k]; });
    renderHPResults(recs, q, true);
    if (!live.length) note.textContent += " Live search unavailable right now.";
  }

  // ---------- manual entry ----------
  function readStage(prefix, withLockout) {
    function f(id) { return num($(prefix + "_" + id).value); }
    return {
      cap47: f("cap47"), cap17: f("cap17"), cap5: NaN,
      cop47: f("cop47"), cop17: f("cop17"), cop5: NaN,
      hspf2: f("hspf2"),
      lockout: withLockout ? f("lockout") : NaN
    };
  }
  function specFromManual(prefix, prefix2, stagesSel) {
    var stage1 = readStage(prefix, true);
    var stages = [stage1];
    if (num($(stagesSel).value) === 2) stages.push(readStage(prefix2, false));
    return {
      brand: $(prefix + "_brand").value || "Manual",
      model: $(prefix + "_model").value || "Manual entry",
      modelSeries: "",
      cap47: stage1.cap47, cap17: stage1.cap17, cap5: NaN,
      cop47: stage1.cop47, cop17: stage1.cop17, cop5: NaN,
      hspf2: stage1.hspf2, lockout: stage1.lockout,
      refrigerant: "", ahri: "", source: "Manual entry",
      stages: stages
    };
  }
  var MANUAL_ERR = "Each stage needs capacity @47\u00B0F and @17\u00B0F plus one of COP@47, COP@17, or HSPF2.";

  // ---------- heat load estimator ----------
  function estimateLoad() {
    var sqft = num($("est_sqft").value);
    var factor = num($("est_quality").value); // BTU/sqft at a 70F design delta-T
    if (!isFinite(sqft) || sqft <= 0) return null;
    var indoor = num($("indoor").value) || 70;
    var designT = num($("designTemp").value);
    if (!isFinite(designT)) designT = state.weather ? round(state.weather.p1cold, 0) : 5;
    var dT = Math.max(20, indoor - designT);
    return { load: Math.round(sqft * factor * (dT / 70) / 1000) * 1000, designT: designT };
  }
  function updateEstPreview() {
    var est = estimateLoad();
    var box = $("estPreview");
    if (!est) { box.hidden = true; return; }
    box.innerHTML = "\u2248 <b>" + fmt(est.load) + " BTU/h</b> at " + est.designT + "\u00B0F outdoors";
    box.hidden = false;
  }

  // =====================================================================
  //  CALCULATE
  // =====================================================================
  function readParams() {
    var elec = num($("elec").value), gas = num($("gas").value);
    var sp = state.geo ? D.statePrice(state.geo.stateAbbr) : null;
    if (!isFinite(elec) && sp) elec = sp.electricity;
    if (!isFinite(gas) && sp) gas = sp.gas;
    var designTemp = num($("designTemp").value);
    if (!isFinite(designTemp) && state.weather) designTemp = round(state.weather.p1cold, 0);
    return {
      indoor: num($("indoor").value) || 70,
      afue: clamp((num($("afue").value) || 95) / 100, 0.4, 1),
      furnaceBtu: num($("furnaceBtu").value),
      designLoad: num($("designLoad").value),
      designTemp: designTemp,
      elec: elec, gas: gas,
      copOverride: {}
    };
  }

  async function doCalculate() {
    var btn = $("calcBtn");
    if (!state.spec || !E.specValid(state.spec)) {
      gotoTab("setup");
      toast("Pick a heat pump first \u2014 search a model or enter specs manually.");
      $("hpSearch").focus();
      return;
    }
    var zip = $("zip").value.trim();
    if (!/^\d{5}$/.test(zip)) {
      gotoTab("setup");
      toast("Enter a 5-digit zip code so we can pull local weather and prices.");
      $("zip").focus();
      return;
    }
    btn.disabled = true;
    try {
      btn.textContent = "Finding the home\u2026";
      var geo = await lookupZip();
      if (!geo) { toast("Couldn't find that zip code."); return; }

      btn.textContent = "Pulling a year of weather\u2026";
      var weather;
      try { weather = state.weather || await prefetchWeather(geo); }
      catch (e) { toast("Weather lookup failed \u2014 check your connection and try again."); return; }

      var p = readParams();
      if (!isFinite(p.elec) || !isFinite(p.gas)) {
        toast("Set electricity and gas prices \u2014 auto-fill isn't available for this state.");
        return;
      }

      btn.textContent = "Crunching 8,760 hours\u2026";
      state.R = E.analyze(state.spec, weather, p);
      state.p = p;
      renderResults(state.R, p);
      gotoTab("results");
    } finally {
      btn.disabled = false;
      btn.textContent = "See results";
    }
  }

  // =====================================================================
  //  RESULTS
  // =====================================================================
  function heroContent(R) {
    var name = ((R.spec.brand || "") + " " + (R.spec.model || "")).trim() || "the heat pump";
    if (R.setpointMode === "furnace_always") {
      return { label: "Run the furnace", value: "Always", cls: "warn",
        sub: "At your rates, gas heat is cheaper than " + name + " at every temperature. Double-check your electric rate \u2014 this usually means expensive electricity." };
    }
    if (R.setpointMode === "hp_always" || (R.setpointTemp === null && R.be.mode === "hp_always")) {
      return { label: "Switch to gas", value: "Never", cls: "blue",
        sub: name + " heats for less than gas at every temperature. Run it all winter; keep the furnace as emergency backup." };
    }
    if (R.setpointMode === "capacity") {
      return { label: "Furnace takes over below", value: round(R.setpointTemp, 1) + "\u00B0F", cls: "",
        sub: name + " is cheaper than gas all the way down \u2014 but below " + round(R.setpointTemp, 1) +
          "\u00B0F it can't carry the whole house, so the furnace should take over." };
    }
    if (R.setpointTemp === null) {
      return { label: "Switch to gas", value: "\u2014", cls: "",
        sub: "Add a home heat load to pin down the exact switchover." };
    }
    if (R.be.mode === "normal" && isFinite(R.capBP) && R.capBP > R.be.temp) {
      return { label: "Switch to gas below", value: round(R.setpointTemp, 1) + "\u00B0F", cls: "",
        sub: name + " stays cheaper than gas down to " + round(R.be.temp, 1) + "\u00B0F, but below " +
          round(R.setpointTemp, 1) + "\u00B0F it can't keep up with the house \u2014 switch to the furnace there." };
    }
    return { label: "Switch to gas below", value: round(R.setpointTemp, 1) + "\u00B0F", cls: "",
      sub: "Above " + round(R.setpointTemp, 1) + "\u00B0F, " + name + " heats for less. Below it, the gas furnace wins \u2014 set your dual-fuel switchover there." };
  }

  function renderResults(R, p) {
    $("resultsEmpty").hidden = true;
    $("resultsBody").hidden = false;

    var h = heroContent(R);
    $("heroLabel").textContent = h.label;
    $("heroValue").textContent = h.value;
    $("heroValue").className = "hero-value " + h.cls;
    $("heroSub").textContent = h.sub;

    var chips = [];
    if (R.be.mode === "normal" && R.be.temp !== null) chips.push("<span class='chip'>Cost tie at <b>" + round(R.be.temp, 1) + "\u00B0F</b></span>");
    if (isFinite(R.capBP)) chips.push("<span class='chip'>Capacity limit <b>" + round(R.capBP, 1) + "\u00B0F</b></span>");
    if (R.be.copReq) chips.push("<span class='chip'>COP to beat gas <b>" + round(R.be.copReq, 2) + "</b></span>");
    $("heroChips").innerHTML = chips.join("");

    // annual costs
    if (R.annual) {
      $("annualCard").hidden = false;
      $("loadNudge").hidden = true;
      renderAnnualBars(R, p);
    } else {
      $("annualCard").hidden = true;
      $("loadNudge").hidden = false;
    }

    drawCostChart($("costChart"), R, p);
    drawCapChart($("capChart"), R, p);
    $("capNote").textContent = R.UA
      ? "Purple line = what the house needs. Where it crosses the heat pump's output is the capacity limit."
      : "Add a home heat load in Setup to overlay what the house needs.";

    $("numbersBody").innerHTML = numbersHTML(R, p);
  }

  function renderAnnualBars(R, p) {
    var a = R.annual;
    var rows = [
      { name: "Dual fuel (optimal)", cost: a.dualCost, detail: fmt(round(a.dualKWh, 0)) + " kWh + " + fmt(round(a.dualTherm, 0)) + " therms" },
      { name: "Heat pump only", cost: a.hpCost, detail: fmt(round(a.hpKWh, 0)) + " kWh (electric backup when short)" },
      { name: "Gas furnace only", cost: a.furnaceCost, detail: fmt(round(a.gasTherm, 0)) + " therms" }
    ];
    var best = Math.min(a.dualCost, a.hpCost, a.furnaceCost);
    var max = Math.max(a.dualCost, a.hpCost, a.furnaceCost, 1);
    var badged = false;
    var html = rows.map(function (r) {
      var isBest = Math.abs(r.cost - best) < 0.5;
      var showBadge = isBest && !badged;
      if (showBadge) badged = true;
      return "<div class='abar" + (isBest ? " best" : "") + "'>" +
        "<div class='abar-top'><span class='abar-name'>" + r.name + (showBadge ? "<span class='badge'>cheapest</span>" : "") + "</span>" +
        "<span class='abar-cost'>" + money(r.cost) + "/yr</span></div>" +
        "<div class='abar-track'><div class='abar-fill' style='width:" + Math.max(4, r.cost / max * 100) + "%'></div></div>" +
        "<div class='abar-detail'>" + r.detail + "</div></div>";
    }).join("");

    if (isFinite(p.furnaceBtu) && isFinite(p.designLoad) && p.furnaceBtu < p.designLoad) {
      html += "<div class='note-warn'>\u26A0 The furnace (" + fmt(p.furnaceBtu) + " BTU/h) is smaller than the design heat load (" +
        fmt(p.designLoad) + " BTU/h) \u2014 it may not keep up alone on the coldest nights.</div>";
    }
    $("annualBars").innerHTML = html;

    var vsWorst = Math.max(a.hpCost, a.furnaceCost) - a.dualCost;
    var note = "";
    if (R.setpointTemp !== null) {
      note = "The furnace covers " + fmt(a.hoursBelow) + " of " + fmt(a.hoursTotal) + " heating hours (below " +
        round(R.setpointTemp, 1) + "\u00B0F). ";
    }
    if (vsWorst > 1) note += "Running the optimal dual-fuel strategy saves about " + money(vsWorst) + "/yr vs the most expensive option.";
    $("annualNote").textContent = note;
  }

  function numbersHTML(R, p) {
    var s = R.spec, w = state.weather;
    function row(l, v) { return "<tr><td>" + l + "</td><td>" + v + "</td></tr>"; }
    var html = "<p class='tbl-title'>Heat pump \u2014 " + esc(((s.brand || "") + " " + (s.model || "")).trim()) + "</p><table>" +
      row("Capacity @47\u00B0F", fmt(s.cap47) + " BTU/h") +
      row("Capacity @17\u00B0F", isFinite(s.cap17) ? fmt(s.cap17) + " BTU/h" : "\u2014") +
      row("Capacity @5\u00B0F", isFinite(s.cap5) ? fmt(s.cap5) + " BTU/h" : "\u2014 (extrapolated)") +
      row("COP @47\u00B0F", isFinite(s.cop47) ? round(s.cop47, 2) : (isFinite(s.hspf2) ? round(s.hspf2 / 2.5, 2) + " (from HSPF2)" : "\u2014")) +
      row("COP @17\u00B0F", isFinite(s.cop17) ? round(s.cop17, 2) : "\u2014") +
      row("HSPF2", isFinite(s.hspf2) ? round(s.hspf2, 1) : "\u2014") +
      row("Stages", (s.stages || []).length || 1) +
      row("Source", esc(s.source || "\u2014")) +
      "</table>";
    html += "<p class='tbl-title'>Furnace</p><table>" +
      row("Efficiency (AFUE)", round(p.afue * 100, 0) + "%") +
      row("Output", isFinite(p.furnaceBtu) ? fmt(p.furnaceBtu) + " BTU/h" : "\u2014") +
      "</table>";
    html += "<p class='tbl-title'>Key temperatures</p><table>" +
      row("Economic break-even", R.be.mode === "normal" ? round(R.be.temp, 1) + "\u00B0F" : (R.be.mode === "hp_always" ? "HP always cheaper" : "Gas always cheaper")) +
      row("COP needed to match gas", R.be.copReq ? round(R.be.copReq, 2) : "\u2014") +
      row("Capacity balance point", isFinite(R.capBP) ? round(R.capBP, 1) + "\u00B0F" : "\u2014 (needs heat load)") +
      row("Recommended switchover", R.setpointTemp !== null ? round(R.setpointTemp, 1) + "\u00B0F" : "\u2014") +
      "</table>";
    if (w) {
      html += "<p class='tbl-title'>Weather \u2014 " + esc((w.place || "") + ", " + (w.stateAbbr || "")) + "</p><table>" +
        row("Year of hourly data", w.year) +
        row("1% cold design temp", round(w.p1cold, 1) + "\u00B0F") +
        row("Coldest / average hour", round(w.min, 1) + "\u00B0F / " + round(w.avg, 1) + "\u00B0F") +
        row("Heating degree-hours (65\u00B0F)", fmt(round(w.hdd65, 0))) +
        "</table>";
    }
    html += "<p class='tbl-title'>Prices</p><table>" +
      row("Electricity", "$" + p.elec + "/kWh") +
      row("Natural gas", "$" + p.gas + "/therm") +
      "</table>" +
      "<p class='field-note'>Capacity and COP are treated as linear between rating points. " +
      "Estimates for planning \u2014 not a substitute for a Manual J load calculation.</p>";
    return html;
  }

  // =====================================================================
  //  CHARTS (canvas, fixed 640-wide logical size, DPR-sharp)
  // =====================================================================
  var C = {
    grid: "#243357", label: "#93a1c2", text: "#eef2fb",
    hp: "#38bdf8", gas: "#fb923c", load: "#a78bfa",
    hpZone: "rgba(56,189,248,0.08)", gasZone: "rgba(251,146,60,0.09)"
  };

  function setupCanvas(cv) {
    var lw = cv.dataset.lw ? +cv.dataset.lw : cv.width;
    var lh = cv.dataset.lh ? +cv.dataset.lh : cv.height;
    cv.dataset.lw = lw; cv.dataset.lh = lh;
    var dpr = window.devicePixelRatio || 1;
    cv.width = lw * dpr; cv.height = lh * dpr;
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx: ctx, w: lw, h: lh };
  }

  function plot(ctx, X, Y, fn, x0, x1, color, lw, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = lw;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    var first = true;
    for (var T = x0; T <= x1; T += 0.5) {
      var x = X(T), y = Y(fn(T));
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawGrid(ctx, X, w, h, padL, padR, padT, padB, x0, x1, yTick) {
    ctx.strokeStyle = C.grid; ctx.lineWidth = 1;
    ctx.fillStyle = C.label; ctx.font = "11px system-ui";
    for (var T = x0; T <= x1; T += 20) {
      ctx.beginPath(); ctx.moveTo(X(T), padT); ctx.lineTo(X(T), h - padB); ctx.stroke();
      ctx.fillText(T + "\u00B0", X(T) - 8, h - padB + 16);
    }
    for (var g = 0; g <= 4; g++) {
      var gy = h - padB - g / 4 * (h - padT - padB);
      ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(w - padR, gy); ctx.stroke();
      if (yTick) yTick(g, gy);
    }
  }

  function drawCostChart(cv, R, p) {
    var c = setupCanvas(cv), ctx = c.ctx, w = c.w, h = c.h;
    ctx.clearRect(0, 0, w, h);
    var padL = 48, padR = 14, padT = 26, padB = 30;
    var x0 = -10, x1 = 70;
    function X(T) { return padL + (T - x0) / (x1 - x0) * (w - padL - padR); }
    var furnCost = (p.gas / E.KWH_PER_THERM) / p.afue; // $/kWh heat, constant
    function hpCostFn(T) { return p.elec / R.copFn(T); }
    var maxY = Math.max(hpCostFn(x0), furnCost) * 1.2;
    function Y(v) { return h - padB - v / maxY * (h - padT - padB); }

    // zone shading around the recommended switchover
    var sp = R.setpointTemp;
    if (sp !== null && isFinite(sp)) {
      ctx.fillStyle = C.gasZone; ctx.fillRect(X(x0), padT, X(sp) - X(x0), h - padT - padB);
      ctx.fillStyle = C.hpZone; ctx.fillRect(X(sp), padT, X(x1) - X(sp), h - padT - padB);
    }

    drawGrid(ctx, X, w, h, padL, padR, padT, padB, x0, x1, function (g, gy) {
      ctx.fillStyle = C.label;
      ctx.fillText("$" + (maxY * g / 4).toFixed(2), 4, gy + 4);
    });

    ctx.strokeStyle = C.gas; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(X(x0), Y(furnCost)); ctx.lineTo(X(x1), Y(furnCost)); ctx.stroke();
    plot(ctx, X, Y, hpCostFn, x0, x1, C.hp, 2.5);

    if (sp !== null && isFinite(sp)) {
      ctx.strokeStyle = C.text; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(X(sp), padT); ctx.lineTo(X(sp), h - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.text; ctx.font = "bold 11px system-ui";
      var lbl = round(sp, 1) + "\u00B0F";
      var lx = Math.min(Math.max(X(sp) - 14, padL), w - padR - 34);
      ctx.fillText(lbl, lx, padT - 8);
    }
    ctx.font = "11px system-ui";
    ctx.fillStyle = C.hp; ctx.fillText("Heat pump ($ per kWh of heat)", padL + 4, padT + 14);
    ctx.fillStyle = C.gas; ctx.fillText("Gas furnace", w - padR - 76, Y(furnCost) - 6);
  }

  function drawCapChart(cv, R, p) {
    var c = setupCanvas(cv), ctx = c.ctx, w = c.w, h = c.h;
    ctx.clearRect(0, 0, w, h);
    var padL = 48, padR = 14, padT = 26, padB = 30;
    var x0 = -10, x1 = 70;
    function X(T) { return padL + (T - x0) / (x1 - x0) * (w - padL - padR); }
    var stages = (R.spec && R.spec.stages) || [];
    var maxC = 0;
    stages.forEach(function (st) {
      for (var t = x0; t <= x1; t += 10) maxC = Math.max(maxC, st.capFn(t));
    });
    if (R.UA) maxC = Math.max(maxC, R.UA * (p.indoor - x0));
    maxC = (maxC || 1) * 1.12;
    function Y(v) { return h - padB - v / maxC * (h - padT - padB); }

    drawGrid(ctx, X, w, h, padL, padR, padT, padB, x0, x1, function (g, gy) {
      ctx.fillStyle = C.label;
      ctx.fillText(Math.round(maxC * g / 4 / 1000) + "k", 10, gy + 4);
    });

    stages.forEach(function (st, i) {
      plot(ctx, X, Y, st.capFn, x0, x1, C.hp, i === stages.length - 1 ? 2.5 : 1.6, i === stages.length - 1 ? null : [6, 4]);
    });
    if (R.UA) {
      plot(ctx, X, Y, function (T) { return Math.max(0, R.UA * (p.indoor - T)); }, x0, x1, C.load, 2.5);
    }
    if (isFinite(R.capBP)) {
      ctx.strokeStyle = C.text; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.moveTo(X(R.capBP), padT); ctx.lineTo(X(R.capBP), h - padB); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = C.text; ctx.font = "bold 11px system-ui";
      ctx.fillText(round(R.capBP, 1) + "\u00B0F", Math.min(Math.max(X(R.capBP) - 14, padL), w - padR - 34), padT - 8);
    }
    ctx.font = "11px system-ui";
    ctx.fillStyle = C.hp; ctx.fillText("Heat pump output (BTU/h)" + (stages.length > 1 ? " \u2014 lower stage dashed" : ""), padL + 4, padT + 14);
    if (R.UA) { ctx.fillStyle = C.load; ctx.fillText("Home heat need", padL + 4, padT + 28); }
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
  function snapshotSpec() {
    if (state.spec && E.specValid(state.spec)) {
      E.prepStages(state.spec);
      return { brand: state.spec.brand, model: state.spec.model, stages: cloneStages(state.spec.stages) };
    }
    return null;
  }
  function currentFurnace() {
    return { afue: clamp((num($("afue").value) || 95) / 100, 0.4, 1), btu: num($("furnaceBtu").value) };
  }

  function seedScenarios() {
    var snap = snapshotSpec();
    if (!snap) {
      toast("Pick a heat pump in Setup first \u2014 Compare starts from your current equipment.");
      gotoTab("setup");
      return;
    }
    var fur = currentFurnace();
    var nm = (snap.brand + " " + snap.model).trim();
    scenarios = [
      { id: uid(), name: nm + " \u2014 dual fuel", brand: snap.brand, model: snap.model, stages: snap.stages, backup: "dual", furnace: fur },
      { id: uid(), name: nm + " \u2014 heat pump only", brand: snap.brand, model: snap.model, stages: cloneStages(snap.stages), backup: "hp", furnace: fur },
      { id: uid(), name: "Gas furnace only (" + Math.round(fur.afue * 100) + "% AFUE)", brand: "", model: "", stages: [], backup: "furnace", furnace: fur }
    ];
    persistScenarios();
    renderScenarioList();
  }

  var MODE_LABELS = { dual: "Dual fuel", hp: "Heat pump only", furnace: "Furnace only" };

  function renderScenarioList() {
    var wrap = $("scenarioList");
    wrap.innerHTML = "";
    $("cmpClearBtn").hidden = scenarios.length === 0;
    if (!scenarios.length) {
      var empty = document.createElement("div");
      empty.className = "empty";
      empty.innerHTML = "<p class='field-note'>Nothing to compare yet.</p>";
      var seed = document.createElement("button");
      seed.id = "cmpSeedBtn";
      seed.type = "button";
      seed.className = "secondary";
      seed.style.marginTop = "10px";
      seed.textContent = "Start with my current setup";
      seed.onclick = seedScenarios;
      empty.appendChild(seed);
      wrap.appendChild(empty);
      return;
    }
    scenarios.forEach(function (sc) {
      var card = document.createElement("div"); card.className = "scn";
      var row1 = document.createElement("div"); row1.className = "scn-row";
      var name = document.createElement("input"); name.className = "scn-name"; name.value = sc.name || "";
      name.setAttribute("aria-label", "Scenario name");
      name.addEventListener("input", function () { sc.name = name.value; persistScenarios(); });
      var del = document.createElement("button"); del.className = "scn-del"; del.type = "button";
      del.setAttribute("aria-label", "Remove scenario"); del.textContent = "\u00D7";
      del.onclick = function () {
        scenarios = scenarios.filter(function (x) { return x !== sc; });
        persistScenarios(); renderScenarioList();
      };
      row1.appendChild(name); row1.appendChild(del);

      var row2 = document.createElement("div"); row2.className = "scn-row2";
      var sel = document.createElement("select"); sel.className = "scn-backup";
      [["dual", "Dual fuel"], ["hp", "Heat pump only"], ["furnace", "Furnace only"]].forEach(function (o) {
        var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1];
        if (sc.backup === o[0]) op.selected = true; sel.appendChild(op);
      });
      sel.addEventListener("change", function () { sc.backup = sel.value; persistScenarios(); });
      var meta = document.createElement("div"); meta.className = "scn-meta";
      var nb = ((sc.brand || "") + " " + (sc.model || "")).trim();
      meta.textContent = nb || (sc.backup === "furnace" ? "no heat pump" : "heat pump");
      row2.appendChild(sel); row2.appendChild(meta);

      card.appendChild(row1); card.appendChild(row2);
      wrap.appendChild(card);
    });
  }

  async function ensureContext() {
    var zip = $("zip").value.trim();
    if (!/^\d{5}$/.test(zip)) {
      toast("Enter a zip code in Setup \u2014 Compare reuses your local weather and prices.");
      gotoTab("setup");
      return null;
    }
    var geo = await lookupZip();
    if (!geo) { toast("Couldn't find that zip code."); return null; }
    var weather;
    try { weather = state.weather || await prefetchWeather(geo); }
    catch (e) { toast("Weather lookup failed \u2014 check your connection."); return null; }
    var p = readParams();
    if (!isFinite(p.elec) || !isFinite(p.gas)) { toast("Set electricity and gas prices in Setup."); return null; }
    return { weather: weather, params: p };
  }

  async function runComparison() {
    if (!scenarios.length) { toast("Add at least one scenario first."); return; }
    var btn = $("cmpRunBtn");
    btn.disabled = true; btn.textContent = "Comparing\u2026";
    try {
      var ctx = await ensureContext();
      if (!ctx) return;
      var results = [];
      for (var i = 0; i < scenarios.length; i++) {
        try { results.push(E.analyzeScenario(scenarios[i], ctx.weather, ctx.params)); }
        catch (e) { /* skip unanalyzable scenario */ }
      }
      if (!results.length) { toast("Couldn't analyze any scenario \u2014 check the specs."); return; }
      state.cmpResults = results;
      renderComparison(results);
      $("compareResults").hidden = false;
      $("compareResults").scrollIntoView({ behavior: "smooth", block: "start" });
    } finally {
      btn.disabled = false; btn.textContent = "Compare";
    }
  }

  function setpointText(r) {
    if (r.setpointTemp !== null) return "switch to gas below " + round(r.setpointTemp, 1) + "\u00B0F";
    if (r.setpointMode === "hp_always") return "heat pump all the way down";
    if (r.setpointMode === "furnace_always") return r.scenario.backup === "furnace" ? "gas all season" : "gas is always cheaper";
    return "";
  }

  function renderComparison(results) {
    var withAnnual = results.filter(function (r) { return r.annual; });
    var sorted = withAnnual.slice().sort(function (a, b) { return a.annual.dualCost - b.annual.dualCost; });
    var noAnnual = results.filter(function (r) { return !r.annual; });
    var maxCost = sorted.length ? sorted[sorted.length - 1].annual.dualCost : 1;
    var bestCost = sorted.length ? sorted[0].annual.dualCost : 0;

    var html = sorted.map(function (r, i) {
      var a = r.annual;
      var extra = a.dualCost - bestCost;
      return "<div class='rank-card" + (i === 0 ? " best" : "") + "'>" +
        "<div class='rank-head'>" +
          "<span class='rank-pos'>" + (i + 1) + "</span>" +
          "<div class='rank-name'>" + esc(r.scenario.name || "(unnamed)") +
            "<div class='rank-mode'>" + [MODE_LABELS[r.scenario.backup], setpointText(r)].filter(Boolean).join(" \u00B7 ") + "</div></div>" +
          "<div class='rank-cost'>" + money(a.dualCost) + "<span class='per'>per year</span></div>" +
        "</div>" +
        "<div class='rank-track'><div class='rank-fill' style='width:" + Math.max(4, a.dualCost / maxCost * 100) + "%'></div></div>" +
        "<div class='rank-foot'>" +
          "<span>" + fmt(round(a.dualKWh, 0)) + " kWh \u00B7 " + fmt(round(a.dualTherm, 0)) + " therms</span>" +
          "<span class='delta" + (i === 0 ? " best" : "") + "'>" + (i === 0 ? "cheapest" : "+" + money(extra) + "/yr") + "</span>" +
        "</div></div>";
    }).join("");

    html += noAnnual.map(function (r) {
      return "<div class='rank-card'>" +
        "<div class='rank-head'><span class='rank-pos'>\u2014</span>" +
        "<div class='rank-name'>" + esc(r.scenario.name || "(unnamed)") +
        "<div class='rank-mode'>" + [MODE_LABELS[r.scenario.backup], setpointText(r)].filter(Boolean).join(" \u00B7 ") + "</div></div>" +
        "<div class='rank-cost'>\u2014</div></div></div>";
    }).join("");
    $("cmpRanking").innerHTML = html;
    $("cmpRec").innerHTML = recommendation(results);
  }

  function recommendation(results) {
    var withAnnual = results.filter(function (r) { return r.annual; });
    if (!withAnnual.length) {
      return "Add a home heat load in Setup (tap <em>estimate</em>) to see yearly costs and savings for each scenario.";
    }
    var sorted = withAnnual.slice().sort(function (a, b) { return a.annual.dualCost - b.annual.dualCost; });
    var best = sorted[0], worst = sorted[sorted.length - 1];
    var save = worst.annual.dualCost - best.annual.dualCost;
    var s = "<strong>" + esc(best.scenario.name) + "</strong> wins at <strong>" + money(best.annual.dualCost) + "/yr</strong>";
    if (save > 1) s += " \u2014 " + money(save) + "/yr less than " + esc(worst.scenario.name) + ".";
    else s += ".";
    if (best.scenario.backup === "dual" && best.setpointTemp !== null) {
      s += " Set the switchover at <strong>" + round(best.setpointTemp, 1) + "\u00B0F</strong>: heat pump above, furnace below.";
    } else if (best.scenario.backup === "hp") {
      s += " Going all-electric uses about " + fmt(round(best.annual.dualKWh, 0)) + " kWh/yr.";
    }
    return s;
  }

  // ---------- scenario sheet ----------
  var cmSrc = "current";
  function openScenarioSheet() {
    $("cm_name").value = "";
    $("cm_backup").value = "dual";
    $("cmStatus").textContent = "";
    $("cmPicked").textContent = "";
    $("cmSearch").value = "";
    $("cmResults").hidden = true;
    state.cmPicked = null;
    setCmSrc("current");
    openSheet("sheetScenario");
  }
  function setCmSrc(src) {
    cmSrc = src;
    Array.prototype.forEach.call(document.querySelectorAll("#cmSrcSeg .seg-btn"), function (b) {
      b.classList.toggle("active", b.dataset.src === src);
    });
    $("cmSearchWrap").hidden = src !== "search";
    $("cmManual").hidden = src !== "manual";
  }

  var doCmSearch = debounce(async function () {
    var q = $("cmSearch").value.trim();
    if (q.length < 2) { $("cmResults").hidden = true; return; }
    await D.loadCatalog();
    var recs = D.localSearch(q).slice(0, 20);
    var box = $("cmResults");
    box.innerHTML = "";
    recs.forEach(function (rec) {
      box.appendChild(matchButton(rec, function (spec) {
        state.cmPicked = spec;
        $("cmPicked").textContent = "Selected: " + ((spec.brand + " " + spec.model).trim());
        $("cmPicked").className = "field-note ok";
        box.hidden = true;
        if (!$("cm_name").value) $("cm_name").value = (spec.brand + " " + spec.model).trim();
      }));
    });
    if (!recs.length) box.innerHTML = "<div class='match invalid'>No match in the offline catalog.</div>";
    box.hidden = false;
  }, 220);

  function addScenarioFromSheet() {
    var name = $("cm_name").value.trim();
    var backup = $("cm_backup").value;
    var st = $("cmStatus");
    var brand = "", model = "", stages = [];

    if (backup !== "furnace") {
      if (cmSrc === "current") {
        var snap = snapshotSpec();
        if (!snap) { st.textContent = "No current heat pump \u2014 pick one in Setup, or use Search/Manual."; return; }
        brand = snap.brand; model = snap.model; stages = snap.stages;
      } else if (cmSrc === "search") {
        if (!state.cmPicked) { st.textContent = "Search and select a model first."; return; }
        E.prepStages(state.cmPicked);
        brand = state.cmPicked.brand; model = state.cmPicked.model; stages = cloneStages(state.cmPicked.stages);
      } else {
        var m = specFromManual("cm", "cm2", "cm_stages");
        if (!E.specValid(m)) { st.textContent = MANUAL_ERR; return; }
        brand = m.brand; model = m.model; stages = m.stages;
      }
    }
    if (!name) name = backup === "furnace" ? "Gas furnace only" : ((brand + " " + model).trim() + " \u2014 " + MODE_LABELS[backup]);
    scenarios.push({ id: uid(), name: name, brand: brand, model: model, stages: cloneStages(stages), backup: backup, furnace: currentFurnace() });
    persistScenarios();
    renderScenarioList();
    closeSheet("sheetScenario");
  }

  // =====================================================================
  //  PDF REPORT (print -> save as PDF)
  // =====================================================================
  function reportHTML() {
    var out = "<h1>Dual Fuel Optimizer \u2014 report</h1>";
    var when = new Date().toLocaleDateString();
    var loc = state.geo ? state.geo.place + ", " + state.geo.stateAbbr + " " + state.geo.zip : "";
    out += "<p class='rep-sub'>" + esc(loc) + " \u00B7 generated " + when + "</p>";

    var R = state.R, p = state.p;
    if (R && p) {
      var h = heroContent(R);
      out += "<h2>Recommendation</h2><p class='rep-hero'>" + esc(h.label) + ": <b>" + esc(h.value) + "</b><br>" + esc(h.sub) + "</p>";
      out += "<h2>System</h2><table>" +
        "<tr><td>Heat pump</td><td>" + esc(((R.spec.brand || "") + " " + (R.spec.model || "")).trim()) + "</td></tr>" +
        "<tr><td>Capacity @47\u00B0F / @17\u00B0F</td><td>" + fmt(R.spec.cap47) + " / " + fmt(R.spec.cap17) + " BTU/h</td></tr>" +
        "<tr><td>Furnace AFUE</td><td>" + round(p.afue * 100, 0) + "%</td></tr>" +
        "<tr><td>Electricity / gas price</td><td>$" + p.elec + "/kWh \u00B7 $" + p.gas + "/therm</td></tr>" +
        (isFinite(p.designLoad) ? "<tr><td>Design heat load</td><td>" + fmt(p.designLoad) + " BTU/h at " + p.designTemp + "\u00B0F</td></tr>" : "") +
        "</table>";
      if (R.annual) {
        var a = R.annual;
        var best = Math.min(a.dualCost, a.hpCost, a.furnaceCost);
        function repRow(n, c, e) {
          return "<tr" + (Math.abs(c - best) < 0.5 ? " class='rep-best'" : "") + "><td>" + n + "</td><td>" + money(c) + "</td><td>" + e + "</td></tr>";
        }
        out += "<h2>Annual heating cost</h2><table><tr><th>Strategy</th><th>Cost/yr</th><th>Energy</th></tr>" +
          repRow("Dual fuel (optimal)", a.dualCost, fmt(round(a.dualKWh, 0)) + " kWh + " + fmt(round(a.dualTherm, 0)) + " therms") +
          repRow("Heat pump only", a.hpCost, fmt(round(a.hpKWh, 0)) + " kWh") +
          repRow("Gas furnace only", a.furnaceCost, fmt(round(a.gasTherm, 0)) + " therms") +
          "</table>";
      }
      try {
        out += "<h2>Cost of heat by outdoor temperature</h2><img src='" + $("costChart").toDataURL("image/png") + "' alt=''/>";
        if (R.UA) out += "<h2>Capacity vs home heat need</h2><img src='" + $("capChart").toDataURL("image/png") + "' alt=''/>";
      } catch (e) { /* canvas unavailable */ }
    }

    if (state.cmpResults && state.cmpResults.length) {
      var withAnnual = state.cmpResults.filter(function (r) { return r.annual; })
        .sort(function (a, b) { return a.annual.dualCost - b.annual.dualCost; });
      if (withAnnual.length) {
        out += "<h2>Scenario comparison</h2><table><tr><th>Scenario</th><th>Strategy</th><th>Switchover</th><th>Cost/yr</th><th>kWh</th><th>Therms</th></tr>";
        withAnnual.forEach(function (r, i) {
          out += "<tr" + (i === 0 ? " class='rep-best'" : "") + "><td>" + esc(r.scenario.name) + "</td><td>" +
            (MODE_LABELS[r.scenario.backup] || "") + "</td><td>" +
            (r.setpointTemp !== null ? round(r.setpointTemp, 1) + "\u00B0F" : "\u2014") + "</td><td>" +
            money(r.annual.dualCost) + "</td><td>" + fmt(round(r.annual.dualKWh, 0)) + "</td><td>" +
            fmt(round(r.annual.dualTherm, 0)) + "</td></tr>";
        });
        out += "</table>";
        out += "<p class='rep-hero'>" + recommendation(state.cmpResults) + "</p>";
      }
    }

    out += "<p class='rep-note'>Hourly weather: Open-Meteo (" + (state.weather ? state.weather.year : "") + "). " +
      "Heat pump data: NEEP ASHP database / manual entry. Prices: EIA state averages unless edited. " +
      "Capacity & COP linear between rating points. Planning estimate \u2014 not a substitute for a Manual J load calculation.</p>";
    return out;
  }

  function printReport() {
    if (!state.R && !(state.cmpResults && state.cmpResults.length)) {
      toast("Run a calculation first, then save the report.");
      return;
    }
    $("report").innerHTML = reportHTML();
    window.print();
  }

  // =====================================================================
  //  SETTINGS
  // =====================================================================
  function openSettings() {
    var cfg = D.store.get("settings", {});
    $("proxyUrl").value = cfg.proxyUrl || "";
    openSheet("sheetSettings");
  }
  function saveSettings() {
    D.store.set("settings", { proxyUrl: $("proxyUrl").value.trim() });
    closeSheet("sheetSettings");
    toast("Settings saved.", "info");
  }

  // =====================================================================
  //  INIT
  // =====================================================================
  function init() {
    wireSheets();

    // tabs
    Array.prototype.forEach.call(document.querySelectorAll(".tabbtn"), function (b) {
      b.onclick = function () { gotoTab(b.dataset.tab); };
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-goto]"), function (b) {
      b.onclick = function () { gotoTab(b.dataset.goto); };
    });
    document.body.dataset.tab = "setup";

    // location
    $("zip").addEventListener("input", function () {
      var v = $("zip").value.replace(/\D/g, "").slice(0, 5);
      if (v !== $("zip").value) $("zip").value = v;
      saveInputsSoon();
      if (v.length === 5) lookupZip();
      else { state.geo = null; $("zipInfo").textContent = ""; updateBadges(); }
    });

    // heat pump search
    $("hpSearch").addEventListener("input", doHPSearch);
    $("manualBtn").onclick = function () { $("manualStatus").textContent = ""; openSheet("sheetManual"); };
    $("m_stages").addEventListener("change", function () {
      $("stage2Wrap").hidden = num($("m_stages").value) !== 2;
    });
    $("useManualBtn").onclick = function () {
      var s = specFromManual("m", "m2", "m_stages");
      if (!E.specValid(s)) { $("manualStatus").textContent = MANUAL_ERR; return; }
      selectSpec(s);
      closeSheet("sheetManual");
    };

    // estimator
    function openEstimator() { updateEstPreview(); openSheet("sheetEstimate"); }
    $("estBtn").onclick = openEstimator;
    $("nudgeEstBtn").onclick = openEstimator;
    $("est_sqft").addEventListener("input", updateEstPreview);
    $("est_quality").addEventListener("change", updateEstPreview);
    $("estApplyBtn").onclick = function () {
      var est = estimateLoad();
      if (!est) { toast("Enter the heated floor area."); return; }
      $("designLoad").value = est.load;
      saveInputs();
      updateBadges();
      closeSheet("sheetEstimate");
      if (state.R) doCalculate(); // refresh results with the new load
    };

    // inputs persistence + badges
    INPUT_IDS.forEach(function (id) {
      $(id).addEventListener("input", function () { saveInputsSoon(); updateBadges(); });
    });
    ["elec", "gas", "afue"].forEach(function (id) {
      $(id).addEventListener("input", function () { $(id).dataset.auto = "0"; });
    });

    // calculate
    $("calcBtn").onclick = doCalculate;

    // results actions
    $("reportBtn").onclick = printReport;
    $("reportBtn2").onclick = printReport;
    $("goCompareBtn").onclick = function () { gotoTab("compare"); };

    // compare
    $("cmpAddBtn").onclick = openScenarioSheet;
    $("cmpRunBtn").onclick = runComparison;
    $("cmpClearBtn").onclick = function () {
      scenarios = [];
      persistScenarios();
      renderScenarioList();
      $("compareResults").hidden = true;
      state.cmpResults = null;
    };
    Array.prototype.forEach.call(document.querySelectorAll("#cmSrcSeg .seg-btn"), function (b) {
      b.onclick = function () { setCmSrc(b.dataset.src); };
    });
    $("cmSearch").addEventListener("input", doCmSearch);
    $("cm_stages").addEventListener("change", function () {
      $("cmStage2Wrap").hidden = num($("cm_stages").value) !== 2;
    });
    $("cmAddBtn").onclick = addScenarioFromSheet;

    // settings
    $("settingsBtn").onclick = openSettings;
    $("settingsSaveBtn").onclick = saveSettings;

    // restore previous session
    restoreInputs();
    var savedSpec = D.store.get("spec", null);
    if (savedSpec && E.specValid(savedSpec)) { state.spec = sanitizeSpec(savedSpec); renderSelectedUnit(); }
    scenarios.forEach(sanitizeSpec);
    renderScenarioList();
    updateBadges();
    if (/^\d{5}$/.test($("zip").value.trim())) lookupZip();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {});
      });
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
