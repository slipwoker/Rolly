// End-to-end browser test: real Chromium, fake microphone fed from a WAV file.
// Usage: node tests/browser_e2e.cjs <wav> [provider] [user] [seconds] [screenshot.png]
const { chromium } = require('playwright');
(async () => {
const [wav, provider = 'mock', user = 'daniel', seconds = '20', shot = ''] = process.argv.slice(2);
const base = process.env.ROLLY_URL || 'http://127.0.0.1:8000';
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
  `--use-file-for-fake-audio-capture=${wav}%noloop`, '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 820, height: 900 }, deviceScaleFactor: shot ? 2 : 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`${base}/index.html?provider=${encodeURIComponent(provider)}&user=${user}&tag=browser-e2e`);
await page.waitForFunction(() => document.querySelectorAll('#provider option').length > 0);
await page.check('#showcap');
await page.click('#start');
const states = [];
const t0 = Date.now();
while (Date.now() - t0 < Number(seconds) * 1000) {
  const s = await page.getAttribute('#orb', 'data-state');
  if (states[states.length - 1] !== s) states.push(s);
  await page.waitForTimeout(100);
}
if (shot) await page.screenshot({ path: shot.replace('.png', '-live.png') });
await page.click('#end');
await page.waitForSelector('#summary:not([hidden])', { timeout: 120000 }).catch(() => logs.push('summary did not appear'));
if (shot) await page.screenshot({ path: shot, fullPage: true });
const out = { states, captions: await page.innerText('#captions'), stats: await page.innerText('#statskv').catch(() => ''), logs };
console.log(JSON.stringify(out, null, 1));
await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
