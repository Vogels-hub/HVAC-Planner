# Dual Fuel Optimizer

An installable **PWA** (progressive web app) for phones (and any modern browser)
that helps technicians and homeowners optimize a **heat-pump + gas-furnace**
(dual fuel) system. Pick a heat pump and enter a zip code and the app:

1. Pulls the heat pump's **specifications** (heating capacity @ 47°F / 17°F / 5°F,
   COP @ 5°F, HSPF2) from the NEEP ASHP database (search-as-you-type against a
   bundled offline catalog, with optional live lookup).
2. Pulls a full year of **hourly weather** for the zip code (Open-Meteo).
3. Auto-fills **electricity & natural-gas prices** for the state (EIA averages, editable),
   suggests the local **design outdoor temperature** from the weather data, and — when
   NEEP lists the unit as a **dual-fuel pairing** — auto-fills the paired **furnace's
   AFUE** from its model number (never overriding a value you typed).
4. Shows the recommended **dual-fuel switchover temperature** in plain language,
   the **economic break-even** and **capacity balance point** behind it, and an
   **annual heating-cost comparison** (dual fuel vs heat-pump-only vs gas-only).
5. Ranks **competing scenarios** (different models / strategies) side by side and
   exports a one-tap **PDF report** for the customer file (browser print → save as PDF).

The UI is phone-first: three tabs (**Setup → Results → Compare**), numbered setup
steps with completion checkmarks, a rough built-in **heat-load estimator**
(sq ft × insulation quality) for homeowners without a Manual J, and everything
persists locally so a tech can reopen the app on site with the last job intact.

## Run / install on Android

No app store or build step is required.

1. Serve the folder over HTTP (browsers block service workers / install on `file://`):

   ```bash
   cd "Dual Fuel Balance Point Tool"
   python3 -m http.server 8080
   ```

2. On your Android phone, open **Chrome** and visit `http://<your-computer-ip>:8080`
   (same Wi-Fi network). Tap **⋮ → Install app** (or "Add to Home screen").
   It now runs full-screen like a native app and works offline.

> To put it on a public URL (so anyone can install it), deploy the folder to any
> static host (GitHub Pages, Netlify, Cloudflare Pages, etc.).

## How the data is fetched

| Need | Source | CORS / key |
|------|--------|-----------|
| Heat-pump specs | [NEEP ASHP database](https://ashp.neep.org) REST API | **Server blocks browser CORS** |
| Zip → lat/lon/state | [zippopotam.us](https://api.zippopotam.us) | open (`*`) |
| Hourly weather | [Open-Meteo archive](https://open-meteo.com) | open (`*`) |
| Energy prices | EIA state averages (bundled, editable) | bundled |

Because NEEP blocks browser cross-origin requests, live model lookup needs a relay.
**End users never configure anything** — the app handles it in this order:

1. **A Cloudflare Worker you deploy once** (see `worker/README.md` and `worker/proxy.js`).
   Paste its URL into `DEFAULT_PROXY` in `app.js` (or Settings). This gives full,
   live NEEP coverage with no per-user setup.
2. **Built-in public CORS proxies** (best-effort; often rate-limited/unavailable).
3. **The bundled catalog** (`data/heatpumps.js`, generated from NEEP — thousands of
   real models, works fully offline).
4. **Manual entry** of the required specs (always available).

> Public CORS proxies are unreliable, so the Worker is the recommended path. Without
> it, the app still works great against the bundled catalog + manual entry.

## The calculation

- **Cost of heat from the heat pump** at outdoor temp *T*:
  `cost_hp(T) = electricity_price / COP(T)`  [$ per kWh of heat]
- **Cost of heat from the furnace**:
  `cost_furnace = (gas_price_per_therm / 29.3) / AFUE`  [$ per kWh of heat]
- **Economic break-even temperature** is the *T* where `cost_hp(T) = cost_furnace`,
  i.e. where `COP(T) = electricity_price × 29.3 × AFUE / gas_price`. Below this
  temperature the gas furnace is cheaper.
- **Capacity balance point** solves `capacity(T) = UA × (T_indoor − T)`, i.e. where the
  heat pump's heating output equals the home's heat loss. Requires a home design load
  (optional input).
- **Recommended dual-fuel setpoint** = the higher of the two (furnace runs below it).
- **Annual cost** integrates the above over the year's actual hourly temperatures
  (heat-pump-only uses electric-resistance backup when the HP can't meet load).

### Estimates / assumptions (transparent, editable)
- COP at 47°F is estimated from HSPF2 as `HSPF2 / 2.5` when not supplied; COP at 17°F
  is interpolated. You can override COP values in the advanced section.
- Capacity and COP are treated as linear between the known rating points and
  extrapolated beyond them.
- Prices are state averages; enter your real tariff for accuracy.
- This is a planning estimator, **not** a substitute for a professional load
  calculation (Manual J) or contractor design.

## Project layout

```
index.html            UI (tabs, sheets, print report shell)
styles.css            design system (mobile-first, dark)
js/engine.js          pure calculation engine (browser + Node, no DOM)
js/data.js            data sources: geocode, weather, NEEP lookup, prices
js/app.js             UI logic: flow, rendering, charts, compare, report
manifest.webmanifest  PWA manifest
sw.js                 offline service worker (caches the app shell)
data/prices.js        EIA state electricity/gas prices
data/heatpumps.js     bundled NEEP catalog (generated; fallback + offline)
scripts/fetch_catalog.py    regenerates data/heatpumps.js from NEEP
scripts/test_calc.js        unit tests for the calculation engine
scripts/test_compare.js     DOM smoke test for the UI (jsdom)
scripts/test_integration.js end-to-end test (real geocode + weather)
```

## Tests

```bash
node scripts/test_calc.js          # calculation engine (js/engine.js)
node scripts/test_compare.js       # UI smoke test (requires jsdom)
node scripts/test_integration.js   # real network: geocode + weather + analyze
```

## Regenerate the bundled catalog

```bash
python3 scripts/fetch_catalog.py   # writes data/heatpumps.js from NEEP
```
