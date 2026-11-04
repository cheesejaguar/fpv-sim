// An on-screen display for ArduPilot builds, in the character grid the HUD draws Betaflight's
// (MAX7456 fonts: uppercase letters, digits and punctuation sit at their ASCII codes). ArduPilot's
// own OSD needs an OSD chip or MSP DisplayPort the browser build doesn't have, so the simulator
// composes one from what its ground station hears (src/ap/apLink.ts ApHub), laid out the way an
// ArduPilot OSD screen usually is: flight mode and arming top left, battery top right, speed and
// altitude at the sides, GPS and distance home at the bottom, the newest message in the middle.
import type { ApTelemetry } from './apLink';

export interface ApOsdExtra {
  vehicle: 'plane' | 'copter';
  vbus: number; current: number; mah: number;
  /** distance (m) and bearing (deg, relative to the nose) home; NaN before a fix */
  homeDistM: number;
  inHand: boolean;
  /** firmware time (s), for the message timeout */
  t: number;
}

/** Grid size: an analog PAL screen (30 x 16) or an HD one (50 x 18). */
export const apOsdSize = (hd: boolean) => (hd ? { cols: 50, rows: 18 } : { cols: 30, rows: 16 });

/** Write the screen into chars (row-major, stride cols x rows of the shared grid) and clear attributes. */
export function apOsd(tel: ApTelemetry, x: ApOsdExtra, grid: { cols: number; rows: number }, stride: number, out: Uint8Array, attrOffset: number) {
  const { cols, rows } = grid;
  for (let r = 0; r < rows; r++) { out.fill(0x20, r * stride, r * stride + cols); out.fill(0, attrOffset + r * stride, attrOffset + r * stride + cols); }
  const put = (r: number, c: number, text: string) => {
    if (r < 0 || r >= rows) return;
    const s = text.toUpperCase();
    for (let i = 0; i < s.length; i++) {
      const cc = c + i;
      if (cc < 0 || cc >= cols) continue;
      const code = s.charCodeAt(i);
      out[r * stride + cc] = code >= 0x20 && code < 0x7f ? code : 0x20;
    }
  };
  const right = (r: number, text: string) => put(r, cols - 1 - text.length, text);
  const center = (r: number, text: string) => put(r, Math.max(0, Math.floor((cols - text.length) / 2)), text);

  // top: mode and arming, battery
  put(1, 1, tel.connected ? tel.modeName : 'BOOTING');
  put(2, 1, tel.armed ? 'ARMED' : 'DISARMED');
  right(1, `${x.vbus.toFixed(1)}V`);
  right(2, `${x.current.toFixed(1)}A ${Math.round(x.mah)}MAH`);
  // sides: speed (airspeed on a plane) and altitude above home, climb rate
  const mid = Math.floor(rows / 2);
  const kmh = (v: number) => Math.round(v * 3.6);
  if (x.vehicle === 'plane') { put(mid - 1, 1, `AS ${kmh(tel.airspeed)}`); put(mid, 1, `GS ${kmh(tel.groundspeed)}`); }
  else put(mid, 1, `${kmh(tel.groundspeed)}KMH`);
  right(mid - 1, `ALT ${Math.round(tel.relAlt)}M`);
  right(mid, `${tel.climb >= 0 ? '+' : ''}${tel.climb.toFixed(1)}M/S`);
  right(mid + 1, `THR ${Math.round(tel.throttle)}`);
  // bottom: GPS, home, mission
  put(rows - 2, 1, `SAT ${tel.sats}${tel.gpsFix >= 3 ? '' : ' NOFIX'}`);
  if (Number.isFinite(x.homeDistM)) center(rows - 2, `HOME ${Math.round(x.homeDistM)}M`);
  right(rows - 2, `HDG ${String(Math.round(tel.headingDeg)).padStart(3, '0')}`);
  if (tel.wpTotal > 0 && (tel.modeName === 'AUTO' || tel.modeName === 'GUIDED')) center(rows - 3, `WP ${tel.wpSeq}/${tel.wpTotal} ${Math.round(tel.wpDist)}M`);
  // the newest message for 4 s; a plane in the hand says how to throw it
  const msg = tel.texts[tel.texts.length - 1];
  if (x.inHand) center(mid + 3, tel.armed ? 'THROTTLE UP TO THROW' : 'ARM, THEN THROTTLE UP TO THROW');
  else if (msg && x.t - msg.t < 4) center(mid + 3, msg.text.slice(0, cols - 2));
}
