// Particle physics — plain JS, no Three.js, so it can run inside a Web Worker.
// The math is the same as before; it just no longer blocks the rendering thread.
import { buildShape, gauss, handBind } from './shapes.js';

// Fast sine (max error ≈ 0.001) for the flow noise — ~3× cheaper than Math.sin, same look.
const TAU = Math.PI * 2, B = 4 / Math.PI, C = -4 / (Math.PI * Math.PI);
function fsin(x) {
  x -= TAU * Math.round(x / TAU);
  const y = B * x + C * x * (x < 0 ? -x : x);
  return 0.225 * (y * (y < 0 ? -y : y) - y) + y;
}
const fcos = (x) => fsin(x + Math.PI / 2);

export class Physics {
  constructor() { this.cache = new Map(); this.shape = null; this.handWorlds = null; }

  build(N) {
    this.N = N;
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.tgt = new Float32Array(N * 3);
    this.hue = new Float32Array(N);
    this.thue = new Float32Array(N);
    this.speed = new Float32Array(N);
    this.lag = new Float32Array(N);
    // particle-hand binding: each particle sits on a blend of 3 landmarks + a fixed offset
    this.hIdx = new Uint8Array(N * 3);
    this.hW = new Float32Array(N * 3);
    this.hOff = new Float32Array(N * 3);
    this.htgt = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) handBind(i, this.hIdx, this.hW, this.hOff);
    for (let i = 0; i < N; i++) {
      this.pos[i * 3] = gauss() * 30; this.pos[i * 3 + 1] = gauss() * 20; this.pos[i * 3 + 2] = gauss() * 20;
      this.lag[i] = 0.12 + Math.random() * 0.88;
      this.hue[i] = Math.random();
    }
    if (this.shape) this.setShape(this.shape);
  }

  setShape(name) {
    const key = name + ':' + this.N;
    if (!this.cache.has(key)) this.cache.set(key, buildShape(name, this.N));
    const s = this.cache.get(key);
    this.tgt.set(s.pos);
    this.thue.set(s.hue);
    this.shape = name;
  }

  kick(a) {
    const v = this.vel;
    for (let i = 0; i < v.length; i++) v[i] += gauss() * a;
  }

  // Throw: every particle inherits the hand's velocity, plus some scatter.
  fling(vx, vy, power = 1) {
    const v = this.vel;
    for (let i = 0; i < this.N; i++) {
      const i3 = i * 3, f = power * (0.4 + Math.random() * 0.9);
      v[i3] += vx * f + gauss() * 0.4; v[i3 + 1] += vy * f + gauss() * 0.4; v[i3 + 2] += gauss() * 0.4;
    }
  }

  burst(cx, cy, cz, power) {
    const p = this.pos, v = this.vel;
    for (let i = 0; i < this.N; i++) {
      const i3 = i * 3;
      const dx = p[i3] - cx, dy = p[i3 + 1] - cy, dz = p[i3 + 2] - cz;
      const f = (power * (0.3 + Math.random())) / (Math.hypot(dx, dy, dz) + 0.5);
      v[i3] += dx * f; v[i3 + 1] += dy * f; v[i3 + 2] += dz * f;
    }
  }

  // Live targets that trace the tracked hand(s). `worlds` = one Float32Array(63) per hand.
  updateHandTargets(worlds) {
    const { hIdx, hW, hOff, htgt, N } = this, nh = worlds.length;
    const scales = worlds.map((w) => Math.hypot(w[27] - w[0], w[28] - w[1]) / 9 || 1);
    for (let i = 0; i < N; i++) {
      const hi = nh > 1 ? i & 1 : 0, w = worlds[hi], sc = scales[hi], i3 = i * 3;
      const a = hIdx[i3] * 3, b = hIdx[i3 + 1] * 3, c = hIdx[i3 + 2] * 3;
      const wa = hW[i3], wb = hW[i3 + 1], wc = hW[i3 + 2];
      htgt[i3] = w[a] * wa + w[b] * wb + w[c] * wc + hOff[i3] * sc;
      htgt[i3 + 1] = w[a + 1] * wa + w[b + 1] * wb + w[c + 1] * wc + hOff[i3 + 1] * sc;
      htgt[i3 + 2] = w[a + 2] * wa + w[b + 2] * wb + w[c + 2] * wc + hOff[i3 + 2] * sc;
    }
  }

  // s = simulation state from main.js (center, scale, rotation matrix, forces, repulsors)
  update(dt, t, s) {
    if (s.handMode && s.handWorlds) this.updateHandTargets(s.handWorlds);
    const { pos, vel, tgt, htgt, hue, thue, speed, lag, N } = this;
    const handMode = s.handMode;
    const r = s.rot;
    const m00 = r[0], m01 = r[4], m02 = r[8], m10 = r[1], m11 = r[5], m12 = r[9], m20 = r[2], m21 = r[6], m22 = r[10];
    const cx = s.cx, cy = s.cy, cz = s.cz, sc = s.scale;
    const k = s.spring * dt, damp = Math.pow(s.damping, dt);
    const nA = s.noise * dt, nf = 0.11, t1 = t * 0.9, t2 = t * 1.1, t3 = t * 0.7;
    const swirl = s.swirl * dt, useLag = s.lag;
    const reps = s.reps, nRep = s.repCount * 3, rR = s.repRadius, rR2 = rR * rR, rS = s.repStrength * dt;
    const hueK = Math.min(1, 0.04 * dt);
    // Bounding box around all fingertips (+radius): particles outside it skip the fingertip loop.
    let bx0 = Infinity, by0 = Infinity, bz0 = Infinity, bx1 = -Infinity, by1 = -Infinity, bz1 = -Infinity;
    for (let j = 0; j < nRep; j += 3) {
      bx0 = Math.min(bx0, reps[j] - rR); bx1 = Math.max(bx1, reps[j] + rR);
      by0 = Math.min(by0, reps[j + 1] - rR); by1 = Math.max(by1, reps[j + 1] + rR);
      bz0 = Math.min(bz0, reps[j + 2] - rR); bz1 = Math.max(bz1, reps[j + 2] + rR);
    }

    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      let tx, ty, tz;
      if (handMode) { tx = htgt[i3]; ty = htgt[i3 + 1]; tz = htgt[i3 + 2]; }
      else {
        const lx = tgt[i3] * sc, ly = tgt[i3 + 1] * sc, lz = tgt[i3 + 2] * sc;
        tx = cx + m00 * lx + m01 * ly + m02 * lz;
        ty = cy + m10 * lx + m11 * ly + m12 * lz;
        tz = cz + m20 * lx + m21 * ly + m22 * lz;
      }
      const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];

      const lg = lag[i];
      const kk = useLag ? k * lg * lg : k * (0.55 + 0.45 * lg);
      let ax = (tx - px) * kk, ay = (ty - py) * kk, az = (tz - pz) * kk;

      // flowing curl-ish noise keeps everything alive
      ax += fsin(py * nf + t1 + lg * 6) * nA;
      ay += fcos(pz * nf + t2 + lg * 4) * nA;
      az += fsin(px * nf - t3) * nA;

      if (swirl) {                                       // vortex around the anchor
        const dx = px - cx, dy = py - cy;
        const f = swirl / Math.sqrt(dx * dx + dy * dy + 1);
        ax -= dy * f; ay += dx * f;
      }

      if (px > bx0 && px < bx1 && py > by0 && py < by1 && pz > bz0 && pz < bz1)
      for (let j = 0; j < nRep; j += 3) {                // fingertips push particles away
        const dx = px - reps[j], dy = py - reps[j + 1], dz = pz - reps[j + 2];
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < rR2 && d2 > 1e-4) {
          const d = Math.sqrt(d2), f = (rS * (1 - d / rR)) / d;
          ax += dx * f + dy * f * 0.6;                   // push + a little spin
          ay += dy * f - dx * f * 0.6;
          az += dz * f;
        }
      }

      const vx = (vel[i3] + ax) * damp, vy = (vel[i3 + 1] + ay) * damp, vz = (vel[i3 + 2] + az) * damp;
      vel[i3] = vx; vel[i3 + 1] = vy; vel[i3 + 2] = vz;
      pos[i3] = px + vx * dt; pos[i3 + 1] = py + vy * dt; pos[i3 + 2] = pz + vz * dt;
      speed[i] = Math.sqrt(vx * vx + vy * vy + vz * vz);
      hue[i] += (thue[i] - hue[i]) * hueK;
    }
  }

  // Runs one command message; shared by the worker and the in-thread fallback.
  handle(m) {
    switch (m.type) {
      case 'build': this.build(m.N); break;
      case 'shape': this.setShape(m.name); break;
      case 'kick': this.kick(m.a); break;
      case 'fling': this.fling(m.vx, m.vy, m.power); break;
      case 'burst': this.burst(m.cx, m.cy, m.cz, m.power); break;
      case 'step': this.update(m.dt, m.t, m.sim); break;
    }
  }
}
