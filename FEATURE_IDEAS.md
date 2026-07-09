# Feature ideas: Dual Fuel Balance Point Tool

Additional capabilities useful for HVAC technicians and homeowners optimizing a
heat pump + furnace system.

## High value (core workflow)
- **Multiple / multi-stage heat pumps** — model a system with two capacity stages
  or two outdoor units; show staged lockout points and per-stage economics.
- **Backup electric resistance cost** — include the resistance-strip cost when the
  heat pump can't keep up (already partially modeled; surface it as a distinct mode).
- **Demand charges & time-of-use (TOU) rates** — let users upload an hourly/electric
  rate schedule so the annual $ calc uses real TOU pricing, not a flat $/kWh.
- **Utility rebates & tax credits** — input upfront incentives (e.g. 25C / local
  rebates) and show simple-payback / ROI on the dual-fuel upgrade.
- **Side-by-side comparison** — compare "heat pump + furnace" vs "furnace only" vs
  "heat pump only" (no gas) with annual cost and carbon columns.

## Technician-focused
- **Manual setpoint override + field verification** — let a tech enter the
  *actual* measured lockout/balance point from commissioning and compare to the
  calculated one.
- **Equipment sizing check** — flag when design heat load exceeds heat pump
  capacity (reduced capacity at cold temps) or when furnace output is undersized.
- **Report / share export** — one-tap PDF or shareable link/summary of inputs,
  setpoint, and annual savings for the customer file.
- **Saved jobs / customer list** — store multiple addresses, models, and quotes
  locally (or account-synced) for return visits.

## Homeowner-focused
- **Carbon / emissions estimate** — convert gas + electricity use to lbs CO2 (with
  selectable grid carbon intensity by state).
- **"Should I keep the furnace?" guidance** — plain-language recommendation
  (e.g. "run heat pump down to X°F, then gas") plus estimated $ saved per year.
- **Weather sensitivity** — show how the setpoint and savings shift under a colder
  or warmer typical year (use a different weather year).
- **Bill estimator** — translate annual kWh + therms into a monthly $ estimate.

## Data & usability
- **Auto-fill from address** — pull climate data and rates from the zip alone
  (extend current EIA + weather integration).
- **Larger bundled catalog** — keep growing the offline NEEP snapshot so more
  models resolve without the live lookup.
- **Unit toggle** — °F/°C and BTU/kW, and metric capacity units.
- **PWA install prompt + offline results** — cache the last computed report so it's
  viewable in the basement with no signal.
