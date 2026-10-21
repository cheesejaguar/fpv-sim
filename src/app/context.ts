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
  logLines: string[];
  log(t: string): void;
}

/** Recent sim / firmware messages shown at the end of the telemetry overlay. */
export function makeLog(lines: string[]) {
  return (t: string) => { lines.push(t); if (lines.length > 6) lines.shift(); };
}
