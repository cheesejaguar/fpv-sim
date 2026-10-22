// Simulation + presentation settings.
import { filesFromDrop, filesFromList, loadLocalMap } from '../maps/localMaps';
import { MapFormatError } from '../maps/mapError';
import { MAP_LIST, MapEntry, MAPS } from '../maps/maps';
import type { TimeOfDay } from '../render/sky';
import { SimSettings } from '../worker/shared';
import { checkbox, el, onUnmount, section, select, slider } from './dom';

export interface ViewSettings {
  osdFont: string;
  renderScale: number;
  cubeSize: number; // px per cube face; 0 = automatic from the video system (autoCubeSize)
  displayCompMs: number;   // subtract the monitor/browser pipeline from the emulated latency
  displayCompAuto: boolean; // estimate it from the measured frame interval instead
  latencyOverrideMs: number; // 0 = from video system
  audio: boolean; volume: number;
  telemetry: boolean;
  osd: boolean;
  view: 'fpv' | 'chase' | 'los';
  linkEffects: boolean;
  highlightGate: boolean;  // make the next race gate glow
  timeOfDay: TimeOfDay;    // 'map' = lit as the map was authored
  goggleOverlay: boolean;  // the goggles' own signal / bitrate / DVR readout
  beeperVolume: number;    // Betaflight's beeper and the DShot beacon, relative to the motors
}

export const TIMES_OF_DAY: { value: TimeOfDay; label: string }[] = [
  { value: 'map', label: 'As the map is set' }, { value: 'morning', label: 'Morning' }, { value: 'noon', label: 'Noon' },
  { value: 'golden', label: 'Golden hour' }, { value: 'dusk', label: 'Dusk' }, { value: 'night', label: 'Night' },
];

// the training telemetry overlay is opt-in (H / D-pad down): new pilots see the OSD, not a wall of numbers
export const DEFAULT_VIEW: ViewSettings = { osdFont: 'betaflight', renderScale: 1, cubeSize: 0, displayCompMs: 18, displayCompAuto: true, latencyOverrideMs: 0, audio: true, volume: 0.4, telemetry: false, osd: true, view: 'fpv', linkEffects: true, highlightGate: true, timeOfDay: 'map', goggleOverlay: true, beeperVolume: 0.6 };

/** What the latency readout needs from the running app (no readout without it). */
export interface LatencySource {
  /** the selected drone's video system */
  video(): { name: string; latencyMs: number };
  /** glass-to-glass latency the frame loop actually emulates, when the camera exposes it */
  effectiveLatencyMs?(): number | undefined;
}

/** The emulated delay on top of what the display adds, and what the pilot ends up seeing (ms). */
export function glassToGlass(targetMs: number, displayMs: number): { addedMs: number; effectiveMs: number; displayBound: boolean } {
  const addedMs = Math.max(0, targetMs - displayMs);
  return { addedMs, effectiveMs: addedMs + displayMs, displayBound: displayMs > targetMs };
}

/** A map's drill courses (MapDef.courses) for the Course select; built once per map, none when it isn't loaded.
 *  isDefault: the course that is the map's own gates (flown with courseId ''). */
const courseCache = new Map<string, { id: string; name: string; isDefault: boolean }[]>();
function coursesOf(id: string): { id: string; name: string; isDefault: boolean }[] {
  let c = courseCache.get(id);
  if (!c) {
    try { const m = MAPS[id]?.(); c = (m?.courses ?? []).map((x) => ({ id: x.id, name: x.name, isDefault: x.gates === m!.gates })); } catch { return []; } // not preloaded yet
    courseCache.set(id, c);
  }
  return c;
}

export function settingsPanel(sim: SimSettings, view: ViewSettings, onSim: (s: SimSettings) => void, onView: (v: ViewSettings) => void, latency?: LatencySource): HTMLElement {
  const s = structuredClone(sim), v = structuredClone(view);
  const lat = latencyReadout(v, latency);
  const pushS = () => onSim(structuredClone(s)), pushV = () => { onView(structuredClone(v)); lat.update(); };
  const credit = el('p', { class: 'note' }, MAP_LIST[s.mapId]?.credit ?? '');
  const mapLabel = (m: MapEntry) => (m.community ? `${m.name} — ${m.community.local ? 'from disk' : `${m.community.author}, ${m.community.license}`}` : m.name);
  // a map with drill courses (the practice field): which one is timed; the default course is its own gates
  const courseSelect = () => {
    const cs = coursesOf(s.mapId);
    if (!cs.length) return el('div', { hidden: '' });
    const def = cs.find((c) => c.isDefault);
    return select('Course', [{ value: '', label: def?.name ?? 'Default course' }, ...cs.filter((c) => !c.isDefault).map((c) => ({ value: c.id, label: c.name }))], s.courseId ?? '', (x) => { s.courseId = x; pushS(); });
  };
  let courseRow = courseSelect();
  const mapChanged = (id: string) => {
    s.mapId = id; s.courseId = ''; credit.textContent = MAP_LIST[id]?.credit ?? '';
    const c = courseSelect(); courseRow.replaceWith(c); courseRow = c;
  };
  const mapSelect = () => select('Map', Object.entries(MAP_LIST).map(([id, m]) => ({ value: id, label: mapLabel(m) })), s.mapId, (x) => { mapChanged(x); pushS(); });
  let mapRow = mapSelect();
  const setMap = (id: string) => { mapChanged(id); const r = mapSelect(); mapRow.replaceWith(r); mapRow = r; pushS(); };
  return el('div', { class: 'panel settings' },
    el('div', { class: 'cols' },
      el('div', { class: 'col' },
        section('World',
          mapRow,
          courseRow,
          credit,
          el('details', { class: 'note' }, el('summary', {}, 'Credits & licenses'),
            ...Object.values(MAP_LIST).map((m) => el('p', {}, el('b', {}, m.name), ': ', m.credit)),
            el('p', {}, 'Full license texts and attribution: public/maps/quake/ATTRIBUTION.md, public/maps/freedoom/ATTRIBUTION.md and public/maps/community/<map>/ATTRIBUTION.md in the source repository.')),
          localMapLoader(setMap),
          select('Time of day', TIMES_OF_DAY, v.timeOfDay, (x) => { v.timeOfDay = x; pushV(); }),
          slider({ label: 'Wind (at 6 m)', min: 0, max: 15, step: 0.1, value: s.wind.speed, unit: 'm/s', onInput: (x) => { s.wind.speed = x; pushS(); } }).row,
          slider({ label: 'Wind from', min: 0, max: 359, step: 1, value: s.wind.direction, unit: '°', onInput: (x) => { s.wind.direction = x; pushS(); } }).row,
          slider({ label: 'Turbulence (Dryden) ×', min: 0, max: 3, step: 0.05, value: s.wind.turbulence, onInput: (x) => { s.wind.turbulence = x; pushS(); } }).row,
          slider({ label: 'Gusts per minute', min: 0, max: 12, step: 0.5, value: s.wind.gusts, onInput: (x) => { s.wind.gusts = x; pushS(); } }).row,
          slider({ label: 'Air temperature', min: -15, max: 45, step: 1, value: s.ambientC, unit: '°C', hint: 'Affects air density, battery resistance and motor cooling', onInput: (x) => { s.ambientC = x; pushS(); } }).row,
        ),
        section('Physics',
          select('Physics / PID loop rate', [{ value: '8000', label: '8 kHz (gyro 8k / PID 8k)' }, { value: '4000', label: '4 kHz' }, { value: '2000', label: '2 kHz (low-end CPU)' }], String(s.physicsHz), (x) => { s.physicsHz = +x; pushS(); }),
          checkbox('Lower the physics rate automatically when this computer can’t keep up', s.autoRate !== false, (x) => { s.autoRate = x; pushS(); }),
          select('RC link rate (ELRS)', [{ value: '500', label: '500 Hz' }, { value: '250', label: '250 Hz' }, { value: '150', label: '150 Hz' }, { value: '50', label: '50 Hz' }], String(s.rcLinkHz), (x) => { s.rcLinkHz = +x; pushS(); }),
          select('RC transmitter power', [{ value: '10', label: '10 mW' }, { value: '25', label: '25 mW' }, { value: '100', label: '100 mW' }, { value: '250', label: '250 mW' }, { value: '500', label: '500 mW' }, { value: '1000', label: '1 W' }], String(s.rcTxPowerMw ?? 250), (x) => { s.rcTxPowerMw = +x; pushS(); }),
          slider({ label: 'Prop wash intensity ×', min: 0, max: 3, step: 0.05, value: s.propwash, onInput: (x) => { s.propwash = x; pushS(); } }).row,
          slider({ label: 'Time scale', min: 0.1, max: 1, step: 0.05, value: s.timeScale, onInput: (x) => { s.timeScale = x; pushS(); } }).row,
          checkbox('Prop / crash damage', s.damage, (x) => { s.damage = x; pushS(); }),
        ),
      ),
      el('div', { class: 'col' },
        section('Video',
          select('OSD font', ['betaflight', 'default', 'bold', 'clarity', 'digital', 'impact', 'large', 'vision'].map((f) => ({ value: f, label: f })), v.osdFont, (x) => { v.osdFont = x; pushV(); }),
          checkbox('Show OSD', v.osd, (x) => { v.osd = x; pushV(); }),
          checkbox('Goggle overlay (signal, bitrate, DVR)', v.goggleOverlay, (x) => { v.goggleOverlay = x; pushV(); }),
          checkbox('Video link degradation (range, walls, multipath)', v.linkEffects, (x) => { v.linkEffects = x; pushV(); }),
          el('p', { class: 'note photo' }, '⚠ Photosensitivity: analog snow, static and 1S brownout dropouts flicker rapidly. If flashing images affect you, turn video link degradation off.'),
          slider({ label: 'Render scale', min: 0.5, max: 2, step: 0.25, value: v.renderScale, onInput: (x) => { v.renderScale = x; pushV(); } }).row,
          select('Cube map resolution', [{ value: '0', label: 'Auto (from the camera)' }, { value: '512', label: '512' }, { value: '768', label: '768' }, { value: '1024', label: '1024' }, { value: '1536', label: '1536' }], String(v.cubeSize), (x) => { v.cubeSize = +x; pushV(); }),
          lat.el,
          slider({ label: 'Latency override (0 = system)', min: 0, max: 150, step: 1, value: v.latencyOverrideMs, unit: 'ms', onInput: (x) => { v.latencyOverrideMs = x; pushV(); } }).row,
          checkbox('Auto-measure display latency', v.displayCompAuto, (x) => { v.displayCompAuto = x; pushV(); }),
          slider({ label: 'Display pipeline compensation', min: 0, max: 50, step: 1, value: v.displayCompMs, unit: 'ms', hint: 'Your monitor and browser already add latency. It is subtracted from the emulated glass-to-glass delay (used when auto-measure is off).', onInput: (x) => { v.displayCompMs = x; pushV(); } }).row,
          el('p', { class: 'note' }, 'A 60 Hz monitor and browser add about 30–45 ms by themselves, as much as a whole analog or HDZero system. For the true feel of those, use a 120 Hz or faster display.'),
        ),
        section('Audio / HUD',
          checkbox('Motor sound', v.audio, (x) => { v.audio = x; pushV(); }),
          slider({ label: 'Volume', min: 0, max: 1, step: 0.01, value: v.volume, onInput: (x) => { v.volume = x; pushV(); } }).row,
          slider({ label: 'Beeper volume', min: 0, max: 1, step: 0.05, value: v.beeperVolume, hint: 'Betaflight’s buzzer (arming, low battery, lost model) and the ESCs’ beacon', onInput: (x) => { v.beeperVolume = x; pushV(); } }).row,
          checkbox('Training telemetry overlay', v.telemetry, (x) => { v.telemetry = x; pushV(); }),
          checkbox('Highlight next gate', v.highlightGate, (x) => { v.highlightGate = x; pushV(); }),
          select('View', [{ value: 'fpv', label: 'FPV goggles' }, { value: 'chase', label: 'Chase camera' }, { value: 'los', label: 'Line of sight (pilot)' }], v.view, (x) => { v.view = x; pushV(); }),
        ),
      ),
    ),
  );
}

/**
 * Effective glass-to-glass latency of the selected video system: the system's own delay (or the
 * override), what this display adds (measured frame interval, as the frame loop estimates it, or
 * the manual compensation) and the result. Refreshes twice a second while the panel is shown.
 */
function latencyReadout(v: ViewSettings, src?: LatencySource): { el: HTMLElement; update(): void } {
  const box = el('div', { class: 'latency', role: 'status' });
  const video = () => src?.video();
  const measured = () => src?.effectiveLatencyMs?.();
  let frameMs = 16.7, last = 0, raf = 0, seen = false;
  const tick = (t: number) => {
    if (last) { const d = t - last; if (d > 2 && d < 100) frameMs += (d - frameMs) * 0.1; }
    last = t;
    seen ||= box.isConnected;
    if (box.isConnected || !seen) raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const update = () => {
    const vs = video();
    if (!vs) { box.replaceChildren(); return; }
    const target = v.latencyOverrideMs || vs.latencyMs;
    const display = v.displayCompAuto ? Math.min(50, 1.5 * frameMs + 6) : v.displayCompMs;
    const g = glassToGlass(target, display);
    const eff = measured() ?? g.effectiveMs;
    const hz = Math.round(1000 / frameMs);
    box.classList.toggle('warn', g.displayBound || hz < 100);
    const kids: HTMLElement[] = [
      el('div', {}, el('b', {}, `${Math.round(eff)} ms`), 'effective glass-to-glass'),
      el('p', {}, `${vs.name.replace(/\s*\([^)]*\)/g, '')}: ${Math.round(target)} ms ${v.latencyOverrideMs ? '(override)' : 'in real goggles'}. Your ${hz} Hz display adds about ${Math.round(display)} ms${g.displayBound ? ', more than the whole system, so the sim adds nothing.' : `, and the sim adds the other ${Math.round(g.addedMs)} ms.`}`),
    ];
    if (hz < 100) kids.push(el('p', {}, 'Use a 120 Hz or faster display for the true feel of low-latency video.'));
    box.replaceChildren(...kids);
  };
  const timer = window.setInterval(() => { if (!box.isConnected && seen) { cancel(); return; } update(); }, 500);
  const cancel = () => { clearInterval(timer); cancelAnimationFrame(raf); };
  onUnmount(box, cancel);
  update();
  return { el: box, update };
}

/** "Load map from disk": a map package (.zip, folder or files) picked or dropped, validated and selected. */
function localMapLoader(select: (id: string) => void): HTMLElement {
  const status = el('div', { class: 'note' });
  const run = async (get: () => Promise<Map<string, Blob>>) => {
    status.textContent = 'Loading map package…';
    try {
      const r = await loadLocalMap(await get());
      status.replaceChildren(el('p', {}, `Loaded “${r.name}”: ${r.stats.primitives} primitives, ${r.stats.gates} gates, ${r.stats.trees} trees${r.stats.brushes ? `, ${r.stats.brushes} brushes` : ''}. Load it again after editing to reload.`),
        ...r.warnings.map((w) => el('p', {}, `⚠ ${w}`)));
      select(r.id);
    } catch (e) {
      const errs = e instanceof MapFormatError ? e.errors : [String((e as Error)?.message ?? e)];
      status.replaceChildren(el('p', {}, 'The map package has problems:'), el('ul', {}, ...errs.map((x) => el('li', {}, x))));
    }
  };
  const picker = (dir: boolean) => {
    const i = el('input', { type: 'file', accept: dir ? undefined : '.zip,application/zip,.json,.png,.jpg,.jpeg,.webp,.glb,.map,.md,.txt', multiple: !dir, webkitdirectory: dir, style: { display: 'none' } }) as HTMLInputElement;
    i.addEventListener('change', () => { if (i.files?.length) void run(() => filesFromList(i.files!)); i.value = ''; });
    return i;
  };
  const zipIn = picker(false), dirIn = picker(true);
  const box = el('div', { class: 'dropzone', style: { border: '1px dashed currentColor', borderRadius: '6px', padding: '8px', margin: '6px 0', opacity: '0.9' } },
    el('div', { class: 'actions' },
      el('button', { onclick: () => zipIn.click() }, 'Load map (.zip / files)…'),
      el('button', { onclick: () => dirIn.click() }, 'Load map folder…')),
    el('p', { class: 'note' }, 'Or drop a map package here. See docs/MAP_FORMAT.md for the format; nothing is uploaded.'),
    zipIn, dirIn, status);
  box.addEventListener('dragover', (e) => { e.preventDefault(); box.style.opacity = '1'; });
  box.addEventListener('dragleave', () => { box.style.opacity = '0.9'; });
  box.addEventListener('drop', (e) => { e.preventDefault(); if (e.dataTransfer) { const dt = e.dataTransfer; void run(() => filesFromDrop(dt)); } });
  return box;
}
