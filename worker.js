// Serves the site normally, and saves each real page visit to Workers KV.
// Filters out bots, scrapers, and traffic from hosting networks.

const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|headless|monitor|scan|check|http-client|axios|fetch\//i;

const HOSTING = /(amazon|google llc|microsoft|digitalocean|linode|ovh|hetzner|m247|vultr|contabo|choopa|datacamp|leaseweb|psychz|cogent|hurricane electric|internap|rackspace|packet|equinix|servercentral|colocrossing|1337 services|custodian|collyer quay|techoff|fine group|sundance international|techties|palo alto networks|tor|private internet|nord|surfshark|mullvad|cyberghost|datacenter|hosting|server|cloud|vps)/i;

export default {
    async fetch(request, env, ctx) {
          const response = await env.ASSETS.fetch(request);
          const type = response.headers.get("content-type") || "";
          const ua = request.headers.get("user-agent") || "";
          const cf = request.cf || {};
          const org = cf.asOrganization || "";

      const isPage = request.method === "GET" && type.includes("text/html");
          const looksLikeBrowser = /mozilla.*(chrome|safari|firefox|edg)/i.test(ua) && !BOTS.test(ua);
          const hasBrowserHeaders = request.headers.get("accept-language") && request.headers.get("sec-fetch-site");
          const notHosting = !HOSTING.test(org);

      if (isPage && looksLikeBrowser && hasBrowserHeaders && notHosting && env.VISITS) {
              const visit = {
                        time: new Date().toISOString(),
                        page: new URL(request.url).pathname,
                        city: cf.city || "unknown",
                        region: cf.region || "unknown",
                        country: cf.country || "unknown",
                        org: org || "unknown",
                        referrer: request.headers.get("referer") || "direct",
              };
              const key = `${visit.time}_${crypto.randomUUID().slice(0, 8)}`;
              ctx.waitUntil(env.VISITS.put(key, JSON.stringify(visit), { expirationTtl: 60 * 60 * 24 * 90 }));
      }
          return response;
    },
};
