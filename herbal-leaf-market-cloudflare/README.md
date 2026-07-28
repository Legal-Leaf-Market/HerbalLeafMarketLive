# Herbal Leaf Market — Cloudflare Workers

Full port of your Apps Script project to Cloudflare (static assets + Worker API).
Your real `index.html` is now included and wired up — no placeholder.

## File map: Apps Script → this project
| Apps Script | Here | Notes |
|---|---|---|
| `code.gs` | `src/index.js` | backend; duplicate `hlmWatchItem` removed (keeps always-email) |
| `appsscript.json` | `wrangler.toml` | timezone/scopes/webapp → Worker config |
| `index.html` | `public/index.html` | your real storefront; 5 GAS hooks fixed (see below) |
| `apps.html` (`<script>`) | `public/app.js` | storefront/cart/garden/checkout logic |
| `products.html` (`<script>`) | `public/products.js` | SEED CATALOG |
| `knowledge.html` (`<script>`) | `public/knowledge.js` | admin Knowledge Matrix |
| `admin.html` | `public/admin.html` | `<?= baseUrl ?>`→`/`, `include('knowledge')`→`<script src>`, shim added |
| `know-the-facts.html` | `public/know-the-facts.html` | standalone, unchanged |
| `anecdote-library.html` | `public/anecdote-library.html` | standalone, unchanged |
| `facts.html` / `stories.html` | `public/*.html` | redirects → the two pages above (keeps `?page=` working) |
| — | `public/hlm-api.js` | recreates `google.script.run` against `/api/rpc` |
| — | `public/sw.js` | raw service worker (fixes old `self is not defined`) |
| — | `public/manifest.json` | PWA manifest (`<head>` referenced `?asset=manifest`) |

## The 5 fixes applied to your index.html
1. `href="?asset=manifest"` → `href="/manifest.json"`
2. `register("?asset=sw")` → `register("/sw.js")`
3. header/footer/mobile-nav `<?= baseUrl ?>?page=facts` → `/know-the-facts.html`
4. …`?page=stories` → `/anecdote-library.html`
5. bottom `<?!= include('products'/'knowledge'/'app'); ?>` → real `<script src>` tags,
   with `/hlm-api.js` loaded FIRST so `google.script.run` exists.

## ⚠️ Add two icon files
Your `<head>` and `manifest.json` reference `/icon-192.png` and `/icon-512.png`
(absolute `https://herballeafmarket.com/...`). Drop `icon-192.png` and `icon-512.png`
into `public/` so the PWA install + social share images work.

## Service mapping
- Sheets → **D1** (`HLM_DB`), PropertiesService → **KV** (`HLM_KV`) + secrets,
  CacheService → **KV** (6h TTL), MailApp → **Resend**, triggers → **cron**, routing → **static assets**.

## Deploy
```bash
npm install
npx wrangler login
npx wrangler d1 create herbal-leaf-market   # paste database_id into wrangler.toml
npm run db:init
npx wrangler kv namespace create HLM_KV     # paste id into wrangler.toml
npx wrangler secret put ADMIN_PW
npx wrangler secret put RESEND_API_KEY       # verify your domain in Resend first
npx wrangler secret put SITE_FROM_EMAIL      # "Herbal Leaf Market <hello@herballeafmarket.com>"
npx wrangler secret put REPORT_EMAIL
npm run deploy
```
Local dev: `npm run dev` (run `npm run db:init:local` once).

## Endpoints
- `GET /`, `GET /?page=facts|stories|admin` — pages
- `GET /?unsub=<email>` — unsubscribe
- `GET /api/inventory` · `GET /api/nss-ids` — cached inventory / NSS variation map
- `POST /api/rpc` — `{ "fn": "hlmWatchItem", "args": [ {...} ] }`
- `GET /api/health`

Resend needs a verified sending domain; until then `hlmSend_` fails soft (logs, returns false).
