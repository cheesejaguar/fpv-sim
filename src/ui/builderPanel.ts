// Drone builder: component dropdowns + sliders for every physical parameter, with a live panel of
// the derived flight model (mass budget, inertia, thrust, hover point, currents, flight time).
import { BATTERIES, ESCS, FCS, FRAMES, MOTORS, PROPS, VIDEO, byId } from '../data/catalog';
import { buildDrone, DroneSpec, PRESETS, Overrides } from '../builder/derive';
import { confirmDialog, el, kv, section, select, setLeaveGuard, slider } from './dom';

export function builderPanel(getSpec: () => DroneSpec, apply: (s: DroneSpec) => void): HTMLElement {
  const root = el('div', { class: 'panel builder' });
  let spec: DroneSpec = structuredClone(getSpec());
  const info = el('div', { class: 'derived' });
  let pending: number | undefined;

  const refreshInfo = () => {
    clearTimeout(pending);
    pending = window.setTimeout(() => {
      const b = buildDrone(spec), i = b.info, p = b.params;
      const I = p.inertia;
      info.replaceChildren(
        section('Derived flight model',
          kv([
            ['All-up weight', `${i.auwG.toFixed(0)} g`],
            ['CG offset (x, z)', `${i.cgMm.x.toFixed(1)} mm, ${i.cgMm.z.toFixed(1)} mm`],
            ['Inertia Ixx / Iyy / Izz', `${(I.xx * 1e3).toFixed(2)} / ${(I.yy * 1e3).toFixed(2)} / ${(I.zz * 1e3).toFixed(2)} g·m²`],
            ['Static thrust / motor', `${((i.staticThrustN / 9.80665) * 1000).toFixed(0)} g @ ${i.wotRpm.toFixed(0)} rpm`],
            ['Thrust-to-weight', `${i.thrustToWeight.toFixed(1)} : 1`],
            ['Hover throttle', `${(i.hoverThrottle * 100).toFixed(0)} % (${i.hoverRpm.toFixed(0)} rpm)`],
            ['Hover / full-throttle current', `${i.hoverCurrentA.toFixed(1)} A / ${i.wotCurrentA.toFixed(0)} A`],
            ['Est. flight time (hover / mixed)', `${i.flightTimeHoverMin.toFixed(1)} / ${i.flightTimeMixedMin.toFixed(1)} min`],
            ['Est. top speed', `${i.estTopSpeedKmh.toFixed(0)} km/h`],
            ['Drag CdA (x / y / z)', `${(p.cdA.x * 1e4).toFixed(0)} / ${(p.cdA.y * 1e4).toFixed(0)} / ${(p.cdA.z * 1e4).toFixed(0)} cm²`],
            ['Frame 1st mode', `${i.frameFreqHz.toFixed(0)} Hz`],
            ['Prop kT / kQ', `${p.rotors[0].table.kT.toExponential(2)} / ${p.rotors[0].table.kQ.toExponential(2)}`],
            ['Battery pack DCIR', `${(((p.battery.cellsSeries / p.battery.cellsParallel) * p.battery.r0CellOhm + p.battery.wiringOhm) * 1000).toFixed(1)} mΩ`],
          ])),
        section('Mass budget', kv(i.massItems.map((m) => [m.name, `${(m.m * 1000).toFixed(1)} g`] as [string, string]))),
      );
    }, 120);
  };

  const nOverrides = () => Object.keys(spec.overrides).length;
  const unapplied = () => JSON.stringify(spec) !== JSON.stringify(getSpec());
  // leaving the tab / closing the menu with edits that were never applied asks first
  setLeaveGuard(root, { dirty: unapplied, what: () => `The changes to ${spec.name} are not applied to your quad yet.` });

  // a new component resets the slider overrides (they belonged to the old part): ask when there are some
  const comp = (label: string, key: keyof DroneSpec, list: { id: string; name: string }[]) =>
    select(label, list.map((c) => ({ value: c.id, label: c.name })), spec[key] as string, (v) => {
      const n = nOverrides();
      const go = () => { (spec as any)[key] = v; spec.overrides = {}; render(); };
      if (!n) { go(); return; }
      void confirmDialog({ title: `Change the ${label.toLowerCase()}?`, body: `Changing the ${label.toLowerCase()} resets your ${n} slider override${n === 1 ? '' : 's'} (motor, propeller, battery and airframe values) to the new parts’ data.`, ok: 'Change and reset', cancel: 'Keep current', danger: true })
        .then((ok) => { if (ok) go(); else render(); });
    });

  const loadPreset = (v: string) => {
    if (v === '') return;
    const next = PRESETS[+v];
    const go = () => { spec = structuredClone(next); render(); };
    if (!unapplied() && !nOverrides()) { go(); return; }
    void confirmDialog({ title: `Load “${next.name}”?`, body: 'The preset replaces the build you are editing, including its slider overrides and any changes you have not applied.', ok: 'Load preset', cancel: 'Keep editing', danger: true })
      .then((ok) => { if (ok) go(); else render(); });
  };

  const ov = (k: keyof Overrides, label: string, min: number, max: number, step: number, def: number, unit = '', hint = '') =>
    slider({ label, min, max, step, value: (spec.overrides[k] as number) ?? def, unit, hint, onInput: (v) => { (spec.overrides as any)[k] = v; refreshInfo(); } }).row;

  // action bar pinned above the (long) builder, so Apply is reachable without scrolling
  const dirtyTag = el('span', { class: 'builder-dirty' });
  const updateDirty = () => {
    const changed = JSON.stringify(spec) !== JSON.stringify(getSpec());
    dirtyTag.textContent = changed ? '● Unapplied changes' : '✓ Matches the quad you are flying';
    dirtyTag.classList.toggle('on', changed);
  };
  root.addEventListener('input', updateDirty);
  root.addEventListener('change', updateDirty);

  const render = () => {
    const m = byId(MOTORS, spec.motor), pr = byId(PROPS, spec.prop), bt = byId(BATTERIES, spec.battery), esc = byId(ESCS, spec.esc);
    root.replaceChildren(
      el('div', { class: 'builder-bar' },
        el('b', {}, spec.name), dirtyTag,
        el('span', { class: 'spacer' }),
        el('button', { class: 'primary', onclick: () => apply(structuredClone(spec)) }, 'Apply & respawn'),
        el('button', { onclick: () => { const n = nOverrides(); if (!n) return; void confirmDialog({ title: 'Reset all overrides?', body: `Your ${n} slider override${n === 1 ? '' : 's'} go back to the components’ own data.`, ok: 'Reset overrides', cancel: 'Cancel', danger: true }).then((ok) => { if (ok) { spec.overrides = {}; render(); } }); } }, 'Reset overrides'),
        el('button', { onclick: () => { const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' }); const a = el('a', { href: URL.createObjectURL(blob), download: `${spec.name.replace(/\W+/g, '_')}.json` }); a.click(); } }, 'Export JSON'),
      ),
      el('div', { class: 'cols' },
        el('div', { class: 'col' },
          section('Preset',
            select('Load preset', [{ value: '', label: '— choose —' }, ...PRESETS.map((p, i) => ({ value: String(i), label: p.name }))], '', loadPreset),
          ),
          section('Components',
            comp('Frame', 'frame', FRAMES), comp('Motors', 'motor', MOTORS), comp('Propellers', 'prop', PROPS),
            comp('Battery', 'battery', BATTERIES), comp('ESC', 'esc', ESCS), comp('Flight controller / gyro', 'fc', FCS), comp('Video system', 'video', VIDEO),
          ),
          section('Layout',
            select('Battery mount', [{ value: 'top', label: 'Top mount' }, { value: 'bottom', label: 'Bottom mount' }], spec.batteryMount, (v) => { spec.batteryMount = v; refreshInfo(); }),
            select('Prop direction', [{ value: 'props-out', label: 'Props out (BF yaw_motors_reversed)' }, { value: 'props-in', label: 'Props in (BF default)' }], spec.propDirection, (v) => { spec.propDirection = v; refreshInfo(); }),
            slider({ label: 'Camera uptilt', min: 0, max: 60, step: 1, value: spec.cameraUptiltDeg, unit: '°', onInput: (v) => { spec.cameraUptiltDeg = v; } }).row,
            slider({ label: 'Extra mass (TPU/GPS/GoPro)', min: 0, max: 150, step: 1, value: spec.extraMassG, unit: 'g', onInput: (v) => { spec.extraMassG = v; refreshInfo(); } }).row,
            slider({ label: 'Extra mass height', min: -20, max: 80, step: 1, value: spec.extraMassZmm, unit: 'mm', onInput: (v) => { spec.extraMassZmm = v; refreshInfo(); } }).row,
            slider({ label: 'Motor tilt (inward)', min: 0, max: 10, step: 0.5, value: spec.motorTiltDeg, unit: '°', onInput: (v) => { spec.motorTiltDeg = v; refreshInfo(); } }).row,
          ),
          section('Battery state',
            slider({ label: 'Initial state of charge', min: 0.1, max: 1, step: 0.01, value: spec.batterySoc, digits: 2, onInput: (v) => { spec.batterySoc = v; } }).row,
            slider({ label: 'Pack age (resistance ×)', min: 1, max: 3, step: 0.05, value: spec.batteryAge, digits: 2, hint: 'Aged packs: higher internal resistance and lower capacity', onInput: (v) => { spec.batteryAge = v; refreshInfo(); } }).row,
          ),
        ),
        el('div', { class: 'col' },
          section('Motor', ov('kv', 'KV', 800, 4500, 10, m.kv, 'rpm/V'), ov('rmMohm', 'Winding resistance', 10, 400, 1, m.rmMohm, 'mΩ'), ov('i0A', 'No-load current @10V', 0.2, 3, 0.05, m.i0A, 'A'), ov('escCurrentLimitA', 'ESC current limit', 10, 90, 1, Math.min(esc.burstA, m.maxCurrentA * 1.25), 'A')),
          section('Propeller', ov('propPitchIn', 'Pitch', 2, 6, 0.05, pr.pitchIn, 'in', 'Re-solves the BEMT tables'), ov('propThrustScale', 'Thrust coefficient ×', 0.6, 1.4, 0.01, 1), ov('propTorqueScale', 'Torque coefficient ×', 0.6, 1.4, 0.01, 1), ov('propImbalance', 'Static imbalance', 0, 5e-6, 1e-8, 2e-7, 'kg·m', 'Bent or unbalanced props feed vibration into the gyro')),
          section('Battery', ov('cells', 'Cells (S)', 1, 8, 1, bt.cells, 'S'), ov('capacityMah', 'Capacity', 300, 6000, 10, bt.capacityMah, 'mAh'), ov('irPerCellMohm', 'IR per cell', 1, 30, 0.1, bt.irPerCellMohm, 'mΩ')),
          section('Airframe', ov('massScale', 'Mass ×', 0.7, 1.5, 0.01, 1), ov('inertiaScale', 'Inertia ×', 0.6, 1.6, 0.01, 1), ov('cdAScale', 'Drag area ×', 0.5, 2, 0.01, 1), ov('frameFreqHz', 'Frame resonance', 60, 400, 1, 160, 'Hz'), ov('vibrationScale', 'Vibration coupling ×', 0, 4, 0.05, 1), ov('auxPowerW', 'Aux power (VTX/FC/cam)', 1, 20, 0.5, 6, 'W')),
        ),
        el('div', { class: 'col' }, info,
          el('p', { class: 'note' }, 'Manufacturer data where published; winding resistance, rotor inertia, thermal constants and prop static calibration are engineering estimates. Override any value with the sliders.'),
        ),
      ),
    );
    refreshInfo();
    updateDirty();
  };
  render();
  return root;
}
