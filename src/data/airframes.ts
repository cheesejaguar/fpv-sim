// Fixed-wing airframes: five commercial FPV planes, each described the way the plane builder
// (src/builder/plane.ts) turns it into a flying model: wing planform and aerofoil, tail, fuselage,
// where the motors sit, the airframe's own mass (foam, servos, linkages), the cruise it is designed
// for, and how ArduPlane drives it (its SERVOn_FUNCTIONs and starting parameters).
//
// Sources: the makers' and retailers' published specifications (read 2026-11): HEEWING T1 Ranger
// (730 mm, 2x 1404 3700KV, FX-3830 props, 2-3S, V-tail on a boom, 205 g grey airframe), AtomRC
// Penguin (750 mm, 15.06 dm^2, twin 2004 2400KV, 6026 props, 4S 2000-3000 mAh, blended "wingsuit"
// wing with elevons), SonicModell AR Wing Pro (1000 mm, 18 dm^2, 2216 1400KV, 8x5, 4S 3200-3700,
// ~500 g PNP), ZOHD Talon GT Rebel (1000 mm, 14 dm^2, V-tail pusher, 2216 1300KV, 8x5, 4S
// 3300-4400) and Volantex Ranger 2000 (2000 mm pusher glider, 2215 1400KV, 8x4 folding, 3S 2200,
// ~1.08 kg flying weight without battery). Values no source gave (marked est) are estimates from the
// published dimensions and photos: the T1's and the Ranger 2000's wing areas, taper, sweep,
// dihedral, tail areas and arms, and every aerofoil coefficient.

export type Layout = 'conventional' | 'vtail' | 'flyingwing';

export interface AirframeSpec {
  id: string;
  name: string;
  maker: string;
  layout: Layout;
  spanMm: number;
  wingAreaDm2: number;
  /** tip chord / root chord */
  taper: number;
  /** leading-edge sweep (deg) and dihedral (deg); flying wings: effective dihedral (sweep's roll stability) */
  sweepDeg: number;
  dihedralDeg: number;
  /** wing aerofoil and incidence: zero-angle lift (camber + incidence), parasite drag, pitching moment, stall */
  airfoil: { cl0: number; cd0: number; cm0: number; stallDeg: number };
  /** tail: area of the horizontal tail (or both V panels together) and the fin; arm from the wing's to the tail's aerodynamic centre; V panel angle above horizontal */
  tail: { hAreaDm2: number; vAreaDm2: number; armMm: number; vAngleDeg?: number };
  /** winglets (flying wings): area of each and how far behind the wing's aerodynamic centre */
  winglets?: { areaDm2: number; aftMm: number; heightMm: number };
  fuselage: { lengthMm: number; widthMm: number; heightMm: number; noseMm: number };
  /** motors: tractor ahead of the wing (on the nose or the wings) or pusher behind it; x from the wing root leading edge (+ forward), y of each motor */
  motors: { count: 1 | 2; mount: 'tractor' | 'pusher'; xMm: number; yMm: number; zMm: number };
  /** control throws (deg each way) */
  throwsDeg: { aileron?: number; elevator?: number; rudder?: number; elevon?: number; ruddervator?: number };
  /** foam, servos, linkages, spar: everything but the motor(s), ESC(s), FC, video, receiver and battery (g) */
  airframeMassG: number;
  /** the speed the plane is designed to cruise at (km/h): the airframe trims there hands off */
  cruiseKmh: number;
  /** static margin (fraction of the mean chord the CG sits ahead of the neutral point) */
  staticMargin: number;
  /** the ArduPlane parameters this airframe starts from (the servo map comes from its layout) */
  params: Record<string, number>;
  /** what the source data left open */
  est: string[];
  url: string;
}

/** ArduPlane parameters every airframe here shares: stabilised flight modes and a hand launch (switches: src/ap/apConfig.ts). */
export const PLANE_PARAMS_COMMON: Record<string, number> = {
  // modes on AUX2 (CH6), a 3-position switch: low MANUAL, mid FBWA, high CRUISE (slots 1, 4, 6; a
  // 6-position switch also gets ACRO and FBWB)
  FLTMODE_CH: 6, FLTMODE1: 0, FLTMODE2: 4, FLTMODE3: 5, FLTMODE4: 5, FLTMODE5: 6, FLTMODE6: 7,
  ARMING_SKIPCHK: -1, ARMING_RUDDER: 2, RC_OPTIONS: 0,
  THR_MIN: 0, THR_MAX: 100, THR_SLEWRATE: 100,
  TKOFF_THR_MINACC: 10, TKOFF_THR_DELAY: 2, TKOFF_THR_MINSPD: 0,
  ARSPD_USE: 1, AIRSPEED_MIN: 10, AIRSPEED_MAX: 30,
  RTL_AUTOLAND: 0, ROLL_LIMIT_DEG: 60, PTCH_LIM_MAX_DEG: 30, PTCH_LIM_MIN_DEG: -30,
  STAB_PITCH_DOWN: 2,
};

export const AIRFRAMES: AirframeSpec[] = [
  {
    id: 'a-heewing-t1', name: 'HEEWING T1 Ranger', maker: 'HEEWING', layout: 'vtail',
    spanMm: 730, wingAreaDm2: 10.9, taper: 0.7, sweepDeg: 2, dihedralDeg: 3,
    airfoil: { cl0: 0.28, cd0: 0.013, cm0: -0.05, stallDeg: 13 },
    tail: { hAreaDm2: 2.6, vAreaDm2: 0, armMm: 330, vAngleDeg: 38 },
    fuselage: { lengthMm: 645, widthMm: 62, heightMm: 70, noseMm: 175 },
    motors: { count: 2, mount: 'tractor', xMm: 70, yMm: 135, zMm: 0 },
    throwsDeg: { aileron: 22, ruddervator: 20 },
    airframeMassG: 205, cruiseKmh: 55, staticMargin: 0.1,
    params: { AIRSPEED_CRUISE: 15, AIRSPEED_MIN: 9, AIRSPEED_MAX: 25, TRIM_THROTTLE: 45, RUDD_DT_GAIN: 50 },
    est: ['wing area', 'taper', 'tail area and arm', 'aerofoil'],
    url: 'https://www.getfpv.com/planes/heewing-t-1-ranger-twin-motor-fixed-wing-730mm-rc-hobby-airplane.html',
  },
  {
    id: 'a-atomrc-penguin', name: 'AtomRC Penguin', maker: 'AtomRC', layout: 'flyingwing',
    spanMm: 750, wingAreaDm2: 15.06, taper: 0.45, sweepDeg: 22, dihedralDeg: 4,
    airfoil: { cl0: 0.12, cd0: 0.016, cm0: 0.01, stallDeg: 16 },
    tail: { hAreaDm2: 0, vAreaDm2: 0, armMm: 0 },
    winglets: { areaDm2: 0.7, aftMm: 120, heightMm: 90 },
    fuselage: { lengthMm: 640, widthMm: 90, heightMm: 80, noseMm: 230 },
    motors: { count: 2, mount: 'tractor', xMm: 40, yMm: 150, zMm: 0 },
    throwsDeg: { elevon: 18 },
    airframeMassG: 310, cruiseKmh: 60, staticMargin: 0.07,
    params: { AIRSPEED_CRUISE: 16, AIRSPEED_MIN: 11, AIRSPEED_MAX: 28, TRIM_THROTTLE: 45, RUDD_DT_GAIN: 50 },
    est: ['taper', 'sweep', 'winglets', 'aerofoil', 'airframe mass'],
    url: 'https://www.kiwiquads.co.nz/product/atomrc-penguin-fpv-plane-kit-pnp-rth',
  },
  {
    id: 'a-ar-wing-pro', name: 'SonicModell AR Wing Pro', maker: 'SonicModell', layout: 'flyingwing',
    spanMm: 1000, wingAreaDm2: 18, taper: 0.5, sweepDeg: 28, dihedralDeg: 4,
    airfoil: { cl0: 0.1, cd0: 0.011, cm0: 0.01, stallDeg: 14 },
    tail: { hAreaDm2: 0, vAreaDm2: 0, armMm: 0 },
    winglets: { areaDm2: 0.9, aftMm: 170, heightMm: 110 },
    fuselage: { lengthMm: 420, widthMm: 80, heightMm: 70, noseMm: 160 },
    motors: { count: 1, mount: 'pusher', xMm: -330, yMm: 0, zMm: 0 },
    throwsDeg: { elevon: 16 },
    airframeMassG: 420, cruiseKmh: 70, staticMargin: 0.07,
    params: { AIRSPEED_CRUISE: 19, AIRSPEED_MIN: 12, AIRSPEED_MAX: 35, TRIM_THROTTLE: 40 },
    est: ['taper', 'sweep', 'winglets', 'fuselage', 'aerofoil'],
    url: 'https://www.getfpv.com/sonicmodell-ar-wing-pro-1000mm-wingspan-epp-fpv-flying-wing-rc-airplane-pnp-version.html',
  },
  {
    id: 'a-zohd-talon-gt', name: 'ZOHD Talon GT Rebel', maker: 'ZOHD', layout: 'vtail',
    spanMm: 1000, wingAreaDm2: 14, taper: 0.6, sweepDeg: 3, dihedralDeg: 3,
    airfoil: { cl0: 0.3, cd0: 0.012, cm0: -0.06, stallDeg: 13 },
    tail: { hAreaDm2: 3.2, vAreaDm2: 0, armMm: 420, vAngleDeg: 36 },
    fuselage: { lengthMm: 660, widthMm: 80, heightMm: 85, noseMm: 230 },
    motors: { count: 1, mount: 'pusher', xMm: -170, yMm: 0, zMm: 15 },
    throwsDeg: { aileron: 20, ruddervator: 18 },
    airframeMassG: 470, cruiseKmh: 65, staticMargin: 0.1,
    params: { AIRSPEED_CRUISE: 18, AIRSPEED_MIN: 11, AIRSPEED_MAX: 32, TRIM_THROTTLE: 40 },
    est: ['taper', 'tail area and arm', 'aerofoil', 'airframe mass'],
    url: 'https://eu.robotshop.com/products/zohd-talon-gt-rebel-1000mm-plane',
  },
  {
    id: 'a-volantex-ranger2000', name: 'Volantex Ranger 2000', maker: 'VolantexRC', layout: 'conventional',
    spanMm: 2000, wingAreaDm2: 37, taper: 0.65, sweepDeg: 2, dihedralDeg: 5,
    airfoil: { cl0: 0.35, cd0: 0.011, cm0: -0.07, stallDeg: 12 },
    tail: { hAreaDm2: 5.8, vAreaDm2: 2.8, armMm: 720 },
    fuselage: { lengthMm: 1100, widthMm: 80, heightMm: 95, noseMm: 330 },
    motors: { count: 1, mount: 'pusher', xMm: -150, yMm: 0, zMm: 90 },
    throwsDeg: { aileron: 18, elevator: 16, rudder: 25 },
    airframeMassG: 880, cruiseKmh: 50, staticMargin: 0.1,
    params: { AIRSPEED_CRUISE: 14, AIRSPEED_MIN: 9, AIRSPEED_MAX: 25, TRIM_THROTTLE: 35, KFF_RDDRMIX: 0.5 },
    est: ['wing area', 'taper', 'tail areas and arm', 'aerofoil'],
    url: 'https://hobbyrc.co.uk/volantexrc-ranger-2000mm-fpv-plane-pnp',
  },
];

export const airframeById = (id: string) => AIRFRAMES.find((a) => a.id === id);
export const isAirframe = (id: string) => AIRFRAMES.some((a) => a.id === id);
