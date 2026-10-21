#!/usr/bin/env node
// Writes THIRD_PARTY_NOTICES and public/licenses.txt (served at /licenses.txt): every third-party
// component the site ships or is built from, its copyright and license, a non-affiliation /
// trademark notice, and the full license texts. Runs before `npm run build` (prebuild).
//   node scripts/build-licenses.mjs           write both files
//   node scripts/build-licenses.mjs --check   exit 1 if either committed file is stale (CI)
// License texts come from the installed packages (node_modules), the vendored map folders under
// public/maps, and scripts/licenses/ (verbatim upstream texts of components that aren't packages).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p) => readFileSync(join(ROOT, p), 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trimEnd();
/** An installed package's folder (node_modules here or in a parent folder, like Node's resolution). */
function modDir(name) {
  for (let d = ROOT; ; d = dirname(d)) {
    const p = join(d, 'node_modules', name);
    if (existsSync(join(p, 'package.json'))) return p;
    if (dirname(d) === d) throw new Error(`${name} is not installed: run npm ci`);
  }
}
const readMod = (name, file) => readFileSync(join(modDir(name), file), 'utf8').replace(/\r\n/g, '\n').trimEnd();
const pkg = (name) => JSON.parse(readMod(name, 'package.json')).version;
/** The GPL-3.0 text, without the project's copyright header at the top of LICENSE. */
const gpl3 = () => { const t = read('LICENSE'); return t.slice(t.lastIndexOf('\n', t.indexOf('GNU GENERAL PUBLIC LICENSE')) + 1); };

const COMPONENTS = [
  {
    name: 'Betaflight flight controller firmware 4.5.5 (compiled to WebAssembly)',
    files: '/bf/betaflight.wasm, /bf/betaflight.mjs',
    copyright: 'Copyright (C) the Betaflight, Cleanflight and Baseflight contributors',
    license: 'GPL-3.0-or-later',
    source: 'https://github.com/betaflight/betaflight (tag 4.5.5), built with the hardware layer and patches in this repository\'s firmware/bfwasm/ (see firmware/README.md)',
    text: 'GPL-3.0',
  },
  {
    name: 'Betaflight OSD fonts (MAX7456 .mcm) from betaflight-configurator',
    files: '/fonts/*.mcm',
    copyright: 'Copyright (C) the Betaflight Configurator contributors',
    license: 'GPL-3.0',
    source: 'https://github.com/betaflight/betaflight-configurator, resources/osd/2/ at commit fac7d21d0746614fde43b580450bdbb3c932c2a2 (scripts/fetch-fonts.mjs)',
    text: 'GPL-3.0',
  },
  {
    name: 'Emscripten 4.0.10 runtime (JavaScript loader and support code in the firmware build)',
    files: '/bf/betaflight.mjs, /bf/betaflight.wasm',
    copyright: 'Copyright (c) 2010-2014 Emscripten authors',
    license: 'MIT (Emscripten is dual-licensed MIT / University of Illinois NCSA; used here under MIT)',
    source: 'https://github.com/emscripten-core/emscripten (tag 4.0.10)',
    text: 'Emscripten',
  },
  {
    name: 'musl libc (as bundled with Emscripten 4.0.10, compiled into the firmware build)',
    files: '/bf/betaflight.wasm',
    copyright: 'Copyright (c) 2005-2020 Rich Felker, et al.',
    license: 'MIT',
    source: 'https://musl.libc.org/ (via emscripten system/lib/libc/musl)',
    text: 'musl',
  },
  {
    name: `three.js ${pkg('three')}`,
    files: '/assets/three-*.js and the application bundle (three/examples loaders)',
    copyright: 'Copyright (c) 2010-2026 three.js authors',
    license: 'MIT',
    source: 'https://github.com/mrdoob/three.js',
    text: 'three.js',
  },
  {
    name: `Russo One typeface (@fontsource/russo-one ${pkg('@fontsource/russo-one')})`,
    files: '/assets/russo-one-*.woff, *.woff2',
    copyright: 'Copyright (c) 2011-2012, Jovanny Lemonad (lemonad@jovanny.ru), with Reserved Font Name "Russo"',
    license: 'OFL-1.1',
    source: 'https://fontsource.org/fonts/russo-one',
    text: 'Russo One',
  },
  {
    name: `Chakra Petch typeface (@fontsource/chakra-petch ${pkg('@fontsource/chakra-petch')})`,
    files: '/assets/chakra-petch-*.woff, *.woff2',
    copyright: 'Copyright 2018 The Chakra Petch Project Authors (https://github.com/m4rc1e/Chakra-Petch.git)',
    license: 'OFL-1.1',
    source: 'https://fontsource.org/fonts/chakra-petch',
    text: 'Chakra Petch',
  },
  {
    name: 'Lucide icons (icon paths copied verbatim into the menu, src/ui/menu/icons.ts)',
    files: 'the application bundle',
    copyright: 'Copyright (c) 2026 Lucide Icons and Contributors; icons derived from Feather: Copyright (c) 2013-present Cole Bemis',
    license: 'ISC; the Feather-derived icons also MIT',
    source: 'https://lucide.dev, https://github.com/lucide-icons/lucide',
    text: 'Lucide',
  },
  {
    name: 'SDL (Simple DirectMedia Layer): Steam Controller HID protocol',
    files: 'the application bundle (src/input/steamHid.ts)',
    copyright: 'Copyright (C) 1997-2026 Sam Lantinga <slouken@libsdl.org>',
    license: 'Zlib',
    source: 'https://github.com/libsdl-org/SDL (src/joystick/hidapi/SDL_hidapi_steam_triton.c, controller_structs.h). The report layouts and commands documented there informed this project\'s own TypeScript driver; no SDL code is included. Acknowledged with thanks.',
    text: 'SDL',
  },
  {
    name: 'Quake level sources: E1M1 "The Slipgate Complex" and DM3 "The Abandoned Base"',
    files: '/maps/quake/e1m1.map, /maps/quake/dm3.map',
    copyright: 'Copyright (C) 1996 id Software; released by John Romero in 2006 under the terms of the GPL',
    license: 'GPL (no version named, so any version may be chosen: GPL-2.0 text shipped with the release; used here under GPL-3.0-or-later)',
    source: 'https://rome.ro/s/1996-quake-map-sources.zip (see /maps/quake/ATTRIBUTION.md)',
    text: 'GPL-2.0',
  },
  {
    name: 'LibreQuake textures (used for the Quake maps)',
    files: '/maps/quake/textures/',
    copyright: 'Copyright (C) 2019-2023 Contributors to the LibreQuake project (some textures derive from the Freedoom and Blasphemer projects)',
    license: 'BSD-3-Clause',
    source: 'https://github.com/lavenderdotpet/LibreQuake (texture-wads/, commit dd4d5bf)',
    text: ['LibreQuake', 'Blasphemer', 'Freedoom (in LibreQuake)'],
  },
  {
    name: 'Freedoom Phase 2 MAP01 "Hydroelectric Plant" and its textures',
    files: '/maps/freedoom/',
    copyright: 'Copyright (C) 2001-2024 Contributors to the Freedoom project',
    license: 'BSD-3-Clause',
    source: 'https://freedoom.github.io (see /maps/freedoom/ATTRIBUTION.md)',
    text: 'Freedoom',
  },
  {
    name: 'UI UX Pro Max design system (style, palette, typography and motion presets of the menu theme)',
    files: 'the application stylesheet (src/ui/menu/theme.css, src/ui/hud/hud.css)',
    copyright: 'Copyright (c) 2024 Next Level Builder',
    license: 'MIT',
    source: 'https://uupm.cc, https://github.com/nextlevelbuilder/ui-ux-pro-max-skill',
    text: 'UI UX Pro Max',
  },
];

const TEXTS = {
  'GPL-3.0': ['GNU General Public License v3.0 (Betaflight, Betaflight OSD fonts; also this project\'s own license)', gpl3],
  'GPL-2.0': ['GNU General Public License v2.0 (as shipped with the Quake map source release)', () => read('public/maps/quake/COPYING-GPL-2.0.txt')],
  Emscripten: ['Emscripten license (MIT / NCSA)', () => read('scripts/licenses/emscripten-MIT.txt')],
  musl: ['musl libc copyright and license (MIT)', () => read('scripts/licenses/musl-MIT.txt')],
  'three.js': ['three.js license (MIT)', () => readMod('three', 'LICENSE')],
  'Russo One': ['Russo One: SIL Open Font License 1.1', () => readMod('@fontsource/russo-one', 'LICENSE')],
  'Chakra Petch': ['Chakra Petch: SIL Open Font License 1.1', () => readMod('@fontsource/chakra-petch', 'LICENSE')],
  Lucide: ['Lucide license (ISC; Feather-derived icons MIT)', () => read('scripts/licenses/lucide-ISC.txt')],
  SDL: ['SDL license (zlib)', () => read('scripts/licenses/sdl-Zlib.txt')],
  LibreQuake: ['LibreQuake license (BSD-3-Clause)', () => read('public/maps/quake/textures/LICENSE-LibreQuake.txt')],
  Blasphemer: ['Blasphemer license (BSD-3-Clause), for LibreQuake textures derived from Blasphemer', () => read('public/maps/quake/textures/LICENSE-Blasphemer.md')],
  'Freedoom (in LibreQuake)': ['Freedoom license as shipped with LibreQuake (BSD-3-Clause), for LibreQuake textures derived from Freedoom', () => read('public/maps/quake/textures/LICENSE-Freedoom.adoc')],
  Freedoom: ['Freedoom license (BSD-3-Clause)', () => read('public/maps/freedoom/COPYING.txt')],
  'UI UX Pro Max': ['UI UX Pro Max license (MIT)', () => read('scripts/licenses/ui-ux-pro-max-MIT.txt')],
};

const NOTICE = `FPV Sim: third-party notices
============================

FPV Sim (https://github.com/cheesejaguar/fpv-sim) is free software: you can redistribute it and/or
modify it under the terms of the GNU General Public License, version 3 or (at your option) any later
version. See LICENSE. Copyright (C) 2026 FPV Sim contributors.

The site ships, or is built from, the third-party components listed below. Each one keeps its own
copyright and license; their full license texts follow the list.

This file is generated by scripts/build-licenses.mjs. The deployed site serves the same text at
/licenses.txt. Do not edit it by hand.


Trademarks and non-affiliation
------------------------------

FPV Sim is an independent, non-commercial open-source project. It is not affiliated with, sponsored
by or endorsed by the Betaflight project, id Software, ZeniMax Media, Bethesda Softworks or
Microsoft, John Romero, the LibreQuake, Freedoom or Blasphemer projects, Valve Corporation, the SDL
project, or any manufacturer of the drones, components, radios or video systems modelled in the
simulator.

Betaflight, Quake, Steam, Steam Controller and the names of real drone components, radio links and
video systems (for example DJI, HDZero, Walksnail and ExpressLRS) are trademarks of their respective
owners. They are used only to identify compatible software and hardware, or where content comes
from. Component data in the drone builder is approximate and not supplied or approved by any
manufacturer.
`;

function build() {
  const out = [NOTICE, '', 'Components', '----------', ''];
  COMPONENTS.forEach((c, i) => {
    out.push(`${i + 1}. ${c.name}`,
      `   Files:     ${c.files}`,
      `   Copyright: ${c.copyright}`,
      `   License:   ${c.license}`,
      `   Source:    ${c.source}`,
      '');
  });
  // community maps: each package carries its own attribution
  const dir = join(ROOT, 'public/maps/community');
  const community = existsSync(dir) ? readdirSync(dir).sort().filter((id) => existsSync(join(dir, id, 'ATTRIBUTION.md'))) : [];
  if (community.length) {
    out.push(`${COMPONENTS.length + 1}. Community map packages (/maps/community/<id>/), each under the license in its own ATTRIBUTION.md:`, '');
    for (const id of community) out.push(...read(`public/maps/community/${id}/ATTRIBUTION.md`).split('\n').map((l) => `   ${l}`.trimEnd()), '');
  }
  out.push('', 'License texts', '=============', '');
  const used = [...new Set(COMPONENTS.flatMap((c) => [c.text].flat()))];
  for (const k of used) {
    const [title, text] = TEXTS[k];
    out.push('-'.repeat(100), title, '-'.repeat(100), '', text(), '', '');
  }
  return out.join('\n').trimEnd() + '\n';
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = build();
  const targets = ['THIRD_PARTY_NOTICES', 'public/licenses.txt'];
  if (process.argv.includes('--check')) {
    const stale = targets.filter((t) => !existsSync(join(ROOT, t)) || readFileSync(join(ROOT, t), 'utf8') !== text);
    if (stale.length) { console.error(`stale: ${stale.join(', ')}. Run: node scripts/build-licenses.mjs`); process.exit(1); }
    console.log('third-party notices are up to date');
  } else {
    for (const t of targets) writeFileSync(join(ROOT, t), text);
    console.log(`licenses: ${COMPONENTS.length} components -> ${targets.join(', ')}`);
  }
}
