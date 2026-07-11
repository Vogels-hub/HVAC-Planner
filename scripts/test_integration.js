// Integration test: real network geocode + weather, then the exported engine.
const C = require("../js/engine.js");

(async () => {
  const zip = "02118";
  const r = await fetch("https://api.zippopotam.us/us/" + zip);
  const d = await r.json();
  const p = d.places[0];
  const geo = {
    place: p["place name"], state: p.state, stateAbbr: p["state abbreviation"],
    lat: parseFloat(p.latitude), lon: parseFloat(p.longitude)
  };
  console.log("geocode:", geo.place, geo.state, geo.lat, geo.lon);

  const year = new Date().getFullYear() - 1;
  const url = "https://archive-api.open-meteo.com/v1/archive?latitude=" + geo.lat +
    "&longitude=" + geo.lon + "&start_date=" + year + "-01-01&end_date=" + year +
    "-12-31&hourly=temperature_2m&temperature_unit=fahrenheit&timezone=auto";
  const wres = await fetch(url);
  const wd = await wres.json();
  const temps = wd.hourly.temperature_2m.filter((t) => typeof t === "number" && isFinite(t));
  const sorted = temps.slice().sort((a, b) => a - b);
  const weather = {
    temps, year, p1cold: sorted[Math.floor(sorted.length * 0.01)],
    min: sorted[0], max: sorted[sorted.length - 1],
    avg: temps.reduce((a, b) => a + b, 0) / temps.length, hdd65: 0
  };
  console.log("weather:", year, "pts", temps.length, "1%cold", Math.round(weather.p1cold), "min", Math.round(weather.min));

  const spec = { brand: "TEST", model: "X", cap47: 24000, cap17: 18000, cap5: 14000, cop5: 2.1, hspf2: 9.5, lockout: NaN, source: "test" };
  const params = { indoor: 70, afue: 0.95, designLoad: 36000, designTemp: 5, elec: 0.30, gas: 2.10, copOverride: {} };
  const R = C.analyze(spec, weather, params);
  console.log("break-even mode:", R.be.mode, "temp:", R.be.temp);
  console.log("capacity BP:", R.capBP);
  console.log("dual setpoint:", R.setpointTemp, "mode:", R.setpointMode);
  console.log("annual dual $:", Math.round(R.annual.dualCost),
    "furnace $:", Math.round(R.annual.furnaceCost),
    "hp-only $:", Math.round(R.annual.hpCost));
  console.log("hours below setpoint:", Math.round(R.annual.hoursBelow), "/", R.annual.hoursTotal);
  console.log("INTEGRATION OK");
})().catch((e) => { console.error("INTEGRATION FAILED:", e); process.exit(1); });
