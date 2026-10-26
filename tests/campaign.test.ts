// Verification campaigns (src/campaign/): exact confidence bounds, requirement verdicts, sweep
// expansion and the Pareto front, the reference autopilot on a real mission, and reproducible runs.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { betaInc, clopperPearson, evaluate, pareto, parseCampaign, quantile, runSeed, runsForZeroFailures, RunOutcome, variants } from '../src/campaign/campaign';
import { buildReport, reportHtml, reportMarkdown } from '../src/campaign/report';
import { runEpisode } from '../src/campaign/runner';
import { createNodeEnv } from '../src/headless/node';
import { MAPS } from '../src/maps/maps';

const have = existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url));
const out = (success: boolean, metrics: RunOutcome['metrics'] = {}): RunOutcome => ({ reason: success ? 'success' : 'crash', success, metrics });

describe('statistics', () => {
  test('incomplete beta and Clopper-Pearson match closed forms', () => {
    expect(betaInc(0.3, 1, 1)).toBeCloseTo(0.3, 10);
    expect(betaInc(0.5, 2, 2)).toBeCloseTo(0.5, 10);
    // no failures in n: the lower bound is (1 - conf)^(1/n); no successes: the upper is 1 - (1 - conf)^(1/n)
    expect(clopperPearson(20, 20, 0.95).lower).toBeCloseTo(Math.pow(0.05, 1 / 20), 6);
    expect(clopperPearson(0, 10, 0.95).upper).toBeCloseTo(1 - Math.pow(0.05, 1 / 10), 6);
    // a tabulated value: 7 of 10, one-sided 95 % lower bound 0.3933
    expect(clopperPearson(7, 10, 0.95).lower).toBeCloseTo(0.3933, 3);
    expect(runsForZeroFailures(0.95, 0.95)).toBe(59); // the rule of three, exactly
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.95)).toBeCloseTo(9.5, 10);
  });

  test('verdicts: pass on the bound, fail when the bound says so, inconclusive in between with the runs that would settle it', () => {
    const req = { id: 'R', metric: 'success', rate: '>=' as const, value: 0.9, confidence: 0.9 };
    expect(evaluate(req, Array.from({ length: 30 }, () => out(true))).verdict).toBe('pass');
    const mid = evaluate(req, Array.from({ length: 10 }, () => out(true)));
    expect(mid.verdict).toBe('inconclusive');
    expect(mid.runsNeeded).toBeGreaterThanOrEqual(22);
    expect(evaluate(req, Array.from({ length: 20 }, (_, i) => out(i < 10))).verdict).toBe('fail');
    const miss = { id: 'M', metric: 'missM', stat: 'p95' as const, op: '<=' as const, value: 2, where: 'success' as const };
    const runs = [...Array.from({ length: 19 }, (_, i) => out(true, { missM: i / 10 })), out(false, { missM: 50 })];
    expect(evaluate(miss, runs)).toMatchObject({ verdict: 'pass', n: 19 });
    expect(evaluate({ ...miss, where: 'all' }, runs).verdict).toBe('fail');
    expect(evaluate({ id: 'C', metric: 'crashed', rate: '<=', value: 0.5 }, [out(true, { crashed: false })]).verdict).toBe('inconclusive');
    expect(evaluate({ id: 'X', metric: 'nothing', stat: 'mean', op: '<=', value: 1 }, runs).verdict).toBe('no data');
  });

  test('Pareto front', () => {
    // minimise energy, maximise success
    const pts = [[1, 0.5], [2, 0.9], [3, 0.9], [1.5, 0.4], [0.5, 0.1]];
    expect(pareto(pts, ['min', 'max'])).toEqual([0, 1, 4]);
  });
});

describe('campaign files', () => {
  test('the example campaigns are valid; a sweep makes every combination with common seeds', () => {
    for (const f of readdirSync('campaigns')) {
      const r = parseCampaign(JSON.parse(readFileSync(`campaigns/${f}`, 'utf8')), (id) => id in MAPS);
      expect(r.errors, f).toEqual([]);
    }
    const c = parseCampaign(JSON.parse(readFileSync('campaigns/battery-trade.json', 'utf8'))).campaign!;
    const vs = variants(c);
    expect(vs.length).toBe(6);
    expect(vs[5].label).toBe('battery=b6s1p-p45b, massG=400');
    expect(vs[5].scenario.drone!.spec!.battery).toBe('b6s1p-p45b');
    expect(vs[5].scenario.ops!.payload!.massG).toBe(400);
    expect(c.scenario.ops!.payload!.massG).toBe(300); // the campaign's own scenario is untouched
    expect(runSeed(c, 0, 3)).toBe(runSeed(c, 5, 3));
    expect(runSeed(c, 0, 3)).not.toBe(runSeed(c, 0, 4));
  });

  test('problems are named', () => {
    const bad = parseCampaign({ format: 'fpvsim-campaign', version: 1, runs: 0, scenario: { format: 'fpvsim-scenario', version: 1, map: { id: 'nowhere' } }, requirements: [{ id: 'a', metric: 'm', value: 1 }] }, (id) => id in MAPS);
    expect(bad.errors).toContain('runs: 1 .. 1000000');
    expect(bad.errors.join('\n')).toMatch(/either rate/);
  });

  test('reports: Markdown and self-contained HTML', () => {
    const c = parseCampaign(JSON.parse(readFileSync('campaigns/delivery-drop.json', 'utf8'))).campaign!;
    const vs = variants(c);
    const results = Array.from({ length: 12 }, (_, i) => ({ variant: 0, outcome: out(i !== 3, { missM: 0.2 * i, impactX: -10 + 0.1 * i, impactY: 0.05 * i, flightS: 10, crashed: i === 3 }), wallMs: 100 }));
    const rep = buildReport(c, vs, results, [{ variant: 0, run: 3, seed: 1, reason: 'crash', file: 'cases/v0-r3.json', events: ['2.00 s impact 5.0 m/s'] }], { app: 'test', firmware: 'bf', workers: 2, wallS: 1 });
    expect(rep.variants[0].cep!.n).toBe(12);
    expect(rep.variants[0].verdicts.map((v) => v.id)).toEqual(['DEL-1', 'DEL-2', 'DEL-3', 'DEL-4']);
    const md = reportMarkdown(rep), html = reportHtml(rep);
    expect(md).toMatch(/CEP50/);
    expect(md).toMatch(/cases\/v0-r3\.json/);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script|https?:\/\//);
  });
});

describe.skipIf(!have)('runs (real Betaflight)', () => {
  test('the reference autopilot delivers a parcel, and a run repeats exactly from its seed', async () => {
    const c = parseCampaign(JSON.parse(readFileSync('campaigns/delivery-drop.json', 'utf8'))).campaign!;
    const env = await createNodeEnv();
    const a = await runEpisode(env, c.scenario, runSeed(c, 0, 1), c.pilot!);
    expect(a.outcome.reason).toBe('success');
    expect(a.outcome.metrics.missM).toBeLessThan(3);
    expect(a.outcome.metrics.payloadReleased).toBe(true);
    const b = await runEpisode(env, c.scenario, runSeed(c, 0, 1), c.pilot!);
    expect(b.outcome).toEqual(a.outcome);
  }, 180000);
});
