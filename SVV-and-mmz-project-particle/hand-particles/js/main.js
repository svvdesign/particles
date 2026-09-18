import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import GUI from 'lil-gui';
import { SHAPES, SHAPE_NAMES } from './shapes.js';
import { ParticleSystem, PALETTES } from './particles.js';
import { GESTURES, classify, GestureStabilizer } from './gestures.js';
import { HandTracker, HAND_CONNECTIONS } from './hands.js';

// ─── Settings (everything here is live-editable in the panel) ────────────────
const P = {
  count: 30000, size: 1.5, brightness: 0.85,
  palette: 'Rainbow', hueSpeed: 0.04,
  spring: 0.05, damping: 0.9, noise: 0.08, spin: 1,
  followHand: true, depthZoom: true, handRoll: true, smoothing: 0.45,
  repel: true, repelStrength: 1.6, repelRadius: 7,
  mirror: true, skeleton: true,
  bloom: 0.95, bloomRadius: 0.4, trails: 0.72, stars: true, quality: 1.5,
  map: {
    none: 'nebula', open: 'galaxy', fist: 'core', point: 'swarm', peace: 'heart',
    three: 'flower', rock: 'explosion', thumbs: 'saturn', pinch: 'blackhole',
  },
};

// ─── Renderer / scene ────────────────────────────────────────────────────────
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setClearColor(0x000000, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 1000);
camera.position.set(0, 0, 60);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const afterimage = new AfterimagePass(P.trails);
composer.addPass(afterimage);
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), P.bloom, P.bloomRadius, 0);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let viewW = 1, viewH = 1;
function resize() {
  const pr = Math.min(devicePixelRatio, P.quality);
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight);
  composer.setPixelRatio(pr);
  composer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  viewH = 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.z;
  viewW = viewH * camera.aspect;
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
let lastSeen = 0;

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
  swirl: 0, lag: false, reps: new Float32Array(30), repCount: 0, repRadius: P.repelRadius, repStrength: P.repelStrength,
};
const euler = new THREE.Euler(0, 0, 0, 'ZXY'), mat = new THREE.Matrix4();
const mouse = { x: 0, y: 0 };
let demoGesture = 'open';
let gesture = null, shapeName = null;

function setGesture(g, force = false) {
  const s = P.map[g];
  if (!force && g === gesture && s === shapeName) return;
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
  if (!P.followHand && def.anchor === 'palm') { tx = 0; ty = 0; }

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
  sim.noise = P.noise;
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
const fP = gui.addFolder('Particles');
fP.add(P, 'count', [10000, 20000, 30000, 45000, 60000, 80000]).name('count').onChange((n) => particles.build(n));
fP.add(P, 'size', 0.5, 6, 0.1).onChange((v) => (u.uSize.value = v));
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
fH.add(P, 'mirror');
fH.add(P, 'skeleton').name('light skeleton');
const fE = gui.addFolder('Effects');
fE.add(P, 'bloom', 0, 3, 0.01).onChange((v) => (bloom.strength = v));
fE.add(P, 'bloomRadius', 0, 1.2, 0.01).name('bloom radius').onChange((v) => (bloom.radius = v));
fE.add(P, 'trails', 0, 0.97, 0.01).name('motion trails').onChange((v) => { afterimage.uniforms.damp.value = v; afterimage.enabled = v > 0; });
fE.add(P, 'stars').onChange((v) => (stars.visible = v));
fE.add(P, 'quality', [1, 1.5, 2]).name('pixel ratio').onChange(resize);
const fG = gui.addFolder('Gesture → Shape');
for (const key of Object.keys(GESTURES)) {
  fG.add(P.map, key, SHAPE_NAMES).name(`${GESTURES[key].icon} ${GESTURES[key].label}`).onChange(() => setGesture(gesture, true));
}
fG.close();
fM.close(); fE.close(); fH.close();

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
    $('mode').textContent = `Camera · ${tracker.delegate}`;
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
  if (e.key === 'f') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
});

// ─── Main loop ───────────────────────────────────────────────────────────────
let last = performance.now(), t = 0, frames = 0, fpsT = last;
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
  composer.render();

  frames++;
  if (now - fpsT > 500) {
    $('fps').textContent = Math.round((frames * 1000) / (now - fpsT));
    $('hands').textContent = hands.length;
    frames = 0; fpsT = now;
  }
}
requestAnimationFrame(frame);
