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
| 🤟 Three fingers | Lotus flower |
| 🤘 Rock on | Supernova blast |
| 👍 Thumbs up | Ringed planet |
| 🤏 Pinch (Vision Pro style) | Black hole at the pinch point |
| no hand | Drifting nebula |

- **Move your hand** and the formation follows it.
- **Move closer to the camera** and the formation grows.
- **Tilt your hand** and the formation rolls with it.
- **Two hands**: the formation sits between them and stretches with their distance.
- **Fingertips** push particles aside as they pass through.

You can change which shape each gesture makes in the panel under **Gesture → Shape**. Also available: sphere, DNA helix, cube, torus knot.

## Keys
`H` hide UI · `F` fullscreen · `0`–`8` pick a gesture in mouse-demo mode (hold the mouse button to push particles)

## Files
- `server.py` is the Python server. The camera only works on localhost or https.
- `js/hands.js` handles the camera and the MediaPipe HandLandmarker (GPU, with CPU fallback).
- `js/gestures.js` reads gestures from the 21 hand landmarks and stabilizes them so they don't flicker.
- `js/shapes.js` generates the 13 particle formations.
- `js/particles.js` runs the spring/noise/vortex physics and the glowing color shaders.
- `js/main.js` sets up the scene, bloom and trails, the hand logic, the HUD and the control panel.
