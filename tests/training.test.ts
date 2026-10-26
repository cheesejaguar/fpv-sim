// Training drills and the adaptive curriculum: the level rule, every drill's scenario at every
// level is a valid scenario file that runs headless, attempts are judged from task metrics, and the
// export carries every attempt.
import { existsSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { createNodeEnv } from '../src/headless/node';
import { MAPS } from '../src/maps/maps';
import { parseScenario } from '../src/scenario/scenario';
import type { TaskMetrics } from '../src/scenario/tasks';
import { adapt, attemptsCsv, courseLength, DRILLS, drillById, hoverMarker, newTrainingState, PASS_ERROR, recordAttempt, STEP_DOWN, STEP_MAX, STEP_MIN } from '../src/training/curriculum';

const hasMap = (id: string) => id in MAPS;
const metrics = (o: Partial<TaskMetrics>): TaskMetrics => ({ type: 'hover', elapsedS: 10, success: false, progress: 0, return: 0, distanceM: 0, maxSpeedMs: 0, ...o });

describe('level rule', () => {
  test('a clean pass moves up by 2.5 to 5 %, cleaner further; a failure moves down 5 %; a bare pass holds', () => {
    expect(adapt(0.5, 'pass', 0)).toBeCloseTo(0.5 + STEP_MAX, 9);
    expect(adapt(0.5, 'pass', PASS_ERROR)).toBeCloseTo(0.5 + STEP_MIN, 9);
    expect(adapt(0.5, 'pass', 0.9)).toBeCloseTo(0.5 + STEP_MIN, 9);
    const mid = adapt(0.5, 'pass', 0.15) - 0.5;
    expect(mid).toBeGreaterThan(STEP_MIN); expect(mid).toBeLessThan(STEP_MAX);
    expect(adapt(0.5, 'hold', 0.3)).toBe(0.5);
    expect(adapt(0.5, 'fail', 1)).toBeCloseTo(0.5 - STEP_DOWN, 9);
    expect(adapt(0.99, 'pass', 0)).toBe(1);
    expect(adapt(0.01, 'fail', 1)).toBe(0);
  });
});

describe('drills', () => {
  test.each(DRILLS.map((d) => [d.id, d] as const))('%s: valid scenarios at every level, harder as the level rises', (_id, d) => {
    for (const lv of [0, 0.37, 1]) {
      const { errors } = parseScenario(d.scenario(lv), hasMap);
      expect(errors, `${d.id} @ ${lv}`).toEqual([]);
      expect(d.describe(lv)).toMatch(/\d/);
    }
    const t0 = d.scenario(0).task!, t1 = d.scenario(1).task!;
    if (t0.type === 'hover' && t1.type === 'hover') {
      expect(t1.radiusM!).toBeLessThan(t0.radiusM!);
      expect(t1.holdS!).toBeGreaterThan(t0.holdS!);
      expect(hoverMarker(d, 0.5)!.radius).toBeGreaterThan(t1.radiusM!);
    } else {
      expect(courseLength(d.mapId, d.courseId)).toBeGreaterThan(5);
      // the target lap shrinks: an attempt that passes at level 0 is not fast enough at level 1
      const lap = (txt: string) => Number(/in ([\d.]+) s/.exec(txt)![1]);
      expect(lap(d.describe(1))).toBeLessThan(lap(d.describe(0)));
    }
  });

  test('judging: hover passes on success (error from the RMS), gates on a lap within the target', () => {
    const hover = drillById('hover-whoop')!, gates = drillById('gym-course')!;
    expect(hover.judge(metrics({ normalizedError: 0.1, success: true }), 'success', 0)).toEqual({ outcome: 'pass', error: 0.1 });
    expect(hover.judge(metrics({ normalizedError: 0.6 }), 'timeout', 0).outcome).toBe('hold');
    expect(hover.judge(metrics({ normalizedError: 2 }), 'timeout', 0).outcome).toBe('fail');
    expect(hover.judge(metrics({ normalizedError: 0.1 }), 'crash', 0).outcome).toBe('fail');
    const target = Number(/in ([\d.]+) s/.exec(gates.describe(0))![1]);
    const quick = gates.judge(metrics({ type: 'gates', lapTimesS: [target * 0.5] }), 'success', 0);
    expect(quick.outcome).toBe('pass');
    expect(quick.error).toBeCloseTo(PASS_ERROR * 0.5, 2); // (the description rounds the target to 0.1 s)
    expect(gates.judge(metrics({ type: 'gates', lapTimesS: [target * 1.5] }), 'success', 0).outcome).toBe('hold');
    expect(gates.judge(metrics({ type: 'gates', passed: 3 }), 'timeout', 0).outcome).toBe('fail');
  });

  test('attempts: levels move with the rule (or stay, when not adaptive), and export as CSV', () => {
    const st = newTrainingState(), d = drillById('hover-whoop')!;
    const a = recordAttempt(st, d, metrics({ normalizedError: 0, success: true }), 'success', 1);
    expect(a.next).toBeCloseTo(STEP_MAX, 9);
    recordAttempt(st, d, metrics({ normalizedError: 0.3 }), 'crash', 2);
    expect(st.levels[d.id]).toBe(0);
    st.adaptive = false;
    recordAttempt(st, d, metrics({ normalizedError: 0, success: true }), 'success', 3);
    expect(st.levels[d.id]).toBe(0);
    const csv = attemptsCsv(st.attempts).trim().split('\n');
    expect(csv).toHaveLength(4);
    expect(csv[0]).toMatch(/^time,drill,level,next_level,outcome/);
    expect(csv[2]).toMatch(/"hover-whoop",0\.05,0,"fail",0\.3,"crash"/);
  });
});

describe.skipIf(!existsSync(new URL('../public/bf/betaflight.mjs', import.meta.url)))('drills run headless', () => {
  test.each(DRILLS.map((d) => [d.id, d] as const))('%s at level 0.5', async (_id, d) => {
    const env = await createNodeEnv();
    const r = await env.reset({ scenario: d.scenario(0.5) });
    expect(r.info.cliErrors).toEqual([]);
    for (let i = 0; i < 20; i++) env.step({ throttle: 0.3 });
    expect(env.metrics().type).toBe(d.scenario(0.5).task!.type);
  }, 60000);
});
