import * as THREE from 'three';
import { gauss } from './shapes.js';
import { Physics } from './physics.js';

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

    gl_PointSize = uSize * (0.7 + aRand * 0.8) * uPR * (60.0 / -mv.z) * (1.0 + sp * 0.5);
  }
`;

const fragmentShader = /* glsl */ `
  uniform float uIntensity;
  varying vec3 vColor;
  varying float vGlow;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float halo = pow(1.0 - d * 2.0, 3.5) * 0.6;          // thin glow so neighbours don't wash out
    float core = smoothstep(0.3, 0.12, d);               // crisp, solid dot
    vec3 c = vColor * (halo * vGlow + core * 1.1) + core * 0.15;
    gl_FragColor = vec4(c * uIntensity, max(halo, core));
  }
`;

// Rendering side of the particles. The physics runs in a Web Worker (physics-worker.js):
// every frame we send it the simulation state plus a spare set of output buffers, and it
// hands them back filled. Two buffer sets ping-pong, so nothing is copied or allocated
// per frame and the main thread only draws. Falls back to in-thread physics if workers fail.
export class ParticleSystem {
  constructor(scene) {
    this.scene = scene;
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
    this.phys = null;                                    // in-thread fallback
    this.dtAcc = 0;
    try {
      this.worker = new Worker(new URL('./physics-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.onFrame(e.data);
      this.worker.onerror = (e) => { console.warn('Physics worker failed, using main thread', e); this.useMainThread(); };
    } catch (e) {
      console.warn('Physics worker unavailable, using main thread', e);
      this.worker = null;
      this.phys = new Physics();
    }
  }

  get mode() { return this.worker ? 'worker' : 'main thread'; }

  send(m, transfer) {
    if (this.worker) this.worker.postMessage(m, transfer || []);
    else this.phys.handle(m);
  }

  useMainThread() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.phys = new Physics();
    this.phys.build(this.N);
    if (this.shape) this.phys.setShape(this.shape);
    this.bind(this.phys.pos, this.phys.speed, this.phys.hue);
  }

  setPalette(name) {
    const p = PALETTES[name], u = this.material.uniforms;
    u.uRainbow.value = p ? 0 : 1;
    if (p) { u.uA.value.set(...p[0]); u.uB.value.set(...p[1]); u.uC.value.set(...p[2]); }
  }

  makeSet(N) {
    const pos = new Float32Array(N * 3), hue = new Float32Array(N);
    for (let i = 0; i < N; i++) {                        // same starting cloud the physics uses
      pos[i * 3] = gauss() * 30; pos[i * 3 + 1] = gauss() * 20; pos[i * 3 + 2] = gauss() * 20;
      hue[i] = Math.random();
    }
    return { pos, speed: new Float32Array(N), hue };
  }

  bind(pos, speed, hue) {
    const a = this.points.geometry.attributes;
    a.position.array = pos; a.aSpeed.array = speed; a.aHue.array = hue;
    a.position.needsUpdate = a.aSpeed.needsUpdate = a.aHue.needsUpdate = true;
    this.shown = { pos, speed, hue };
  }

  build(N) {
    this.N = N;
    this.send({ type: 'build', N });
    if (this.shape) this.send({ type: 'shape', name: this.shape });

    const shown = this.phys ? { pos: this.phys.pos, speed: this.phys.speed, hue: this.phys.hue } : this.makeSet(N);
    this.spare = this.phys ? null : this.makeSet(N);
    const rnd = new Float32Array(N);
    for (let i = 0; i < N; i++) rnd[i] = Math.random();

    if (this.points) { this.scene.remove(this.points); this.points.geometry.dispose(); }
    const g = new THREE.BufferGeometry();
    const attr = (arr, size) => new THREE.BufferAttribute(arr, size).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', attr(shown.pos, 3));
    g.setAttribute('aHue', attr(shown.hue, 1));
    g.setAttribute('aSpeed', attr(shown.speed, 1));
    g.setAttribute('aRand', new THREE.BufferAttribute(rnd, 1));
    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.scene.add(this.points);
    this.shown = shown;
  }

  setShape(name) { this.shape = name; this.send({ type: 'shape', name }); }
  kick(a) { this.send({ type: 'kick', a }); }
  fling(vx, vy, power = 1) { this.send({ type: 'fling', vx, vy, power }); }
  burst(cx, cy, cz, power) { this.send({ type: 'burst', cx, cy, cz, power }); }

  // A finished physics step came back: show it, and keep the old buffers as the next spare.
  onFrame(msg) {
    const out = msg.out;
    if (msg.stale || out.pos.length !== this.N * 3) { this.spare = this.makeSet(this.N); return; }
    this.spare = this.shown;
    this.bind(out.pos, out.speed, out.hue);
  }

  update(dt, t, s) {
    this.material.uniforms.uTime.value = t;
    if (this.phys) {                                     // fallback: simulate right here
      this.phys.update(dt, t, s);
      const a = this.points.geometry.attributes;
      a.position.needsUpdate = a.aSpeed.needsUpdate = a.aHue.needsUpdate = true;
      return;
    }
    this.dtAcc += dt;
    if (!this.spare) return;                             // previous step still running: draw what we have
    const out = this.spare;
    this.spare = null;
    const step = Math.min(this.dtAcc, 3);
    this.dtAcc = 0;
    this.worker.postMessage({ type: 'step', dt: step, t, sim: s, out }, [out.pos.buffer, out.speed.buffer, out.hue.buffer]);
  }
}
