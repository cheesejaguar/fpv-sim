// The line a lap actually flew, for the track-map card: the replay's positions (ENU, the same frame
// as the gate plan), thinned to about 400 points.
import { decodeReplay } from '../../server/src/replayFormat';

export async function trailFromReplay(bytes: Uint8Array): Promise<{ x: number; y: number }[] | null> {
  const { px, py } = (await decodeReplay(bytes)).columns;
  if (!px?.length || !py) return null;
  const step = Math.max(1, Math.ceil(px.length / 400)), out: { x: number; y: number }[] = [];
  for (let i = 0; i < px.length; i += step) out.push({ x: px[i], y: py[i] });
  return out;
}
