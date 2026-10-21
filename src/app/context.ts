// Shared state of the running app. Long-lived objects (renderer, worker bridge, input, audio …) are
// created once; the world-dependent ones (map, scene, drone build) are replaced when the pilot changes
// map or drone, so modules always read them through this object instead of keeping their own copy.
import type * as THREE from 'three';
import type { DroneBuild, DroneSpec } from '../builder/derive';
import type { InputManager } from '../input/gamepad';
import type { MapDef, PrimitiveWorld } from '../maps/world';
import type { MultiplayerClient } from '../net/multiplayer';
import type { MotorAudio } from '../render/audio';
import type { DroneModel } from '../render/droneMesh';
import type { FpvCamera } from '../render/fpvCamera';
import type { OsdRenderer } from '../render/osdRenderer';
import type { RemoteQuads } from '../render/remoteQuads';
import type { SceneBundle } from '../render/scene';
import type { VideoLink } from '../render/videoLink';
import type { Blackbox } from '../ui/blackbox';
import type { ViewSettings } from '../ui/settingsPanel';
import type { Shared, SimSettings, Telemetry, ToWorker } from '../worker/shared';
import type { LapBoard } from './leaderboard';
import type { DrillState, RaceState } from './race';
import type { LapRecorder } from './replayRecorder';

/**
 * A lap replay shown in place of the live quad (ui/replay/player.ts): while ctx.replay is set, the
 * frame loop renders the replay's map, drone and state instead of the paused live session.
 */
export interface ReplayView {
  /** advance playback; called at the start of every frame */
  frame(now: number): void;
  /** the state at lap time t, in the ring's record layout (R / REC) */
  sample(t: number, out: Float64Array): boolean;
  /** playback time now (lap time, s) */
  readonly time: number;
  readonly playing: boolean;
  readonly speed: number;
  /** changes on every jump (seek, step, loop): the FPV camera captures afresh */
  readonly seq: number;
  readonly cam: 'fpv' | 'chase' | 'los' | 'orbit';
  /** orbit camera around the quad: azimuth, elevation (rad), distance (m) */
  readonly orbit: { az: number; el: number; dist: number };
  /** FPV: the video link's breakup and noise (off: a clean picture) */
  readonly link: boolean;
  /** motor sound on (playing at 1×) */
  readonly sound: boolean;
  /** index of the next gate in ctx.map.gates (the highlight) */
  readonly nextGate: number;
  /** the recorded OSD grid at `time` (read by the OsdRenderer like the shared OSD memory) */
  readonly osd: Pick<Shared, 'ctrl' | 'osd'>;
  readonly wind: { speed: number; direction: number };
  /** put the live session back (also called when the app changes map, drone or scene underneath it) */
  close(): void;
}

export interface AppCtx {
  // persisted settings (replaced as a whole when they change)
  spec: DroneSpec;
  sim: SimSettings;
  view: ViewSettings;
  // world + quad (rebuilt on map / drone changes)
  build: DroneBuild;
  map: MapDef;
  world: PrimitiveWorld;
  scene: SceneBundle;
  drone: DroneModel;
  mountQ: THREE.Quaternion;
  // services
  sh: Shared;
  send: (m: ToWorker) => void;
  renderer: THREE.WebGLRenderer;
  fpv: FpvCamera;
  osd: OsdRenderer;
  link: VideoLink;
  audio: MotorAudio;
  input: InputManager;
  mp: MultiplayerClient;
  remotes: RemoteQuads;
  blackbox: Blackbox;
  // live state
  tel: Telemetry | null;
  fwStatus: string;
  menuOpen: boolean;
  /** newest ring sample (written by the frame loop / HUD each frame) */
  rec: Float64Array;
  /** where the pilot stands (ENU), for the video link, audio and line-of-sight view */
  pilot: { x: number; y: number; z: number };
  race: RaceState;
  drill: DrillState;
  /** personal bests + the global lap leaderboard */
  lb: LapBoard;
  /** records every timed lap for its replay */
  replays: LapRecorder;
  /** the replay being watched, or null (the live session) */
  replay: ReplayView | null;
  logLines: string[];
  log(t: string): void;
}

/** Recent sim / firmware messages shown at the end of the telemetry overlay. */
export function makeLog(lines: string[]) {
  return (t: string) => { lines.push(t); if (lines.length > 6) lines.shift(); };
}
