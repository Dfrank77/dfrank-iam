// Serves the site normally, and saves page views to Workers KV.
// Bots are not saved at all. Every other view is saved and labeled so real readers stand out.
//   visitor          a real browser that engaged with the page (stayed visible 3s, or scrolled, clicked, tapped, typed)
//   no-engagement    looked like a browser on a normal network, but never engaged (mostly disguised crawlers)
//   hosting-network  looked like a browser on a VPN, relay, cloud or big-company network, and never engaged
//   (bot)            crawlers, link previews, scripts, anything that doesn't look like a browser: served, never saved
//
// How "visitor" gets earned: every page gets a tiny script added on the way out. When the reader
// engages, the script sends this view's key back to /__engaged, and the entry is relabeled "visitor".

const BOTS = /bot|crawl|spider|slurp|preview|facebookexternalhit|curl|wget|python|headless|monitor|scan|check|http-client|axios|fetch\//i;

// Whole words only, so "tor" no longer matches names like "Victoria".
const HOSTING = /\b(amazon|google llc|google cloud|microsoft|oracle|digitalocean|linode|ovh|hetzner|m247|vultr|contabo|choopa|datacamp|leaseweb|psychz|cogent|hurricane electric|internap|rackspace|packet|equinix|servercentral|colocrossing|1337 services|custodian|collyer quay|techoff|fine group|sundance international|techties|code200|tzulo|palo alto networks|tor|private internet|nord|surfshark|mullvad|cyberghost|cloudflare|akamai|fastly|datacenter|data center|hosting|server|servers|cloud|vps)\b/i;

const ENGAGED_PATH = "/__engaged";
const KEEP_FOR = 60 * 60 * 24 * 90; // 90 days

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

// First-pass label from the page request alone. Only "bot" is final here;
// the other two get upgraded to "visitor" if the engagement signal comes back.
function classify(request) {
  const ua = request.headers.get("user-agent") || "";
  const org = (request.cf || {}).asOrganization || "";
  const looksLikeBrowser = /mozilla.*(chrome|safari|firefox|edg)/i.test(ua) && !BOTS.test(ua);
  const hasBrowserHeaders = Boolean(request.headers.get("accept-language") && request.headers.get("sec-fetch-site"));
  if (!looksLikeBrowser || !hasBrowserHeaders) return "bot";
  if (HOSTING.test(org)) return "hosting-network";
  return "no-engagement";
}

function buildKey(time, kind, visit, id) {
  return [
    `${denverTime(time)} MT`,
    kind,
    `${visit.city}, ${visit.region}, ${visit.country}`,
    visit.org,
    visit.page,
    id,
  ].join(" | ").slice(0, 500);
}

// The script added to every non-bot page. Fires once: after 3 seconds of the tab
// actually being on screen, or on the first scroll, click, tap or keypress.
function engagementScript(key) {
  // JSON.stringify makes it a safe JS string; escaping "<" stops a "</script>" in a city or org name breaking out.
  const k = JSON.stringify(key).replace(/</g, "\\u003c");
  return `<script>
(function(){
  var key=${k},sent=false,timer=null;
  function send(){if(sent)return;sent=true;navigator.sendBeacon("${ENGAGED_PATH}",key);}
  function watch(){
    if(document.visibilityState==="visible"){if(!timer)timer=setTimeout(send,3000);}
    else if(timer){clearTimeout(timer);timer=null;}
  }
  document.addEventListener("visibilitychange",watch);watch();
  ["scroll","pointerdown","keydown","touchstart"].forEach(function(e){
    addEventListener(e,send,{once:true,passive:true});
  });
})();
</script>`;
}

// Relabel one saved view as "visitor". The key itself is the proof: it has a random
// ending and only the browser that loaded that page ever saw it.
async function markEngaged(key, env) {
  const saved = key && (await env.VISITS.get(key));
  if (!saved) return; // unknown key, or KV hasn't caught up yet: leave it as it was
  const visit = JSON.parse(saved);
  if (visit.kind !== "no-engagement" && visit.kind !== "hosting-network") return; // bots and repeats stay put

  const network = visit.kind === "hosting-network" ? "hosting" : "normal";
  const updated = { ...visit, kind: "visitor", network, engagedAt: new Date().toISOString() };
  const newKey = buildKey(new Date(visit.time), "visitor", visit, key.split(" | ").pop());
  await env.VISITS.put(newKey, JSON.stringify(updated), { expirationTtl: KEEP_FOR });
  await env.VISITS.delete(key);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === ENGAGED_PATH) {
      // Read the key now: the request body can't be read after the reply has gone out.
      if (request.method === "POST" && env.VISITS) {
        const key = (await request.text()).slice(0, 500);
        ctx.waitUntil(markEngaged(key, env));
      }
      return new Response(null, { status: 204 });
    }

    // For page loads, ask for the full page instead of "has it changed?".
    // A browser's cached copy would carry an old key, so every load needs a fresh one.
    let assetRequest = request;
    if ((request.headers.get("accept") || "").includes("text/html")) {
      const headers = new Headers(request.headers);
      headers.delete("if-none-match");
      headers.delete("if-modified-since");
      assetRequest = new Request(request, { headers });
    }

    const response = await env.ASSETS.fetch(assetRequest);
    const type = response.headers.get("content-type") || "";
    const isPage = request.method === "GET" && response.status === 200 && type.includes("text/html");
    if (!isPage || !env.VISITS) return response;

    const kind = classify(request);
    if (kind === "bot") return response; // bots get the page but are not saved

    const cf = request.cf || {};
    const now = new Date();
    const visit = {
      time: now.toISOString(),
      kind,
      page: url.pathname,
      city: cf.city || "unknown",
      region: cf.region || "unknown",
      country: cf.country || "unknown",
      org: cf.asOrganization || "unknown",
      referrer: request.headers.get("referer") || "direct",
      userAgent: (request.headers.get("user-agent") || "none").slice(0, 300),
    };
    // Readable key, e.g. "2026-10-17 11:25 MT | visitor | Phoenix, Arizona, US | Comcast Cable | / | 1a2b3c4d"
    const key = buildKey(now, kind, visit, crypto.randomUUID().slice(0, 8));
    ctx.waitUntil(env.VISITS.put(key, JSON.stringify(visit), { expirationTtl: KEEP_FOR }));

    // Pages with a key in them must never be cached, or two loads would share one key.
    const page = new Response(response.body, response);
    page.headers.set("cache-control", "no-store");
    page.headers.delete("etag");
    page.headers.delete("last-modified");
    return new HTMLRewriter()
      .on("body", { element(el) { el.append(engagementScript(key), { html: true }); } })
      .transform(page);
  },
};
