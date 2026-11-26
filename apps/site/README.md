# ROLLY landing page (coming soon + waiting list)

A single static page, no build step: `index.html` plus `assets/` (favicon, touch icon, social preview `og.png`).
Hebrew, right-to-left. The sky follows the visitor's clock (day 06:00–18:59, night otherwise) and can be toggled.
The driver is the same drawing as the app's `apps/mobile/src/ui/RollyAvatar.tsx`.

- **Waiting list**: the forms post to `POST https://rolly-api.onrender.com/v1/waitlist` (`apps/api/src/waitlist.ts`,
  table `waitlist`). To point the page at another API, add `<meta name="rolly-api" content="https://…">` to the head.
- **Who signed up** (owner, admin token): `GET /v1/admin/waitlist` (JSON) or `GET /v1/admin/waitlist?format=csv`.
- **Hosting**: Render Static Site `rolly-site` (publish directory `apps/site`, no build command), served at https://heyrolly.ai (DNS on Cloudflare: CNAME `@` and `www` → `rolly-site.onrender.com`, DNS only).
- **Social preview**: `assets/og.png` is a 1200×630 capture of the hero; recapture it when the hero changes.
