# ✦ Particle Hands

Control 30,000+ glowing particles with your bare hands. The app runs at 60 fps and has a black background, bloom glow and motion trails.
The camera feeds the hand tracker only. It is never shown on screen.

## Run

```bash
python3 server.py
```

Your browser opens at `http://localhost:8000`. Click **Start camera** and allow access.
Use Chrome or Safari. Nothing to install: Three.js, MediaPipe and lil-gui load from a CDN.

## Gestures

| Gesture | Particles become |
|---|---|
| 🖐️ Open palm | Spiral galaxy |
| ✊ Fist | Dense energy core |
| ☝️ Point | Firefly swarm that trails your fingertip |
| ✌️ Peace | Heart |
| 🤟 Three fingers | **Particle hand**: the particles form your real hand and follow every finger |
| 🤘 Rock on | Supernova blast |
| 👍 Thumbs up | Ringed planet |
| 🤏 Pinch (Vision Pro style) | Black hole at the pinch point |
| no hand | Drifting nebula |

- **Move your hand** and the formation follows it.
- **Move closer to the camera** and the formation grows.
- **Tilt your hand** and the formation rolls with it.
- **Two hands**: the formation sits between them and stretches with their distance.
- **Fingertips** push particles aside as they pass through.
- **Pinch, move, let go**: the particles are thrown in the direction your hand was moving.
- **Move faster** and the particles swirl harder (shown on the energy meter under the gesture name).

## Extras
- **📸 4K Snapshot** (key `S`) saves a 3840-pixel-wide PNG picture. **⏺ Record** (key `R`) saves a video clip of the particles; the camera image is never included.
- **Render quality** (panel → Effects): Fast, HD, Retina (default) or **4K**. The stats line shows the current resolution.
- **Presets** at the top of the panel: Default, Calm, Cosmic, Chaos, Neon Dream.
- Your panel settings are remembered in this browser. **↺ reset everything** restores the defaults.

You can change which shape each gesture makes in the panel under **Gesture → Shape**. Also available: lotus flower, sphere, DNA helix, cube, torus knot.

## Keys
`H` hide UI · `F` fullscreen · `S` snapshot · `R` record · `0`–`8` pick a gesture in mouse-demo mode (hold the mouse button to push particles)

## Performance
Measured in a real Chrome window on an Intel MacBook (Iris Plus 655, 4 cores) at 2560×1426:
**60 fps** in the demo and **~60 fps with the camera on** (it was 20 fps before these changes).

- **Frosted glass drawn in WebGL** (`post.js`). CSS `backdrop-filter` re-blurred the canvas under every
  HUD panel on every frame and alone held the app at 20–27 fps. The blur already exists in the bloom
  pass, so the glass now costs a few texture reads.
- **Hand tracking in background workers** (`tracker-worker.js`). MediaPipe on the main thread took
  ~54 ms per camera frame (→ 18 fps). It now runs in a pool of CPU workers, so rendering never waits;
  2 trackers on a 4-core Mac (~12 hand updates/s), 4 on 8-core machines. Between updates the hand
  keeps moving along its recent velocity (**motion prediction**, panel → Hand), so particles glide.
- **Physics in a Web Worker** (`physics-worker.js`), so the main thread only draws.
- **Leaner glow + trails pipeline**: same shaders and the same image (verified pixel-by-pixel to
  within 1/255), with fewer full-screen passes, no unused depth buffers and no redundant clears.
- **Auto quality** (default, panel → Effects): full Retina sharpness; the resolution only steps down
  if the frame rate stays under 60 for 3 seconds (e.g. a big 4K monitor), and tries going back up later.

Developer switches: add `?perf` to the URL and run `__phBench()` in the console. `?tracker=gpu|cpu`,
`?workers=N`, `?hands=1|2`, `?trackthread=main` change the hand tracker for comparisons.

## Files
- `server.py` is the Python server. The camera only works on localhost or https.
- `js/hands.js` handles the camera and sends frames to a pool of `js/tracker-worker.js` workers (MediaPipe HandLandmarker).
- `js/gestures.js` reads gestures from the 21 hand landmarks and stabilizes them so they don't flicker.
- `js/shapes.js` generates the 14 particle formations, including the particle hand.
- `js/physics.js` + `js/physics-worker.js` run the spring/noise/vortex physics off the main thread.
- `js/particles.js` draws the particles (glowing color shaders) and exchanges buffers with the physics worker.
- `js/post.js` renders the motion trails, bloom glow, the frosted glass behind the panels and the final output.
- `js/main.js` sets up the scene, bloom and trails, the hand logic, the HUD and the control panel.
