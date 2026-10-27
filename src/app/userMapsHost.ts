// User maps in the running app (main.ts): ?map=u-… links, the user map selected last session, a
// room host's pick of a user map (a consent card for each pilot), and the banner while flying one.
// Small on purpose: the downloads, dialogs and their styles (src/net/userMaps.ts,
// src/ui/userMaps/*) load the first time a user map is involved.
import { isUserMapId } from '../net/protocol';
import { MAP_LIST } from '../maps/maps';
import type { SimSettings } from '../worker/shared';
import type { AppCtx } from './context';

export interface UserMapsDeps {
  ctx: AppCtx;
  applySim(s: SimSettings): void;
  /** switch to the room's map as main.ts does for a room map change (not sent back to the room) */
  applyRoomMap(id: string): void;
  /** a user map was opened from a link: preselect it in New game */
  selected?(id: string): void;
}

const ui = () => import('../ui/userMaps/browser');

export function installUserMaps(d: UserMapsDeps) {
  const { ctx } = d;
  let offered: string | null = null;

  /** The room's map is a user map this pilot doesn't have: ask, then download, verify and switch. */
  async function offerRoomMap(id: string): Promise<void> {
    if (offered === id) return;
    offered = id;
    try {
      const { confirmAndFetch } = await ui();
      const got = await confirmAndFetch(id, {
        title: 'The host picked a user map',
        lead: 'Load it to fly with the room? If you don’t, you stay on your current map.',
      });
      if (ctx.mp.map !== id || !ctx.mp.active) return; // the room moved on meanwhile
      if (got) d.applyRoomMap(id);
      else ctx.log(`Staying on ${ctx.map.name}: the room flies a user map you didn’t load`);
    } catch (e) { ctx.log(`User map ${id}: ${(e as Error)?.message ?? e}`); }
    finally { if (offered === id) offered = null; }
  }

  /** Boot: the user map flown last session (from this device's cache), or a ?map=u-… link. */
  async function boot(saved: string | null): Promise<void> {
    const params = new URLSearchParams(location.search), link = params.get('map');
    if (isUserMapId(link)) {
      params.delete('map');
      const qs = params.toString();
      history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}${location.hash}`);
      const got = await (await ui()).confirmAndFetch(link, { title: 'Open a user map?', lead: 'Someone shared a link to a map a player published.' });
      if (got) { d.applySim({ ...ctx.sim, mapId: got, courseId: '', spawnId: '' }); d.selected?.(got); }
      return;
    }
    if (saved && ctx.sim.mapId === 'field') {
      const um = await import('../net/userMaps');
      if (!(await um.cachedUserMaps()).some((m) => m.id === saved)) return; // removed from this device
      try {
        await um.fetchUserMap(saved);
        if (ctx.sim.mapId === 'field') { d.applySim({ ...ctx.sim, mapId: saved }); d.selected?.(saved); }
      } catch (e) { ctx.log(`User map ${saved} could not be restored: ${(e as Error)?.message ?? e}`); }
    }
  }

  // ---- "User map · not reviewed" over the HUD while flying one ----
  let banner: { el: HTMLElement; id: string } | null = null, loadingBanner = false;
  setInterval(() => {
    const id = ctx.map.id, on = isUserMapId(id) && !ctx.menuOpen;
    if (banner && banner.id !== id) { banner.el.remove(); banner = null; }
    if (banner) { banner.el.style.display = on ? '' : 'none'; return; }
    if (!on || loadingBanner) return;
    loadingBanner = true;
    void import('../ui/userMaps/banner').then((b) => {
      loadingBanner = false;
      if (ctx.map.id !== id) return;
      const e = MAP_LIST[id];
      banner = { id, el: b.userMapBanner({ id, name: e?.name ?? id, author: e?.community?.author ?? 'unknown' }) };
      document.body.append(banner.el);
    }, () => { loadingBanner = false; });
  }, 1000);

  return { offerRoomMap, boot };
}
