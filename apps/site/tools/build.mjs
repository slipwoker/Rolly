#!/usr/bin/env node
/**
 * Builds the site's SEO/GEO files from the copy in index.html (the single source: the `T` dictionary in its script).
 * No dependencies. Run after changing any copy:   node apps/site/tools/build.mjs
 *
 *   index.html      Hebrew page at /    : <head> SEO block (between seo:start/seo:end) + every [data-t] text from T.he
 *   en/index.html   English page at /en/: the same page with T.en baked into the HTML (crawlers and AI engines
 *                   that don't run JavaScript read it as is)
 *   sitemap.xml     both URLs, with hreflang alternates
 *   llms.txt        a plain-language summary for AI assistants (llmstxt.org)
 *   privacy/, terms/, accessibility/ (and en/…)   the legal pages, from legal/<slug>.<he|en>.html (content only;
 *                   the first line is a <!--meta {json}--> with title, h1, description and the "updated" date)
 *
 * The page's own script still applies T at runtime, so what visitors see and what crawlers read is the same text.
 */
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const ORIGIN = "https://heyrolly.ai";
const URL = { he: `${ORIGIN}/`, en: `${ORIGIN}/en/` };
const LOCALE = { he: "he_IL", en: "en_US" };
const OTHER = { he: "en", en: "he" };

const src = readFileSync(join(SITE, "index.html"), "utf8");

// ------------------------------------------------------------------ the copy
const tm = src.match(/\n  var T = (\{[\s\S]*?\n  \});\n/);
if (!tm) throw new Error("could not find `var T = {...};` in index.html");
const T = new Function(`return (${tm[1]});`)();
const t = (lang, k) => {
  const v = T[lang][k] ?? T.he[k];
  if (v === undefined) throw new Error(`missing copy: ${lang}.${k}`);
  return v;
};
const FAQ = [1, 2, 3, 4, 5, 6];
const SKILLS = [1, 2, 3, 4, 5, 6];
const STEPS = [1, 2, 3];

const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const text = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ------------------------------------------------------------------ <head>
function jsonLd(lang) {
  const page = URL[lang];
  const image = { "@type": "ImageObject", url: `${ORIGIN}/assets/og-${lang}.jpg`, width: 1200, height: 630, caption: t(lang, "og_alt") };
  const graph = [
    {
      "@type": "Organization", "@id": `${ORIGIN}/#org`, name: "ROLLY", alternateName: ["Rolly", "רולי"], url: URL.he,
      legalName: "Zappy Technologies Ltd.",
      logo: { "@type": "ImageObject", url: `${ORIGIN}/assets/apple-touch-icon.png`, width: 180, height: 180 },
      address: { "@type": "PostalAddress", streetAddress: "4 HaShlosha St.", addressLocality: "Nitzanei Oz", addressCountry: "IL" },
      contactPoint: [
        { "@type": "ContactPoint", contactType: "customer support", email: "ido@zappy5.com", telephone: "+972-54-4559955", availableLanguage: ["he", "en"] },
        { "@type": "ContactPoint", contactType: "privacy", email: "privacy@zappy5.com", availableLanguage: ["he", "en"] },
      ],
    },
    {
      "@type": "WebSite", "@id": `${ORIGIN}/#website`, url: URL.he, name: "ROLLY", alternateName: ["Rolly", "רולי"],
      inLanguage: ["he", "en"], publisher: { "@id": `${ORIGIN}/#org` },
    },
    {
      "@type": "MobileApplication", "@id": `${ORIGIN}/#app`, name: "ROLLY", alternateName: ["Rolly", "רולי"],
      url: page, description: t(lang, "desc"), operatingSystem: "iOS, Android", applicationCategory: "LifestyleApplication",
      inLanguage: ["he", "en"], image: image.url, publisher: { "@id": `${ORIGIN}/#org` },
      featureList: SKILLS.map((i) => `${t(lang, `k${i}_t`)}: ${t(lang, `k${i}_p`)}`),
    },
    {
      "@type": ["WebPage", "FAQPage"], "@id": `${page}#webpage`, url: page, name: t(lang, "title"), description: t(lang, "desc"),
      inLanguage: lang, isPartOf: { "@id": `${ORIGIN}/#website` }, about: { "@id": `${ORIGIN}/#app` }, primaryImageOfPage: image,
      speakable: { "@type": "SpeakableSpecification", cssSelector: ["#hero-title", ".lede", "#faq .qa"] },
      mainEntity: FAQ.map((i) => ({
        "@type": "Question", name: t(lang, `q${i}_q`), acceptedAnswer: { "@type": "Answer", text: t(lang, `q${i}_a`) },
      })),
    },
  ];
  return JSON.stringify({ "@context": "https://schema.org", "@graph": graph }, null, 1).replace(/<\//g, "<\\/");
}

function seoBlock(lang) {
  const o = OTHER[lang];
  return [
    `<title>${text(t(lang, "title"))}</title>`,
    `<meta name="description" content="${attr(t(lang, "desc"))}">`,
    `<meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1">`,
    `<link rel="canonical" href="${URL[lang]}">`,
    `<link rel="alternate" hreflang="he" href="${URL.he}">`,
    `<link rel="alternate" hreflang="en" href="${URL.en}">`,
    `<link rel="alternate" hreflang="x-default" href="${URL.he}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="ROLLY">`,
    `<meta property="og:locale" content="${LOCALE[lang]}">`,
    `<meta property="og:locale:alternate" content="${LOCALE[o]}">`,
    `<meta property="og:url" content="${URL[lang]}">`,
    `<meta property="og:title" content="${attr(t(lang, "title"))}">`,
    `<meta property="og:description" content="${attr(t(lang, "desc"))}">`,
    `<meta property="og:image" content="${ORIGIN}/assets/og-${lang}.jpg">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta property="og:image:type" content="image/jpeg">`,
    `<meta property="og:image:alt" content="${attr(t(lang, "og_alt"))}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${attr(t(lang, "title"))}">`,
    `<meta name="twitter:description" content="${attr(t(lang, "desc"))}">`,
    `<meta name="twitter:image" content="${ORIGIN}/assets/og-${lang}.jpg">`,
    `<meta name="twitter:image:alt" content="${attr(t(lang, "og_alt"))}">`,
    `<meta name="application-name" content="ROLLY">`,
    `<meta name="apple-mobile-web-app-title" content="ROLLY">`,
    `<meta name="theme-color" content="#F7F6FA">`,
    `<link rel="icon" href="/assets/favicon.png" type="image/png" sizes="64x64">`,
    `<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180">`,
    `<link rel="manifest" href="/site.webmanifest">`,
    `<script type="application/ld+json">\n${jsonLd(lang)}\n</script>`,
  ].join("\n");
}

// ------------------------------------------------------------------ the page in one language
function render(lang) {
  let html = src;
  let filled = 0;
  html = html.replace(/<!-- seo:start([^>]*)-->[\s\S]*?<!-- seo:end -->/, (_, note) => `<!-- seo:start${note}-->\n${seoBlock(lang)}\n<!-- seo:end -->`);
  html = html.replace(/<html lang="(he|en)" dir="(rtl|ltr)"/, `<html lang="${lang}" dir="${lang === "he" ? "rtl" : "ltr"}"`);
  // every element with data-t="key" holds plain text (the runtime sets textContent)
  html = html.replace(/(<([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?\sdata-t="([a-z0-9_]+)"[^>]*>)([^<]*)(<\/\2>)/g, (_, open, _tag, key, _old, close) => {
    filled++;
    return open + text(t(lang, key)) + close;
  });
  html = html.replace(/<[a-zA-Z][^>]*\sdata-t-ph="([a-z0-9_]+)"[^>]*>/g, (tag, key) => tag.replace(/\splaceholder="[^"]*"/, ` placeholder="${attr(t(lang, key))}"`));
  html = html.replace(/<[a-zA-Z][^>]*\sdata-t-aria="([a-z0-9_]+)"[^>]*>/g, (tag, key) => tag.replace(/\saria-label="[^"]*"/, ` aria-label="${attr(t(lang, key))}"`));
  html = html.replace(/(<button class="chip"[^>]*\sdata-min="(\d+)"[^>]*>)[^<]*(<\/button>)/g, (_, open, n, close) => open + text(t(lang, "chip").replace("{n}", n)) + close);
  if (lang === "en") html = html.replace(/href="\/(privacy|terms|accessibility)\/" data-legal/g, 'href="/en/$1/" data-legal');
  // footer: the current language's link is marked as the current page
  html = html.replace(/(<a href="[^"]*" data-lang="(he|en)"[^>]*?)( aria-current="page")?>/g, (_, open, l) => `${open}${l === lang ? ' aria-current="page"' : ""}>`);
  const keys = (src.match(/\sdata-t="[a-z0-9_]+"/g) || []).length;
  if (filled !== keys) throw new Error(`filled ${filled} of ${keys} [data-t] elements: one of them has markup inside`);
  return html;
}


// ------------------------------------------------------------------ legal pages
const LEGAL = ["privacy", "terms", "accessibility"];
const LT = {
  he: { home: "לעמוד הבית", toc: "בעמוד זה", updated: "עודכן לאחרונה", other: "English", crumbs: "מיקום בעמוד" },
  en: { home: "Home", toc: "On this page", updated: "Last updated", other: "עברית", crumbs: "Breadcrumb" },
};
const legalPath = (slug, lang) => `${lang === "en" ? "/en" : ""}/${slug}/`;
const homePath = (lang) => (lang === "en" ? "/en/" : "/");

function legalSource(slug, lang) {
  const raw = readFileSync(join(SITE, "legal", `${slug}.${lang}.html`), "utf8");
  const m = raw.match(/^<!--meta (\{[\s\S]*?\}) -->\n/);
  if (!m) throw new Error(`legal/${slug}.${lang}.html: first line must be <!--meta {json} -->`);
  return { meta: JSON.parse(m[1]), body: raw.slice(m[0].length) };
}

/** The table of contents goes after the "in short" box when a page has one, else first. */
function withToc(body, toc) {
  if (!body.startsWith('<div class="summary">')) return `${toc}\n${body}`;
  const end = body.indexOf("</div>") + "</div>".length;
  return `${body.slice(0, end)}\n${toc}${body.slice(end)}`;
}

function legalPage(slug, lang) {
  const { meta, body } = legalSource(slug, lang);
  const o = OTHER[lang], url = ORIGIN + legalPath(slug, lang);
  const date = new Intl.DateTimeFormat(lang === "he" ? "he-IL" : "en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
    .format(new Date(`${meta.updated}T00:00:00Z`));
  const toc = [...body.matchAll(/<h2 id="([a-z0-9-]+)">([^<]+)<\/h2>/g)].filter(([, id]) => id !== "short")
    .map(([, id, title]) => `<li><a href="#${id}">${title}</a></li>`).join("");
  const ld = JSON.stringify({ "@context": "https://schema.org", "@graph": [
    { "@type": "WebPage", "@id": `${url}#webpage`, url, name: meta.title, description: meta.description, inLanguage: lang,
      dateModified: meta.updated, isPartOf: { "@id": `${ORIGIN}/#website` }, about: { "@id": `${ORIGIN}/#org` }, publisher: { "@id": `${ORIGIN}/#org` } },
    { "@type": "BreadcrumbList", itemListElement: [
      { "@type": "ListItem", position: 1, name: "ROLLY", item: ORIGIN + homePath(lang) },
      { "@type": "ListItem", position: 2, name: meta.h1, item: url } ] },
  ] }, null, 1).replace(/<\//g, "<\\/");
  const links = LEGAL.map((s) => `<li><a href="${legalPath(s, lang)}"${s === slug ? ' aria-current="page"' : ""}>${text(t(lang, { privacy: "legal_privacy", terms: "legal_terms", accessibility: "legal_access" }[s]))}</a></li>`).join("");
  return `<!doctype html>
<html lang="${lang}" dir="${lang === "he" ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- generated by tools/build.mjs from legal/${slug}.${lang}.html: edit that file, then run: node apps/site/tools/build.mjs -->
<title>${text(meta.title)}</title>
<meta name="description" content="${attr(meta.description)}">
<meta name="robots" content="index, follow, max-snippet:-1">
<link rel="canonical" href="${url}">
<link rel="alternate" hreflang="he" href="${ORIGIN + legalPath(slug, "he")}">
<link rel="alternate" hreflang="en" href="${ORIGIN + legalPath(slug, "en")}">
<link rel="alternate" hreflang="x-default" href="${ORIGIN + legalPath(slug, "he")}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="ROLLY">
<meta property="og:locale" content="${LOCALE[lang]}">
<meta property="og:locale:alternate" content="${LOCALE[o]}">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${attr(meta.title)}">
<meta property="og:description" content="${attr(meta.description)}">
<meta property="og:image" content="${ORIGIN}/assets/og-${lang}.jpg">
<meta property="article:modified_time" content="${meta.updated}">
<meta name="twitter:card" content="summary">
<meta name="theme-color" content="#F7F6FA">
<link rel="icon" href="/assets/favicon.png" type="image/png" sizes="64x64">
<link rel="apple-touch-icon" href="/assets/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@500;600;700&family=Rubik:wght@400;500;600&display=swap" rel="stylesheet">
<script type="application/ld+json">
${ld}
</script>
<style>
:root{--ink:#0E0B16;--ink-2:#5B5468;--line:#E8E4F0;--paper:#F7F6FA;--card:#fff;--violet:#7C3AED;--violet-soft:#F1EBFE;
  --display:"Fredoka","Rubik",system-ui,sans-serif;--body:"Rubik",system-ui,sans-serif}
*{box-sizing:border-box}
html{overflow-x:clip;-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:400 17px/1.7 var(--body);-webkit-font-smoothing:antialiased}
a{color:var(--violet);text-underline-offset:3px}
:focus-visible{outline:3px solid var(--violet);outline-offset:3px;border-radius:8px}
.skip{position:absolute;inset-inline-start:16px;top:-60px;z-index:10;padding:10px 16px;border-radius:12px;background:var(--ink);color:#fff;text-decoration:none;font-weight:500}
.skip:focus{top:12px}
.wrap{width:min(860px,100% - 32px);margin-inline:auto}
.top{position:sticky;top:0;z-index:5;background:rgba(247,246,250,.9);backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:16px;height:64px}
.brand{display:flex;align-items:center;gap:10px;color:var(--ink);text-decoration:none;font:700 21px var(--display);letter-spacing:.02em}
.brand img{width:34px;height:34px;border-radius:10px}
.top .home{margin-inline-start:auto;color:var(--ink-2);font-size:15px}
.top .lang{padding:6px 14px;border:1px solid var(--line);border-radius:999px;background:#fff;color:var(--ink);font-size:14px;text-decoration:none}
main{padding:40px 0 72px}
.crumbs ol{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px;padding:0;list-style:none;font-size:14px;color:var(--ink-2)}
.crumbs li+li::before{content:"/";margin-inline-end:8px;color:var(--line)}
.crumbs a{color:var(--ink-2)}
h1{font:600 clamp(36px,6vw,56px)/1.05 var(--display);margin:0 0 10px}
.updated{margin:0 0 28px;color:var(--ink-2);font-size:15px}
h2{font:600 26px/1.25 var(--display);margin:44px 0 12px;scroll-margin-top:84px}
h3{font:600 19px/1.3 var(--display);margin:26px 0 8px}
p,ul{margin:0 0 14px}
ul{padding-inline-start:1.3em}
li{margin-bottom:6px}
code{font-size:.9em;background:var(--violet-soft);padding:1px 6px;border-radius:6px;direction:ltr;unicode-bidi:isolate}
.toc,.summary,.contact{background:var(--card);border-radius:20px;box-shadow:0 1px 2px rgba(17,12,30,.05),0 10px 30px rgba(76,29,149,.08);padding:22px 26px;margin:0 0 22px}
.toc h2,.summary h2{margin:0 0 10px;font-size:19px}
.toc ol{margin:0;padding:0;list-style:none;columns:2;column-gap:32px}
.toc li{break-inside:avoid}
.summary{background:linear-gradient(160deg,#F3EDFF,#FBEFFA)}
.contact p{margin:0}
.table{overflow-x:auto;margin:0 0 16px;border-radius:16px;border:1px solid var(--line);background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:15px;line-height:1.5}
th,td{padding:12px 14px;text-align:start;vertical-align:top;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}
th{background:var(--violet-soft);font-weight:600}
footer{border-top:1px solid var(--line);padding:28px 0 40px;color:var(--ink-2);font-size:14px}
footer .wrap{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;justify-content:space-between}
footer ul{display:flex;flex-wrap:wrap;gap:4px 18px;margin:0;padding:0;list-style:none}
footer a{color:var(--ink-2)}
footer a[aria-current="page"]{color:var(--ink);font-weight:500;text-decoration:none}
@media (max-width:640px){.toc ol{columns:1}.top .home{display:none}.toc,.summary,.contact{padding:18px 20px}}
@media print{.top,.toc,footer,.skip{display:none}body{background:#fff}.summary,.contact{box-shadow:none;border:1px solid #ccc}}
</style>
</head>
<body>
<a class="skip" href="#main">${text(t(lang, "skip"))}</a>
<header class="top"><div class="wrap">
  <a class="brand" href="${homePath(lang)}"><img src="/assets/favicon.png" alt="" width="34" height="34">ROLLY</a>
  <a class="home" href="${homePath(lang)}">${LT[lang].home}</a>
  <a class="lang" href="${legalPath(slug, o)}" lang="${o}" hreflang="${o}">${LT[lang].other}</a>
</div></header>
<main id="main" class="wrap">
<nav class="crumbs" aria-label="${LT[lang].crumbs}"><ol><li><a href="${homePath(lang)}">ROLLY</a></li><li aria-current="page">${text(meta.h1)}</li></ol></nav>
<article>
<h1>${text(meta.h1)}</h1>
<p class="updated">${LT[lang].updated}: <time datetime="${meta.updated}">${date}</time></p>
${withToc(body.trim(), `<nav class="toc" aria-labelledby="toc-title"><h2 id="toc-title">${LT[lang].toc}</h2><ol>${toc}</ol></nav>`)}
</article>
</main>
<footer><div class="wrap">
  <nav aria-label="${attr(t(lang, "legal_nav"))}"><ul>${links}</ul></nav>
  <span>${text(t(lang, "rights"))}</span>
</div></footer>
</body>
</html>
`;
}

// ------------------------------------------------------------------ sitemap and llms.txt
function lastmod() {
  try { return execSync("git log -1 --format=%cs -- index.html", { cwd: SITE, encoding: "utf8" }).trim() || today(); } catch { return today(); }
}
function today() { return new Date().toISOString().slice(0, 10); }

function sitemap() {
  const entry = (loc, mod, he, en) => `  <url>
    <loc>${loc}</loc>
    <lastmod>${mod}</lastmod>
    <xhtml:link rel="alternate" hreflang="he" href="${he}"/>
    <xhtml:link rel="alternate" hreflang="en" href="${en}"/>
    <xhtml:link rel="alternate" hreflang="x-default" href="${he}"/>
  </url>`;
  const urls = [
    ...["he", "en"].map((l) => entry(URL[l], lastmod(), URL.he, URL.en)),
    ...LEGAL.flatMap((slug) => ["he", "en"].map((l) => entry(ORIGIN + legalPath(slug, l), legalSource(slug, l).meta.updated,
      ORIGIN + legalPath(slug, "he"), ORIGIN + legalPath(slug, "en")))),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls}
</urlset>
`;
}

function llms() {
  const en = (k) => t("en", k), he = (k) => t("he", k);
  return `# ROLLY

> ${en("desc")}

ROLLY (in Hebrew: רולי) is a voice-first companion app for car rides, in Hebrew and English. It is in its last round of testing and is coming soon to iPhone and Android. Website and waitlist: ${URL.en} (English), ${URL.he} (Hebrew).

## Key facts

${FAQ.map((i) => `- **${en(`q${i}_q`)}** ${en(`q${i}_a`)}`).join("\n")}

## How it works

${STEPS.map((i) => `${i}. **${en(`s${i}_t`)}.** ${en(`s${i}_p`)}`).join("\n")}

## What it does

${SKILLS.map((i) => `- **${en(`k${i}_t`)}:** ${en(`k${i}_p`)}`).join("\n")}

## Pages

- [ROLLY, in English](${URL.en}): ${en("title")}
- [ROLLY, in Hebrew](${URL.he}): ${he("title")}
${LEGAL.map((slug) => { const m = legalSource(slug, "en").meta; return `- [${m.h1}](${ORIGIN + legalPath(slug, "en")}): ${m.description}`; }).join("\n")}

ROLLY is operated by Zappy Technologies Ltd., 4 HaShlosha St., Nitzanei Oz, Israel. Contact: ido@zappy5.com; privacy: privacy@zappy5.com.

## בעברית

> ${he("desc")}

${FAQ.map((i) => `- **${he(`q${i}_q`)}** ${he(`q${i}_a`)}`).join("\n")}
`;
}

// ------------------------------------------------------------------ write
const out = {
  "index.html": render("he"),
  "en/index.html": render("en"),
  "sitemap.xml": sitemap(),
  "llms.txt": llms(),
  ...Object.fromEntries(LEGAL.flatMap((slug) => ["he", "en"].map((l) => [`${legalPath(slug, l).slice(1)}index.html`, legalPage(slug, l)]))),
};
for (const [file, body] of Object.entries(out)) {
  mkdirSync(dirname(join(SITE, file)), { recursive: true });
  writeFileSync(join(SITE, file), body);
  console.log(`wrote apps/site/${file} (${Buffer.byteLength(body)} bytes)`);
}
