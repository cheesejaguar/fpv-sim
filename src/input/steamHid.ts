// Direct WebHID driver for the 2026 Steam Controller ("Triton"), wired or via its wireless puck.
//
// That controller does not present itself to Windows as a gamepad: without Steam actively driving
// it, it falls back to "lizard mode" (keyboard + mouse), so the browser Gamepad API never sees it.
// Valve's protocol is documented by its open-source driver in SDL
// (src/joystick/hidapi/SDL_hidapi_steam_triton.c, steam/controller_structs.h, zlib licence):
//   - feature report 1: ID_SET_SETTINGS_VALUES(0x87), len 3, {SETTING_LIZARD_MODE(9) = OFF(0)},
//     re-sent every few seconds (the controller's watchdog re-enables lizard mode)
//   - input reports 0x42 / 0x45 (BLE) = TritonMTUNoQuat_t, 0x47 = variant with a trackpad timestamp
// Decoded state is exposed as a Gamepad-like object with the W3C "standard" layout so the rest of
// the input pipeline (profiles, wizard, calibration) works unchanged.

const VALVE = 0x28de;
// 0x1302 wired, 0x1303 BLE, 0x1304 Proteus puck, 0x1305 Nereid puck
const TRITON_PIDS = [0x1302, 0x1303, 0x1304, 0x1305];

const B = {
  A: 0x1, B: 0x2, X: 0x4, Y: 0x8, QAM: 0x10, R3: 0x20, VIEW: 0x40, R4: 0x80, R5: 0x100, R: 0x200,
  DOWN: 0x400, RIGHT: 0x800, LEFT: 0x1000, UP: 0x2000, MENU: 0x4000, L3: 0x8000, STEAM: 0x10000,
  L4: 0x20000, L5: 0x40000, L: 0x80000, RPAD_TOUCH: 0x200000, RPAD_CLICK: 0x400000,
  LPAD_TOUCH: 0x2000000, LPAD_CLICK: 0x4000000,
};

export interface HidPadButton { pressed: boolean; touched: boolean; value: number }
/** Minimal Gamepad-compatible snapshot. */
export interface HidPad { id: string; index: number; mapping: string; connected: boolean; timestamp: number; axes: number[]; buttons: HidPadButton[] }

type HIDDeviceLike = {
  opened: boolean; productId: number; vendorId: number; productName: string;
  collections: { usagePage: number; usage: number; inputReports?: { reportId: number }[] }[];
  open(): Promise<void>; close(): Promise<void>;
  sendFeatureReport(reportId: number, data: BufferSource): Promise<void>;
  addEventListener(t: 'inputreport', cb: (e: { reportId: number; data: DataView }) => void): void;
};

/** Standard-layout button i: its bit in the report (0 = analog trigger: 6 left, 7 right). */
const BUTTON_MASKS = [
  B.A, B.B, B.X, B.Y, B.L, B.R, 0, 0,
  B.VIEW, B.MENU, B.L3, B.R3, B.UP, B.DOWN, B.LEFT, B.RIGHT,
  B.STEAM, B.QAM, B.L4, B.R4, B.L5, B.R5, B.LPAD_CLICK, B.RPAD_CLICK,
];

const hid = (): any => (navigator as any).hid;
export const webHidSupported = () => !!hid();

export class SteamHidController {
  private devices: HIDDeviceLike[] = [];
  private keepalive: number | undefined;
  pad: HidPad | null = null;
  private ids = new WeakMap<object, string>();
  status = '';
  lastReportAt = 0;

  constructor() {
    if (!webHidSupported()) return;
    // Re-open controllers the user has already granted, and follow hot-plug.
    void this.reconnect();
    hid().addEventListener('connect', () => void this.reconnect());
    hid().addEventListener('disconnect', (e: any) => {
      this.devices = this.devices.filter((d) => d !== e.device);
      if (!this.devices.length) { this.pad = null; this.status = 'Steam Controller disconnected'; }
    });
  }

  /** Must be called from a user gesture (click / key press): shows the browser's device chooser. */
  async request(): Promise<void> {
    if (!webHidSupported()) { this.status = 'This browser has no WebHID. Use Chrome or Edge.'; return; }
    try {
      await hid().requestDevice({ filters: TRITON_PIDS.map((productId) => ({ vendorId: VALVE, productId })) });
    } catch (e) { this.status = `Device request failed: ${(e as Error).message}`; return; }
    await this.reconnect();
  }

  private async reconnect(): Promise<void> {
    const all: HIDDeviceLike[] = await hid().getDevices();
    const ours = all.filter((d) => d.vendorId === VALVE && TRITON_PIDS.includes(d.productId))
      // the controller interfaces are vendor-defined (usage page 0xFFxx); keyboard/mouse ones are
      // reserved by Windows and could not be opened anyway
      .filter((d) => d.collections.some((c) => c.usagePage >= 0xff00));
    for (const d of ours) {
      if (this.devices.includes(d)) continue;
      try {
        if (!d.opened) await d.open();
        d.addEventListener('inputreport', (e) => this.onReport(d, e.reportId, e.data));
        this.devices.push(d);
        await this.lizardOff(d);
      } catch (e) {
        this.status = `Could not open ${d.productName || 'Steam Controller'}: ${(e as Error).message}. If Steam is running it may be holding the controller: close Steam and try again.`;
      }
    }
    if (this.devices.length && this.keepalive === undefined) {
      this.keepalive = window.setInterval(() => { for (const d of this.devices) void this.lizardOff(d); }, 2000);
    }
    if (this.devices.length && !this.pad) this.status = 'Steam Controller opened, waiting for input…';
  }

  private async lizardOff(d: HIDDeviceLike): Promise<void> {
    // FeatureReportMsg after report id 1: header {type, length}, ControllerSetting {u8 num, u16 value}
    const buf = new Uint8Array(63);
    buf[0] = 0x87; buf[1] = 3; buf[2] = 9; buf[3] = 0; buf[4] = 0;
    try { await d.sendFeatureReport(1, buf); } catch { /* wireless interface with no controller paired: ignore */ }
  }

  private onReport(d: HIDDeviceLike, reportId: number, v: DataView): void {
    let padOff: number;
    if (reportId === 0x42 || reportId === 0x45) padOff = 17;      // TritonMTUNoQuat_t
    else if (reportId === 0x47) padOff = 19;                       // + u16 trackpad timestamp
    else return;
    if (v.byteLength < padOff + 12) return;
    const s16 = (o: number) => v.getInt16(o, true) / 32768;
    const buttons = v.getUint32(1, true);
    const trigL = Math.max(0, v.getInt16(5, true)) / 32767, trigR = Math.max(0, v.getInt16(7, true)) / 32767;
    this.lastReportAt = performance.now();
    // one pad object, updated in place: reports arrive at up to ~1 kHz and every reader copies what it
    // keeps (edge detection, the setup wizard, menu navigation)
    const pad = (this.pad ??= { id: '', index: 100, mapping: 'standard', connected: true, timestamp: 0, axes: new Array<number>(8).fill(0), buttons: Array.from({ length: 24 }, () => ({ pressed: false, touched: false, value: 0 })) });
    let id = this.ids.get(d);
    if (id === undefined) { id = `Steam Controller (2026) — WebHID ${d.productName || ''} (Vendor: 28de Product: ${d.productId.toString(16)})`; this.ids.set(d, id); }
    pad.id = id; pad.timestamp = this.lastReportAt;
    // Sticks: raw +Y is up; the standard Gamepad layout has +Y down.
    // standard: 0 LX, 1 LY, 2 RX, 3 RY; extras: 4/5 right trackpad, 6/7 left trackpad
    const ax = pad.axes, rpad = (buttons & B.RPAD_TOUCH) !== 0, lpad = (buttons & B.LPAD_TOUCH) !== 0;
    ax[0] = s16(9); ax[1] = -s16(11); ax[2] = s16(13); ax[3] = -s16(15);
    ax[4] = rpad ? s16(padOff + 6) : 0; ax[5] = rpad ? -s16(padOff + 8) : 0;
    ax[6] = lpad ? s16(padOff) : 0; ax[7] = lpad ? -s16(padOff + 2) : 0;
    const bt = pad.buttons;
    for (let i = 0; i < 24; i++) {
      const m = BUTTON_MASKS[i];
      if (m === 0) { const x = i === 6 ? trigL : trigR; bt[i].pressed = x > 0.5; bt[i].touched = x > 0.02; bt[i].value = x; continue; }
      const on = (buttons & m) !== 0;
      bt[i].pressed = on; bt[i].touched = on; bt[i].value = on ? 1 : 0;
    }
    this.status = '';
  }

  /** Current pad, or null if nothing has reported recently. */
  current(): HidPad | null {
    if (!this.pad) return null;
    if (performance.now() - this.lastReportAt > 1500) return null;
    return this.pad;
  }
}
