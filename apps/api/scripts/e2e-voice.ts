/**
 * Run a scripted conversation from wherever rolly-api's voice socket is reachable (not from the Claude sandbox: its proxy
 * does not pass WebSocket upgrades — use POST /v1/admin/selftest there instead).
 *
 *   npx tsx scripts/e2e-voice.ts --api ws://127.0.0.1:8080 --dev-user e2e-1 [--lang he] [--out <dir>]
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { LINES, runConversation } from "../src/selftest/scenarios.ts";

const args = Object.fromEntries(process.argv.slice(2).reduce<[string, string][]>((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1]!.startsWith("--") ? arr[i + 1]! : "1"]);
  return acc;
}, []));
const api = args.api ?? "ws://127.0.0.1:8080";
const lang = (args.lang ?? "he") as "he" | "en";
const out = resolve(args.out ?? "e2e-out");
const wsUrl = args.ticket ? `${api}/v1/voice?ticket=${args.ticket}` : `${api}/v1/voice?dev_user=${encodeURIComponent(args["dev-user"] ?? "e2e")}`;

const r = await runConversation({
  wsUrl, lang, outDir: out, label: "e2e", steps: LINES[lang].relay,
  pod: { url: process.env.ROLLY_GPU_WORKER_URL ?? "https://gn48mxl9lsf1nv-8000.proxy.runpod.net/v1", apiKey: process.env.ROLLY_GPU_API_KEY ?? "proxy-injected" },
});
mkdirSync(out, { recursive: true });
const f = resolve(out, `e2e_${lang}_${new Date().toISOString().replace(/[:.]/g, "").slice(0, 15)}.json`);
writeFileSync(f, JSON.stringify(r, null, 2));
for (const t of r.turns) console.log(`[${t.label}] ${t.interrupted ? "(interrupted) " : ""}${t.reply_latency_ms ?? ""} :: ${t.text}`);
console.log(r.ok ? "OK" : `FAILED: ${r.error}`, f);
process.exit(r.ok ? 0 : 1);
