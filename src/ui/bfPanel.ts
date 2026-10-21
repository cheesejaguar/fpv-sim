// Betaflight tuning (reads/writes the real firmware's settings through its CLI) and a raw CLI console.
import { cliErrors, planDiffImport, DiffPlan } from '../bf/diffImport';
import { confirmDialog, el, onUnmount, section, setLeaveGuard, slider, uniqueId } from './dom';

export interface BfBridge {
  cliBatch(lines: string[]): Promise<string>;
  cliSend(text: string): void;
  /** Subscribe to CLI output; returns an unsubscribe function (called when the panel goes away). */
  onCliOut(cb: (text: string) => void): (() => void) | void;
}

/** Hooks into the rest of the app for "Bring your real quad". */
export interface BfPanelOptions {
  /** Sim-owned CLI lines to re-apply after an import (see simHardwareCli in src/bf/defaults.ts). */
  hardwareCli(keepOsdLayout: boolean, propsOut: boolean | null): string[];
  /** Current physical prop direction of the simulated quad (true = props out). */
  propsOut(): boolean;
  /** Make the simulated airframe spin its props the way the imported tune expects. */
  setPropsOut(propsOut: boolean): void;
  /** Wipe the simulated FC back to the simulator's first-boot defaults (worker `factoryReset`). */
  factoryReset?: () => void;
}

/** scale: CLI value × scale = the number shown (Betaflight stores rates in 10 °/s, idle in 100 rpm …) */
interface Param { key: string; label: string; min: number; max: number; step: number; unit?: string; scale?: number }

const RATES: Param[] = ['roll', 'pitch', 'yaw'].flatMap((a) => [
  { key: `${a}_rc_rate`, label: `${cap(a)} center sensitivity`, min: 1, max: 50, step: 1, unit: '°/s', scale: 10 },
  { key: `${a}_srate`, label: `${cap(a)} max rate`, min: 10, max: 180, step: 1, unit: '°/s', scale: 10 },
  { key: `${a}_expo`, label: `${cap(a)} expo`, min: 0, max: 100, step: 1 },
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
  { key: 'tpa_rate', label: 'TPA rate', min: 0, max: 100, step: 1, unit: '%' }, { key: 'tpa_breakpoint', label: 'TPA breakpoint', min: 1000, max: 2000, step: 10, unit: 'µs' },
  { key: 'anti_gravity_gain', label: 'Anti-gravity gain', min: 0, max: 250, step: 1 }, { key: 'iterm_relax_cutoff', label: 'I-term relax cutoff', min: 1, max: 50, step: 1, unit: 'Hz' },
  { key: 'thrust_linear', label: 'Thrust linearization', min: 0, max: 150, step: 1, unit: '%' }, { key: 'dyn_idle_min_rpm', label: 'Dynamic idle', min: 0, max: 100, step: 1, unit: 'rpm', scale: 100 },
  { key: 'vbat_sag_compensation', label: 'Battery sag compensation', min: 0, max: 150, step: 1, unit: '%' }, { key: 'throttle_boost', label: 'Throttle boost', min: 0, max: 100, step: 1 },
  { key: 'motor_output_limit', label: 'Motor output limit', min: 50, max: 100, step: 1, unit: '%' }, { key: 'thr_mid', label: 'Throttle mid', min: 0, max: 100, step: 1 },
  { key: 'thr_expo', label: 'Throttle expo', min: 0, max: 100, step: 1 }, { key: 'dshot_idle_value', label: 'DShot idle', min: 0, max: 2000, step: 10, unit: '%', scale: 0.01 },
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

function cap(s: string) { return s[0].toUpperCase() + s.slice(1); }

function actualRate(x: number, rc: number, max: number, expo: number) {
  const a = Math.abs(x), e = expo / 100;
  const expof = a * (Math.pow(x, 5) * e + x * (1 - e));
  const center = rc * 10, stick = Math.max(0, max * 10 - center);
  return x * center + stick * expof;
}

/** The tune before the last "Apply to simulated FC" (its `diff all`), so the import can be undone. */
const BACKUP_KEY = 'fpv-bf-backup';
interface Backup { at: number; text: string }
function loadBackup(): Backup | null { try { const s = localStorage.getItem(BACKUP_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }

/** `diff all` output -> config lines (no echo, comments, batch / defaults / save / exit). */
export function diffConfigLines(text: string): string[] {
  return text.replace(/\r/g, '').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !/^(batch|defaults|save|exit|diff|Entering CLI|Leaving CLI|Rebooting)\b/i.test(l));
}

/** Clean `diff all` text for export / backup (drops the CLI's own chatter). */
function cleanDiff(out: string): string {
  return out.replace(/\r/g, '').split('\n').filter((l) => !/^# ?(diff all|exit|leaving CLI|Rebooting)/i.test(l) && !/^Entering CLI/.test(l)).join('\n');
}

export function bfPanel(bf: BfBridge, opts?: BfPanelOptions): HTMLElement {
  const root = el('div', { class: 'panel bf' });
  const values: Record<string, number> = {};
  const dirty = new Set<string>();
  const status = el('div', { class: 'status', role: 'status' }, 'Reading settings from Betaflight…');
  const dirtyTag = el('span', { class: 'bf-dirty' });
  const updateDirty = () => {
    dirtyTag.textContent = dirty.size ? `● ${dirty.size} unsaved change${dirty.size === 1 ? '' : 's'}` : '✓ Matches the flight controller';
    dirtyTag.classList.toggle('on', dirty.size > 0);
  };
  setLeaveGuard(root, { dirty: () => dirty.size > 0, what: () => `${dirty.size} slider change${dirty.size === 1 ? ' is' : 's are'} not written to Betaflight yet.` });
  const curve = el('canvas', { width: 320, height: 200, class: 'curve', role: 'img', 'aria-label': 'Rate curves: stick deflection versus rotation rate for roll, pitch and yaw' }) as HTMLCanvasElement;
  const drawCurve = () => {
    const c = curve.getContext('2d')!; c.clearRect(0, 0, 320, 200);
    c.strokeStyle = '#333'; c.beginPath(); for (let i = 0; i <= 4; i++) { c.moveTo(0, i * 50); c.lineTo(320, i * 50); } c.stroke();
    const colors = { roll: '#ff5a5a', pitch: '#5aff8a', yaw: '#5ab0ff' };
    let maxR = 1;
    for (const a of ['roll', 'pitch', 'yaw'] as const) maxR = Math.max(maxR, actualRate(1, values[`${a}_rc_rate`] ?? 7, values[`${a}_srate`] ?? 67, values[`${a}_expo`] ?? 0));
    c.font = '13px ui-monospace, Consolas, monospace';
    for (const a of ['roll', 'pitch', 'yaw'] as const) {
      c.strokeStyle = colors[a]; c.lineWidth = 2; c.beginPath();
      for (let i = 0; i <= 100; i++) { const x = i / 100; const r = actualRate(x, values[`${a}_rc_rate`] ?? 7, values[`${a}_srate`] ?? 67, values[`${a}_expo`] ?? 0); const px = x * 320, py = 200 - (r / (maxR * 1.05)) * 200; if (i) c.lineTo(px, py); else c.moveTo(px, py); }
      c.stroke();
      c.fillStyle = colors[a]; c.fillText(`${a} ${actualRate(1, values[`${a}_rc_rate`] ?? 7, values[`${a}_srate`] ?? 67, values[`${a}_expo`] ?? 0).toFixed(0)}°/s`, 6, 16 + ['roll', 'pitch', 'yaw'].indexOf(a) * 16);
    }
  };
  // sliders show real units (°/s, rpm, %); the CLI value is shown ÷ scale
  const group = (title: string, ps: Param[]) => section(title, ...ps.map((p) => {
    const k = p.scale ?? 1;
    return slider({ label: p.label, min: p.min * k, max: p.max * k, step: p.step * k, unit: p.unit, value: (values[p.key] ?? p.min) * k,
      onInput: (v) => { values[p.key] = Math.round(v / k); dirty.add(p.key); updateDirty(); drawCurve(); } }).row;
  }));

  const out = el('pre', { class: 'cli-out', 'aria-label': 'CLI output', tabindex: '0' });
  const cliId = uniqueId('cli');
  const inp = el('input', { class: 'cli-in', id: cliId, autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. status, get rpm, diff — Enter sends' }) as HTMLInputElement;
  let entered = false;
  inp.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    if (!entered) { bf.cliSend('#\n'); entered = true; }
    bf.cliSend(inp.value + '\n');
    inp.value = '';
  });
  // one CLI listener per panel, dropped when the menu throws the panel away
  let unsub: (() => void) | void = undefined;
  const stop = () => { if (unsub) { unsub(); unsub = undefined; } };
  let seen = false;
  unsub = bf.onCliOut((t) => {
    seen ||= root.isConnected;
    if (seen && !root.isConnected) { stop(); return; }
    out.textContent = (out.textContent + t).slice(-40000); out.scrollTop = out.scrollHeight;
  });
  onUnmount(root, stop);

  const importSec = opts ? realQuadSection(bf, opts, () => load()) : null;

  const writeSave = async () => {
    if (!dirty.size) { status.textContent = 'Nothing to write: no slider was changed.'; return; }
    const ok = await confirmDialog({ title: 'Write & save to Betaflight?', body: `${dirty.size} setting${dirty.size === 1 ? '' : 's'} will be written and saved. Saving reboots the simulated flight controller, which disarms the quad.`, ok: 'Write & save', cancel: 'Cancel' });
    if (!ok) return;
    status.textContent = 'Writing to Betaflight + save (reboot)…';
    await bf.cliBatch([...[...dirty].map((k) => `set ${k} = ${values[k]}`), 'save']);
    dirty.clear(); updateDirty(); status.textContent = 'Saved to the flight controller EEPROM.';
  };
  const reread = async () => {
    if (dirty.size && !(await confirmDialog({ title: 'Discard unsaved changes?', body: 'Re-reading replaces your unsaved slider changes with the values on the flight controller.', ok: 'Discard and re-read', cancel: 'Keep editing', danger: true }))) return;
    dirty.clear(); void load();
  };
  const restoreDefaults = async () => {
    const ok = await confirmDialog({ title: 'Restore simulator defaults?', body: 'This erases the simulated flight controller’s settings (your tune, rates, filters, OSD layout and any imported diff) and reboots it with the simulator’s first-boot defaults. It cannot be undone.', ok: 'Restore defaults', cancel: 'Cancel', danger: true });
    if (!ok) return;
    opts?.factoryReset?.();
    dirty.clear(); updateDirty();
    status.textContent = 'Restoring simulator defaults (the flight controller reboots)…';
    setTimeout(() => void load(), 2500);
  };

  const render = () => {
    root.replaceChildren(
      el('div', { class: 'cols' },
        el('div', { class: 'col' }, section('Rates (Actual)', curve), group('Rates', RATES)),
        el('div', { class: 'col' }, group('PID gains', PIDS), group('PID dynamics', DYN)),
        el('div', { class: 'col' }, group('Filters', FILTERS),
          el('div', { class: 'actions' },
            el('button', { class: 'primary', onclick: () => void writeSave() }, 'Write & save'),
            el('button', { onclick: () => void reread() }, 'Re-read'),
            dirtyTag,
          ), status,
          section('CLI console',
            el('p', { class: 'note' }, 'Entering the CLI disarms the quad; type exit to leave without saving.'),
            out,
            el('label', { class: 'cli-label', for: cliId }, 'Betaflight CLI command'), inp),
          section('Reset',
            el('p', { class: 'note' }, 'Back to the simulator’s first-boot Betaflight configuration.'),
            el('div', { class: 'actions' }, el('button', { class: 'danger', onclick: () => void restoreDefaults() }, 'Restore sim defaults…'))),
        ),
      ),
      importSec ?? '',
    );
    updateDirty();
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
    dirty.clear();
    render();
  };
  render();
  void load();
  return root;
}

/**
 * "Bring your real quad": paste `diff all` from a real Betaflight FC, preview what is kept vs dropped
 * (board hardware), back up the current tune, apply it to the simulated FC, re-apply the simulator's
 * own hardware settings, and report any lines Betaflight rejected. Built once and kept across panel
 * re-renders.
 */
function realQuadSection(bf: BfBridge, opts: BfPanelOptions, reload: () => Promise<void>): HTMLElement {
  const taId = uniqueId('diff');
  const ta = el('textarea', { class: 'diff-in', id: taId, rows: 10, spellcheck: false, placeholder: 'In Betaflight Configurator → CLI on your real quad, type  diff all  and press Enter, then copy everything it prints and paste it here.' }) as HTMLTextAreaElement;
  const report = el('div', { class: 'diff-report', role: 'status' });
  const restoreRow = el('div', { class: 'actions' });
  let plan: DiffPlan | null = null;
  const drawRestore = () => {
    const b = loadBackup();
    restoreRow.replaceChildren(...(b ? [el('button', { onclick: () => void restore() }, 'Restore backup…'),
      el('span', { class: 'note' }, `Tune before the last import, saved ${new Date(b.at).toLocaleString()}.`)] : []));
  };
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
      el('div', { class: 'actions' }, el('button', { class: 'primary', disabled: !p.apply.length, onclick: () => void apply() }, 'Apply to simulated FC…')),
    );
  };
  const apply = async () => {
    if (!plan || !plan.apply.length) return;
    const p = plan;
    const ok = await confirmDialog({ title: 'Apply this diff to the simulated FC?', body: `${p.apply.length} lines from your quad overwrite the simulated flight controller’s tune, rates, filters and OSD, then it saves and reboots. The current setup is backed up first, so you can restore it.`, ok: 'Back up and apply', cancel: 'Cancel' });
    if (!ok) return;
    report.append(el('p', { class: 'status' }, 'Backing up the current setup (diff all)…'));
    const backup = cleanDiff(await bf.cliBatch(['diff all']));
    if (diffConfigLines(backup).length) { try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: Date.now(), text: backup } satisfies Backup)); } catch { /* storage full: apply anyway */ } }
    drawRestore();
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
  /** Put the backed-up tune back exactly: defaults, replay its diff, re-apply the sim hardware, save. */
  const restore = async () => {
    const b = loadBackup();
    if (!b) return;
    const ok = await confirmDialog({ title: 'Restore the backup?', body: `This replaces the simulated flight controller’s current settings with the tune saved ${new Date(b.at).toLocaleString()}, then saves and reboots it.`, ok: 'Restore backup', cancel: 'Cancel', danger: true });
    if (!ok) return;
    const props = planDiffImport(b.text).propsOut ?? false; // yaw_motors_reversed is OFF unless the diff says so
    if (props !== opts.propsOut()) opts.setPropsOut(props);
    report.replaceChildren(el('p', { class: 'status' }, 'Restoring the backup…'));
    const out = await bf.cliBatch(['defaults nosave', ...diffConfigLines(b.text), ...opts.hardwareCli(true, props), 'save']);
    const errs = cliErrors(out);
    report.replaceChildren(el('p', {}, `Restored the tune from ${new Date(b.at).toLocaleString()}.${errs.length ? ` ${errs.length} line(s) were rejected:` : ''}`),
      errs.length ? el('pre', { class: 'diff-skip' }, errs.join('\n')) : '');
    await reload();
  };
  const exportDiff = async () => {
    const text = cleanDiff(await bf.cliBatch(['diff all']));
    const a = el('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/plain' })), download: 'fpv-sim-diff-all.txt' }) as HTMLAnchorElement;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  drawRestore();
  return section('Bring your real quad — import Betaflight "diff all"',
    el('p', {}, 'Fly the sim with exactly the tune on your real flight controller: PIDs, feedforward, rates, filters, RPM filter, TPA, anti-gravity, dynamic idle, throttle settings and OSD. Board-specific hardware lines are filtered out. For the closest match, also pick your motors, props and battery in the Drone builder.'),
    el('label', { class: 'diff-label', for: taId }, 'Your quad’s diff all'),
    ta,
    el('div', { class: 'actions' },
      el('button', { onclick: preview }, 'Preview'),
      el('button', { onclick: () => void exportDiff() }, 'Export sim diff all'),
    ),
    report,
    restoreRow,
  );
}
