// Arming coach: while the quad is disarmed, turn Betaflight's arming-disable flags into one plain
// sentence and the fix ("Pull the throttle fully down, then arm"), and walk new pilots through their
// first arm (throttle down -> arm -> ease the throttle up). Pure, so it is unit-tested; hud.ts draws it.

/** The buttons / keys to name in the advice, for the device in use. */
export interface CoachGlyphs { arm: string; respawn: string; throttleUp: string; throttleDown: string; keyboard: boolean }

export interface CoachInput {
  /** tel.armingFlagNames: Betaflight 4.5 armingDisableFlags_e names, bit order */
  flags: string[];
  /** the arm switch / key is on but the flight controller is not armed */
  armRequested: boolean;
  /** never flown yet: show the first-flight steps */
  newPilot: boolean;
  glyphs: CoachGlyphs;
}

export interface CoachStep { text: string; glyph?: string; state: 'done' | 'now' | 'todo' }
export interface CoachAdvice {
  title: string;
  /** what is wrong, in one sentence (empty when nothing blocks arming) */
  why: string;
  /** what to do about it */
  fix: string;
  /** the name Betaflight shows in the OSD warnings / CLI `status` */
  osd?: string;
  steps?: CoachStep[];
}

interface Rule { osd: string; why: string; fix: (g: CoachGlyphs, armOn: boolean) => string }

// Most fundamental first: a missing link or an open CLI makes every other flag moot, and the
// throttle / switch flags are what the pilot fixes last, right before arming.
const RULES: [string, Rule][] = [
  ['NO_GYRO', { osd: 'NOGYRO', why: 'Betaflight can’t find its gyro.', fix: () => 'Reload the page to restart the simulated flight controller.' }],
  ['RX_FAILSAFE', { osd: 'RXLOSS', why: 'Betaflight gets no signal from your controller.', fix: (g) => (g.keyboard ? 'Press a button on your controller so the browser detects it, or fly with the keyboard.' : 'Check the controller is connected, then press a button on it.') }],
  ['FAILSAFE', { osd: 'FAILSAFE', why: 'Failsafe is active: the radio link was lost.', fix: (g) => `Wait for the link to come back, then turn the arm switch off and on again (${g.arm}).` }],
  ['BOXFAILSAFE', { osd: 'BOXFAILSAFE', why: 'The failsafe switch is on.', fix: () => 'Turn the failsafe switch off.' }],
  ['BAD_RX_RECOVERY', { osd: 'BADRX', why: 'The radio link just came back after a failsafe.', fix: (g) => `Turn the arm switch off and on again (${g.arm}).` }],
  ['CLI', { osd: 'CLI', why: 'The Betaflight CLI is open, and it blocks arming.', fix: () => 'Type exit in Settings → Betaflight → CLI console.' }],
  ['MSP', { osd: 'MSP', why: 'A configurator is connected over MSP.', fix: () => 'Disconnect the configurator.' }],
  ['CMS_MENU', { osd: 'CMS', why: 'The OSD menu is open.', fix: () => 'Leave the OSD menu (Exit / Save).' }],
  ['REBOOT_REQUIRED', { osd: 'REBOOT_REQD', why: 'A changed setting needs the flight controller to reboot.', fix: () => 'Save in Settings → Betaflight. Saving reboots the flight controller.' }],
  ['PARALYZE', { osd: 'PARALYZE', why: 'Paralyze mode is on.', fix: () => 'Save in Settings → Betaflight to reboot the flight controller.' }],
  ['LOAD', { osd: 'LOAD', why: 'The flight controller’s CPU is overloaded.', fix: () => 'Lower the physics / PID loop rate in Settings → Simulation.' }],
  ['BOOT_GRACE_TIME', { osd: 'BOOTGRACE', why: 'Betaflight has only just booted.', fix: () => 'Wait a second, then arm.' }],
  ['CALIBRATING', { osd: 'CALIB', why: 'Betaflight is calibrating the gyro.', fix: () => 'Keep the quad still for a second.' }],
  ['ACC_CALIBRATION', { osd: 'NO_ACC_CAL', why: 'The accelerometer is not calibrated.', fix: () => 'Restore the simulator defaults in Settings → Betaflight.' }],
  ['RPMFILTER', { osd: 'RPMFILTER', why: 'The RPM filter has no motor telemetry yet.', fix: (g) => `Wait a moment. If it stays, respawn (${g.respawn}).` }],
  ['MOTOR_PROTOCOL', { osd: 'MOTOR_PROTO', why: 'The motor protocol is not supported.', fix: () => 'Set motor_pwm_protocol = DSHOT600 in the CLI, or restore the simulator defaults.' }],
  ['DSHOT_BITBANG', { osd: 'DSHOT_BBANG', why: 'DShot bit-bang is misconfigured.', fix: () => 'Restore the simulator defaults in Settings → Betaflight.' }],
  ['CRASH_DETECTED', { osd: 'CRASH', why: 'Betaflight detected a crash.', fix: (g) => `Respawn (${g.respawn}), then arm again.` }],
  ['RUNAWAY_TAKEOFF', { osd: 'RUNAWAY', why: 'Runaway takeoff protection stopped the motors.', fix: (g) => `Turn the arm switch off, respawn (${g.respawn}), then arm again.` }],
  ['ANGLE', { osd: 'ANGLE', why: 'The quad is tilted too far to arm.', fix: (g) => `Respawn (${g.respawn}) to put it level on the pad.` }],
  ['THROTTLE', { osd: 'THROTTLE', why: 'The throttle isn’t all the way down.', fix: (g) => (g.keyboard ? `Hold ${g.throttleDown} until the throttle is at zero, then arm (${g.arm}).` : 'Pull the throttle fully down, then arm.') }],
  ['ARM_SWITCH', { osd: 'ARMSWITCH', why: 'The arm switch was already on.', fix: (g, on) => (on ? `Turn it off (${g.arm}), then on again to arm.` : `Arm now (${g.arm}).`) }],
  ['NOPREARM', { osd: 'NOPREARM', why: 'The prearm switch is off.', fix: () => 'Turn the prearm switch on, then arm.' }],
  ['GPS', { osd: 'GPS', why: 'GPS rescue needs a GPS fix.', fix: () => 'Turn GPS rescue off in the CLI.' }],
  ['RESC', { osd: 'RESCUE SW', why: 'The GPS rescue switch is on.', fix: () => 'Turn the rescue switch off.' }],
  ['BST', { osd: 'BST', why: 'A BST device is blocking arming.', fix: () => 'Disconnect it.' }],
];
const RULE = new Map(RULES);
const ORDER = RULES.map(([k]) => k);

/** The flag to fix first (most fundamental), or null. Unknown flags come last, by name. */
export function topFlag(flags: string[]): string | null {
  if (!flags.length) return null;
  const known = flags.filter((f) => RULE.has(f)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
  return known[0] ?? [...flags].sort()[0];
}

/** Advice for the coach card, or null when there is nothing to say (armed pilots never see it). */
export function armingAdvice(i: CoachInput): CoachAdvice | null {
  const g = i.glyphs, top = topFlag(i.flags);
  const rule = top ? RULE.get(top) : undefined;
  const steps = i.newPilot ? firstFlightSteps(i) : undefined;
  if (top) {
    return {
      title: 'Can’t arm yet',
      why: rule?.why ?? `Betaflight reports ${top}.`,
      fix: rule?.fix(g, i.armRequested) ?? 'Respawn, or check Settings → Betaflight → CLI with the status command.',
      osd: rule?.osd ?? top,
      steps,
    };
  }
  if (!steps) return null;
  return { title: 'First flight', why: '', fix: 'Arm, then ease the throttle up until the quad lifts off.', steps };
}

function firstFlightSteps(i: CoachInput): CoachStep[] {
  const g = i.glyphs;
  const thrDown = !i.flags.includes('THROTTLE');
  const otherBlock = i.flags.some((f) => f !== 'THROTTLE' && f !== 'ARM_SWITCH');
  const s1: CoachStep['state'] = thrDown ? 'done' : 'now';
  const s2: CoachStep['state'] = !thrDown || otherBlock ? 'todo' : 'now';
  return [
    { text: 'Throttle fully down', glyph: g.keyboard ? g.throttleDown : undefined, state: s1 },
    { text: 'Arm', glyph: g.arm, state: s2 },
    { text: 'Ease the throttle up', glyph: g.keyboard ? g.throttleUp : undefined, state: 'todo' },
  ];
}

/** Stable text of the advice, so the card is only rebuilt when it changes. */
export const adviceSig = (a: CoachAdvice | null) => (a ? `${a.title}|${a.why}|${a.fix}|${a.osd ?? ''}|${a.steps?.map((s) => s.state + s.text + (s.glyph ?? '')).join(',') ?? ''}` : '');
