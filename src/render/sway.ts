// Wind animation and LOD shared by the world's foliage, cloth and crowd: one set of uniforms per
// scene (set by SceneBundle.setWind / the LOD hook), injected into stock three.js materials with
// onBeforeCompile so lighting, shadows and fog stay three's own. All motion is visual only: the
// collision volumes (world.ts) stay where they are, and the sway is centimetres to a few decimetres.
import * as THREE from 'three';

export interface WorldUniforms {
  /** xy = air flow direction (three x, z; unit), z = strength (0 calm .. ~1.8 gale), w = time (s) */
  uWind: { value: THREE.Vector4 };
  /** LOD centre: the rendering camera's position (set before every render, shadow pass included) */
  uLod: { value: THREE.Vector3 };
}
/**
 * userData flag of a camera that must not move the LOD centre: the FPV camera's shadow-refresh
 * render looks at nothing from far away, and binning the trees around it hid every near tree (and
 * its shadow) just before the shadow pass. The LOD stays where the last real camera put it.
 */
export const NO_LOD = 'noLodCentre';
export const makeWorldUniforms = (): WorldUniforms => ({ uWind: { value: new THREE.Vector4(1, 0, 0.35, 0) }, uLod: { value: new THREE.Vector3() } });

/** Visual wind strength from a wind speed (m/s): 1 at a stiff 8 m/s breeze, capped at a gale. */
export const windStrength = (speedMs: number) => Math.max(0, Math.min(1.8, speedMs / 8));
/** Air flow direction (three x, z) for a meteorological direction (deg the wind blows FROM, 0 = north). */
export function flowDir(fromDeg: number): [number, number] {
  const a = (fromDeg * Math.PI) / 180;
  return [-Math.sin(a), Math.cos(a)]; // ENU flow (-sin, -cos) -> three (x, -y)
}

/** Near trees dissolve into their far stand-ins over this band (m from the camera). */
export const TREE_FADE: [number, number] = [72, 90];

// sin-free hash (stable for large arguments)
const COMMON = /* glsl */ `
uniform vec4 uWind;
uniform vec3 uLod;
float swHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
`;
// interleaved gradient noise: screen-door threshold for the LOD dissolve
const IGN = 'fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))))';

export type SwayKind = 'tree' | 'grass' | 'pebble' | 'flag' | 'crowd';

export interface PatchOptions {
  /** trees: which side of the near / far dissolve this mesh is */
  fade?: 'near' | 'far';
  /** depth material for shadows: no screen-door fade (a fading tree still shadows normally) */
  depth?: boolean;
  /** alpha-tested cards: texture size, to keep coverage as mips average the alpha away */
  alphaMips?: number;
  /** two-sided cards lit with their own (crown-radial) normals on both faces */
  noNormalFlip?: boolean;
}

/**
 * Vertex code per kind. pre: after the normal is set up (or first, without normals), with `normal`
 * code only where the program has normals; begin: after `transformed`; project: replaces three's
 * projection (world-space displacement after instancing).
 *
 * Trees: attribute iTree = (base x, y, z (three), height) per instance; aTq >= 0 marks trunk
 * vertices, stretched from the ground (q = 0) to the canopy centre (q = 1); aLeaf = flutter. The
 * bend grows with height² like a cantilever.
 */
interface VertexCode { pars: string; pre?: string; normal?: string; begin?: string; project?: string; color?: string }
const VERTEX: Record<SwayKind, VertexCode> = {
  tree: {
    pars: 'attribute vec4 iTree; attribute float aTq; attribute float aLeaf; varying float vFade;',
    begin: 'if (aTq > -0.5) transformed.y = (aTq - 1.0) * 0.62 * iTree.w / length(instanceMatrix[0].xyz);',
    project: /* glsl */ `
      vec4 swP = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
      float swQ = clamp((swP.y - iTree.y) / iTree.w, 0.0, 1.2), swPh = dot(iTree.xz, vec2(0.173, 0.291));
      float swS = uWind.z, swT = uWind.w;
      float swB = swS * (0.6 + 0.28 * sin(swT * 0.83 + swPh) + 0.12 * sin(swT * 2.1 + swPh * 2.3));
      swP.xz += uWind.xy * (swB * 0.02 * iTree.w * swQ * swQ);
      float swF = sin(swT * (5.0 + 4.0 * swS) + dot(swP.xyz, vec3(2.1, 1.7, 2.9))) * (0.012 + 0.035 * swS) * aLeaf;
      swP.xyz += vec3(-uWind.y, 0.7, uWind.x) * swF;
      vec4 mvPosition = viewMatrix * swP;
      gl_Position = projectionMatrix * mvPosition;
      vFade = distance(uLod, iTree.xyz + vec3(0.0, 0.5 * iTree.w, 0.0));`,
  },
  grass: {
    // tufts shrink away beyond ~25 m from the camera (no aliasing blades, no cost far out)
    pars: '',
    begin: 'transformed *= smoothstep(28.0, 18.0, distance(uLod, (modelMatrix * instanceMatrix[3]).xyz));',
    project: /* glsl */ `
      vec4 swP = modelMatrix * instanceMatrix * vec4(transformed, 1.0);
      float swH = max(transformed.y, 0.0) * length(instanceMatrix[1].xyz), swPh = dot(instanceMatrix[3].xz, vec2(0.71, 0.37));
      swP.xz += uWind.xy * uWind.z * swH * swH * (1.2 + 0.5 * sin(uWind.w * (2.5 + uWind.z * 2.0) + swPh));
      vec4 mvPosition = viewMatrix * swP;
      gl_Position = projectionMatrix * mvPosition;`,
  },
  pebble: {
    pars: '',
    begin: 'transformed *= smoothstep(30.0, 20.0, distance(uLod, (modelMatrix * instanceMatrix[3]).xyz));',
  },
  flag: {
    // cloth in its local frame (three axes): banner in the y-z plane, aFlag.x = 0 at the pole .. 1
    // at the free edge (uFlagLen along +z), aFlag.y = 0 .. 1 bottom to top: a travelling wave that
    // grows towards the free edge, faster and bigger in stronger wind
    pars: 'attribute vec2 aFlag; uniform float uFlagLen;',
    pre: /* glsl */ `
      float flS = uWind.z, flU = aFlag.x;
      float flPh = 7.0 * flU - uWind.w * (5.0 + 7.0 * flS) - dot(modelMatrix[3].xz, vec2(0.3, 0.7)) + aFlag.y * 1.3;
      float flAmp = 0.02 + 0.07 * flS, flE = pow(max(flU, 1e-3), 0.3);
      float flDisp = flAmp * flE * flU * sin(flPh);
      float flD = flAmp * (1.3 * flE * sin(flPh) + flE * flU * 7.0 * cos(flPh)) / uFlagLen;`,
    normal: 'objectNormal = normalize(vec3(1.0, 0.0, -flD));',
    begin: 'transformed.x += flDisp;',
  },
  crowd: {
    // aPart: x = skin (head), y = trousers, z = raised arm (crowd.ts draws arms only for those who
    // raise them); some bob up and down
    pars: 'attribute vec3 aPart;',
    begin: /* glsl */ `
      float crPh = swHash(instanceMatrix[3].xz);
      transformed.y += step(0.8, crPh) * max(0.0, sin(uWind.w * (6.0 + 3.0 * crPh) + crPh * 40.0)) * 0.06;`,
    color: /* glsl */ `
      #ifdef USE_INSTANCING_COLOR
        float crH = swHash(instanceMatrix[3].xz * 1.7 + 3.1);
        vColor.rgb = mix(vColor.rgb, mix(vec3(0.95, 0.72, 0.56), vec3(0.32, 0.2, 0.13), crH * crH), aPart.x);
        vColor.rgb = mix(vColor.rgb, mix(vec3(0.06, 0.07, 0.1), vec3(0.25, 0.27, 0.32), crH), aPart.y);
      #endif`,
  },
};

/** Inject the wind / LOD code of `kind` into a three.js material (standard or depth). */
export function patchMaterial<M extends THREE.Material>(mat: M, u: WorldUniforms, kind: SwayKind, opts: PatchOptions = {}, extraUniforms: Record<string, { value: unknown }> = {}): M {
  const v = VERTEX[kind];
  const key = `sway:${kind}:${opts.fade ?? ''}:${opts.depth ? 1 : 0}:${opts.alphaMips ?? ''}:${opts.noNormalFlip ? 1 : 0}`;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uWind = u.uWind; sh.uniforms.uLod = u.uLod;
    Object.assign(sh.uniforms, extraUniforms);
    let vs = sh.vertexShader.replace('#include <common>', '#include <common>\n' + COMMON + v.pars);
    // standard programs set the normal up before the position; the depth program has no normals
    const normals = vs.includes('#include <defaultnormal_vertex>');
    if (normals) {
      if (v.pre) vs = vs.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n' + v.pre + (v.normal ?? ''));
      if (v.begin) vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + v.begin);
    } else vs = vs.replace('#include <begin_vertex>', '#include <begin_vertex>\n' + (v.pre ?? '') + (v.begin ?? ''));
    if (v.project) vs = vs.replace('#include <project_vertex>', v.project);
    if (v.color) vs = vs.replace('#include <color_vertex>', '#include <color_vertex>\n' + v.color);
    sh.vertexShader = vs;
    let fs = sh.fragmentShader;
    if (opts.alphaMips) {
      // Golus' trick: scale alpha with the mip level so alpha-tested cards keep their coverage
      fs = fs.replace('#include <alphatest_fragment>', /* glsl */ `
        #ifdef USE_MAP
          vec2 amT = vMapUv * ${opts.alphaMips.toFixed(1)};
          float amL = max(0.0, 0.5 * log2(max(dot(dFdx(amT), dFdx(amT)), dot(dFdy(amT), dFdy(amT)))));
          diffuseColor.a *= 1.0 + amL * 0.3;
        #endif
        #include <alphatest_fragment>`);
    }
    if (opts.fade && !opts.depth) {
      // complementary screen-door dissolve: the near and far versions never draw the same pixel
      const f = `smoothstep(${TREE_FADE[1].toFixed(1)}, ${TREE_FADE[0].toFixed(1)}, vFade)`;
      fs = fs.replace('#include <common>', '#include <common>\nvarying float vFade;')
        .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>\n if (${IGN} ${opts.fade === 'near' ? '>=' : '<'} ${f}) discard;`);
    }
    if (opts.noNormalFlip) fs = fs.replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''));
    sh.fragmentShader = fs;
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}
