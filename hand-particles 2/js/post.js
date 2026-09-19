import * as THREE from 'three';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { AfterimageShader } from 'three/addons/shaders/AfterimageShader.js';

// Draws the same image as EffectComposer(RenderPass → AfterimagePass → UnrealBloomPass → OutputPass)
// using the very same shaders, but with three fewer full-screen passes per frame:
//   · trails are written once and read directly (AfterimagePass copies them to another buffer),
//   · the bloom is added inside the final sRGB output (UnrealBloomPass blends it in its own pass,
//     then OutputPass copies everything once more).
// Full-screen passes are what costs the most on integrated GPUs at Retina/4K resolutions.
//
// It also draws the frosted glass behind the HUD panels. CSS backdrop-filter re-blurs the canvas
// under every panel on every frame (measured: 27 fps with it, 60 fps without on an Iris Plus 655),
// while here the blurred image already exists — it's the bloom's blur chain — so the glass is
// just a few texture reads inside the rounded rectangles the page reports each frame.
export const MAX_GLASS = 20;

export class Post {
  constructor(renderer, scene, camera, { strength, radius, threshold, damp }) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    // No depth buffers anywhere: every dot is additive with depthWrite off, so depth never
    // hides anything — it was only being cleared and tested for nothing.
    const half = { type: THREE.HalfFloatType, depthBuffer: false };
    this.rtOptions = half;
    this.sceneRT = new THREE.WebGLRenderTarget(1, 1, half);
    // Linear filtering: the bloom samples the trail image at half size, and in the old chain it
    // read a linearly-filtered copy. (The trail shader itself reads texel centres, so it's unaffected.)
    this.trailOld = new THREE.WebGLRenderTarget(1, 1, half);
    this.trailNew = new THREE.WebGLRenderTarget(1, 1, half);
    this.trailMat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(AfterimageShader.uniforms),
      vertexShader: AfterimageShader.vertexShader,
      fragmentShader: AfterimageShader.fragmentShader,
    });
    this.trailQuad = new FullScreenQuad(this.trailMat);
    this.setDamp(damp);

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), strength, radius, threshold);
    const b = this.bloom;                                // its targets aren't allocated yet, so this is free
    for (const t of [b.renderTargetBright, ...b.renderTargetsHorizontal, ...b.renderTargetsVertical]) t.depthBuffer = false;

    // OutputPass + the additive bloom blend, fused. Additive blending in three.js is
    // dst + src·srcAlpha, so the bloom is added as rgb·a — exactly what the blend pass did.
    this.outMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: null }, tBloom: { value: null }, useBloom: { value: 1 },
        tBlurA: { value: null }, tBlurB: { value: null }, uBlurMix: { value: 0 },
        uRects: { value: Array.from({ length: MAX_GLASS }, () => new THREE.Vector4()) },
        uRadii: { value: new Float32Array(MAX_GLASS) }, uAlpha: { value: new Float32Array(MAX_GLASS) }, uCount: { value: 0 },
      },
      defines: { MAX_GLASS },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene, tBloom, tBlurA, tBlurB;
        uniform float useBloom, uBlurMix;
        uniform vec4 uRects[MAX_GLASS];                  // x0, y0, x1, y1 in drawing-buffer pixels (y up)
        uniform float uRadii[MAX_GLASS];
        uniform float uAlpha[MAX_GLASS];                 // follows the panel's own fade
        uniform int uCount;
        varying vec2 vUv;   // sRGBTransferOETF comes from three's built-in ShaderMaterial prefix

        // How much of this pixel lies inside a glass panel (rounded rect, 1px anti-aliased edge).
        float glass(vec2 p) {
          float cover = 0.0;
          for (int i = 0; i < MAX_GLASS; i++) {
            if (i >= uCount) break;
            vec4 r = uRects[i];
            if (p.x < r.x || p.y < r.y || p.x > r.z || p.y > r.w) continue;
            vec2 hs = (r.zw - r.xy) * 0.5;
            vec2 q = abs(p - (r.xy + hs)) - (hs - uRadii[i]);
            float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadii[i];
            cover = max(cover, clamp(0.5 - d, 0.0, 1.0) * uAlpha[i]);
          }
          return cover;
        }

        void main() {
          vec4 c = texture2D(tScene, vUv);
          vec3 b = vec3(0.0);
          if (useBloom > 0.5) { vec4 bl = texture2D(tBloom, vUv); b = bl.rgb * bl.a; c.a += bl.a * bl.a; }
          c.rgb += b;
          if (uCount > 0) {
            float g = glass(gl_FragCoord.xy);
            if (g > 0.0) {
              vec3 frosted = mix(texture2D(tBlurA, vUv).rgb, texture2D(tBlurB, vUv).rgb, uBlurMix) + b;
              c.rgb = mix(c.rgb, frosted, g);
            }
          }
          gl_FragColor = sRGBTransferOETF(c);
        }`,
    });
    this.outQuad = new FullScreenQuad(this.outMat);
    this.clearColor = new THREE.Color();
  }

  setDamp(v) {
    const on = v > 0;
    if (on && this.trails === false) this.trailsStale = true;   // history froze while off: start clean
    this.trailMat.uniforms.damp.value = v;
    this.trails = on;
  }

  clearTrails() {
    const r = this.renderer;
    for (const t of [this.trailOld, this.trailNew]) { r.setRenderTarget(t); r.clear(true, false, false); }
    this.pendingOld?.dispose(); this.pendingOld = null;
  }

  setSize(w, h) {                                        // drawing-buffer pixels
    this.sceneRT.setSize(w, h);
    if (this.trailOld.width !== w || this.trailOld.height !== h) {
      // Keep the trail history across a size change (quality step, 4K snapshot): the old image is
      // read once, stretched to the new size, instead of the trails vanishing.
      this.pendingOld?.dispose();
      this.pendingOld = this.trailOld;
      this.trailOld = new THREE.WebGLRenderTarget(w, h, this.rtOptions);
      this.trailNew.setSize(w, h);
    }
    this.bloom.setSize(w, h);
  }

  // Frosted-glass panels for this frame: [{x0, y0, x1, y1, r}] in drawing-buffer pixels (y up),
  // and the blur strength as a Gaussian sigma in drawing-buffer pixels (CSS blur(14px) × pixel ratio).
  setGlass(rects, sigma) {
    const u = this.outMat.uniforms, n = Math.min(rects.length, MAX_GLASS);
    for (let i = 0; i < n; i++) {
      const g = rects[i];
      u.uRects.value[i].set(g.x0, g.y0, g.x1, g.y1);
      u.uRadii.value[i] = g.r;
      u.uAlpha.value[i] = g.a ?? 1;
    }
    u.uCount.value = n;
    this.glassSigma = sigma;
  }

  // The bloom's blur chain: mip j is blurred at 1/2^(j+1) size by a Gaussian (sigma = K) cut off at
  // |x| ≤ K−1 texels, which behaves like a much narrower blur. Its real variance, plus the 2:1 bilinear
  // downsamples between mips, gives each mip's total blur in full-size pixels (≈ 2.8, 10, 30, 80, 199).
  // Pick the two mips around the wanted sigma and cross-fade between them.
  pickBlur(sigma) {
    const b = this.bloom;
    if (!this.mipSigma) {
      let acc = 0.25;                                    // the half-size high-pass sample
      this.mipSigma = [3, 5, 7, 9, 11].slice(0, b.nMips).map((K, j) => {
        let sw = 0, sv = 0;
        for (let i = -(K - 1); i <= K - 1; i++) { const w = Math.exp((-0.5 * i * i) / (K * K)); sw += w; sv += w * i * i; }
        if (j > 0) acc += 0.25 * 4 ** j;
        acc += (sv / sw) * 4 ** (j + 1);
        return Math.sqrt(acc);
      });
    }
    const m = this.mipSigma;
    let i = 0;
    while (i < m.length - 2 && sigma > m[i + 1]) i++;
    const u = this.outMat.uniforms;
    u.tBlurA.value = b.renderTargetsVertical[i].texture;
    u.tBlurB.value = b.renderTargetsVertical[i + 1].texture;
    u.uBlurMix.value = Math.min(1, Math.max(0, (sigma - m[i]) / (m[i + 1] - m[i])));
  }

  // UnrealBloomPass.render without its final blend (we do that in the output shader).
  // `composite` = also build the bloom image (skipped when only the glass needs the blur chain).
  runBloom(input, composite = true) {
    const b = this.bloom, r = this.renderer;
    b.highPassUniforms.tDiffuse.value = input;
    b.highPassUniforms.luminosityThreshold.value = b.threshold;
    b.fsQuad.material = b.materialHighPassFilter;
    r.setRenderTarget(b.renderTargetBright); r.clear(true, false, false); b.fsQuad.render(r);
    let src = b.renderTargetBright;
    for (let i = 0; i < b.nMips; i++) {
      const m = b.separableBlurMaterials[i];
      b.fsQuad.material = m;
      m.uniforms.colorTexture.value = src.texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionX;
      r.setRenderTarget(b.renderTargetsHorizontal[i]); r.clear(true, false, false); b.fsQuad.render(r);
      m.uniforms.colorTexture.value = b.renderTargetsHorizontal[i].texture;
      m.uniforms.direction.value = UnrealBloomPass.BlurDirectionY;
      r.setRenderTarget(b.renderTargetsVertical[i]); r.clear(true, false, false); b.fsQuad.render(r);
      src = b.renderTargetsVertical[i];
    }
    if (!composite) return null;
    const c = b.compositeMaterial;
    b.fsQuad.material = c;
    c.uniforms.bloomStrength.value = b.strength;
    c.uniforms.bloomRadius.value = b.radius;
    c.uniforms.bloomTintColors.value = b.bloomTintColors;
    r.setRenderTarget(b.renderTargetsHorizontal[0]); r.clear(true, false, false); b.fsQuad.render(r);
    return b.renderTargetsHorizontal[0].texture;
  }

  // The renderer runs with autoClear off: full-screen passes overwrite every pixel,
  // so clearing before them (three's default) is wasted bandwidth. Only the scene is cleared.
  render() {
    const r = this.renderer;
    r.setRenderTarget(this.sceneRT);
    r.clear(true, false, false);
    r.render(this.scene, this.camera);
    let image = this.sceneRT.texture;

    if (this.trails) {                                   // max(new, old·damp), kept for next frame
      if (this.trailsStale) { this.clearTrails(); this.trailsStale = false; }
      this.trailMat.uniforms.tOld.value = (this.pendingOld ?? this.trailOld).texture;
      this.trailMat.uniforms.tNew.value = image;
      r.setRenderTarget(this.trailNew);
      this.trailQuad.render(r);
      [this.trailOld, this.trailNew] = [this.trailNew, this.trailOld];
      this.pendingOld?.dispose(); this.pendingOld = null;
      image = this.trailOld.texture;
    }

    const useBloom = this.bloom.strength > 0, useGlass = this.outMat.uniforms.uCount.value > 0;
    if (useBloom || useGlass) {
      r.getClearColor(this.clearColor); const oldAlpha = r.getClearAlpha();
      r.setClearColor(this.bloom.clearColor, 0);
      const bloomTex = this.runBloom(image, useBloom);
      if (useBloom) this.outMat.uniforms.tBloom.value = bloomTex;
      if (useGlass) this.pickBlur(this.glassSigma);
      r.setClearColor(this.clearColor, oldAlpha);
    }
    this.outMat.uniforms.tScene.value = image;
    this.outMat.uniforms.useBloom.value = useBloom ? 1 : 0;
    r.setRenderTarget(null);
    this.outQuad.render(r);
  }
}
