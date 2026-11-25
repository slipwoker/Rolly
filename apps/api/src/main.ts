import { loadConfig, missingSettings } from "./config.ts";
import { buildServer } from "./server.ts";
import { buildContext, emptyMemory } from "./persona/promptBuilder.ts";
import type { SessionHooks } from "./voice/session.ts";

const config = loadConfig();

/** Hooks without a database: a fixed, empty memory. Used only when DATABASE_URL is not set (relay development). */
const statelessHooks: SessionHooks = {
  async prepare(userId, sessionId, start) {
    const built = buildContext(emptyMemory(), { language: start.language ?? "he", journey: { ...start.journey, proactive: start.proactive ?? true }, timeZone: config.timezone });
    return {
      onboarding: built.onboarding,
      ctx: { session_id: sessionId, user_id: userId, language: built.language, system_prompt: built.system_prompt,
        opener_instruction: built.opener_instruction, proactive: start.proactive ?? true, journey: start.journey ?? {}, profile: built.profile, options: {} },
    };
  },
  async finalize({ turns }) { return { method: "none", turns: turns.length }; },
};

async function main() {
  let deps;
  const missing = missingSettings(config);
  if (process.env.NODE_ENV === "production" && (!config.databaseUrl || !config.gpuApiKey)) {
    // not configured yet: answer /healthz with what is missing, refuse everything else
    deps = { config, hooks: statelessHooks, consumeTicket: async () => null, health: async () => ({ configured: false, missing }) };
  } else if (config.databaseUrl) {
    const { createApp } = await import("./app.ts");
    const full = await createApp(config);
    deps = { ...full, health: async () => ({ ...(await full.health!()), configured: missing.length === 0, missing }) };
  } else {
    deps = { config, hooks: statelessHooks, consumeTicket: async () => null };
  }
  const app = await buildServer(deps);
  await app.listen({ port: config.port, host: config.host });
}

main().catch((e) => { console.error(e); process.exit(1); });
