import * as THREE from 'three';
import { buildShape, gauss } from './shapes.js';

// null = HSV rainbow; otherwise a looping 3-stop gradient.
export const PALETTES = {
  Rainbow: null,
  Neon:    [[1, 0.1, 0.85], [0.1, 0.85, 1], [0.55, 0.2, 1]],
  Fire:    [[1, 0.1, 0.0], [1, 0.5, 0.0], [1, 0.9, 0.35]],
  Ocean:   [[0.0, 0.25, 1], [0.0, 0.85, 1], [0.35, 1, 0.75]],
  Aurora:  [[0.1, 1, 0.55], [0.15, 0.55, 1], [0.75, 0.25, 1]],
  Sunset:  [[1, 0.25, 0.5], [1, 0.6, 0.15], [0.55, 0.2, 1]],
  Candy:   [[1, 0.4, 0.8], [0.45, 0.9, 1], [1, 0.95, 0.45]],
};

const vertexShader = /* glsl */ `
  attribute float aHue;
  attribute float aSpeed;
  attribute float aRand;
  uniform float uTime, uSize, uPR, uHueSpeed, uRainbow;
  uniform vec3 uA, uB, uC;
  varying vec3 vColor;
  varying float vGlow;

  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }
  vec3 grad(float h) {
    float x = fract(h) * 3.0;
    if (x < 1.0) return mix(uA, uB, smoothstep(0.0, 1.0, x));
    if (x < 2.0) return mix(uB, uC, smoothstep(0.0, 1.0, x - 1.0));
    return mix(uC, uA, smoothstep(0.0, 1.0, x - 2.0));
  }

  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;

    float h = aHue + aRand * 0.08 + uTime * uHueSpeed;
    vec3 col = uRainbow > 0.5 ? hsv2rgb(vec3(fract(h), 0.78, 1.0)) : grad(h);

    // fast particles flare white-hot
    float sp = clamp(aSpeed * 0.18, 0.0, 1.0);
    col = mix(col, vec3(1.0), sp * 0.3);
    float twinkle = 0.7 + 0.3 * sin(uTime * 3.0 + aRand * 60.0);
    vColor = col * twinkle;
    vGlow = 0.6 + sp * 0.9;

    gl_PointSize = uSize * (0.5 + aRand * 1.0) * uPR * (60.0 / -mv.z) * (1.0 + sp * 0.7);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uIntensity;
  varying vec3 vColor;
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float halo = pow(1.0 - d * 2.0, 2.6);
    float core = smoothstep(0.16, 0.0, d);
    vec3 c = vColor * halo * vGlow + vColor * core * 0.6 + core * 0.2;
    gl_FragColor = vec4(c * uIntensity, halo);
  }
`;

export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
    this.cache = new Map();
    this.shape = null;
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 }, uSize: { value: 2 }, uPR: { value: 1 }, uHueSpeed: { value: 0.05 },
        uIntensity: { value: 0.6 }, uRainbow: { value: 1 },
        uA: { value: new THREE.Vector3() }, uB: { value: new THREE.Vector3() }, uC: { value: new THREE.Vector3() },
      },
    });
  }

  setPalette(name) {
    const p = PALETTES[name], u = this.material.uniforms;
    u.uRainbow.value = p ? 0 : 1;
    if (p) { u.uA.value.set(...p[0]); u.uB.value.set(...p[1]); u.uC.value.set(...p[2]); }
  }

  build(N) {
    this.N = N;
    this.pos = new Float32Array(N * 3);
    this.vel = new Float32Array(N * 3);
    this.tgt = new Float32Array(N * 3);
    this.hue = new Float32Array(N);
    this.thue = new Float32Array(N);
    this.speed = new Float32Array(N);
    this.rnd = new Float32Array(N);
    this.lag = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      this.pos[i * 3] = gauss() * 30; this.pos[i * 3 + 1] = gauss() * 20; this.pos[i * 3 + 2] = gauss() * 20;
      this.rnd[i] = Math.random();
      this.lag[i] = 0.12 + Math.random() * 0.88;
      this.hue[i] = Math.random();
    }

    if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    const attr = (arr, size) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', attr(this.pos, 3));
    g.setAttribute('aHue', attr(this.hue, 1));
    g.setAttribute('aSpeed', attr(this.speed, 1));
    g.setAttribute('aRand', new THREE.BufferAttribute(this.rnd, 1));
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
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

  burst(cx, cy, cz, power) {
    const p = this.pos, v = this.vel;
    for (let i = 0; i < this.N; i++) {
      const i3 = i * 3;
      const dx = p[i3] - cx, dy = p[i3 + 1] - cy, dz = p[i3 + 2] - cz;
      const f = (power * (0.3 + Math.random())) / (Math.hypot(dx, dy, dz) + 0.5);
      v[i3] += dx * f; v[i3 + 1] += dy * f; v[i3 + 2] += dz * f;
    }
  }

  // s = simulation state from main.js (center, scale, rotation matrix, forces, repulsors)
  update(dt, t, s) {
    const { pos, vel, tgt, hue, thue, speed, lag, N } = this;
    const r = s.rot;
    const m00 = r[0], m01 = r[4], m02 = r[8], m10 = r[1], m11 = r[5], m12 = r[9], m20 = r[2], m21 = r[6], m22 = r[10];
    const cx = s.cx, cy = s.cy, cz = s.cz, sc = s.scale;
    const k = s.spring * dt, damp = Math.pow(s.damping, dt);
    const nA = s.noise * dt, nf = 0.11, t1 = t * 0.9, t2 = t * 1.1, t3 = t * 0.7;
    const swirl = s.swirl * dt, useLag = s.lag;
    const reps = s.reps, nRep = s.repCount * 3, rR = s.repRadius, rR2 = rR * rR, rS = s.repStrength * dt;
    const hueK = Math.min(1, 0.04 * dt);

    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const lx = tgt[i3] * sc, ly = tgt[i3 + 1] * sc, lz = tgt[i3 + 2] * sc;
      const tx = cx + m00 * lx + m01 * ly + m02 * lz;
      const ty = cy + m10 * lx + m11 * ly + m12 * lz;
      const tz = cz + m20 * lx + m21 * ly + m22 * lz;
      let px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];

      const lg = lag[i];
      const kk = useLag ? k * lg * lg : k * (0.55 + 0.45 * lg);
      let ax = (tx - px) * kk, ay = (ty - py) * kk, az = (tz - pz) * kk;

      // flowing curl-ish noise keeps everything alive
      ax += Math.sin(py * nf + t1 + lg * 6) * nA;
      ay += Math.cos(pz * nf + t2 + lg * 4) * nA;
      az += Math.sin(px * nf - t3) * nA;

      if (swirl) {                                       // vortex around the anchor
        const dx = px - cx, dy = py - cy;
        const f = swirl / Math.sqrt(dx * dx + dy * dy + 1);
        ax -= dy * f; ay += dx * f;
      }

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

    const a = this.points.geometry.attributes;
    a.position.needsUpdate = true; a.aSpeed.needsUpdate = true; a.aHue.needsUpdate = true;
    this.material.uniforms.uTime.value = t;
  }
}
