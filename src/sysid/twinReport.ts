// The sim-to-real gap report of a digital-twin run (twin.ts): Markdown and a self-contained HTML
// page, per axis how the simulated flight differs from the logged one, before and after the fit.
import type { FitResult, GapReport } from './twin';

const f = (x: number, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '–');
const pct = (a: number, b: number) => (b ? `${((a / b - 1) * 100 >= 0 ? '+' : '')}${((a / b - 1) * 100).toFixed(0)} %` : '–');

/** What the motor levels say, in words. */
export function thrustNote(g: GapReport): string {
  const r = g.motorMean.real, s = g.motorMean.sim;
  if (!r) return '';
  const d = s / r - 1;
  if (Math.abs(d) < 0.04) return 'Motor levels agree: thrust against weight matches.';
  return d < 0
    ? `The simulated drone flew the same profile on ${f(-d * 100, 0)} % less motor output: the real one is heavier, or its props or motors deliver less, than the build says.`
    : `The simulated drone needed ${f(d * 100, 0)} % more motor output: the real one is lighter, or its props or motors deliver more, than the build says.`;
}

function axisRows(g: GapReport): string[][] {
  return (['roll', 'pitch', 'yaw'] as const).map((k) => {
    const a = g.axes[k];
    return [k, f(a.gyroErrRms), f(a.corr, 3), `${f(a.trackRms.real)} / ${f(a.trackRms.sim)}`, `${a.lagMs.real} / ${a.lagMs.sim}`, `${f(a.noiseRms.real, 2)} / ${f(a.noiseRms.sim, 2)}`, `${f(a.effortErrRms)} of ${f(a.effortRms)}`];
  });
}
const HEAD = ['Axis', 'Gyro error (deg/s RMS)', 'Correlation', 'Tracking error real / sim (deg/s)', 'Delay real / sim (ms)', 'Noise real / sim (deg/s)', 'Effort error (of real)'];

export function twinMarkdown(o: { log: string; spec: string; gap: GapReport; fit?: FitResult; cliErrors: string[] }): string {
  const L: string[] = ['# Sim-to-real gap report', '', `Log: \`${o.log}\` · build: ${o.spec} · compared ${f(o.gap.seconds)} s (log ${f(o.gap.segment.fromS)}–${f(o.gap.segment.toS)} s)`, ''];
  const table = (g: GapReport) => [`| ${HEAD.join(' | ')} |`, `| ${HEAD.map(() => '---').join(' | ')} |`, ...axisRows(g).map((r) => `| ${r.join(' | ')} |`)];
  L.push('## The build as specified', '', ...table(o.gap), '', `Motor output: real ${f(o.gap.motorMean.real * 100)} %, simulated ${f(o.gap.motorMean.sim * 100)} %. ${thrustNote(o.gap)}`, '', `Cost ${f(o.gap.cost, 4)}.`, '');
  if (o.fit) {
    const fit = o.fit;
    L.push('## Fitted twin', '', `Overrides: ${Object.entries(fit.overrides).map(([k, v]) => `\`${k}\` ${f(v as number, 3)}`).join(', ')} (${fit.evals} simulated flights)`, '', ...table(fit.after), '', `Cost ${f(fit.before.cost, 4)} → ${f(fit.after.cost, 4)} (${pct(fit.after.cost, fit.before.cost)}).`, '');
  }
  if (o.cliErrors.length) L.push('## Settings the simulator did not take', '', ...o.cliErrors.map((e) => `- \`${e}\``), '');
  L.push('Method: the log\'s sticks were flown through the same Betaflight build high above the ground, and the simulator\'s own blackbox log was compared with the real one (gyro and controller effort below ~40 / 10 Hz, aligned on the setpoint). See docs/DIGITAL_TWIN.md.');
  return L.join('\n') + '\n';
}

export function twinHtml(o: { log: string; spec: string; gap: GapReport; fit?: FitResult; cliErrors: string[] }): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const table = (g: GapReport) => `<table><tr>${HEAD.map((h) => `<th>${h}</th>`).join('')}</tr>${axisRows(g).map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</table>`;
  const fit = o.fit;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sim-to-real gap</title>
<style>:root{--bg:#fbfbfa;--fg:#1d1f22;--mut:#6b7078;--line:#e3e4e6;--card:#fff;--acc:#2f5fd0}@media (prefers-color-scheme:dark){:root{--bg:#141517;--fg:#e8e9eb;--mut:#9aa0a8;--line:#2b2d31;--card:#1b1c1f;--acc:#7aa2ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1000px;margin:0 auto;padding:24px 16px}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--mut)}.mut{color:var(--mut)}code{font-size:13px}</style></head><body><main>
<h1>Sim-to-real gap report</h1><p class="mut">Log <code>${esc(o.log)}</code> · build ${esc(o.spec)} · ${f(o.gap.seconds)} s compared (log ${f(o.gap.segment.fromS)}–${f(o.gap.segment.toS)} s)</p>
<section><h2>The build as specified</h2>${table(o.gap)}<p>Motor output: real ${f(o.gap.motorMean.real * 100)} %, simulated ${f(o.gap.motorMean.sim * 100)} %. ${esc(thrustNote(o.gap))}</p><p class="mut">Cost ${f(o.gap.cost, 4)}</p></section>
${fit ? `<section><h2>Fitted twin</h2><p>${Object.entries(fit.overrides).map(([k, v]) => `<code>${esc(k)}</code> ${f(v as number, 3)}`).join(' · ')} <span class="mut">(${fit.evals} simulated flights)</span></p>${table(fit.after)}<p class="mut">Cost ${f(fit.before.cost, 4)} → ${f(fit.after.cost, 4)} (${pct(fit.after.cost, fit.before.cost)})</p></section>` : ''}
${o.cliErrors.length ? `<section><h2>Settings the simulator did not take</h2><ul>${o.cliErrors.map((e) => `<li><code>${esc(e)}</code></li>`).join('')}</ul></section>` : ''}
<p class="mut">The log's sticks were flown through the same Betaflight build high above the ground, and the simulator's own blackbox log compared with the real one (gyro and controller effort below ~40 / 10 Hz, aligned on the setpoint).</p></main></body></html>`;
}
