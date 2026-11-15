// Serves the site normally, and saves every page view to Workers KV.
// Nothing is thrown away: each view is labeled so real readers can be told apart from the rest.
//   visitor          a normal browser on a normal network (home, mobile, office)
//   hosting-network  a normal browser on a VPN, relay, cloud desktop or big-company network
//   bot              crawlers, link previews, scripts, anything that doesn't look like a browser

const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|headless|monitor|scan|check|http-client|axios|fetch\//i;

// Whole words only, so "tor" no longer matches names like "Victoria".
const HOSTING = /\b(amazon|google llc|google cloud|microsoft|oracle|digitalocean|linode|ovh|hetzner|m247|vultr|contabo|choopa|datacamp|leaseweb|psychz|cogent|hurricane electric|internap|rackspace|packet|equinix|servercentral|colocrossing|1337 services|custodian|collyer quay|techoff|fine group|sundance international|techties|code200|tzulo|palo alto networks|tor|private internet|nord|surfshark|mullvad|cyberghost|cloudflare|akamai|fastly|datacenter|data center|hosting|server|servers|cloud|vps)\b/i;

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

function classify(request) {
  const ua = request.headers.get("user-agent") || "";
  const org = (request.cf || {}).asOrganization || "";
  const looksLikeBrowser = /mozilla.*(chrome|safari|firefox|edg)/i.test(ua) && !BOTS.test(ua);
  const hasBrowserHeaders = Boolean(request.headers.get("accept-language") && request.headers.get("sec-fetch-site"));
  if (!looksLikeBrowser || !hasBrowserHeaders) return "bot";
  if (HOSTING.test(org)) return "hosting-network";
  return "visitor";
}

export default {
  async fetch(request, env, ctx) {
    const response = await env.ASSETS.fetch(request);
    const type = response.headers.get("content-type") || "";
    const isPage = request.method === "GET" && type.includes("text/html");

    if (isPage && env.VISITS) {
      const cf = request.cf || {};
      const now = new Date();
      const kind = classify(request);
      const visit = {
        time: now.toISOString(),
        kind,
        page: new URL(request.url).pathname,
        city: cf.city || "unknown",
        region: cf.region || "unknown",
        country: cf.country || "unknown",
        org: cf.asOrganization || "unknown",
        referrer: request.headers.get("referer") || "direct",
        userAgent: (request.headers.get("user-agent") || "none").slice(0, 300),
      };
      // Readable key, e.g. "2026-10-17 11:25 MT | visitor | Phoenix, Arizona, US | Comcast Cable | / | 1a2b3c4d"
      const key = [
        `${denverTime(now)} MT`,
        kind,
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
