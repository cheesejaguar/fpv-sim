// Watching a lap replay: the replay's map (and course), time of day and drone are put in place of
// the live session's for the frame loop to render, without touching anything the pilot saved; the
// live sim stays paused behind the menu. Loaded with the replay player.
import { buildDrone, preloadPropTable } from '../builder/derive';
import { hasMap, MAPS, preloadMap } from '../maps/maps';
import { MapDef, PrimitiveWorld, withCourse } from '../maps/world';
import { cameraMountQuat } from '../render/coords';
import { buildDroneMesh } from '../render/droneMesh';
import { OsdRenderer } from '../render/osdRenderer';
import { buildScene, TimeOfDay } from '../render/scene';
import { VideoLink } from '../render/videoLink';
import type { AppCtx, ReplayView } from './context';
import { courseOf } from './leaderboard';
import { parseSpec } from './persist';
import type { ReplayTrack } from './replayTrack';

const TIMES: readonly TimeOfDay[] = ['map', 'morning', 'noon', 'golden', 'dusk', 'night'];

/** What the replay needs of this build: its map, its drone's parts. Throws with a message for the pilot. */
export async function replayWorld(track: ReplayTrack): Promise<{ map: MapDef; spec: NonNullable<ReturnType<typeof parseSpec>> }> {
  const h = track.header;
  const spec = parseSpec(h.spec);
  if (!spec) throw new Error('This replay was flown with drone parts this version of FPV Sim doesn’t have.');
  if (!hasMap(h.map)) throw new Error(`This replay was flown on a map this version of FPV Sim doesn’t have (${h.map}).`);
  // the map's data and the prop's precomputed BEMT table (else enterReplay's buildDrone spends ~1.2 s on it)
  await Promise.all([preloadMap(h.map), preloadPropTable(spec.prop)]);
  const map = withCourse(MAPS[h.map](), h.course);
  if (courseOf(map) !== h.course && h.course) throw new Error(`This replay was flown on a course this map doesn’t have any more (${h.course}).`);
  return { map, spec };
}

/**
 * Show the replay instead of the live session (ctx.replay = view) and return the function that
 * puts the live session back exactly as it was. The live scene is reused when the replay flies the
 * same map, course and time of day (only the quad is swapped); otherwise the replay gets its own.
 */
export function enterReplay(ctx: AppCtx, track: ReplayTrack, w: Awaited<ReturnType<typeof replayWorld>>, view: ReplayView): () => void {
  const live = { map: ctx.map, world: ctx.world, scene: ctx.scene, drone: ctx.drone, build: ctx.build, mountQ: ctx.mountQ, osd: ctx.osd, link: ctx.link };
  const h = track.header;
  const tod = TIMES.includes(h.timeOfDay as TimeOfDay) ? (h.timeOfDay as TimeOfDay) : ctx.view.timeOfDay;
  const reuse = live.map.id === w.map.id && courseOf(live.map) === h.course && tod === ctx.view.timeOfDay;
  const build = buildDrone(w.spec);
  const drone = buildDroneMesh(build.spec, build.info, build.params.rotors.map((r) => ({ ...r.pos, dir: r.dir })), build.info.cgMm);
  const scene = reuse ? live.scene : buildScene(w.map, { timeOfDay: tod });
  if (reuse) scene.scene.remove(live.drone.root);
  scene.scene.add(drone.root);
  const osd = new OsdRenderer();
  void osd.setFont(ctx.view.osdFont);
  track.cells = build.info.components.battery.cells;
  Object.assign(ctx, { map: w.map, world: reuse ? live.world : new PrimitiveWorld(w.map), scene, drone, build, mountQ: cameraMountQuat(w.spec.cameraUptiltDeg), osd, link: new VideoLink() });
  ctx.fpv.setVideo(build.info.components.video, ctx.view.renderScale);
  ctx.replay = view;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (ctx.replay === view) ctx.replay = null;
    scene.scene.remove(drone.root); drone.dispose();
    if (reuse) scene.scene.add(live.drone.root); else scene.dispose();
    osd.texture.dispose();
    Object.assign(ctx, live);
    ctx.fpv.setVideo(live.build.info.components.video, ctx.view.renderScale);
  };
}
