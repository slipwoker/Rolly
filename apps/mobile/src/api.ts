/**
 * HTTP client for rolly-api. No sign-in screen: on first launch the app enrolls this phone silently with the build's
 * enrollment key and keeps only its own device refresh token (iOS Keychain via expo-secure-store) plus a short-lived
 * access token in memory. No pipeline or OpenAI key is ever on the device.
 */
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";

export const API_URL: string = process.env.EXPO_PUBLIC_API_URL ?? (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl ?? "https://rolly-api.onrender.com";
export const WS_URL = API_URL.replace(/^http/, "ws");

const REFRESH_KEY = "rolly.refresh";
let access: { token: string; exp: number } | null = null;
let refreshing: Promise<string> | null = null;

export class AuthError extends Error {}

/** Build-time gate for enrollment (EXPO_PUBLIC_ROLLY_ENROLLMENT_KEY, set on the build machine / in EAS, never committed). */
const ENROLLMENT_KEY = process.env.EXPO_PUBLIC_ROLLY_ENROLLMENT_KEY ?? "";

async function saveTokens(j: { refresh_token: string; access_token: string; expires_in: number }) {
  await SecureStore.setItemAsync(REFRESH_KEY, j.refresh_token, { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY });
  access = { token: j.access_token, exp: Date.now() + (j.expires_in - 30) * 1000 };
}

/** First launch: register this phone as a new primary user. */
async function enroll(): Promise<string> {
  if (!ENROLLMENT_KEY) throw new AuthError("this build has no enrollment key");
  const r = await fetch(`${API_URL}/v1/auth/enroll`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollment_key: ENROLLMENT_KEY, device_name: Device.modelName ?? "iPhone" }) });
  if (r.status === 401) throw new AuthError("enrollment refused (wrong build key)");
  if (r.status === 403) throw new AuthError("no more users can be enrolled");
  if (!r.ok) throw new Error(`enrollment failed (${r.status})`);
  const j = await r.json();
  await saveTokens(j);
  return j.access_token as string;
}

/** Forget this phone's credentials (after account deletion); the next launch enrolls afresh. */
export async function forgetDevice(): Promise<void> {
  access = null;
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}

async function accessToken(): Promise<string> {
  if (access && access.exp > Date.now()) return access.token;
  // refresh tokens rotate: never run two refreshes at once
  refreshing ??= (async () => {
    const rt = await SecureStore.getItemAsync(REFRESH_KEY);
    if (!rt) return enroll();
    const r = await fetch(`${API_URL}/v1/auth/refresh`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: rt }) });
    // device revoked or account deleted on the server: start over as a new user
    if (r.status === 401) { await forgetDevice(); return enroll(); }
    if (!r.ok) throw new Error(`refresh failed (${r.status})`);
    const j = await r.json();
    await saveTokens(j);
    return j.access_token as string;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const tok = await accessToken();
  const r = await fetch(`${API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: { Authorization: `Bearer ${tok}`, ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (r.status === 401) { access = null; throw new AuthError("unauthorized"); }
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

/** Call at launch so the first conversation does not wait for enrollment. */
export async function warmUp(): Promise<void> {
  await accessToken();
}

export async function voiceTicket(): Promise<string> {
  return (await api<{ ticket: string }>("/v1/voice/ticket", { method: "POST", body: {} })).ticket;
}
