// Simulation + presentation settings.
import { MAP_LIST } from '../maps/maps';
import { SimSettings } from '../worker/shared';
import { checkbox, el, section, select, slider } from './dom';

export interface ViewSettings {
  osdFont: string;
  renderScale: number;
  cubeSize: number;
  displayCompMs: number;   // subtract the monitor/browser pipeline from the emulated latency
  latencyOverrideMs: number; // 0 = from video system
  audio: boolean; volume: number;
  telemetry: boolean;
  osd: boolean;
  view: 'fpv' | 'chase' | 'los';
  linkEffects: boolean;
}

export const DEFAULT_VIEW: ViewSettings = { osdFont: 'betaflight', renderScale: 1, cubeSize: 768, displayCompMs: 18, latencyOverrideMs: 0, audio: true, volume: 0.4, telemetry: true, osd: true, view: 'fpv', linkEffects: true };

export function settingsPanel(sim: SimSettings, view: ViewSettings, onSim: (s: SimSettings) => void, onView: (v: ViewSettings) => void): HTMLElement {
  const s = structuredClone(sim), v = structuredClone(view);
  const pushS = () => onSim(structuredClone(s)), pushV = () => onView(structuredClone(v));
  const credit = el('p', { class: 'note' }, MAP_LIST[s.mapId]?.credit ?? '');
  return el('div', { class: 'panel settings' },
    el('div', { class: 'cols' },
      el('div', { class: 'col' },
        section('World',
          select('Map', Object.entries(MAP_LIST).map(([id, m]) => ({ value: id, label: m.name })), s.mapId, (x) => { s.mapId = x; credit.textContent = MAP_LIST[x]?.credit ?? ''; pushS(); }),
          credit,
          el('details', { class: 'note' }, el('summary', {}, 'Credits & licenses'),
            ...Object.values(MAP_LIST).map((m) => el('p', {}, el('b', {}, m.name), ': ', m.credit)),
            el('p', {}, 'Full license texts and attribution: public/maps/quake/ATTRIBUTION.md and public/maps/freedoom/ATTRIBUTION.md in the source repository.')),
          slider({ label: 'Wind (at 6 m)', min: 0, max: 15, step: 0.1, value: s.wind.speed, unit: 'm/s', onInput: (x) => { s.wind.speed = x; pushS(); } }).row,
          slider({ label: 'Wind from', min: 0, max: 359, step: 1, value: s.wind.direction, unit: '°', onInput: (x) => { s.wind.direction = x; pushS(); } }).row,
          slider({ label: 'Turbulence (Dryden) ×', min: 0, max: 3, step: 0.05, value: s.wind.turbulence, onInput: (x) => { s.wind.turbulence = x; pushS(); } }).row,
          slider({ label: 'Gusts per minute', min: 0, max: 12, step: 0.5, value: s.wind.gusts, onInput: (x) => { s.wind.gusts = x; pushS(); } }).row,
          slider({ label: 'Air temperature', min: -15, max: 45, step: 1, value: s.ambientC, unit: '°C', hint: 'Affects air density, battery resistance and motor cooling', onInput: (x) => { s.ambientC = x; pushS(); } }).row,
        ),
        section('Physics',
          select('Physics / PID loop rate', [{ value: '8000', label: '8 kHz (gyro 8k / PID 8k)' }, { value: '4000', label: '4 kHz' }, { value: '2000', label: '2 kHz (low-end CPU)' }], String(s.physicsHz), (x) => { s.physicsHz = +x; pushS(); }),
          select('RC link rate (ELRS)', [{ value: '500', label: '500 Hz' }, { value: '250', label: '250 Hz' }, { value: '150', label: '150 Hz' }, { value: '50', label: '50 Hz' }], String(s.rcLinkHz), (x) => { s.rcLinkHz = +x; pushS(); }),
          slider({ label: 'Prop wash intensity ×', min: 0, max: 3, step: 0.05, value: s.propwash, onInput: (x) => { s.propwash = x; pushS(); } }).row,
          slider({ label: 'Time scale', min: 0.1, max: 1, step: 0.05, value: s.timeScale, onInput: (x) => { s.timeScale = x; pushS(); } }).row,
          checkbox('Prop / crash damage', s.damage, (x) => { s.damage = x; pushS(); }),
        ),
      ),
      el('div', { class: 'col' },
        section('Video',
          select('OSD font', ['betaflight', 'default', 'bold', 'clarity', 'digital', 'impact', 'large', 'vision'].map((f) => ({ value: f, label: f })), v.osdFont, (x) => { v.osdFont = x; pushV(); }),
          checkbox('Show OSD', v.osd, (x) => { v.osd = x; pushV(); }),
          checkbox('Video link degradation (range, walls, multipath)', v.linkEffects, (x) => { v.linkEffects = x; pushV(); }),
          slider({ label: 'Render scale', min: 0.5, max: 2, step: 0.25, value: v.renderScale, onInput: (x) => { v.renderScale = x; pushV(); } }).row,
          select('Cube map resolution', [{ value: '512', label: '512' }, { value: '768', label: '768' }, { value: '1024', label: '1024' }, { value: '1536', label: '1536' }], String(v.cubeSize), (x) => { v.cubeSize = +x; pushV(); }),
          slider({ label: 'Latency override (0 = system)', min: 0, max: 150, step: 1, value: v.latencyOverrideMs, unit: 'ms', onInput: (x) => { v.latencyOverrideMs = x; pushV(); } }).row,
          slider({ label: 'Display pipeline compensation', min: 0, max: 50, step: 1, value: v.displayCompMs, unit: 'ms', hint: 'Your monitor + browser already add latency; it is subtracted from the emulated glass-to-glass delay', onInput: (x) => { v.displayCompMs = x; pushV(); } }).row,
        ),
        section('Audio / HUD',
          checkbox('Motor sound', v.audio, (x) => { v.audio = x; pushV(); }),
          slider({ label: 'Volume', min: 0, max: 1, step: 0.01, value: v.volume, onInput: (x) => { v.volume = x; pushV(); } }).row,
          checkbox('Training telemetry overlay', v.telemetry, (x) => { v.telemetry = x; pushV(); }),
          select('View', [{ value: 'fpv', label: 'FPV goggles' }, { value: 'chase', label: 'Chase camera' }, { value: 'los', label: 'Line of sight (pilot)' }], v.view, (x) => { v.view = x; pushV(); }),
        ),
      ),
    ),
  );
}
