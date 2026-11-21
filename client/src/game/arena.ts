// =====================================================================
// 3D 전장 빌드 (킬 하우스 / 물류 창고 / 사격장) + AABB 충돌 월드
// 지오메트리 원본은 서버(server.js MAPS) → 'room:joined'.map 으로 전달된 MapData 를 그대로 사용.
// 메시 맵: 화면에는 원본 3D 모델(FBX/GLB)을, 충돌·피격은 서버가 준 복셀 박스('mesh')를 사용.
// =====================================================================
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MOVE, type MapId } from '../config/weapons';

/** [x0, y0, z0, x1, y1, z1, kind] */
export type MapBox = [number, number, number, number, number, number, string];
export interface SpawnPoint { x: number; y: number; z: number; yaw: number }
/** 모델 → 월드 변환 (client/scripts/gen-map-colliders.mjs 가 충돌 박스와 같은 값으로 생성) */
export interface MapModel { url: string; scale: number; rotY: number; offset: [number, number, number] }
export interface MapData {
  id: MapId; name: string;
  bounds: { x0: number; x1: number; z0: number; z1: number };
  wallH: number; boxes: MapBox[]; spawns: SpawnPoint[][]; marks: { z: number; label: string }[];
  model?: MapModel | null;
}
export interface Vec3Like { x: number; y: number; z: number }
export interface RayHit { t: number; axis: 0 | 1 | 2; sign: number }

// ───────────────────────────── 충돌 월드 ─────────────────────────────
export class World {
  readonly boxes: MapBox[];
  readonly bounds: MapData['bounds'];
  constructor(readonly map: MapData) { this.boxes = map.boxes; this.bounds = map.bounds; }

  /** 플레이어 AABB(반경 r, 높이 h)와 겹치는 첫 박스 */
  hit(p: Vec3Like, h: number, r: number = MOVE.radius): MapBox | null {
    const bs = this.boxes;
    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (p.x + r > b[0] && p.x - r < b[3] && p.z + r > b[2] && p.z - r < b[5] && p.y + h > b[1] && p.y < b[4] - 1e-4) return b;
    }
    return null;
  }
  blocked(p: Vec3Like, h: number): boolean { return this.hit(p, h) !== null; }

  private moveAxis(p: Vec3Like, v: Vec3Like, dt: number, h: number, ax: 'x' | 'z', grounded: boolean): void {
    const i = ax === 'x' ? 0 : 2, old = p[ax], r = MOVE.radius;
    p[ax] += v[ax] * dt;
    let b = this.hit(p, h);
    if (b && grounded) { // 낮은 턱 오르기
      const top = b[4], rise = top - p.y;
      if (rise > 0 && rise <= MOVE.stepHeight) { const oy = p.y; p.y = top; if (this.hit(p, h)) p.y = oy; else b = null; }
    }
    if (b) {
      p[ax] = v[ax] > 0 ? b[i] - r - 1e-3 : (b[i + 3] as number) + r + 1e-3;
      if (this.hit(p, h)) p[ax] = old;
      v[ax] = 0;
    }
  }
  /** 축 분리 이동 + 충돌 해소. p=발 위치, v=속도(충돌 축 0 처리). 반환: 접지 여부 */
  moveBody(p: Vec3Like, v: Vec3Like, dt: number, h: number, wasGrounded: boolean): boolean {
    this.moveAxis(p, v, dt, h, 'x', wasGrounded);
    this.moveAxis(p, v, dt, h, 'z', wasGrounded);
    let grounded = false;
    p.y += v.y * dt;
    if (p.y <= 0) { p.y = 0; if (v.y < 0) v.y = 0; grounded = true; }
    const b = this.hit(p, h);
    if (b) {
      if (v.y <= 0) { p.y = b[4]; v.y = 0; grounded = true; }
      else { p.y = b[1] - h - 1e-3; v.y = 0; }
    }
    return grounded;
  }

  /** 레이 vs 월드(바닥 포함) — server.js raycastWorld 와 동일 규약 */
  raycast(o: Vec3Like, d: Vec3Like, maxT: number): RayHit | null {
    let best: RayHit | null = null, bt = maxT;
    if (d.y < -1e-9) { const t = -o.y / d.y; if (t >= 0 && t < bt) { bt = t; best = { t, axis: 1, sign: 1 }; } }
    const bs = this.boxes;
    for (let n = 0; n < bs.length; n++) {
      const b = bs[n]; let t0 = 0, t1 = bt, axis = -1, sign = 0, miss = false;
      for (let i = 0; i < 3; i++) {
        const oi = i === 0 ? o.x : i === 1 ? o.y : o.z, di = i === 0 ? d.x : i === 1 ? d.y : d.z, mn = b[i] as number, mx = b[i + 3] as number;
        if (Math.abs(di) < 1e-9) { if (oi < mn || oi > mx) { miss = true; break; } continue; }
        let ta = (mn - oi) / di, tb = (mx - oi) / di, s = -1;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; s = 1; }
        if (ta > t0) { t0 = ta; axis = i; sign = s; }
        if (tb < t1) t1 = tb;
        if (t0 > t1) { miss = true; break; }
      }
      if (!miss && axis >= 0 && t0 < bt) { bt = t0; best = { t: t0, axis: axis as 0 | 1 | 2, sign }; }
    }
    return best;
  }
  losClear(a: Vec3Like, b: Vec3Like): boolean {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z, len = Math.hypot(dx, dy, dz);
    if (len < 1e-4) return true;
    return !this.raycast(a, { x: dx / len, y: dy / len, z: dz / len }, len - 0.05);
  }
}

// ───────────────────────────── 테마 ─────────────────────────────
interface Theme {
  sky: number; fog: [number, number]; floor: string; line: string; subLine: string; tile: number; accent: number;
  hemi: [number, number, number]; sun: [number, number];
  kinds: Record<string, { color: number; rough: number; metal: number; edge?: boolean; emissive?: number }>;
}
const THEMES: Record<MapId, Theme> = {
  // 킬 하우스 — 야외 훈련 시설: 흐린 주간 하늘 + 흙빛 바닥
  killhouse: {
    sky: 0x9fb4c8, fog: [70, 220], floor: '#5b5446', line: '#6b6352', subLine: '#544d40', tile: 4, accent: 0xffb547, hemi: [0xe8f1ff, 0x5a5040, 1.25], sun: [0xfff4e0, 1.6],
    kinds: { block: { color: 0x6b6352, rough: 0.9, metal: 0.05 }, cover: { color: 0x7a6a50, rough: 0.8, metal: 0.05 } },
  },
  // 물류 창고 — 실내 창고: 따뜻한 조명 + 콘크리트 바닥
  warehouse: {
    sky: 0x2a2f38, fog: [80, 240], floor: '#3a3d42', line: '#4a4e55', subLine: '#33363b', tile: 4, accent: 0xffb547, hemi: [0xfff0dc, 0x30343c, 1.35], sun: [0xfff0dc, 1.4],
    kinds: { block: { color: 0x5a5f68, rough: 0.85, metal: 0.1 }, cover: { color: 0x8a6a3a, rough: 0.8, metal: 0.05 } },
  },
  // RANGE — 사격장
  range: {
    sky: 0x11161c, fog: [120, 320], floor: '#1c232b', line: '#56616e', subLine: '#252d37', tile: 5, accent: 0xffd23f, hemi: [0xffffff, 0x1a1f26, 1.0], sun: [0xffffff, 1.0],
    kinds: { cover: { color: 0x3a4654, rough: 0.6, metal: 0.3, edge: true }, block: { color: 0x3a4654, rough: 0.6, metal: 0.3 } },
  },
};

function floorTexture(th: Theme): THREE.CanvasTexture {
  const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = th.floor; g.fillRect(0, 0, S, S);
  g.strokeStyle = th.subLine; g.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const p = (i * S) / 5; g.beginPath(); g.moveTo(p, 0); g.lineTo(p, S); g.moveTo(0, p); g.lineTo(S, p); g.stroke(); }
  g.strokeStyle = th.line; g.lineWidth = 3; g.globalAlpha = 0.85; g.strokeRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
export function textSprite(text: string, color = '#ffffff', scale = 1, bg: string | null = null): THREE.Sprite {
  const c = document.createElement('canvas'), g = c.getContext('2d')!, font = 'bold 44px system-ui, sans-serif';
  g.font = font; const w = Math.ceil(g.measureText(text).width) + 24;
  c.width = w; c.height = 64;
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, w, 64); }
  g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = 'rgba(0,0,0,0.75)'; g.strokeText(text, w / 2, 34);
  g.fillStyle = color; g.fillText(text, w / 2, 34);
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
  sp.scale.set((w / 64) * 0.5 * scale, 0.5 * scale, 1);
  return sp;
}

// ───────────────────────────── 메시 맵 모델 ─────────────────────────────
// 파싱 결과를 URL 별로 캐시 → 같은 맵 재입장 시 재다운로드·재파싱 없이 clone(지오메트리·재질 공유)
const modelCache = new Map<string, Promise<THREE.Object3D>>();
function prepareModel(root: THREE.Object3D): THREE.Object3D {
  const strip: THREE.Object3D[] = [];
  root.traverse((o) => {
    if ((o as THREE.Light).isLight || (o as THREE.Camera).isCamera) { strip.push(o); return; } // 원본 내장 조명/카메라 제거 → 테마 조명만 사용
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.receiveShadow = true;
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      const mm = mat as THREE.MeshStandardMaterial;
      if (mm.map) mm.map.colorSpace = THREE.SRGBColorSpace;
      if ((mat as THREE.MeshPhongMaterial).isMeshPhongMaterial) (mat as THREE.MeshPhongMaterial).shininess = Math.min((mat as THREE.MeshPhongMaterial).shininess, 12); // FBX 기본 광택 과다 → 플라스틱 느낌 완화
      mat.side = THREE.FrontSide;
    }
  });
  for (const o of strip) o.removeFromParent();
  return root;
}
function loadMapModel(url: string): Promise<THREE.Object3D> {
  let p = modelCache.get(url);
  if (!p) {
    const full = (import.meta.env?.BASE_URL ?? '/') + url;
    p = (url.endsWith('.fbx') ? new FBXLoader().loadAsync(full) : new GLTFLoader().loadAsync(full).then((g) => g.scene)).then(prepareModel);
    p.catch(() => modelCache.delete(url)); // 실패 시 다음 입장에서 재시도
    modelCache.set(url, p);
  }
  return p;
}

// ───────────────────────────── 빌드 ─────────────────────────────
export interface ArenaBuild {
  id: MapId; map: MapData; world: World; group: THREE.Group; sun: THREE.DirectionalLight; background: THREE.Color; fog: THREE.Fog;
  setShadows(mode: 'off' | 'low' | 'high'): void;
  dispose(): void;
}

export function buildArena(map: MapData): ArenaBuild {
  const th = THEMES[map.id] ?? THEMES.warehouse, group = new THREE.Group(); group.name = `arena:${map.id}`;
  const { x0, x1, z0, z1 } = map.bounds, sx = x1 - x0, sz = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const disposables: { dispose(): void }[] = [];
  const track = <T extends { dispose(): void }>(o: T): T => { disposables.push(o); return o; };

  // 바닥
  const ftex = track(floorTexture(th)); ftex.repeat.set(sx / th.tile, sz / th.tile);
  const floor = new THREE.Mesh(track(new THREE.PlaneGeometry(sx, sz)), track(new THREE.MeshStandardMaterial({ map: ftex, roughness: 0.9, metalness: 0.05 })));
  // 메시 맵은 모델 자체 바닥이 y=0 → 절차적 바닥은 살짝 아래에 두어 모델 바닥의 빈틈만 메움(z-파이팅 방지)
  floor.rotation.x = -Math.PI / 2; floor.position.set(cx, map.model ? -0.03 : 0, cz); floor.receiveShadow = true; group.add(floor);

  // 박스
  const unit = track(new THREE.BoxGeometry(1, 1, 1)), edges = track(new THREE.EdgesGeometry(unit));
  const edgeMat = track(new THREE.LineBasicMaterial({ color: th.accent, transparent: true, opacity: 0.55 }));
  const boundMat = track(new THREE.MeshStandardMaterial({ color: th.accent, transparent: true, opacity: 0.08, roughness: 1, side: THREE.DoubleSide, depthWrite: false }));
  const mats = new Map<string, THREE.MeshStandardMaterial>();
  const matFor = (kind: string): THREE.MeshStandardMaterial => {
    let m = mats.get(kind);
    if (!m) {
      const k = th.kinds[kind] ?? th.kinds.block;
      m = track(new THREE.MeshStandardMaterial({ color: k.color, roughness: k.rough, metalness: k.metal, emissive: k.emissive ?? 0x000000, emissiveIntensity: k.emissive ? 1 : 0 }));
      mats.set(kind, m);
    }
    return m;
  };
  const shadowMeshes: THREE.Mesh[] = [floor];
  for (const b of map.boxes) {
    const [bx0, by0, bz0, bx1, by1, bz1, kind] = b, w = bx1 - bx0, h = by1 - by0, d = bz1 - bz0;
    if (kind === 'mesh') continue; // 모델 충돌용 복셀 박스 — 화면에는 원본 모델을 그림
    if (kind === 'bound') {
      const m = new THREE.Mesh(unit, boundMat); m.scale.set(w, h, d); m.position.set(bx0 + w / 2, by0 + h / 2, bz0 + d / 2); group.add(m);
      continue;
    }
    const m = new THREE.Mesh(unit, matFor(kind)); m.scale.set(w, h, d); m.position.set(bx0 + w / 2, by0 + h / 2, bz0 + d / 2);
    m.castShadow = true; m.receiveShadow = true; group.add(m); shadowMeshes.push(m);
    if ((th.kinds[kind] ?? th.kinds.block).edge) { const l = new THREE.LineSegments(edges, edgeMat); l.scale.copy(m.scale).multiplyScalar(1.002); l.position.copy(m.position); group.add(l); }
  }
  // 경계 상단 라인
  const rim = new THREE.LineSegments(edges, edgeMat); rim.scale.set(sx, map.wallH, sz); rim.position.set(cx, map.wallH / 2, cz); group.add(rim);

  // 스폰 표시 (팀 색 바닥 패드)
  map.spawns.forEach((list, team) => {
    if (!list.length) return;
    const mat = track(new THREE.MeshBasicMaterial({ color: team === 0 ? 0x3b9cff : 0xff4655, transparent: true, opacity: 0.18, depthWrite: false }));
    const geo = track(new THREE.CircleGeometry(0.9, 24));
    for (const s of list) { const p = new THREE.Mesh(geo, mat); p.rotation.x = -Math.PI / 2; p.position.set(s.x, 0.02, s.z); group.add(p); }
  });

  // 사격장: 거리 표시선(5/10/20/30/50/70/100/150m) + 라벨
  if (map.marks.length) {
    const lineMat = track(new THREE.MeshBasicMaterial({ color: th.accent, transparent: true, opacity: 0.9 }));
    const lineGeo = track(new THREE.PlaneGeometry(sx - 1, 0.18));
    for (const mk of map.marks) {
      const l = new THREE.Mesh(lineGeo, lineMat); l.rotation.x = -Math.PI / 2; l.position.set(cx, 0.03, mk.z); group.add(l);
      for (const side of [x0 + 1.6, x1 - 1.6]) {
        const post = new THREE.Mesh(unit, matFor('cover')); post.scale.set(0.15, 2.4, 0.15); post.position.set(side, 1.2, mk.z); group.add(post);
        const sp = textSprite(mk.label, '#ffd23f', 2.2, 'rgba(0,0,0,0.55)'); sp.position.set(side, 2.9, mk.z); group.add(sp);
        disposables.push(sp.material.map!, sp.material);
      }
    }
    // 사선(射線)
    const fl = new THREE.Mesh(track(new THREE.PlaneGeometry(sx - 1, 0.3)), track(new THREE.MeshBasicMaterial({ color: 0xff4655 })));
    fl.rotation.x = -Math.PI / 2; fl.position.set(cx, 0.03, (map.spawns[0]?.[0]?.z ?? 3) - 1.2); group.add(fl);
  }

  // 조명
  const hemi = new THREE.HemisphereLight(th.hemi[0], th.hemi[1], th.hemi[2]); group.add(hemi);
  const sun = new THREE.DirectionalLight(th.sun[0], th.sun[1]);
  const span = Math.max(sx, sz) / 2 + 6;
  sun.position.set(cx + span * 0.5, span * 1.2 + 20, cz + span * 0.35); sun.target.position.set(cx, 0, cz);
  sun.shadow.camera.left = -span; sun.shadow.camera.right = span; sun.shadow.camera.top = span; sun.shadow.camera.bottom = -span;
  sun.shadow.camera.near = 1; sun.shadow.camera.far = span * 4 + 60; sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03;
  group.add(sun, sun.target);

  // 메시 맵 모델: 텍스처·머티리얼이 어둡지 않도록 보조 환경광
  if (map.model) group.add(new THREE.AmbientLight(0xffffff, 0.35));

  const modelMeshes: THREE.Mesh[] = [];
  let shadowMode: 'off' | 'low' | 'high' = 'low', disposed = false;
  const setShadows = (mode: 'off' | 'low' | 'high'): void => {
    shadowMode = mode;
    sun.castShadow = mode !== 'off';
    const size = 1024; // 그림자 맵 해상도 상한 1024 (high/low 동일 — 캐스터 수·필터만 차이)
    if (sun.shadow.mapSize.x !== size) { sun.shadow.mapSize.set(size, size); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    for (const m of shadowMeshes) { m.castShadow = mode !== 'off' && m !== floor; m.receiveShadow = mode !== 'off'; }
    // 고폴리 모델은 'high'에서만 그림자 투사(그림자 패스 비용), 수신은 항상
    for (const m of modelMeshes) { m.castShadow = mode === 'high'; m.receiveShadow = mode !== 'off'; }
  };
  setShadows('low');

  if (map.model) {
    const mm = map.model;
    loadMapModel(mm.url).then((src) => {
      if (disposed) return;
      const holder = new THREE.Group(); holder.name = `model:${map.id}`;
      holder.position.fromArray(mm.offset); holder.rotation.y = mm.rotY; holder.scale.setScalar(mm.scale);
      holder.add(src.clone());
      holder.traverse((o) => { if ((o as THREE.Mesh).isMesh) modelMeshes.push(o as THREE.Mesh); });
      group.add(holder); setShadows(shadowMode);
    }).catch((e) => console.error(`[map] ${mm.url} 로드 실패`, e));
  }

  return {
    id: map.id, map, world: new World(map), group, sun, background: new THREE.Color(th.sky), fog: new THREE.Fog(th.sky, th.fog[0], th.fog[1]), setShadows,
    dispose() { disposed = true; group.removeFromParent(); for (const d of disposables) d.dispose(); sun.shadow.map?.dispose(); }, // 모델 지오메트리·재질은 캐시 공유 → 해제하지 않음
  };
}