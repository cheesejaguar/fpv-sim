// The drone builder's ArduPilot page: which firmware a quad flies, the parameters a build boots
// with (what the builder derives, and the pilot's own on top), and the Lua scripts that run on it.
// Everything here is part of the build (DroneSpec.autopilot / apParams / apScripts): it is saved
// with it, exported with it, and ArduPilot restarts with it when the build is applied.
import { apParams, apVehicle } from '../ap/apConfig';
import type { DroneBuild, DroneSpec } from '../builder/derive';
import { isAirframe } from '../data/airframes';
import { el, section, select } from './dom';

/** Example scripts (ArduPilot's Lua API: ardupilot.org/plane/docs/common-lua-scripts.html). */
export const LUA_EXAMPLES: Record<string, { about: string; text: string }> = {
  'hello.lua': {
    about: 'Says hello every 10 s with the altitude above home',
    text: `-- runs every 10 s: a message on the ground station and the OSD
function update()
  local home = ahrs:get_home()
  local pos = ahrs:get_location()
  if home and pos then
    gcs:send_text(6, string.format("alt %.0f m, %.0f m from home", pos:alt() * 0.01 - home:alt() * 0.01, pos:get_distance(home)))
  else
    gcs:send_text(6, "hello from Lua: waiting for GPS")
  end
  return update, 10000
end
return update, 1000
`,
  },
  'low-battery-rtl.lua': {
    about: 'Switches to RTL when the pack falls below 3.5 V per cell under load',
    text: `-- RTL at 3.5 V per cell (the cell count from the resting voltage at boot)
local cells = nil
local done = false
local RTL = vehicle:get_mode() ~= nil and (FWVersion:type() == 3 and 11 or 6) -- Plane 11, Copter 6
function update()
  local v = battery:voltage(0)
  if not cells and v > 3 then cells = math.floor(v / 4.15 + 0.7) end
  if cells and not done and arming:is_armed() and v / cells < 3.5 then
    done = true
    vehicle:set_mode(RTL)
    gcs:send_text(4, string.format("battery %.2f V/cell: RTL", v / cells))
  end
  return update, 500
end
return update, 2000
`,
  },
  'figure-eight.lua': {
    about: 'Plane: flies a figure eight around home in GUIDED mode when AUX4 (CH8) is high',
    text: `-- a figure eight of two 60 m circles beside home, in GUIDED, while CH8 is high
local GUIDED = 15
local R, ALT = 60, 40
local t = 0
function update()
  local home = ahrs:get_home()
  if not (home and arming:is_armed()) then return update, 500 end
  if rc:get_pwm(8) < 1700 then t = 0; return update, 200 end
  if vehicle:get_mode() ~= GUIDED then vehicle:set_mode(GUIDED) end
  t = t + 0.2
  local a = t * 0.15
  local wp = home:copy()
  wp:offset(R * math.sin(a), R * math.sin(a) * math.cos(a))
  wp:alt(home:alt() + ALT * 100)
  vehicle:set_target_location(wp)
  return update, 200
end
return update, 1000
`,
  },
};

const fmt = (v: number) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6));

/** Parse "NAME value" lines (# comments, blank lines, = or , as separators); the bad lines are returned. */
export function parseParamText(text: string): { params: Record<string, number>; bad: string[] } {
  const params: Record<string, number> = {}, bad: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z][A-Za-z0-9_]{0,15})[\s,=]+(-?[\d.eE+-]+)$/.exec(line);
    const v = m ? Number(m[2]) : NaN;
    if (!m || !Number.isFinite(v)) { bad.push(raw.trim()); continue; }
    params[m[1].toUpperCase()] = v;
  }
  return { params, bad };
}

/**
 * The ArduPilot page. build: the spec's current derived build (its starting parameters are shown);
 * changed(): the spec was edited (the builder marks it unapplied).
 */
export function apBuilderSection(spec: DroneSpec, build: DroneBuild | null, changed: () => void, rerender: () => void): HTMLElement {
  const plane = isAirframe(spec.frame);
  const vehicle = apVehicle(spec);
  const choose = plane
    ? el('p', { class: 'note' }, 'Planes fly ArduPlane 4.7.2 (the real firmware, compiled to WebAssembly, running in your browser). Hand launch: arm on AUX1, put AUX2 in FBWA (middle), then throttle up: the plane leaves your hand once the motor runs.')
    : select('Flight controller firmware', [{ value: 'betaflight', label: 'Betaflight 4.5 (acro, angle, horizon)' }, { value: 'ardupilot', label: 'ArduCopter 4.7.2 (stabilize, alt hold, loiter, auto missions, Lua)' }],
      spec.autopilot === 'ardupilot' ? 'ardupilot' : 'betaflight', (v) => { spec.autopilot = v; changed(); rerender(); });
  if (!vehicle) return section('Autopilot', choose);

  // parameters: the build's starting set (read-only) and the pilot's own on top
  const own = spec.apParams ?? {};
  const ownText = Object.entries(own).map(([k, v]) => `${k} ${fmt(v)}`).join('\n');
  const status = el('div', { class: 'note' });
  const ta = el('textarea', { class: 'ap-params', rows: 8, spellcheck: false, placeholder: 'One per line, e.g.\nRTL_ALTITUDE 60\nAIRSPEED_CRUISE 16' }, ownText) as HTMLTextAreaElement;
  ta.addEventListener('input', () => {
    const { params, bad } = parseParamText(ta.value);
    spec.apParams = params;
    status.textContent = bad.length ? `Not understood (NAME value): ${bad.slice(0, 3).join(' · ')}${bad.length > 3 ? ' …' : ''}` : `${Object.keys(params).length} parameter${Object.keys(params).length === 1 ? '' : 's'} of your own`;
    changed();
  });
  status.textContent = `${Object.keys(own).length} parameter${Object.keys(own).length === 1 ? '' : 's'} of your own`;
  const base = build ? apParams({ ...build, spec: { ...build.spec, apParams: {} } }) : {};
  const baseList = el('details', {}, el('summary', {}, `Starting parameters from the build (${Object.keys(base).length})`),
    el('pre', { class: 'ap-base' }, Object.entries(base).map(([k, v]) => `${k} ${fmt(v)}`).join('\n')));

  // Lua scripts
  const scripts = spec.apScripts ?? {};
  const list = el('div', { class: 'ap-scripts' });
  const renderScripts = () => {
    list.replaceChildren(...Object.entries(spec.apScripts ?? {}).map(([name, text]) => {
      const area = el('textarea', { rows: 10, spellcheck: false, class: 'ap-lua' }, text) as HTMLTextAreaElement;
      area.addEventListener('input', () => { spec.apScripts = { ...(spec.apScripts ?? {}), [name]: area.value }; changed(); });
      return el('div', { class: 'ap-script' },
        el('div', { class: 'ap-script-head' }, el('code', {}, name), el('span', { class: 'spacer' }),
          el('button', { onclick: () => { const s = { ...(spec.apScripts ?? {}) }; delete s[name]; spec.apScripts = s; changed(); renderScripts(); } }, 'Remove')),
        area);
    }));
  };
  renderScripts();
  const nameIn = el('input', { type: 'text', placeholder: 'my-script.lua', maxlength: 44, size: 18 }) as HTMLInputElement;
  const add = (name: string, text: string) => {
    const n = name.trim().replace(/\s+/g, '-');
    const file = /\.lua$/i.test(n) ? n : `${n}.lua`;
    if (!/^[A-Za-z0-9_-]{1,40}\.lua$/.test(file)) { status.textContent = 'Script names: letters, digits, - and _, ending .lua'; return; }
    if (Object.keys(spec.apScripts ?? {}).length >= 16 && !(file in (spec.apScripts ?? {}))) { status.textContent = 'At most 16 scripts'; return; }
    spec.apScripts = { ...(spec.apScripts ?? {}), [file]: text };
    changed(); renderScripts();
  };
  const examples = select('Add an example', [{ value: '', label: '— choose —' }, ...Object.entries(LUA_EXAMPLES).map(([k, e]) => ({ value: k, label: `${k}: ${e.about}` }))], '', (k) => { if (k) add(k, LUA_EXAMPLES[k].text); });
  void scripts;

  return el('div', {},
    section('Autopilot', choose,
      el('p', { class: 'note' }, `Switches: AUX1 (CH5) arms, AUX2 (CH6) picks the mode (${vehicle === 'plane' ? 'ACRO / FBWA / CRUISE' : 'ACRO / STABILIZE / ALT_HOLD'}), AUX3 (CH7) RTL, AUX4 (CH8) AUTO (the map's mission). Applying the build restarts ArduPilot with it.`)),
    section('ArduPilot parameters', el('p', { class: 'note' }, 'Your parameters, over the ones the build starts from. Any ArduPilot parameter: ardupilot.org/' + (vehicle === 'plane' ? 'plane' : 'copter') + '/docs/parameters.html'), ta, status, baseList),
    section('Lua scripts', el('p', { class: 'note' }, 'They run on ArduPilot (APM/scripts) with its full Lua API: read sensors and state, change modes, fly guided targets, talk to the ground station.'),
      list,
      el('div', { class: 'ap-script-add' }, nameIn, el('button', { onclick: () => { if (nameIn.value.trim()) { add(nameIn.value, '-- new script\nfunction update()\n  return update, 1000\nend\nreturn update, 1000\n'); nameIn.value = ''; } } }, 'New script')),
      examples),
  );
}
