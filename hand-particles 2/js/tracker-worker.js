// Hand tracking off the main thread. MediaPipe inference takes 10–30 ms per camera frame
// on integrated GPUs; running it here means rendering never waits for it.
// (Classic worker: MediaPipe loads its WASM runtime with importScripts, which module workers lack.)
let landmarker = null;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'init') {
    try {
      self.exports = {};                                 // the CommonJS build writes its exports here
      importScripts(m.bundle);
      const { FilesetResolver, HandLandmarker } = self.exports;
      const fileset = await FilesetResolver.forVisionTasks(m.wasm);
      const opts = (delegate) => ({
        baseOptions: m.modelBuffer ? { modelAssetBuffer: m.modelBuffer, delegate } : { modelAssetPath: m.model, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      let delegate = 'GPU';
      try { landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { delegate = 'CPU'; landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU')); }
      self.postMessage({ type: 'ready', delegate });
    } catch (err) {
      self.postMessage({ type: 'error', message: String(err && err.message || err) });
    }
    return;
  }
  if (m.type === 'frame') {
    let res = null;
    try { res = landmarker.detectForVideo(m.bitmap, m.ts); } catch (err) { console.warn(err); }
    m.bitmap.close();
    self.postMessage({ type: 'result', landmarks: res ? res.landmarks : [], handedness: res ? res.handedness : [] });
  }
};
