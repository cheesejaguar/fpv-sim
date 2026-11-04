// Types of apHost.mjs (plain JavaScript so that a Node worker thread can load it unchanged).

export declare const AP: Readonly<{
  CTRL_INTS: number;
  STATE_SEQ: number; SERVO_SEQ: number; STATUS: number; STATE_LEN: number; SERVO_FRAME: number; SERVO_N: number; EXIT_CODE: number; SERVO_RATE: number;
  LOADING: number; RUNNING: number; EXITED: number; FAILED: number;
  SERVO_OFF: number; SERVO_MAX: number;
  STATE_OFF: number; STATE_MAX: number;
  RING_OFF: number; RING_HDR: number; RING_CAP: number; PORTS: number;
}>;

export declare const AP_BYTES: number;
export declare function ringOffset(port: number, dir: 0 | 1): number;

export declare class ByteRing {
  constructor(sab: SharedArrayBuffer, off: number);
  readonly size: number;
  write(src: ArrayLike<number>, off?: number, n?: number): number;
  read(dst: Uint8Array, off: number, max: number): number;
}

export interface ApInit {
  sab: SharedArrayBuffer;
  moduleUrl: string;
  files?: Record<string, string>;
  args: string[];
  cwd?: string;
}

export type ApHostMessage = { type: 'log'; text: string } | { type: 'exit'; code: number } | { type: 'error'; reason: string };

export declare function runArduPilot(init: ApInit, post: (m: ApHostMessage) => void): Promise<void>;
