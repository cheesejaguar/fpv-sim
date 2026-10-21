import { expect, test } from 'vitest';
import { planDiffImport, cliErrors } from '../src/bf/diffImport';

const SAMPLE = `diff all

# version
# Betaflight / STM32F7X2 (S7X2) 4.5.1 Sep 29 2024 / 09:35:55 (77d01ba3b) MSP API: 1.46
# config rev: 8b6a3c9

# start the command batch
batch start

board_name SPEEDYBEEF7V3
manufacturer_id SPBE

# resources
resource MOTOR 1 B04

# timer
timer B04 AF2

# dma
dma ADC 1 0

# feature
feature -RX_PARALLEL_PWM
feature RX_SERIAL
feature TELEMETRY
feature OSD

# serial
serial 0 64 115200 57600 0 115200

# aux
aux 0 0 0 1800 2100 0 0

# master
set gyro_lpf1_static_hz = 0
set gyro_lpf2_static_hz = 750
set dyn_notch_count = 1
set serialrx_provider = CRSF
set motor_pwm_protocol = DSHOT300
set dshot_bidir = ON
set motor_poles = 12
set align_board_yaw = 90
set yaw_motors_reversed = ON
set vbat_scale = 109
set osd_vbat_pos = 2465
set name = MyQuad

profile 0

# profile 0
set p_roll = 52
set d_roll = 41
set f_roll = 140
set simplified_d_gain = 110

rateprofile 0

# rateprofile 0
set roll_rc_rate = 12
set roll_srate = 75

# end the command batch
batch end

# 
`;

test('keeps the tune, drops the board hardware', () => {
  const p = planDiffImport(SAMPLE);
  expect(p.version).toBe('4.5.1');
  expect(p.board).toBe('STM32F7X2');
  expect(p.propsOut).toBe(true);
  const a = p.apply.join('\n');
  for (const keep of ['set gyro_lpf2_static_hz = 750', 'set dyn_notch_count = 1', 'set dshot_bidir = ON', 'set motor_pwm_protocol = DSHOT300', 'profile 0', 'set p_roll = 52', 'set f_roll = 140', 'rateprofile 0', 'set roll_srate = 75', 'feature OSD', 'set osd_vbat_pos = 2465', 'set yaw_motors_reversed = ON']) expect(a).toContain(keep);
  for (const drop of ['resource', 'timer', 'dma', 'serial 0', 'aux 0', 'serialrx_provider', 'motor_poles', 'align_board_yaw', 'vbat_scale', 'RX_SERIAL', 'TELEMETRY', 'board_name', 'batch']) expect(a).not.toContain(drop);
  // profile switch precedes the profile's settings
  expect(p.apply.indexOf('profile 0')).toBeLessThan(p.apply.indexOf('set p_roll = 52'));
  expect(p.warnings).toEqual([]);
  expect(a).toContain('set craft_name = MyQuad'); // legacy "set name" translated
  expect(planDiffImport('# Betaflight / X 4.5.0 x\nname OldQuad').apply).toContain('set craft_name = OldQuad');
});

test('warns on other Betaflight versions and missing header', () => {
  expect(planDiffImport(SAMPLE.replace('4.5.1', '4.4.3')).warnings.join(' ')).toContain('4.4.3');
  expect(planDiffImport('set p_roll = 40').warnings.join(' ')).toContain('diff all');
});

test('extracts CLI errors with the offending command', () => {
  const out = '# set foo_bar = 3\r\n###ERROR IN set: INVALID NAME: foo_bar###\r\n# set p_roll = 50\r\np_roll set to 50\r\n';
  const e = cliErrors(out);
  expect(e.length).toBe(1);
  expect(e[0]).toContain('foo_bar');
});
