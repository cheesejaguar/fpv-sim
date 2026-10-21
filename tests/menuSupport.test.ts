// Menu support pieces: version label, prefilled bug report, glass-to-glass latency readout, Betaflight
// backup replay lines, and the race / roster panel data.
import { describe, expect, it } from 'vitest';
import { newDrill, newRace, raceInfo } from '../src/app/race';
import type { AppCtx } from '../src/app/context';
import { DEFAULT_SPEC } from '../src/builder/derive';
import { diffConfigLines } from '../src/ui/bfPanel';
import { bugReportUrl, commitUrl, versionLabel } from '../src/ui/menu/about';
import { DEFAULT_VIEW, glassToGlass } from '../src/ui/settingsPanel';

describe('version + bug report', () => {
  it('labels release and development builds', () => {
    expect(versionLabel('dev', '')).toBe('dev');
    expect(versionLabel('0.2.0', '')).toBe('v0.2.0');
    expect(versionLabel('v0.2.0', '1a2b3c4d5e6f')).toBe('v0.2.0 · 1a2b3c4');
    expect(commitUrl('1a2b3c4')).toBe('https://github.com/cheesejaguar/fpv-sim/commit/1a2b3c4');
    expect(commitUrl('')).toBe('');
  });

  it('prefills a GitHub issue with version, browser, GPU and controller', () => {
    const u = new URL(bugReportUrl({ version: '0.2.0', commit: 'abcdef123', userAgent: 'Mozilla/5.0 Test', gpu: 'ANGLE (NVIDIA RTX 4070)', controller: 'Xbox Wireless Controller (STANDARD GAMEPAD)', page: 'https://fpv-sim-gamma.vercel.app/' }));
    expect(u.origin + u.pathname).toBe('https://github.com/cheesejaguar/fpv-sim/issues/new');
    const body = u.searchParams.get('body')!;
    expect(body).toContain('Version: v0.2.0 · abcdef1');
    expect(body).toContain('Browser: Mozilla/5.0 Test');
    expect(body).toContain('GPU: ANGLE (NVIDIA RTX 4070)');
    expect(body).toContain('Controller: Xbox Wireless Controller (STANDARD GAMEPAD)');
    expect(u.searchParams.get('title')).toMatch(/^Bug/);
    const none = new URL(bugReportUrl({ version: 'dev', commit: '', userAgent: 'UA', gpu: '', controller: '', page: 'x' })).searchParams.get('body')!;
    expect(none).toContain('Controller: none (keyboard)');
    expect(none).toContain('GPU: unknown');
  });
});

describe('settings', () => {
  it('starts with the telemetry overlay off', () => {
    expect(DEFAULT_VIEW.telemetry).toBe(false);
  });

  it('computes the glass-to-glass latency the pilot actually sees', () => {
    // fast display: the sim adds the rest of the system's delay
    expect(glassToGlass(24, 12)).toEqual({ addedMs: 12, effectiveMs: 24, displayBound: false });
    // a 60 Hz display (~31 ms) is slower than DJI O4's whole 24 ms: nothing can be added
    expect(glassToGlass(24, 31)).toEqual({ addedMs: 0, effectiveMs: 31, displayBound: true });
  });
});

describe('Betaflight backup replay', () => {
  it('keeps the config lines of a diff all and drops the CLI chatter', () => {
    const diff = ['# diff all', '', '# version', '# Betaflight / SITL (SITL) 4.5.5 Jan 1 2025', 'batch start', 'defaults nosave',
      'board_name SITL', '# master', 'set motor_poles = 12', 'profile 0', 'set p_roll = 50', 'rateprofile 0', 'set roll_srate = 75',
      'batch end', 'save', 'exit', 'Rebooting'].join('\r\n');
    expect(diffConfigLines(diff)).toEqual(['board_name SITL', 'set motor_poles = 12', 'profile 0', 'set p_roll = 50', 'rateprofile 0', 'set roll_srate = 75']);
  });
});

describe('race panel', () => {
  const ctx = (gates: number, connected: boolean, lb: Partial<AppCtx['lb']> = { pb: () => undefined, record: () => undefined }) => ({
    race: { ...newRace(), lapCount: 2, bestLap: 31.5, lastLap: 33 }, drill: newDrill(),
    map: { id: 'field', gates: Array.from({ length: gates }, (_, i) => ({ id: i })) }, spec: DEFAULT_SPEC, lb,
    mp: { connected, room: connected ? 'ABCD' : null, peers: new Map([[2, { info: { name: 'Bob', color: '#00ff00' }, lap: { lap: 3, best: 29.9 } }]]) },
  }) as unknown as AppCtx;

  it('shows the personal best and the leaderboard record for this track and drone class', () => {
    const asked: string[] = [];
    const lb = {
      pb: (m: string, c: string, cls: string) => { asked.push(`${m}|${c}|${cls}`); return { lapMs: 30_250, splitsMs: [], at: 1, summary: '', submitted: { id: 9, at: 2 } }; },
      record: () => ({ id: 9, initials: 'ACE', lapMs: 30_250, cls: 'freestyle5', summary: '', at: 2 }),
    };
    const r = raceInfo(ctx(8, false, lb))!;
    expect(asked).toEqual(['field||freestyle5']);
    expect(r).toMatchObject({ pb: 30.25, record: { initials: 'ACE', lap: 30.25, mine: true } });
  });

  it('has no panel solo on a map without gates', () => {
    expect(raceInfo(ctx(0, false))).toBeNull();
  });

  it('shows the room roster on a map without gates', () => {
    const r = raceInfo(ctx(0, true))!;
    expect(r.gates).toBe(0);
    expect(r.room).toBe('ABCD');
    expect(r.board!.map((b) => b.name)).toEqual(['Pilot', 'Bob']); // me first, no lap ordering
  });

  it('ranks the room by best lap on a race course', () => {
    const r = raceInfo(ctx(8, true))!;
    expect(r.gates).toBe(8);
    expect(r.board!.map((b) => b.name)).toEqual(['Bob', 'Pilot']);
    expect(raceInfo(ctx(8, false))!.board).toBeUndefined();
  });
});
