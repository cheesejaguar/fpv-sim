// International Standard Atmosphere (troposphere), with temperature offset.
export const G0 = 9.80665;
const R_AIR = 287.05287;

export interface AirState { rho: number; pressure: number; tempK: number; mu: number }

export function isa(altitudeM: number, tempOffsetK = 0, out?: AirState): AirState {
  const T0 = 288.15 + tempOffsetK;
  const L = 0.0065;
  const T = T0 - L * altitudeM;
  const p = 101325 * Math.pow(1 - (L * altitudeM) / 288.15, 5.25588);
  const rho = p / (R_AIR * T);
  // Sutherland viscosity
  const mu = 1.458e-6 * Math.pow(T, 1.5) / (T + 110.4);
  const o = out ?? { rho, pressure: p, tempK: T, mu };
  o.rho = rho; o.pressure = p; o.tempK = T; o.mu = mu;
  return o;
}
