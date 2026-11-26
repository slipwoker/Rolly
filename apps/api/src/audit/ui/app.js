/* Rolly agent audit - backoffice. No build step, no dependencies. All data is inserted with textContent. */
"use strict";
(() => {
  // ------------------------------------------------------------------ small helpers
  const $ = (sel) => document.querySelector(sel);
  const store = {
    get(k, d) { try { const v = sessionStorage.getItem(k) ?? localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
    tab(k, v) { try { v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* private mode */ } },
    keep(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  /** h("div.card#id", {attrs, on: {click}}, ...children) - children: strings (text), nodes, arrays, null */
  function h(spec, attrs, ...kids) {
    if (attrs === null || typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs)) { kids.unshift(attrs); attrs = {}; }
    const [, tag, rest] = spec.match(/^([a-z0-9]+)(.*)$/i) || [null, "div", ""];
    const el = document.createElement(tag);
    for (const m of rest.matchAll(/([.#])([\w-]+)/g)) m[1] === "." ? el.classList.add(m[2]) : (el.id = m[2]);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === "class") String(v).split(/\s+/).filter(Boolean).forEach((c) => el.classList.add(c));
      else if (k === "text") el.textContent = String(v);
      else if (k === "style") el.style.cssText = String(v); // CSSOM: allowed by the page's CSP, a style attribute is not
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    add(el, kids);
    return el;
  }
  function add(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }
  const SVG = "http://www.w3.org/2000/svg";
  function s(tag, attrs = {}, ...kids) {
    const el = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    for (const k of kids.flat()) if (k) el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  }

  let TZ = "Asia/Jerusalem";
  const fmt = {
    usd(x) {
      if (x === null || x === undefined || !Number.isFinite(Number(x))) return "-";
      const v = Number(x);
      if (v === 0) return "$0";
      if (Math.abs(v) < 0.01) return "$" + v.toFixed(4);
      if (Math.abs(v) < 100) return "$" + v.toFixed(2);
      return "$" + Math.round(v).toLocaleString("en-US");
    },
    ms(x) { return x === null || x === undefined ? "-" : Number(x) >= 10000 ? (Number(x) / 1000).toFixed(1) + " s" : Math.round(Number(x)).toLocaleString("en-US") + " ms"; },
    pct(x) { return x === null || x === undefined ? "-" : Math.round(Number(x) * 100) + "%"; },
    n(x, d = 0) { return x === null || x === undefined || !Number.isFinite(Number(x)) ? "-" : Number(x).toLocaleString("en-US", { maximumFractionDigits: d }); },
    dur(sec) {
      if (sec === null || sec === undefined) return "-";
      const m = Math.floor(sec / 60), r = Math.round(sec % 60);
      return m ? `${m}m ${String(r).padStart(2, "0")}s` : `${r}s`;
    },
    dt(d) { return d ? new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(d)) : "-"; },
    day(k) { const [y, m, dd] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }); },
    time(d) { return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(d)); },
    user(label, id) { return label || (id ? id.slice(0, 8) : "-"); },
  };
  const scoreBadge = (v) => v === null || v === undefined ? h("span.muted", "-")
    : h("span.score", { class: v >= 80 ? "good" : v >= 55 ? "mid" : "bad", title: "Health score: 100 minus a weight per flag" }, String(v));

  // flags: severity and a human label (the server sends the reason per session)
  const FLAGS = {
    pipeline_failed: ["high", "Pipeline failed"], language_mismatch: ["high", "Language mismatch"], judge_low: ["high", "Judge: low"],
    errors: ["medium", "Errors"], slow: ["medium", "Slow replies"], bot_speak: ["medium", "Bot-speak"], interruptions: ["medium", "Interruptions"],
    memory_corrected: ["medium", "User fixed memory"], summary_failed: ["medium", "Summary failed"],
    long_replies: ["low", "Long replies"], lookahead_failed: ["low", "Plan step failed"], utility_llm_errors: ["low", "Utility model errors"],
    abandoned: ["low", "Abandoned"], superseded: ["low", "Superseded"], other_voices: ["low", "Other voices"], stt_discards: ["low", "STT discards"],
  };
  const flagChip = (id, why, link = true) => {
    const [sev, label] = FLAGS[id] || ["low", id];
    const p = { class: "chip " + sev, title: why || label };
    return link ? h("a", { ...p, href: `#/sessions?flag=${encodeURIComponent(id)}` }, label) : h("span", p, label);
  };
  const REVIEW_TAGS = ["great", "bot_speak", "misheard", "wrong_language", "wrong_gender", "forgot_context", "invented_fact", "too_long",
    "too_many_questions", "ignored_user", "bad_opener", "latency"];
  const PURPOSE_LABEL = { summary: "Summary", live_command: "Live memory command", capture: "Note capture", plan: "Next-ride plan",
    scrub: "Forget (scrub)", consolidate: "Digest", judge: "LLM judge", other: "Other", gpu: "GPU time" };

  // ------------------------------------------------------------------ API
  const filters = { days: Number(store.get("audit.days", "30")) || 30, selftest: store.get("audit.selftest", "0") === "1" };
  const status = (t) => { $("#status").textContent = t || ""; };
  async function api(path, opts = {}) {
    const token = store.get("audit.token", "");
    if (!token) { showLogin(); throw new Error("no token"); }
    const r = await fetch(path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.body ? { "Content-Type": "application/json" } : {}) } });
    if (r.status === 401) { store.tab("audit.token", null); showLogin("The token was not accepted."); throw new Error("unauthorized"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  const qs = (extra = {}) => {
    const p = new URLSearchParams({ days: String(filters.days), ...(filters.selftest ? { selftest: "1" } : {}) });
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== "") p.set(k, v);
    return p.toString();
  };

  function showLogin(msg) {
    $("#login").hidden = false;
    $("#app").hidden = true;
    const e = $("#login-error");
    e.hidden = !msg; e.textContent = msg || "";
    $("#token").focus();
  }
  $("#login-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    store.tab("audit.token", $("#token").value.trim());
    $("#login").hidden = true; $("#app").hidden = false;
    route();
  });
  $("#logout").addEventListener("click", () => { store.tab("audit.token", null); showLogin(); });
  $("#theme").addEventListener("click", () => {
    const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next; store.keep("audit.theme", next);
  });
  { const t = store.get("audit.theme", ""); if (t === "dark" || t === "light") document.documentElement.dataset.theme = t; }
  $("#f-days").value = String(filters.days);
  $("#f-selftest").checked = filters.selftest;
  $("#f-days").addEventListener("change", (e) => { filters.days = Number(e.target.value); store.keep("audit.days", String(filters.days)); route(); });
  $("#f-selftest").addEventListener("change", (e) => { filters.selftest = e.target.checked; store.keep("audit.selftest", filters.selftest ? "1" : "0"); route(); });

  // ------------------------------------------------------------------ tooltip
  const tip = $("#tip");
  function showTip(ev, title, rows) {
    tip.replaceChildren(h("div.t", title), ...rows.map(([color, label, value]) =>
      h("div.r", color ? h("i", { style: `background:${color}` }) : null, h("b", value), h("span.muted", label))));
    tip.hidden = false;
    const right = ev.clientX + 14 + tip.offsetWidth > window.innerWidth - 8;
    const x = Math.max(8, right ? ev.clientX - 14 - tip.offsetWidth : ev.clientX + 14), y = Math.max(8, Math.min(window.innerHeight - tip.offsetHeight - 8, ev.clientY + 14));
    tip.style.left = x + "px"; tip.style.top = y + "px";
  }
  const hideTip = () => { tip.hidden = true; };

  // ------------------------------------------------------------------ charts (SVG)
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const niceMax = (v) => {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  };
  /** columns over days; series stack; one per-column hover target */
  /** draws at the container's real width (text stays 11px on a phone and on a wide screen), again on resize */
  function responsive(draw, legendNode) {
    const box = h("div.chart", legendNode);
    const plot = h("div");
    box.append(plot);
    let last = 0;
    const ro = new ResizeObserver(() => {
      const w = Math.round(plot.clientWidth);
      if (!w || Math.abs(w - last) < 2) return;
      last = w; plot.replaceChildren(draw(Math.max(260, w)));
    });
    ro.observe(plot);
    return box;
  }
  function barChart(data, series, opts = {}) {
    return responsive((W) => drawBars(W, data, series, opts), legend(series, "rect"));
  }
  function drawBars(W, data, series, { format = (v) => fmt.n(v, 2), height = 180, title, integer = false } = {}) {
    const H = height, L = 48, R = 8, T = 8, B = 22;
    const totals = data.map((d) => series.reduce((n, sr) => n + (Number(d[sr.key]) || 0), 0));
    // counts: four whole-number gridlines
    const max = integer ? Math.max(4, Math.ceil(Math.max(...totals, 0) / 4) * 4) : niceMax(Math.max(...totals, 0));
    const bw = (W - L - R) / Math.max(1, data.length);
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": title || "bar chart" });
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      svg.append(s("line", { class: i ? "grid-l" : "base", x1: L, x2: W - R, y1: y(v), y2: y(v) }), s("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, format(v)));
    }
    const every = Math.ceil(data.length / Math.max(2, Math.floor((W - L) / 64)));
    data.forEach((d, i) => {
      const x = L + i * bw, w = Math.max(1, Math.min(28, bw - 2)), cx = x + (bw - w) / 2;
      let acc = 0;
      const segs = series.filter((sr) => Number(d[sr.key]) > 0);
      segs.forEach((sr, j) => {
        const v = Number(d[sr.key]);
        const y0 = y(acc), y1 = y(acc + v);
        acc += v;
        const top = j === segs.length - 1, hgt = Math.max(0, y0 - y1 - (j ? 2 : 0));
        if (hgt <= 0) return;
        const r = top ? Math.min(4, w / 2, hgt) : 0;
        const yy = y1, yb = y1 + hgt;
        const path = r ? `M${cx},${yb} V${yy + r} Q${cx},${yy} ${cx + r},${yy} H${cx + w - r} Q${cx + w},${yy} ${cx + w},${yy + r} V${yb} Z` : `M${cx},${yb} V${yy} H${cx + w} V${yb} Z`;
        svg.append(s("path", { d: path, fill: sr.color, class: "bar" }));
      });
      if (i % every === 0) svg.append(s("text", { x: x + bw / 2, y: H - 6, "text-anchor": "middle" }, fmt.day(d.day)));
      const hit = s("rect", { x, y: T, width: bw, height: H - T - B, class: "hit", tabindex: 0 });
      const show = (ev) => showTip(ev, fmt.day(d.day), [...series].reverse().map((sr) => [sr.color, sr.label, format(Number(d[sr.key]) || 0)])
        .concat(series.length > 1 ? [[null, "total", format(totals[i])]] : []));
      hit.addEventListener("pointermove", show); hit.addEventListener("pointerleave", hideTip);
      hit.addEventListener("focus", (ev) => { const b = ev.target.getBoundingClientRect(); show({ clientX: b.right, clientY: b.top }); });
      hit.addEventListener("blur", hideTip);
      svg.append(hit);
    });
    return svg;
  }
  /** lines over days with a crosshair; gaps where a day has no value */
  function lineChart(data, series, opts = {}) {
    return responsive((W) => drawLines(W, data, series, opts), series.length > 1 ? legend(series, "line") : null);
  }
  function drawLines(W, data, series, { format = (v) => fmt.n(v), height = 180, title } = {}) {
    const H = height, L = 56, R = 8, T = 8, B = 22;
    const vals = data.flatMap((d) => series.map((sr) => d[sr.key])).filter((v) => typeof v === "number");
    const max = niceMax(Math.max(...vals, 0));
    const step = (W - L - R) / Math.max(1, data.length - 1);
    const x = (i) => L + i * step, y = (v) => T + (H - T - B) * (1 - v / max);
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img", "aria-label": title || "line chart" });
    for (let i = 0; i <= 4; i++) {
      const v = (max * i) / 4;
      svg.append(s("line", { class: i ? "grid-l" : "base", x1: L, x2: W - R, y1: y(v), y2: y(v) }), s("text", { x: L - 6, y: y(v) + 4, "text-anchor": "end" }, format(v)));
    }
    const every = Math.ceil(data.length / Math.max(2, Math.floor((W - L) / 64)));
    data.forEach((d, i) => { if (i % every === 0) svg.append(s("text", { x: x(i), y: H - 6, "text-anchor": "middle" }, fmt.day(d.day))); });
    for (const sr of series) {
      let dstr = "", pen = false;
      data.forEach((d, i) => {
        const v = d[sr.key];
        if (typeof v !== "number") { pen = false; return; }
        dstr += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)} `; pen = true;
      });
      svg.append(s("path", { d: dstr, fill: "none", stroke: sr.color, "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      data.forEach((d, i) => {
        const v = d[sr.key], prev = data[i - 1]?.[sr.key], next = data[i + 1]?.[sr.key];
        if (typeof v === "number" && typeof prev !== "number" && typeof next !== "number")
          svg.append(s("circle", { cx: x(i), cy: y(v), r: 4, fill: sr.color, stroke: css("--surface"), "stroke-width": 2 }));
      });
    }
    const xh = s("line", { class: "xhair", y1: T, y2: H - B, x1: -10, x2: -10 });
    svg.append(xh);
    const hit = s("rect", { x: L, y: T, width: W - L - R, height: H - T - B, class: "hit" });
    hit.addEventListener("pointermove", (ev) => {
      const b = svg.getBoundingClientRect();
      const px = ((ev.clientX - b.left) / b.width) * W;
      const i = Math.max(0, Math.min(data.length - 1, Math.round((px - L) / step)));
      xh.setAttribute("x1", x(i)); xh.setAttribute("x2", x(i));
      showTip(ev, fmt.day(data[i].day), series.map((sr) => [sr.color, sr.label, typeof data[i][sr.key] === "number" ? format(data[i][sr.key]) : "-"]));
    });
    hit.addEventListener("pointerleave", () => { hideTip(); xh.setAttribute("x1", -10); xh.setAttribute("x2", -10); });
    svg.append(hit);
    return svg;
  }
  const legend = (series, kind) => series.length < 2 ? null
    : h("div.legend", series.map((sr) => h("span", h("i", { class: kind === "line" ? "line" : "", style: `background:${sr.color}` }), sr.label)));
  function hbars(items, { onClick, format = (v) => String(v), color } = {}) {
    if (!items.length) return h("div.empty", "Nothing here.");
    const max = Math.max(...items.map((i) => i.n), 1);
    return h("div.hbars", items.map((it) => {
      const lab = it.label instanceof Node ? it.label : h("span.lab", { title: String(it.label) }, String(it.label));
      const row = h("div.hbar", lab, h("div.track", h("div.fill", { style: `width:${(it.n / max) * 100}%;${color ? `background:${color}` : ""}` })), h("span.num", format(it.n)));
      if (onClick) { row.style.cursor = "pointer"; row.addEventListener("click", () => onClick(it)); }
      return row;
    }));
  }
  const tile = (k, v, sub, title) => h("div.tile", { title }, h("div.k", k), h("div.v", v), sub ? h("div.sub", sub) : null);
  const card = (title, ...body) => h("section.card", title ? h("h2", title) : null, ...body);
  function table(cols, rows, { onRow, empty = "Nothing in this range." } = {}) {
    if (!rows.length) return h("div.empty", empty);
    return h("div.tablewrap", h("table",
      h("thead", h("tr", cols.map((c) => h("th", { class: c.num ? "num" : "" }, c.label)))),
      h("tbody", rows.map((r) => h("tr", { class: onRow ? "click" : "", on: onRow ? { click: (e) => { if (!e.target.closest("a,button")) onRow(r); } } : {} },
        cols.map((c) => { const v = c.get(r); return h("td", { class: [c.num ? "num" : "", c.wrap ? "wrap" : ""].join(" ") }, v instanceof Node ? v : v ?? "-"); }))))));
  }
  const series = (i) => css(`--s${i}`);

  // ------------------------------------------------------------------ views
  const view = $("#view");
  async function render(fn) {
    view.classList.add("loading"); status("Loading…");
    try {
      const nodes = await fn();
      view.replaceChildren(...[nodes].flat());
      status("");
    } catch (e) {
      if (String(e.message) !== "unauthorized" && String(e.message) !== "no token") { view.replaceChildren(card(null, h("p.error", "Could not load: " + e.message))); status(""); }
    } finally { view.classList.remove("loading"); }
  }

  async function overviewView() {
    const o = await api("/v1/admin/audit/overview?" + qs());
    TZ = o.time_zone || TZ;
    const k = o.kpis, ins = o.insights;
    return [
      h("div.head", h("div", h("h1", "Overview"), h("div.muted", `${o.days === 1 ? "Today" : `Last ${o.days} days`} · utility model ${o.utility_llm ?? "none"}${o.build ? ` · build ${o.build}` : ""}`))),
      h("div.tiles",
        tile("Conversations", fmt.n(k.conversations), `${k.users} user${k.users === 1 ? "" : "s"} · ${fmt.n(k.minutes, 1)} min`),
        tile("Reply latency p50", fmt.ms(k.reply_p50), `p95 ${fmt.ms(k.reply_p95)}`, "From the end of the user's speech to Rolly's first audio, measured on the server"),
        tile("Health score", k.avg_score ?? "-", `${fmt.n(k.flagged)} flagged (${fmt.pct(k.flagged_share)})`),
        tile("Judge", k.judge_avg === null ? "-" : `${k.judge_avg} / 5`, `${k.judged} judged`),
        tile("Owner review", k.review_avg === null ? "-" : `${k.review_avg} / 5`, `${k.reviewed} reviewed`),
        tile("Spend", fmt.usd(k.total_usd), `API ${fmt.usd(k.api_usd)} · GPU ${fmt.usd(k.gpu_usd)}`, "API: measured tokens x prices. GPU: conversation time x hourly rate."),
        tile("Cost / minute", fmt.usd(k.usd_per_minute), `API per conversation ${fmt.usd(k.api_usd_per_conversation)}`),
      ),
      h("div.grid.g2",
        card("Conversations per day", barChart(o.daily, [{ key: "sessions", label: "Conversations", color: series(1) }], { format: (v) => fmt.n(v), title: "Conversations per day", integer: true })),
        card("Reply latency", lineChart(o.daily, [{ key: "reply_p50", label: "p50", color: series(1) }, { key: "reply_p95", label: "p95", color: series(2) }], { format: fmt.ms, title: "Reply latency per day" })),
      ),
      h("div.grid.g2",
        card("Spend per day", barChart(o.daily, [{ key: "gpu_usd", label: "GPU time", color: series(1) }, { key: "api_usd", label: "Utility model API", color: series(2) }], { format: fmt.usd, title: "Spend per day" })),
        card("What to look at", h("p.muted.small", "Flags on conversations in this range. Click one to list them."),
          hbars(o.flags.map((f) => ({ label: flagChip(f.key, null, false), n: f.n, key: f.key })), { onClick: (it) => { location.hash = `#/sessions?flag=${encodeURIComponent(it.key)}`; } })),
      ),
      h("h2", { style: "margin:8px 0 0" }, "Agent insights"),
      h("div.grid.g3",
        card("How Rolly talks",
          h("p.muted.small", "Habits that make a reply sound like an assistant (persona/style.ts), over all replies."),
          hbars([
            { label: "Any bot-speak habit", n: ins.style.bot_speak_rate ?? 0 },
            { label: "Opens by agreeing", n: ins.style.ack_rate ?? 0 },
            { label: "General wisdom", n: ins.style.platitude_rate ?? 0 },
            { label: "Names feelings back", n: ins.style.therapist_rate ?? 0 },
            { label: "Apologises", n: ins.style.apology_rate ?? 0 },
            { label: "Ends with a question", n: ins.style.question_rate ?? 0 },
          ], { format: fmt.pct }),
          h("dl.kv", { style: "margin-top:12px" }, h("dt", "Replies"), h("dd", fmt.n(ins.style.replies)), h("dt", "Words per reply"), h("dd", fmt.n(ins.style.avg_agent_words, 1)),
            h("dt", "Long replies (40+ words)"), h("dd", fmt.n(ins.style.long_replies)), h("dt", "Questions twice in a row"), h("dd", fmt.n(ins.style.questions_in_a_row)),
            h("dt", "Style-guard notes sent"), h("dd", fmt.n(ins.style.guard_notes)))),
        card("Turn-taking & hearing",
          h("dl.kv", h("dt", "Interruptions"), h("dd", `${fmt.n(ins.turn_taking.interruptions)} (${fmt.pct(ins.turn_taking.interruption_rate)} of replies)`),
            h("dt", "Slow replies (> 2 s)"), h("dd", fmt.n(ins.turn_taking.slow_replies)),
            h("dt", "User turns per conversation"), h("dd", fmt.n(ins.turn_taking.avg_user_turns, 1)),
            h("dt", "Discarded by the recogniser"), h("dd", fmt.n(ins.turn_taking.stt_discarded)),
            h("dt", "Possibly another voice"), h("dd", fmt.n(ins.turn_taking.uncertain_turns)),
            h("dt", "Language mismatches"), h("dd", fmt.n(ins.language.mismatches))),
          h("h3", { style: "margin-top:14px" }, "How conversations ended"),
          hbars(o.end_reasons.map((r) => ({ label: r.key, n: r.n })), { color: series(7) })),
        card("Plan & memory",
          h("dl.kv", h("dt", "Plan items taken up"), h("dd", `${fmt.pct(ins.plan.taken_rate)} of ${fmt.n(ins.plan.items)}`),
            ...Object.entries(ins.plan.by_kind).flatMap(([kind, v]) => [h("dt", `· ${kind}`), h("dd", `${v.taken} taken, ${v.skipped} skipped`)]),
            h("dt", "Memories saved active"), h("dd", fmt.n(ins.memory.active)),
            h("dt", "Saved as unconfirmed"), h("dd", fmt.n(ins.memory.candidate)),
            h("dt", "User corrected / deleted"), h("dd", `${fmt.n(ins.memory.user_corrections)} / ${fmt.n(ins.memory.user_deletions)}`),
            h("dt", "User confirmed"), h("dd", fmt.n(ins.memory.user_confirmations)),
            h("dt", "Summaries failed"), h("dd", fmt.n(ins.memory.summary_failures))),
          Object.keys(ins.judge).length ? [h("h3", { style: "margin-top:14px" }, "LLM judge, average per criterion"),
            hbars(Object.entries(ins.judge).map(([kk, v]) => ({ label: kk.replace("_", " "), n: v ?? 0 })), { format: (v) => `${v} / 5`, color: series(3) })] : null),
      ),
    ];
  }

  async function sessionsView(params) {
    const flag = params.get("flag"), user = params.get("user_id"), prompt = params.get("prompt"), reviewed = params.get("reviewed");
    const r = await api("/v1/admin/audit/sessions?" + qs({ flag, user_id: user, prompt, reviewed }));
    const filt = [flag && ["flag", (FLAGS[flag] || [0, flag])[1]], user && ["user_id", "user " + user.slice(0, 8)], prompt && ["prompt", "prompt " + prompt],
      reviewed && ["reviewed", reviewed === "1" ? "reviewed" : "not reviewed"]].filter(Boolean);
    const clear = (k) => { const p = new URLSearchParams(params); p.delete(k); location.hash = "#/sessions" + (p.toString() ? "?" + p : ""); };
    return [
      h("div.head", h("div", h("h1", "Conversations"), h("div.muted", `${r.total} in range${r.total > r.sessions.length ? `, newest ${r.sessions.length} shown` : ""}`)),
        h("div.row", h("a.chip", { href: "#/sessions?reviewed=0" + (flag ? "&flag=" + encodeURIComponent(flag) : "") }, "Not reviewed yet"),
          ...filt.map(([k, lab]) => h("button.chip", { type: "button", title: "Remove filter", on: { click: () => clear(k) } }, lab + " ✕")))),
      card(null, table([
        { label: "Started", get: (x) => fmt.dt(x.started_at) },
        { label: "User", get: (x) => h("a", { href: `#/sessions?user_id=${x.user_id}` }, fmt.user(x.user_label, x.user_id)) },
        { label: "Lang", get: (x) => x.language },
        { label: "Length", num: true, get: (x) => fmt.dur(x.duration_s) },
        { label: "User turns", num: true, get: (x) => x.user_turns },
        { label: "Reply p50", num: true, get: (x) => fmt.ms(x.reply_p50) },
        { label: "Bot-speak", num: true, get: (x) => fmt.pct(x.bot_speak_rate) },
        { label: "Score", num: true, get: (x) => scoreBadge(x.score) },
        { label: "Judge", num: true, get: (x) => x.judge ?? "-" },
        { label: "Review", num: true, get: (x) => x.review ? "★".repeat(x.review) : "-" },
        { label: "Cost", num: true, get: (x) => fmt.usd(x.cost_usd) },
        { label: "Flags", wrap: true, get: (x) => h("div.row", x.flags.map((f) => flagChip(f))) },
      ], r.sessions, { onRow: (x) => { location.hash = `#/session/${x.id}`; } })),
    ];
  }

  async function sessionView(id) {
    const d = await api(`/v1/admin/audit/sessions/${encodeURIComponent(id)}`);
    const s = d.session, a = d.audit || {}, q = a.quality || {}, st = s.stats || {};
    const reasons = q.flag_reasons || {};
    const apiUsd = d.llm_calls.reduce((n, c) => n + (Number(c.cost_usd) || 0), 0);
    const gpuUsd = a.cost?.gpu_usd ?? 0;
    const usage = st.usage?.llm;
    const started = new Date(s.started_at).getTime();

    // timeline: turns and notes in time order
    const items = d.turns.map((t) => ({ t: new Date(t.created_at).getTime(), kind: "turn", v: t }))
      .concat((a.notes || []).map((n) => ({ t: started + n.at_s * 1000 + 1, kind: "note", v: n })))
      .sort((x, y) => x.t - y.t);
    const timeline = h("div.timeline", items.length ? items.map((it) => {
      const rel = fmt.dur(Math.max(0, Math.round((it.t - started) / 1000)));
      if (it.kind === "note") {
        return h("div.turn.note", h("div.meta", h("span", "note to the model · " + it.v.kind), h("span", rel), h("span", `${it.v.turns} turn${it.v.turns === 1 ? "" : "s"}`)),
          h("div.text", { dir: "auto" }, it.v.text ?? "[text removed]"));
      }
      const t = it.v, m = t.meta || {};
      const meta = [h("b", t.role === "user" ? (t.attribution === "uncertain" ? "User?" : "User") : "Rolly"), h("span", `#${t.idx}`), h("span", rel)];
      if (t.role === "user") {
        if (t.language) meta.push(h("span", { class: t.language !== s.language && s.language !== "auto" ? "chip high" : "" }, t.language));
        if (m.uncertain_because) meta.push(h("span.chip", m.uncertain_because.replace(/_/g, " ")));
        if (m.barge_in) meta.push(h("span.chip", "barge-in"));
      } else {
        if (m.proactive) meta.push(h("span.chip", "proactive"));
        if (m.interrupted) meta.push(h("span.chip.medium", "interrupted"));
        if (typeof m.reply_ms === "number") meta.push(h("span", { class: m.reply_ms > 2000 ? "chip medium" : "", title: "server reply latency" }, fmt.ms(m.reply_ms)));
        if (typeof m.llm_ttft_ms === "number") meta.push(h("span", { title: "model first token" }, "LLM " + fmt.ms(m.llm_ttft_ms)));
        if (typeof m.tts_ttfa_ms === "number") meta.push(h("span", { title: "voice first audio" }, "TTS " + fmt.ms(m.tts_ttfa_ms)));
        if (typeof m.prompt_tokens === "number") meta.push(h("span", { title: "conversation-model tokens in / out" }, `${fmt.n(m.prompt_tokens)} → ${fmt.n(m.completion_tokens)} tok`));
      }
      return h("div.turn", { class: t.role, id: `turn-${t.idx}` }, h("div.meta", meta), h("div.text", { dir: "auto" }, t.text));
    }) : h("div.empty", `No transcript. Transcripts are deleted after ${d.retention_days} days; the measurements stay.`));

    // prompt tab
    const promptTab = h("div.grid",
      a.redacted ? h("div.callout", a.redacted === "forget"
        ? "The personal part of this prompt was removed because the user deleted or corrected a memory. The persona version and the measurements stay."
        : `The personal part of this prompt was removed after the ${d.retention_days}-day retention period.`) : null,
      h("dl.kv",
        h("dt", "Persona version"), h("dd", a.prompt_hash ? h("a", { href: `#/prompts?hash=${a.prompt_hash}` }, a.prompt_hash + (a.prompt_label ? ` · ${a.prompt_label}` : "")) : "-"),
        h("dt", "Build"), h("dd", a.build || "-"),
        h("dt", "System prompt"), h("dd", `${fmt.n(a.prompt_chars)} chars (memory part ${fmt.n(a.memory_chars)}) · ~${fmt.n(a.prompt_tokens_est)} tokens estimated`
          + (usage ? ` · ${fmt.n(usage.max_prompt_tokens)} tokens measured at the largest turn` : "")),
        h("dt", "Language"), h("dd", `${s.language ?? "-"}${s.onboarding ? " · first ride (onboarding)" : ""}`),
        h("dt", "Sampling override"), h("dd", Object.keys(a.sampling || {}).length ? JSON.stringify(a.sampling) : "none (pod defaults)"),
        h("dt", "Memories injected"), h("dd", `${(a.memory_ids || []).length}`)),
      h("div", h("h3", "Opener instruction"), h("pre.block", { dir: "auto" }, a.opener ?? (a.redacted ? "[removed]" : "(none)"))),
      h("div", h("h3", "Plan for this ride"), (a.plan || []).length ? h("ol", a.plan.map((p) => h("li", { dir: "auto" }, h("span.chip", p.kind), " ", p.topic, p.take ? h("div.muted.small", "take: " + p.take) : null)))
        : h("p.muted", (a.plan_kinds || []).length ? `${a.plan_kinds.join(", ")} (text removed)` : "No plan.")),
      h("div", h("h3", "What Rolly knew (memory part of the system prompt)"), h("pre.block", { dir: "auto" }, a.memory_block ?? (a.redacted ? "[removed]" : "(not recorded)"))),
      h("details", h("summary", "Persona (fixed part of the system prompt)"), h("pre.block", a.persona_text ?? "(not recorded)")),
    );

    const callsTab = table([
      { label: "At", get: (c) => fmt.time(c.at) },
      { label: "Purpose", get: (c) => PURPOSE_LABEL[c.purpose] || c.purpose },
      { label: "Model", get: (c) => c.model },
      { label: "OK", get: (c) => c.ok ? "yes" : h("span.error", { title: c.error || "" }, "failed") },
      { label: "Latency", num: true, get: (c) => fmt.ms(c.ms) },
      { label: "Tokens in", num: true, get: (c) => fmt.n(c.prompt_tokens) },
      { label: "cached", num: true, get: (c) => fmt.n(c.cached_tokens) },
      { label: "out", num: true, get: (c) => fmt.n(c.completion_tokens) },
      { label: "Cost", num: true, get: (c) => fmt.usd(c.cost_usd) },
    ], d.llm_calls, { empty: "No utility-model calls recorded for this conversation." });

    const memTab = h("div.grid.g2",
      card("Learned from this conversation", table([
        { label: "Kind", get: (m) => m.kind }, { label: "Status", get: (m) => h("span", { class: m.status === "active" ? "chip ok" : "chip" }, m.status) },
        { label: "Content", wrap: true, get: (m) => h("span", { dir: "auto" }, m.content) }, { label: "Why", get: (m) => m.reason || "-" },
      ], d.memories_learned, { empty: "Nothing kept from this conversation." })),
      card("Injected into the prompt (as they stand now)", table([
        { label: "Kind", get: (m) => m.kind }, { label: "Status", get: (m) => m.status },
        { label: "Content", wrap: true, get: (m) => h("span", { dir: "auto" }, m.content || "[deleted]") },
      ], d.memories_used, { empty: "No memory items were injected." })),
      card("Memory changes during the session", table([
        { label: "At", get: (e) => fmt.time(e.at) }, { label: "Action", get: (e) => e.action }, { label: "Via", get: (e) => e.via },
      ], d.memory_events, { empty: "None." })),
      card("Summary", h("p", { dir: "auto" }, s.summary?.summary ?? "-"), h("p.muted.small", `method ${s.summary?.method ?? "-"}${s.summary?.error ? " · error: " + s.summary.error : ""}`)),
    );

    // judge & review
    const j = a.judge;
    const judgeBox = h("div", j ? [
      h("div.row", h("span.score", { class: j.overall >= 4 ? "good" : j.overall >= 3 ? "mid" : "bad" }, `${j.overall}/5`), h("span.muted.small", `${j.model} · ${fmt.dt(j.at)}`)),
      j.summary ? h("p", j.summary) : null,
      hbars(Object.entries(j.scores || {}).map(([k, v]) => ({ label: h("span.lab", { title: d.judge_criteria[k] || k }, k.replace("_", " ")), n: v })), { format: (v) => `${v}/5`, color: series(3) }),
      (j.issues || []).length ? [h("h3", { style: "margin-top:12px" }, "Issues"), h("ul", j.issues.map((i) => h("li", i.turn !== null ? h("a", { href: `#/session/${id}`, on: { click: (e) => { e.preventDefault(); document.getElementById(`turn-${i.turn}`)?.scrollIntoView({ block: "center" }); tabs.select(0); } } }, `#${i.turn}`) : null, " ", h("span.chip", i.criterion), " ", i.note)))] : null,
      (j.strengths || []).length ? h("p.muted.small", "Strengths: " + j.strengths.join(" · ")) : null,
    ] : h("p.muted", "Not judged yet."));
    const runJudge = h("button", { type: "button", on: { click: async () => {
      runJudge.disabled = true; runJudge.textContent = "Judging…";
      try { await api(`/v1/admin/audit/sessions/${id}/judge`, { method: "POST", body: "{}" }); route(); }
      catch (e) { runJudge.disabled = false; runJudge.textContent = "Run judge"; alert("Judge failed: " + e.message); }
    } } }, j ? "Run judge again" : "Run judge");

    let rating = a.review_rating ?? null;
    const tags = new Set(a.review_tags || []);
    const stars = h("div.stars", [1, 2, 3, 4, 5].map((n) => h("button", { type: "button", "aria-label": `${n} of 5`, class: rating && n <= rating ? "on" : "", on: { click: () => {
      rating = rating === n ? null : n; [...stars.children].forEach((b, i) => b.classList.toggle("on", !!rating && i < rating)); } } }, String(n))));
    const tagPick = h("div.tagpick", REVIEW_TAGS.map((t) => h("button", { type: "button", class: tags.has(t) ? "on" : "", on: { click: (e) => {
      tags.has(t) ? tags.delete(t) : tags.add(t); e.currentTarget.classList.toggle("on"); } } }, t.replace(/_/g, " "))));
    const note = h("textarea", { placeholder: "What was right or wrong in this conversation?", maxlength: 2000 });
    note.value = a.review_note ?? "";
    const saved = h("span.muted.small", a.reviewed_at ? `saved ${fmt.dt(a.reviewed_at)}` : "");
    const reviewBox = h("div.grid", { style: "gap:10px" }, h("div.row", h("span.muted", "Rating"), stars), tagPick, note,
      h("div.row", h("button.primary", { type: "button", on: { click: async () => {
        try { await api(`/v1/admin/audit/sessions/${id}/review`, { method: "POST", body: JSON.stringify({ rating, tags: [...tags], note: note.value.trim() || null }) }); saved.textContent = "saved"; }
        catch (e) { saved.textContent = "not saved: " + e.message; }
      } } }, "Save review"), saved));

    const tabs = makeTabs([
      ["Timeline", timeline], ["Prompt", promptTab], [`Model calls (${d.llm_calls.length})`, callsTab], ["Memory", memTab],
      ["Judge & review", h("div.grid.g2", card("LLM judge", judgeBox, h("div.row", { style: "margin-top:12px" }, runJudge)), card("Your review", reviewBox))],
    ]);

    return [
      h("div.head",
        h("div", h("div.muted.small", h("a", { href: "#/sessions" }, "Conversations"), " / ", fmt.user(s.user_label, s.user_id)),
          h("h1", `${fmt.dt(s.started_at)} · ${fmt.dur(st.duration_s)}`),
          h("div.row.muted", `${s.language ?? "-"} · ended: ${s.end_reason ?? "open"} · ${s.user_turns} user turns`, s.onboarding ? h("span.chip", "first ride") : null)),
        h("div.row", d.neighbours.prev ? h("a", { href: `#/session/${d.neighbours.prev}` }, "← previous") : null,
          d.neighbours.next ? h("a", { href: `#/session/${d.neighbours.next}` }, "next →") : null,
          h("button", { type: "button", title: "Recompute metrics and flags", on: { click: async () => { await api(`/v1/admin/audit/sessions/${id}/reassess`, { method: "POST", body: "{}" }); route(); } } }, "Reassess"))),
      (a.flags || []).length ? h("div.row", a.flags.map((f) => h("span", { title: reasons[f]?.why }, flagChip(f, reasons[f]?.why)))) : null,
      (a.flags || []).length ? h("ul.small.muted", { style: "margin:0" }, a.flags.map((f) => h("li", `${(FLAGS[f] || [0, f])[1]}: ${reasons[f]?.why ?? ""}`))) : null,
      h("div.tiles",
        tile("Health score", scoreBadge(q.score)),
        tile("Reply p50", fmt.ms(q.reply_ms?.p50), `p95 ${fmt.ms(q.reply_ms?.p95)} · ${q.reply_ms?.slow ?? 0} slow`),
        tile("Interruptions", fmt.n(q.interruptions), `${fmt.pct(q.interruption_rate)} of replies`),
        tile("Bot-speak", fmt.pct(q.style?.bot_speak_rate), `${q.style?.replies ?? 0} replies · ${fmt.n(q.words?.agent_avg, 1)} words avg`),
        tile("Talk ratio", q.words?.talk_ratio ?? "-", "Rolly words per user word"),
        tile("Cost", fmt.usd(apiUsd + gpuUsd), `API ${fmt.usd(apiUsd)} · GPU ${fmt.usd(gpuUsd)}`),
        tile("Model tokens", usage ? fmt.n(usage.prompt_tokens + usage.completion_tokens) : "-", usage ? `${usage.calls} calls · ${usage.model ?? ""}` : "not reported by the pod"),
      ),
      card(null, tabs.el),
    ];
  }
  function makeTabs(list) {
    const bar = h("div.tabs", { role: "tablist" });
    const body = h("div");
    const btns = list.map(([label], i) => h("button", { type: "button", role: "tab", on: { click: () => select(i) } }, label));
    bar.append(...btns);
    function select(i) { btns.forEach((b, j) => b.classList.toggle("on", i === j)); body.replaceChildren(list[i][1]); store.tab("audit.tab", String(i)); }
    select(Math.min(list.length - 1, Number(store.get("audit.tab", "0")) || 0));
    return { el: h("div", bar, body), select };
  }

  /** line diff (LCS); prompts are a few dozen lines */
  function diffLines(a, b) {
    const x = a.split("\n"), y = b.split("\n"), n = x.length, m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = []; let i = 0, j = 0;
    while (i < n && j < m) { if (x[i] === y[j]) { out.push(["", x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push(["del", x[i++]]); else out.push(["add", y[j++]]); }
    while (i < n) out.push(["del", x[i++]]); while (j < m) out.push(["add", y[j++]]);
    return out;
  }

  async function promptsView(params) {
    const r = await api("/v1/admin/audit/prompts?" + qs());
    const vs = r.versions;
    const sel = params.get("hash");
    const left = h("select", vs.map((v) => h("option", { value: v.hash }, `${v.hash}${v.label ? " · " + v.label : ""} (${v.language}, ${fmt.dt(v.first_seen)})`)));
    const right = left.cloneNode(true);
    const out = h("div");
    const showOne = async (hash) => {
      const v = await api(`/v1/admin/audit/prompts/${hash}`);
      out.replaceChildren(h("h3", `Version ${v.hash}`), h("pre.block", v.text));
    };
    const compare = async () => {
      const [a, b] = await Promise.all([api(`/v1/admin/audit/prompts/${left.value}`), api(`/v1/admin/audit/prompts/${right.value}`)]);
      const lines = diffLines(a.text, b.text);
      const changed = lines.filter(([k]) => k).length;
      out.replaceChildren(h("h3", `${a.hash} → ${b.hash} · ${changed} changed line${changed === 1 ? "" : "s"}`),
        h("div.diff.block", { style: "background:var(--surface-2);border-radius:8px;padding:8px 0" }, lines.map(([k, t]) => h("div", { class: k }, (k === "add" ? "+ " : k === "del" ? "− " : "  ") + t))));
    };
    if (vs.length > 1) { left.value = vs[1].hash; right.value = vs[0].hash; }
    if (sel && vs.some((v) => v.hash === sel)) void showOne(sel);
    const label = (v) => h("button.link", { type: "button", title: "Name this version", on: { click: async () => {
      const name = prompt("Name for version " + v.hash + " (empty to clear)", v.label || "");
      if (name === null) return;
      await api(`/v1/admin/audit/prompts/${v.hash}`, { method: "PATCH", body: JSON.stringify({ label: name.trim() || null }) }); route();
    } } }, v.label || "name it");
    return [
      h("div.head", h("div", h("h1", "Prompts"), h("div.muted", "The fixed persona part of the system prompt, one row per distinct text. Metrics: conversations in the selected range that used it."))),
      card(null, table([
        { label: "Version", get: (v) => h("a", { href: `#/prompts?hash=${v.hash}`, class: "mono" }, v.hash) },
        { label: "Name", get: label },
        { label: "Lang", get: (v) => v.language },
        { label: "First seen", get: (v) => fmt.dt(v.first_seen) },
        { label: "Last seen", get: (v) => fmt.dt(v.last_seen) },
        { label: "Persona chars", num: true, get: (v) => fmt.n(v.chars) },
        { label: "Prompt chars p50", num: true, get: (v) => fmt.n(v.prompt_chars_p50) },
        { label: "Tokens p50", num: true, get: (v) => fmt.n(v.metrics?.prompt_tokens_p50 ?? v.tokens_est_p50), },
        { label: "Convs", num: true, get: (v) => v.metrics ? h("a", { href: `#/sessions?prompt=${v.hash}` }, String(v.metrics.conversations)) : "0" },
        { label: "Reply p50", num: true, get: (v) => fmt.ms(v.metrics?.reply_p50) },
        { label: "Bot-speak", num: true, get: (v) => fmt.pct(v.metrics?.bot_speak_rate) },
        { label: "Agree-opener", num: true, get: (v) => fmt.pct(v.metrics?.ack_rate) },
        { label: "Wisdom", num: true, get: (v) => fmt.pct(v.metrics?.platitude_rate) },
        { label: "Words", num: true, get: (v) => fmt.n(v.metrics?.avg_agent_words, 1) },
        { label: "Score", num: true, get: (v) => fmt.n(v.metrics?.avg_score) },
        { label: "Judge", num: true, get: (v) => fmt.n(v.metrics?.judge_avg, 2) },
        { label: "Review", num: true, get: (v) => fmt.n(v.metrics?.review_avg, 2) },
        { label: "Flagged", num: true, get: (v) => fmt.pct(v.metrics?.flagged_share) },
        { label: "Build", get: (v) => v.build || "-" },
      ], vs, { empty: "No prompt recorded yet: versions appear with the first conversation after this deploy." })),
      vs.length ? card("Read or compare", h("div.row", { style: "margin-bottom:12px" }, left, h("span.muted", "→"), right,
        h("button", { type: "button", on: { click: compare } }, "Compare"), h("button", { type: "button", on: { click: () => showOne(right.value) } }, "Show right")), out) : null,
    ];
  }

  async function costsView() {
    const c = await api("/v1/admin/audit/costs?" + qs());
    const t = c.totals;
    const purposes = [...new Set(c.daily.flatMap((d) => Object.keys(d)).filter((k) => k !== "day" && k !== "gpu"))];
    const order = ["summary", "plan", "live_command", "capture", "consolidate", "scrub", "judge", "other"];
    purposes.sort((a, b) => (order.indexOf(a) + 99) % 99 - (order.indexOf(b) + 99) % 99);
    const ser = [{ key: "gpu", label: "GPU time", color: series(1) }, ...purposes.slice(0, 7).map((p, i) => ({ key: p, label: PURPOSE_LABEL[p] || p, color: series(i + 2) }))];
    return [
      h("div.head", h("div", h("h1", "Costs"), h("div.muted", "Variable cost is measured: utility-model tokens at list price, and conversation time on the GPU at its hourly rate."))),
      h("div.tiles",
        tile("Variable spend", fmt.usd(t.variable_usd), `API ${fmt.usd(t.api_usd)} · GPU ${fmt.usd(t.gpu_usd)}`),
        tile("Per conversation minute", fmt.usd(t.usd_per_minute), `API alone ${fmt.usd(t.api_usd_per_minute)}`),
        tile("Minutes talked", fmt.n(t.minutes, 1)),
        tile("Monthly run-rate", fmt.usd(t.monthly_run_rate_usd), `incl. fixed ${fmt.usd(t.fixed_monthly_usd)}/month`),
        tile("Pod if always on", fmt.usd(t.gpu_always_on_usd), `${fmt.usd(c.pricing.gpu_usd_per_hour)}/h for the whole range`,
          "The pod is billed per hour while it exists, used or not. Compare with the GPU time conversations actually used."),
      ),
      card("Spend per day", barChart(c.daily, ser, { format: fmt.usd, title: "Spend per day by purpose" })),
      h("div.grid.g2",
        card("Utility model by purpose", table([
          { label: "Purpose", get: (p) => PURPOSE_LABEL[p.purpose] || p.purpose },
          { label: "Calls", num: true, get: (p) => fmt.n(p.calls) },
          { label: "Failed", num: true, get: (p) => p.failures ? h("a", { href: `#/calls?purpose=${p.purpose}&ok=0`, class: "error" }, String(p.failures)) : "0" },
          { label: "Tokens in", num: true, get: (p) => fmt.n(p.prompt_tokens) },
          { label: "cached", num: true, get: (p) => fmt.n(p.cached_tokens) },
          { label: "out", num: true, get: (p) => fmt.n(p.completion_tokens) },
          { label: "p50", num: true, get: (p) => fmt.ms(p.ms_p50) },
          { label: "p95", num: true, get: (p) => fmt.ms(p.ms_p95) },
          { label: "Cost", num: true, get: (p) => fmt.usd(p.usd) },
        ], c.by_purpose)),
        card("By user", table([
          { label: "User", get: (u) => h("a", { href: `#/sessions?user_id=${u.user_id}` }, fmt.user(u.label, u.user_id)) },
          { label: "Convs", num: true, get: (u) => u.conversations },
          { label: "Minutes", num: true, get: (u) => fmt.n(u.minutes, 1) },
          { label: "API", num: true, get: (u) => fmt.usd(u.api_usd) },
          { label: "GPU", num: true, get: (u) => fmt.usd(u.gpu_usd) },
          { label: "Total", num: true, get: (u) => fmt.usd(u.api_usd + u.gpu_usd) },
        ], c.by_user)),
      ),
      h("div.grid.g2",
        card("By model", table([
          { label: "Model", get: (m) => m.model }, { label: "Calls", num: true, get: (m) => fmt.n(m.calls) },
          { label: "Unpriced calls", num: true, get: (m) => m.unpriced ? h("span.error", { title: "No price for this model: add it to ROLLY_PRICING" }, String(m.unpriced)) : "0" },
          { label: "Cost", num: true, get: (m) => fmt.usd(m.usd) },
        ], c.by_model)),
        card("Prices in use", h("dl.kv",
          ...Object.entries(c.pricing.models).flatMap(([m, p]) => [h("dt", m), h("dd", `$${p.input} in · $${p.cached} cached · $${p.output} out per 1M tokens`)]),
          h("dt", "GPU"), h("dd", `$${c.pricing.gpu_usd_per_hour}/h, shared by ${c.pricing.gpu_sessions_share} conversation(s)`),
          ...Object.entries(c.pricing.fixed_monthly).flatMap(([k, v]) => [h("dt", k), h("dd", `$${v}/month`)])),
          h("p.muted.small", "Change with the ROLLY_PRICING environment variable (JSON). Stored costs keep the prices they were computed with.")),
      ),
    ];
  }

  async function callsView(params) {
    const purpose = params.get("purpose"), ok = params.get("ok");
    const r = await api("/v1/admin/audit/llm-calls?" + qs({ purpose, ok }));
    const pick = h("select", { on: { change: (e) => { const p = new URLSearchParams(params); e.target.value ? p.set("purpose", e.target.value) : p.delete("purpose"); location.hash = "#/calls?" + p; } } },
      h("option", { value: "" }, "All purposes"), Object.entries(PURPOSE_LABEL).filter(([k]) => k !== "gpu").map(([k, v]) => h("option", { value: k, selected: k === purpose }, v)));
    const fails = h("label.check", h("input", { type: "checkbox", checked: ok === "0", on: { change: (e) => { const p = new URLSearchParams(params); e.target.checked ? p.set("ok", "0") : p.delete("ok"); location.hash = "#/calls?" + p; } } }), " Failures only");
    return [
      h("div.head", h("div", h("h1", "Model calls"), h("div.muted", "Every utility-model call (no prompt or answer text is stored). Newest 300.")), h("div.row", pick, fails)),
      card(null, table([
        { label: "At", get: (c) => fmt.dt(c.at) },
        { label: "Purpose", get: (c) => PURPOSE_LABEL[c.purpose] || c.purpose },
        { label: "User", get: (c) => c.user_id ? fmt.user(c.user_label, c.user_id) : "-" },
        { label: "Session", get: (c) => c.session_id ? h("a", { href: `#/session/${c.session_id}`, class: "mono" }, c.session_id.slice(0, 8)) : "-" },
        { label: "Model", get: (c) => c.model },
        { label: "Result", wrap: true, get: (c) => c.ok ? "ok" : h("span.error", c.error || "failed") },
        { label: "Latency", num: true, get: (c) => fmt.ms(c.ms) },
        { label: "Prompt chars", num: true, get: (c) => fmt.n(c.prompt_chars) },
        { label: "Tokens in/out", num: true, get: (c) => c.prompt_tokens === null ? "-" : `${fmt.n(c.prompt_tokens)} / ${fmt.n(c.completion_tokens)}` },
        { label: "Cost", num: true, get: (c) => fmt.usd(c.cost_usd) },
      ], r.calls)),
    ];
  }

  async function usersView() {
    const r = await api("/v1/admin/audit/users?" + qs());
    return [
      h("div.head", h("div", h("h1", "Users"), h("div.muted", "Testers, their use in the selected range, and the state of their memory."))),
      card(null, table([
        { label: "User", get: (u) => h("a", { href: `#/sessions?user_id=${u.id}` }, fmt.user(u.display_label, u.id)) },
        { label: "Since", get: (u) => fmt.dt(u.created_at) },
        { label: "Last conversation", get: (u) => fmt.dt(u.last_session_at) },
        { label: "Devices", num: true, get: (u) => u.devices },
        { label: "Language", get: (u) => u.preferred_language || "-" },
        { label: "Addressing", get: (u) => u.addressing_value ? `${u.addressing_value} (${u.addressing_status})` : "-" },
        { label: "Convs", num: true, get: (u) => u.conversations },
        { label: "Minutes", num: true, get: (u) => fmt.n(u.minutes, 1) },
        { label: "Score", num: true, get: (u) => scoreBadge(u.avg_score) },
        { label: "Flagged", num: true, get: (u) => u.flagged },
        { label: "Memories", num: true, get: (u) => `${u.memories_active} + ${u.memories_candidate} unconfirmed` },
        { label: "Goals", num: true, get: (u) => u.goals_active },
        { label: "User fixes", num: true, get: (u) => u.user_fixes, },
        { label: "Cost", num: true, get: (u) => fmt.usd(u.cost_usd) },
      ], r.users, { onRow: (u) => { location.hash = `#/sessions?user_id=${u.id}`; } })),
    ];
  }

  /** Sign-ups from the landing page (heyrolly.ai). The range filter applies to the chart and "in range". */
  async function waitlistView() {
    const r = await api("/v1/admin/waitlist?" + qs());
    const sm = r.summary;
    TZ = sm.time_zone || TZ;
    const LANG = { he: "Hebrew", en: "English" };
    const people = [...r.items].reverse(); // newest first
    const download = async () => {
      const res = await fetch("/v1/admin/waitlist?format=csv", { headers: { Authorization: `Bearer ${store.get("audit.token", "")}` } });
      if (!res.ok) { status("Export failed: HTTP " + res.status); return; }
      const url = URL.createObjectURL(await res.blob());
      const a = h("a", { href: url, download: `rolly-waitlist-${new Date().toISOString().slice(0, 10)}.csv` });
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
    };
    const copy = async (btn) => {
      try { await navigator.clipboard.writeText(people.map((p) => p.email).join("\n")); btn.textContent = `Copied ${people.length}`; }
      catch { btn.textContent = "Copy failed"; }
      setTimeout(() => { btn.textContent = "Copy emails"; }, 1800);
    };
    const remove = async (p) => {
      if (!confirm(`Remove ${p.email} from the waitlist? This cannot be undone.`)) return;
      await api(`/v1/admin/waitlist/${p.id}`, { method: "DELETE" });
      route();
    };
    const listBox = h("div");
    const draw = (needle) => {
      const n = needle.trim().toLowerCase();
      const rows = n ? people.filter((p) => p.email.includes(n) || (p.source || "").toLowerCase().includes(n)) : people;
      listBox.replaceChildren(table([
        { label: "#", num: true, get: (p) => p.position },
        { label: "Email", get: (p) => h("a", { href: `mailto:${p.email}` }, p.email) },
        { label: "Language", get: (p) => LANG[p.lang] || p.lang || "-" },
        { label: "Came from", wrap: true, get: (p) => p.source || h("span.muted", "direct") },
        { label: "Signed up", get: (p) => fmt.dt(p.created_at) },
        { label: "", num: true, get: (p) => h("button.link", { type: "button", title: "Remove from the list", on: { click: () => remove(p) } }, "Remove") },
      ], rows, { empty: n ? "No one matches." : "No sign-ups yet. Share heyrolly.ai!" }));
    };
    draw("");
    const copyBtn = h("button", { type: "button", on: { click: (e) => copy(e.currentTarget) } }, "Copy emails");
    return [
      h("div.head",
        h("div", h("h1", "Waitlist"), h("div.muted", h("a", { href: "https://heyrolly.ai", target: "_blank", rel: "noopener" }, "heyrolly.ai"), " sign-ups · one email each when the app is ready")),
        h("div.row", copyBtn, h("button.primary", { type: "button", on: { click: download } }, "Export CSV"))),
      h("div.tiles",
        tile("On the list", fmt.n(sm.total)),
        tile("Today", fmt.n(sm.today)),
        tile("Last 7 days", fmt.n(sm.week)),
        tile(sm.days === 1 ? "In range (today)" : `Last ${sm.days} days`, fmt.n(sm.in_range)),
        tile("Hebrew / English", `${fmt.n(sm.he)} / ${fmt.n(sm.en)}`, sm.total ? `${fmt.pct(sm.he / sm.total)} Hebrew` : null, "The page's language when they signed up (Israel time zone → Hebrew)")),
      h("div.grid.g2",
        card("Sign-ups per day", barChart(sm.daily, [{ key: "signups", label: "Sign-ups", color: series(7) }], { format: (v) => fmt.n(v), title: "Sign-ups per day", integer: true })),
        card("Where they came from",
          h("p.muted.small", "utm_source or ?ref= in the link, otherwise the referring site."),
          hbars(sm.sources.map((x) => ({ label: x.source, n: x.n })), { color: series(5) }))),
      card(null,
        h("div.row", { style: "margin-bottom:12px" },
          h("input", { type: "search", placeholder: "Search email or source", "aria-label": "Search the waitlist", style: "min-width:260px", on: { input: (e) => draw(e.target.value) } }),
          h("span.muted.small", `${fmt.n(r.count)} total`)),
        listBox),
    ];
  }

  // ------------------------------------------------------------------ router
  function route() {
    hideTip();
    if (!store.get("audit.token", "")) return showLogin();
    const [path, query] = (location.hash.slice(1) || "/overview").split("?");
    const params = new URLSearchParams(query || "");
    const parts = path.split("/").filter(Boolean);
    const name = parts[0] || "overview";
    document.querySelectorAll("#nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === (name === "session" ? "sessions" : name)));
    $("#filters").hidden = name === "session";
    $("#f-selftest").closest("label").hidden = name === "waitlist";
    const views = { overview: overviewView, sessions: () => sessionsView(params), session: () => sessionView(parts[1]), prompts: () => promptsView(params),
      costs: costsView, calls: () => callsView(params), users: usersView, waitlist: waitlistView };
    if (name !== "session") store.tab("audit.tab", "0");
    void render(views[name] || overviewView);
    window.scrollTo(0, 0);
  }
  window.addEventListener("hashchange", route);
  if (!store.get("audit.token", "")) showLogin(); else route();
})();
