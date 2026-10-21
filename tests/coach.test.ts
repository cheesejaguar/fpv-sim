// Arming coach: Betaflight's arming-disable flags -> one plain sentence + the fix, first-flight steps.
import { describe, expect, it } from 'vitest';
import { adviceSig, armingAdvice, CoachGlyphs, topFlag } from '../src/ui/hud/coach';
import { ARMING_FLAG_NAMES } from '../src/bf/bfModule';

const KB: CoachGlyphs = { arm: 'Space', respawn: 'R', throttleUp: 'W', throttleDown: 'S', keyboard: true };
const PAD: CoachGlyphs = { arm: 'RB', respawn: 'A', throttleUp: 'left stick', throttleDown: 'left stick', keyboard: false };
const advice = (flags: string[], o: Partial<{ armRequested: boolean; newPilot: boolean; glyphs: CoachGlyphs }> = {}) =>
  armingAdvice({ flags, armRequested: o.armRequested ?? false, newPilot: o.newPilot ?? false, glyphs: o.glyphs ?? PAD });

describe('arming coach', () => {
  it('says nothing when Betaflight can arm and the pilot has flown before', () => {
    expect(advice([])).toBeNull();
  });

  it('explains a raised throttle with the fix, naming the keys on a keyboard', () => {
    const pad = advice(['THROTTLE'])!;
    expect(pad.osd).toBe('THROTTLE');
    expect(pad.why).toMatch(/throttle isn’t all the way down/);
    expect(pad.fix).toBe('Pull the throttle fully down, then arm.');
    const kb = advice(['THROTTLE'], { glyphs: KB })!;
    expect(kb.fix).toContain('Hold S');
    expect(kb.fix).toContain('(Space)');
  });

  it('fixes the most fundamental problem first', () => {
    expect(topFlag(['THROTTLE', 'RX_FAILSAFE', 'ARM_SWITCH'])).toBe('RX_FAILSAFE');
    expect(topFlag(['ARM_SWITCH', 'THROTTLE'])).toBe('THROTTLE');
    expect(topFlag(['THROTTLE', 'CLI'])).toBe('CLI');
    expect(topFlag(['ANGLE', 'BOOT_GRACE_TIME'])).toBe('BOOT_GRACE_TIME');
    expect(topFlag([])).toBeNull();
  });

  it('uses the OSD short names pilots see in their goggles', () => {
    expect(advice(['RX_FAILSAFE'])!.osd).toBe('RXLOSS');
    expect(advice(['BOOT_GRACE_TIME'])!.osd).toBe('BOOTGRACE');
    expect(advice(['CALIBRATING'])!.osd).toBe('CALIB');
    expect(advice(['ARM_SWITCH'])!.osd).toBe('ARMSWITCH');
  });

  it('has a plain sentence and a fix for every Betaflight 4.5 flag', () => {
    for (const f of ARMING_FLAG_NAMES) {
      const a = advice([f])!;
      expect(a.why.length, f).toBeGreaterThan(10);
      expect(a.fix.length, f).toBeGreaterThan(5);
      expect(a.why).not.toMatch(/reports/); // a real explanation, not the generic fallback
    }
  });

  it('falls back gracefully for a flag it does not know', () => {
    const a = advice(['SOMETHING_NEW'])!;
    expect(a.osd).toBe('SOMETHING_NEW');
    expect(a.why).toContain('SOMETHING_NEW');
  });

  it('tells the pilot to cycle the arm switch only while it is on', () => {
    expect(advice(['ARM_SWITCH'], { armRequested: true, glyphs: KB })!.fix).toMatch(/Turn it off \(Space\), then on again/);
    expect(advice(['ARM_SWITCH'], { armRequested: false, glyphs: KB })!.fix).toBe('Arm now (Space).');
  });

  it('walks a new pilot through throttle down -> arm -> ease up', () => {
    const ready = advice([], { newPilot: true, glyphs: KB })!;
    expect(ready.title).toBe('First flight');
    expect(ready.steps!.map((s) => s.state)).toEqual(['done', 'now', 'todo']);
    expect(ready.steps!.map((s) => s.glyph)).toEqual(['S', 'Space', 'W']);
    const thrUp = advice(['THROTTLE'], { newPilot: true, glyphs: KB })!;
    expect(thrUp.title).toBe('Can’t arm yet');
    expect(thrUp.steps!.map((s) => s.state)).toEqual(['now', 'todo', 'todo']);
    // another block (booting): throttle is fine but arming has to wait
    expect(advice(['BOOT_GRACE_TIME'], { newPilot: true })!.steps!.map((s) => s.state)).toEqual(['done', 'todo', 'todo']);
    // controllers: no key glyph for the stick steps
    expect(advice([], { newPilot: true, glyphs: PAD })!.steps!.map((s) => s.glyph)).toEqual([undefined, 'RB', undefined]);
  });

  it('has a stable signature, so the card is rebuilt only when the advice changes', () => {
    expect(adviceSig(advice(['THROTTLE']))).toBe(adviceSig(advice(['THROTTLE'])));
    expect(adviceSig(advice(['THROTTLE']))).not.toBe(adviceSig(advice(['CLI'])));
    expect(adviceSig(null)).toBe('');
  });
});
