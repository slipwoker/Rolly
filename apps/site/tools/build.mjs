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
      logo: { "@type": "ImageObject", url: `${ORIGIN}/assets/apple-touch-icon.png`, width: 180, height: 180 },
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
  // footer: the current language's link is marked as the current page
  html = html.replace(/(<a href="[^"]*" data-lang="(he|en)"[^>]*?)( aria-current="page")?>/g, (_, open, l) => `${open}${l === lang ? ' aria-current="page"' : ""}>`);
  const keys = (src.match(/\sdata-t="[a-z0-9_]+"/g) || []).length;
  if (filled !== keys) throw new Error(`filled ${filled} of ${keys} [data-t] elements: one of them has markup inside`);
  return html;
}

// ------------------------------------------------------------------ sitemap and llms.txt
function lastmod() {
  try { return execSync("git log -1 --format=%cs -- index.html", { cwd: SITE, encoding: "utf8" }).trim() || today(); } catch { return today(); }
}
function today() { return new Date().toISOString().slice(0, 10); }

function sitemap() {
  const alts = ["he", "en"].map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${URL[l]}"/>`).join("\n");
  const urls = ["he", "en"].map((l) => `  <url>
    <loc>${URL[l]}</loc>
    <lastmod>${lastmod()}</lastmod>
${alts}
    <xhtml:link rel="alternate" hreflang="x-default" href="${URL.he}"/>
  </url>`).join("\n");
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
};
for (const [file, body] of Object.entries(out)) {
  mkdirSync(dirname(join(SITE, file)), { recursive: true });
  writeFileSync(join(SITE, file), body);
  console.log(`wrote apps/site/${file} (${Buffer.byteLength(body)} bytes)`);
}
