// Dual Fuel Balance Point — NEEP proxy worker (Cloudflare Workers).
//
// NEEP's API (ashp.neep.org) blocks browser cross-origin requests, so the PWA
// can't call it directly. Deploy this tiny worker ONCE and the app talks to it
// instead. It fetches NEEP server-side and returns the data with open CORS
// headers. End users never configure anything.
//
// Deploy (free, ~1 minute):
//   1. Install wrangler:  npm i -g wrangler
//   2. Login:             wrangler login
//   3. Create:            wrangler init --from-dash (or `wrangler generate`)
//   4. Replace src/worker.js (or worker.js) with THIS file.
//   5. Publish:           wrangler deploy
//   6. Copy the URL it prints (e.g. https://dualfuel-proxy.<user>.workers.dev/)
//      and paste it into DEFAULT_PROXY at the top of app.js (or Settings in the app).
//
// The worker only forwards to ashp.neep.org, so it can't be abused to fetch
// arbitrary sites.

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get("url");
    if (!target) {
      return new Response("Missing ?url= parameter", { status: 400 });
    }
    // Allowlist: only NEEP ASHP API.
    if (!/^https:\/\/ashp\.neep\.org\//i.test(target)) {
      return new Response("Only ashp.neep.org is allowed", { status: 403 });
    }
    try {
      const upstream = await fetch(target, {
        headers: { "User-Agent": "DualFuelBalancePoint/1.0" },
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Content-Type": upstream.headers.get("Content-Type") || "application/json",
          "Cache-Control": "public, max-age=3600",
        },
      });
    } catch (e) {
      return new Response("Upstream error: " + e.message, { status: 502 });
    }
  },
};
