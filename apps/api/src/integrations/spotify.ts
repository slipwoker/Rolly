/**
 * Spotify catalogue search: songs, artists, albums, podcasts (shows) and episodes. Needs only the app's own credentials
 * (client-credentials flow), no user sign-in: the user's account is not touched. Recommendations are the companion's own
 * taste applied to what the search returns (Spotify closed its recommendations endpoint to new apps).
 */
import { form, type Http } from "./http.ts";

export interface SpotifyConfig { clientId: string; clientSecret: string; market: string }
export type MusicKind = "track" | "artist" | "album" | "show" | "episode" | "any";
export interface MusicHit { kind: "track" | "artist" | "album" | "show" | "episode"; name: string; by: string | null; detail: string | null; url: string | null; image: string | null }

let cached: { token: string; exp: number; key: string } | null = null;

async function token(http: Http, c: SpotifyConfig): Promise<string> {
  if (cached && cached.key === c.clientId && cached.exp > Date.now() + 30_000) return cached.token;
  const r = await http("https://accounts.spotify.com/api/token", { method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: "Basic " + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64") },
    body: form({ grant_type: "client_credentials" }) });
  const j = r.json as { access_token?: string; expires_in?: number } | null;
  if (!r.ok || !j?.access_token) throw new Error(`spotify token HTTP ${r.status}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000, key: c.clientId };
  return j.access_token;
}
export const resetSpotifyToken = () => { cached = null; };

type Item = Record<string, unknown> & { name?: string; external_urls?: { spotify?: string } };
const url = (i: Item) => i.external_urls?.spotify ?? null;
/** cover art: Spotify lists sizes largest first; the middle one (~300 px) is right for a card */
const image = (i: Item) => {
  const imgs = ((i.images ?? (i.album as Item | undefined)?.images) as { url?: string }[] | undefined) ?? [];
  return (imgs[1] ?? imgs[0])?.url ?? null;
};

export async function search(http: Http, c: SpotifyConfig, q: string, kind: MusicKind): Promise<MusicHit[]> {
  const types = kind === "any" ? "track,artist,show,episode" : kind;
  const r = await http("https://api.spotify.com/v1/search?" + form({ q: q.slice(0, 200), type: types, limit: kind === "any" ? "3" : "5", market: c.market }), { headers: { Authorization: `Bearer ${await token(http, c)}` } });
  if (!r.ok) throw new Error(`spotify search HTTP ${r.status}`);
  const j = (r.json ?? {}) as Record<string, { items?: (Item | null)[] } | undefined>;
  const hits: MusicHit[] = [];
  const names = (a: unknown) => (Array.isArray(a) ? (a as Item[]).map((x) => x.name).filter(Boolean).slice(0, 2).join(", ") : null) || null;
  for (const i of j.tracks?.items ?? []) if (i) hits.push({ kind: "track", name: String(i.name), by: names(i.artists), detail: (i.album as Item | undefined)?.name ? String((i.album as Item).name) : null, url: url(i), image: image(i) });
  for (const i of j.artists?.items ?? []) if (i) hits.push({ kind: "artist", name: String(i.name), by: null, detail: names(i.genres ? (i.genres as string[]).map((g) => ({ name: g })) : null), url: url(i), image: image(i) });
  for (const i of j.albums?.items ?? []) if (i) hits.push({ kind: "album", name: String(i.name), by: names(i.artists), detail: String(i.release_date ?? "").slice(0, 4) || null, url: url(i), image: image(i) });
  for (const i of j.shows?.items ?? []) if (i) hits.push({ kind: "show", name: String(i.name), by: i.publisher ? String(i.publisher) : null, detail: i.description ? String(i.description).slice(0, 140) : null, url: url(i), image: image(i) });
  for (const i of j.episodes?.items ?? []) if (i) hits.push({ kind: "episode", name: String(i.name), by: null, detail: i.description ? String(i.description).slice(0, 140) : null, url: url(i), image: image(i) });
  return hits;
}

// ------------------------------------------------------------------------------------------------------------------
// The user's own Spotify account: playback on their phone. Scopes: start playback and see devices (read/modify
// playback state) and their plan (Premium is required by Spotify to control playback).
export const SPOTIFY_SCOPES = ["user-modify-playback-state", "user-read-playback-state", "user-read-private"];

export interface SpotifyOAuth { clientId: string; clientSecret: string; redirectUri: string }
const basic = (c: { clientId: string; clientSecret: string }) => "Basic " + Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64");

export function authUrl(c: SpotifyOAuth, state: string): string {
  return "https://accounts.spotify.com/authorize?" + form({ client_id: c.clientId, response_type: "code", redirect_uri: c.redirectUri, scope: SPOTIFY_SCOPES.join(" "), state, show_dialog: "true" });
}

export async function exchangeCode(http: Http, c: SpotifyOAuth, code: string): Promise<{ refreshToken: string; account: string | null } | null> {
  const r = await http("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(c) },
    body: form({ grant_type: "authorization_code", code, redirect_uri: c.redirectUri }) });
  const j = r.json as { access_token?: string; refresh_token?: string } | null;
  if (!r.ok || !j?.access_token || !j.refresh_token) return null;
  const me = await http("https://api.spotify.com/v1/me", { headers: { Authorization: `Bearer ${j.access_token}` } }).catch(() => null);
  const m = me?.json as { display_name?: string; id?: string } | null;
  return { refreshToken: j.refresh_token, account: m?.display_name || m?.id || null };
}

export class SpotifyAuthLost extends Error {}

/** Spotify may hand back a NEW refresh token on refresh: the caller stores it when present. */
export async function userToken(http: Http, c: SpotifyOAuth, refreshToken: string): Promise<{ accessToken: string; refreshToken: string | null }> {
  const r = await http("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: basic(c) },
    body: form({ grant_type: "refresh_token", refresh_token: refreshToken }) });
  const j = r.json as { access_token?: string; refresh_token?: string; error?: string } | null;
  if (r.status === 400 && j?.error === "invalid_grant") throw new SpotifyAuthLost("the user revoked access");
  if (!r.ok || !j?.access_token) throw new Error(`spotify token HTTP ${r.status}`);
  return { accessToken: j.access_token, refreshToken: j.refresh_token ?? null };
}

/** https://open.spotify.com/track/ID?... -> what the player API takes */
export function playTarget(url: string): { kind: MusicKind; uri: string; context: boolean } | null {
  const m = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|episode|album|artist|show)\/([A-Za-z0-9]+)/.exec(url);
  if (!m) return null;
  const kind = m[1] as MusicKind;
  return { kind, uri: `spotify:${kind}:${m[2]}`, context: kind === "album" || kind === "artist" || kind === "show" };
}

export type PlayCheck = { ok: true; deviceId: string; deviceName: string } | { ok: false; reason: "premium" | "no_device" | "failed" };

/** Before anything is said: is this account Premium, and is there a Spotify app on a device that can play? */
export async function canPlay(http: Http, accessToken: string): Promise<PlayCheck> {
  const auth = { Authorization: `Bearer ${accessToken}` };
  const me = await http("https://api.spotify.com/v1/me", { headers: auth });
  if (!me.ok) return { ok: false, reason: "failed" };
  if ((me.json as { product?: string } | null)?.product !== "premium") return { ok: false, reason: "premium" };
  const d = await http("https://api.spotify.com/v1/me/player/devices", { headers: auth });
  if (!d.ok) return { ok: false, reason: "failed" };
  const devices = ((d.json as { devices?: { id: string | null; name: string; type: string; is_active: boolean; is_restricted: boolean }[] } | null)?.devices ?? []).filter((x) => x.id && !x.is_restricted);
  const pick = devices.find((x) => x.is_active) ?? devices.find((x) => x.type === "Smartphone") ?? devices[0];
  return pick ? { ok: true, deviceId: pick.id!, deviceName: pick.name } : { ok: false, reason: "no_device" };
}

export async function startPlayback(http: Http, accessToken: string, deviceId: string, t: { uri: string; context: boolean }): Promise<boolean> {
  const r = await http("https://api.spotify.com/v1/me/player/play?" + form({ device_id: deviceId }), { method: "PUT",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, body: JSON.stringify(t.context ? { context_uri: t.uri } : { uris: [t.uri] }) });
  return r.ok; // 204
}

export async function pausePlayback(http: Http, accessToken: string): Promise<void> {
  await http("https://api.spotify.com/v1/me/player/pause", { method: "PUT", headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => {});
}

/** Is what we started still the thing playing? false = it ended, the user stopped it, or Spotify moved on to something else (autoplay). */
export async function stillPlaying(http: Http, accessToken: string, t: { uri: string; context: boolean }): Promise<boolean | "error"> {
  const r = await http("https://api.spotify.com/v1/me/player", { headers: { Authorization: `Bearer ${accessToken}` } }).catch(() => null);
  if (!r || (!r.ok && r.status !== 204)) return "error";
  const j = r.json as { is_playing?: boolean; item?: { uri?: string } | null; context?: { uri?: string } | null } | null;
  if (!j || !j.is_playing) return false; // 204: nothing playing
  return t.context ? j.context?.uri === t.uri : j.item?.uri === t.uri;
}
