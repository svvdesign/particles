// Camera + MediaPipe HandLandmarker. The video never touches the screen —
// it only feeds the tracker, which runs in a Web Worker (tracker-worker.js).

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
export const TRACKER_FILES = {
  bundle: `${CDN}/vision_bundle.cjs`,
  wasm: `${CDN}/wasm`,
  model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  loadModel: null,                                       // optional async () => Uint8Array (hosted copies)
};

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
    this.busy = false; this.pending = null;
  }

  async init(onStatus = () => {}) {
    onStatus('Requesting camera…');
    const camera = navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      audio: false,
    });
    camera.catch(() => {});                              // handled below; avoid an unhandled-rejection warning
    onStatus('Loading hand-tracking model…');
    try {
      await this.initWorker();
    } catch (e) {
      console.warn('Tracker worker failed, running on the main thread', e);
      this.worker?.terminate(); this.worker = null;
      this.mode = 'main thread';
      await this.initMainThread();
    }
    this.video.srcObject = await camera;
    await this.video.play();
    this.ready = true;
    onStatus('Ready');
  }

  async initWorker() {
    const f = TRACKER_FILES;
    const modelBuffer = f.loadModel ? await f.loadModel() : null;
    this.worker = new Worker(new URL('./tracker-worker.js', import.meta.url));
    await new Promise((resolve, reject) => {
      this.worker.onerror = (e) => reject(e.message || e);
      this.worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'ready') { this.delegate = m.delegate; resolve(); }
        else if (m.type === 'error') reject(m.message);
        else if (m.type === 'result') { this.pending = m; this.busy = false; }
      };
      this.worker.postMessage({ type: 'init', bundle: f.bundle, wasm: f.wasm, model: f.model, modelBuffer }, modelBuffer ? [modelBuffer.buffer] : []);
    });
  }

  async initMainThread() {
    const { FilesetResolver, HandLandmarker } = await import('@mediapipe/tasks-vision');
    const f = TRACKER_FILES;
    const fileset = await FilesetResolver.forVisionTasks(f.wasm);
    const modelBuffer = f.loadModel ? await f.loadModel() : null;
    const opts = (delegate) => ({
      baseOptions: modelBuffer ? { modelAssetBuffer: modelBuffer, delegate } : { modelAssetPath: f.model, delegate },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch { this.delegate = 'CPU'; this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU')); }
  }

  // Called every animation frame. Sends each new camera frame to the worker (one at a time)
  // and returns the newest finished result once, or null if nothing new arrived.
  detect(now) {
    if (!this.ready || this.video.readyState < 2) return null;
    const t = this.video.currentTime;
    if (!this.worker) {                                  // fallback: synchronous, as before
      if (t === this.lastTime) return null;
      this.lastTime = t;
      return this.landmarker.detectForVideo(this.video, now);
    }
    if (!this.busy && t !== this.lastTime) {
      this.lastTime = t;
      this.busy = true;
      createImageBitmap(this.video)
        .then((bitmap) => this.worker.postMessage({ type: 'frame', bitmap, ts: now }, [bitmap]))
        .catch(() => { this.busy = false; });
    }
    const res = this.pending;
    this.pending = null;
    return res;
  }
}
