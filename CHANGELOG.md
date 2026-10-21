# Changelog

Notable changes to FPV Sim, newest first. The app is deployed continuously from `main`, so entries
are grouped by date; the version shown in the menu footer and the About screen comes from the
build (`VITE_APP_VERSION` / `VITE_APP_COMMIT`), and reads "dev" on a local dev server.

## Unreleased

### Onboarding and HUD
- **Arming coach**: while disarmed, a card turns Betaflight's arming-disable flag into one plain
  sentence and the fix ("The throttle isn't all the way down. Pull the throttle fully down, then
  arm."), with the flag name the OSD shows. New pilots also get the first-flight steps (throttle
  down, arm, ease up). It is placed around the OSD like every HUD widget, never over it.
- Keyboard flying keys (W/S throttle, A/D yaw, arrow keys pitch/roll) in the key hints, the
  no-controller notice and the guide's controls table; "Respawn" and "Fresh battery" used
  consistently.
- The training telemetry overlay is off by default (H or D-pad ↓ shows it).
- Race card: a short flash when a lap completes and "NEW BEST" on a faster lap. In a multiplayer
  room on a map without gates, the room roster is shown instead of nothing.
- Phones and tablets without a gamepad: "Desktop + controller needed" on the title screen, a
  warning before flying, and the HUD's Menu hint is a button that opens the pause menu.
- HUD widgets are only rebuilt when what they show changes, and the pilot's name/color is cached
  instead of read from storage every frame.

### Menus
- About screen: version and commit, GPL-3.0 notice with the no-warranty text, source link,
  third-party notices (`/licenses.txt`), privacy notice (`/privacy.html`) and a non-affiliation
  statement.
- Footer: version, **Report a bug** (a GitHub issue prefilled with version, browser, GPU and
  controller), **Fullscreen** toggle (F11 hint).
- The title screen fits 1280×720: the guide entry and the tip card are above the fold.
- Race mode only on maps with gates; gateless maps can't be picked for it.
- The guide's "Fly a hover drill" starts the hover drill, and pause → Respawn restarts the mode you
  are actually flying.
- Settings show the effective glass-to-glass latency of your video system on your display, with a
  120 Hz+ display recommendation.

### Safer settings
- Betaflight tab: confirm before **Write & save** (it reboots the flight controller) and before
  **Apply to simulated FC**; the current `diff all` is backed up first and **Restore backup**
  replays it. New confirmed **Restore sim defaults**. Unsaved slider edits are marked and the
  menu asks before throwing them away. Rates show °/s (not "×10 °/s"), idle shows rpm and %.
- Drone builder: confirm before a component change resets slider overrides, before Load preset
  replaces the build, and before leaving with unapplied changes.

### Accessibility and polish
- Live regions only on notices, the coach and the crash banner; screen names as labels; mode, map
  and drone pickers are radio groups; slider help is visible text; 13 px minimum text; placeholder
  contrast above 4.5:1; photosensitivity note in the guide and next to Video link degradation.
- en-US spelling throughout the UI; the "Host a room" button icon is the right size again.
- Loading splash instead of a black screen while Betaflight and the map load, `<noscript>` text,
  meta description, Open Graph / Twitter cards with a 1200×630 preview image, canonical URL,
  robots.txt, sitemap.xml, web app manifest and favicon.ico.

## 2026-10-21

- `main.ts` split into app modules (worker bridge, frame loop, HUD controller, instruments,
  race), with no behavior change.
- Security: map ids such as `constructor` or `__proto__` from other pilots or storage can no
  longer crash clients. Steam Controller button names in the hints.
- Crash banner from 4 m/s impacts, naming the damage.
- Favicon and Apple touch icon from the menu logo.
- Controller buttons for fresh battery (B), camera, telemetry, hover drill and noise spectrum
  (D-pad); the HUD legend shows the controller's real button names.
- FPV video: no banding on Macs (explicit LOD for interlace / macroblock reads), no blocky halos or
  flat-white windows indoors.
- Menu-styled HUD laid out around the Betaflight OSD; frozen digital video, prop clipping,
  brightness and camera angle fixes.
- Drone builder: Apply & respawn pinned in a sticky action bar with an unapplied-changes marker.

## 2026-10-20

- Realism pass: rotor aerodynamics, collisions and damage, wind, frame vibration, battery, video
  link and audio.
- Game menu: title screen, New game (local / multiplayer), server browser, settings, pause menu
  and the nine-chapter Betaflight quick start guide; fully usable with a controller.
- Live RSSI dBm on the OSD; the firmware is cache-busted so a stale copy never runs.
- Simulated RC link (ELRS-style) feeding real LQ / RSSI to Betaflight.
- Beginner presets: 65 mm and 75 mm tiny whoops, 3" cinewhoop.
- The open **fpvsim-map v1** map format, loader, validator and community maps (Quarry Loop).
- The FPV World Cup Stadium replaces the open field, with a glowing next gate.
- Freedoom MAP01 and Quake E1M1 / DM3 as freestyle maps.
- Peak impact speed reported for each crash.
- Live multiplayer rooms and Betaflight `diff all` import ("Bring your real quad").
- Xbox, PlayStation 5 DualSense and DJI FPV Remote Controller 3 support.
- First version (0.1.0): the real Betaflight 4.5.5 firmware compiled to WebAssembly, in lock-step
  with an 8 kHz physics, electrical and sensor model of a quad built from component specs.
