// Betaflight tuning (reads/writes the real firmware's settings through its CLI) and a raw CLI console.
import { cliErrors, planDiffImport, DiffPlan } from '../bf/diffImport';
import { el, section, slider } from './dom';

export interface BfBridge {
  cliBatch(lines: string[]): Promise<string>;
  cliSend(text: string): void;
  onCliOut(cb: (text: string) => void): void;
}

/** Hooks into the rest of the app for "Bring your real quad". */
export interface BfPanelOptions {
  /** Sim-owned CLI lines to re-apply after an import (see simHardwareCli in src/bf/defaults.ts). */
  hardwareCli(keepOsdLayout: boolean, propsOut: boolean | null): string[];
  /** Current physical prop direction of the simulated quad (true = props out). */
  propsOut(): boolean;
  /** Make the simulated airframe spin its props the way the imported tune expects. */
  setPropsOut(propsOut: boolean): void;
}

interface Param { key: string; label: string; min: number; max: number; step: number; unit?: string }

const RATES: Param[] = ['roll', 'pitch', 'yaw'].flatMap((a) => [
  { key: `${a}_rc_rate`, label: `${a} centre sensitivity (×10 °/s)`, min: 1, max: 50, step: 1 },
  { key: `${a}_srate`, label: `${a} max rate (×10 °/s)`, min: 10, max: 180, step: 1 },
  { key: `${a}_expo`, label: `${a} expo`, min: 0, max: 100, step: 1 },
]);
const PIDS: Param[] = [
  ...['roll', 'pitch'].flatMap((a) => [
    { key: `p_${a}`, label: `P ${a}`, min: 0, max: 200, step: 1 }, { key: `i_${a}`, label: `I ${a}`, min: 0, max: 200, step: 1 },
    { key: `d_${a}`, label: `D ${a}`, min: 0, max: 150, step: 1 }, { key: `d_min_${a}`, label: `D min ${a}`, min: 0, max: 150, step: 1 },
    { key: `f_${a}`, label: `FF ${a}`, min: 0, max: 400, step: 1 },
  ]),
  { key: 'p_yaw', label: 'P yaw', min: 0, max: 200, step: 1 }, { key: 'i_yaw', label: 'I yaw', min: 0, max: 200, step: 1 }, { key: 'f_yaw', label: 'FF yaw', min: 0, max: 400, step: 1 },
];
const DYN: Param[] = [
  { key: 'tpa_rate', label: 'TPA rate', min: 0, max: 100, step: 1, unit: '%' }, { key: 'tpa_breakpoint', label: 'TPA breakpoint', min: 1000, max: 2000, step: 10 },
  { key: 'anti_gravity_gain', label: 'Anti-gravity gain', min: 0, max: 250, step: 1 }, { key: 'iterm_relax_cutoff', label: 'I-term relax cutoff', min: 1, max: 50, step: 1, unit: 'Hz' },
  { key: 'thrust_linear', label: 'Thrust linearisation', min: 0, max: 150, step: 1 }, { key: 'dyn_idle_min_rpm', label: 'Dynamic idle (×100 rpm)', min: 0, max: 100, step: 1 },
  { key: 'vbat_sag_compensation', label: 'Battery sag compensation', min: 0, max: 150, step: 1, unit: '%' }, { key: 'throttle_boost', label: 'Throttle boost', min: 0, max: 100, step: 1 },
  { key: 'motor_output_limit', label: 'Motor output limit', min: 50, max: 100, step: 1, unit: '%' }, { key: 'thr_mid', label: 'Throttle mid', min: 0, max: 100, step: 1 },
  { key: 'thr_expo', label: 'Throttle expo', min: 0, max: 100, step: 1 }, { key: 'dshot_idle_value', label: 'DShot idle (×0.01 %)', min: 0, max: 2000, step: 10 },
];
const FILTERS: Param[] = [
  { key: 'gyro_lpf1_dyn_min_hz', label: 'Gyro LPF1 dyn min', min: 0, max: 1000, step: 5, unit: 'Hz' }, { key: 'gyro_lpf1_dyn_max_hz', label: 'Gyro LPF1 dyn max', min: 0, max: 1000, step: 5, unit: 'Hz' },
  { key: 'gyro_lpf2_static_hz', label: 'Gyro LPF2', min: 0, max: 1000, step: 5, unit: 'Hz' },
  { key: 'dterm_lpf1_dyn_min_hz', label: 'D-term LPF1 dyn min', min: 0, max: 500, step: 5, unit: 'Hz' }, { key: 'dterm_lpf1_dyn_max_hz', label: 'D-term LPF1 dyn max', min: 0, max: 500, step: 5, unit: 'Hz' },
  { key: 'dterm_lpf2_static_hz', label: 'D-term LPF2', min: 0, max: 500, step: 5, unit: 'Hz' },
  { key: 'dyn_notch_count', label: 'Dynamic notch count', min: 0, max: 7, step: 1 }, { key: 'dyn_notch_q', label: 'Dynamic notch Q', min: 1, max: 1000, step: 1 },
  { key: 'rpm_filter_harmonics', label: 'RPM filter harmonics', min: 0, max: 3, step: 1 }, { key: 'rpm_filter_q', label: 'RPM filter Q', min: 250, max: 3000, step: 10 },
];
const ALL = [...RATES, ...PIDS, ...DYN, ...FILTERS];

function actualRate(x: number, rc: number, max: number, expo: number) {
  const a = Math.abs(x), e = expo / 100;
  const expof = a * (Math.pow(x, 5) * e + x * (1 - e));
  const center = rc * 10, stick = Math.max(0, max * 10 - center);
  return x * center + stick * expof;
}

export function bfPanel(bf: BfBridge, opts?: BfPanelOptions): HTMLElement {
  const root = el('div', { class: 'panel bf' });
  const values: Record<string, number> = {};
  const dirty = new Set<string>();
  const status = el('div', { class: 'status' }, 'Reading settings from Betaflight…');
  const curve = el('canvas', { width: 320, height: 200, class: 'curve' }) as HTMLCanvasElement;
  const drawCurve = () => {
    const c = curve.getContext('2d')!; c.clearRect(0, 0, 320, 200);
    c.strokeStyle = '#333'; c.beginPath(); for (let i = 0; i <= 4; i++) { c.moveTo(0, i * 50); c.lineTo(320, i * 50); } c.stroke();
    const colors = { roll: '#ff5a5a', pitch: '#5aff8a', yaw: '#5ab0ff' };
    let maxR = 1;
    for (const a of ['roll', 'pitch', 'yaw'] as const) maxR = Math.max(maxR, actualRate(1, values[`${a}_rc_rate`] ?? 7, values[`${a}_srate`] ?? 67, values[`${a}_expo`] ?? 0));
    for (const a of ['roll', 'pitch', 'yaw'] as const) {
      c.strokeStyle = colors[a]; c.lineWidth = 2; c.beginPath();
      for (let i = 0; i <= 100; i++) { const x = i / 100; const r = actualRate(x, values[`${a}_rc_rate`] ?? 7, values[`${a}_srate`] ?? 67, values[`${a}_expo`] ?? 0); const px = x * 320, py = 200 - (r / (maxR * 1.05)) * 200; if (i) c.lineTo(px, py); else c.moveTo(px, py); }
      c.stroke();
      c.fillStyle = colors[a]; c.fillText(`${a} ${actualRate(1, values[`${a}_rc_rate`] ?? 7, values[`${a}_srate`] ?? 67, values[`${a}_expo`] ?? 0).toFixed(0)}°/s`, 6, 14 + ['roll', 'pitch', 'yaw'].indexOf(a) * 14);
    }
  };
  const group = (title: string, ps: Param[]) => section(title, ...ps.map((p) => slider({ label: p.label, min: p.min, max: p.max, step: p.step, unit: p.unit, value: values[p.key] ?? p.min, onInput: (v) => { values[p.key] = v; dirty.add(p.key); drawCurve(); } }).row));

  const out = el('pre', { class: 'cli-out' });
  const inp = el('input', { class: 'cli-in', placeholder: 'Type a CLI command (e.g. "status", "get rpm", "diff")  — Enter to send' }) as HTMLInputElement;
  let entered = false;
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!entered) { bf.cliSend('#\n'); entered = true; }
    bf.cliSend(inp.value + '\n');
    inp.value = '';
  });
  bf.onCliOut((t) => { out.textContent = (out.textContent + t).slice(-40000); out.scrollTop = out.scrollHeight; });

  const importSec = opts ? realQuadSection(bf, opts, () => load()) : null;

  const render = () => {
    root.replaceChildren(
      el('div', { class: 'cols' },
        el('div', { class: 'col' }, section('Rates (Actual)', curve), group('Rates', RATES)),
        el('div', { class: 'col' }, group('PID gains', PIDS), group('PID dynamics', DYN)),
        el('div', { class: 'col' }, group('Filters', FILTERS),
          el('div', { class: 'actions' },
            el('button', { class: 'primary', onclick: async () => {
              if (!dirty.size) return;
              status.textContent = 'Writing to Betaflight + save (reboot)…';
              await bf.cliBatch([...[...dirty].map((k) => `set ${k} = ${values[k]}`), 'save']);
              dirty.clear(); status.textContent = 'Saved to the flight controller EEPROM.';
            } }, 'Write & save'),
            el('button', { onclick: () => load() }, 'Re-read'),
          ), status,
          section('CLI console (entering the CLI disarms; type "exit" to leave)', out, inp),
        ),
      ),
      importSec ?? '',
    );
    drawCurve();
  };

  const load = async () => {
    const txt = await bf.cliBatch(ALL.map((p) => `get ${p.key}`));
    for (const line of txt.split(/\r?\n/)) {
      const m = /^(\w+) = (-?[\d.]+)/.exec(line.trim());
      if (m) values[m[1]] = parseFloat(m[2]);
    }
    const n = ALL.filter((p) => p.key in values).length;
    status.textContent = n ? `Read ${n} settings from the flight controller.` : 'Could not read settings (is the firmware running?).';
    render();
  };
  render();
  void load();
  return root;
}

/**
 * "Bring your real quad": paste `diff all` from a real Betaflight FC, preview what is kept vs dropped
 * (board hardware), apply it to the simulated FC, re-apply the simulator's own hardware settings,
 * and report any lines Betaflight rejected. Built once and kept across panel re-renders.
 */
function realQuadSection(bf: BfBridge, opts: BfPanelOptions, reload: () => Promise<void>): HTMLElement {
  const ta = el('textarea', { class: 'diff-in', rows: 10, spellcheck: false, placeholder: 'In Betaflight Configurator → CLI on your real quad, type  diff all  and press Enter, then copy everything it prints and paste it here.' }) as HTMLTextAreaElement;
  const report = el('div', { class: 'diff-report' });
  let plan: DiffPlan | null = null;
  const preview = () => {
    plan = planDiffImport(ta.value);
    const p = plan;
    const sameProps = p.propsOut == null || p.propsOut === opts.propsOut();
    report.replaceChildren(
      el('p', {}, p.version ? `Betaflight ${p.version} on ${p.board ?? 'unknown board'}` : 'Betaflight version: unknown'),
      el('p', {}, `${p.apply.length} lines will be applied (tune, rates, filters, features, OSD); ${p.skipped.length} board-hardware lines will be skipped.`),
      ...p.warnings.map((w) => el('p', { class: 'warn' }, '⚠ ' + w)),
      sameProps ? '' : el('p', { class: 'warn' }, `⚠ Your quad runs props ${p.propsOut ? 'out' : 'in'}; the simulated airframe will be switched to match.`),
      p.skipped.length ? el('details', {}, el('summary', {}, 'Skipped lines and why'),
        el('pre', { class: 'diff-skip' }, p.skipped.map((x) => `${x.line}\n    ↳ ${x.reason}`).join('\n'))) : '',
      el('div', { class: 'actions' }, el('button', { class: 'primary', disabled: !p.apply.length, onclick: () => void apply() }, 'Apply to simulated FC')),
    );
  };
  const apply = async () => {
    if (!plan || !plan.apply.length) return;
    const p = plan;
    report.append(el('p', { class: 'status' }, 'Applying to the simulated flight controller…'));
    if (p.propsOut != null && p.propsOut !== opts.propsOut()) opts.setPropsOut(p.propsOut);
    const keepOsd = p.apply.some((l) => /^set osd_\w+_pos\b/.test(l));
    const out = await bf.cliBatch([...p.apply, ...opts.hardwareCli(keepOsd, p.propsOut), 'save']);
    const errs = cliErrors(out);
    report.replaceChildren(
      el('p', {}, `Applied ${p.apply.length} lines from your quad and saved. ${errs.length ? `${errs.length} line(s) were rejected by Betaflight 4.5.5:` : 'Betaflight accepted every line.'}`),
      errs.length ? el('pre', { class: 'diff-skip' }, errs.join('\n')) : '',
      el('p', { class: 'note' }, 'Kept from the simulator: virtual sensors, receiver, motor poles/KV from the drone builder, and the controller mode mapping (AUX1 arm, AUX2 flight mode, AUX3 turtle).'),
    );
    await reload();
  };
  const exportDiff = async () => {
    const out = await bf.cliBatch(['diff all']);
    const text = out.replace(/\r/g, '').split('\n').filter((l) => !/^# ?(diff all|exit|leaving CLI|Rebooting)/i.test(l) && !/^Entering CLI/.test(l)).join('\n');
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'fpv-sim-diff-all.txt' }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  return section('Bring your real quad — import Betaflight "diff all"',
    el('p', {}, 'Fly the sim with exactly the tune on your real flight controller: PIDs, feedforward, rates, filters, RPM filter, TPA, anti-gravity, dynamic idle, throttle settings and OSD. Board-specific hardware lines are filtered out. For the closest match, also pick your motors, props and battery in the Drone builder.'),
    ta,
    el('div', { class: 'actions' },
      el('button', { onclick: preview }, 'Preview'),
      el('button', { onclick: () => void exportDiff() }, 'Export sim diff all'),
    ),
    report,
  );
}
