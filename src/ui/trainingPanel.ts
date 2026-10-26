// Settings → Training: drills with an adaptive curriculum (src/training/curriculum.ts). Pick a
// drill, fly attempts; the level rises after clean passes and drops after failures, and every
// attempt's metrics are kept for export (CSV / JSON) — for a pilot's own progress, an instructor,
// or a study. Loaded the first time the tab opens.
import { attemptsCsv, DRILLS } from '../training/curriculum';
import { trainingSession, SessionDeps } from '../training/session';
import { checkbox, el, onUnmount, section, select } from './dom';

const download = (text: string, name: string, type: string) => {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name }) as HTMLAnchorElement;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
};

export function trainingPanel(deps: SessionDeps): HTMLElement {
  const s = trainingSession(deps);
  const root = el('div', { class: 'panel training' });
  const body = el('div');
  const render = () => {
    const st = s.state, drill = s.drill, lv = s.level();
    const mine = st.attempts.filter((a) => a.drill === drill.id);
    const recent = mine.slice(-10).reverse();
    const passes = mine.filter((a) => a.outcome === 'pass').length;
    body.replaceChildren(
      section('Drill',
        select('Drill', DRILLS.map((d) => ({ value: d.id, label: `${d.name} (level ${((st.levels[d.id] ?? 0) * 100).toFixed(0)} %)` })), drill.id, (v) => { if (s.running) s.stop(); st.drill = v; s.save(); render(); }),
        el('p', {}, drill.blurb),
        el('div', { class: 'level', role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(lv * 100), 'aria-label': 'Level' },
          el('i', { style: { width: `${(lv * 100).toFixed(1)}%` } })),
        el('p', { class: 'note' }, `Level ${(lv * 100).toFixed(0)} %: ${drill.describe(lv)}`),
        checkbox('Adapt the level to how I fly (up after a clean pass, down after a failure)', st.adaptive, (v) => { st.adaptive = v; s.save(); }),
        checkbox('Start the next attempt by itself', st.auto, (v) => { st.auto = v; s.save(); }),
        el('div', { class: 'actions' },
          el('button', { type: 'button', class: 'primary', onclick: () => void s.start().catch(() => render()) }, s.running ? 'Restart the attempt' : 'Start training'),
          s.running ? el('button', { type: 'button', onclick: () => s.stop() }, 'Stop') : null)),
      section(`Attempts (${mine.length}, ${passes} passed)`,
        recent.length ? el('table', { class: 'kv attempts' },
          el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Level'), el('th', {}, 'Result'), el('th', {}, 'Error'), el('th', {}, 'Time')),
          ...recent.map((a) => el('tr', { class: a.outcome },
            el('td', {}, new Date(a.at).toLocaleTimeString()),
            el('td', {}, `${(a.level * 100).toFixed(0)} → ${(a.next * 100).toFixed(0)}`),
            el('td', {}, `${a.outcome}${a.reason !== 'success' ? ` (${a.reason.replace(/_/g, ' ')})` : ''}`),
            el('td', {}, a.error.toFixed(2)),
            el('td', {}, a.metrics.lapTimesS?.length ? `${a.metrics.lapTimesS[0].toFixed(2)} s lap` : `${a.metrics.elapsedS.toFixed(1)} s`)))) : el('p', { class: 'note' }, 'No attempts yet.'),
        el('div', { class: 'actions' },
          el('button', { type: 'button', disabled: !st.attempts.length, onclick: () => download(attemptsCsv(st.attempts), 'fpv-sim-training.csv', 'text/csv') }, 'Export CSV'),
          el('button', { type: 'button', disabled: !st.attempts.length, onclick: () => download(JSON.stringify(st, null, 1), 'fpv-sim-training.json', 'application/json') }, 'Export JSON'),
          el('button', { type: 'button', disabled: !mine.length, onclick: () => s.clearProgress(drill.id) }, 'Reset this drill'))),
      section('How the level works',
        el('p', {}, 'Each level sets the drill\'s difficulty: a smaller box and a longer hold, more wind, a faster target lap. A clean pass — an error below a quarter of what the level allows — raises it by 2.5 to 5 %, the cleaner the more; a pass that was only just made keeps it; a crash, a timeout or a missed gate lowers it by 5 %. This is the curriculum rule HyperDrone uses to train its policies, applied to a pilot. Scenario files for every drill and level run in the headless simulator too, so pilots and policies can be compared on the same tasks.')),
    );
  };
  s.onChange = () => { if (root.isConnected) render(); };
  onUnmount(root, () => { if (s.onChange) s.onChange = null; });
  render();
  root.append(body);
  return root;
}
