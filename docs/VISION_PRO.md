# Apple Vision Pro

`visionos/` is a native visionOS app that runs FPV Sim fully offline: nothing is loaded from the
network, and the page inside it is not allowed to connect anywhere but the app itself.

It is a hybrid:

- **The simulator core is unchanged.** The real Betaflight / ArduPilot WebAssembly, the 8 kHz physics,
  the drone builder, menus, settings, laps and audio run in a `WKWebView` in the app's window, served
  from inside the app bundle by a loopback HTTP server (`LocalServer.swift`). The window is the
  simulator as you know it from the browser, and flies there too.
- **The immersive view is native.** "Fly immersive" opens an immersive space drawn by RealityKit in
  stereo. The page exports its Three.js scene as a binary blob (`src/visionos/sceneExport.ts`), streams
  the quad's state from the physics ring at ~120 Hz, and reports what moves or changes look (props,
  gate highlights, actors). The native side rebuilds the meshes, extrapolates the pose to its own frame
  and places the world around you. While it draws, the page skips its WebGL passes.

Every map source therefore works without a native loader: built-in maps, Quake `.map`, Freedoom, map
packages, glTF meshes.

## Views

| View | What you see |
| --- | --- |
| FPV | Through the quad's lens (camera uptilt included). The world moves around you; turning your head looks around from the quad. The Betaflight OSD floats in front of your eyes. |
| Line of sight | You stand where the pilot stands, at 1:1, and watch the quad fly. |
| Tabletop | The course as a 1.2 m model in your room (mixed immersion). |

"Recentre" puts the view where you are now. FPV in a headset moves the horizon without moving you:
start with a tiny whoop in angle mode, or with Line of sight.

## Controller

Pair a Bluetooth gamepad (Xbox, DualSense, …) in visionOS Settings. The app reads it with the
GameController framework and hands it to the page as a standard Gamepad, so the Controller tab, the
stick wizard and menu navigation work as in a browser. USB radios (DJI RC 3, EdgeTX joystick mode)
need a wired USB connection the headset does not have; a radio that pairs as a Bluetooth gamepad works.

## Build

```bash
visionos/build-web.sh          # builds the web core into visionos/WebBundle/ (once, and after src/ changes)
open visionos/FPVSim.xcodeproj # pick the Apple Vision Pro simulator or your device, set a signing team, Run
```

Needs Xcode 16 or later and visionOS 2 or later.

## What differs from the browser

- No multiplayer, global leaderboard or user-map downloads: there is no network. Personal bests,
  replays, the map builder and local map packages work.
- The immersive view shows the true state: no emulated video latency, analog noise, fisheye or
  breakup (the window still has them).
- Shader-only looks do not cross: the procedural sky (an equirectangular gradient with the sun
  stands in, and lights the scene), fog, bloom, the ground's anti-repeat shading, wind sway, grass
  clutter. Trees are low-poly solids instead of leaf cards. Additive glows are plain see-through colour.
- The window has to stay open while you fly immersive: it is the simulator.

## How the pieces talk

| Direction | Channel | Content |
| --- | --- | --- |
| page → app | `POST /__native/scene?part=world\|drone` | the scene blob (`'FPVS'`, JSON header, 4-byte aligned buffers) |
| page → app | `webkit.messageHandlers.fpvNative` | `s` state, `d` transforms / visibility, `m` tints, `osd` picture, `hud` numbers |
| app → page | `window.__fpvNative` | `setImmersive`, `pad` / `padGone`, `respawn`, `toggleMenu`, `requestScene` |

The page's storage (settings, Betaflight EEPROM, personal bests) belongs to `http://127.0.0.1:51730`;
the server keeps that port so it survives relaunches.
