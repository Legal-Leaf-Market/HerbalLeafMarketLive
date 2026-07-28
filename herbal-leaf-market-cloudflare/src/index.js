/*** Herbal Leaf Market — Cloudflare Worker backend (index.js)
 *   Ported from Apps Script code.gs. Service mapping:
 *     SpreadsheetApp (Members/Clicks)  -> D1  (env.HLM_DB)
 *     PropertiesService (rules/config) -> KV  (env.HLM_KV) + secrets
 *     CacheService (inventory cache)   -> KV  (env.HLM_KV) with expirationTtl
 *     MailApp.sendEmail                -> Resend HTTP API (env.RESEND_API_KEY)
 *     ScriptApp time triggers          -> Cron triggers (wrangler.toml) -> scheduled()
 *     HtmlService page routing         -> static assets (env.ASSETS) + fetch router
 *   Client contract preserved via /api/rpc + public/hlm-api.js shim.
 ***/
///
const SITE_NAME    = "Herbal Leaf Market";
const SITE_FROM    = "Herbal Leaf Market";
const CONTACT_EMAIL = "hello@herballeafmarket.com";
const SITE_URL     = "https://herballeafmarket.com";

const SHOPIFY_STORES = [
  { vendor: "Puff Herbals",    domain: "https://puffherbals.com",       prefix: "puff" },
  { vendor: "Secret Nature",   domain: "https://secretnature.com",      prefix: "sn"   },
  { vendor: "Soul CBD",        domain: "https://mysoulcbd.com",         prefix: "soul" },
  { vendor: "Charlotte's Web", domain: "https://www.charlottesweb.com", prefix: "cw"   }
];
const NSS_ORIGIN = "https://www.smokingblends.com";

const HLM_DEFAULT_RULES = {
  evidenceFloor: "traditional", itemsPerRitual: 3, preferInStock: true,
  showEvidenceBadges: true, crossSellCBD: true,
  goalsEnabled: { calm: true, sleep: true, focus: true, ritual: true },
  coupons: { "Bear Blend": 10, "Puff Herbals": 15, "Secret Nature": 15, "Soul CBD": 20, "Natural Smoke Shop": 10, "Charlotte's Web": 0 }
};

/* ============================ ENTRYPOINTS ============================ */
export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const p = url.pathname;

      if (url.searchParams.has("unsub")) {
        const html = await hlmUnsubscribe_(env, url.searchParams.get("unsub"));
        return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (p === "/api/rpc" && request.method === "POST")  return json(await rpc(request, env, ctx));
      if (p === "/api/inventory")                         return json(await getInventory(env, ctx));
      if (p === "/api/nss-ids")                           return json(await getSmokingBlendsIds(env, ctx, null));
      if (p === "/api/health")                            return json({ ok: true, site: SITE_NAME, ts: Date.now() });

      // Back-compat for old ?page= links.
      const page = (url.searchParams.get("page") || "").toLowerCase();
      if (page && p === "/") {
        const map = { facts: "/facts.html", stories: "/stories.html", admin: "/admin.html", home: "/index.html" };
        const target = map[page] || "/index.html";
        return env.ASSETS.fetch(new Request(new URL(target, url.origin), request));
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return json({ ok: false, error: String(e) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    try {
      if (controller.cron === "0 12 * * 1") ctx.waitUntil(hlmSendWeeklyClickReport(env));
      if (controller.cron === "0 13 * * 1") ctx.waitUntil(hlmSendWeeklyDigest(env));
    } catch (e) {}
  }
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
  });
}

/* ============================ RPC DISPATCH ============================ */
const RPC = {
  hlmWatchItem, hlmCreateAccount, hlmLogClick, hlmGetRules, hlmGetMatrix,
  getInventory: (env, ctx) => getInventory(env, ctx),
  refreshInventory, getSmokingBlendsIds: (env, ctx, a) => getSmokingBlendsIds(env, ctx, a && a[0]),
  refreshSmokingBlendsIds, hlmGetClickStats,
  hlmAdminData, hlmSaveRules, hlmSaveMatrixOverrides, hlmGetMatrixOverrides,
  hlmSendWeeklyDigest, hlmSendWeeklyClickReport, hlmGardenSelfTest
};
async function rpc(request, env, ctx) {
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const fn = String(body.fn || "");
  const args = Array.isArray(body.args) ? body.args : [];
  const handler = RPC[fn];
  if (!handler) return { ok: false, error: "unknown function: " + fn };
  return await handler(env, ctx, args);
}

/* ============================ INVENTORY ============================ */
async function getInventory(env, ctx) {
  const cached = await kvGet(env, "hlm_live_v3");
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  let out = [];
  try {
    const resps = await Promise.all(SHOPIFY_STORES.map(s =>
      fetch(s.domain + "/products.json?limit=250", {
        headers: { "Accept": "application/json", "User-Agent": "Mozilla/5.0" }
      }).catch(() => null)
    ));
    for (let i = 0; i < resps.length; i++) {
      const r = resps[i];
      if (!r || r.status !== 200) continue;
      try { const data = await r.json(); out = out.concat(mapShopify_(SHOPIFY_STORES[i], (data && data.products) || [])); }
      catch (e2) {}
    }
  } catch (e) {}
  if (out.length) { await kvPut(env, "hlm_live_v3", JSON.stringify(out), 21600); }
  return out;
}
async function refreshInventory(env, ctx) {
  await kvDel(env, "hlm_live_v3");
  const n = (await getInventory(env, ctx)).length;
  return n + " products cached.";
}
function mapShopify_(store, products) {
  const out = [];
  (products || []).forEach(function (p) {
    if (!p || !p.handle) return;
    const img = (p.images && p.images[0] && p.images[0].src) ? p.images[0].src : "";
    const vars = (p.variants || []).map(v => ({
      id: String(v.id),
      title: (v.title && v.title !== "Default Title") ? v.title : "",
      price: Number(v.price) || 0,
      available: v.available !== false
    }));
    const prices = vars.map(v => v.price).filter(n => n > 0);
    const minP = prices.length ? Math.min.apply(null, prices) : 0;
    const anyAvail = vars.some(v => v.available);
    let blurb = String(p.body_html || "").replace(/<[^>]*>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
    if (blurb.length > 160) blurb = blurb.slice(0, 157) + "...";
    out.push({
      id: store.prefix + "-" + p.handle, vendor: store.vendor, name: p.title || "",
      category: p.product_type || "", image: img, price: minP,
      unit: (vars.length > 1) ? "from" : "", blurb: blurb,
      url: store.domain + "/products/" + p.handle, badge: "", inStock: anyAvail, variants: vars
    });
  });
  return out;
}

async function getSmokingBlendsIds(env, ctx, slugs) {
  const key = "nss_ids_v3";
  const cached = await kvGet(env, key);
  if (cached) { try { return JSON.parse(cached); } catch (e) {} }
  if (!slugs || !slugs.length) { slugs = await nssCrawlSlugs_(); }
  const map = {};
  try {
    const resps = await Promise.all(slugs.map(s =>
      fetch(NSS_ORIGIN + "/product/" + s + "/", {
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "text/html" }
      }).catch(() => null)
    ));
    for (let i = 0; i < resps.length; i++) {
      const r = resps[i];
      if (!r || r.status !== 200) continue;
      try { const list = parseVariationsFromHtml_(await r.text()); if (list && list.length) map[slugs[i]] = list; }
      catch (e2) {}
    }
  } catch (e) {}
  if (Object.keys(map).length) { await kvPut(env, key, JSON.stringify(map), 21600); }
  return map;
}
async function refreshSmokingBlendsIds(env, ctx) {
  await kvDel(env, "nss_ids_v3");
  const m = await getSmokingBlendsIds(env, ctx, null);
  return Object.keys(m).length + " NSS products mapped.";
}
function parseVariationsFromHtml_(html) {
  const out = [];
  if (!html) return out;
  const m = html.match(/data-product_variations\s*=\s*(['"])(.*?)\1/is);
  if (!m || !m[2] || m[2] === "false") return out;
  const jsonStr = m[2].replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  let arr; try { arr = JSON.parse(jsonStr); } catch (e) { return out; }
  (arr || []).forEach(function (v) {
    const vid = v.variation_id || v.id; if (!vid) return;
    let size = "";
    if (v.attributes) { for (const k in v.attributes) { if (v.attributes[k]) { size = String(v.attributes[k]); break; } } }
    const price = Number(v.display_price != null ? v.display_price : v.display_regular_price) || 0;
    out.push({ id: vid, price: price, size: size });
  });
  return out;
}
async function nssCrawlSlugs_() {
  const slugs = [];
  try {
    for (let page = 1; page <= 4; page++) {
      const r = await fetch(NSS_ORIGIN + "/wp-json/wc/store/v1/products?per_page=100&page=" + page, {
        headers: { "Accept": "application/json" }
      });
      if (r.status !== 200) break;
      const arr = await r.json();
      if (!arr || !arr.length) break;
      arr.forEach(p => { if (p && p.slug && p.type === "variable") slugs.push(p.slug); });
      if (arr.length < 100) break;
    }
  } catch (e) {}
  return slugs;
}

/* ============================ ADMIN / RULES (KV) ============================ */
function hlmCheckAdmin_(env, pw) {
  const real = (env.ADMIN_PW || "");
  return real !== "" && String(pw) === real;
}
async function hlmGetRules(env) {
  try {
    const s = await kvGet(env, "HLM_RULES");
    if (s) {
      const r = JSON.parse(s);
      for (const k in HLM_DEFAULT_RULES) { if (r[k] === undefined) r[k] = HLM_DEFAULT_RULES[k]; }
      return r;
    }
  } catch (e) {}
  return HLM_DEFAULT_RULES;
}
async function hlmSaveRules(env, ctx, args) {
  const pw = args[0], rules = args[1];
  if (!hlmCheckAdmin_(env, pw)) return { ok: false, error: "unauthorized" };
  try { await kvPut(env, "HLM_RULES", JSON.stringify(rules || {})); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}
async function hlmGetMatrixOverrides(env) {
  try { const s = await kvGet(env, "HLM_MATRIX_OV"); return s ? JSON.parse(s) : {}; }
  catch (e) { return {}; }
}
async function hlmSaveMatrixOverrides(env, ctx, args) {
  const pw = args[0], ov = args[1];
  if (!hlmCheckAdmin_(env, pw)) return { ok: false, error: "unauthorized" };
  try { await kvPut(env, "HLM_MATRIX_OV", JSON.stringify(ov || {})); return { ok: true }; }
  catch (e) { return { ok: false, error: String(e) }; }
}
async function hlmGetMatrix(env) {
  return { overrides: await hlmGetMatrixOverrides(env), rules: await hlmGetRules(env) };
}
async function hlmAdminData(env, ctx, args) {
  const pw = args[0];
  if (!hlmCheckAdmin_(env, pw)) return { ok: false, error: "unauthorized" };
  let members = 0, unsub = 0;
  try {
    const r = await env.HLM_DB.prepare(
      "SELECT COUNT(*) AS n, SUM(CASE WHEN unsubscribed='unsub' THEN 1 ELSE 0 END) AS u FROM members"
    ).first();
    members = (r && r.n) || 0; unsub = (r && r.u) || 0;
  } catch (e) {}
  let clicks = null;
  try { clicks = await hlmClickStats_(env, 7); } catch (e) {}
  return { ok: true, rules: await hlmGetRules(env), overrides: await hlmGetMatrixOverrides(env), members, unsub, clicks };
}

/* ============================ CLICK TRACKER (D1) ============================ */
async function hlmLogClick(env, ctx, args) {
  const payload = (args && args[0]) || {};
  try {
    await env.HLM_DB.prepare(
      "INSERT INTO clicks (ts,type,vendor,product,price,category,page,device,email,ref) VALUES (?,?,?,?,?,?,?,?,?,?)"
    ).bind(
      Date.now(),
      String(payload.type || "outbound").slice(0, 40),
      String(payload.vendor || "").slice(0, 80),
      String(payload.product || "").slice(0, 140),
      Number(payload.price) || 0,
      String(payload.category || "").slice(0, 60),
      String(payload.page || "").slice(0, 60),
      String(payload.device || "").slice(0, 20),
      String(payload.email || "").slice(0, 120),
      String(payload.ref || "").slice(0, 120)
    ).run();
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}
async function hlmClickStats_(env, days) {
  days = days || 7;
  const since = Date.now() - days * 86400000;
  const rows = (await env.HLM_DB.prepare(
    "SELECT type,vendor,product FROM clicks WHERE ts >= ?"
  ).bind(since).all()).results || [];
  let total = 0; const byVendor = {}, byType = {}, prod = {};
  rows.forEach(row => {
    total++;
    const v = row.vendor || "(none)"; byVendor[v] = (byVendor[v] || 0) + 1;
    const t = row.type || "outbound"; byType[t] = (byType[t] || 0) + 1;
    if (row.product) { const key = (row.vendor || "") + " \u2014 " + (row.product || ""); prod[key] = (prod[key] || 0) + 1; }
  });
  const top = Object.keys(prod).map(k => ({ name: k, n: prod[k] })).sort((a, b) => b.n - a.n).slice(0, 10);
  return { total, byVendor, byType, top, days };
}
async function hlmGetClickStats(env, ctx, args) { return await hlmClickStats_(env, (args && args[0]) || 7); }

async function hlmSendWeeklyClickReport(env) {
  const s = await hlmClickStats_(env, 7);
  const vend = Object.keys(s.byVendor).map(k => ({ k, n: s.byVendor[k] })).sort((a, b) => b.n - a.n);
  const vrows = vend.map(r => '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">' + hlmEsc_(r.k) + '</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:700">' + r.n + '</td></tr>').join("")
    || '<tr><td style="padding:10px;color:#6d6a58">No clicks yet.</td></tr>';
  const prows = s.top.map(r => '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">' + hlmEsc_(r.name) + '</td><td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-weight:700">' + r.n + '</td></tr>').join("");
  const html = '<!DOCTYPE html><html><body style="margin:0;background:#f1ead9;padding:24px 0"><table role="presentation" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#fdfbf3;border:1px solid #d6c9ac;border-radius:18px;overflow:hidden"><tr><td style="background:linear-gradient(135deg,#3a7b50,#265a39);padding:20px 26px;color:#f5efdd;font:900 20px Georgia,serif">Herbal Leaf Market &mdash; Weekly Click Report</td></tr><tr><td style="padding:22px 26px"><div style="font:800 34px Georgia,serif;color:#2f5d3a">' + s.total + '</div><div style="font:400 14px sans-serif;color:#6d6a58;margin-bottom:14px">outbound clicks in the last 7 days</div><div style="font:700 13px sans-serif;color:#265a39;text-transform:uppercase;letter-spacing:.5px;margin:8px 0 4px">By store (partner leverage)</div><table style="width:100%;border-collapse:collapse;font:14px sans-serif">' + vrows + '</table>' + (prows ? ('<div style="font:700 13px sans-serif;color:#265a39;text-transform:uppercase;letter-spacing:.5px;margin:16px 0 4px">Top products clicked</div><table style="width:100%;border-collapse:collapse;font:14px sans-serif">' + prows + '</table>') : '') + '</td></tr></table></body></html>';
  const to = env.REPORT_EMAIL || CONTACT_EMAIL;
  await hlmSend_(env, to, "\uD83D\uDCC8 HLM weekly click report \u2014 " + s.total + " clicks", html);
  return s.total + " clicks reported.";
}

/* ============================ MEMBERS / GARDEN (D1) ============================ */
function hlmValidEmail_(e) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || "")); }
async function hlmGetMember_(env, email) {
  return await env.HLM_DB.prepare("SELECT * FROM members WHERE email = ?").bind(email).first();
}

async function hlmCreateAccount(env, ctx, args) {
  const payload = (args && args[0]) || {};
  try {
    const email = String(payload.email || "").trim().toLowerCase();
    if (!hlmValidEmail_(email)) return { ok: false, error: "invalid email" };
    const name = String(payload.name || "").trim();
    const items = Array.isArray(payload.items) ? payload.items : [];
    const consent = payload.consent ? "yes" : "no";
    const now = Date.now();

    let member = await hlmGetMember_(env, email);
    let notified = {};
    if (member) {
      let cur = {}; try { cur = JSON.parse(member.garden || "{}"); } catch (e) {}
      try { notified = JSON.parse(member.notified || "{}"); } catch (e) {}
      items.forEach(it => { if (it && it.id) cur[it.id] = it; });
      const newName = name || member.name || "";
      const newConsent = (consent === "yes") ? "yes" : (member.consent || "no");
      await env.HLM_DB.prepare(
        "UPDATE members SET name=?, garden=?, consent=?, unsubscribed='' WHERE email=?"
      ).bind(newName, JSON.stringify(cur), newConsent, email).run();
      member = await hlmGetMember_(env, email);
    } else {
      const g = {}; items.forEach(it => { if (it && it.id) g[it.id] = it; });
      await env.HLM_DB.prepare(
        "INSERT INTO members (email,name,joined,garden,notified,consent,unsubscribed,last_email) VALUES (?,?,?,?,?,?,?,?)"
      ).bind(email, name, now, JSON.stringify(g), "{}", consent, "", 0).run();
      member = await hlmGetMember_(env, email);
    }

    if (String(member.unsubscribed || "") !== "unsub") {
      await hlmSendWelcome_(env, email, name, items, notified);
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: String(e) }; }
}

/* CLEANED: single hlmWatchItem — ALWAYS emails on every save (dedupe removed). */
async function hlmWatchItem(env, ctx, args) {
  const payload = (args && args[0]) || {};
  try {
    const email = String(payload.email || "").trim().toLowerCase();
    const it = payload.item || {};
    if (!hlmValidEmail_(email) || !it || !it.id) return { ok: false };

    let member = await hlmGetMember_(env, email);
    if (!member) {
      return await hlmCreateAccount(env, ctx, [{ email, name: payload.name || "", items: [it], consent: true }]);
    }
    if (String(member.unsubscribed || "") === "unsub") return { ok: false, error: "unsubscribed" };

    let garden = {}, notified = {};
    try { garden = JSON.parse(member.garden || "{}"); } catch (e) {}
    try { notified = JSON.parse(member.notified || "{}"); } catch (e) {}

    garden[it.id] = it;

    const sent = await hlmSend_(env, email,
      "\uD83C\uDF3F You're tracking " + (it.name || "an item") + " on " + SITE_NAME,
      hlmEmailShell_(env, "You're tracking a new find \uD83C\uDF3F",
        "We'll keep this in your Garden. Here's what you saved:",
        hlmItemCardHtml_(it), email));

    notified[it.id] = (notified[it.id] || 0) + 1; // count only; no longer gates sending
    await env.HLM_DB.prepare(
      "UPDATE members SET garden=?, notified=?, last_email=? WHERE email=?"
    ).bind(JSON.stringify(garden), JSON.stringify(notified), Date.now(), email).run();

    return { ok: true, emailed: sent };
  } catch (e) { return { ok: false, error: String(e) }; }
}

async function hlmSendWelcome_(env, email, name, items, notified) {
  const hi = name ? ("Welcome, " + name.split(" ")[0] + "!") : "Welcome to your Garden!";
  const cards = (items && items.length)
    ? items.map(it => hlmItemCardHtml_(it)).join("")
    : '<tr><td style="padding:14px;color:#6d6a58;font:15px sans-serif">Your Garden is ready \u2014 tap the \u2764 on any product to grow it.</td></tr>';
  await hlmSend_(env, email, "\uD83C\uDF3F Your Herbal Leaf Market Garden",
    hlmEmailShell_(env, hi, "Your saved botanicals are below. We'll email you when you track new finds.", cards, email));
  try {
    const n = notified || {};
    (items || []).forEach(it => { if (it && it.id) n[it.id] = 1; });
    await env.HLM_DB.prepare("UPDATE members SET notified=?, last_email=? WHERE email=?")
      .bind(JSON.stringify(n), Date.now(), email).run();
  } catch (e) {}
}

async function hlmUnsubscribe_(env, email) {
  email = String(email || "").trim().toLowerCase();
  try {
    const m = await hlmGetMember_(env, email);
    if (m) await env.HLM_DB.prepare("UPDATE members SET unsubscribed='unsub' WHERE email=?").bind(email).run();
  } catch (e) {}
  return '<div style="font:16px sans-serif;max-width:520px;margin:60px auto;text-align:center;color:#22271e"><h2 style="font-family:Georgia,serif;color:#2f5d3a">You\'re unsubscribed \uD83C\uDF3F</h2><p>' + hlmEsc_(email) + ' will no longer receive Garden emails.</p></div>';
}

async function hlmSendWeeklyDigest(env) {
  const rows = (await env.HLM_DB.prepare("SELECT * FROM members").all()).results || [];
  let sent = 0;
  for (const m of rows) {
    const email = String(m.email).toLowerCase();
    if (!hlmValidEmail_(email)) continue;
    if (String(m.consent || "") !== "yes" || String(m.unsubscribed || "") === "unsub") continue;
    let garden = {}; try { garden = JSON.parse(m.garden || "{}"); } catch (e) {}
    const items = Object.keys(garden).map(k => garden[k]);
    if (!items.length) continue;
    const name = String(m.name || "");
    const cards = items.slice(0, 12).map(it => hlmItemCardHtml_(it)).join("");
    const hi = name ? ("Your Garden this week, " + name.split(" ")[0]) : "Your Garden this week";
    const ok = await hlmSend_(env, email, "\uD83C\uDF3F Your Herbal Leaf Market Garden \u2014 weekly recap",
      hlmEmailShell_(env, hi, "Here are the botanicals you're growing. Ready to bring any home?", cards, email));
    if (ok) { sent++; try { await env.HLM_DB.prepare("UPDATE members SET last_email=? WHERE email=?").bind(Date.now(), email).run(); } catch (e) {} }
  }
  return sent + " digest email(s) sent.";
}

async function hlmGardenSelfTest(env, ctx, args) {
  const me = env.REPORT_EMAIL || CONTACT_EMAIL;
  return await hlmCreateAccount(env, ctx, [{
    email: me, name: "Test Gardener", consent: true,
    items: [{
      id: "demo1", name: "Calm CBD Gummies", vendor: "Charlotte's Web", price: 49.99,
      image: "https://herballeafmarket.com/icon-192.png", url: "https://www.charlottesweb.com/",
      blurb: "Full-spectrum CBD gummies with lemon balm."
    }]
  }]);
}

/* ============================ EMAIL (Resend) ============================ */
function hlmSafeUrl_(u) {
  u = String(u || "");
  if (!u || u === "#") return SITE_URL;
  if (/^https?:\/\//i.test(u)) return u;
  if (u.charAt(0) === "/") return SITE_URL + u;
  return SITE_URL;
}
function hlmItemCardHtml_(it) {
  it = it || {};
  const url = hlmSafeUrl_(it.url); const urlE = hlmEsc_(url);
  const imgInner = it.image
    ? ('<img src="' + hlmEsc_(it.image) + '" width="120" height="120" alt="' + hlmEsc_(it.name) + '" style="display:block;width:120px;height:120px;object-fit:cover;border-radius:12px;border:1px solid #e0d3bd" />')
    : '<div style="width:120px;height:120px;border-radius:12px;background:#eef0e2"></div>';
  const img = '<a href="' + urlE + '" target="_blank" style="text-decoration:none">' + imgInner + '</a>';
  const price = (Number(it.price) || 0) > 0 ? ('$' + (Number(it.price).toFixed(2)) + (it.unit === "from" ? " +" : "")) : "";
  const cta = '<a href="' + urlE + '" target="_blank" style="display:inline-block;margin-top:8px;background:#c85a34;color:#ffffff;text-decoration:none;font:700 13px sans-serif;padding:10px 18px;border-radius:999px">View / Shop &rarr;</a>';
  return '<tr><td style="padding:12px 0;border-bottom:1px solid #eee"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%"><tr><td valign="top" style="width:132px">' + img + '</td><td valign="top" style="padding-left:14px"><div style="font:700 11px sans-serif;letter-spacing:.6px;text-transform:uppercase;color:#265a39">' + hlmEsc_(it.vendor || "") + '</div><div style="font:700 17px Georgia,serif;color:#22271e;margin:2px 0 4px"><a href="' + urlE + '" target="_blank" style="color:#22271e;text-decoration:none">' + hlmEsc_(it.name || "") + '</a></div>' + (price ? ('<div style="font:800 16px Georgia,serif;color:#1f6b52">' + price + '</div>') : '') + (it.blurb ? ('<div style="font:400 13px sans-serif;color:#6d6a58;line-height:1.5;margin-top:4px">' + hlmEsc_(String(it.blurb).slice(0, 150)) + '</div>') : '') + cta + '</td></tr></table></td></tr>';
}
function hlmEmailShell_(env, heading, intro, cardsHtml, email) {
  let unsub = "";
  try { unsub = (env.PUBLIC_URL || SITE_URL) + "/?unsub=" + encodeURIComponent(email); }
  catch (e) { unsub = "mailto:" + CONTACT_EMAIL + "?subject=unsubscribe"; }
  return '<!DOCTYPE html><html><body style="margin:0;background:#f1ead9;padding:24px 0"><table role="presentation" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#fdfbf3;border:1px solid #d6c9ac;border-radius:18px;overflow:hidden"><tr><td style="background:linear-gradient(135deg,#3a7b50,#265a39);padding:22px 26px"><div style="font:900 20px Georgia,serif;color:#f5efdd">Herbal Leaf Market</div><div style="font:italic 400 12px Georgia,serif;color:#c9962f;letter-spacing:2px;text-transform:uppercase">botanical apothecary</div></td></tr><tr><td style="padding:24px 26px 6px"><div style="font:900 22px Georgia,serif;color:#2f5d3a">' + hlmEsc_(heading) + '</div><div style="font:400 15px sans-serif;color:#6d6a58;margin:6px 0 8px;line-height:1.5">' + hlmEsc_(intro) + '</div></td></tr><tr><td style="padding:0 26px 18px"><table role="presentation" cellpadding="0" cellspacing="0" style="width:100%">' + cardsHtml + '</table></td></tr><tr><td style="padding:16px 26px;background:#f6f1e4;border-top:1px solid #e6dcc4"><div style="font:400 11px sans-serif;color:#9c9a84;line-height:1.6">You are receiving this because you created or updated a Garden at Herbal Leaf Market. We link you to independent makers; you complete purchases on their sites. Statements have not been evaluated by the FDA and are not intended to diagnose, treat, cure, or prevent any disease. 21+. <a href="' + hlmEsc_(unsub) + '" style="color:#9c3d1a">Unsubscribe</a>.</div></td></tr></table></body></html>';
}
function hlmEsc_(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
async function hlmSend_(env, to, subject, html) {
  try {
    if (!env.RESEND_API_KEY) { console.log("RESEND_API_KEY missing; skipping send to " + to); return false; }
    const from = env.SITE_FROM_EMAIL || (SITE_FROM + " <" + CONTACT_EMAIL + ">");
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, subject, html })
    });
    if (r.status >= 200 && r.status < 300) return true;
    console.log("send error " + r.status + ": " + (await r.text()));
    return false;
  } catch (e) { console.log("send error: " + e); return false; }
}

/* ============================ KV helpers ============================ */
async function kvPut(env, key, val, ttl) { await env.HLM_KV.put(key, val, ttl ? { expirationTtl: ttl } : undefined); }
async function kvGet(env, key) { return await env.HLM_KV.get(key); }
async function kvDel(env, key) { await env.HLM_KV.delete(key); }
