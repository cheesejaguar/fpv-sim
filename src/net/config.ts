// Where the multiplayer relay (server/, a Cloudflare Worker) lives, in priority order:
//  - a per-browser override saved from the Multiplayer tab (for self-hosted relays)
//  - VITE_MP_URL at build time
//  - local development: the `wrangler dev` default port
//  - the project's public relay
export const PUBLIC_RELAY = 'wss://fpv-sim-rooms.newsanjose.workers.dev';

/** Inside the offline native app (visionos/): there is no relay to reach (rooms, leaderboard, user maps). */
const offlineHost = () => typeof window !== 'undefined' && !!(window as unknown as { webkit?: { messageHandlers?: { fpvNative?: unknown } } }).webkit?.messageHandlers?.fpvNative;

export function multiplayerUrl(): string | null {
  if (offlineHost()) return null;
  try { const o = localStorage.getItem('fpv-mp-url'); if (o) return o; } catch { /* ignore */ }
  const env = (import.meta as any).env?.VITE_MP_URL as string | undefined;
  if (env) return env;
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return 'ws://127.0.0.1:8787';
  return PUBLIC_RELAY;
}

export function setMultiplayerUrl(url: string | null) {
  try { if (url) localStorage.setItem('fpv-mp-url', url); else localStorage.removeItem('fpv-mp-url'); } catch { /* ignore */ }
}
