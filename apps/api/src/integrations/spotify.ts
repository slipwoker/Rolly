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

/** https://open.spotify.com/track/ID?... -> what the player API takes */
export function playTarget(url: string): { kind: MusicKind; uri: string; context: boolean } | null {
  const m = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]+\/)?(track|episode|album|artist|show)\/([A-Za-z0-9]+)/.exec(url);
  if (!m) return null;
  const kind = m[1] as MusicKind;
  return { kind, uri: `spotify:${kind}:${m[2]}`, context: kind === "album" || kind === "artist" || kind === "show" };
}
