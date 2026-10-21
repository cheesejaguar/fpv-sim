# Changelog

Notable changes to FPV Sim, newest first. The app is deployed continuously from `main`, so entries
are grouped by date; the version shown in the menu footer and the About screen comes from the
build (`VITE_APP_VERSION` / `VITE_APP_COMMIT`), and reads "dev" on a local dev server.

## Unreleased

### Lap replays
- **Replay permalinks**: `/?replay=<entry id>` opens a leaderboard lap's replay straight from a link,
  and `&t=<seconds>` starts it at that moment. The address bar shows the link while a board replay
  plays; **Copy link** in the player copies it (at the paused moment, when paused mid-lap), and the
  phone share page has **Watch the replay**.
- The player's **Video link** switch takes effect at once, also while paused, and switches to the
  FPV camera (the only view it changes).
- **Every timed lap is recorded**, from just before gate 0 to just after the finish: the flight
  path and attitude, motor speeds, the sticks Betaflight received, armed state and flight mode,
  battery, every gate's time and Betaflight's OSD, in a compact `.fpvreplay` file (about
  40 KB for a one-minute lap). Your personal best's replay on each board is kept in the browser.
- **Watch** any leaderboard lap posted with a replay, your own best (also offline, posted or not),
  or the last lap you flew (pause menu → **Replay last lap**). Replays can be downloaded and
  opened from a file.
- **A full replay player**: play / pause, a timeline with the gate splits to scrub, 0.1× to 4×,
  frame step, restart and loop; FPV through the real camera (fisheye, rolling shutter, the
  recorded OSD, optional video-link breakup), chase, line of sight and an orbit camera; stick,
  speed / altitude, split and battery overlays; motor sound at 1×. Keyboard and controller
  shortcuts are shown in the player. The live session waits paused behind it and comes back as it
  was.
- **Laps are posted with their replay**, and the relay checks that the replay really flies the
  lap: each gate's opening passed in order at its split time, no jumps, and speed and acceleration
  the drone class can manage. A faster lap now replaces your entry with a new one. Entries posted
  before replays show "No replay". The privacy notice says what a replay contains: it is public.

### Share your lap to Instagram Stories
- **Share** a personal best as a 9:16 card, from the post-your-lap card, the pause menu, the
  posted-lap screen and your own leaderboard rows.
  - Five styles: stats, a studio render of your drone, the FPV moment (your goggle view with
    its OSD as the lap finished), a track map with your splits, and the leaderboard's top 5.
  - Three colour themes.
- On a phone, **Share to Instagram** opens the share sheet. On a desktop, download the PNG,
  copy it, or use **Send to my phone**: a QR code opens a light page that draws the same cards on
  the phone, ready for Instagram.
- Cards are drawn on your device and the QR code is made there too: nothing is uploaded unless
  you share it. The phone link shows the lap's public leaderboard entry (privacy notice updated).
- Relay: `GET /leaderboard/entry/:id` (one entry, its rank and the board's top 5).

### Flight feel (from a pilot flying a tiny whoop with an ExpressLRS radio)
- **No more phantom roll in Angle mode.** Whoops fell over onto one duct on the pad, and the
  accelerometer was calibrated on that 13° tilt, so Angle mode held it as "level" and drifted.
  Whoops now stand on their duct guards, the accelerometer is calibrated on a level, still quad
  (and again whenever the build's sensors change), and every existing calibration is redone once.
- **No more yaw snaps from slow radios.** A BLE radio reaches the browser at 40–90 Hz; the RC link
  repeated each report until the next one jumped, and Betaflight's feedforward spiked on every
  jump. Sticks are now reconstructed between reports (a few ms of extra delay on slow inputs only).
- Small quads no longer rattle or bounce on hard ground, at any physics rate.
- **Radios are never treated as gamepads.** ExpressLRS in BLE joystick mode, EdgeTX / OpenTX
  radios over USB and other transmitters some browsers label "standard gamepad" got the Xbox
  layout: an arm switch could drive roll and the throttle scrolled the menus. A radio now flies
  only after its stick & switch setup (the HUD says so), with no deadzone, as on a real quad; in
  menus it steers with its calibrated right stick only, and the mouse wheel silences a held stick.

### Maps
- New: **Whoop Gym** (indoor, no wind, thin whoop gates; the first map for new pilots),
  **Practice Field** (spec track plus slalom, figure-8 and power-loop drills, picked under
  Simulation → Course), **Meadow Park**, **Ridgeline** (4 × 4 km long range) and **Night Session**.
- The stadium is now the **FPV Grand Prix Stadium**. Maps can have a night sky and point lights.
- Simulation → **Time of day**: morning, noon, golden hour, dusk or night on any map.

### Firmware and simulation
- Betaflight changes saved in the CLI survive reloads; boot-time messages are queued; a crashed
  simulator restarts itself once, then shows an error page with a bug-report link.
- Rebuilt Betaflight: real accelerometer calibration, BMI270 at 3.2 kHz, beeper and DShot beacon
  sounds, a downloadable `.bbl` blackbox for Blackbox Explorer / PIDtoolbox, GPS (and GPS Rescue),
  barometer noise, eRPM and current-sensor errors, 1S brownout reboots and real CPU load.
- Physics: rotor drag and hub moments, ESC current limit off by default (as ESCs ship),
  low-rpm protection, frame vibration modes, thermal damage, battery fast-transient sag and cold
  derating, motor desyncs, IMU offsets and board tilt. The physics rate drops automatically when
  the computer can't keep up (a setting).

### Camera and video
- The quad's own shadow, sun glare and lens ghosts, motion blur from the real shutter time,
  anti-aliasing, camera jello from prop vibration and damage, sensor noise that grows in the dark,
  prop discs that look like the camera sees them, a crisper HD OSD, and the goggles' own overlay
  (signal, bitrate, DVR; a setting). **V** records the goggle feed with sound (DVR).
- FPV renders at the video's own resolution on high-density displays and only redraws on new
  camera frames: much less GPU work on Retina screens.

### World and sound
- Trees, flags and a windsock that move with the wind, ground detail, spectators, night lighting.
- Motor sound with distance, Doppler, reverb indoors, the other pilots' quads, and Betaflight's own
  beeper. Sound mutes in the menus and in background tabs.

### Multiplayer
- Rooms are unlisted unless made public; dropped connections rejoin by themselves; paused pilots
  stay in the room, parked; tighter relay limits and validation (protocol v2, old clients still
  work).

### Reliability, privacy and security
- Browser check with a clear page when something required is missing; versioned, validated saved
  settings with a reset button; the simulation pauses in background tabs.
- Content Security Policy and security headers; a fix for Safari, which could refuse to start the
  simulator after a reload (cached files lost their cross-origin isolation headers).
- Third-party notices (`/licenses.txt`) and a privacy notice (`/privacy.html`).

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
