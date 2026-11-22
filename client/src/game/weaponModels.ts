// =====================================================================
// Quaternius 총기 모델 로더 (FBX → GLB 변환본) — 1회 비동기 로드 → 캐시 → clone 재사용.
// 로딩 전/실패 시에는 호출측의 프로시저럴(박스) 모델이 그대로 폴백으로 남는다.
// FBX 규약(실측): 총열 방향 = +X, 위 = +Y, 원점 ≈ 그립. 게임 규약: 전방 = -Z → Y축 +90° 회전.
// =====================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { WeaponId } from '../config/weapons';
import { getSkin } from '../config/skins';

/** 무기 → FBX 파일, 정규화 전체 길이(m, 개머리판~총구) */
/** file = 모델 이름(확장자 .fbx/.glb/없음 모두 같은 이름의 .glb 를 GLTFLoader 로 로드).
 *  grip = 뒤쪽 끝에서 손잡이 위치(0~1, 모델 길이 비율) → 그 지점이 뷰모델 원점, roll = 길이축 회전(rad, 평평한 면을 카메라 쪽으로) */
export const WEAPON_MODELS: Partial<Record<WeaponId, ModelDef>> = {
  // M9 Bayonet(GLB, knife.blend → Blender CLI 변환: 날끝 +X · 날 -Y · 두께 Z, 메시 = blade/garda/handle) — 31cm, 손잡이 중앙(t≈0.19) 파지
  dagger: { file: 'm9_bayonet.glb', length: 0.31, grip: 0.19 },  // 카타나(FBX, 단위 ≈ cm, 날끝 -X · 칼날 평면 = XZ · 날(볼록면) +Z, 칼집 포함) → 칼집 제거, 날끝 +X · 날이 아래(-Y)로 향하도록 회전.
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
  // 투척류(FBX, 텍스처 미포함 → FILE_PARTS 재질). 루트 노드의 Blender 축변환(-90° X)을 build() 의 roll 이 덮어쓰지 않도록 rot 으로 감싸 굽는다 → Y-up.
  // length = 모델 X 폭 기준 정규화값 → 실제 높이 ≈ 섬광탄 12cm · 수류탄 11cm
  flash: { file: 'flashbang.fbx', length: 0.12 * (5.7 / 13.25), rot: [-Math.PI / 2, 0, 0] },
  grenade: { file: 'grenade.fbx', length: 0.11 * (198.3 / 298.6), rot: [-Math.PI / 2, 0, 0] },
};

/** 텍스처가 없는 FBX 의 파일별 기본 재질/스킨 역할 (메시 이름 기준) — 스킨 전용 모델(GlbSpec)은 parts 를 가질 수 없어 여기서 지정 */
const AK_STEEL = { color: 0x2b3038, metalness: 0.82, roughness: 0.38 };
const NADE_STEEL: PartDef = { role: 'accent', color: 0xa9aeb4, metalness: 0.9, roughness: 0.3 };
const NADE_DARK: PartDef = { role: 'dark', color: 0x2a2d31, metalness: 0.7, roughness: 0.45 };
const FILE_PARTS: Record<string, Record<string, PartDef>> = {
  // CS2 섬광탄: 무광 그레이 원통 몸체 + 다크 코어 · 스틸 레버/헤드 · 밝은 핀/링 (메시 이름 = FBX 실측)
  'flashbang.fbx': {
    Body: { role: 'base', color: 0x8d949b, metalness: 0.55, roughness: 0.42 }, Core: NADE_DARK, Head: { ...NADE_STEEL, color: 0x6f757c },
    Lever: NADE_STEEL, PIn_1: { ...NADE_STEEL, color: 0xd2d5d8 }, Pin_2: { ...NADE_STEEL, color: 0xd2d5d8 }, Picker_1: NADE_STEEL, Picker_2: NADE_STEEL,
  },
  // CS2 고폭 수류탄: 올리브 드랩 구형 몸체 + 스틸 신관/스푼(handle) · 밝은 안전핀 링
  'grenade.fbx': {
    body: { role: 'base', color: 0x46502f, metalness: 0.35, roughness: 0.58 }, body001: NADE_STEEL, head: { ...NADE_STEEL, color: 0x7a8086 },
    handle: { ...NADE_STEEL, color: 0x8e9399 }, Cylinder001: NADE_DARK, ring: { ...NADE_STEEL, color: 0xd2d5d8 }, ring2: { ...NADE_STEEL, color: 0xd2d5d8 },
    ball: NADE_DARK, ball2: NADE_DARK,
  },
  // CS2 기본 AK-47 투톤: 건메탈 스틸 총몸/총열/가스관/가늠쇠 + 호두나무 개머리판·권총 손잡이·상하부 총열덮개.
  // m_gun 은 단일 병합 메시라 삼각형 무게중심(모델 cm 좌표: x = 총구 방향 길이, y = 높이)으로 목재 영역을 분리 — 측면 진단 렌더로 경계 실측
  'ak47.fbx': {
    m_gun: {
      role: 'base', ...AK_STEEL,
      split: {
        test: (x, y) => x < -3.6 || (x < 3 && y < 3.5) || (x > 22.5 && x < 39.6 && y < 9.6) || (x > 27.6 && x < 39.6 && y > 9.6), // 개머리판 · 손잡이 · 하부/상부 덮개 + 중앙 가로 띠(y 9.6~10.6)
        part: { role: 'base', color: 0x87492a, metalness: 0.05, roughness: 0.68, grain: true },
      },
    },
    m_mag: { role: 'accent', ...AK_STEEL },
    m_trigger: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 }, m_fireselect: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 },
    m_maglid: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 }, m_magrel: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 },
    m_shelleject: { role: 'dark', color: 0x18191c, metalness: 0.7, roughness: 0.5 },
  },
};

/** 근접 무기 칼날 마스크 — 단일 병합 메시를 [손잡이(0), 칼날(1), 금속 파츠(2)] 삼각형 그룹으로 나눈다.
 *  comps = 모델의 실제 위상(위치 용접 후 삼각형 연결 컴포넌트, 삼각형 수 내림차순 순위) 기준 칼날/금속 컴포넌트 → 파츠 경계가 모델링 그대로 떨어진다(우선 사용)
 *  from = (comps 없는 모델용) 길이축 위치 절단(0=손잡이 끝 ~ 1=날끝), handleOnly = 통째로 손잡이인 메시(예: 파라코드),
 *  blade/handle/metal/wrap = 기본(스킨 미적용) 재질 — 생략 시 모델 내장 재질 유지. 스킨 적용 시 칼날에만 스킨 재질, 금속 파츠·손잡이는 기본 유지.
 *  mats = 칼날 외 부위에서 원본 재질 이름별 기본 재질(handle/wrap 보다 우선) */
interface BladeMask { from?: number; comps?: { blade: number[]; metal?: number[] }; handleOnly?: RegExp; blade?: PartDef; handle?: PartDef; metal?: PartDef; wrap?: PartDef; mats?: Record<string, PartDef> }
/** 카람빗 재질. 손잡이 몸체 = 모든 스킨 공통 매트 차콜 폴리머, 기본(바닐라) 칼날·핑거 링 = 건메탈 탄소강 */
const KARAMBIT_POLYMER: PartDef = { role: 'dark', color: 0x181a1e, metalness: 0.15, roughness: 0.82 };
const KARAMBIT_VANILLA_BLADE: PartDef = { role: 'base', color: 0x2d323a, metalness: 0.84, roughness: 0.34 };
/** 스킨별 칼날 재질(GlbSpec.variant). 표면 경화 #387 블루젬: 시트의 큰 코발트 블루 덩어리를 칼날 측면 전체에 1:1 비율로 배치 (평면 UV: u = 길이축 0~1, v = 높이/길이) */
const BLADE_VARIANTS: Record<string, PartDef> = {
  case_hardened_387: { role: 'base', color: 0xa8bce6, metalness: 0.76, roughness: 0.26, envMapIntensity: 0.8, sheet: { url: 'textures/case_hardened.png', rotation: 0, repeat: [0.5, 0.5], offset: [-0.37, 0.41] } },
  // 도플러 루비: doppler.jpeg 시트의 왼쪽 붉은 연기 구역(U≈0.17~0.41)만 칼날+핑거 링에 매핑 (three offset 은 중심 기준: u' = r·(u-0.5)+0.5+off)
  doppler_ruby: { role: 'base', color: 0xffc4c4, metalness: 0.78, roughness: 0.2, envMapIntensity: 0.85, sheet: { url: 'textures/doppler.jpeg', rotation: 0, repeat: [0.24, 0.55], offset: [-0.21, 0.225] } },
};
const DAMASCUS_FILE = 'damascus_karambit.glb';
const BLADE_MASKS: Record<string, BladeMask> = {
  // CS2 카람빗(damascus_karambit.glb): 단일 메시·연결 컴포넌트 3개(실측) — #0 손잡이 몸체(4730 tri), #1 핑거 링(948), #2 칼날(858)
  // → 칼날 + 핑거 링 금속 테두리 = 같은 블레이드 그룹(바닐라 건메탈, 스킨 variant/skin.base 가 둘 다 덮어씀), 손잡이 몸체만 매트 차콜 폴리머. 내장 다마스커스 PBR 텍스처는 원본 root 재질에 그대로 보존(embeddedMaterials)
  [DAMASCUS_FILE]: {
    comps: { blade: [1, 2] },
    blade: KARAMBIT_VANILLA_BLADE, handle: KARAMBIT_POLYMER,
  },
  // CS2 바닐라 스켈레톤: 내장 Fade 텍스처를 덮어쓰는 무광 다크 스틸 날 + 차콜 그레이 프레임/링, 파라코드(Plane001)는 통째로 손잡이
  'skeleton_knife.glb': {
    from: 0.42, handleOnly: /^Plane001$/,
    blade: { role: 'base', color: 0x2d323a, metalness: 0.82, roughness: 0.38 },
    handle: { role: 'dark', color: 0x1c1e23, metalness: 0.6, roughness: 0.5 },
    wrap: { role: 'dark', color: 0x1c1e23, metalness: 0.08, roughness: 0.88 },
  },
  // 보위 나이프: 단일 메시의 연결 컴포넌트 8개(실측) — #0 칼날, #4 가드, #5 폼멜, #6 손잡이 슬랩, #1·2·3·7 리벳
  // → 새틴 스틸 날 + 브라스 가드/폼멜/리벳 + 다크 월넛 손잡이 (외부 PNG 텍스처는 저장소에 없음)
  'bowie_knife.fbx': {
    comps: { blade: [0], metal: [1, 2, 3, 4, 5, 7] },
    blade: { role: 'base', color: 0xb9bec4, metalness: 0.92, roughness: 0.22 },
    metal: { role: 'accent', color: 0xa8854a, metalness: 0.9, roughness: 0.32 },
    handle: { role: 'dark', color: 0x3a2417, metalness: 0.05, roughness: 0.62 },
  },
  // M9 총검: blade 메시 전체 = 칼날(내장 브러시드 스틸 텍스처 유지), garda·handle = 손잡이.
  // 원본 'Black plastic' 은 ColorRamp 노드 재질이라 glTF 에선 스크래치 마스크가 base color 로 나와 → 무광 블랙 폴리머로 대체, 'Dark iron'(폼멜)은 다크 스틸
  'm9_bayonet.glb': {
    from: 0, handleOnly: /^(garda|handle)/,
    handle: { role: 'dark', color: 0x141519, metalness: 0.1, roughness: 0.78 },
    mats: { 'Dark iron': { role: 'dark', color: 0x34383e, metalness: 0.85, roughness: 0.42 } },
  },
};

/** own = FBX 라도 내장 UV/텍스처를 유지(GLB 와 동일 취급). 스킨 적용 시에만 평면 UV 사용
 *  rot = 정규화 전에 모델에 굽는 회전(Euler XYZ) → 길이축을 +X 로 맞춤, hide = 제거할 메시 이름(예: 칼집),
 *  parts = 메시 이름별 기본 재질 + 스킨 역할(재질이 하나뿐인 모델용, 부모 메시 이름이 아닌 메시 자신의 이름 기준) */
type ModelDef = { file: string; length: number; grip?: number; roll?: number; own?: boolean; rot?: [number, number, number]; hide?: RegExp; parts?: Record<string, PartDef>; variant?: string };
type Role = 'base' | 'accent' | 'dark' | 'glass';
/** split = 단일 메시 안의 2차 영역(rot 적용 후 모델 좌표 x/y 로 판정) → 기본 외형에서만 part 재질, 스킨 장착 시엔 메시 전체가 기존처럼 role 스킨. grain = 나뭇결 텍스처 */
interface PartDef { role: Role; color: number; metalness: number; roughness: number; envMapIntensity?: number; grain?: boolean; sheet?: SheetMap; split?: { test: (x: number, y: number) => boolean; part: PartDef } }
/** 원본 시트 이미지(public/textures)를 평면 UV 로 매핑하는 변환 — THREE.Texture 의 center/rotation/repeat/offset 그대로 */
interface SheetMap { url: string; rotation: number; repeat: [number, number]; offset: [number, number] }
interface Source { glb: boolean; root: THREE.Object3D; roles: Map<string, Role>; scale: number; offset: THREE.Vector3; muzzle: THREE.Vector3; parts?: Record<string, PartDef>; mask?: BladeMask; axis: { y: Float32Array; x0: number; len: number } }
export interface SkinSet { base: THREE.Material; accent: THREE.Material; skinned: boolean }

const gltfLoader = new GLTFLoader();
const isGlb = (f: string): boolean => /\.(glb|gltf)$/i.test(f);
const pending = new Map<string, Promise<Source | null>>();
const ready = new Map<string, Source>();
const BASE = (import.meta.env?.BASE_URL ?? '/') + 'models/';
const darkMat = new THREE.MeshStandardMaterial({ color: 0x14161a, roughness: 0.5, metalness: 0.7 });
const glassMat = new THREE.MeshStandardMaterial({ color: 0x88c8ff, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.4 });

/** GLB/own 모델의 평면 UV — userData 는 clone() 시 JSON 직렬화되어 Float32Array 가 깨지므로(→ 렌더 예외) 지오메트리 키로 따로 보관 */
const planarUvs = new WeakMap<THREE.BufferGeometry, Float32Array>();
/** 칼날 마스크로 분할된 지오메트리 → 정점별 그룹 번호 (스킨 시 칼날(1) 정점만 평면 UV, 나머지는 원본 UV 유지) */
const bladeVerts = new WeakMap<THREE.BufferGeometry, Uint8Array>();

const triVerts = (src: ArrayLike<number> | null, t: number): [number, number, number] => (src ? [src[t * 3], src[t * 3 + 1], src[t * 3 + 2]] : [t * 3, t * 3 + 1, t * 3 + 2]);

/** 삼각형마다 cls(삼각형 번호, root 공간 무게중심 x/y) 가 돌려준 그룹(0..)으로 인덱스를 재정렬 (material → 그룹 수만큼 복제, 최소 2). 반환 = 정점별 그룹 */
function splitTris(me: THREE.Mesh, cls: (t: number, x: number, y: number) => number): Uint8Array {
  const g = me.geometry, pos = g.attributes.position, src = g.index ? g.index.array : null, tris = (src ? src.length : pos.count) / 3;
  const xs = new Float32Array(pos.count), ys = new Float32Array(pos.count), v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(me.matrixWorld); xs[i] = v.x; ys[i] = v.y; }
  const groups: number[][] = [[], []], flag = new Uint8Array(pos.count);
  for (let t = 0; t < tris; t++) {
    const [a, b, c] = triVerts(src, t), k = cls(t, (xs[a] + xs[b] + xs[c]) / 3, (ys[a] + ys[b] + ys[c]) / 3);
    (groups[k] ??= []).push(a, b, c); flag[a] = flag[b] = flag[c] = k;
  }
  g.setIndex(groups.flatMap((x) => x ?? []));
  g.clearGroups(); let at = 0;
  groups.forEach((x, k) => { const n = x?.length ?? 0; g.addGroup(at, n, k); at += n; });
  const m = me.material as THREE.Material; me.material = groups.map(() => m);
  return flag;
}

/** 위치 용접(같은 좌표 정점 = 한 정점) 후 삼각형 연결 컴포넌트(union-find) — 반환 = 삼각형별 컴포넌트 순위(삼각형 수 내림차순, 0 = 최대) */
function triComponents(g: THREE.BufferGeometry): Int32Array {
  const pos = g.attributes.position, src = g.index ? g.index.array : null, tris = (src ? src.length : pos.count) / 3;
  const weld = new Map<string, number>(), vid = new Int32Array(pos.count), q = (n: number): number => Math.round(n * 1e4);
  for (let i = 0; i < pos.count; i++) { const k = `${q(pos.getX(i))},${q(pos.getY(i))},${q(pos.getZ(i))}`; let id = weld.get(k); if (id === undefined) weld.set(k, (id = weld.size)); vid[i] = id; }
  const par = Int32Array.from({ length: weld.size }, (_, i) => i);
  const find = (x: number): number => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let t = 0; t < tris; t++) { const [a, b, c] = triVerts(src, t), r = find(vid[a]); par[find(vid[b])] = r; par[find(vid[c])] = r; }
  const root = new Int32Array(tris), size = new Map<number, number>();
  for (let t = 0; t < tris; t++) { const r = (root[t] = find(vid[triVerts(src, t)[0]])); size.set(r, (size.get(r) ?? 0) + 1); }
  const rank = new Map([...size.entries()].sort((a, b) => b[1] - a[1]).map(([r], i) => [r, i]));
  return root.map((r) => rank.get(r)!);
}

/** 칼날 마스크: comps(실제 연결 컴포넌트) 또는 from(길이축 절단)으로 [손잡이 0, 칼날 1, 금속 2] 분할 */
function splitBlade(root: THREE.Object3D, mask: BladeMask): void {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), cut = box.min.x + (box.max.x - box.min.x) * (mask.from ?? 0);
  root.traverse((o) => {
    const me = o as THREE.Mesh;
    if (!me.isMesh || Array.isArray(me.material) || mask.handleOnly?.test(me.name)) return;
    const cs = mask.comps, comp = cs ? triComponents(me.geometry) : null;
    bladeVerts.set(me.geometry, splitTris(me, (t, x) => (cs ? (cs.blade.includes(comp![t]) ? 1 : cs.metal?.includes(comp![t]) ? 2 : 0) : x >= cut ? 1 : 0)));
  });
}

/** parts.split: 메시 이름별 2차 영역 분할 (예: AK-47 m_gun → [스틸, 목재]) */
function splitParts(root: THREE.Object3D, parts: Record<string, PartDef>): void {
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const me = o as THREE.Mesh, sp = parts[me.name]?.split;
    // sp.test 의 임계값은 모델 원본 cm 좌표 기준 — GLB 는 루트 스케일 0.01(m)로 구워져 있으므로 월드 좌표를 cm 로 환산해 넘긴다
    if (me.isMesh && sp && !Array.isArray(me.material)) { const k = 1 / me.matrixWorld.getMaxScaleOnAxis(); splitTris(me, (_t, x, y) => (sp.test(x * k, y * k) ? 1 : 0)); }
  });
}

/** 프로시저럴 호두나무 나뭇결 (평면 UV: u = 길이축, v = 높이 → 결이 총 길이 방향으로 흐름) */
let woodTex: THREE.CanvasTexture | null = null;
function woodGrain(): THREE.CanvasTexture {
  if (woodTex) return woodTex;
  const S = 512, cv = document.createElement('canvas'); cv.width = cv.height = S;
  const x = cv.getContext('2d')!;
  x.fillStyle = '#ffffff'; x.fillRect(0, 0, S, S); // 색은 재질 color 로 곱해짐 → 텍스처는 밝기 변조만
  let seed = 7; const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    const y0 = rnd() * S, amp = 2 + rnd() * 6, f = 1 + rnd() * 3, ph = rnd() * 6.28, w = 0.6 + rnd() * 2.4;
    x.strokeStyle = rnd() < 0.7 ? `rgba(60,25,8,${0.12 + rnd() * 0.22})` : `rgba(255,220,180,${0.08 + rnd() * 0.12})`; x.lineWidth = w;
    x.beginPath(); for (let u = 0; u <= S; u += 8) { const yy = y0 + Math.sin((u / S) * 6.28 * f + ph) * amp; if (u) x.lineTo(u, yy); else x.moveTo(u, yy); } x.stroke();
  }
  woodTex = new THREE.CanvasTexture(cv); woodTex.colorSpace = THREE.SRGBColorSpace;
  woodTex.wrapS = woodTex.wrapT = THREE.RepeatWrapping; woodTex.repeat.set(2, 6); woodTex.anisotropy = 4;
  return woodTex;
}
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

/** 칼날 재질: 스킨 variant 가 있으면 그것, 없으면 마스크 기본(바닐라) */
const bladeOf = (def: ModelDef): PartDef | undefined => (def.variant ? BLADE_VARIANTS[def.variant] : undefined) ?? BLADE_MASKS[def.file]?.blade;
/** 모델에 내장된 원본 재질(예: damascus_karambit.glb 의 다마스커스 PBR 텍스처) — 로드 후 향후 다마스커스 스틸 스킨이 그대로 재사용할 수 있게 보존 */
export const embeddedMaterials = (file: string): THREE.Material[] => {
  const out = new Set<THREE.Material>(); ready.get(file)?.root.traverse((o) => { if ((o as THREE.Mesh).isMesh) matsOf(o as THREE.Mesh).forEach((m) => out.add(m)); });
  return [...out];
};

function load(def: ModelDef | undefined): Promise<Source | null> {
  if (!def) return Promise.resolve(null);
  let p = pending.get(def.file);
  if (!p) {
    const glb = isGlb(def.file);
    // 모든 무기/투척물 모델은 .glb 로 변환됨 — def.file 이 .fbx/확장자 없음이어도 같은 이름의 .glb 를 GLTFLoader 로 로드한다.
    // (glb 플래그 = 원본이 GLB 인가: 내장 PBR/UV 사용 여부 판단용이라 변환 여부와 무관하게 원래 의미를 유지)
    const url = glb ? def.file : def.file.replace(/\.fbx$/i, '') + '.glb';
    const raw: Promise<THREE.Object3D> = gltfLoader.loadAsync(BASE + url).then((g) => g.scene);
    p = Promise.all([raw, preloadSheet(bladeOf(def)?.sheet)]).then(([loaded]) => {
      let root = loaded;
      if (def.hide) { const drop: THREE.Object3D[] = []; loaded.traverse((o) => { if ((o as THREE.Mesh).isMesh && def.hide!.test(o.name)) drop.push(o); }); for (const o of drop) o.removeFromParent(); }
      if (def.rot) { root = new THREE.Group(); loaded.rotation.set(...def.rot); root.add(loaded); } // build() 가 inner.rotation.x(roll)을 덮어쓰므로 한 겹 감싸서 굽는다
      const mask = BLADE_MASKS[def.file], parts = def.parts ?? FILE_PARTS[def.file];
      if (mask) splitBlade(root, mask);
      if (parts) splitParts(root, parts);
      const s = prepare(root, def.length, glb || !!def.own, def.grip); s.parts = parts; s.mask = mask; ready.set(def.file, s); return s;
    })
      .catch((e) => { console.warn('[weaponModels] 모델 로드 실패 → 박스 모델 폴백:', def.file, e); return null; });
    pending.set(def.file, p);
  }
  return p;
}
/** 해당 무기/스킨이 쓰는 모델 파일의 로드가 끝나면(실패 포함) resolve — 이후 createWeaponMesh 는 동기로 실제 모델을 붙인다 */
export function weaponModelReady(weaponId: WeaponId, skinId?: string | null): Promise<void> { return load(modelFor(weaponId, skinId)).then(() => undefined); }
/** 시작 시 한 번 호출 — 사용하는 모델을 미리 받아 둔다 */
export function preloadWeaponModels(): Promise<void> { return Promise.all((Object.keys(WEAPON_MODELS) as WeaponId[]).map((id) => load(WEAPON_MODELS[id]))).then(() => undefined); }

const nativeCache = new Map<string, THREE.MeshStandardMaterial>();
const native = (m: THREE.Material): THREE.MeshStandardMaterial => {
  const ph = m as THREE.MeshPhongMaterial, col = ph.color, map = ph.map, k = m.name + '|' + (col?.getHexString() ?? '') + '|' + (map?.uuid ?? ''); let r = nativeCache.get(k);
  if (!r) { const metal = /Metal/i.test(m.name) || !!map; r = new THREE.MeshStandardMaterial({ color: col ?? 0x888888, map: map ?? null, metalness: metal ? 0.7 : 0.25, roughness: metal ? 0.4 : 0.6 }); nativeCache.set(k, r); }
  return r;
};

/** parts 기본 재질(미장착 스킨) — 금속 부위는 장면 환경맵 반사를 받도록 envMapIntensity 를 높인다 */
const partCache = new Map<PartDef, THREE.MeshStandardMaterial>();
const texLoader = new THREE.TextureLoader();
const sheetBase = new Map<string, THREE.Texture>();
/** 모델 로드 전에 시트 이미지를 먼저 받아 둔다 → 썸네일/프리뷰가 텍스처 미로드(검은 칼날) 상태로 캡처되지 않게 */
const preloadSheet = (s?: SheetMap): Promise<unknown> => (!s || sheetBase.has(s.url) ? Promise.resolve() : texLoader.loadAsync((import.meta.env?.BASE_URL ?? '/') + s.url).then((t) => sheetBase.set(s.url, t)));
function sheetTex(s: SheetMap): THREE.Texture {
  const t = sheetBase.get(s.url)!.clone(); t.needsUpdate = true;
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
  t.center.set(0.5, 0.5); t.rotation = s.rotation; t.repeat.set(...s.repeat); t.offset.set(...s.offset);
  return t;
}
const partMat = (p: PartDef): THREE.MeshStandardMaterial => {
  let r = partCache.get(p);
  if (!r) { r = new THREE.MeshStandardMaterial({ color: p.color, metalness: p.metalness, roughness: p.roughness, envMapIntensity: p.envMapIntensity ?? (p.metalness > 0.5 ? 1.6 : 1), map: p.sheet ? sheetTex(p.sheet) : p.grain ? woodGrain() : null }); partCache.set(p, r); }
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

function build(src: Source, skin: SkinSet, roll = 0, blade?: PartDef): THREE.Group {
  const wrap = new THREE.Group(); wrap.rotation.y = Math.PI / 2; wrap.scale.setScalar(src.scale); // +X(총열) → -Z(전방)
  const inner = src.root.clone(true); inner.position.copy(src.offset); inner.rotation.x = roll; wrap.add(inner);
  let curMesh: THREE.Mesh | null = null;
  const pick = (m: THREE.Material, i = 0): THREE.Material => {
    const part = curMesh && src.parts?.[curMesh.name];
    if (part) return skin.skinned ? (part.role === 'base' ? skin.base : part.role === 'accent' ? skin.accent : part.role === 'glass' ? glassMat : darkMat) : partMat(i === 1 && part.split ? part.split.part : part);
    const role = src.roles.get(m.name) ?? 'base';
    if (role === 'glass') return glassMat; if (role === 'dark') return darkMat;
    if (!skin.skinned) return src.glb && curMesh ? glbNative(curMesh, m) : native(m);
    return role === 'base' ? skin.base : skin.accent; // 스킨 재질(프로시저럴 텍스처/PBR/발광) 연결
  };
  // 칼날 마스크: 손잡이(0)·금속 파츠(2, 예: 핑거 링)는 항상 기본 재질, 스킨은 칼날 그룹(1)에만
  const mask = src.mask;
  const own = (m: THREE.Material, def?: PartDef): THREE.Material => (def ? partMat(def) : src.glb && curMesh ? glbNative(curMesh, m) : native(m));
  const pickMasked = (m: THREE.Material, group: number): THREE.Material =>
    group === 1 ? (skin.skinned ? skin.base : own(m, blade ?? mask!.blade))
      : group === 2 ? own(m, mask!.mats?.[m.name] ?? mask!.metal ?? mask!.blade)
        : own(m, mask!.mats?.[m.name] ?? (curMesh && mask!.handleOnly?.test(curMesh.name) ? mask!.wrap ?? mask!.handle : mask!.handle));
  inner.traverse((o) => {
    const me = o as THREE.Mesh; if (!me.isMesh) return;
    curMesh = me;
    const puv = src.glb && (skin.skinned || (blade ?? mask?.blade)?.sheet) ? planarUvs.get(me.geometry) : undefined, flag = bladeVerts.get(me.geometry);
    if (puv && !(mask && !flag)) { // 마스크 모델의 손잡이 전용 메시는 원본 UV 유지
      let uv = puv;
      if (flag) { const orig = me.geometry.attributes.uv; uv = new Float32Array(puv); if (orig) for (let i = 0; i < flag.length; i++) if (flag[i] !== 1) { uv[i * 2] = orig.getX(i); uv[i * 2 + 1] = orig.getY(i); } }
      me.geometry = me.geometry.clone(); me.geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    }
    if (mask) me.material = Array.isArray(me.material) ? me.material.map((m, i) => pickMasked(m, flag ? i : 0)) : pickMasked(me.material, 0);
    else me.material = Array.isArray(me.material) ? me.material.map(pick) : pick(me.material);
  });
  return wrap;
}

/** 프로시저럴 폴백 group 에 FBX 모델을 비동기 교체 장착. 실패/미매핑이면 폴백 유지. */
export function attachFbxModel(g: THREE.Group, weaponId: WeaponId, skin: SkinSet, viewmodel: boolean, skinId?: string | null): void {
  const def = modelFor(weaponId, skinId); if (!def) return;
  const apply = (src: Source): void => {
    const model = build(src, skin, def.roll ?? 0, bladeOf(def));
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
