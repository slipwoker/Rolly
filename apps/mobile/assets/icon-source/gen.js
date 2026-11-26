// Generates ROLLY's app icon, splash and Android adaptive icon from the same drawing as src/ui/RollyAvatar.tsx
// (a little driver peeking over a steering wheel; day sky for light, night sky for dark), frozen at a rest frame.
// Run from this folder: node gen.js  (needs Playwright + Chromium). Writes the SVGs here and the PNGs into ../
//   icon.png (iOS light + Android legacy) · icon-dark.png (iOS dark) · splash-avatar.png / splash-avatar-dark.png
//   (transparent, soft-edged) · adaptive-fg.png / adaptive-bg.png (Android adaptive icon layers)
// Keep the geometry in sync with RollyAvatar.tsx.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SCENE = {
  day: { sky1: '#4FB6FF', sky2: '#B794F6', ring: '#1B1328', ringHi: '#3A2A55', hub: '#C084FC', shade: '#E6E9FB' },
  night: { sky1: '#2A1E48', sky2: '#0D0B13', ring: '#7C3AED', ringHi: '#A78BFA', hub: '#F5C2E7', shade: '#E4D6FB' },
};
const SUN = { x: 300, y: 300 }, SPARK = { x: 740, y: 290 }, W = { cx: 512, cy: 880, r: 290 };
const STARS = [[190, 470, 16], [620, 170, 20], [860, 500, 14], [170, 650, 12], [420, 160, 14], [860, 340, 18], [250, 560, 10], [850, 660, 12]];

const sparkle = (cx, cy, s) => {
  const k = s * 0.12;
  return `M${cx},${cy - s} Q${cx + k},${cy - k} ${cx + s},${cy} Q${cx + k},${cy + k} ${cx},${cy + s} Q${cx - k},${cy + k} ${cx - s},${cy} Q${cx - k},${cy - k} ${cx},${cy - s} Z`;
};
const cloud = (x, y, s) => `<g transform="translate(${x} ${y}) scale(${s})" opacity="0.92" fill="#fff"><circle cx="-70" cy="10" r="52"/><circle cx="5" cy="-22" r="72"/><circle cx="80" cy="8" r="50"/><rect x="-122" y="10" width="252" height="52" rx="26"/></g>`;

/** Sky only (gradient + night glow). */
function sky(mode) {
  const sc = SCENE[mode];
  return `<defs><linearGradient id="sky" x1="0" y1="0" x2="${mode === 'day' ? 0.6 : 0.4}" y2="1"><stop offset="0" stop-color="${sc.sky1}"/><stop offset="1" stop-color="${sc.sky2}"/></linearGradient>
<radialGradient id="ng" cx="50%" cy="47%" r="45%"><stop offset="0" stop-color="#7C3AED" stop-opacity="0.45"/><stop offset="1" stop-color="#7C3AED" stop-opacity="0"/></radialGradient></defs>
<rect width="1024" height="1024" fill="url(#sky)"/>${mode === 'night' ? '<rect width="1024" height="1024" fill="url(#ng)"/>' : ''}`;
}

/** Sun or moon, clouds or stars, the sparkle, the driver and the wheel. `fadeWheel` sinks the wheel below its hub. */
function scene(mode, { fadeWheel = false } = {}) {
  const sc = SCENE[mode];
  const deco = mode === 'day'
    ? `<radialGradient id="sun" cx="50%" cy="50%" r="50%"><stop offset="0.45" stop-color="#FFE58A" stop-opacity="0.55"/><stop offset="1" stop-color="#FFE58A" stop-opacity="0"/></radialGradient>`
    : `<mask id="moon"><rect width="1024" height="1024" fill="#fff"/><circle cx="${SUN.x + 36}" cy="${SUN.y - 26}" r="64" fill="#000"/></mask>`;
  const sky = mode === 'day'
    ? `<circle cx="${SUN.x}" cy="${SUN.y}" r="150" fill="url(#sun)"/><circle cx="${SUN.x}" cy="${SUN.y}" r="72" fill="#FFD45A"/>${cloud(700, 200, 0.55)}`
    : `<circle cx="${SUN.x}" cy="${SUN.y}" r="72" fill="#FDF1C7" mask="url(#moon)"/>${STARS.map(([x, y, s]) => `<path d="${sparkle(x, y, s)}" fill="#fff"/>`).join('')}`;
  const hands = [-42, 42].map((a) => {
    const x = W.cx + W.r * Math.sin((a * Math.PI) / 180), y = W.cy - W.r * Math.cos((a * Math.PI) / 180);
    return `<ellipse cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="44" ry="36" fill="#fff" transform="rotate(${a * 0.6} ${x.toFixed(1)} ${y.toFixed(1)})"/>`;
  }).join('');
  return `<defs>${deco}
<clipPath id="head"><ellipse cx="512" cy="505" rx="225" ry="190"/></clipPath>
<linearGradient id="ring" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sc.ringHi}"/><stop offset="1" stop-color="${sc.ring}"/></linearGradient>
<linearGradient id="wf" x1="0" y1="780" x2="0" y2="990" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<mask id="wm" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="url(#wf)"/></mask></defs>
${sky}
<path d="${sparkle(SPARK.x, SPARK.y, 50)}" fill="#fff"/>
<ellipse cx="512" cy="505" rx="225" ry="190" fill="#fff"/>
<g clip-path="url(#head)"><circle cx="790" cy="560" r="230" fill="${sc.shade}"/></g>
<ellipse cx="418" cy="515" rx="26" ry="14" fill="#FF8FC6" opacity="0.55"/><ellipse cx="596" cy="515" rx="26" ry="14" fill="#FF8FC6" opacity="0.55"/>
<ellipse cx="453" cy="455" rx="25" ry="38" fill="#141018" transform="rotate(8 453 455)"/><ellipse cx="557" cy="455" rx="25" ry="38" fill="#141018" transform="rotate(8 557 455)"/>
<g ${fadeWheel ? 'mask="url(#wm)"' : ''}>
<circle cx="${W.cx}" cy="${W.cy}" r="${W.r}" fill="none" stroke="url(#ring)" stroke-width="62"/>
<path d="M${W.cx - W.r},${W.cy} L${W.cx + W.r},${W.cy}" stroke="${sc.ring}" stroke-width="54" stroke-linecap="round"/>
<circle cx="${W.cx}" cy="${W.cy}" r="92" fill="${sc.ring}"/><circle cx="${W.cx}" cy="${W.cy}" r="40" fill="${sc.hub}"/></g>
${hands}`;
}

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">\n${body}\n</svg>\n`;
/** Soft radial fade (same as the in-app avatar) so the splash melts into the splash background. */
const soft = (body) => `<defs><radialGradient id="sfg" cx="512" cy="540" r="512" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff"/><stop offset="0.6" stop-color="#fff"/><stop offset="0.82" stop-color="#fff" stop-opacity="0.45"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
<mask id="soft" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect width="1024" height="1024" fill="url(#sfg)"/></mask></defs><g mask="url(#soft)">${body}</g>`;

const OUT = {
  'icon-light': { svg: svg(sky('day') + scene('day')), png: '../icon.png' },
  'icon-dark': { svg: svg(sky('night') + scene('night')), png: '../icon-dark.png' },
  'splash-light': { svg: svg(soft(sky('day')) + scene('day', { fadeWheel: true })), png: '../splash-avatar.png', transparent: true },
  'splash-dark': { svg: svg(soft(sky('night')) + scene('night', { fadeWheel: true })), png: '../splash-avatar-dark.png', transparent: true },
  // Android shows only the centre ~66% of the foreground layer, so the drawing is shrunk into that safe zone.
  'adaptive-fg': { svg: svg(`<g transform="translate(512 530) scale(0.7) translate(-512 -530)">${scene('day')}</g>`), png: '../adaptive-fg.png', transparent: true },
  'adaptive-bg': { svg: svg(sky('day')), png: '../adaptive-bg.png' },
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  for (const [name, o] of Object.entries(OUT)) {
    fs.writeFileSync(path.join(__dirname, `${name}.svg`), o.svg);
    await page.setContent(`<html><body style="margin:0;background:transparent">${o.svg}</body></html>`);
    await page.locator('svg').screenshot({ path: path.join(__dirname, o.png), omitBackground: !!o.transparent });
  }
  await browser.close();
})();
