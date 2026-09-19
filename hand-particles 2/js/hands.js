// Camera + MediaPipe HandLandmarker. The video never touches the screen —
// it only feeds the tracker, which runs in a Web Worker (tracker-worker.js).

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
export const TRACKER_FILES = {
  bundle: `${CDN}/vision_bundle.cjs`,
  wasm: `${CDN}/wasm`,
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  loadModel: null,                                       // async () => Uint8Array; default fetches `model` once
  // Measured on an Intel MacBook (Iris Plus 655): MediaPipe on the GPU competes with the particle
  // renderer for the one graphics chip (2–8 results/s), while CPU trackers in workers leave it alone.
  // One CPU tracker gives ~6 results/s; four in parallel give ~18/s, all at a steady 60 fps.
  delegate: 'CPU',                                       // preferred; the other one is the fallback
  inputWidth: 640,                                       // frames are scaled to this width before tracking
  numHands: 2,
  worker: true,
  workers: Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2))),
};

async function fetchModel() {
  const res = await fetch(TRACKER_FILES.model);
  if (!res.ok) throw new Error(`Hand model download failed (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export class HandTracker {
  constructor(video) {
    this.video = video; this.ready = false; this.lastTime = -1;
    this.delegate = 'GPU'; this.mode = 'worker';
    this.pool = []; this.pending = null; this.appliedTs = -1;
  }

  get worker() { return this.pool.length > 0; }

  async init(onStatus = () => {}) {
    onStatus('Requesting camera…');
    const camera = navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      audio: false,
    });
    camera.catch(() => {});                              // handled below; avoid an unhandled-rejection warning
    try {
      // Load the trackers only once: if the camera was refused and the user tries again,
      // the trackers from the first attempt are reused instead of starting (and leaking) new ones.
      if (!this.pool.length && !this.landmarker) {
        onStatus('Loading hand-tracking model…');
        try {
          if (!TRACKER_FILES.worker) throw new Error('worker disabled');
          await this.initWorker();
        } catch (e) {
          console.warn('Tracker worker failed, running on the main thread', e);
          for (const slot of this.slots || []) slot.worker.terminate();
          this.pool = [];
          this.mode = 'main thread';
          await this.initMainThread();
        }
      }
    } catch (e) {
      camera.then((stream) => stream.getTracks().forEach((t) => t.stop()), () => {});   // don't leave the camera on
      throw e;
    }
    this.video.srcObject = await camera;
    await this.video.play();
    this.ready = true;
    onStatus('Ready');
  }


  // One or more tracker workers. Each keeps its own tracking state and simply sees every Nth
  // frame; results are applied newest-first, so a slow one can never move the hand backwards.
  // Tracking starts as soon as the first worker is ready; the others join when they are.
  async initWorker() {
    const f = TRACKER_FILES;
    const count = Math.max(1, f.workers | 0);
    const modelBytes = await (f.loadModel || fetchModel)();   // downloaded once, copied to each worker
    this.slots = [];
    const start = () => new Promise((resolve, reject) => {
      const slot = { worker: new Worker(new URL('./tracker-worker.js', import.meta.url)), busy: false };
      this.slots.push(slot);
      slot.worker.onerror = (e) => reject(e.message || e);
      slot.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { this.delegate = m.delegate; resolve(slot); }
        else if (m.type === 'error') reject(m.message);
        else if (m.type === 'result') {
          slot.busy = false;
          this.inferMs = this.inferMs ? this.inferMs * 0.9 + m.ms * 0.1 : m.ms;
          this.results = (this.results || 0) + 1;
          if (m.ts > this.appliedTs) { this.appliedTs = m.ts; this.pending = m; }
        }
      };
      const modelBuffer = modelBytes ? modelBytes.slice() : null;
      slot.worker.postMessage({ type: 'init', bundle: f.bundle, wasm: f.wasm, model: f.model, modelBuffer, delegate: f.delegate, numHands: f.numHands }, modelBuffer ? [modelBuffer.buffer] : []);
    });
    // All trackers start together while the loading screen is up. (Starting extra ones later,
    // while tracking is already busy, measured far slower: they queue behind the running one.)
    const results = await Promise.allSettled(Array.from({ length: count }, start));
    this.pool = results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
    for (const r of results) if (r.status === 'rejected') console.warn('A hand tracker failed to start', r.reason);
    if (!this.pool.length) throw new Error(String(results[0].reason));
    for (const slot of this.slots) if (!this.pool.includes(slot)) slot.worker.terminate();
  }

  async initMainThread() {
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    const f = TRACKER_FILES;
    const fileset = await FilesetResolver.forVisionTasks(f.wasm);
    const modelBuffer = await (f.loadModel || fetchModel)();
    const opts = (delegate) => ({
      baseOptions: { modelAssetBuffer: modelBuffer, delegate },
      runningMode: 'VIDEO', numHands: f.numHands,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    const order = ['GPU', 'CPU'];                         // on the main thread the GPU is far less blocking
    this.delegate = order[0];
    try { this.landmarker = await HandLandmarker.createFromOptions(fileset, opts(order[0])); }
    catch { this.delegate = order[1]; this.landmarker = await HandLandmarker.createFromOptions(fileset, opts(order[1])); }
  }

  // Called every animation frame. Sends each new camera frame to the worker (one at a time)
  // and returns the newest finished result once, or null if nothing new arrived.
  detect(now) {
    if (!this.ready || this.video.readyState < 2) return null;
    const t = this.video.currentTime;
    if (!this.worker) {                                  // fallback: synchronous, as before
      if (t === this.lastTime) return null;
      this.lastTime = t;
      const t0 = performance.now();
      const res = this.landmarker.detectForVideo(this.video, now);
      const ms = performance.now() - t0;
      this.inferMs = this.inferMs ? this.inferMs * 0.9 + ms * 0.1 : ms;
      this.results = (this.results || 0) + 1;
      return res;
    }
    const slot = t !== this.lastTime && this.pool.find((s) => !s.busy);
    if (slot) {
      this.lastTime = t;
      slot.busy = true;
      const w = TRACKER_FILES.inputWidth, h = Math.round(w * this.video.videoHeight / this.video.videoWidth) || w * 3 / 4;
      createImageBitmap(this.video, { resizeWidth: w, resizeHeight: h, resizeQuality: 'low' })
        .then((bitmap) => slot.worker.postMessage({ type: 'frame', bitmap, ts: now }, [bitmap]))
        .catch(() => { slot.busy = false; });
    }
    const res = this.pending;
    this.pending = null;
    return res;
  }
}
