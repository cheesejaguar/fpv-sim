// "Bring your real quad": take the output of `diff all` from a real Betaflight flight controller and
// turn it into a CLI script for the simulated FC. Everything that defines how the quad flies (PIDs,
// rates, filters, feedforward, TPA, anti-gravity, dynamic idle, throttle settings, OSD, features,
// modes) is kept. Lines that describe the physical board are dropped, because the simulator's
// virtual hardware replaces it: pin resources, timers, DMA, UARTs, receiver protocol, gyro buses and
// alignment, LEDs, VTX tables. Motor poles / KV are owned by the drone builder (they must match the
// simulated motors for the RPM filter); prop direction is reported so the builder can follow it.

export interface DiffLine { line: string; reason?: string }

export interface DiffPlan {
  version: string | null;        // e.g. "4.5.1" from "# Betaflight / STM32F7X2 (S7X2) 4.5.1 ..."
  board: string | null;
  apply: string[];                // CLI lines to send (profile/rateprofile switches included)
  skipped: DiffLine[];            // dropped lines with the reason
  warnings: string[];
  propsOut: boolean | null;       // from yaw_motors_reversed, if present
  mixer: string | null;
}

// Commands that only describe the physical board / hardware wiring.
const DROP_COMMANDS: Record<string, string> = {
  resource: 'pin assignment (board hardware)', timer: 'timer assignment (board hardware)', dma: 'DMA assignment (board hardware)',
  serial: 'UART configuration (the simulator owns its virtual UARTs)', serialpassthrough: 'hardware passthrough',
  board_name: 'board identity', manufacturer_id: 'board identity', mcu_id: 'board identity', signature: 'board identity',
  led: 'LED strip', color: 'LED strip', mode_color: 'LED strip', vtxtable: 'VTX hardware table', vtx: 'VTX channel schedule',
  map: 'channel map: the simulator sends AETR', aux: 'mode switches: the simulator maps arm / angle / turtle to its own controller setup',
  rxrange: 'receiver endpoints: the simulator sends calibrated 1000–2000 µs', rxfail: 'receiver failsafe values',
  defaults: 'would reset the simulator’s hardware setup', save: 'added once at the end', exit: 'not needed', batch: 'not needed',
  dfu: 'not applicable', bl: 'not applicable', flash_erase: 'not applicable', timer_show: 'not applicable',
  servo: 'servos are not simulated', smix: 'servos are not simulated', adjrange: 'in-flight adjustments are not mapped',
  beacon: 'DShot beacon (hardware)',
};

// `set` variables that describe hardware or that the simulator must control itself.
const DROP_SET: [RegExp, string][] = [
  [/^(gyro|acc|baro|mag)_(hardware|to_use|1_|2_|.*bustype|.*spibus|.*i2c|.*_align|.*sensor_align)/, 'sensor hardware / bus'],
  [/^(gyro_1|gyro_2)_/, 'sensor hardware / bus'],
  [/^(align_board_roll|align_board_pitch|align_board_yaw|align_mag)/, 'board alignment: the simulated gyro is mounted straight'],
  [/^(serialrx_|rx_spi_|spektrum_|sbus_|crsf_|frsky_|ibus_|srxl2_|rssi_|rc_smoothing_|.*_halfduplex|serialrx)/, 'receiver protocol / link (the simulator feeds RC directly)'],
  [/^(rx_min_usec|rx_max_usec|min_check|max_check)$/, 'receiver endpoints'],
  [/^(motor_poles|motor_kv)$/, 'owned by the drone builder (must match the simulated motors for the RPM filter)'],
  [/^(vbat_scale|vbat_divider|vbat_multiplier|ibata_scale|ibata_offset|current_meter|battery_meter|.*_adc_|adc_device)/, 'battery sensor calibration (the simulator feeds calibrated voltage/current)'],
  [/^(vcd_video_system|osd_displayport_device|max7456_|displayport_|vcd_)/, 'video hardware: follows the simulator’s video system'],
  [/^(dshot_bitbang|dshot_burst|dshot_bitbang_timer|motor_output_reordering|pwm_|servo_)/, 'motor output hardware'],
  [/^(blackbox_device|sdcard_|flash_|usb_)/, 'storage / USB hardware'],
  [/^(beeper_|beacon_)/, 'beeper hardware'],
  [/^(ledstrip_|led_)/, 'LED strip'],
  [/^acc_calibration$/, 'accelerometer calibration of the real board (the simulator calibrates its own)'],
  [/^gps_(?!rescue_)/, 'GPS receiver setup: the simulator owns its virtual u-blox GPS (rescue settings are kept)'],
  [/^(vtx_|camera_control_|pinio_|box_user_|tlm_|telemetry_|frsky_|hott_|smartport_|ltm_|mavlink_|ibus_)/, 'hardware peripheral not simulated'],
  [/^(system_hse_mhz|cpu_overclock|task_statistics|debug_mode)$/, 'MCU / diagnostics'],
];

const FEATURE_DROP = /^-?(RX_|SOFTSERIAL|LED_STRIP|TELEMETRY|TRANSPONDER|GPS|ESC_SENSOR|RANGEFINDER|CHANNEL_FORWARDING|SERVO_TILT|INFLIGHT_ACC_CAL|DASHBOARD)/;

export function planDiffImport(text: string): DiffPlan {
  const plan: DiffPlan = { version: null, board: null, apply: [], skipped: [], warnings: [], propsOut: null, mixer: null };
  const lines = text.replace(/\r/g, '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const v = /^#\s*Betaflight\s*\/\s*(\S+)(?:\s*\(\S+\))?\s+(\d+\.\d+\.\d+)/.exec(line);
      if (v) { plan.board = v[1]; plan.version = v[2]; }
      continue;
    }
    const [cmd, ...rest] = line.split(/\s+/);
    const c = cmd.toLowerCase();
    if (DROP_COMMANDS[c]) { plan.skipped.push({ line, reason: DROP_COMMANDS[c] }); continue; }
    if (c === 'profile' || c === 'rateprofile') { plan.apply.push(line); continue; }
    if (c === 'mixer') { plan.mixer = rest[0] ?? null; plan.apply.push(line); continue; }
    if (c === 'feature') {
      const f = rest[0] ?? '';
      if (FEATURE_DROP.test(f)) { plan.skipped.push({ line, reason: 'hardware feature (receiver / peripherals)' }); continue; }
      if (/^-OSD$/i.test(f)) { plan.skipped.push({ line, reason: 'the simulator always shows the OSD' }); continue; }
      plan.apply.push(line); continue;
    }
    if (c === 'set') {
      const m = /^set\s+(\S+)\s*=\s*(.*)$/i.exec(line);
      if (!m) { plan.skipped.push({ line, reason: 'unrecognised set syntax' }); continue; }
      let name = m[1].toLowerCase();
      const value = m[2].trim();
      if (name === 'name') name = 'craft_name'; // pre-4.3 spelling
      const hit = DROP_SET.find(([re]) => re.test(name));
      if (hit) { plan.skipped.push({ line, reason: hit[1] }); continue; }
      if (name === 'yaw_motors_reversed') plan.propsOut = /^on$/i.test(value);
      if (name === 'motor_pwm_protocol' && !/^dshot/i.test(value)) {
        plan.warnings.push(`Your quad uses ${value}; the simulator emulates it, but the RPM filter needs bidirectional DShot.`);
      }
      plan.apply.push(`set ${name} = ${value}`);
      continue;
    }
    if (c === 'name') { if (rest.length) plan.apply.push(`set craft_name = ${rest.join(' ')}`); continue; } // pre-4.2 command form
    if (c === 'beeper' || c === 'mmix' || c === 'simplified_tuning' || c === 'vtx_channel') {
      plan.apply.push(line); continue;
    }
    plan.skipped.push({ line, reason: 'command not used by the simulator' });
  }
  if (!plan.version) plan.warnings.push('No "# Betaflight … version" header found: paste the complete output of `diff all`.');
  else if (!plan.version.startsWith('4.5')) plan.warnings.push(`Your flight controller runs Betaflight ${plan.version}; the simulator runs 4.5.5. Settings renamed between versions will be reported as errors and ignored.`);
  if (plan.mixer && plan.mixer.toUpperCase() !== 'QUADX') plan.warnings.push(`Mixer ${plan.mixer}: the simulator models a quad-X airframe.`);
  // leave the FC in profile 0 / rateprofile 0 context-agnostic: Betaflight keeps the selected index
  return plan;
}

/** Parse CLI output from applying a plan: count errors per line. */
export function cliErrors(output: string): string[] {
  const errs: string[] = [];
  const lines = output.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/###ERROR|^Invalid name|^Invalid value|ERROR IN/i.test(lines[i])) {
      // the command echo precedes the error
      const prev = [...lines.slice(Math.max(0, i - 3), i)].reverse().find((l) => l.startsWith('# '));
      errs.push(`${prev ? prev.slice(2) + ' → ' : ''}${lines[i].replace(/#/g, '').trim()}`);
    }
  }
  return errs;
}
