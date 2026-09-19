// Hand-gesture recognition from the 21 MediaPipe hand landmarks.
//
//   0 wrist | thumb 1-4 | index 5-8 | middle 9-12 | ring 13-16 | pinky 17-20
//   (MCP, PIP, DIP, TIP for each finger)

export const GESTURES = {
  open:   { label: 'Open palm', icon: '🖐️', key: '1' },
  fist:   { label: 'Fist',      icon: '✊',  key: '2' },
  point:  { label: 'Point',     icon: '☝️', key: '3' },
  peace:  { label: 'Peace',     icon: '✌️', key: '4' },
  three:  { label: 'Three',     icon: '🤟', key: '5' },
  rock:   { label: 'Rock on',   icon: '🤘', key: '6' },
  thumbs: { label: 'Thumbs up', icon: '👍', key: '7' },
  pinch:  { label: 'Pinch',     icon: '🤏', key: '8' },
  none:   { label: 'No hand',   icon: '✦',  key: '0' },
};

const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

export function classify(lm) {
  const size = d(lm[0], lm[9]) || 1e-6;                  // wrist → middle knuckle
  const ext = (tip, pip) => d(lm[tip], lm[0]) > d(lm[pip], lm[0]) * 1.12;
  const index = ext(8, 6), middle = ext(12, 10), ring = ext(16, 14), pinky = ext(20, 18);
  const thumb = d(lm[4], lm[17]) > d(lm[2], lm[17]) * 1.15 && d(lm[4], lm[5]) > size * 0.45;
  const pinch = d(lm[4], lm[8]) / size;
  const n = index + middle + ring + pinky;

  let gesture = 'unknown';
  if (pinch < 0.28 && d(lm[8], lm[0]) > size * 0.95) gesture = 'pinch';   // Vision-Pro-style pinch
  else if (n === 0) gesture = thumb && lm[4].y < lm[5].y - size * 0.25 ? 'thumbs' : 'fist';
  else if (index && !middle && !ring && pinky) gesture = 'rock';
  else if (index && !middle && !ring && !pinky) gesture = 'point';
  else if (index && middle && !ring && !pinky) gesture = 'peace';
  else if (index && middle && ring && !pinky) gesture = 'three';
  else if (n >= 4 || (n === 3 && pinky)) gesture = 'open';

  return { gesture, pinch, size, fingers: { thumb, index, middle, ring, pinky } };
}

// Only switch gestures after the same one is seen for a few frames — no flicker.
export class GestureStabilizer {
  constructor(frames = 3) { this.frames = frames; this.current = 'none'; this.candidate = 'none'; this.count = 0; }
  push(g) {
    if (g === 'unknown') return this.current;
    if (g === this.current) { this.candidate = g; this.count = 0; return g; }
    if (g === this.candidate) {
      if (++this.count >= this.frames) { this.current = g; this.count = 0; }
    } else { this.candidate = g; this.count = 1; }
    return this.current;
  }
}
