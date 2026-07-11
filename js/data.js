/* Dual Fuel Optimizer — data sources (browser only).
 * Geocoding, hourly weather, NEEP heat-pump lookup (live + bundled catalog),
 * state energy prices, and localStorage persistence. */
(function () {
  "use strict";

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

  var store = {
    get: function (k, d) { try { var v = localStorage.getItem("dfbp_" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem("dfbp_" + k, JSON.stringify(v)); } catch (e) {} }
  };

  // ---------- geocode: zip -> lat/lon/state ----------
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

  // ---------- weather: Open-Meteo archive, full prior year hourly temps ----------
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

  // ---------- NEEP live lookup (via CORS proxy) ----------
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

  // ---------- bundled catalog (lazy: ~630 KB, injected on first search) ----------
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

  // ---------- state average prices (EIA, bundled in data/prices.js) ----------
  function statePrice(abbr) { return (window.STATE_PRICES || {})[abbr]; }

  window.Data = {
    geocodeZip: geocodeZip,
    fetchWeather: fetchWeather,
    neepLiveSearch: neepLiveSearch,
    loadCatalog: loadCatalog,
    localSearch: localSearch,
    statePrice: statePrice,
    store: store
  };
})();
