import * as THREE from 'three';
import { Post, MAX_GLASS } from './post.js';
import GUI from 'lil-gui';
import { SHAPES, SHAPE_NAMES } from './shapes.js';
import { ParticleSystem, PALETTES } from './particles.js';
import { GESTURES, classify, GestureStabilizer } from './gestures.js';
import { HandTracker, HAND_CONNECTIONS, TRACKER_FILES } from './hands.js';
const trackerPref = new URLSearchParams(location.search).get('tracker');   // ?tracker=cpu|gpu to compare
if (trackerPref) TRACKER_FILES.delegate = trackerPref.toUpperCase();
const trackerW = +new URLSearchParams(location.search).get('trackw');
if (trackerW) TRACKER_FILES.inputWidth = trackerW;
const trackerHands = +new URLSearchParams(location.search).get('hands');
if (trackerHands) TRACKER_FILES.numHands = Math.min(2, Math.max(1, trackerHands));
if (new URLSearchParams(location.search).get('trackthread') === 'main') TRACKER_FILES.worker = false;
const trackerWorkers = +new URLSearchParams(location.search).get('workers');
if (trackerWorkers) TRACKER_FILES.workers = trackerWorkers;

// ─── Settings (everything here is live-editable in the panel) ────────────────
const P = {
  count: 30000, size: 2.3, brightness: 0.7,
  palette: 'Rainbow', hueSpeed: 0.04,
  spring: 0.05, damping: 0.9, noise: 0.08, spin: 1,
  followHand: true, depthZoom: true, handRoll: true, smoothing: 0.45, prediction: 70,
  repel: true, repelStrength: 1.6, repelRadius: 7, energy: 1, throwPower: 1.2,
  mirror: true, skeleton: true,
  bloom: 0.8, bloomRadius: 0.35, trails: 0.6, stars: true, quality: 'Auto',
  map: {
    none: 'nebula', open: 'galaxy', fist: 'core', point: 'swarm', peace: 'heart',
    three: 'hand', rock: 'explosion', thumbs: 'saturn', pinch: 'blackhole',
  },
};

// Settings survive a reload (per browser). Everything works without storage too.
const STORE = 'particle-hands:v3';   // v3: performance defaults (auto quality, tracker pool)
try {
  const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
  if (saved) {
    const { map = {}, ...rest } = saved;
    for (const k of Object.keys(rest)) if (k in P && typeof rest[k] === typeof P[k]) P[k] = rest[k];
    for (const k of Object.keys(map)) if (k in P.map && SHAPES[map[k]]) P.map[k] = map[k];
  }
} catch { /* storage blocked — defaults it is */ }
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(P)); } catch { /* ignore */ } };

const PRESETS = {
  Default:     { size: 2.3, brightness: 0.7, palette: 'Rainbow', hueSpeed: 0.04, spring: 0.05, damping: 0.9, noise: 0.08, spin: 1, bloom: 0.95, bloomRadius: 0.4, trails: 0.72 },
  Calm:        { size: 2, brightness: 0.6, palette: 'Ocean', hueSpeed: 0.015, spring: 0.03, damping: 0.94, noise: 0.03, spin: 0.5, bloom: 0.7, bloomRadius: 0.5, trails: 0.85 },
  Cosmic:      { size: 2.2, brightness: 0.72, palette: 'Aurora', hueSpeed: 0.03, spring: 0.045, damping: 0.92, noise: 0.06, spin: 1.2, bloom: 1.2, bloomRadius: 0.7, trails: 0.8 },
  Chaos:       { size: 2.6, brightness: 0.8, palette: 'Fire', hueSpeed: 0.15, spring: 0.09, damping: 0.86, noise: 0.35, spin: 2.5, bloom: 1.3, bloomRadius: 0.4, trails: 0.6 },
  'Neon Dream': { size: 2.4, brightness: 0.75, palette: 'Neon', hueSpeed: 0.08, spring: 0.06, damping: 0.9, noise: 0.1, spin: 1.4, bloom: 1.6, bloomRadius: 0.8, trails: 0.9 },
};

// A resting open hand (wrist at 0,0; image-style y down). Used in mouse demo for the particle hand.
const DEMO_HAND = [
  [0, 0], [-0.35, -0.25], [-0.6, -0.5], [-0.8, -0.75], [-0.95, -1.0],
  [-0.3, -1.0], [-0.35, -1.45], [-0.38, -1.75], [-0.4, -2.0],
  [0, -1.05], [0, -1.55], [0, -1.9], [0, -2.2],
  [0.28, -0.98], [0.32, -1.42], [0.35, -1.72], [0.37, -1.95],
  [0.52, -0.85], [0.62, -1.2], [0.68, -1.42], [0.72, -1.62],
];
const demoWorld = new Float32Array(63);
function updateDemoHand(t, x, y) {
  const s = 9;
  for (let j = 0; j < 21; j++) {
    const [dx, dy] = DEMO_HAND[j];
    const wave = j > 4 && j % 4 !== 1 ? Math.sin(t * 2.2 + j * 0.5) * 0.06 * (j % 4 || 4) : 0;   // fingers ripple
    demoWorld[j * 3] = x + dx * s + wave * s;
    demoWorld[j * 3 + 1] = y - (dy + 1.05) * s;
    demoWorld[j * 3 + 2] = 0;
  }
}

// ─── Renderer / scene ────────────────────────────────────────────────────────
const canvas = document.getElementById('scene');
// No depth/stencil on the canvas (nothing uses them); post.js clears only what it needs.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, depth: false, stencil: false, powerPreference: 'high-performance' });
renderer.autoClear = false;
renderer.domElement.addEventListener('webglcontextlost', (e) => { e.preventDefault(); location.reload(); });
renderer.setClearColor(0x000000, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 0, 60);

// Trails + bloom + sRGB output in one lean pipeline (see post.js).
const post = new Post(renderer, scene, camera, { strength: P.bloom, radius: P.bloomRadius, threshold: 0, damp: P.trails });
const bloom = post.bloom;

// Render resolution. '4K' draws 3840 pixels across whatever the window size is.
const QUALITY = ['Auto', 'Fast', 'HD', 'Retina', '4K'];
const auto = { pr: Math.min(devicePixelRatio, 2), max: Math.min(devicePixelRatio, 2), slow: 0, fast: 0, blockUpUntil: 0, lastChange: 0 };
function pixelRatioFor(q, width = innerWidth) {
  if (q === 'Auto') return auto.pr;
  if (q === 'Fast') return 1;
  if (q === 'HD') return Math.min(devicePixelRatio, 1.5);
  if (q === '4K') return Math.min(3840 / width, 4);
  return Math.min(devicePixelRatio, 2);
}
let viewW = 1, viewH = 1;
function resize() {
  const pr = pixelRatioFor(P.quality);
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  post.setSize(renderer.domElement.width, renderer.domElement.height);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  viewH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
  viewW = viewH * camera.aspect;
  applyPR(pr);
  const el = document.getElementById('res');
  if (el) el.textContent = `${renderer.domElement.width}×${renderer.domElement.height}`;
}
function applyPR(pr) {                                   // dot size stays the same on screen at any resolution
  particles.material.uniforms.uPR.value = pr * (innerHeight / 900);
}

// Background star field, slowly drifting.
const stars = (() => {
  const n = 2500, p = new Float32Array(n * 3), c = new Float32Array(n * 3), col = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const r = 120 + Math.random() * 200, u = Math.random() * 2 - 1, t = Math.random() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    p.set([s * Math.cos(t) * r, u * r, s * Math.sin(t) * r - 60], i * 3);
    col.setHSL(Math.random(), 0.6, 0.55 + Math.random() * 0.3);
    c.set([col.r, col.g, col.b], i * 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const m = new THREE.PointsMaterial({ size: 0.9, vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const pts = new THREE.Points(g, m);
  pts.visible = P.stars;
  scene.add(pts);
  return pts;
})();

// Particles
const particles = new ParticleSystem(scene);
particles.setPalette(P.palette);
particles.material.uniforms.uSize.value = P.size;
particles.material.uniforms.uIntensity.value = P.brightness;
particles.material.uniforms.uHueSpeed.value = P.hueSpeed;
particles.build(P.count);
resize();
addEventListener('resize', onResize);

// Hand skeleton made of light (never the camera image).
const skeleton = (() => {
  const lineGeo = new THREE.BufferGeometry();
  lineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(2 * HAND_CONNECTIONS.length * 6), 3));
  const lines = new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({ color: 0x66ccff, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }));
  const jointGeo = new THREE.BufferGeometry();
  jointGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(42 * 3), 3));
  const joints = new THREE.Points(jointGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.7, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
  lines.frustumCulled = joints.frustumCulled = false;
  scene.add(lines, joints);
  return { lines, joints };
})();

// ─── Hand state ──────────────────────────────────────────────────────────────
const video = document.getElementById('cam');
const tracker = new HandTracker(video);
let mode = 'idle';                     // idle | camera | demo
const hands = [];                      // { label, lm, world: Float32Array(63), info, gesture, stab, fresh }
let lastSeen = 0, camStart = 0;

function newHand(label, info) {
  const stab = new GestureStabilizer(3);
  if (info.gesture !== 'unknown') stab.current = stab.candidate = info.gesture;   // respond at once, no 'none' gap
  return { label, world: new Float32Array(63), raw: new Float32Array(63), vel: new Float32Array(63), ts: 0, arrive: 0, seen: 0, stab, gesture: stab.current, fresh: true };
}

function onResults(res, now) {
  const found = res.landmarks || [];
  const ts = res.ts ?? now;                             // when the camera frame was captured
  const prevPrimary = hands[0];
  const next = [];
  found.forEach((lm, k) => {
    const label = res.handedness?.[k]?.[0]?.categoryName ?? 'H' + k;
    const info = classify(lm);
    // Same hand as before? Match by wrist position first (left/right labels can flip), then by label.
    let h = null, best = 0.15;
    for (const x of hands) {
      if (next.includes(x) || !x.lm) continue;
      const d = Math.hypot(x.lm[0].x - lm[0].x, x.lm[0].y - lm[0].y);
      if (d < best) { best = d; h = x; }
    }
    h ??= hands.find((x) => x.label === label && !next.includes(x)) ?? newHand(label, info);
    h.label = label; h.lm = lm; h.seen = now; h.arrive = now;
    trackResult(h, lm, ts);
    h.info = info;
    h.gesture = h.stab.push(info.gesture);
    next.push(h);
  });
  if (found.length) lastSeen = now;
  for (const x of hands) if (!next.includes(x) && now - x.seen < 250) next.push(x);   // survive one missed result
  next.sort((a, b) => (a.label < b.label ? 1 : -1));   // 'Right' is the primary hand…
  if (prevPrimary && next.includes(prevPrimary)) next.unshift(...next.splice(next.indexOf(prevPrimary), 1));   // …unless one already is
  hands.length = 0;
  hands.push(...next);
}

// Tracking results arrive ~10–20 times a second, each describing a camera frame from a moment ago.
// Between results, each joint keeps moving at its recent velocity for up to `prediction` ms, so the
// particles glide with the hand instead of stepping — and some of the tracking delay is hidden.
function trackResult(h, lm, ts) {
  const raw = h.raw, vel = h.vel, gap = ts - h.ts;
  for (let j = 0; j < 21; j++) {
    const l = lm[j], x = P.mirror ? 1 - l.x : l.x, j3 = j * 3;
    const wx = (x - 0.5) * viewW, wy = (0.5 - l.y) * viewH, wz = -l.z * 30;
    if (!h.fresh && gap > 0 && gap < 250) {             // velocity in world units per ms, lightly smoothed
      vel[j3] = vel[j3] * 0.4 + ((wx - raw[j3]) / gap) * 0.6;
      vel[j3 + 1] = vel[j3 + 1] * 0.4 + ((wy - raw[j3 + 1]) / gap) * 0.6;
      vel[j3 + 2] = vel[j3 + 2] * 0.4 + ((wz - raw[j3 + 2]) / gap) * 0.6;
    } else { vel[j3] = vel[j3 + 1] = vel[j3 + 2] = 0; }
    raw[j3] = wx; raw[j3 + 1] = wy; raw[j3 + 2] = wz;
  }
  h.ts = ts;
}

function updateHandWorld(dt, now) {
  const keep = Math.pow(P.smoothing, dt);
  for (const h of hands) {
    // Make up part of the tracking delay (capped at `prediction`), then keep gliding until the next result.
    const lead = P.prediction ? Math.min(h.arrive - h.ts, P.prediction) + Math.min(now - h.arrive, 100) : 0;
    for (let j = 0; j < 21; j++) {
      const j3 = j * 3;
      const wx = h.raw[j3] + h.vel[j3] * lead, wy = h.raw[j3 + 1] + h.vel[j3 + 1] * lead, wz = h.raw[j3 + 2] + h.vel[j3 + 2] * lead;
      const w = h.world;
      if (h.fresh) { w[j3] = wx; w[j3 + 1] = wy; w[j3 + 2] = wz; }
      else { w[j3] = wx + (w[j3] - wx) * keep; w[j3 + 1] = wy + (w[j3 + 1] - wy) * keep; w[j3 + 2] = wz + (w[j3 + 2] - wz) * keep; }
    }
    h.fresh = false;
  }
}

function anchorPoint(h, anchor) {
  const w = h.world;
  if (anchor === 'index') return { x: w[24], y: w[25] };
  if (anchor === 'pinch') return { x: (w[12] + w[24]) / 2, y: (w[13] + w[25]) / 2 };
  let x = 0, y = 0;
  for (const j of [0, 5, 9, 13, 17]) { x += w[j * 3]; y += w[j * 3 + 1]; }
  return { x: x / 5, y: y / 5 };
}

function drawSkeleton() {
  const show = P.skeleton && hands.length > 0;
  skeleton.lines.visible = skeleton.joints.visible = show;
  if (!show) return;
  const lp = skeleton.lines.geometry.attributes.position, jp = skeleton.joints.geometry.attributes.position;
  let li = 0;
  hands.forEach((h, hi) => {
    for (const [a, b] of HAND_CONNECTIONS) {
      lp.array.set(h.world.subarray(a * 3, a * 3 + 3), li); li += 3;
      lp.array.set(h.world.subarray(b * 3, b * 3 + 3), li); li += 3;
    }
    jp.array.set(h.world, hi * 63);
  });
  skeleton.lines.geometry.setDrawRange(0, li / 3);
  skeleton.joints.geometry.setDrawRange(0, hands.length * 21);
  lp.needsUpdate = jp.needsUpdate = true;
}

// ─── Simulation state ────────────────────────────────────────────────────────
const sim = {
  cx: 0, cy: 0, cz: 0, scale: 1, roll: 0, yaw: 0,
  rot: new THREE.Matrix4().elements, spring: P.spring, damping: P.damping, noise: P.noise,
  swirl: 0, lag: false, handMode: false, reps: new Float32Array(30), repCount: 0, repRadius: P.repelRadius, repStrength: P.repelStrength,
};
const euler = new THREE.Euler(0, 0, 0, 'ZXY'), mat = new THREE.Matrix4();
const mouse = { x: 0, y: 0 };
let demoGesture = 'open';
let gesture = null, shapeName = null;
const motion = { px: 0, py: 0, vx: 0, vy: 0, energy: 0, has: false };   // hand velocity (world units / frame)

function setGesture(g, force = false) {
  const s = P.map[g];
  if (!force && g === gesture && s === shapeName) return;
  // Let go of a pinch while moving → throw the particles (only if it's still the same hand).
  if (gesture === 'pinch' && g !== 'pinch' && samePrimary && Math.hypot(motion.vx, motion.vy) > 0.15) {
    particles.fling(motion.vx * 2.2, motion.vy * 2.2, P.throwPower);
    flash('Thrown!');
  }
  gesture = g;
  if (s !== shapeName || force) {
    shapeName = s;
    particles.setShape(s);
    const def = SHAPES[s];
    if (def.burst) particles.burst(sim.cx, sim.cy, sim.cz, def.burst);
    else particles.kick(0.5);
  }
  updateHud();
}

let lastPrimary = null, samePrimary = true;
function updateSim(dt, sec, t) {
  samePrimary = (hands[0] || null) === lastPrimary;
  lastPrimary = hands[0] || null;
  // 1. Which gesture is active?
  let g = 'none';
  if (hands.length) g = hands[0].gesture;
  else if (mode === 'demo') g = demoGesture;
  setGesture(g);
  const def = SHAPES[shapeName];

  // 2. Where should the formation be, how big, how rotated?
  let tx = 0, ty = 0, tScale = 1, tRoll = 0;
  if (hands.length) {
    const h = hands[0], w = h.world, p = anchorPoint(h, def.anchor);
    if (hands.length > 1 && def.anchor === 'palm') {
      const p2 = anchorPoint(hands[1], 'palm');
      tx = (p.x + p2.x) / 2; ty = (p.y + p2.y) / 2;
      tScale = THREE.MathUtils.clamp(Math.hypot(p.x - p2.x, p.y - p2.y) / 24, 0.35, 2.6);   // two hands stretch it
    } else {
      tx = p.x; ty = p.y;
      if (P.depthZoom && def.anchor === 'palm') tScale = THREE.MathUtils.clamp(h.info.size / 0.2, 0.55, 1.9);
    }
    if (P.handRoll) tRoll = -Math.atan2(w[27] - w[0], w[28] - w[1]);
  } else if (mode === 'demo') { tx = mouse.x; ty = mouse.y; }

  // Hand speed → energy (more flow) and the velocity used for throwing.
  const mx = hands.length ? anchorPoint(hands[0], 'palm').x : mode === 'demo' ? mouse.x : 0;
  const my = hands.length ? anchorPoint(hands[0], 'palm').y : mode === 'demo' ? mouse.y : 0;
  const has = hands.length > 0 || mode === 'demo';
  if (motion.has && has && samePrimary) {
    const k = 1 - Math.pow(0.7, dt);
    motion.vx += ((mx - motion.px) / dt - motion.vx) * k;
    motion.vy += ((my - motion.py) / dt - motion.vy) * k;
  } else {                                               // hand gone or switched: let the energy fade
    const d = Math.pow(0.7, dt);
    motion.vx *= d; motion.vy *= d;
  }
  motion.px = mx; motion.py = my; motion.has = has;
  const target = Math.min(1, Math.hypot(motion.vx, motion.vy) / 1.6);
  motion.energy += (target - motion.energy) * (target > motion.energy ? 0.25 : 0.04) * dt;

  if (!P.followHand && def.anchor === 'palm') { tx = 0; ty = 0; }

  // Particle hand: targets trace the real skeleton (or a demo hand under the mouse).
  sim.handMode = !!def.hand;
  if (def.hand) {
    if (hands.length) sim.handWorlds = hands.map((h) => h.world);
    else { updateDemoHand(t, mode === 'demo' ? mouse.x : 0, mode === 'demo' ? mouse.y : 0); sim.handWorlds = [demoWorld]; }
  } else sim.handWorlds = null;

  const f = 1 - Math.pow(0.82, dt);
  sim.cx += (tx - sim.cx) * f; sim.cy += (ty - sim.cy) * f;
  sim.scale += (tScale - sim.scale) * f * 0.6;
  let dr = tRoll - sim.roll; dr = Math.atan2(Math.sin(dr), Math.cos(dr));
  sim.roll += dr * f * 0.6;
  sim.yaw += def.spin * P.spin * sec;

  euler.set(def.tilt + Math.sin(t * 0.4) * 0.15, sim.yaw, sim.roll + Math.sin(t * 0.3) * 0.05);
  mat.makeRotationFromEuler(euler);
  sim.rot = mat.elements;

  // 3. Forces
  sim.spring = P.spring * (def.spring ?? 1);
  sim.damping = P.damping;
  sim.noise = P.noise * (1 + motion.energy * 4 * P.energy);
  sim.swirl = def.swirl ?? 0;
  sim.lag = !!def.lag;
  sim.repRadius = P.repelRadius;
  sim.repStrength = P.repelStrength;
  sim.repCount = 0;
  if (P.repel && def.repel !== false) {
    if (hands.length) {
      for (const h of hands) for (const j of [4, 8, 12, 16, 20]) {
        sim.reps.set(h.world.subarray(j * 3, j * 3 + 3), sim.repCount * 3);
        sim.repCount++;
      }
    } else if (mode === 'demo' && mouse.down) {
      sim.reps.set([mouse.x, mouse.y, 0], 0); sim.repCount = 1;
    }
  }
}

// ─── HUD ─────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const legend = $('legend');
for (const [key, g] of Object.entries(GESTURES)) {
  const el = document.createElement('button');
  el.className = 'card';
  el.dataset.g = key;
  el.innerHTML = `<span class="ic">${g.icon}</span><span class="nm">${g.label}</span><span class="sh"></span><kbd>${g.key}</kbd>`;
  el.onclick = () => { demoGesture = key; if (mode === 'idle') startDemo(); };
  legend.appendChild(el);
}
let flashT = 0;
function flash(text) {
  const el = $('flash');
  el.textContent = text;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  clearTimeout(flashT); flashT = setTimeout(() => el.classList.remove('show'), 1400);
}
function updateHud() {
  const g = GESTURES[gesture];
  $('g-icon').textContent = g.icon;
  $('g-name').textContent = g.label;
  $('g-shape').textContent = SHAPES[shapeName].label;
  for (const el of legend.children) {
    el.classList.toggle('on', el.dataset.g === gesture);
    el.querySelector('.sh').textContent = SHAPES[P.map[el.dataset.g]].label;
  }
}

// ─── Control panel ───────────────────────────────────────────────────────────
const gui = new GUI({ title: '✦ Controls' });
const u = particles.material.uniforms;
const ui = { preset: 'Default' };
gui.add(ui, 'preset', Object.keys(PRESETS)).name('✨ preset').onChange((name) => {
  const p = PRESETS[name];
  for (const c of gui.controllersRecursive()) if (c.object === P && c.property in p) c.setValue(p[c.property]);
  save();
});
const fP = gui.addFolder('Particles');
fP.add(P, 'count', [10000, 20000, 30000, 45000, 60000, 80000]).name('count').onChange((n) => { particles.build(n); settle(); });
fP.add(P, 'size', 0.5, 10, 0.1).onChange((v) => (u.uSize.value = v));
fP.add(P, 'brightness', 0.1, 1.5, 0.01).onChange((v) => (u.uIntensity.value = v));
const fC = gui.addFolder('Color');
fC.add(P, 'palette', Object.keys(PALETTES)).onChange((v) => particles.setPalette(v));
fC.add(P, 'hueSpeed', 0, 0.4, 0.005).name('color cycle').onChange((v) => (u.uHueSpeed.value = v));
const fM = gui.addFolder('Motion');
fM.add(P, 'spring', 0.005, 0.2, 0.001).name('snap to shape');
fM.add(P, 'damping', 0.7, 0.99, 0.005);
fM.add(P, 'noise', 0, 0.5, 0.005).name('flow noise');
fM.add(P, 'spin', 0, 4, 0.05).name('spin speed');
const fH = gui.addFolder('Hand');
fH.add(P, 'followHand').name('follow hand');
fH.add(P, 'depthZoom').name('closer = bigger');
fH.add(P, 'handRoll').name('rotate with hand');
fH.add(P, 'smoothing', 0, 0.9, 0.01).name('smoothing');
fH.add(P, 'prediction', 0, 150, 5).name('motion prediction (ms)');
fH.add(P, 'repel').name('fingertip ripples');
fH.add(P, 'repelStrength', 0, 5, 0.05).name('ripple force');
fH.add(P, 'repelRadius', 1, 20, 0.5).name('ripple radius');
fH.add(P, 'energy', 0, 3, 0.05).name('motion energy');
fH.add(P, 'throwPower', 0, 3, 0.05).name('pinch throw');
fH.add(P, 'mirror');
fH.add(P, 'skeleton').name('light skeleton');
const fE = gui.addFolder('Effects');
fE.add(P, 'bloom', 0, 3, 0.01).onChange((v) => (bloom.strength = v));
fE.add(P, 'bloomRadius', 0, 1.2, 0.01).name('bloom radius').onChange((v) => (bloom.radius = v));
fE.add(P, 'trails', 0, 0.97, 0.01).name('motion trails').onChange((v) => post.setDamp(v));
fE.add(P, 'stars').onChange((v) => (stars.visible = v));
fE.add(P, 'quality', QUALITY).name('render quality').onChange(resize);
const fG = gui.addFolder('Gesture → Shape');
for (const key of Object.keys(GESTURES)) {
  fG.add(P.map, key, SHAPE_NAMES).name(`${GESTURES[key].icon} ${GESTURES[key].label}`).onChange(() => setGesture(gesture, true));
}
fG.close();
gui.add({ reset() { try { localStorage.removeItem(STORE); } catch { /* ignore */ } location.reload(); } }, 'reset').name('↺ reset everything');
gui.onFinishChange(save);
fM.close(); fE.close(); fH.close();

// ─── Snapshot & recording ────────────────────────────────────────────────────
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
let snapRequested = false;
// Snapshots are always rendered at 4K (3840 px wide), then the screen goes back to its own quality.
function takeSnapshot() {
  const pr = pixelRatioFor('4K');
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight, false);
  post.setSize(renderer.domElement.width, renderer.domElement.height);
  applyPR(pr);
  post.setGlass([], 0);                                  // the HTML panels aren't in the picture, so neither is their glass
  post.render();
  canvas.toBlob((b) => b && download(b, `particle-hands-4k-${stamp()}.png`), 'image/png');
  resize();
  settle(1500);
  flash('4K snapshot saved');
}
let recorder = null, recStart = 0;
function toggleRecording() {
  if (recorder) { recorder.stop(); return; }
  if (!window.MediaRecorder) { flash('Recording is not supported in this browser'); return; }
  const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const chunks = [];
  recorder = new MediaRecorder(canvas.captureStream(60), { mimeType: type, videoBitsPerSecond: canvas.width >= 3000 ? 50e6 : 25e6 });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    download(new Blob(chunks, { type }), `particle-hands-${stamp()}.${type.startsWith('video/mp4') ? 'mp4' : 'webm'}`);
    recorder = null;
    $('btn-rec').classList.remove('rec');
    $('btn-rec').textContent = '⏺ Record';
    flash('Video saved');
  };
  recorder.start(250);
  recStart = performance.now();
  $('btn-rec').classList.add('rec');
}
$('btn-snap').onclick = () => (snapRequested = true);
$('btn-rec').onclick = toggleRecording;
$('btn-full').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen());

// ─── Start screen ────────────────────────────────────────────────────────────
const status = (s) => ($('status').textContent = s);
// On narrow windows the control panel would cover the start screen; keep it closed until then.
const guiWasOpen = !gui._closed;
if (innerWidth < 1100) gui.close();
function hideStart() {
  $('start').classList.add('gone');
  if (guiWasOpen && innerWidth >= 700) gui.open();
}
function startDemo() {
  mode = 'demo';
  $('mode').textContent = 'Mouse demo · keys 0-8';
  hideStart();
}
$('btn-cam').onclick = async () => {
  $('btn-cam').disabled = true;
  gov.settleUntil = Infinity;                            // loading the trackers is not a reason to lower quality
  try {
    await tracker.init(status);
    mode = 'camera';
    camStart = performance.now();
    gov.settleUntil = 0; settle(8000);
    $('mode').textContent = `Camera · ${tracker.delegate} · ${tracker.mode}`;
    hideStart();
  } catch (e) {
    console.error(e);
    gov.settleUntil = 0; settle();
    status(`Camera unavailable (${e.name || e.message}). Try demo mode.`);
    $('btn-cam').disabled = false;
  }
};
$('btn-demo').onclick = startDemo;

addEventListener('pointermove', (e) => {
  mouse.x = (e.clientX / innerWidth - 0.5) * viewW;
  mouse.y = (0.5 - e.clientY / innerHeight) * viewH;
});
canvas.addEventListener('pointerdown', () => (mouse.down = true));
addEventListener('pointerup', () => (mouse.down = false));
addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;             // held keys and browser shortcuts
  if (e.target.closest?.('input, select, textarea, [contenteditable]')) return;
  const k = e.key.toLowerCase();                                         // works with Caps Lock too
  const g = Object.keys(GESTURES).find((x) => GESTURES[x].key === k);
  if (g) { demoGesture = g; if (mode === 'idle') startDemo(); }
  if (k === 'h') document.body.classList.toggle('clean');
  if (k === 's') snapRequested = true;
  if (k === 'r') toggleRecording();
  if (k === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});

// ─── Frosted glass ───────────────────────────────────────────────────────────
// The HUD panels look like frosted glass. Instead of CSS backdrop-filter (which re-blurs the
// canvas under each panel every frame and cost ~30 ms/frame on integrated graphics), the page
// reports where the panels are and post.js draws the blur inside the WebGL frame.
const legendEl = document.getElementById('legend');
const glassEls = [...document.querySelectorAll('.gesture, .tools button, .card, #hint, #start .panel, .lil-gui.root')];
// Each panel fades with a container (the HUD, the legend, the hint, the start screen, the panel itself);
// the glass takes that container's current opacity so it fades in and out with it.
const fadeRoot = (el) => el.closest('#hud, #legend, #hint, #start') || el;
const glassFade = new Map(glassEls.map((el) => [el, fadeRoot(el)]));
const radiusOf = new Map();
const glassRects = [], alphaOf = new Map();
function collectGlass(off) {
  glassRects.length = 0;
  if (off) return glassRects;
  alphaOf.clear();
  const s = renderer.domElement.width / innerWidth, H = renderer.domElement.height;
  const lr = legendEl.getBoundingClientRect();
  for (const el of glassEls) {
    const root = glassFade.get(el);
    if (!alphaOf.has(root)) alphaOf.set(root, parseFloat(getComputedStyle(root).opacity));
    const a = alphaOf.get(root);
    if (!(a > 0.01)) continue;
    let { left, top, right, bottom } = el.getBoundingClientRect();
    if (el.classList.contains('card')) {                // cards can scroll out of the legend strip
      left = Math.max(left, lr.left); right = Math.min(right, lr.right);
      if (right <= left) continue;
    }
    if (!radiusOf.has(el)) radiusOf.set(el, parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0);
    const r = Math.min(radiusOf.get(el), (right - left) / 2, (bottom - top) / 2);
    glassRects.push({ x0: left * s, x1: right * s, y0: H - bottom * s, y1: H - top * s, r: r * s, a });
    if (glassRects.length === MAX_GLASS) break;
  }
  return glassRects;
}
const GLASS_BLUR = 14;                                   // CSS px, same as the old blur(14px)

// ─── Auto quality ────────────────────────────────────────────────────────────
// 'Auto' renders at full Retina sharpness and only lowers the resolution if the frame rate stays
// below 60 (e.g. on a large external monitor). It tries going back up after a stable minute.
// It ignores the first seconds after start-up or any big change (shaders compiling, trackers
// loading) and only reacts to a slowdown that lasts 3 seconds in a row.
const gov = { t0: 0, n: 0, hitch: false, settleUntil: performance.now() + 6000 };
function settle(ms = 4000) {
  gov.settleUntil = Math.max(gov.settleUntil, performance.now() + ms);
  gov.t0 = 0; gov.n = 0; auto.slow = 0;
}
function setAutoPR(pr, now) {
  auto.pr = +pr.toFixed(3); auto.slow = auto.fast = 0; auto.lastChange = now;
  resize();
  settle(1500);
}
// Runs before the frame is drawn, so a resolution change never shows a blank frame.
function governQuality(frameMs, now) {
  if (P.quality !== 'Auto' || now < gov.settleUntil) { gov.t0 = 0; gov.n = 0; return; }
  if (frameMs > 200) gov.hitch = true;                   // tab switch or similar: don't judge this window
  if (!gov.t0) { gov.t0 = now; gov.n = 0; return; }
  gov.n++;
  if (now - gov.t0 < 1000) return;
  const fps = (gov.n * 1000) / (now - gov.t0), hitch = gov.hitch;
  gov.t0 = now; gov.n = 0; gov.hitch = false;
  if (hitch) return;
  if (auto.probe) {                                      // first judgement after a change
    const p = auto.probe; auto.probe = null;
    if (p.down && fps < p.fps * 1.05) {                  // lowering didn't help (e.g. a 50 Hz display): undo it
      auto.noDownUntil = now + 60000; setAutoPR(p.from, now); return;
    }
    if (!p.down && fps < 55) {                           // going back up didn't hold: wait longer next time
      auto.backoff = Math.min((auto.backoff || 60000) * 2, 960000);
      auto.blockUpUntil = now + auto.backoff; setAutoPR(p.from, now); return;
    }
  }
  if (fps < 55) {
    auto.fast = 0;
    if (++auto.slow >= 3 && auto.pr > 1 && now > (auto.noDownUntil || 0)) {
      auto.probe = { down: true, fps, from: auto.pr };
      setAutoPR(Math.max(1, auto.pr * 0.85), now);
    }
  } else if (fps > 58.5) {
    auto.slow = 0;
    if (++auto.fast >= 60 && auto.pr < auto.max && now > auto.blockUpUntil) {
      auto.probe = { down: false, fps, from: auto.pr };
      setAutoPR(Math.min(auto.max, auto.pr / 0.85), now);
    }
  } else auto.slow = 0;
}
// Window resized or moved to a screen with a different pixel density.
let lastDpr = devicePixelRatio;
function onResize() {
  if (devicePixelRatio !== lastDpr) { auto.pr *= devicePixelRatio / lastDpr; lastDpr = devicePixelRatio; auto.backoff = 0; }
  auto.max = Math.min(devicePixelRatio, 2);
  auto.pr = Math.min(Math.max(auto.pr, 1), auto.max);
  resize();
  settle();
}

// ─── Main loop ───────────────────────────────────────────────────────────────
let last = performance.now(), t = 0, frames = 0, fpsT = last;
const energyEl = $('energy'), hintEl = $('hint');
const hud = { energy: -1, hint: null, rec: -1 };
setGesture('none', true);

function frame(now) {
  requestAnimationFrame(frame);
  const frameMs = now - last, ms = Math.min(frameMs, 50);
  last = now;
  const dt = ms / 16.667, sec = ms / 1000;
  t += sec;

  if (mode === 'camera') {
    const res = tracker.detect(now);
    if (res) onResults(res, now);
    else if (now - lastSeen > 280) hands.length = 0;
    updateHandWorld(dt, now);
  }

  updateSim(dt, sec, t);
  particles.update(dt, t, sim);
  drawSkeleton();
  stars.rotation.y += sec * 0.01;
  stars.rotation.x = Math.sin(t * 0.05) * 0.1;
  // Snapshot and quality changes resize the canvas, which blanks it, so they happen before the draw.
  if (snapRequested) { snapRequested = false; takeSnapshot(); }
  governQuality(frameMs, now);
  post.setGlass(collectGlass(!!recorder), GLASS_BLUR * (renderer.domElement.width / innerWidth));   // not in recordings
  post.render();

  // Touch the DOM only when something visibly changed (each write forces the page to re-composite).
  const e = Math.round(motion.energy * 100);
  if (e !== hud.energy) { hud.energy = e; energyEl.style.transform = `scaleX(${e / 100})`; }
  const hint = mode === 'camera' && !hands.length && now - Math.max(lastSeen, camStart) > 1500;
  if (hint !== hud.hint) { hud.hint = hint; hintEl.classList.toggle('show', hint); }
  if (recorder) {
    const secs = Math.floor((now - recStart) / 1000);
    if (secs !== hud.rec) { hud.rec = secs; $('btn-rec').textContent = `■ ${secs}s`; }
  } else hud.rec = -1;

  frames++;
  if (now - fpsT > 500) {
    $('fps').textContent = Math.round((frames * 1000) / (now - fpsT));
    $('hands').textContent = hands.length;
    frames = 0; fpsT = now;
  }
}
requestAnimationFrame(frame);

// ─── Benchmark (only with ?perf in the URL) ──────────────────────────────────
// Runs frames back-to-back, independent of requestAnimationFrame, and waits for the GPU
// after each one, so the numbers are real even when the tab is in the background.
if (new URLSearchParams(location.search).has('perf')) {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  window.__ph = { bloom, post, particles, stars, renderer, P, resize, pixelRatioFor, tracker };
  window.__phBench = (n = 120, gesture = 'open') => {
    mode = 'demo'; demoGesture = gesture;
    const out = { sim: 0, render: 0, total: 0 };
    for (let i = 0; i < n; i++) {
      const a = performance.now();
      t += 1 / 60;
      updateSim(1, 1 / 60, t);
      particles.update(1, t, sim);
      const b = performance.now();
      post.render();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));   // forces the GPU to finish
      const c = performance.now();
      out.sim += b - a; out.render += c - b; out.total += c - a;
    }
    for (const k in out) out[k] = +(out[k] / n).toFixed(2);
    out.fps = Math.round(1000 / out.total);
    out.res = `${renderer.domElement.width}x${renderer.domElement.height}`;
    out.gpu = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';
    out.physicsThread = particles.mode;
    return out;
  };
  // Cost of one physics step (what the worker spends per frame, off the main thread).
  window.__phPhysics = async (n = 60, shape = 'galaxy') => {
    const { Physics } = await import('./physics.js');
    const ph = new Physics(); ph.build(P.count); ph.setShape(shape);
    const s = { ...sim, handMode: false, handWorlds: null };
    const a = performance.now();
    for (let i = 0; i < n; i++) ph.update(1, i / 60, s);
    return +((performance.now() - a) / n).toFixed(2);
  };
}
