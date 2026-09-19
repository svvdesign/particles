// Particle formations. Each generator writes one point into `o` = [x, y, z, hue?].
// If o[3] stays -1 the hue is derived from the point's angle + radius.
//
// anchor: what the formation follows — 'palm', 'index' (fingertip) or 'pinch' (thumb+index midpoint)
// spin:   rad/s around the formation's own axis     tilt: base tilt toward the camera
// spring: pull-strength multiplier                  swirl: tangential vortex force
// lag:    per-particle lag (trailing swarm look)    burst: outward blast on enter
// repel:  whether fingertips push particles away

import { HAND_CONNECTIONS } from './hands.js';

const TAU = Math.PI * 2;
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
export function gauss() {
  let u = 0;
  while (!u) u = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * Math.random());
}
function dir(o, r) {
  const u = rand(-1, 1), t = rand(0, TAU), s = Math.sqrt(1 - u * u);
  o[0] = s * Math.cos(t) * r; o[1] = u * r; o[2] = s * Math.sin(t) * r;
}

export const SHAPES = {
  galaxy: {
    label: 'Spiral galaxy', anchor: 'palm', spin: 0.45, tilt: 1.05, spring: 1,
    gen(i, N, o) {
      const arms = 4, arm = i % arms;
      const r = Math.pow(Math.random(), 0.6) * 21 + 0.3;
      const a = (arm / arms) * TAU + r * 0.3 + gauss() * 0.22 * (1.3 - r / 24);
      const spread = 0.35 + r * 0.035;
      o[0] = Math.cos(a) * r + gauss() * spread;
      o[2] = Math.sin(a) * r + gauss() * spread;
      o[1] = gauss() * (1.8 * Math.exp(-r * 0.2) + 0.2);
      o[3] = (r / 22) * 0.8 + arm * 0.05;
    },
  },
  core: {
    label: 'Energy core', anchor: 'palm', spin: 1.6, tilt: 0.3, spring: 1.4,
    gen(i, N, o) {
      if (i % 7 === 0) dir(o, rand(6, 10));             // sparse halo
      else dir(o, Math.cbrt(Math.random()) * 5);       // dense glowing ball
      o[3] = Math.hypot(o[0], o[1], o[2]) / 10;
    },
  },
  sphere: {
    label: 'Crystal sphere', anchor: 'palm', spin: 0.5, tilt: 0.2, spring: 1,
    gen(i, N, o) {
      const k = i + 0.5, phi = Math.acos(1 - (2 * k) / N), th = Math.PI * (1 + Math.sqrt(5)) * k;
      const r = 13 + gauss() * 0.25;
      o[0] = Math.cos(th) * Math.sin(phi) * r; o[1] = Math.cos(phi) * r; o[2] = Math.sin(th) * Math.sin(phi) * r;
      o[3] = (o[1] / 26 + 0.5) * 0.9;
    },
  },
  heart: {
    label: 'Heart', anchor: 'palm', spin: 0.6, tilt: 0, spring: 1,
    gen(i, N, o) {
      const t = rand(0, TAU), s = Math.pow(Math.random(), 0.3);
      const x = 16 * Math.pow(Math.sin(t), 3);
      const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      o[0] = x * s * 0.8; o[1] = (y * s + 3) * 0.8;
      o[2] = gauss() * 2.6 * Math.sqrt(Math.max(0.04, 1 - s * s));
      o[3] = s * 0.35 + (t / TAU) * 0.25;
    },
  },
  saturn: {
    label: 'Ringed planet', anchor: 'palm', spin: 0.5, tilt: 0.45, spring: 1,
    gen(i, N, o) {
      if (i % 10 < 4) { dir(o, 6.5 + Math.random() * 0.3); o[3] = 0.05 + (o[1] / 14 + 0.5) * 0.15; return; }
      let r = 9 + Math.pow(Math.random(), 0.8) * 9;
      if (r > 12.6 && r < 13.4) r += 1;                  // Cassini gap
      const a = rand(0, TAU);
      o[0] = Math.cos(a) * r; o[1] = gauss() * 0.12; o[2] = Math.sin(a) * r;
      o[3] = 0.45 + (r - 9) / 18;
    },
  },
  flower: {
    label: 'Lotus flower', anchor: 'palm', spin: 0.35, tilt: 0.6, spring: 1,
    gen(i, N, o) {
      if (i % 12 === 0) { dir(o, Math.cbrt(Math.random()) * 2.2); o[1] += 1; o[3] = 0.15; return; }
      const layer = i % 3;                               // three petal rings, offset
      const th = rand(0, TAU), petals = 5 + layer;
      const p = Math.abs(Math.cos((petals / 2) * th + layer * 0.6));
      const fill = Math.random() < 0.55 ? 0.9 + Math.random() * 0.1 : Math.sqrt(Math.random());   // bright petal edges
      const r = (17 - layer * 3.5) * p * fill;
      o[0] = Math.cos(th) * r; o[2] = Math.sin(th) * r;
      o[1] = Math.pow(r / 17, 2) * (7 + layer * 2) - 2 + gauss() * 0.2;
      o[3] = 0.55 + r / 30 + layer * 0.08;
    },
  },
  helix: {
    label: 'DNA helix', anchor: 'palm', spin: 0.9, tilt: 0.15, spring: 1,
    gen(i, N, o) {
      const y = rand(-19, 19);
      if (i % 5 === 0) {                                 // base-pair rungs
        const yq = Math.round(y / 1.9) * 1.9, a = yq * 0.4, t = rand(-1, 1);
        o[0] = Math.cos(a) * 6 * t; o[1] = yq; o[2] = Math.sin(a) * 6 * t;
        o[3] = 0.5 + t * 0.15;
        return;
      }
      const a = y * 0.4 + (i % 2) * Math.PI;
      o[0] = Math.cos(a) * 6 + gauss() * 0.35; o[1] = y + gauss() * 0.2; o[2] = Math.sin(a) * 6 + gauss() * 0.35;
      o[3] = (y / 38 + 0.5) * 0.7 + (i % 2) * 0.3;
    },
  },
  cube: {
    label: 'Tesseract cube', anchor: 'palm', spin: 0.6, tilt: 0.55, spring: 1,
    gen(i, N, o) {
      const s = 10.5, ax = i % 3;
      if (i % 3 === 0 || i % 7 === 0) {                  // bright edges
        const e = Math.floor(Math.random() * 3);
        for (let k = 0; k < 3; k++) o[k] = k === e ? rand(-s, s) : (Math.random() < 0.5 ? -s : s);
      } else if (i % 5 === 0) {                          // inner cube
        const e = Math.floor(Math.random() * 3);
        for (let k = 0; k < 3; k++) o[k] = k === e ? rand(-s / 2, s / 2) : (Math.random() < 0.5 ? -s / 2 : s / 2);
      } else {                                           // faint faces
        for (let k = 0; k < 3; k++) o[k] = k === ax ? (Math.random() < 0.5 ? -s : s) : rand(-s, s);
      }
      o[3] = (o[0] + o[1] + o[2]) / (6 * s) + 0.5;
    },
  },
  torusKnot: {
    label: 'Torus knot', anchor: 'palm', spin: 0.7, tilt: 0.3, spring: 1,
    gen(i, N, o) {
      const t = rand(0, TAU), p = 2, q = 3, r = Math.cos(q * t) + 2.2;
      const tube = Math.abs(gauss()) * 0.9;
      dir(o, tube);
      o[0] += r * Math.cos(p * t) * 5; o[1] += r * Math.sin(p * t) * 5; o[2] += -Math.sin(q * t) * 5;
      o[3] = t / TAU;
    },
  },
  explosion: {
    label: 'Supernova', anchor: 'palm', spin: 0.15, tilt: 0, spring: 0.35, burst: 3.2,
    gen(i, N, o) {
      dir(o, 14 + Math.pow(Math.random(), 3) * 12);
      o[3] = Math.hypot(o[0], o[1], o[2]) / 40 + Math.random() * 0.1;
    },
  },
  nebula: {
    label: 'Nebula', anchor: 'palm', spin: 0.12, tilt: 0.2, spring: 0.5,
    gen(i, N, o) {
      const k = i % 7;
      const cx = Math.cos(k * 2.4) * 15, cy = Math.sin(k * 1.7) * 9, cz = Math.sin(k * 3.1) * 8;
      const sp = 3 + (k % 3) * 1.6;
      o[0] = cx + gauss() * sp * 1.3; o[1] = cy + gauss() * sp * 0.8; o[2] = cz + gauss() * sp;
      o[3] = k / 7 + gauss() * 0.04;
    },
  },
  swarm: {
    label: 'Firefly swarm', anchor: 'index', spin: 1.4, tilt: 0.4, spring: 1.6, lag: true, repel: false,
    gen(i, N, o) { dir(o, Math.cbrt(Math.random()) * 3.4); o[3] = Math.random() * 0.25 + (i % 4) * 0.2; },
  },
  hand: {
    label: 'Particle hand', anchor: 'palm', spin: 0, tilt: 0, spring: 2.4, repel: false, hand: true,
    gen(i, N, o) { o[0] = o[1] = o[2] = 0; o[3] = handHue(i); },   // targets are computed live from the hand
  },
  blackhole: {
    label: 'Black hole', anchor: 'pinch', spin: 1.8, tilt: 0.32, spring: 1.6, swirl: 0.12, repel: false,
    gen(i, N, o) {
      if (i % 16 === 0) {                                // polar jets
        const y = rand(1, 16) * (Math.random() < 0.5 ? -1 : 1);
        o[0] = gauss() * 0.3 * (1 + Math.abs(y) / 10); o[1] = y; o[2] = gauss() * 0.3 * (1 + Math.abs(y) / 10); o[3] = 0.55;
        return;
      }
      const r = 3.2 + Math.pow(Math.random(), 1.9) * 12, a = rand(0, TAU);   // dark hole in the middle
      o[0] = Math.cos(a) * r; o[1] = gauss() * 0.22 * (r / 12); o[2] = Math.sin(a) * r;
      o[3] = 0.02 + r / 30;
    },
  },
};

// ─── Particle hand ───────────────────────────────────────────────────────────
// Every particle is bound to the hand skeleton: 21 bones, the palm (4 triangles)
// and glowing fingertip halos. Each finger gets its own color band.
const PALM = [[0, 5, 9], [0, 9, 13], [0, 13, 17], [0, 1, 5]];
const TIPS = [4, 8, 12, 16, 20];
const BUCKETS = 28;

function handHue(i) {
  const b = i % BUCKETS;
  if (b <= 20) return b === 20 ? 0.88 : Math.floor(b / 4) * 0.17;
  if (b <= 26) return 0.88 + (b % 4) * 0.025;
  return TIPS.indexOf(TIPS[Math.floor(i / BUCKETS) % 5]) * 0.17;
}

export function handBind(i, idx, w, off) {
  const b = i % BUCKETS, i3 = i * 3;
  let r;
  if (b <= 20) {                                         // along a bone
    const [p, q] = HAND_CONNECTIONS[b], t = Math.random();
    idx[i3] = p; idx[i3 + 1] = q; idx[i3 + 2] = q;
    w[i3] = 1 - t; w[i3 + 1] = t; w[i3 + 2] = 0;
    r = 0.55 - t * 0.15;
  } else if (b <= 26) {                                  // palm surface
    const tri = PALM[b % 4];
    let u = Math.random(), v = Math.random();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    idx.set(tri, i3);
    w[i3] = 1 - u - v; w[i3 + 1] = u; w[i3 + 2] = v;
    r = 0.3;
  } else {                                               // fingertip glow
    const tip = TIPS[Math.floor(i / BUCKETS) % 5];
    idx[i3] = idx[i3 + 1] = idx[i3 + 2] = tip;
    w[i3] = 1; w[i3 + 1] = w[i3 + 2] = 0;
    r = 1.0;
  }
  off[i3] = gauss() * r; off[i3 + 1] = gauss() * r; off[i3 + 2] = gauss() * r * 0.6;
}

export const SHAPE_NAMES = Object.keys(SHAPES);

export function buildShape(name, N) {
  const def = SHAPES[name];
  const pos = new Float32Array(N * 3), hue = new Float32Array(N);
  const o = [0, 0, 0, -1];
  for (let i = 0; i < N; i++) {
    o[3] = -1;
    def.gen(i, N, o);
    pos[i * 3] = o[0]; pos[i * 3 + 1] = o[1]; pos[i * 3 + 2] = o[2];
    if (o[3] >= 0) hue[i] = o[3];
    else hue[i] = (Math.atan2(o[2], o[0]) / TAU + 0.5) * 0.35 + (Math.hypot(o[0], o[1], o[2]) / 24) * 0.65;
  }
  return { pos, hue };
}
