// Node 환경에서 three 로더로 맵 모델(FBX/GLB)을 파싱 — 텍스처는 무시(지오메트리만 필요)
import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// 브라우저 전용 API 최소 스텁 (텍스처 디코딩은 건너뜀)
globalThis.self ??= globalThis;
globalThis.window ??= globalThis;
globalThis.document ??= { createElementNS: () => ({ style: {}, addEventListener() {}, removeEventListener() {} }) };
globalThis.createImageBitmap = undefined;
THREE.TextureLoader.prototype.load = () => new THREE.Texture();
THREE.ImageBitmapLoader.prototype.load = (_u, onLoad) => { onLoad?.(null); };
THREE.ImageLoader.prototype.load = () => ({});

const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

export async function loadModel(path) {
  const buf = readFileSync(path);
  if (path.endsWith('.fbx')) return new FBXLoader().parse(toAB(buf), '');
  const gltf = await new GLTFLoader().parseAsync(toAB(buf), '');
  return gltf.scene;
}
export { THREE };
