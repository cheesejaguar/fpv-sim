// DVR: records the WebGL canvas (the FPV picture exactly as composited: link artefacts, OSD and the
// goggle overlay) like a goggle's DVR, plus the motor sound when the audio engine offers a stream.
// V starts / stops it (not while typing or in the menus); stopping saves a .webm (.mp4 on browsers
// whose MediaRecorder only does MP4). A small "REC ●" chip of its own shows while it runs.
import type { AppCtx } from './context';

/** Read by the goggle overlay (REC timer) and anything else that wants to show the DVR state. */
export const dvrState = { recording: false, startedAt: 0 };

export interface Dvr { toggle(): void; start(): boolean; stop(): void; readonly recording: boolean }

const TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1,mp4a', 'video/mp4'];

/** Pick the first container / codec this browser's MediaRecorder can write (exported for tests). */
export function pickMimeType(isSupported: (t: string) => boolean): string {
  for (const t of TYPES) if (isSupported(t)) return t;
  return '';
}

/** DVR file name, e.g. fpv-dvr-2026-10-21_14-03-07.webm. */
export function dvrFileName(d: Date, mime: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  return `fpv-dvr-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`;
}

/** "02:07" from milliseconds (goggle REC timers count mm:ss). */
export function recClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Wire the DVR: call once from main.ts after the app context exists. */
export function initDvr(ctx: AppCtx, parent: HTMLElement = document.body): Dvr {
  const canvas = ctx.renderer.domElement;
  let rec: MediaRecorder | null = null, chunks: Blob[] = [], mime = '', stream: MediaStream | null = null;
  const chip = document.createElement('div');
  chip.className = 'dvr-rec';
  chip.setAttribute('role', 'status');
  Object.assign(chip.style, {
    position: 'fixed', top: '10px', left: '50%', transform: 'translateX(-50%)', zIndex: '40', display: 'none',
    padding: '3px 10px', borderRadius: '6px', background: 'rgba(0,0,0,0.6)', color: '#fff',
    font: '600 13px/1.4 system-ui, sans-serif', letterSpacing: '0.06em', pointerEvents: 'none',
  } as Partial<CSSStyleDeclaration>);
  const dot = document.createElement('span');
  dot.textContent = '●';
  Object.assign(dot.style, { color: '#ff3b30', marginLeft: '6px' });
  const clock = document.createElement('span');
  Object.assign(clock.style, { marginLeft: '8px', fontVariantNumeric: 'tabular-nums', opacity: '0.85' });
  const label = document.createElement('span');
  label.textContent = 'REC';
  chip.append(label, dot, clock);
  parent.append(chip);
  let tick = 0, noteT = 0;
  const showChip = (on: boolean) => {
    chip.style.display = on ? 'block' : 'none';
    label.textContent = 'REC'; dot.style.display = clock.style.display = '';
    clearInterval(tick); clearTimeout(noteT);
    if (on) tick = window.setInterval(() => {
      const ms = performance.now() - dvrState.startedAt;
      clock.textContent = recClock(ms);
      dot.style.visibility = Math.floor(ms / 500) % 2 ? 'hidden' : 'visible'; // blinks like a camcorder
    }, 250);
  };

  const save = () => {
    if (!chunks.length) return;
    const blob = new Blob(chunks, { type: mime || 'video/webm' });
    chunks = [];
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = dvrFileName(new Date(), mime);
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  };

  /** A short message in the chip instead of the timer (e.g. no MediaRecorder in this browser). */
  const note = (text: string) => {
    showChip(true); clearInterval(tick);
    label.textContent = text; dot.style.display = clock.style.display = 'none';
    noteT = window.setTimeout(() => showChip(false), 2500);
    ctx.log(text);
  };
  const start = (): boolean => {
    if (rec) return false;
    if (typeof MediaRecorder === 'undefined' || !canvas.captureStream) { note('DVR: this browser cannot record video'); return false; }
    const v = ctx.build.info.components.video;
    // record at the camera's frame rate (the canvas only changes on new camera frames anyway)
    stream = canvas.captureStream(Math.min(120, Math.round(v.fps)));
    const audio = (ctx.audio as { mediaStream?(): MediaStream | null | undefined }).mediaStream?.();
    for (const t of audio?.getAudioTracks() ?? []) stream.addTrack(t);
    mime = pickMimeType((t) => MediaRecorder.isTypeSupported(t));
    try {
      rec = new MediaRecorder(stream, { ...(mime && { mimeType: mime }), videoBitsPerSecond: v.kind === 'analog' ? 6e6 : 16e6 });
    } catch (e) { note(`DVR: ${(e as Error).message}`); stream = null; return false; }
    mime = rec.mimeType || mime;
    chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = () => { save(); for (const t of stream?.getVideoTracks() ?? []) t.stop(); stream = null; };
    rec.start(1000); // 1 s chunks: a long flight never sits in one giant buffer
    dvrState.recording = true; dvrState.startedAt = performance.now();
    clock.textContent = recClock(0);
    showChip(true);
    return true;
  };
  const stop = () => {
    if (!rec) return;
    const r = rec; rec = null;
    dvrState.recording = false;
    showChip(false);
    if (r.state !== 'inactive') r.stop();
  };
  const dvr: Dvr = {
    toggle: () => (rec ? stop() : void start()),
    start, stop,
    get recording() { return rec !== null; },
  };

  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyV' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (ctx.menuOpen) return;
    dvr.toggle();
  });
  // closing the tab mid-recording still saves what was recorded
  window.addEventListener('pagehide', stop);
  return dvr;
}
