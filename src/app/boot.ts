// Boot guard. main.ts imports this module first, so it runs before the rest of the app: it checks
// that the browser can run the simulator and shows a readable page instead of a blank one when it
// can't. Until the menu is up (bootDone), anything thrown also ends on a page with a way out:
// "Reset saved settings" clears this site's storage, the usual fix after a bad saved value.
// Keep it free of app imports (dom.ts has none) so nothing else has run when it starts.
import { el } from '../ui/dom';

export const SUPPORTED_BROWSERS = 'Chrome or Edge 97+, Firefox 114+, or Safari 16.4+';
const ISSUES_URL = 'https://github.com/cheesejaguar/fpv-sim/issues/new';
const VERSION: string = import.meta.env.VITE_APP_VERSION ?? 'dev';
const HW_ACCEL = 'Check that hardware acceleration is on (Chrome / Edge: Settings, System, "Use graphics acceleration when available"; Firefox: Settings, General, Performance), update your graphics driver, or try another browser.';

export interface Missing { what: string; fix: string }

/**
 * Module workers: start (and at once stop) an empty one. Browsers that don't know the `type`
 * option never read it (the getter), and Firefox < 114 reads it but throws.
 */
function moduleWorkers(): boolean {
  let typeRead = false;
  const opts: WorkerOptions = { get type() { typeRead = true; return 'module' as const; } };
  let url = '';
  try {
    url = URL.createObjectURL(new Blob([''], { type: 'text/javascript' }));
    new Worker(url, opts).terminate();
    return typeRead;
  } catch { return false; } finally { if (url) URL.revokeObjectURL(url); }
}

/** What this browser lacks to run the simulator (empty: good to go). */
export function missingFeatures(): Missing[] {
  const missing: Missing[] = [];
  let gl: WebGL2RenderingContext | null = null;
  try { gl = document.createElement('canvas').getContext('webgl2'); } catch { /* no WebGL */ }
  if (!gl) missing.push({ what: 'WebGL 2 (3D graphics)', fix: `WebGL 2 is off or blocked. ${HW_ACCEL}` });
  else if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
    missing.push({ what: 'Floating-point render targets (EXT_color_buffer_float)', fix: `Your graphics driver doesn't offer them to the browser. ${HW_ACCEL}` });
  }
  // the probe's context is released at once: browsers cap live WebGL contexts per page (and per GPU
  // process), and this one would otherwise linger until garbage collection
  try { gl?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* best effort */ }
  if (typeof WebAssembly !== 'object' || typeof WebAssembly.instantiate !== 'function') {
    missing.push({ what: 'WebAssembly (runs the Betaflight firmware)', fix: 'WebAssembly is turned off, for example by Lockdown Mode on Apple devices or by a browser policy. Allow it for this site.' });
  }
  if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer !== 'function') {
    missing.push(!isSecureContext
      ? { what: 'A secure connection (HTTPS)', fix: 'The simulator needs SharedArrayBuffer, which browsers only allow over HTTPS or on localhost. Open the https:// address.' }
      : typeof SharedArrayBuffer === 'function' || 'crossOriginIsolated' in globalThis
        ? { what: 'Cross-origin isolation (SharedArrayBuffer)', fix: `The page arrived without its isolation headers (COOP / COEP). This happens behind some proxies and in apps' built-in browsers: open the site directly in your browser.${import.meta.env.DEV ? ' Developers: serve it with "npm run dev" or "npm run preview", which send the headers.' : ''}` }
        : { what: 'SharedArrayBuffer', fix: 'This browser version is too old. Update it.' });
  }
  if (!moduleWorkers()) missing.push({ what: 'Module workers', fix: 'This browser version is too old. Update it.' });
  return missing;
}

// ---------------------------------------------------------------------------------------------
// Full-page messages

let shownFatal = false;
const beforeReset: (() => void)[] = [];
/** Run before "Reset saved settings" clears storage (main.ts: stop the worker, which holds the EEPROM database open). */
export function onBeforeReset(f: () => void) { beforeReset.push(f); }

/** Remove every fpv-* localStorage value and the firmware's IndexedDB database (EEPROM). */
export async function clearSavedData(): Promise<void> {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('fpv-')) keys.push(k); }
    for (const k of keys) localStorage.removeItem(k);
  } catch { /* storage unavailable: nothing saved */ }
  await new Promise<void>((done) => {
    try {
      const r = indexedDB.deleteDatabase('fpv-sim');
      r.onsuccess = r.onerror = () => done();
      setTimeout(done, 3000); // still blocked by an open connection: reload anyway, the delete completes then
    } catch { done(); }
  });
}

const C = { bg: '#0f0f23', card: '#1e1c35', fg: '#e2e8f0', muted: '#94a3b8', primary: '#7c3aed', secondary: '#a78bfa', border: 'rgba(167, 139, 250, 0.22)', danger: '#fca5a5' };
const button = (label: string, primary: boolean, onclick: () => void) => el('button', {
  type: 'button', onclick,
  style: { font: 'inherit', fontWeight: '600', fontSize: '15px', padding: '10px 18px', borderRadius: '9px', cursor: 'pointer', minHeight: '44px', border: `1px solid ${primary ? C.primary : C.border}`, background: primary ? C.primary : 'transparent', color: primary ? '#fff' : C.fg },
}, label);

export interface FatalPage {
  title: string;
  lead: string;
  items?: Missing[];
  /** technical detail (error message, stack), shown folded */
  detail?: string;
  /** offer "Reset saved settings" (boot errors) */
  reset?: boolean;
  /** text for the bug report */
  report?: string;
}

/** Replace the screen with a message. The first one wins (a later error is usually a consequence). */
export function showFatal(p: FatalPage) {
  if (shownFatal) return;
  shownFatal = true;
  const body = `Version: ${VERSION}\nBrowser: ${navigator.userAgent}\n\n${p.report ?? p.title}\n`;
  const reportUrl = `${ISSUES_URL}?${new URLSearchParams({ title: p.title, body: '```\n' + body.slice(0, 1500) + '```\n\nWhat were you doing when it happened?\n' })}`;
  const reset = button('Reset saved settings', true, async () => {
    reset.setAttribute('disabled', ''); reset.textContent = 'Resetting…';
    for (const f of beforeReset) try { f(); } catch { /* ignore */ }
    await clearSavedData();
    location.reload();
  });
  const page = el('div', {
    role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'fpv-fatal-title',
    style: { position: 'fixed', inset: '0', zIndex: '2147483647', overflow: 'auto', background: `radial-gradient(ellipse at top, #1b1840 0%, ${C.bg} 60%) ${C.bg}`, color: C.fg, font: "16px/1.55 'Chakra Petch', system-ui, -apple-system, 'Segoe UI', sans-serif", padding: '40px 16px' },
  }, el('div', { style: { maxWidth: '640px', margin: '0 auto', background: C.card, border: `1px solid ${C.border}`, borderRadius: '14px', padding: '24px', boxShadow: '0 18px 40px rgba(0,0,0,.45)' } },
    el('h1', { id: 'fpv-fatal-title', style: { font: "400 26px/1.25 'Russo One', 'Chakra Petch', system-ui, sans-serif", margin: '0 0 12px' } }, p.title),
    el('p', { style: { margin: '0 0 14px', color: C.fg } }, p.lead),
    p.items?.length ? el('ul', { style: { margin: '0 0 14px', paddingLeft: '20px' } }, ...p.items.map((m) => el('li', { style: { margin: '0 0 8px' } }, el('b', { style: { color: C.danger } }, m.what), el('br'), el('span', { style: { color: C.muted } }, m.fix)))) : null,
    p.items ? el('p', { style: { margin: '0 0 14px', color: C.muted } }, `Supported browsers: ${SUPPORTED_BROWSERS}, on a computer with hardware graphics acceleration.`) : null,
    p.detail ? el('details', { style: { margin: '0 0 16px', color: C.muted } }, el('summary', { style: { cursor: 'pointer' } }, 'Technical details'),
      el('pre', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: '13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', background: 'rgba(255,255,255,.05)', padding: '10px', borderRadius: '8px', margin: '8px 0 0' } }, `${p.detail}\n\nVersion ${VERSION}`)) : null,
    el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' } },
      p.reset ? reset : null,
      button('Reload', !p.reset, () => location.reload()),
      el('a', { href: reportUrl, target: '_blank', rel: 'noopener', style: { color: C.secondary, marginLeft: '6px' } }, 'Report a bug')),
  ));
  (document.body ?? document.documentElement).append(page);
  page.querySelector<HTMLElement>('button')?.focus();
}

// ---------------------------------------------------------------------------------------------
// Boot: feature checks now, then catch anything thrown until bootDone()

const describe = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}${e.stack ? `\n${e.stack}` : ''}` : String(e));

function onBootError(ev: ErrorEvent) {
  const e = ev.error ?? ev.message;
  showFatal({
    title: 'FPV Sim couldn’t start',
    lead: 'Something went wrong while starting. Saved settings from an older version can cause this: resetting them usually fixes it. That clears this site’s settings, controller profiles and the simulated flight controller’s saved configuration in this browser.',
    detail: describe(e), reset: true, report: describe(e),
  });
}
window.addEventListener('error', onBootError);

/** The menu is up: from here on, errors go to the console and the HUD as usual. */
export function bootDone() { window.removeEventListener('error', onBootError); }

{
  const missing = missingFeatures();
  if (missing.length) {
    showFatal({
      title: 'This browser can’t run FPV Sim',
      lead: 'FPV Sim runs the real Betaflight firmware and a 3D world in your browser. It needs a few things this browser doesn’t offer right now:',
      items: missing, report: `Unsupported browser: ${missing.map((m) => m.what).join(', ')}`,
    });
    // stop here: the rest of the app must not start (this error is expected and stays on this page)
    throw new Error(`FPV Sim cannot run in this browser: ${missing.map((m) => m.what).join(', ')}`);
  }
}
