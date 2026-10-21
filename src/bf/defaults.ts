// First-boot Betaflight configuration applied over the CLI (then `save`). Hardware-dependent
// values (motor poles, KV, prop direction, video system / OSD canvas) come from the drone build.
import type { DroneBuild } from '../builder/derive';

/** BF 4.5 OSD position encoding: x (6 bits, bit5 stored at bit 10), y (5 bits), visible flag. */
export function osdPos(x: number, y: number, visible = true): number {
  return (x & 0x1f) | ((y & 0x1f) << 5) | ((x & 0x20) ? 0x400 : 0) | (visible ? 0x800 : 0);
}

/** Canvas size per video standard: HD 53x20, PAL 30x16, NTSC 30x13. */
export function osdGrid(video: { osd: 'sd' | 'hd'; fps: number }): { hd: boolean; W: number; H: number; vcd: string } {
  if (video.osd === 'hd') return { hd: true, W: 53, H: 20, vcd: 'HD' };
  return video.fps < 55 ? { hd: false, W: 30, H: 16, vcd: 'PAL' } : { hd: false, W: 30, H: 13, vcd: 'NTSC' };
}

export function osdLayout(video: { osd: 'sd' | 'hd'; fps: number }): Record<string, number> {
  const { W, H } = osdGrid(video);
  const r = W - 1;
  return {
    osd_craft_name_pos: osdPos(Math.floor(W / 2) - 3, 1),
    osd_throttle_pos: osdPos(1, 1),
    osd_tim_2_pos: osdPos(r - 6, 1),
    osd_link_quality_pos: osdPos(1, 2),
    osd_rssi_dbm_pos: osdPos(1, 3),      // uplink RSSI in dBm, under LQ (as on an ExpressLRS quad)
    osd_vbat_pos: osdPos(1, H - 2),
    osd_current_pos: osdPos(1, H - 3),
    osd_mah_drawn_pos: osdPos(r - 6, H - 3),
    osd_avg_cell_voltage_pos: osdPos(r - 6, H - 2),
    osd_flymode_pos: osdPos(Math.floor(W / 2) - 2, H - 2),
    osd_warnings_pos: osdPos(Math.floor(W / 2) - 5, H - 5),
    osd_crosshairs_pos: osdPos(Math.floor(W / 2) - 1, Math.floor(H / 2), true),
    osd_disarmed_pos: osdPos(Math.floor(W / 2) - 4, Math.floor(H / 2) + 2),
    osd_power_pos: osdPos(1, H - 4),
    osd_motor_diag_pos: osdPos(1, H - 6, false),
  };
}

/**
 * Settings the simulator itself depends on, re-applied after importing a real quad's `diff all`:
 * simulated motor poles/KV (RPM telemetry decoding), virtual battery sensor, video canvas, the
 * controller mode mapping (AUX1 arm, AUX2 mode, AUX3 turtle, AUX4 beeper), OSD on, and the debug
 * mode used by the noise-spectrum overlay. OSD element positions are only reset when the import
 * didn't bring its own.
 */
/**
 * Battery settings matching the simulated pack. Without vbat_max_cell_voltage = 445 Betaflight
 * (default 430) miscounts LiHV packs: a full 6S HV (26.1 V) reads as 7S, and a full 1S HV (4.35 V)
 * as USB power. bat_capacity drives the mAh-based warnings and the OSD battery %.
 */
export function batteryCli(build: DroneBuild): string[] {
  const b = build.info.components.battery;
  const liion = b.chemistry === 'LiIon';
  return [
    `set vbat_max_cell_voltage = ${b.chemistry === 'LiHV' ? 445 : 430}`,
    `set vbat_warning_cell_voltage = ${liion ? 300 : 350}`,
    `set vbat_min_cell_voltage = ${liion ? 280 : 330}`,
    `set bat_capacity = ${Math.round(b.capacityMah * (b.parallel || 1))}`,
  ];
}

/**
 * The simulator's virtual peripherals on their UARTs (the same on every build): UART1 MSP + CLI,
 * UART2 the native serial blackbox (2 Mbaud, 2 kHz at 8 kHz PID, captured by the worker), UART3
 * the u-blox GPS. DShot beacon on RX loss and on the AUX beeper switch, as most pilots set it up.
 */
export function peripheralsCli(): string[] {
  return [
    'serial 1 128 115200 57600 0 2000000',
    'set blackbox_device = SERIAL',
    'set blackbox_sample_rate = 1/4',
    'set blackbox_mode = NORMAL',
    'feature GPS',
    'serial 2 2 115200 115200 0 115200',
    'set gps_provider = UBLOX',
    'beacon RX_LOST',
    'beacon RX_SET',
  ];
}

/** Gyro / PID loop matching the simulated chip: a BMI270 runs gyro and PID at 3.2 kHz (denom 1). */
export function loopCli(build: DroneBuild): string[] {
  return build.params.imuChip.sampleRateHz < 8000 ? ['set pid_process_denom = 1'] : [];
}

export function simHardwareCli(build: DroneBuild, opts: { keepOsdLayout: boolean; propsOut: boolean | null }): string[] {
  const m = build.info.components.motor, v = build.info.components.video;
  const propsOut = opts.propsOut ?? build.spec.propDirection === 'props-out';
  const lines = [
    'feature OSD',
    ...peripheralsCli(),
    ...loopCli(build),
    `set motor_poles = ${m.poles}`,
    `set motor_kv = ${Math.round(m.kv)}`,
    `set yaw_motors_reversed = ${propsOut ? 'ON' : 'OFF'}`,
    `set vcd_video_system = ${osdGrid(v).vcd}`,
    'set current_meter = ADC',
    'set battery_meter = ADC',
    ...batteryCli(build),
    'set debug_mode = GYRO_FILTERED',
    'aux 0 0 0 1700 2100 0 0',
    'aux 1 1 1 1700 2100 0 0',
    'aux 2 2 1 1300 1700 0 0',
    'aux 3 35 2 1700 2100 0 0',
    'aux 4 13 3 1700 2100 0 0',
    'map AETR1234',
  ];
  if (!opts.keepOsdLayout) for (const [k, val] of Object.entries(osdLayout(v))) lines.push(`set ${k} = ${val}`);
  return lines;
}

export function defaultCli(build: DroneBuild): string[] {
  const s = build.spec, m = build.info.components.motor, v = build.info.components.video;
  const grid = osdGrid(v);
  const lines = [
    '# fpv-sim first boot defaults',
    'set craft_name = FPVSIM',
    'feature OSD',
    'set motor_pwm_protocol = DSHOT600',
    'set dshot_bidir = ON',
    `set motor_poles = ${m.poles}`,
    `set motor_kv = ${Math.round(m.kv)}`,
    `set yaw_motors_reversed = ${s.propDirection === 'props-out' ? 'ON' : 'OFF'}`,
    'set dshot_idle_value = 550',
    ...batteryCli(build),
    `set vcd_video_system = ${grid.vcd}`,
    'set current_meter = ADC',
    'set battery_meter = ADC',
    'set osd_units = METRIC',
    // arms only roughly level (Betaflight's own default), like a real quad on the pad
    'set small_angle = 25',
    'set pid_process_denom = 1',
    ...peripheralsCli(),
    // long range: GPS rescue brings it home on failsafe (arming then waits for a fix with 8+ sats)
    `set failsafe_procedure = ${s.frame === 'f7-lr' ? 'GPS-RESCUE' : 'DROP'}`,
    // debug[0..2] = fully filtered gyro: the worker's spectrum overlay compares it with the raw IMU
    'set debug_mode = GYRO_FILTERED',
    // modes: AUX1 arm, AUX2 low=acro / mid=horizon / high=angle, AUX3 turtle, AUX4 beeper
    'aux 0 0 0 1700 2100 0 0',
    'aux 1 1 1 1700 2100 0 0',
    'aux 2 2 1 1300 1700 0 0',
    'aux 3 35 2 1700 2100 0 0',
    'aux 4 13 3 1700 2100 0 0',
    'map AETR1234',
  ];
  for (const [k, val] of Object.entries(osdLayout(v))) lines.push(`set ${k} = ${val}`);
  lines.push('save');
  return lines;
}
