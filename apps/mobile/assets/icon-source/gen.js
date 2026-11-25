// Generates the ROLLY app icon (light + dark) from the same petals as src/ui/Orb.tsx.
// Run from this folder: node gen.js  (needs Playwright + Chromium); then copy icon-light.png → ../icon.png, icon-dark.png → ../icon-dark.png, icon-splash.png → ../splash-orb.png

const { chromium } = require('playwright');
const S = 1024, C = S / 2;
let R = S * 0.3; // orb radius
const orb = { violet: "#6D28D9", indigo: "#5B21F5", purple: "#9333EA", magenta: "#C026D3", pink: "#DB2777", blush: "#F5C2E7", mist: "#FCE7F3" };
// same petals as src/ui/Orb.tsx, frozen at a pleasing frame (angle + squash)
const P = [
  { a: -35, sx: 1, rx: 0.5, ry: 0.47, dx: 0.04, dy: -0.04, from: orb.indigo, mid: orb.purple, to: orb.blush, o: 0.95 },
  { a: 25, sx: 0.88, rx: 0.48, ry: 0.36, dx: -0.06, dy: 0.02, from: orb.violet, mid: orb.magenta, to: orb.mist, o: 0.6 },
  { a: 110, sx: 0.86, rx: 0.46, ry: 0.32, dx: -0.03, dy: 0.07, from: orb.purple, mid: orb.pink, to: orb.mist, o: 0.5 },
  { a: 205, sx: 0.92, rx: 0.44, ry: 0.4, dx: 0.06, dy: 0.05, from: orb.indigo, mid: orb.magenta, to: orb.blush, o: 0.45 },
  { a: 300, sx: 0.8, rx: 0.42, ry: 0.27, dx: -0.02, dy: -0.07, from: orb.magenta, mid: orb.pink, to: orb.mist, o: 0.4 },
];
function svg(mode) {
  const d = 2 * R;
  const bg = mode === 'light'
    ? `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#F4EFFC"/><stop offset="0.5" stop-color="#FBFAFD"/><stop offset="1" stop-color="#EADFF9"/></linearGradient>
       <radialGradient id="gl1" cx="0.9" cy="0.08" r="0.7"><stop offset="0" stop-color="#C9AEF2" stop-opacity="0.6"/><stop offset="1" stop-color="#C9AEF2" stop-opacity="0"/></radialGradient>
       <radialGradient id="gl2" cx="0.1" cy="0.95" r="0.7"><stop offset="0" stop-color="#E7D3FA" stop-opacity="0.9"/><stop offset="1" stop-color="#E7D3FA" stop-opacity="0"/></radialGradient>`
    : `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#17112A"/><stop offset="0.5" stop-color="#0D0B13"/><stop offset="1" stop-color="#1D1336"/></linearGradient>
       <radialGradient id="gl1" cx="0.9" cy="0.08" r="0.7"><stop offset="0" stop-color="#5B21B6" stop-opacity="0.55"/><stop offset="1" stop-color="#5B21B6" stop-opacity="0"/></radialGradient>
       <radialGradient id="gl2" cx="0.1" cy="0.95" r="0.7"><stop offset="0" stop-color="#3B1C6E" stop-opacity="0.8"/><stop offset="1" stop-color="#3B1C6E" stop-opacity="0"/></radialGradient>`;
  const petals = P.map((p, i) => `
    <linearGradient id="p${i}" gradientUnits="objectBoundingBox" x1="0.85" y1="0.1" x2="0.15" y2="0.95">
      <stop offset="0" stop-color="${p.from}" stop-opacity="${p.o}"/><stop offset="0.5" stop-color="${p.mid}" stop-opacity="${p.o * 0.75}"/><stop offset="1" stop-color="${p.to}" stop-opacity="${p.o * 0.2}"/>
    </linearGradient>`).join('');
  const shapes = P.map((p, i) => `<g transform="translate(${C + p.dx * d} ${C + p.dy * d}) rotate(${p.a}) scale(${p.sx} 1)"><ellipse cx="0" cy="0" rx="${d * p.rx - 3}" ry="${d * p.ry - 3}" fill="url(#p${i})" stroke="#FFFFFF" stroke-opacity="${mode === 'light' ? 0.35 : 0.22}" stroke-width="3"/></g>`).join('');
  const ground = mode !== 'dark'
    ? `<ellipse cx="${C}" cy="${C + R * 1.12}" rx="${R * 0.8}" ry="${R * 0.12}" fill="url(#shadow)"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <defs>${bg}${petals}
    <radialGradient id="core" cx="0.45" cy="0.48" r="0.5"><stop offset="0" stop-color="${orb.pink}" stop-opacity="0.75"/><stop offset="0.55" stop-color="${orb.magenta}" stop-opacity="0.35"/><stop offset="1" stop-color="${orb.magenta}" stop-opacity="0"/></radialGradient>
    <radialGradient id="halo" cx="0.5" cy="0.5" r="0.5"><stop offset="0.55" stop-color="#A855F7" stop-opacity="${mode === 'light' ? 0.22 : 0.35}"/><stop offset="1" stop-color="#A855F7" stop-opacity="0"/></radialGradient>
    <radialGradient id="shadow" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#6D28D9" stop-opacity="0.18"/><stop offset="1" stop-color="#6D28D9" stop-opacity="0"/></radialGradient>
  </defs>
  ${mode === 'splash' ? '' : `<rect width="${S}" height="${S}" fill="url(#bg)"/><rect width="${S}" height="${S}" fill="url(#gl1)"/><rect width="${S}" height="${S}" fill="url(#gl2)"/>`}
  ${ground}
  <circle cx="${C}" cy="${C}" r="${Math.min(R * 1.45, S * 0.49)}" fill="url(#halo)"/>
  <circle cx="${C}" cy="${C}" r="${R}" fill="url(#core)"/>
  ${shapes}
</svg>`;
}
(async () => {
  const fs = require('fs');
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: S, height: S }, deviceScaleFactor: 1 });
  for (const mode of ['light', 'dark', 'splash']) {
    R = S * (mode === 'splash' ? 0.38 : 0.3);
    const s = svg(mode); fs.writeFileSync(`icon-${mode}.svg`, s);
    await p.setContent(`<html><body style="margin:0;background:transparent">${s}</body></html>`);
    await p.screenshot({ path: `icon-${mode}.png`, omitBackground: mode === 'splash' });
  }
  R = S * 0.3;
  // preview: rounded like on a home screen, at several sizes
  const L = fs.readFileSync('icon-light.png').toString('base64'), D = fs.readFileSync('icon-dark.png').toString('base64');
  await p.setViewportSize({ width: 900, height: 420 });
  const tile = (src, sz, bg) => `<div style="display:flex;flex-direction:column;align-items:center;gap:10px"><img src="data:image/png;base64,${src}" style="width:${sz}px;height:${sz}px;border-radius:${sz * 0.225}px;box-shadow:0 6px 18px rgba(0,0,0,.18)"><span style="font:600 14px -apple-system,system-ui;color:${bg === '#111' ? '#fff' : '#111'}">ROLLY</span></div>`;
  await p.setContent(`<body style="margin:0;display:flex;height:100%"><div style="flex:1;background:linear-gradient(#cbb6ef,#f1e9fb);display:flex;gap:36px;align-items:center;justify-content:center">${tile(L, 180)}${tile(L, 90)}${tile(L, 60)}</div><div style="flex:1;background:#111;display:flex;gap:36px;align-items:center;justify-content:center">${tile(D, 180, '#111')}${tile(D, 90, '#111')}${tile(D, 60, '#111')}</div></body>`);
  await p.screenshot({ path: 'preview.png' });
  await b.close();
})();
