// Serves the site normally, and saves each real page visit
// (city, state, country, page, referrer) to Workers KV.
// Runs on Cloudflare's side, so ad blockers cannot stop it.

const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|headless|monitor/i;

export default {
  async fetch(request, env, ctx) {
    const response = await env.ASSETS.fetch(request);

    const type = response.headers.get("content-type") || "";
    const ua = request.headers.get("user-agent") || "";

    // Only count real page loads from real browsers
    if (request.method === "GET" && type.includes("text/html") && !BOTS.test(ua) && env.VISITS) {
      const cf = request.cf || {};
      const visit = {
        time: new Date().toISOString(),
        page: new URL(request.url).pathname,
        city: cf.city || "unknown",
        region: cf.region || "unknown",
        country: cf.country || "unknown",
        org: cf.asOrganization || "unknown",
        referrer: request.headers.get("referer") || "direct",
      };
      const key = `${visit.time}_${crypto.randomUUID().slice(0, 8)}`;

      // Save without slowing down the page. Entries auto-delete after 90 days.
      ctx.waitUntil(
        env.VISITS.put(key, JSON.stringify(visit), { expirationTtl: 60 * 60 * 24 * 90 })
      );
    }

    return response;
  },
};
