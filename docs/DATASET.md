# fpvsim-dataset v1: camera datasets

The dataset recorder saves what the FPV camera sees, frame by frame, with ground truth rendered
through the same lens and labels for every frame. Use it for perception research: gate detection
and corner regression for drone racing, depth estimation, segmentation, visual odometry with true
poses and IMU.

- Record from **Settings → Research → Camera dataset** (a `.zip`), or through the control API's
  `capture` and `record` ([API.md](API.md)). Over the API, frames stream as events and
  [`python/examples/record_dataset.py`](../python/examples/record_dataset.py) writes them to a folder.
- It works in flight and in lap replays (FPV camera), so a leaderboard lap can become a dataset.
- Code: [`src/app/dataset.ts`](../src/app/dataset.ts), [`src/render/groundTruth.ts`](../src/render/groundTruth.ts),
  [`src/app/datasetFiles.ts`](../src/app/datasetFiles.ts). Tests: [`tests/dataset.test.ts`](../tests/dataset.test.ts).

## Same lens, same instant

The picture comes from the simulator's camera model:
- a Kannala–Brandt fisheye at the video system's field of view;
- a rolling shutter and motion blur, through the exposure;
- mount vibration from the props;
- auto exposure and sensor noise.

The ground truth is rendered for the same captured frame. The scene goes into a float cube map,
with every surface writing its range, class and instance. It is then resampled with the fisheye's
own geometry, at each row's readout time, with the frame's rotation table and vibration. So labels
line up with the picture pixel for pixel, rolling-shutter skew included. Nearest-neighbour
sampling keeps labels unblended.

## Layout

```
meta.json            format, version, app, map, course, drone build, video system, wind, classes, units
frames.jsonl         one JSON object per frame (labels, below)
rgb/000000.png       the clean camera picture (8-bit RGBA): exposure, noise, no radio link, no OSD
received/000000.png  (optional) what the goggles received: link noise and break-up, the analog OSD
depth/000000.png     range from the lens, 16-bit grayscale, millimetres; 0 = nothing hit (sky); 65535 = 65.535 m or more
segmentation/000000.png  semantic class per pixel, 8-bit (classes below)
instance/000000.png  instance id per pixel, 16-bit: gate id + 1 on gates, 0 elsewhere
```

Depth is the **range along the ray**, the natural quantity for a fisheye. It is not the z-depth of
a pinhole camera. Images use the video system's own resolution: 640×480 for analog NTSC, 1280×720
for digital, times the render scale.

### Classes

| Value | Class | What |
| --- | --- | --- |
| 0 | `sky` | nothing hit |
| 1 | `ground` | terrain |
| 2 | `structure` | buildings, obstacles, level geometry, and anything untagged |
| 3 | `vegetation` | trees, grass tufts |
| 4 | `gate` | gate frames, LED strips and flag banners (instance: gate id + 1) |
| 5 | `person` | spectators |
| 6 | `drone_self` | the quad's own props and ducts in view |
| 7 | `drone_other` | other pilots' quads (multiplayer) |
| 8 | `object` | the windsock, lights and similar props |

Leaf-card trees are labelled by their cards: foliage masks are coarser than the leaves drawn in the
picture. Light shafts and glows are not surfaces and are not labelled.

## Labels (frames.jsonl)

```jsonc
{
  "frame": 12,
  "t": 31.415,                            // sim time of the capture (s)
  "camera": {
    "model": "kannala-brandt", "width": 640, "height": 480,
    "k": [-0.02, 0.004, -0.001, 0],      // θ_d = θ (1 + k1 θ² + k2 θ⁴ + k3 θ⁶ + k4 θ⁸)
    "fovDeg": 160,                        // diagonal: the image corner is at θ = fovDeg / 2
    "fPx": 295.7, "cx": 320, "cy": 240,   // pixel radius from (cx, cy) = fPx · θ_d
    "readoutS": 0.016,                    // rolling shutter: row y is exposed at t + (y / height − 0.5) · readoutS
    "fps": 59.94, "uptiltDeg": 30, "latencyMs": 22
  },
  "pose": {                               // the camera at the frame's middle row
    "pos": [x, y, z],                     // world ENU (m)
    "R": [9 numbers],                     // camera-to-world rotation, row-major; OpenCV camera axes (x right, y down, z forward)
    "quat": [w, x, y, z]                  // the same rotation
  },
  "body": { "pos", "quat", "vel", "rates", "gyro", "motorRpm", "rc", "armed", "vbus" },  // the quad: FLU body, ENU world
  "gates": [{
    "id": 3, "index": 3, "next": true, "kind": "square",
    "cornersWorld": [[x, y, z], ...],     // the opening: top-left, top-right, bottom-right, bottom-left seen from the approach side
    "corners": [[u, v] | null, ...],      // in the image (pixels, origin at the top-left corner, x right, y down); null outside the picture or behind the lens
    "visible": [true, ...],               // in the picture and nothing solid between the corner and the lens
    "centreWorld": [x, y, z], "centre": [u, v] | null,
    "rangeM": 7.4
  }]
}
```

To project a world point: transform it into the camera frame with `pose`, take θ (the angle from
the optical axis) and φ (the azimuth in the image), apply the Kannala–Brandt polynomial to get
θ_d, then `u = cx + fPx · θ_d · cos φ` and `v = cy + fPx · θ_d · sin φ` (OpenCV axes). Gate corners
are projected at the middle row's pose, without rolling-shutter correction: in fast rotation a
corner near the top or bottom of the picture can be off by a few pixels.

## Rates and limits

- Frames are taken at the chosen rate in sim time, from the camera's own frames (at most its frame
  rate).
- A frame is skipped rather than slowing the flight when the computer can't encode fast enough. The
  zip records how many were skipped.
- The in-app recorder keeps up to 600 frames per zip in memory. Over the API, streaming has no
  limit.
- Ground truth renders one extra cube map, plus a lens pass and a read-back, per recorded frame.
  Its cost depends on the GPU, so record at the rate you need.
