// Campaign reports: the results of every run reduced to what a reviewer reads — per variant, the
// requirement verdicts with their confidence bounds, metric distributions, how runs ended, the
// failure cases kept for re-flying, impact scatter and CEP for drop tasks, and (for a sweep) the
// Pareto front of the trade study. Output: JSON (everything), Markdown, and a self-contained HTML
// page. Pure functions over the run outcomes.
import { Campaign, evaluate, fmt, objectiveValue, pareto, summarize, Summary, Variant, Verdict, RunOutcome } from './campaign';

export interface CaseRef { variant: number; run: number; seed: number; reason: string; file: string; events: string[] }

export interface VariantReport {
  index: number; label: string; settings: Record<string, unknown>;
  runs: number;
  outcomes: Record<string, number>;
  verdicts: Verdict[];
  metrics: Record<string, Summary>;
  objectives: Record<string, number>;
  /** drop tasks: radial miss distances (m) */
  cep?: { cep50: number; cep90: number; r95: number; n: number; points: [number, number][] };
  cases: CaseRef[];
  wallS: number;
}

export interface CampaignReport {
  format: 'fpvsim-campaign-report'; version: 1;
  campaign: { name: string; description?: string; runs: number; seed: number; variants: number; pilot: string };
  generated: string; app: string; firmware: string;
  totals: { runs: number; wallS: number; simS: number; workers: number };
  variants: VariantReport[];
  pareto: number[];
  objectives: { metric: string; goal: 'min' | 'max' }[];
  /** worst verdict over every variant: what a CI gate should look at */
  verdict: 'pass' | 'fail' | 'inconclusive' | 'none';
}

const METRICS_SHOWN = ['flightS', 'energyWh', 'minCellV', 'maxTiltDeg', 'maxImpactMs', 'rmsErrorM', 'missM', 'bestLapS', 'distanceM', 'minLq', 'gnssLostS', 'maxPosErrM'];

export function buildReport(c: Campaign, vs: Variant[], results: { variant: number; outcome: RunOutcome; wallMs: number }[], cases: CaseRef[], meta: { app: string; firmware: string; workers: number; wallS: number }): CampaignReport {
  const variants: VariantReport[] = vs.map((v) => {
    const rs = results.filter((r) => r.variant === v.index);
    const outs = rs.map((r) => r.outcome);
    const outcomes: Record<string, number> = {};
    for (const o of outs) outcomes[o.reason] = (outcomes[o.reason] ?? 0) + 1;
    const keys = new Set<string>();
    for (const o of outs) for (const [k, x] of Object.entries(o.metrics)) if (typeof x === 'number') keys.add(k);
    const metrics: Record<string, Summary> = {};
    for (const k of keys) { const s = summarize(outs.map((o) => o.metrics[k]).filter((x): x is number => typeof x === 'number')); if (s) metrics[k] = s; }
    const objectives: Record<string, number> = {};
    for (const ob of c.objectives ?? []) objectives[ob.metric] = objectiveValue(outs, ob.metric);
    let cep: VariantReport['cep'];
    const task = v.scenario.task;
    if (task?.type === 'drop') {
      const pts = outs.filter((o) => typeof o.metrics.impactX === 'number').map((o) => [(o.metrics.impactX as number) - task.target[0], (o.metrics.impactY as number) - task.target[1]] as [number, number]);
      const radial = pts.map(([x, y]) => Math.hypot(x, y));
      const s = summarize(radial);
      if (s) cep = { cep50: s.p50, cep90: s.p90, r95: s.p95, n: s.n, points: pts.map(([x, y]) => [Math.round(x * 100) / 100, Math.round(y * 100) / 100]) };
    }
    return {
      index: v.index, label: v.label, settings: v.settings, runs: rs.length, outcomes,
      verdicts: (c.requirements ?? []).map((q) => evaluate(q, outs)), metrics, objectives, cep,
      cases: cases.filter((x) => x.variant === v.index), wallS: rs.reduce((a, r) => a + r.wallMs, 0) / 1000,
    };
  });
  const obj = c.objectives ?? [];
  const front = obj.length && variants.length > 1 ? pareto(variants.map((v) => obj.map((o) => v.objectives[o.metric])), obj.map((o) => o.goal)) : [];
  const all = variants.flatMap((v) => v.verdicts.map((x) => x.verdict));
  const verdict = !all.length ? 'none' : all.includes('fail') ? 'fail' : all.some((x) => x === 'inconclusive' || x === 'no data') ? 'inconclusive' : 'pass';
  const simS = results.reduce((a, r) => a + ((r.outcome.metrics.flightS as number) ?? 0), 0);
  return {
    format: 'fpvsim-campaign-report', version: 1,
    campaign: { name: c.meta?.name ?? c.meta?.id ?? 'campaign', description: c.meta?.description, runs: c.runs, seed: c.seed ?? 0, variants: vs.length, pilot: c.pilot?.type ?? 'reference' },
    generated: new Date().toISOString(), app: meta.app, firmware: meta.firmware,
    totals: { runs: results.length, wallS: meta.wallS, simS, workers: meta.workers },
    variants, pareto: front, objectives: obj, verdict,
  };
}

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

export function reportMarkdown(r: CampaignReport): string {
  const L: string[] = [];
  L.push(`# ${r.campaign.name}`, '');
  if (r.campaign.description) L.push(r.campaign.description, '');
  L.push(`**Verdict: ${r.verdict.toUpperCase()}** · ${r.totals.runs} runs (${r.campaign.variants} variant${r.campaign.variants > 1 ? 's' : ''} × ${r.campaign.runs}), ${(r.totals.simS / 3600).toFixed(2)} h simulated in ${(r.totals.wallS / 60).toFixed(1)} min on ${r.totals.workers} workers · seed ${r.campaign.seed} · pilot: ${r.campaign.pilot} · ${r.firmware} · ${r.app}`, '');
  if (r.pareto.length) {
    L.push('## Trade study', '', `Pareto-optimal variants for ${r.objectives.map((o) => `${o.goal} ${o.metric}`).join(', ')}:`, '');
    L.push(`| Variant | ${r.objectives.map((o) => o.metric).join(' | ')} | Pareto |`, `| --- | ${r.objectives.map(() => '---').join(' | ')} | --- |`);
    for (const v of r.variants) L.push(`| ${v.label} | ${r.objectives.map((o) => fmt(v.objectives[o.metric])).join(' | ')} | ${r.pareto.includes(v.index) ? '★' : ''} |`);
    L.push('');
  }
  for (const v of r.variants) {
    L.push(`## ${v.label || 'Results'}`, '');
    L.push(`Runs: ${v.runs} · ends: ${Object.entries(v.outcomes).map(([k, n]) => `${k} ${n}`).join(', ')}`, '');
    if (v.verdicts.length) {
      L.push('| Requirement | Metric | Measured | Verdict |', '| --- | --- | --- | --- |');
      for (const x of v.verdicts) L.push(`| ${x.id}${x.text ? ` ${x.text}` : ''} | ${x.metric} | ${x.measured} | ${x.verdict.toUpperCase()}${x.runsNeeded ? ` (≈ ${x.runsNeeded} runs would settle it)` : ''} |`);
      L.push('');
    }
    const ms = METRICS_SHOWN.filter((k) => v.metrics[k]);
    if (ms.length) {
      L.push('| Metric | mean | 95 % CI | p50 | p95 | min | max |', '| --- | --- | --- | --- | --- | --- | --- |');
      for (const k of ms) { const s = v.metrics[k]; L.push(`| ${k} | ${fmt(s.mean)} | ${fmt(s.ci95[0])} .. ${fmt(s.ci95[1])} | ${fmt(s.p50)} | ${fmt(s.p95)} | ${fmt(s.min)} | ${fmt(s.max)} |`); }
      L.push('');
    }
    if (v.cep) L.push(`Drop accuracy: CEP50 ${fmt(v.cep.cep50)} m, CEP90 ${fmt(v.cep.cep90)} m, R95 ${fmt(v.cep.r95)} m over ${v.cep.n} drops.`, '');
    if (v.cases.length) {
      L.push('Failure cases (re-fly exactly: `npm run campaign -- --case <file>`):', '');
      for (const k of v.cases) L.push(`- run ${k.run} (seed ${k.seed}): ${k.reason} — \`${k.file}\`${k.events.length ? ` — ${k.events.slice(0, 4).join('; ')}` : ''}`);
      L.push('');
    }
  }
  return L.join('\n');
}

/** A self-contained HTML report (no scripts, no external resources). */
export function reportHtml(r: CampaignReport): string {
  const badge = (v: string) => `<span class="b ${v.replace(' ', '')}">${esc(v.toUpperCase())}</span>`;
  const sections = r.variants.map((v) => {
    const ms = METRICS_SHOWN.filter((k) => v.metrics[k]);
    const total = Math.max(1, v.runs);
    const bars = Object.entries(v.outcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `<div class="bar"><span>${esc(k)}</span><i style="width:${(100 * n) / total}%"></i><b>${n}</b></div>`).join('');
    return `<section><h2>${esc(v.label || 'Results')}${r.pareto.includes(v.index) ? ' <span class="star">★ Pareto</span>' : ''}</h2>
<div class="outcomes">${bars}</div>
${v.verdicts.length ? `<table><tr><th>Requirement</th><th>Metric</th><th>Measured</th><th>Verdict</th></tr>${v.verdicts.map((x) => `<tr><td><b>${esc(x.id)}</b> ${esc(x.text ?? '')}</td><td>${esc(x.metric)}</td><td>${esc(x.measured)}</td><td>${badge(x.verdict)}${x.runsNeeded ? `<br><small>≈ ${x.runsNeeded} runs would settle it</small>` : ''}</td></tr>`).join('')}</table>` : ''}
${ms.length ? `<table><tr><th>Metric</th><th>mean</th><th>95 % CI</th><th>p50</th><th>p95</th><th>min</th><th>max</th></tr>${ms.map((k) => { const s = v.metrics[k]; return `<tr><td>${k}</td><td>${fmt(s.mean)}</td><td>${fmt(s.ci95[0])} … ${fmt(s.ci95[1])}</td><td>${fmt(s.p50)}</td><td>${fmt(s.p95)}</td><td>${fmt(s.min)}</td><td>${fmt(s.max)}</td></tr>`; }).join('')}</table>` : ''}
${v.cep ? cepSvg(v.cep) : ''}
${v.cases.length ? `<h3>Failure cases</h3><ul>${v.cases.map((k) => `<li>run ${k.run} (seed ${k.seed}): <b>${esc(k.reason)}</b> — <code>${esc(k.file)}</code><br><small>${esc(k.events.slice(0, 6).join(' · '))}</small></li>`).join('')}</ul>` : ''}
</section>`;
  }).join('\n');
  const trade = r.pareto.length ? `<section><h2>Trade study</h2><table><tr><th>Variant</th>${r.objectives.map((o) => `<th>${o.goal} ${esc(o.metric)}</th>`).join('')}<th></th></tr>${r.variants.map((v) => `<tr${r.pareto.includes(v.index) ? ' class="front"' : ''}><td>${esc(v.label)}</td>${r.objectives.map((o) => `<td>${fmt(v.objectives[o.metric])}</td>`).join('')}<td>${r.pareto.includes(v.index) ? '★' : ''}</td></tr>`).join('')}</table></section>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(r.campaign.name)}</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1f22;--mut:#6b7078;--line:#e3e4e6;--card:#fff;--ok:#1b7f4b;--bad:#b3261e;--warn:#9a6700;--acc:#2f5fd0}
@media (prefers-color-scheme:dark){:root{--bg:#141517;--fg:#e8e9eb;--mut:#9aa0a8;--line:#2b2d31;--card:#1b1c1f;--ok:#4cc38a;--bad:#ff6b5e;--warn:#e3b341;--acc:#7aa2ff}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px}
h1{margin:0 0 4px;font-size:26px}h2{font-size:19px;margin:0 0 12px}h3{font-size:15px}
.meta{color:var(--mut);margin-bottom:20px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin:16px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:10px 0;font-size:14px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mut);font-weight:600}
.b{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:700;color:#fff}
.b.pass{background:var(--ok)}.b.fail{background:var(--bad)}.b.inconclusive,.b.nodata,.b.none{background:var(--warn)}
.big{font-size:18px}.star{color:var(--acc);font-size:14px}tr.front td{font-weight:600}
.bar{display:grid;grid-template-columns:110px 1fr 48px;gap:8px;align-items:center;font-size:13px}
.bar i{display:block;height:10px;border-radius:5px;background:var(--acc)}.bar b{text-align:right}
code{font-size:12px}svg text{fill:var(--mut);font-size:11px}
</style></head><body><main>
<h1>${esc(r.campaign.name)}</h1>
<div class="meta">${r.campaign.description ? esc(r.campaign.description) + '<br>' : ''}${badge(r.verdict)} &nbsp;${r.totals.runs} runs (${r.campaign.variants} variant${r.campaign.variants > 1 ? 's' : ''} × ${r.campaign.runs}) · ${(r.totals.simS / 3600).toFixed(2)} h simulated in ${(r.totals.wallS / 60).toFixed(1)} min on ${r.totals.workers} workers · seed ${r.campaign.seed} · pilot ${esc(r.campaign.pilot)}<br>${esc(r.firmware)} · ${esc(r.app)} · ${esc(r.generated)}</div>
${trade}
${sections}
<p class="meta">Every run is reproducible from its seed: re-fly a case with <code>npm run campaign -- --case &lt;file&gt;</code>. Proportions use exact one-sided Clopper–Pearson bounds.</p>
</main></body></html>`;
}

function cepSvg(c: NonNullable<VariantReport['cep']>): string {
  const R = Math.max(1, c.r95 * 1.3, ...c.points.map(([x, y]) => Math.hypot(x, y))), S = 260, k = (S / 2 - 10) / R;
  const pts = c.points.map(([x, y]) => `<circle cx="${(S / 2 + x * k).toFixed(1)}" cy="${(S / 2 - y * k).toFixed(1)}" r="2.5" fill="currentColor" opacity="0.6"/>`).join('');
  const ring = (r: number, label: string, dash: string) => `<circle cx="${S / 2}" cy="${S / 2}" r="${(r * k).toFixed(1)}" fill="none" stroke="currentColor" stroke-dasharray="${dash}" opacity="0.7"/><text x="${S / 2 + r * k * 0.71 + 3}" y="${S / 2 - r * k * 0.71 - 3}">${label} ${fmt(r)} m</text>`;
  return `<h3>Drop accuracy (impact points around the target, north up)</h3><svg viewBox="0 0 ${S} ${S}" width="${S}" height="${S}" style="color:var(--acc)" role="img" aria-label="impact scatter"><line x1="${S / 2}" y1="0" x2="${S / 2}" y2="${S}" stroke="var(--line)"/><line x1="0" y1="${S / 2}" x2="${S}" y2="${S / 2}" stroke="var(--line)"/>${ring(c.cep50, 'CEP50', '')}${ring(c.cep90, 'CEP90', '4 3')}${pts}<circle cx="${S / 2}" cy="${S / 2}" r="3.5" fill="var(--bad)"/></svg>`;
}
