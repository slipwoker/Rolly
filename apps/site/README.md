# ROLLY landing page (coming soon + waiting list)

A static page in two languages, each at its own URL: `index.html` is Hebrew at `/` (the source), `en/index.html`
is English at `/en/` (generated). The sky follows the visitor's clock (day 06:00–18:59, night otherwise) and can be
toggled.

- **Editing copy**: all text lives in the `T` dictionary in `index.html`'s script (`he` and `en`). After changing it,
  run `node apps/site/tools/build.mjs` (no dependencies) and commit what it writes: the `<head>` SEO block of both
  pages, `en/index.html` with the English baked into the HTML, `sitemap.xml` and `llms.txt`. Edit layout and styles
  in `index.html` only; `en/index.html` is overwritten on every build.
- **Languages**: a person landing on `/` for the first time goes to `/en/` unless they are in Israel (by time zone);
  the footer links switch language and remember the choice; old `?lang=he|en` links go to that language's URL.
  Crawlers are never redirected, so each URL is indexed in its own language.
- **SEO / GEO**: per page: title, description, canonical, hreflang (he, en, x-default → `/`), Open Graph and Twitter
  cards with `assets/og-he.jpg` / `og-en.jpg`, and JSON-LD (Organization, WebSite, MobileApplication, and the page as
  WebPage + FAQPage with speakable). The visible "questions" section is the FAQ the structured data describes.
  `robots.txt` allows all crawlers including AI assistants, `sitemap.xml` lists both URLs, `llms.txt` is a
  plain-language summary for AI assistants, `site.webmanifest` names the site and its icons.

The driver is the same drawing as the app's `apps/mobile/src/ui/RollyAvatar.tsx`.

- **Waiting list**: the forms post to `POST https://rolly-api.onrender.com/v1/waitlist` (`apps/api/src/waitlist.ts`,
  table `waitlist`). To point the page at another API, add `<meta name="rolly-api" content="https://…">` to the head.
- **Who signed up**: backoffice → Waitlist (`https://rolly-api.onrender.com/admin#/waitlist`, admin token): totals,
  sign-ups per day, sources, search, remove, CSV export. API: `GET /v1/admin/waitlist` (JSON, `?format=csv`) and
  `DELETE /v1/admin/waitlist/:id`.
- **Hosting**: Render Static Site `rolly-site` (publish directory `apps/site`, no build command), served at
  https://heyrolly.ai (DNS on Cloudflare, proxied, SSL mode Full).
- **Social preview**: `assets/og-he.jpg` and `assets/og-en.jpg` are 1200×630 captures of each hero (day sky, nav
  hidden, JPEG so WhatsApp shows them); recapture both when the hero changes. `assets/og.png` is the old
  Hebrew-only capture, kept so links already shared with it keep their preview.
