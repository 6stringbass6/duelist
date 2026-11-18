// =====================================================================
// Quaternius FBX 총기 모델 로더 — 1회 비동기 로드 → 캐시 → clone 재사용.
// 로딩 전/실패 시에는 호출측의 프로시저럴(박스) 모델이 그대로 폴백으로 남는다.
// FBX 규약(실측): 총열 방향 = +X, 위 = +Y, 원점 ≈ 그립. 게임 규약: 전방 = -Z → Y축 +90° 회전.
// =====================================================================
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WeaponId } from '../config/weapons';
import { getSkin } from '../config/skins';

/** 무기 → FBX 파일, 정규화 전체 길이(m, 개머리판~총구) */
/** file 에 확장자(.glb/.gltf)가 있으면 GLTFLoader, 없으면 FBXLoader(.fbx).
 *  grip = 뒤쪽 끝에서 손잡이 위치(0~1, 모델 길이 비율) → 그 지점이 뷰모델 원점, roll = 길이축 회전(rad, 평평한 면을 카메라 쪽으로) */
export const WEAPON_MODELS: Partial<Record<WeaponId, ModelDef>> = {
  // M9 Bayonet(FBX, 단위 ≈ mm, 날끝 +X, 손잡이 -X, 내장 UV/베이크 텍스처) — 기본 스킨은 원본 텍스처 유지, 구매 스킨은 평면 UV 로 재질 교체
  dagger: { file: 'm9_bayonet', length: 0.3, grip: 0.15, own: true },
  // 카타나(FBX, 단위 ≈ cm, 날끝 -X · 칼날 평면 = XZ · 날(볼록면) +Z, 칼집 포함) → 칼집 제거, 날끝 +X · 날이 아래(-Y)로 향하도록 회전.
  // 파일 내 재질이 1개(Material.001, 외부 PNG 미포함)라 메시 이름으로 부위별 재질/스킨 역할을 지정한다.
  sword: {
    file: 'katana', length: 1.0, grip: 0.18, own: true, rot: [-Math.PI / 2, Math.PI, 0], hide: /^Plane00[37]$/,
    parts: {
      Plane: { role: 'base', color: 0xd9dee5, metalness: 1, roughness: 0.16 },     // 칼날
      Circle004: { role: 'accent', color: 0x3a3128, metalness: 0.85, roughness: 0.38 }, // 츠바(코등이)
      Cube001: { role: 'accent', color: 0x16171b, metalness: 0.05, roughness: 0.8 }, // 손잡이 감개(츠카이토)
      Cube003: { role: 'dark', color: 0x8a7a5a, metalness: 0.75, roughness: 0.35 },  // 손잡이 심·카시라
    },
  },
  classic: { file: 'Pistol_1', length: 0.3 },
  shorty: { file: 'Shotgun_SawedOff', length: 0.42 },
  frenzy: { file: 'SubmachineGun_4', length: 0.34 },
  ghost: { file: 'Pistol_5', length: 0.32 },
  sheriff: { file: 'deagle.glb', length: 0.34, grip: 0.3, rot: [0, Math.PI / 2, 0] }, // 디글 (GLB, 내장 PBR · 총구 +Z → +X)
  vandal: { file: 'ak47.fbx', length: 0.88, grip: 0.3, rot: [0, Math.PI / 2, 0] }, // AK-47 (FBX, 단위 cm · 총구 +Z → +X, 텍스처 없음 → FILE_PARTS 재질)
  phantom: { file: 'AssaultRifle2_1', length: 0.88 },
  marshal: { file: 'SniperRifle_4', length: 1.05 },
};

/** 텍스처가 없는 FBX 의 파일별 기본 재질/스킨 역할 (메시 이름 기준) — 스킨 전용 모델(GlbSpec)은 parts 를 가질 수 없어 여기서 지정 */
const FILE_PARTS: Record<string, Record<string, PartDef>> = {
  'ak47.fbx': {
    m_gun: { role: 'base', color: 0x55585d, metalness: 0.85, roughness: 0.38 },
    m_mag: { role: 'accent', color: 0x2c2d30, metalness: 0.6, roughness: 0.5 },
    m_trigger: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 }, m_fireselect: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 },
    m_maglid: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 }, m_magrel: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 },
    m_shelleject: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 },
  },
  'karambit.fbx': { Knife: { role: 'base', color: 0xc9ced6, metalness: 1, roughness: 0.2 } },
};

/** own = FBX 라도 내장 UV/텍스처를 유지(GLB 와 동일 취급). 스킨 적용 시에만 평면 UV 사용
 *  rot = 정규화 전에 모델에 굽는 회전(Euler XYZ) → 길이축을 +X 로 맞춤, hide = 제거할 메시 이름(예: 칼집),
 *  parts = 메시 이름별 기본 재질 + 스킨 역할(재질이 하나뿐인 모델용, 부모 메시 이름이 아닌 메시 자신의 이름 기준) */
type ModelDef = { file: string; length: number; grip?: number; roll?: number; own?: boolean; rot?: [number, number, number]; hide?: RegExp; parts?: Record<string, PartDef> };
type Role = 'base' | 'accent' | 'dark' | 'glass';
interface PartDef { role: Role; color: number; metalness: number; roughness: number }
interface Source { glb: boolean; root: THREE.Object3D; roles: Map<string, Role>; scale: number; offset: THREE.Vector3; muzzle: THREE.Vector3; parts?: Record<string, PartDef>; axis: { y: Float32Array; x0: number; len: number } }
export interface SkinSet { base: THREE.Material; accent: THREE.Material; skinned: boolean }

// FBX 가 참조하지만 포함하지 않은 외부 텍스처(예: 카타나의 Blender 베이크 PNG)는 404 대신 1px 투명 이미지로 대체 — parts 재질을 쓰므로 실제로는 사용되지 않는다
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const fbxManager = new THREE.LoadingManager(); fbxManager.setURLModifier((u) => (/katana_Material/i.test(u) ? BLANK_PNG : u));
const fbxLoader = new FBXLoader(fbxManager), gltfLoader = new GLTFLoader();
const isGlb = (f: string): boolean => /\.(glb|gltf)$/i.test(f);
const pending = new Map<string, Promise<Source | null>>();
const ready = new Map<string, Source>();
const BASE = (import.meta.env?.BASE_URL ?? '/') + 'models/';
const darkMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.7 });
const glassMat = new THREE.MeshStandardMaterial({ color: 0x88c8ff, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.4 });

/** GLB/own 모델의 평면 UV — userData 는 clone() 시 JSON 직렬화되어 Float32Array 가 깨지므로(→ 렌더 예외) 지오메트리 키로 따로 보관 */
const planarUvs = new WeakMap<THREE.BufferGeometry, Float32Array>();
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
    if (glb) planarUvs.set(g, uv); // GLB: 내장 UV(PBR 텍스처) 유지, 스킨 적용 시에만 평면 UV 사용
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
  // 길이축(X)을 따라 구간별 평균 높이(Y) — 휘어진 칼날(카타나)에 등급 파츠를 칼날 중심선에 맞춰 붙일 때 사용
  const AX = 24, ay = new Float32Array(AX), an = new Float32Array(AX);
  for (const mesh of meshes) {
    const p = mesh.geometry.attributes.position;
    for (let i = 0; i < p.count; i++) { tmp.fromBufferAttribute(p, i).applyMatrix4(mesh.matrixWorld); const b = Math.min(AX - 1, Math.max(0, Math.floor(((tmp.x - box.min.x) / size.x) * AX))); ay[b] += tmp.y; an[b]++; }
  }
  for (let i = 0; i < AX; i++) ay[i] = an[i] ? ay[i] / an[i] : i ? ay[i - 1] : ctr.y;
  const ox = grip === undefined ? 0 : -(box.min.x + size.x * grip);
  return { glb, root, roles, scale: length / size.x, offset: new THREE.Vector3(ox, -ctr.y, -ctr.z), muzzle: mz, axis: { y: ay, x0: box.min.x, len: size.x } };
}

/** 스킨 전용 모델(GLB)이 있으면 그것, 없으면 무기 기본 모델 */
const modelFor = (id: WeaponId, skinId?: string | null): ModelDef | undefined => getSkin(skinId)?.glb ?? WEAPON_MODELS[id];

function load(def: ModelDef | undefined): Promise<Source | null> {
  if (!def) return Promise.resolve(null);
  let p = pending.get(def.file);
  if (!p) {
    const glb = isGlb(def.file);
    const raw: Promise<THREE.Object3D> = glb ? gltfLoader.loadAsync(BASE + def.file).then((g) => g.scene) : fbxLoader.loadAsync(BASE + (/.fbx$/i.test(def.file) ? def.file : def.file + ".fbx"));
    p = raw.then((loaded) => {
      let root = loaded;
      if (def.hide) { const drop: THREE.Object3D[] = []; loaded.traverse((o) => { if ((o as THREE.Mesh).isMesh && def.hide!.test(o.name)) drop.push(o); }); for (const o of drop) o.removeFromParent(); }
      if (def.rot) { root = new THREE.Group(); loaded.rotation.set(...def.rot); root.add(loaded); } // build() 가 inner.rotation.x(roll)을 덮어쓰므로 한 겹 감싸서 굽는다
      const s = prepare(root, def.length, glb || !!def.own, def.grip); s.parts = def.parts ?? FILE_PARTS[def.file]; ready.set(def.file, s); return s;
    })
      .catch((e) => { console.warn('[weaponModels] 모델 로드 실패 → 박스 모델 폴백:', def.file, e); return null; });
    pending.set(def.file, p);
  }
  return p;
}
/** 해당 무기/스킨이 쓰는 모델 파일의 로드가 끝나면(실패 포함) resolve — 이후 createWeaponMesh 는 동기로 실제 모델을 붙인다 */
export function weaponModelReady(weaponId: WeaponId, skinId?: string | null): Promise<void> { return load(modelFor(weaponId, skinId)).then(() => undefined); }
/** 시작 시 한 번 호출 — 사용하는 모델을 미리 받아 둔다 */
export function preloadWeaponModels(): void { for (const id of Object.keys(WEAPON_MODELS) as WeaponId[]) void load(WEAPON_MODELS[id]); }

const nativeCache = new Map<string, THREE.MeshStandardMaterial>();
const native = (m: THREE.Material): THREE.MeshStandardMaterial => {
  const ph = m as THREE.MeshPhongMaterial, col = ph.color, map = ph.map, k = m.name + '|' + (col?.getHexString() ?? '') + '|' + (map?.uuid ?? ''); let r = nativeCache.get(k);
  if (!r) { const metal = /Metal/i.test(m.name) || !!map; r = new THREE.MeshStandardMaterial({ color: col ?? 0x888888, map: map ?? null, metalness: metal ? 0.7 : 0.25, roughness: metal ? 0.4 : 0.6 }); nativeCache.set(k, r); }
  return r;
};

/** parts 기본 재질(미장착 스킨) — 금속 부위는 장면 환경맵 반사를 받도록 envMapIntensity 를 높인다 */
const partCache = new Map<PartDef, THREE.MeshStandardMaterial>();
const partMat = (p: PartDef): THREE.MeshStandardMaterial => {
  let r = partCache.get(p);
  if (!r) { r = new THREE.MeshStandardMaterial({ color: p.color, metalness: p.metalness, roughness: p.roughness, envMapIntensity: p.metalness > 0.5 ? 1.6 : 1 }); partCache.set(p, r); }
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
    const part = curMesh && src.parts?.[curMesh.name];
    if (part) return skin.skinned ? (part.role === 'base' ? skin.base : part.role === 'accent' ? skin.accent : part.role === 'glass' ? glassMat : darkMat) : partMat(part);
    const role = src.roles.get(m.name) ?? 'base';
    if (role === 'glass') return glassMat; if (role === 'dark') return darkMat;
    if (!skin.skinned) return src.glb && curMesh ? glbNative(curMesh, m) : native(m);
    return role === 'base' ? skin.base : skin.accent; // 스킨 재질(프로시저럴 텍스처/PBR/발광) 연결
  };
  inner.traverse((o) => {
    const me = o as THREE.Mesh; if (!me.isMesh) return;
    curMesh = me;
    const puv = src.glb && skin.skinned ? planarUvs.get(me.geometry) : undefined;
    if (puv) { me.geometry = me.geometry.clone(); me.geometry.setAttribute('uv', new THREE.BufferAttribute(puv, 2)); }
    me.material = Array.isArray(me.material) ? me.material.map(pick) : pick(me.material);
  });
  return wrap;
}

/** 프로시저럴 폴백 group 에 FBX 모델을 비동기 교체 장착. 실패/미매핑이면 폴백 유지. */
export function attachFbxModel(g: THREE.Group, weaponId: WeaponId, skin: SkinSet, viewmodel: boolean, skinId?: string | null): void {
  const def = modelFor(weaponId, skinId); if (!def) return;
  const apply = (src: Source): void => {
    const model = build(src, skin, def.roll ?? 0);
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = !viewmodel; if (viewmodel) { o.frustumCulled = false; o.renderOrder = 10; } } });
    const mz = g.userData.muzzle as THREE.Object3D;
    for (const c of [...g.children]) if (c !== mz && !c.userData.keep) c.removeFromParent(); // 등급 파츠(userData.keep)는 유지
    g.add(model);
    mz.position.copy(src.muzzle).add(src.offset).multiplyScalar(src.scale).applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2);
    if (weaponId === 'sword' || weaponId === 'dagger') { // 근접 무기: 그룹 공간 z → 칼날 중심선 높이(y) (휘어진 날에서 등급 파츠가 허공에 뜨지 않게)
      const { y, x0, len } = src.axis, N = y.length;
      g.userData.axisY = (z: number): number => {
        const t = Math.min(N - 1, Math.max(0, ((-z / src.scale - src.offset.x - x0) / len) * N - 0.5)), i = Math.floor(t), j = Math.min(N - 1, i + 1);
        return (y[i] + (y[j] - y[i]) * (t - i) + src.offset.y) * src.scale;
      };
    }
    g.userData.fbx = true; (g.userData.onModel as (() => void) | undefined)?.(); // 총구 위치 확정 → 등급 파츠 재배치
  };
  const hit = ready.get(def.file); if (hit) { apply(hit); return; }
  void load(def).then((s) => { if (s) apply(s); });
}
