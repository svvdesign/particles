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
export class Post {
  constructor(renderer, scene, camera, { strength, radius, threshold, damp }) {
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    // No depth buffers anywhere: every dot is additive with depthWrite off, so depth never
    // hides anything — it was only being cleared and tested for nothing.
    const half = { type: THREE.HalfFloatType, depthBuffer: false };
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
      uniforms: { tScene: { value: null }, tBloom: { value: null }, useBloom: { value: 1 } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene, tBloom;
        uniform float useBloom;
        varying vec2 vUv;   // sRGBTransferOETF comes from three's built-in ShaderMaterial prefix
        void main() {
          vec4 c = texture2D(tScene, vUv);
          if (useBloom > 0.5) { vec4 b = texture2D(tBloom, vUv); c.rgb += b.rgb * b.a; c.a += b.a * b.a; }
          gl_FragColor = sRGBTransferOETF(c);
        }`,
    });
    this.outQuad = new FullScreenQuad(this.outMat);
    this.clearColor = new THREE.Color();
  }

  setDamp(v) { this.trailMat.uniforms.damp.value = v; this.trails = v > 0; }

  clearTrails() {
    const r = this.renderer;
    for (const t of [this.trailOld, this.trailNew]) { r.setRenderTarget(t); r.clear(true, false, false); }
  }

  setSize(w, h) {                                        // drawing-buffer pixels
    this.sceneRT.setSize(w, h);
    this.trailOld.setSize(w, h);
    this.trailNew.setSize(w, h);
    this.bloom.setSize(w, h);
  }

  // UnrealBloomPass.render without its final blend (we do that in the output shader).
  runBloom(input) {
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
      this.trailMat.uniforms.tOld.value = this.trailOld.texture;
      this.trailMat.uniforms.tNew.value = image;
      r.setRenderTarget(this.trailNew);
      this.trailQuad.render(r);
      [this.trailOld, this.trailNew] = [this.trailNew, this.trailOld];
      image = this.trailOld.texture;
    }

    const useBloom = this.bloom.strength > 0;
    if (useBloom) {
      r.getClearColor(this.clearColor); const oldAlpha = r.getClearAlpha();
      r.setClearColor(this.bloom.clearColor, 0);
      this.outMat.uniforms.tBloom.value = this.runBloom(image);
      r.setClearColor(this.clearColor, oldAlpha);
    }
    this.outMat.uniforms.tScene.value = image;
    this.outMat.uniforms.useBloom.value = useBloom ? 1 : 0;
    r.setRenderTarget(null);
    this.outQuad.render(r);
  }
}
