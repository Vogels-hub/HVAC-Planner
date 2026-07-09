# Implementation Plan: Multi-Stage Heat Pumps + Scenario Comparison + PDF Report

Scope (from request):
1. **Multi-stage heat pump** calculations.
2. **Comparison** of either two dual-fuel heat pumps, or heat-pump+furnace vs furnace-only (and vs heat-pump-only), with a **yearly cost** for each.
3. A **professional, friendly PDF** export a technician can send to a customer.

Status: planning only. No code changes yet.

---

## 1. Current architecture (what we build on)

- A `spec` describes **one** heat pump: `cap47, cap17, cap5, cop47, cop17, cop5, hspf2, lockout` + `brand/model` (`normalizeRecord` app.js:157, `specFromManual` app.js:642).
- Curves are single functions: `buildCapacityCurve(spec)` (app.js:~205) and `buildCOPCurve(spec, ov)` (app.js:237). Both are anchor-based via `piecewise()`.
- `economicBreakEven(copFn, elec, gas, afue)` (app.js:252) and `capacityBalancePoint(capFn, UA, Tin)` (app.js:270) produce the dual-fuel **setpoint**.
- `analyze(spec, weather, p)` (app.js:284) returns `{ be, capBP, setpointTemp, setpointMode, annual }`.
- `integrateAnnual(...)` (app.js:315) loops every weather hour, picks HP vs furnace via `setpointMode`/`setpointTemp`, and returns `hpCost / furnaceCost / dualCost / hpKWh / dualKWh / dualTherm / hoursBelow`.
- `p` carries shared inputs: `elec, gas, afue, furnaceBtu, designLoad, designTemp, indoor, copOverride` (`readParams` app.js:663).

Key insight: the per-hour loop in `integrateAnnual` already decides HP vs furnace per hour. Multi-stage and "mode" comparison are both natural extensions of that loop.

---

## 2. Data model changes

### 2.1 Make a heat pump always a list of *stages*
Internally convert every `spec` into `spec.stages = [stage0, stage1, ...]`. A single-stage unit is just one element. Each `stage` carries the existing capacity/COP fields (cap47/17/5, cop47/17/5, hspf2, lockout). `normalizeRecord` and `specFromManual` populate `stages` (single element today). No breaking change to stored records — wrap on load.

### 2.2 Multi-stage inputs (manual form)
In the manual "Heat pump" group (index.html), add:
- **Stages:** radio/select `1` or `2` (most residential dual-fuel is 1–2 stages; keep extensible).
- When `2` is selected, reveal a second row of `cap @47 / cap @17 / COP @47 / COP @17` (stage 2) and a **Stage-1→2 switchover temp (°F)** field (default ~30°F).
- NEEP lookup: if a matched unit exposes low-stage ratings, map them to `stages[0]`; otherwise single stage. (NEEP rarely exposes per-stage cleanly, so this is primarily a manual-entry feature; note as known limitation.)

### 2.3 Scenario/config object (for comparison)
A `scenario` = the inputs for one compared system:
```
{
  name: "Current: Bosch 20SEER2 + 95% furnace",
  stages: [...],                 // heat pump stage(s)
  backup: "dual" | "hp" | "furnace",
  furnace: { afue, btu },        // ignored when backup === "hp"
  setpointOverride: null | °F    // optional; else computed
}
```
Shared across scenarios: `weather, elec, gas, indoor, designLoad, designTemp` (the home + prices from the existing inputs).

---

## 3. Calculation engine changes

### 3.1 Stage-aware curves (no change to `piecewise`)
- `buildCapacityCurve(stage)` and `buildCOPCurve(stage)` stay as-is, but are called **per stage**.
- Add `activeStageForHour(demandKW, T, stages)`:
  - Returns the **lowest** stage whose `capFn(T)` (in kW) ≥ `demandKW`.
  - If no stage can meet demand, return the **highest** stage (deliver what it can; remainder is backup).
- This makes control demand-responsive (efficient low stage when it can satisfy the load), which is the correct multi-stage behavior and generalizes single-stage for free.

### 3.2 Refactor `integrateAnnual` into `integrateScenario(scenario, weather, p)`
Per weather hour `T` (skip `T ≥ indoor`):
1. `demandKWh = UA * (indoor - T) / BTU_PER_KWH`.
2. Choose branch by `scenario.backup`:
   - **`furnace`**: `cost = demandKWh * (gas / KWH_PER_THERM) / afue`; no HP, no kWh.
   - **`hp`** (heat pump only, no gas): run HP at active stage; any shortfall uses **electric resistance** at `elec` $/kWh.
   - **`dual`** (heat pump + furnace): if `T >= setpoint` run HP (active stage, resistance for shortfall); else full furnace. Setpoint = `max(economicBreakEven, capacityBalancePoint)` as today (app.js:295).
3. Accumulate per branch: `cost`, `kWh`, `therm`, `hoursBelowSetpoint`.
Return an `annual` result object (same shape as today, plus `mode` tag).

### 3.3 `analyze` becomes `analyzeScenario`
- `analyzeScenario(scenario, weather, p)` builds curves from `scenario.stages`, computes `be`/`capBP`/`setpoint` (only meaningful for `dual`), and calls `integrateScenario`.
- Existing single-result `analyze` is kept as a thin wrapper for the main screen so current UI/render keeps working during rollout.

### 3.4 Yearly cost = bottom line
`annual.dualCost` (or `hpCost`/`furnaceCost`) **is** the yearly cost. Comparison just computes this for each scenario and diffs them (savings = `min - other`).

---

## 4. Comparison UI

### 4.1 "Compare" panel (new section in index.html)
- A **Scenarios** list. "Add scenario" clones the current equipment inputs into a card with a `name` and a `backup` selector (`Dual-fuel / Heat pump only / Furnace only`).
- Sensible defaults so a technician gets value fast:
  - **Auto-scenario A:** current inputs as `dual`.
  - **Auto-scenario B:** same heat pump as `hp` (no gas) — shows heat-pump-only cost.
  - **Auto-scenario C:** `furnace only` using the entered furnace AFUE/BTU — shows gas-only cost.
  - User can also add a **second heat pump** (different model/manual specs) as a second `dual` scenario to compare two dual-fuel systems directly.
- "Run comparison" computes all scenarios with the shared weather + prices and renders:
  - A **summary table**: scenario, backup type, setpoint, annual $, annual kWh, annual therms, yearly savings vs most-expensive.
  - A **bar chart** of annual $ per scenario (`drawCompareChart()`), reusing the existing canvas/chart helpers.
  - A one-line **recommendation** (e.g. "Dual fuel saves $X/yr vs furnace-only; heat pump alone saves $Y but uses Z kWh more electricity.").

### 4.2 Reuse existing machinery
- Charts: add `drawCompareChart(canvas, scenarios)` next to `drawPerfChart`/`drawCostChart`.
- State: store scenarios in `store` (localStorage) so a tech can save a customer's comparison (ties into the saved-jobs idea in FEATURE_IDEAS.md).

---

## 5. PDF report (professional, friendly, sendable)

Decision (confirmed): **print-stylesheet + `window.print()` → "Save as PDF"**. Rationale: zero dependencies, works offline (PWA), produces a real vector PDF, and we fully control the layout with CSS. (jsPDF deferred — would add a dependency and weaker layout control.)

### 5.1 Report layout (`@media print` + a hidden `#report` node)
Build a clean, branded report that a technician emails/prints:
- **Header:** app/company name, technician name + license (editable Settings fields), date, customer name + address (from zip/geocode).
- **Equipment compared:** for each scenario, brand/model, stages, capacities @47/17, COP @47/17, HSPF2, furnace AFUE/BTU, setpoint.
- **Results table:** annual cost, kWh, therms, CO₂ (optional), savings vs baseline.
- **Charts as images:** `canvas.toDataURL("image/png")` the perf/cost/compare canvases into `<img>`s so they print reliably.
- **Friendly summary:** plain-language recommendation generated from the numbers (no jargon walls).
- **Footer:** disclaimer ("estimate based on…") + contact.

### 5.2 Trigger
- "Export PDF" button on the results/compare screen → populate `#report`, then `window.print()`. Add `@media print { body > *:not(#report){display:none} #report{display:block} }` and print-friendly typography (avoid dark theme; light, high-contrast, serif/sans mix).
- Ensure the SW still caches the app so the report works offline at the job site.

---

## 6. Implementation order (phased)

1. **Refactor to stages** (internally `spec.stages`); keep single-stage behavior identical; add `activeStageForHour`. Unit-test in `scripts/test_calc.js` (single vs 2-stage, assert cost between stage-1-only and stage-2-only bounds).
2. **`integrateScenario` + `analyzeScenario`**; keep `analyze` wrapper. Tests: `dual` equals current output; `hp` and `furnace` branches produce sensible numbers.
3. **Manual 2-stage form** + `specFromManual` v2; `specValid` updated (require stage-1 always; stage-2 optional).
4. **Comparison UI** (scenarios list, auto A/B/C, run, table + bar chart + recommendation).
5. **PDF report** (hidden `#report`, print CSS, chart→image, Export button).
6. **Polish:** saved scenarios (localStorage), saved jobs/customer list (ties to FEATURE_IDEAS.md), unit toggle pass.

---

## 7. Testing
- Extend `scripts/test_calc.js`:
  - Multi-stage: 2-stage cost must be ≤ single-(high-stage)-only cost and ≥ single-(low-stage)-only cost at cold temps; at mild temps equals low-stage.
  - Modes: `furnace` cost ≈ pure-gas formula; `hp` uses resistance for shortfall; `dual` matches existing `dualCost`.
  - Comparison: savings sign correct (cheaper scenario has lower annual $).
- Add `scripts/test_pdf.js` smoke (report node builds, charts serialize to data URLs) if/jsPDF added.
- Manual: two real models looked up + a furnace-only scenario; export PDF and eyeball layout.

---

## 8. Risks / decisions (RESOLVED)
- **PDF method — CONFIRMED: print-to-PDF** (print stylesheet + `window.print()`). No jsPDF dependency.
- **Multi-stage control — CONFIRMED: demand-responsive.** `activeStageForHour` prefers the lowest stage that meets the hour's demand; no fixed switchover temp required. Keep an optional measured-override temp field for technicians.
- **Multi-stage data from NEEP:** likely unavailable per-stage → treat as manual-entry feature for now; auto-detect only if data exists.
- **Carbon:** include CO₂ only if grid-intensity data is added (see FEATURE_IDEAS.md); otherwise omit from v1 PDF.
