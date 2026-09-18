// Camera + MediaPipe HandLandmarker. The video never touches the screen —
// it only feeds the tracker.

const VISION = '@mediapipe/tasks-vision';
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export class HandTracker {
  constructor(video) { this.video = video; this.ready = false; this.lastTime = -1; this.delegate = 'GPU'; }

  async init(onStatus = () => {}) {
    onStatus('Requesting camera…');
    const camera = navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 60 } },
      audio: false,
    });

    onStatus('Loading hand-tracking model…');
    const { FilesetResolver, HandLandmarker } = await import(VISION);
    const fileset = await FilesetResolver.forVisionTasks(WASM);
    const opts = (delegate) => ({
      baseOptions: { modelAssetPath: MODEL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
    try {
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU'));
    } catch (e) {
      console.warn('GPU delegate failed, falling back to CPU', e);
      this.delegate = 'CPU';
      this.landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU'));
    }

    this.video.srcObject = await camera;
    await this.video.play();
    this.ready = true;
    onStatus('Ready');
  }

  // Returns a result only when the camera delivered a new frame.
  detect(now) {
    if (!this.ready || this.video.readyState < 2) return null;
    const t = this.video.currentTime;
    if (t === this.lastTime) return null;
    this.lastTime = t;
    return this.landmarker.detectForVideo(this.video, now);
  }
}
