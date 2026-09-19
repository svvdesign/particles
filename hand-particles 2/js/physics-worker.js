// Runs the particle physics off the main thread. The main thread sends commands and
// a 'step' per frame (with spare output buffers); we fill them and hand them back.
import { Physics } from './physics.js';

const phys = new Physics();

self.onmessage = (e) => {
  const m = e.data;
  phys.handle(m);
  if (m.type !== 'step') return;
  const { pos, speed, hue } = m.out;
  if (pos.length !== phys.pos.length) {                  // count changed while this step was in flight
    self.postMessage({ type: 'frame', out: m.out, stale: true }, [pos.buffer, speed.buffer, hue.buffer]);
    return;
  }
  pos.set(phys.pos); speed.set(phys.speed); hue.set(phys.hue);
  self.postMessage({ type: 'frame', out: m.out }, [pos.buffer, speed.buffer, hue.buffer]);
};
