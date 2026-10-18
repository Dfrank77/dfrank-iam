// Serves the site normally, and saves each real page visit to Workers KV.
// Filters out bots, scrapers, and traffic from hosting networks.

const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|headless|monitor|scan|check|http-client|axios|fetch\//i;

const HOSTING = /(amazon|google llc|microsoft|oracle|digitalocean|linode|ovh|hetzner|m247|vultr|contabo|choopa|datacamp|leaseweb|psychz|cogent|hurricane electric|internap|rackspace|packet|equinix|servercentral|colocrossing|1337 services|custodian|collyer quay|techoff|fine group|sundance international|techties|code200|tzulo|palo alto networks|tor|private internet|nord|surfshark|mullvad|cyberghost|datacenter|hosting|server|cloud|vps)/i;

// "2026-10-17 11:25" in Denver time, so keys sort by time and read at a glance.
function denverTime(date) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Denver",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(date).map((p) => [p.type, p.value])
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

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
      const now = new Date();
      const visit = {
        time: now.toISOString(),
        page: new URL(request.url).pathname,
        city: cf.city || "unknown",
        region: cf.region || "unknown",
        country: cf.country || "unknown",
        org: org || "unknown",
        referrer: request.headers.get("referer") || "direct",
      };
      // Readable key, e.g. "2026-10-17 11:25 MT | Phoenix, Arizona, US | Comcast Cable | / | 1a2b3c4d"
      const key = [
        `${denverTime(now)} MT`,
        `${visit.city}, ${visit.region}, ${visit.country}`,
        visit.org,
        visit.page,
        crypto.randomUUID().slice(0, 8),
      ].join(" | ").slice(0, 500);
      ctx.waitUntil(env.VISITS.put(key, JSON.stringify(visit), { expirationTtl: 60 * 60 * 24 * 90 }));
    }
    return response;
  },
};
