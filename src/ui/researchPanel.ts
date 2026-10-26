// Settings → Research: the simulator as an instrument. Reproducible runs (record a flight that the
// headless simulator re-simulates exactly), the camera dataset recorder (pictures with depth,
// segmentation and labels), scenario files (an experiment or a drill set up from one file), and the
// control API connection (a program flies the quad). Loaded the first time the tab opens.
import type { ApiHost } from '../app/apiHost';
import type { WorkerBridge } from '../app/bridge';
import type { AppCtx } from '../app/context';
import { checkbox, el, onUnmount, section, select } from './dom';

export interface ResearchDeps {
  ctx: AppCtx;
  api: ApiHost;
  bridge: WorkerBridge;
  /** close the menu into flight */
  fly(): void;
}

const download = (data: BlobPart, name: string, type: string) => {
  const a = el('a', { href: URL.createObjectURL(new Blob([data], { type })), download: name }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const randomSeed = () => Math.floor(Math.random() * 2 ** 31);

let recBanner: HTMLElement | null = null;

export function researchPanel(d: ResearchDeps): HTMLElement {
  const { ctx } = d;
  currentCtx = ctx;
  const root = el('div', { class: 'panel research' });
  const timers: ReturnType<typeof setInterval>[] = [];
  onUnmount(root, () => timers.forEach(clearInterval));

  // ---- reproducible run ----
  const seedIn = el('input', { type: 'number', min: 0, max: 4294967295, step: 1, value: String(ctx.run.seed ?? randomSeed()), 'aria-label': 'Seed', style: { width: '9em' } }) as HTMLInputElement;
  const runStatus = el('p', { class: 'status', role: 'status' });
  const showRun = () => {
    const r = ctx.run;
    runStatus.textContent = r.active ? `Recording a run (seed ${r.seed}). Fly, then come back here to stop it.` : r.reason ? `Last run ended: ${r.reason}.` : 'No run recorded yet.';
  };
  showRun(); timers.push(setInterval(showRun, 500));
  const runSec = section('Reproducible run',
    el('p', {}, 'Records a flight so that it can be re-simulated exactly, headless, on any computer: the simulator reboots Betaflight, seeds every random process (wind turbulence, sensor noise, the radio link) and records the sticks of every RC packet the flight controller receives. Changing the drone, the map, the settings or Betaflight ends the run.'),
    el('div', { class: 'actions' },
      el('label', { class: 'field inline' }, el('span', { class: 'lbl' }, 'Seed'), seedIn),
      el('button', { type: 'button', onclick: () => { seedIn.value = String(randomSeed()); } }, 'New seed')),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'primary', onclick: () => { const s = Number(seedIn.value) >>> 0; d.bridge.runStart(s); ctx.run = { active: true, seed: s }; d.fly(); } }, 'Start run and fly'),
      el('button', { type: 'button', onclick: async () => {
        const r = await d.bridge.runStop();
        if (!r.data.byteLength) { runStatus.textContent = 'There is no run to save yet.'; return; }
        download(r.data, `fpv-sim-run-${stamp()}.fpvrun`, 'application/gzip');
        runStatus.textContent = `Saved a ${r.seconds.toFixed(1)} s run (${r.reason}). Re-simulate it with: npm run resim -- <file>.fpvrun`;
      } }, 'Stop and save .fpvrun')),
    runStatus);

  // ---- dataset recorder ----
  const opts = { hz: '10', rgb: true, received: false, depth: true, segmentation: true };
  const dsStatus = el('p', { class: 'status', role: 'status' });
  const dsSec = section('Camera dataset',
    el('p', {}, 'Records what the FPV camera sees, frame by frame, with ground truth through the same fisheye lens: range from the lens (16-bit PNG, millimetres), semantic classes and gate instances (PNG), and labels for every frame — camera intrinsics and pose, the quad\'s state and sticks, and every gate\'s corners in the image with their visibility. Works in flight and in lap replays (FPV camera). Format: docs/DATASET.md.'),
    select('Frames per second (sim time)', ['2', '5', '10', '20', '30'].map((v) => ({ value: v, label: `${v} Hz` })), opts.hz, (v) => { opts.hz = v; }),
    checkbox('Camera picture (clean)', opts.rgb, (v) => { opts.rgb = v; }),
    checkbox('Received picture (radio link, OSD)', opts.received, (v) => { opts.received = v; }),
    checkbox('Depth (range from the lens)', opts.depth, (v) => { opts.depth = v; }),
    checkbox('Segmentation and gate instances', opts.segmentation, (v) => { opts.segmentation = v; }),
    el('div', { class: 'actions' },
      el('button', { type: 'button', class: 'primary', onclick: async () => {
        const ds = await import('../app/dataset');
        try {
          ds.startRecording(ctx, { hz: +opts.hz, rgb: opts.rgb, received: opts.received, depth: opts.depth, segmentation: opts.segmentation }, undefined, () => showRec(ds.recordingStatus()));
        } catch (e) { dsStatus.textContent = (e as Error).message; return; }
        showRec(ds.recordingStatus());
        d.fly();
      } }, 'Start recording and fly'),
      el('button', { type: 'button', onclick: () => void stopDataset(ctx, dsStatus) }, 'Stop and save .zip')),
    dsStatus);

  // ---- scenario ----
  const scStatus = el('p', { class: 'status', role: 'status' });
  const file = el('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Scenario file', onchange: async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const doc = JSON.parse(await f.text());
      const b = await d.api.backend();
      const off = b.listen('episode', (e) => {
        const m = (e as { reason: string; metrics: Record<string, unknown> });
        ctx.log(`Scenario ended (${m.reason}): ${summary(m.metrics)}`);
        scStatus.textContent = `Last attempt: ${m.reason}. ${summary(m.metrics)}`;
        off();
      });
      await b.call('reset', { scenario: doc, pilot: true });
      scStatus.textContent = `Loaded ${(doc.meta?.name as string) ?? f.name}.`;
    } catch (e) { scStatus.textContent = `This scenario can't be used: ${(e as Error).message}`; }
    file.value = '';
  } }) as HTMLInputElement;
  const scSec = section('Scenario',
    el('p', {}, 'A scenario file (fpvsim-scenario, docs/SCENARIO_FORMAT.md) sets up the map and course, the drone, wind and conditions, Betaflight\'s configuration, the start and a scored task — the same file the headless simulator and the control API take. You fly it; the task\'s result is shown when it ends.'),
    el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Load a scenario (.json)'), file),
    scStatus);

  // ---- control API ----
  const url = el('input', { type: 'text', value: 'ws://127.0.0.1:8765', spellcheck: false, 'aria-label': 'Relay address', style: { width: '16em' } }) as HTMLInputElement;
  const apiStatus = el('p', { class: 'status', role: 'status' }, document.querySelector('.api-banner') ? 'Connected.' : 'Not connected.');
  const apiSec = section('Control API',
    el('p', {}, 'Lets a program fly the simulator and read its state in real time: start the relay on this computer with "npm run api -- --live", then connect. Python: python/fpvsim (docs/API.md). A banner shows while a program is connected, and one click takes the controls back.'),
    el('div', { class: 'actions' }, url,
      el('button', { type: 'button', class: 'primary', onclick: async () => {
        apiStatus.textContent = 'Connecting…';
        try { await (await d.api.backend()).connect(url.value.trim()); apiStatus.textContent = `Connected to ${url.value.trim()}.`; } catch (e) { apiStatus.textContent = (e as Error).message; }
      } }, 'Connect'),
      el('button', { type: 'button', onclick: async () => { (await d.api.backend()).disconnect(); apiStatus.textContent = 'Not connected.'; } }, 'Disconnect')),
    apiStatus);

  root.append(runSec, dsSec, scSec, apiSec);
  return root;
}

function summary(m: Record<string, unknown>): string {
  const n = (k: string, unit = '', digits = 2) => (typeof m[k] === 'number' ? `${(m[k] as number).toFixed(digits)}${unit}` : null);
  const bits = [
    m.type === 'hover' && `inside the box ${((m.insideFraction as number) * 100).toFixed(0)} %, RMS error ${n('rmsErrorM', ' m')}`,
    (m.type === 'gates' || m.type === 'waypoints') && `${m.passed}/${m.total} passed${Array.isArray(m.lapTimesS) && m.lapTimesS.length ? `, lap ${(m.lapTimesS as number[])[0].toFixed(3)} s` : ''}`,
    `${n('elapsedS', ' s', 1)}`,
  ].filter(Boolean);
  return bits.join(' · ');
}

/** The recording banner (frames so far, Stop) while the dataset recorder runs; built once, its text updated. */
function showRec(st: { frames: number; dropped: number; bytes: number; max: number } | null) {
  if (!st) { recBanner?.remove(); recBanner = null; return; }
  if (!recBanner) {
    const text = el('span', { class: 'rec-text' });
    recBanner = el('div', { class: 'api-banner rec-banner', role: 'status' },
      el('span', { class: 'api-dot api-flying' }), text,
      el('button', { type: 'button', onclick: () => { if (currentCtx) void stopDataset(currentCtx, null); } }, 'Stop and save'));
    document.body.append(recBanner);
  }
  const t = `Recording dataset · ${st.frames} frames${st.dropped ? ` (${st.dropped} skipped)` : ''} · ${(st.bytes / 1048576).toFixed(0)} MB${st.frames >= st.max ? ' · full' : ''}`;
  const span = recBanner.querySelector('.rec-text')!;
  if (span.textContent !== t) span.textContent = t;
}

/** the app, for the recording banner's Stop button (the banner outlives the panel) */
let currentCtx: AppCtx | null = null;
async function stopDataset(ctx: AppCtx, status: HTMLElement | null) {
  currentCtx = ctx;
  const ds = await import('../app/dataset');
  if (!ds.recordingStatus()) { if (status) status.textContent = 'Not recording.'; return; }
  const r = await ds.stopRecording(ctx, true);
  showRec(null);
  if (r.blob) download(r.blob, `fpv-sim-dataset-${stamp()}.zip`, 'application/zip');
  const msg = `Saved ${r.frames} frames${r.dropped ? ` (${r.dropped} skipped: the computer could not keep up)` : ''}.`;
  if (status) status.textContent = msg;
  ctx.log(`Dataset: ${msg}`);
}
