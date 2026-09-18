import * as THREE from 'three';
import { Post } from './post.js';
import GUI from 'lil-gui';
import { SHAPES, SHAPE_NAMES } from './shapes.js';
import { ParticleSystem, PALETTES } from './particles.js';
import { GESTURES, classify, GestureStabilizer } from './gestures.js';
import { HandTracker, HAND_CONNECTIONS } from './hands.js';

// ─── Settings (everything here is live-editable in the panel) ────────────────
const P = {
  count: 30000, size: 2.3, brightness: 0.7,
  palette: 'Rainbow', hueSpeed: 0.04,
  spring: 0.05, damping: 0.9, noise: 0.08, spin: 1,
  followHand: true, depthZoom: true, handRoll: true, smoothing: 0.45,
  repel: true, repelStrength: 1.6, repelRadius: 7, energy: 1, throwPower: 1.2,
  mirror: true, skeleton: true,
  bloom: 0.8, bloomRadius: 0.35, trails: 0.6, stars: true, quality: 'Retina',
  map: {
    none: 'nebula', open: 'galaxy', fist: 'core', point: 'swarm', peace: 'heart',
    three: 'hand', rock: 'explosion', thumbs: 'saturn', pinch: 'blackhole',
  },
};

// Settings survive a reload (per browser). Everything works without storage too.
const STORE = 'particle-hands:v2';   // v2: bigger dots + 4K quality
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
const QUALITY = ['Fast', 'HD', 'Retina', '4K'];
function pixelRatioFor(q, width = innerWidth) {
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
addEventListener('resize', resize);

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

function onResults(res, now) {
  const found = res.landmarks || [];
  if (!found.length) { if (now - lastSeen > 280) hands.length = 0; return; }
  lastSeen = now;
  const next = [];
  found.forEach((lm, k) => {
    const label = res.handedness?.[k]?.[0]?.categoryName ?? 'H' + k;
    let h = hands.find((x) => x.label === label && !next.includes(x));
    if (!h) h = { label, world: new Float32Array(63), stab: new GestureStabilizer(3), gesture: 'none', fresh: true };
    h.lm = lm;
    h.info = classify(lm);
    h.gesture = h.stab.push(h.info.gesture);
    next.push(h);
  });
  next.sort((a, b) => (a.label < b.label ? 1 : -1));   // 'Right' is the primary hand
  hands.length = 0;
  hands.push(...next);
}

function updateHandWorld(dt) {
  const keep = Math.pow(P.smoothing, dt);
  for (const h of hands) {
    for (let j = 0; j < 21; j++) {
      const l = h.lm[j], x = P.mirror ? 1 - l.x : l.x;
      const wx = (x - 0.5) * viewW, wy = (0.5 - l.y) * viewH, wz = -l.z * 30;
      const w = h.world, j3 = j * 3;
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
  // Let go of a pinch while moving → throw the particles.
  if (gesture === 'pinch' && g !== 'pinch' && Math.hypot(motion.vx, motion.vy) > 0.15) {
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

function updateSim(dt, sec, t) {
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
  if (motion.has) {
    const k = 1 - Math.pow(0.7, dt);
    motion.vx += ((mx - motion.px) / dt - motion.vx) * k;
    motion.vy += ((my - motion.py) / dt - motion.vy) * k;
  }
  motion.px = mx; motion.py = my; motion.has = hands.length > 0 || mode === 'demo';
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
fP.add(P, 'count', [10000, 20000, 30000, 45000, 60000, 80000]).name('count').onChange((n) => particles.build(n));
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
  post.render();
  canvas.toBlob((b) => b && download(b, `particle-hands-4k-${stamp()}.png`), 'image/png');
  resize();
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
function hideStart() { $('start').classList.add('gone'); }
function startDemo() {
  mode = 'demo';
  $('mode').textContent = 'Mouse demo · keys 0-8';
  hideStart();
}
$('btn-cam').onclick = async () => {
  $('btn-cam').disabled = true;
  try {
    await tracker.init(status);
    mode = 'camera';
    camStart = performance.now();
    $('mode').textContent = `Camera · ${tracker.delegate} · ${tracker.mode}`;
    hideStart();
  } catch (e) {
    console.error(e);
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
  if (e.target.tagName === 'INPUT') return;
  const g = Object.keys(GESTURES).find((k) => GESTURES[k].key === e.key);
  if (g) { demoGesture = g; if (mode === 'idle') startDemo(); }
  if (e.key === 'h') document.body.classList.toggle('clean');
  if (e.key === 's') snapRequested = true;
  if (e.key === 'r') toggleRecording();
  if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});

// ─── Main loop ───────────────────────────────────────────────────────────────
let last = performance.now(), t = 0, frames = 0, fpsT = last;
const energyEl = $('energy'), hintEl = $('hint');
const hud = { energy: -1, hint: null, rec: -1 };
setGesture('none', true);

function frame(now) {
  requestAnimationFrame(frame);
  const ms = Math.min(now - last, 50);
  last = now;
  const dt = ms / 16.667, sec = ms / 1000;
  t += sec;

  if (mode === 'camera') {
    const res = tracker.detect(now);
    if (res) onResults(res, now);
    else if (now - lastSeen > 280) hands.length = 0;
    updateHandWorld(dt);
  }

  updateSim(dt, sec, t);
  particles.update(dt, t, sim);
  drawSkeleton();
  stars.rotation.y += sec * 0.01;
  stars.rotation.x = Math.sin(t * 0.05) * 0.1;
  post.render();
  if (snapRequested) { snapRequested = false; takeSnapshot(); }

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
  window.__ph = { bloom, post, particles, stars, renderer, P, resize, pixelRatioFor };
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
