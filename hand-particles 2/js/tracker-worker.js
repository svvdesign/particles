// Hand tracking off the main thread. MediaPipe inference takes 10–30 ms per camera frame
// on integrated GPUs; running it here means rendering never waits for it.
// (Classic worker: MediaPipe loads its WASM runtime with importScripts, which module workers lack.)
let landmarker = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      // The CDN serves the CommonJS build as "application/node", which importScripts() rejects,
      // so fetch it as text and run it; its exports land on self.exports.
      self.exports = {};
      const src = await (await fetch(m.bundle)).text();
      (0, eval)(src);
      const { FilesetResolver, HandLandmarker } = self.exports;
      const fileset = await FilesetResolver.forVisionTasks(m.wasm);
      const opts = (delegate) => ({
        baseOptions: m.modelBuffer ? { modelAssetBuffer: m.modelBuffer, delegate } : { modelAssetPath: m.model, delegate },
        runningMode: 'VIDEO',
        numHands: m.numHands || 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      const order = m.delegate === 'CPU' ? ['CPU', 'GPU'] : ['GPU', 'CPU'];
      let delegate = order[0];
      try { landmarker = await HandLandmarker.createFromOptions(fileset, opts(order[0])); }
      catch { delegate = order[1]; landmarker = await HandLandmarker.createFromOptions(fileset, opts(order[1])); }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }
  if (m.type === 'frame') {
    let res = null;
    const t0 = performance.now();
    try { res = landmarker.detectForVideo(m.bitmap, m.ts); } catch (err) { console.warn(err); }
    m.bitmap.close();
    self.postMessage({ type: 'result', ts: m.ts, landmarks: res ? res.landmarks : [], handedness: res ? res.handedness : [], ms: performance.now() - t0 });
  }
};
