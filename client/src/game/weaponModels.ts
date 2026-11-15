// =====================================================================
// Quaternius FBX 총기 모델 로더 — 1회 비동기 로드 → 캐시 → clone 재사용.
// 로딩 전/실패 시에는 호출측의 프로시저럴(박스) 모델이 그대로 폴백으로 남는다.
// FBX 규약(실측): 총열 방향 = +X, 위 = +Y, 원점 ≈ 그립. 게임 규약: 전방 = -Z → Y축 +90° 회전.
// =====================================================================
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WeaponId } from '../config/weapons';

/** 무기 → FBX 파일, 정규화 전체 길이(m, 개머리판~총구) */
/** file 에 확장자(.glb/.gltf)가 있으면 GLTFLoader, 없으면 FBXLoader(.fbx).
 *  grip = 뒤쪽 끝에서 손잡이 위치(0~1, 모델 길이 비율) → 그 지점이 뷰모델 원점, roll = 길이축 회전(rad, 평평한 면을 카메라 쪽으로) */
export const WEAPON_MODELS: Partial<Record<WeaponId, { file: string; length: number; grip?: number; roll?: number }>> = {
  dagger: { file: 'karambit.glb', length: 0.27, grip: 0.3, roll: -0.9 },
  classic: { file: 'Pistol_1', length: 0.3 },
  shorty: { file: 'Shotgun_SawedOff', length: 0.42 },
  frenzy: { file: 'SubmachineGun_4', length: 0.34 },
  ghost: { file: 'Pistol_5', length: 0.32 },
  sheriff: { file: 'Revolver_1', length: 0.32 },
  vandal: { file: 'AssaultRifle_2', length: 0.88 },
  phantom: { file: 'AssaultRifle2_1', length: 0.88 },
  marshal: { file: 'SniperRifle_4', length: 1.05 },
};

type Role = 'base' | 'accent' | 'dark' | 'glass';
interface Source { glb: boolean; root: THREE.Object3D; roles: Map<string, Role>; scale: number; offset: THREE.Vector3; muzzle: THREE.Vector3 }
export interface SkinSet { base: THREE.Material; accent: THREE.Material; skinned: boolean }

const fbxLoader = new FBXLoader(), gltfLoader = new GLTFLoader();
const isGlb = (f: string): boolean => /\.(glb|gltf)$/i.test(f);
const pending = new Map<string, Promise<Source | null>>();
const ready = new Map<string, Source>();
const BASE = (import.meta.env?.BASE_URL ?? '/') + 'models/';
const darkMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.7 });
const glassMat = new THREE.MeshStandardMaterial({ color: 0x88c8ff, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.4 });

const matsOf = (m: THREE.Mesh): THREE.Material[] => (Array.isArray(m.material) ? m.material : [m.material]);

function prepare(root: THREE.Object3D, length: number, glb: boolean, grip?: number): Source {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3()), ctr = box.getCenter(new THREE.Vector3());
  const meshes: THREE.Mesh[] = []; root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  // 재질 역할: 삼각형 수 상위 = 스킨 본체, 나머지 = 포인트, Black/Grey = 고정 다크, Glass = 렌즈
  const count = new Map<string, number>();
  for (const mesh of meshes) {
    const g = mesh.geometry, mats = matsOf(mesh), total = g.index ? g.index.count : g.attributes.position.count;
    const groups = g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
    for (const gr of groups) { const m = mats[gr.materialIndex ?? 0]; if (m) count.set(m.name, (count.get(m.name) ?? 0) + gr.count / 3); }
    // 평면 투영 UV — 팔레트 UV 대신 패턴이 균일하게 입혀지도록 (모델 공간 x/y)
    const pos = g.attributes.position, uv = new Float32Array(pos.count * 2), v = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld); uv[i * 2] = (v.x - box.min.x) / size.x; uv[i * 2 + 1] = (v.y - box.min.y) / size.x; }
    if (glb) mesh.userData.planarUv = uv; // GLB: 내장 UV(PBR 텍스처) 유지, 스킨 적용 시에만 평면 UV 사용
    else g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  }
  const names = [...count.keys()], free = names.filter((n) => !/^(Black2?|Grey|Glass)$|Grip|Polymer/i.test(n));
  const top = Math.max(1, ...free.map((n) => count.get(n) ?? 0)), roles = new Map<string, Role>();
  for (const n of names) roles.set(n, /Glass/i.test(n) ? 'glass' : /^(Black2?|Grey)$|Grip|Polymer/i.test(n) ? 'dark' : (count.get(n) ?? 0) >= top * 0.45 ? 'base' : 'accent');
  // 총구: 최대 X 부근 정점 평균 (모델 공간)
  const mz = new THREE.Vector3(), tmp = new THREE.Vector3(); let n = 0;
  for (const mesh of meshes) {
    const p = mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) { tmp.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld); if (tmp.x > box.max.x - size.x * 0.03) { mz.add(tmp); n++; } }
  }
  mz.divideScalar(Math.max(1, n)); mz.x = box.max.x;
  const ox = grip === undefined ? 0 : -(box.min.x + size.x * grip);
  return { glb, root, roles, scale: length / size.x, offset: new THREE.Vector3(ox, -ctr.y, -ctr.z), muzzle: mz };
}

function load(id: WeaponId): Promise<Source | null> {
  const def = WEAPON_MODELS[id]; if (!def) return Promise.resolve(null);
  let p = pending.get(def.file);
  if (!p) {
    const glb = isGlb(def.file);
    const raw: Promise<THREE.Object3D> = glb ? gltfLoader.loadAsync(BASE + def.file).then((g) => g.scene) : fbxLoader.loadAsync(`${BASE}${def.file}.fbx`);
    p = raw.then((root) => { const s = prepare(root, def.length, glb, def.grip); ready.set(def.file, s); return s; })
      .catch((e) => { console.warn('[weaponModels] 모델 로드 실패 → 박스 모델 폴백:', def.file, e); return null; });
    pending.set(def.file, p);
  }
  return p;
}
/** 시작 시 한 번 호출 — 사용하는 모델을 미리 받아 둔다 */
export function preloadWeaponModels(): void { for (const id of Object.keys(WEAPON_MODELS) as WeaponId[]) void load(id); }

const nativeCache = new Map<string, THREE.MeshStandardMaterial>();
const native = (m: THREE.Material): THREE.MeshStandardMaterial => {
  const col = (m as THREE.MeshPhongMaterial).color, k = m.name + '|' + (col?.getHexString() ?? ''); let r = nativeCache.get(k);
  if (!r) { const metal = /Metal/i.test(m.name); r = new THREE.MeshStandardMaterial({ color: col ?? 0x888888, metalness: metal ? 0.85 : 0.25, roughness: metal ? 0.38 : 0.6 }); nativeCache.set(k, r); }
  return r;
};

/** GLB 내장 PBR 재질: 인스턴스별 복제 + 렌더 직전 장면 환경맵을 직접 물려 금속 반사를 강하게(씬 IBL 이 약해도 어둡지 않게) */
function glbNative(mesh: THREE.Mesh, m: THREE.Material): THREE.Material {
  const c = m.clone() as THREE.MeshStandardMaterial;
  if (c.metalness > 0.5) { c.metalness = 1; c.roughness = Math.max(0.16, c.roughness * 0.8); }
  c.envMapIntensity = 1;
  let last: THREE.Texture | null = null, lastI = -1;
  const prev = mesh.onBeforeRender;
  mesh.onBeforeRender = function (this: THREE.Mesh, ...a: Parameters<typeof prev>) {
    const scene = a[1] as THREE.Scene, env = scene.environment;
    if (env !== last) { last = env; c.envMap = env; c.needsUpdate = true; }
    const k = c.metalness > 0.5 ? 2.6 : 1.2, i = (scene.environmentIntensity ?? 1) * k + 0.25;
    if (i !== lastI) { lastI = i; c.envMapIntensity = i; }
    prev.apply(this, a);
  };
  return c;
}

function build(src: Source, skin: SkinSet, roll = 0): THREE.Group {
  const wrap = new THREE.Group(); wrap.rotation.y = Math.PI / 2; wrap.scale.setScalar(src.scale); // +X(총열) → -Z(전방)
  const inner = src.root.clone(true); inner.position.copy(src.offset); inner.rotation.x = roll; wrap.add(inner);
  let curMesh: THREE.Mesh | null = null;
  const pick = (m: THREE.Material): THREE.Material => {
    const role = src.roles.get(m.name) ?? 'base';
    if (role === 'glass') return glassMat; if (role === 'dark') return darkMat;
    if (!skin.skinned) return src.glb && curMesh ? glbNative(curMesh, m) : native(m);
    return role === 'base' ? skin.base : skin.accent; // 스킨 재질(프로시저럴 텍스처/PBR/발광) 연결
  };
  inner.traverse((o) => {
    const me = o as THREE.Mesh; if (!me.isMesh) return;
    curMesh = me;
    if (src.glb && skin.skinned && me.userData.planarUv) { me.geometry = me.geometry.clone(); me.geometry.setAttribute('uv', new THREE.BufferAttribute(me.userData.planarUv as Float32Array, 2)); }
    me.material = Array.isArray(me.material) ? me.material.map(pick) : pick(me.material);
  });
  return wrap;
}

/** 프로시저럴 폴백 group 에 FBX 모델을 비동기 교체 장착. 실패/미매핑이면 폴백 유지. */
export function attachFbxModel(g: THREE.Group, weaponId: WeaponId, skin: SkinSet, viewmodel: boolean): void {
  const def = WEAPON_MODELS[weaponId]; if (!def) return;
  const apply = (src: Source): void => {
    const model = build(src, skin, def.roll ?? 0);
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = !viewmodel; if (viewmodel) { o.frustumCulled = false; o.renderOrder = 10; } } });
    const mz = g.userData.muzzle as THREE.Object3D;
    for (const c of [...g.children]) if (c !== mz && !c.userData.keep) c.removeFromParent(); // 등급 파츠(userData.keep)는 유지
    g.add(model);
    mz.position.copy(src.muzzle).add(src.offset).multiplyScalar(src.scale).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    g.userData.fbx = true; (g.userData.onModel as (() => void) | undefined)?.(); // 총구 위치 확정 → 등급 파츠 재배치
  };
  const hit = ready.get(def.file); if (hit) { apply(hit); return; }
  void load(weaponId).then((s) => { if (s) apply(s); });
}
