// =====================================================================
// 3D 무기 상자 — 모델 로더 · 파츠 바인딩 · 개봉 무대 · 상점 썸네일
//
//  모델: public/models/scifi_crate.fbx (최종 확정, 원본 SciFi_Crate.fbx)
//   - 단일 메시 'SciFiCrate'(약 37만 삼각형) + 재질 그룹 6개(실측):
//       몸체 = body · FrontMetal(정면 +Z 패널) · SideMetal(측면 패널)
//       뚜껑 = TopBase(상판) · TopMetal(상단 프레임) · TopDevice(중앙 레버/잠금장치)
//   - 로드 시 재질 그룹 기준으로 몸체/뚜껑 두 메시로 분할(정점 버퍼 공유) → 뚜껑은 뒤쪽(-Z) 아래 모서리 경첩 피벗
//   - 원본 텍스처(Export_Text/Blender/*.png)는 FBX 에 내장돼 있지 않아 재질을 직접 지정한다(검게 나오지 않게)
//   - 열쇠는 모델에 없어 절차적 열쇠를 TopDevice 정면(자물쇠 마커)에 꽂는다
//  로드 실패 시 같은 리그 구조의 절차적 상자로 폴백. 결과 리그는 폭 1.0 으로 정규화, 바닥 y=0.
// =====================================================================
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { CaseKind } from '../config/skins';

/** height = 정규화 후 상자 높이(카메라 프레이밍용) */
export interface CaseRig { root: THREE.Group; lid: THREE.Group; key: THREE.Group; glow: THREE.Mesh; lock: THREE.Vector3; height: number }

const CRATE_URL = (import.meta.env?.BASE_URL ?? '/') + 'models/scifi_crate.fbx';
/** 뚜껑에 속하는 재질 그룹 (그 외 = 몸체) */
const LID_GROUP = /^Top/;
const BLANK_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

/** 상자 종류별 재질 색: drop = 국방색 + 건메탈 + 붉은 레버, store = 차콜 + 골드 프레임 + 붉은 레버 */
const LOOK: Record<CaseKind, { body: number; plate: number; frame: number; panel: number; device: number }> = {
  drop: { body: 0x4b5534, plate: 0x3f472b, frame: 0x5d636b, panel: 0x454a51, device: 0xb3261c },
  store: { body: 0x1c1d21, plate: 0x26272c, frame: 0xb8923e, panel: 0x2c2e34, device: 0xc0281e },
};
/** 재질 이름(FBX 재질 그룹명) → 종류별 MeshStandardMaterial */
const crateMats = new Map<CaseKind, Record<string, THREE.MeshStandardMaterial>>();
function crateMaterials(kind: CaseKind): Record<string, THREE.MeshStandardMaterial> {
  let m = crateMats.get(kind); if (m) return m;
  const L = LOOK[kind], std = (color: number, metalness: number, roughness: number): THREE.MeshStandardMaterial => new THREE.MeshStandardMaterial({ color, metalness, roughness });
  m = {
    body: std(L.body, 0.45, 0.55), TopBase: std(L.plate, 0.45, 0.5), TopMetal: std(L.frame, 0.9, 0.32),
    FrontMetal: std(L.panel, 0.85, 0.36), SideMetal: std(L.panel, 0.85, 0.38), TopDevice: std(L.device, 0.55, 0.38),
  };
  crateMats.set(kind, m); return m;
}

// ───────────────────────────── 외부 모델 로드 (1회) + 몸체/뚜껑 분할 ─────────────────────────────
/** 분할 결과: 정규화 전 원본 좌표계의 몸체/뚜껑 메시(재질 배열 = 원본 재질, 이름으로 교체) + 자물쇠 위치 */
interface CrateSrc { root: THREE.Group; lock: THREE.Vector3 }
let external: Promise<CrateSrc | null> | null = null;
/** 단일 메시를 재질 그룹으로 두 메시(test=true / false)로 나눈다 — 정점 속성은 공유하고 인덱스만 새로 만든다 */
function splitByGroups(me: THREE.Mesh, test: (matName: string) => boolean): [THREE.Mesh, THREE.Mesh] {
  const g = me.geometry, mats = me.material as THREE.Material[];
  const make = (want: boolean): THREE.Mesh => {
    const ng = new THREE.BufferGeometry(), idx: number[] = [];
    for (const [k, a] of Object.entries(g.attributes)) ng.setAttribute(k, a);
    for (const gr of g.groups) {
      if (test(mats[gr.materialIndex ?? 0].name) !== want) continue;
      ng.addGroup(idx.length, gr.count, gr.materialIndex);
      for (let i = gr.start; i < gr.start + gr.count; i++) idx.push(g.index ? g.index.getX(i) : i);
    }
    ng.setIndex(new THREE.BufferAttribute(new Uint32Array(idx), 1));
    const m = new THREE.Mesh(ng, mats); m.matrix.copy(me.matrixWorld); m.matrix.decompose(m.position, m.quaternion, m.scale); return m;
  };
  return [make(true), make(false)];
}
function prepareCrate(loaded: THREE.Object3D): CrateSrc {
  let found: THREE.Mesh | null = null;
  loaded.traverse((o) => { const m = o as THREE.Mesh; if (!found && m.isMesh && Array.isArray(m.material)) found = m; });
  if (!found) throw new Error('scifi_crate: 다중 재질 메시 없음');
  const me: THREE.Mesh = found;
  me.rotation.z = 0; loaded.updateMatrixWorld(true); // 원본 익스포트의 3° 요잉 제거 → 축 정렬 바운딩 박스
  const [lid, body] = splitByGroups(me, (n) => LID_GROUP.test(n));
  lid.name = 'case_lid'; body.name = 'case_body';
  const root = new THREE.Group(); root.add(body, lid); root.updateMatrixWorld(true);
  // 자물쇠: TopDevice(레버/잠금장치) 그룹의 정면(+Z) 중앙
  const g = lid.geometry, pos = g.attributes.position, mats = lid.material as THREE.Material[], b = new THREE.Box3(), v = new THREE.Vector3();
  for (const gr of g.groups) {
    if (mats[gr.materialIndex ?? 0].name !== 'TopDevice') continue;
    for (let i = gr.start; i < gr.start + gr.count; i += 3) b.expandByPoint(v.fromBufferAttribute(pos, g.index!.getX(i)).applyMatrix4(lid.matrixWorld));
  }
  const all = new THREE.Box3().setFromObject(root);
  const lock = b.isEmpty() ? new THREE.Vector3(0, all.max.y, all.max.z) : new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y + (b.max.y - b.min.y) * 0.4, b.max.z);
  me.geometry.dispose(); // 원본 인덱스(있다면)만 해제 — 정점 속성은 분할 메시가 공유
  return { root, lock };
}
function loadExternal(): Promise<CrateSrc | null> {
  // 원본 PBR 텍스처 경로는 저장소에 없음 → 요청 자체를 1px 데이터로 대체(404 방지, 재질은 crateMaterials 로 교체)
  external ??= (async () => {
    const mgr = new THREE.LoadingManager(); mgr.setURLModifier((u) => (/\.(png|jpe?g|tga)$/i.test(u) && !/^(data|blob):/.test(u) ? BLANK_PNG : u));
    return prepareCrate(await new FBXLoader(mgr).loadAsync(CRATE_URL));
  })().catch((e) => { console.warn('[case3d] 상자 모델 로드 실패 → 절차적 모델:', e); return null; });
  return external;
}

// ───────────────────────────── 열쇠 (공용) · 절차적 폴백 상자 ─────────────────────────────
const boxMesh = (m: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => { const me = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); me.position.set(x, y, z); return me; };
/** 열쇠: 링 + 자루 + 키 비트 (정규화 공간 크기, 길이축 = -Z · 자물쇠에 꽂히는 끝이 -Z) */
function makeKey(): THREE.Group {
  const m = new THREE.MeshStandardMaterial({ color: 0xd8b56a, metalness: 1, roughness: 0.24 }), key = new THREE.Group();
  const bow = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.014, 10, 28), m); bow.position.z = 0.1;
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.16, 12), m); shaft.rotation.x = Math.PI / 2;
  key.add(bow, shaft, boxMesh(m, 0.008, 0.04, 0.05, 0, -0.022, -0.05), boxMesh(m, 0.008, 0.025, 0.02, 0, -0.012, -0.075));
  return key;
}
/** 모델 로드 실패 시: 같은 재질 체계의 단순 상자 (몸체 + 상판/프레임 + 붉은 레버) */
function proceduralCrate(kind: CaseKind): CrateSrc {
  const M = crateMaterials(kind), root = new THREE.Group(), W = 1, H = 0.46, D = 0.44, LH = 0.1;
  const body = new THREE.Group(); body.name = 'case_body';
  body.add(boxMesh(M.body, W, H, D, 0, H / 2, 0), boxMesh(M.FrontMetal, W * 0.8, H * 0.7, 0.02, 0, H / 2, D / 2 + 0.01));
  const lid = new THREE.Group(); lid.name = 'case_lid';
  lid.add(boxMesh(M.TopBase, W + 0.03, LH, D + 0.03, 0, H + LH / 2, 0), boxMesh(M.TopMetal, W + 0.05, 0.03, D + 0.05, 0, H + 0.015, 0), boxMesh(M.TopDevice, 0.2, 0.06, 0.16, 0, H + LH + 0.03, 0));
  root.add(body, lid);
  return { root, lock: new THREE.Vector3(0, H + LH + 0.03, 0.08) };
}

// ───────────────────────────── 리그 (정규화 · 경첩 피벗 · 열쇠 · 발광면) ─────────────────────────────
/** 노드를 지정 위치(root 공간)의 피벗 그룹 아래로 옮긴다 (월드 변환 유지) */
function pivotAt(obj: THREE.Object3D, at: THREE.Vector3, parent: THREE.Object3D, name: string): THREE.Group {
  const p = new THREE.Group(); p.name = name; p.position.copy(at); parent.add(p); p.updateMatrixWorld(true);
  p.attach(obj); return p;
}
function rig({ root: src, lock: rawLock }: CrateSrc): CaseRig {
  const root = new THREE.Group(), holder = new THREE.Group(); root.add(holder); holder.add(src);
  // 1) 정규화: 폭(가장 긴 수평축) 1.0, 바닥 y=0, 중심 정렬
  src.updateMatrixWorld(true);
  const b0 = new THREE.Box3().setFromObject(src), s0 = b0.getSize(new THREE.Vector3()), c0 = b0.getCenter(new THREE.Vector3());
  const s = 1 / Math.max(1e-6, s0.x, s0.z); holder.scale.setScalar(s); holder.position.set(-c0.x * s, -b0.min.y * s, -c0.z * s);
  root.updateMatrixWorld(true);
  const lidObj = src.getObjectByName('case_lid')!, bodyObj = src.getObjectByName('case_body')!;
  // 2) 뚜껑: 뒤쪽(-Z) 아래 모서리 경첩
  const lb = new THREE.Box3().setFromObject(lidObj);
  const lid = pivotAt(lidObj, new THREE.Vector3(0, lb.min.y, lb.min.z), root, 'case_lid_pivot');
  // 3) 열쇠: 자물쇠(레버/잠금장치 정면) 앞에서 대기 → 개봉 연출에서 꽂고 돌림
  const lock = holder.localToWorld(rawLock.clone());
  const key = new THREE.Group(); key.name = 'keys_pivot'; key.add(makeKey()); key.position.copy(lock).add(new THREE.Vector3(0, 0, 0.11)); root.add(key);
  // 4) 내부 발광면 (뚜껑이 열리면 등급색으로 빛남)
  const bb = new THREE.Box3().setFromObject(bodyObj), bs = bb.getSize(new THREE.Vector3()), bc = bb.getCenter(new THREE.Vector3());
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(bs.x * 0.72, bs.z * 0.66), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.rotation.x = -Math.PI / 2; glow.position.set(bc.x, bb.max.y - bs.y * 0.18, bc.z); root.add(glow); // 테두리 안쪽 아래 — 상자 위에 떠 보이지 않게
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m !== glow) { m.castShadow = true; m.receiveShadow = true; } });
  return { root, lid, key, glow, lock, height: bb.max.y };
}

/** 상자 리그 생성 — scifi_crate.fbx 복제(지오메트리 공유) + 종류별 재질. 로드 실패 시 절차적 상자 */
export async function createCaseRig(kind: CaseKind): Promise<CaseRig> {
  const ext = await loadExternal();
  if (!ext) return rig(proceduralCrate(kind));
  const M = crateMaterials(kind), root = ext.root.clone(true);
  root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.material = (m.material as THREE.Material[]).map((x) => M[x.name] ?? M.body); });
  return rig({ root, lock: ext.lock.clone() });
}

// ───────────────────────────── 공용 조명 장면 ─────────────────────────────
function makeRenderer(w: number, h: number, keep: boolean): THREE.WebGLRenderer {
  const r = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: keep });
  r.setPixelRatio(keep ? 1 : Math.min(devicePixelRatio || 1, 2)); r.setSize(w, h, false);
  r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 1.05; r.setClearColor(0x000000, 0);
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
  return r;
}
function stageScene(r: THREE.WebGLRenderer): { scene: THREE.Scene; spot: THREE.SpotLight; inner: THREE.PointLight } {
  const scene = new THREE.Scene();
  const pm = new THREE.PMREMGenerator(r); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; pm.dispose();
  scene.environmentIntensity = 0.55;
  const spot = new THREE.SpotLight(0xfff1d6, 26, 8, 0.55, 0.55, 1.6); spot.position.set(0.6, 3.2, 1.6); spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -0.0004;
  const rim = new THREE.DirectionalLight(0x9fb3c8, 0.9); rim.position.set(-2, 1.4, -2.2);
  const inner = new THREE.PointLight(0xffffff, 0, 3, 1.4); inner.position.set(0, 0.3, 0); // 상자 내부 — 바깥 면(법선이 광원 반대)은 비추지 않아 '틈으로 새는 빛'이 된다
  const floor = new THREE.Mesh(new THREE.CircleGeometry(2.2, 48), new THREE.ShadowMaterial({ opacity: 0.55 })); floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  scene.add(new THREE.HemisphereLight(0xdfe6f0, 0x0a0a0a, 0.35), spot, spot.target, rim, inner, floor);
  return { scene, spot, inner };
}

// ───────────────────────────── 상점 카드 썸네일 (오프스크린 촬영 → 캐시 URL) ─────────────────────────────
const TW = 640, TH = 400;
const thumbs = new Map<CaseKind, Promise<string | null>>();
const thumbUrl = new Map<CaseKind, string | null>();
let thumbR: THREE.WebGLRenderer | null = null, thumbFail = false;
/** 이미 촬영된 상자 썸네일 (없으면 undefined, WebGL 불가면 null) */
export const cachedCaseThumb = (kind: CaseKind): string | null | undefined => thumbUrl.get(kind);
export function requestCaseThumb(kind: CaseKind): Promise<string | null> {
  let p = thumbs.get(kind);
  if (!p) {
    p = (async () => {
      if (thumbFail) return null;
      try { thumbR ??= makeRenderer(TW, TH, true); } catch (e) { console.warn('[case3d] WebGL 불가 — SVG 폴백', e); thumbFail = true; return null; }
      const { scene } = stageScene(thumbR), cam = new THREE.PerspectiveCamera(26, TW / TH, 0.05, 20);
      const r = await createCaseRig(kind); r.root.rotation.y = -0.5; scene.add(r.root);
      r.key.position.set(0.62, 0.02, 0.18); r.key.rotation.set(Math.PI / 2, 0, 0.9); // 열쇠는 상자 앞 바닥에 눕혀 함께 촬영
      // 바운딩 구 기준 자동 프레이밍 (3/4 위에서 내려다보는 고정 방향)
      const sph = new THREE.Box3().setFromObject(r.root).getBoundingSphere(new THREE.Sphere()), dir = new THREE.Vector3(0.42, 0.42, 0.8).normalize();
      const dist = sph.radius / Math.sin(THREE.MathUtils.degToRad(cam.fov / 2)) * 0.98;
      cam.position.copy(sph.center).addScaledVector(dir, dist); cam.lookAt(sph.center);
      thumbR.render(scene, cam); thumbR.render(scene, cam);
      const blob = await new Promise<Blob | null>((res) => thumbR!.domElement.toBlob(res, 'image/webp', 0.92));
      scene.environment?.dispose();
      const url = blob ? URL.createObjectURL(blob) : null; thumbUrl.set(kind, url); return url;
    })().catch((e) => { console.warn('[case3d] 썸네일 실패', e); thumbUrl.set(kind, null); return null; });
    thumbs.set(kind, p);
  }
  return p;
}

// ───────────────────────────── 개봉 무대 (등장 → 열쇠 삽입·회전 → 뚜껑 개방 + 등급색 발광) ─────────────────────────────
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const seg = (t: number, a: number, b: number): number => clamp01((t - a) / (b - a));
const easeOut = (p: number): number => 1 - Math.pow(1 - p, 3);
const easeInOut = (p: number): number => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
const backOut = (p: number): number => { const c = 1.6; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); };
/** 단계 시각(초) — quick = 다중 개봉 2번째 이후/모션 감소 */
const TL = { full: { drop: 0.55, keyIn: 1.15, turn: 1.55, keyOut: 1.75, open: 2.35 }, quick: { drop: 0.2, keyIn: 0.4, turn: 0.55, keyOut: 0.62, open: 0.85 } };

export class CaseStage {
  readonly el: HTMLDivElement;
  private r: THREE.WebGLRenderer | null = null;
  private scene!: THREE.Scene; private spot!: THREE.SpotLight; private inner!: THREE.PointLight;
  private readonly cam = new THREE.PerspectiveCamera(30, 2, 0.05, 30);
  private rigs = new Map<CaseKind, CaseRig>(); private cur: CaseRig | null = null;
  private glow: THREE.Sprite | null = null; private sparks: THREE.Points | null = null; private sparkV: Float32Array | null = null;
  private raf = 0; private t0 = 0; private tl = TL.full; private tier = new THREE.Color(); private done: (() => void) | null = null; private fired = false;
  private w = 0; private h = 0; private dead = false;

  constructor() { this.el = document.createElement('div'); this.el.className = 'co-3d'; }

  /** WebGL 준비 (불가 시 false → 호출측 CSS 폴백) */
  init(): boolean {
    if (this.r) return true; if (this.dead) return false;
    try { this.r = makeRenderer(4, 4, false); } catch (e) { console.warn('[case3d] 개봉 무대 WebGL 불가 — CSS 폴백', e); return false; }
    ({ scene: this.scene, spot: this.spot, inner: this.inner } = stageScene(this.r));
    this.el.appendChild(this.r.domElement);
    const gc = document.createElement('canvas'); gc.width = gc.height = 128; const g = gc.getContext('2d')!, rg = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    rg.addColorStop(0, 'rgba(255,255,255,1)'); rg.addColorStop(0.35, 'rgba(255,255,255,.45)'); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.fillRect(0, 0, 128, 128);
    const tex = new THREE.CanvasTexture(gc);
    this.glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.glow.position.set(0, 0.5, -0.08); this.scene.add(this.glow);
    const N = 90, pos = new Float32Array(N * 3); this.sparkV = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.sparks = new THREE.Points(geo, new THREE.PointsMaterial({ map: tex, size: 0.06, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.scene.add(this.sparks);
    return true;
  }

  /** 상자 1개 개봉 연출 재생. onOpened = 뚜껑이 다 열린 순간(→ 룰렛 시작) */
  async play(kind: CaseKind, tierColor: string, quick: boolean, onOpened: () => void): Promise<void> {
    if (!this.init()) { onOpened(); return; }
    let rg = this.rigs.get(kind);
    if (!rg) { rg = await createCaseRig(kind); this.rigs.set(kind, rg); }
    if (this.dead) return; // 모델 로드 중 모달이 닫힘
    if (this.cur !== rg) { this.cur?.root.removeFromParent(); this.scene.add(rg.root); this.cur = rg; }
    this.tier.set(tierColor); this.tl = quick ? TL.quick : TL.full; this.done = onOpened; this.fired = false;
    (this.glow!.material as THREE.SpriteMaterial).color.copy(this.tier); (this.sparks!.material as THREE.PointsMaterial).color.copy(this.tier).lerp(new THREE.Color(0xffffff), 0.35);
    this.inner.color.copy(this.tier);
    (rg.glow.material as THREE.MeshBasicMaterial).color.copy(this.tier);
    this.resetSparks(); this.t0 = performance.now(); this.start();
  }

  private resetSparks(): void {
    const p = this.sparks!.geometry.attributes.position as THREE.BufferAttribute, v = this.sparkV!;
    for (let i = 0; i < p.count; i++) {
      p.setXYZ(i, (Math.random() - 0.5) * 0.8, 0.45, (Math.random() - 0.5) * 0.35);
      v[i * 3] = (Math.random() - 0.5) * 0.5; v[i * 3 + 1] = 0.6 + Math.random() * 1.3; v[i * 3 + 2] = (Math.random() - 0.5) * 0.4;
    }
    p.needsUpdate = true;
  }

  private start(): void { if (!this.raf) this.raf = requestAnimationFrame(this.loop); }
  stop(): void { cancelAnimationFrame(this.raf); this.raf = 0; }
  dispose(): void {
    this.dead = true; this.stop(); this.el.remove();
    if (this.r) { this.scene.environment?.dispose(); this.r.dispose(); this.r.forceContextLoss(); this.r = null; }
  }

  private readonly loop = (now: number): void => {
    this.raf = 0;
    if (!this.el.isConnected || !this.r || !this.cur) return; // 화면에서 떼면 정지 (다음 play 때 재개)
    this.raf = requestAnimationFrame(this.loop);
    const r = this.r, w = this.el.clientWidth, h = this.el.clientHeight; if (w < 2 || h < 2) return;
    if (w !== this.w || h !== this.h) { this.w = w; this.h = h; r.setSize(w, h, false); this.cam.aspect = w / h; this.cam.updateProjectionMatrix(); }
    const t = (now - this.t0) / 1000, L = this.tl, rg = this.cur;
    // 1) 등장: 위에서 떨어지며 착지 (back-out), 3/4 각도로 회전
    const pd = seg(t, 0, L.drop);
    rg.root.position.y = (1 - backOut(pd)) * 0.7; rg.root.rotation.y = -0.75 + easeOut(pd) * 0.42 + Math.sin(t * 0.6) * 0.03;
    // 2) 열쇠: 오른쪽 앞에서 날아와 자물쇠에 꽂힘 → 90° 회전 → 사라짐
    const home = rg.lock.clone().add(new THREE.Vector3(0, 0, 0.11)), pk = easeInOut(seg(t, L.drop * 0.8, L.keyIn)), pt = easeInOut(seg(t, L.keyIn, L.turn));
    const from = home.clone().add(new THREE.Vector3(0.55, 0.35, 0.9));
    rg.key.position.lerpVectors(from, home, pk); rg.key.rotation.set(0, (1 - pk) * -0.9, pt * (Math.PI / 2));
    rg.key.visible = t < L.keyOut && pk > 0;
    // 해제 순간의 덜컹임
    const shake = seg(t, L.turn, L.keyOut); rg.root.rotation.z = Math.sin(shake * Math.PI * 4) * 0.02 * (1 - shake);
    // 3) 뚜껑 개방 + 등급색 발광/파티클
    const po = easeOut(seg(t, L.keyOut, L.open)); rg.lid.rotation.x = -po * 1.95;
    const light = po * (0.85 + 0.15 * Math.sin(t * 7));
    this.inner.intensity = light * 5; (this.glow!.material as THREE.SpriteMaterial).opacity = light * 0.55; this.glow!.scale.set(0.6 + po * 0.9, 0.4 + po * 0.7, 1);
    (rg.glow.material as THREE.MeshBasicMaterial).opacity = po * 0.55;
    this.spot.intensity = 26 - po * 8; this.scene.environmentIntensity = 0.55 - po * 0.15;
    const sm = this.sparks!.material as THREE.PointsMaterial;
    if (po > 0) {
      const p = this.sparks!.geometry.attributes.position as THREE.BufferAttribute, v = this.sparkV!, dt = 1 / 60, age = t - L.keyOut;
      for (let i = 0; i < p.count; i++) { p.setXYZ(i, p.getX(i) + v[i * 3] * dt, p.getY(i) + v[i * 3 + 1] * dt, p.getZ(i) + v[i * 3 + 2] * dt); v[i * 3 + 1] -= 0.6 * dt; }
      p.needsUpdate = true; sm.opacity = Math.max(0, 1 - age / 2.2);
    } else sm.opacity = 0;
    // 카메라: 천천히 다가가며 개방 순간 상자 안을 내려다봄
    const k = Math.max(1, 1.55 / this.cam.aspect); // 세로로 긴(모바일) 화면에선 상자 폭이 잘리지 않게 뒤로
    const hk = rg.height / 0.56; // 상자 높이에 비례해 프레이밍 (열쇠가 날아오는 위쪽 여유 포함)
    this.cam.position.set(0.25, (0.85 + po * 0.35) * k * hk, (2.75 - pd * 0.25 - po * 0.25) * k * hk); this.cam.lookAt(0, (0.3 + po * 0.1) * hk, 0);
    r.render(this.scene, this.cam);
    if (!this.fired && t >= L.open) { this.fired = true; this.done?.(); }
  };
}
