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
Built to hold 60 fps on integrated graphics (tested on an Intel Iris Plus 655 at 2560×1440):
- **Physics runs in a Web Worker** (`physics-worker.js`), so the main thread only draws.
- **Hand tracking runs in a Web Worker** (`tracker-worker.js`), so camera frames never freeze the animation.
- **Glow + trails in one lean pipeline** (`post.js`): same shaders and the same image (verified to within 1/255), with fewer full-screen passes, no unused depth buffers and no redundant clears.
- Add `?perf` to the URL and run `__phBench()` in the console to measure frame cost on your machine.

## Files
- `server.py` is the Python server. The camera only works on localhost or https.
- `js/hands.js` handles the camera and sends frames to `js/tracker-worker.js` (MediaPipe HandLandmarker, GPU with CPU fallback).
- `js/gestures.js` reads gestures from the 21 hand landmarks and stabilizes them so they don't flicker.
- `js/shapes.js` generates the 14 particle formations, including the particle hand.
- `js/physics.js` + `js/physics-worker.js` run the spring/noise/vortex physics off the main thread.
- `js/particles.js` draws the particles (glowing color shaders) and exchanges buffers with the physics worker.
- `js/post.js` renders the motion trails, bloom glow and final output.
- `js/main.js` sets up the scene, bloom and trails, the hand logic, the HUD and the control panel.
