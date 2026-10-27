// One line of text for the app's log per operational event (src/worker/ops.ts): faults, the
// payload, the fibre, the GNSS receiver.
import type { OpsEvent } from '../worker/ops';

export function opsEventText(e: OpsEvent): string {
  switch (e.type) {
    case 'fault': return `Fault ${e.on ? 'injected' : 'cleared'}: ${e.kind.replace(/_/g, ' ')}${e.motor ? ` (motor ${e.motor})` : ''}`;
    case 'payload_release': return `Payload released at ${Math.hypot(e.vel.x, e.vel.y, e.vel.z).toFixed(1)} m/s`;
    case 'payload_impact': return `Payload landed after ${e.flightS.toFixed(1)} s at ${e.speed.toFixed(1)} m/s`;
    case 'fiber_break': return `Fibre broke: ${e.reason}`;
    case 'gnss': return e.state === 'ok' ? 'GNSS: back to normal' : `GNSS ${e.state === 'lost' ? 'lost (jamming or failure)' : e.state === 'spoofed' ? 'spoofed: the position is counterfeit' : 'degraded'}`;
  }
}
