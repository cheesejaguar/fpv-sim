// What the map builder needs from the app (main.ts provides it): the screen, the paused simulator,
// flying a map, running a scenario, and (optionally) publishing.
import type { AppCtx } from '../app/context';
import type { MapMeta } from '../maps/mapDoc';

/** The editor while it has the screen: the frame loop calls frame() instead of drawing the flight. */
export interface EditorView {
  frame(now: number): void;
  /** the controller's Start / menu button */
  onMenu(): void;
}

export interface EditorHost {
  ctx: AppCtx;
  /** take the screen: the menu closes, the simulator stays paused, the HUD and flight keys are off */
  enter(v: EditorView): void;
  /** give it back: the menu opens on the Build screen */
  leave(): void;
  /** fly a registered map (local-<id>): select it with this course / spawn, respawn and resume */
  fly(o: { mapId: string; courseId: string; spawnId: string; race: boolean }): void;
  /** start a scenario in the live sim (Settings → Research → Scenario's path) and resume flight */
  runScenario(doc: unknown): Promise<void>;
  /**
   * Publish a validated package (map.json, assets, ATTRIBUTION.md / LICENSE.txt). Provided by the
   * user-maps service; without it the editor shows no Publish button.
   */
  onPublish?: (files: Map<string, Blob>, meta: MapMeta) => void | Promise<void>;
}
