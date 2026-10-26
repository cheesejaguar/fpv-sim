// Verification campaigns (format "fpvsim-campaign", version 1): many seeded episodes of a scenario,
// flown by a pilot (the reference autopilot, or the developer's own controller), over variants of
// the design (a sweep), scored against written requirements with statistical confidence.
//   - Every run is a pure function of (scenario variant, seed, pilot, firmware build): a failure
//     found in run 4,817 of a 10,000-run campaign is re-flown bit for bit from its case file.
//   - Proportion requirements ("succeeds in at least 95 % of runs, at 90 % confidence") are judged
//     on the exact (Clopper–Pearson) bound, not the point estimate: too few runs gives
//     "inconclusive" with the number of runs that would settle it.
//   - Statistic requirements ("95th percentile miss distance under 3 m") on any run metric.
//   - A sweep crosses design choices (battery, motor, payload mass, jammer power...) and the report
//     marks the Pareto-optimal variants for the campaign's objectives: a trade study with the real
//     firmware in the loop.
// Pure: no I/O. The runner (runner.ts) flies the episodes; scripts/fpv-campaign.mjs runs them in
// parallel and writes the reports (report.ts).
import { parseScenario, Scenario } from '../scenario/scenario';
import { subSeed } from '../sim/math';
import type { PilotParams } from './pilot';

export const CAMPAIGN_FORMAT = 'fpvsim-campaign';

export type PilotSpec =
  | ({ type: 'reference' } & Omit<PilotParams, 'hoverThrottle'>)
  /** an ES module exporting createPilot(info) -> { act(obs) -> action | { action, release } } (path relative to the campaign file) */
  | { type: 'module'; path: string; options?: unknown }
  /** no pilot: sticks centred, throttle at hover (faults on a passive quad, link and GNSS surveys) */
  | { type: 'none' };

export interface Requirement {
  id: string;
  text?: string;
  /** a run metric (runner.ts RunMetrics) or "reason=<end reason>" */
  metric: string;
  /** proportion requirement: the share of runs where the metric holds, compared with value at confidence */
  rate?: '>=' | '<=';
  /** statistic requirement: this statistic of the metric over the runs, compared with value */
  stat?: 'mean' | 'p50' | 'p90' | 'p95' | 'p99' | 'max' | 'min';
  op?: '<=' | '>=';
  value: number;
  /** one-sided confidence for proportion requirements (default 0.9) */
  confidence?: number;
  /** only the runs that succeeded (e.g. the miss distance of drops that happened) */
  where?: 'all' | 'success';
}

export interface Campaign {
  format: typeof CAMPAIGN_FORMAT;
  version: 1;
  meta?: { id?: string; name?: string; description?: string; author?: string };
  scenario: Scenario;
  /** runs per variant */
  runs: number;
  seed?: number;
  pilot?: PilotSpec;
  /** design sweep: scenario JSON paths -> values; every combination is a variant */
  sweep?: Record<string, unknown[]>;
  requirements?: Requirement[];
  /** trade-study objectives over variants: a metric's mean (or a rate) to minimise or maximise */
  objectives?: { metric: string; goal: 'min' | 'max' }[];
  /** keep this many failed runs per variant as case files with a trace (default 5) */
  saveFailures?: number;
}

export interface Variant { index: number; label: string; settings: Record<string, unknown>; scenario: Scenario }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Check a campaign; its scenario (and every sweep variant of it) must be valid. */
export function parseCampaign(raw: unknown, hasMap?: (id: string) => boolean): { campaign: Campaign | null; errors: string[] } {
  const errors: string[] = [];
  const err = (e: string) => errors.push(e);
  if (!isObj(raw)) return { campaign: null, errors: ['a campaign is a JSON object'] };
  for (const k of Object.keys(raw)) if (!['$schema', 'format', 'version', 'meta', 'scenario', 'runs', 'seed', 'pilot', 'sweep', 'requirements', 'objectives', 'saveFailures'].includes(k)) err(`${k}: unknown key`);
  if (raw.format !== CAMPAIGN_FORMAT) err(`format: expected "${CAMPAIGN_FORMAT}"`);
  if (raw.version !== 1) err('version: this simulator reads version 1');
  if (!(Number.isInteger(raw.runs) && (raw.runs as number) >= 1 && (raw.runs as number) <= 1e6)) err('runs: 1 .. 1000000');
  if (raw.seed !== undefined && !(Number.isInteger(raw.seed) && (raw.seed as number) >= 0 && (raw.seed as number) < 2 ** 32)) err('seed: an integer 0 .. 2^32-1');
  if (raw.saveFailures !== undefined && !(Number.isInteger(raw.saveFailures) && (raw.saveFailures as number) >= 0)) err('saveFailures: an integer >= 0');
  const p = raw.pilot;
  if (p !== undefined) {
    if (!isObj(p) || !['reference', 'module', 'none'].includes(p.type as string)) err('pilot.type: reference, module or none');
    else if (p.type === 'module' && typeof p.path !== 'string') err('pilot.path: the controller module');
    else if (p.type === 'reference') {
      for (const k of Object.keys(p)) if (!['type', 'navigation', 'cruiseMs', 'maxTiltDeg', 'cruiseAglM', 'angleLimitDeg'].includes(k)) err(`pilot.${k}: unknown key`);
      if (p.navigation !== undefined && p.navigation !== 'truth' && p.navigation !== 'gnss') err('pilot.navigation: truth or gnss');
    }
  }
  if (raw.sweep !== undefined) {
    if (!isObj(raw.sweep)) err('sweep: expected { "path.in.scenario": [values] }');
    else for (const [k, v] of Object.entries(raw.sweep)) if (!(Array.isArray(v) && v.length >= 1)) err(`sweep.${k}: a non-empty list of values`);
  }
  if (raw.requirements !== undefined) {
    if (!Array.isArray(raw.requirements)) err('requirements: a list');
    else raw.requirements.forEach((r, i) => {
      const q = `requirements[${i}]`;
      if (!isObj(r)) { err(`${q}: an object`); return; }
      if (typeof r.id !== 'string') err(`${q}.id: text`);
      if (typeof r.metric !== 'string') err(`${q}.metric: a run metric`);
      if (typeof r.value !== 'number') err(`${q}.value: a number`);
      if ((r.rate === undefined) === (r.stat === undefined)) err(`${q}: give either rate (">=" / "<=") or stat with op`);
      if (r.rate !== undefined && r.rate !== '>=' && r.rate !== '<=') err(`${q}.rate: ">=" or "<="`);
      if (r.stat !== undefined && !['mean', 'p50', 'p90', 'p95', 'p99', 'max', 'min'].includes(r.stat as string)) err(`${q}.stat: mean, p50, p90, p95, p99, max or min`);
      if (r.stat !== undefined && r.op !== '<=' && r.op !== '>=') err(`${q}.op: "<=" or ">="`);
      if (r.confidence !== undefined && !(typeof r.confidence === 'number' && r.confidence > 0 && r.confidence < 1)) err(`${q}.confidence: 0 .. 1`);
    });
  }
  if (raw.objectives !== undefined && !(Array.isArray(raw.objectives) && raw.objectives.every((o) => isObj(o) && typeof o.metric === 'string' && (o.goal === 'min' || o.goal === 'max')))) err('objectives: a list of { metric, goal: "min" | "max" }');
  if (errors.length) return { campaign: null, errors };
  const c = raw as unknown as Campaign;
  for (const v of variants(c)) {
    const r = parseScenario(v.scenario, hasMap);
    if (!r.scenario) for (const e of r.errors) err(`scenario${v.label ? ` (${v.label})` : ''}: ${e}`);
    if (errors.length > 20) break;
  }
  return { campaign: errors.length ? null : c, errors };
}

/** Set a dotted path in an object, creating objects on the way ("drone.spec.battery"). */
export function setPath(o: Record<string, unknown>, path: string, v: unknown) {
  const keys = path.split('.');
  let cur: Record<string, unknown> = o;
  for (const k of keys.slice(0, -1)) {
    const nx = /^\d+$/.test(k) && Array.isArray(cur) ? (cur as unknown as unknown[])[Number(k)] : cur[k];
    if (typeof nx !== 'object' || nx === null) cur[k] = {};
    cur = (Array.isArray(cur) && /^\d+$/.test(k) ? (cur as unknown as unknown[])[Number(k)] : cur[k]) as Record<string, unknown>;
  }
  const last = keys[keys.length - 1];
  if (Array.isArray(cur) && /^\d+$/.test(last)) (cur as unknown[])[Number(last)] = v; else cur[last] = v;
}

/** Every combination of the sweep, applied to the scenario (one variant without a sweep). */
export function variants(c: Campaign): Variant[] {
  const keys = Object.keys(c.sweep ?? {});
  const out: Variant[] = [];
  const n = keys.reduce((a, k) => a * c.sweep![k].length, 1);
  for (let i = 0; i < n; i++) {
    const settings: Record<string, unknown> = {};
    let r = i;
    for (let j = keys.length - 1; j >= 0; j--) { const vals = c.sweep![keys[j]]; settings[keys[j]] = vals[r % vals.length]; r = Math.floor(r / vals.length); }
    const sc = structuredClone(c.scenario) as unknown as Record<string, unknown>;
    for (const k of keys) setPath(sc, k, structuredClone(settings[k]));
    const label = keys.map((k) => `${k.split('.').pop()}=${typeof settings[k] === 'object' ? JSON.stringify(settings[k]) : String(settings[k])}`).join(', ');
    out.push({ index: i, label, settings, scenario: sc as unknown as Scenario });
  }
  return out;
}

/** The seed of run k of variant v: the same run of every variant sees the same conditions (common random numbers). */
export const runSeed = (c: Campaign, _variant: number, run: number) => subSeed(c.seed ?? 0, run);

// ---- statistics ----

/** ln Γ(x) (Lanczos). */
function lnGamma(x: number): number {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

/** Regularised incomplete beta I_x(a, b) (continued fraction, Numerical Recipes betacf). */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  const cf = (x: number, a: number, b: number) => {
    const qab = a + b, qap = a + 1, qam = a - 1;
    let c = 1, d = 1 - (qab * x) / qap;
    if (Math.abs(d) < 1e-300) d = 1e-300;
    d = 1 / d;
    let h = d;
    for (let m = 1; m <= 300; m++) {
      const m2 = 2 * m;
      let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300; c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; h *= d * c;
      aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300; c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d;
      const del = d * c; h *= del;
      if (Math.abs(del - 1) < 3e-14) break;
    }
    return h;
  };
  return x < (a + 1) / (a + b + 2) ? (bt * cf(x, a, b)) / a : 1 - (bt * cf(1 - x, b, a)) / b;
}

/** Quantile of the Beta(a, b) distribution (bisection on betaInc). */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0, hi = 1;
  for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; if (betaInc(m, a, b) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

/** Exact (Clopper–Pearson) one-sided bounds on a proportion: k of n, at confidence conf. */
export function clopperPearson(k: number, n: number, conf: number): { lower: number; upper: number } {
  const a = 1 - conf;
  return { lower: k === 0 ? 0 : betaQuantile(a, k, n - k + 1), upper: k === n ? 1 : betaQuantile(1 - a, k + 1, n - k) };
}

/** Runs needed to show a rate >= p at confidence conf with no failures (the "rule of three" generalised). */
export const runsForZeroFailures = (p: number, conf: number) => Math.ceil(Math.log(1 - conf) / Math.log(p));

/** Linear-interpolated quantile of sorted values. */
export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

export interface Summary { n: number; mean: number; sd: number; ci95: [number, number]; min: number; p50: number; p90: number; p95: number; p99: number; max: number }

export function summarize(xs: number[]): Summary | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const n = v.length, mean = v.reduce((a, x) => a + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const h = (1.96 * sd) / Math.sqrt(n);
  return { n, mean, sd, ci95: [mean - h, mean + h], min: v[0], p50: quantile(v, 0.5), p90: quantile(v, 0.9), p95: quantile(v, 0.95), p99: quantile(v, 0.99), max: v[n - 1] };
}

// ---- requirements ----

/** What a run contributes: its metrics (numbers and flags) and its end reason. */
export interface RunOutcome { reason: string; success: boolean; metrics: Record<string, number | boolean | null> }

/** A run's value of a metric: a number, a flag, or null when it doesn't have it. */
export function metricOf(r: RunOutcome, metric: string): number | boolean | null {
  if (metric.startsWith('reason=')) return r.reason === metric.slice(7);
  if (metric === 'success') return r.success;
  const v = r.metrics[metric];
  return v === undefined ? null : v;
}

export interface Verdict {
  id: string; text?: string; metric: string;
  verdict: 'pass' | 'fail' | 'inconclusive' | 'no data';
  /** what was measured, in words */
  measured: string;
  n: number;
  estimate: number | null;
  bound?: number;
  /** proportion requirements: runs that would settle an inconclusive verdict (if no more failures) */
  runsNeeded?: number;
}

export function evaluate(req: Requirement, runs: RunOutcome[]): Verdict {
  const pool = req.where === 'success' ? runs.filter((r) => r.success) : runs;
  const base = { id: req.id, text: req.text, metric: req.metric };
  if (req.rate) {
    const vals = pool.map((r) => metricOf(r, req.metric)).filter((v) => v !== null);
    const n = vals.length, k = vals.filter((v) => (typeof v === 'boolean' ? v : (v as number) !== 0)).length;
    if (!n) return { ...base, verdict: 'no data', measured: 'no runs with this metric', n: 0, estimate: null };
    const conf = req.confidence ?? 0.9, cp = clopperPearson(k, n, conf), est = k / n;
    const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
    if (req.rate === '>=') {
      const verdict = cp.lower >= req.value ? 'pass' : cp.upper < req.value ? 'fail' : 'inconclusive';
      // with no more failures, n' such that the lower bound reaches the value (search)
      let runsNeeded: number | undefined;
      if (verdict === 'inconclusive') { let m = n; while (m < 1e7 && clopperPearson(k + (m - n), m, conf).lower < req.value) m = Math.ceil(m * 1.25) + 1; runsNeeded = m; }
      return { ...base, verdict, measured: `${k}/${n} = ${pct(est)} (≥ ${pct(cp.lower)} at ${pct(conf)} confidence)`, n, estimate: est, bound: cp.lower, runsNeeded };
    }
    const verdict = cp.upper <= req.value ? 'pass' : cp.lower > req.value ? 'fail' : 'inconclusive';
    let runsNeeded: number | undefined;
    if (verdict === 'inconclusive') { let m = n; while (m < 1e7 && clopperPearson(k, m, conf).upper > req.value) m = Math.ceil(m * 1.25) + 1; runsNeeded = m; }
    return { ...base, verdict, measured: `${k}/${n} = ${pct(est)} (≤ ${pct(cp.upper)} at ${pct(conf)} confidence)`, n, estimate: est, bound: cp.upper, runsNeeded };
  }
  const xs = pool.map((r) => metricOf(r, req.metric)).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  const s = summarize(xs);
  if (!s) return { ...base, verdict: 'no data', measured: 'no runs with this metric', n: 0, estimate: null };
  const est = s[req.stat!];
  const ok = req.op === '<=' ? est <= req.value : est >= req.value;
  return { ...base, verdict: ok ? 'pass' : 'fail', measured: `${req.stat} = ${fmt(est)} over ${s.n} runs`, n: s.n, estimate: est };
}

export const fmt = (x: number) => (Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2));

/** Indices of the variants no other variant beats on every objective (and strictly on one). */
export function pareto(points: number[][], goals: ('min' | 'max')[]): number[] {
  const better = (a: number[], b: number[]) => goals.every((g, i) => (g === 'min' ? a[i] <= b[i] : a[i] >= b[i])) && goals.some((g, i) => (g === 'min' ? a[i] < b[i] : a[i] > b[i]));
  return points.map((p, i) => (p.some((x) => !Number.isFinite(x)) || points.some((q, j) => j !== i && !q.some((x) => !Number.isFinite(x)) && better(q, p)) ? -1 : i)).filter((i) => i >= 0);
}

/** The value of an objective for a variant: a rate for flags, the mean for numbers. */
export function objectiveValue(runs: RunOutcome[], metric: string): number {
  const vals = runs.map((r) => metricOf(r, metric)).filter((v) => v !== null);
  if (!vals.length) return NaN;
  if (vals.every((v) => typeof v === 'boolean')) return vals.filter(Boolean).length / vals.length;
  const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length ? nums.reduce((a, x) => a + x, 0) / nums.length : NaN;
}
