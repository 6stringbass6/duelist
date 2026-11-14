// =====================================================================
// Socket.io 클라이언트: 방/매칭 · 스냅샷 보간 · 원격 캐릭터/무기(스킨) 렌더 · 킬로그/점수 동기화
// 이벤트·페이로드는 server/server.js 와 1:1 대응.
// =====================================================================
import * as THREE from 'three';
import { io, type Socket } from 'socket.io-client';
import { F, RULES, SLOT_KEYS, WEAPONS, isGun, type GameMode, type HitZone, type Loadout, type MapId, type WeaponId } from '../config/weapons';
import { DEFAULT_SKIN, getSkin, type SkinDef, type SkinMaterial } from '../config/skins';
import { SERVER_URL, socketAuthPayload } from '../services/supabase';
import { buildArena, textSprite, type ArenaBuild, type MapData, type World } from './arena';

// ───────────────────────────── 타입 ─────────────────────────────
export type Phase = 'lobby' | 'buy' | 'live' | 'roundEnd' | 'ended';
export interface PlayerInfo {
  id: number; name: string; bot: boolean; team: number; tier: number; rp: number; title: string | null;
  skins: Record<string, string>; loadout: Loadout; career: { kd: number; hs: number; wr: number; matches?: number };
  k: number; d: number; a: number; dummy: boolean;
}
export interface RoomState {
  id: string; code: string | null; mode: GameMode; teamSize: number; mapId: MapId; isPrivate: boolean; hostId: number;
  phase: Phase; endsAt: number; round: number; score: [number, number]; fillBots: boolean; botLevel: number; target: number; players: PlayerInfo[];
}
export interface AmmoState { secondary: number; primary: number; charges: number; reloadUntil: number; reloadKey: 'secondary' | 'primary' | null }
export interface KillFeedItem { at: number; killer: string; victim: string; killerTeam: number; victimTeam: number; weapon: WeaponId; hs: boolean; assists: string[]; mine: boolean; suicide: boolean }
export interface Ack { ok: boolean; error?: string; code?: string; applied?: boolean }
/** [id, x, y, z, yaw, spawnSeq] */
export type SpawnTuple = [number, number, number, number, number, number];
export interface MatchEnd { winner: number; score: [number, number]; players: { id: number; k: number; d: number; a: number; hs: number; dmg: number }[] }
export interface MatchReward { result: 'win' | 'loss' | 'draw' | 'left'; rp_delta: number; credits: number; saved: boolean; rank_points?: number; credits_earned?: number; unlocked?: string[] }
export interface HelloInfo { serverTime: number; guest: boolean; name: string; rp: number; tier: number; tierLabel: string; loadout: Loadout }
interface Snap { t: number; x: number; y: number; z: number; yaw: number; pitch: number; f: number; hp: number; slot: number }

export interface NetEvents {
  connect: () => void; disconnect: (reason: string) => void; error: (code: string) => void;
  hello: (h: HelloInfo) => void;
  joined: (room: RoomState) => void; state: (room: RoomState) => void; roster: (room: RoomState) => void; closed: (reason: string) => void;
  phase: (p: { phase: Phase; endsAt: number; round: number; score: [number, number]; winner?: number }) => void;
  spawn: (x: number, y: number, z: number, yaw: number, seq: number) => void;   // 내 스폰
  correct: (x: number, y: number, z: number, seq: number) => void;
  ammo: (a: AmmoState) => void;
  hit: (h: { v: number; d: number; z: HitZone; k: boolean }) => void;
  hurt: (h: { a: number; d: number; hp: number; from: [number, number] }) => void;
  flash: (f: { dur: number; by: number; full: boolean }) => void;
  kill: (k: KillFeedItem, raw: { k: number; v: number }) => void;
  shot: (s: { id: number; w: WeaponId; o: [number, number, number]; alt: boolean }) => void;
  melee: (m: { id: number; w: WeaponId; hit: number }) => void;
  reload: (id: number) => void;
  explode: (e: { type: 'grenade' | 'flash'; p: [number, number, number] }) => void;
  skill: (s: { id: number; k: 'q' | 'e'; cd: number; until: number }) => void;
  loadout: (id: number, l: Loadout) => void;
  rangeConfig: (moving: boolean) => void;
  matchEnd: (m: MatchEnd) => void; reward: (r: MatchReward) => void;
}

// ───────────────────────────── 스킨 재질 / 무기 메시 ─────────────────────────────
interface SkinMats { base: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial }
const matCache = new Map<string, SkinMats>();
const animated: { mat: THREE.MeshStandardMaterial; mode: 'pulse' | 'flow'; speed: number; base: number }[] = [];

function patternTexture(m: SkinMaterial): THREE.CanvasTexture | null {
  if (m.pattern === 'solid') return null;
  const S = 128, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!, hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');
  g.fillStyle = hex(m.baseColor); g.fillRect(0, 0, S, S); g.fillStyle = g.strokeStyle = hex(m.patternColor);
  const rnd = (() => { let s = (m.baseColor ^ m.patternColor) >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
  switch (m.pattern) {
    case 'gradient': { const gr = g.createLinearGradient(0, 0, S, S); gr.addColorStop(0, hex(m.baseColor)); gr.addColorStop(1, hex(m.patternColor)); g.fillStyle = gr; g.fillRect(0, 0, S, S); break; }
    case 'stripes': g.lineWidth = 10; for (let i = -S; i < S * 2; i += 28) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S, S); g.stroke(); } break;
    case 'carbon': for (let y = 0; y < S; y += 8) for (let x = 0; x < S; x += 8) if (((x + y) / 8) % 2 === 0) g.fillRect(x, y, 8, 8); break;
    case 'hex': g.lineWidth = 2; for (let y = 0; y < S + 20; y += 20) for (let x = 0; x < S + 24; x += 24) { const ox = (y / 20) % 2 ? 12 : 0; g.beginPath(); for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k; g.lineTo(x + ox + Math.cos(a) * 10, y + Math.sin(a) * 10); } g.closePath(); g.stroke(); } break;
    case 'wave': g.lineWidth = 3; for (let y = 8; y < S; y += 16) { g.beginPath(); for (let x = 0; x <= S; x += 4) g.lineTo(x, y + Math.sin((x / S) * Math.PI * 4) * 5); g.stroke(); } break;
    case 'circuit': g.lineWidth = 2; for (let i = 0; i < 14; i++) { let x = rnd() * S, y = rnd() * S; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 4; k++) { if (rnd() < 0.5) x += (rnd() - 0.5) * 60; else y += (rnd() - 0.5) * 60; g.lineTo(x, y); } g.stroke(); g.fillRect(x - 3, y - 3, 6, 6); } break;
    case 'petals': for (let i = 0; i < 26; i++) { g.save(); g.translate(rnd() * S, rnd() * S); g.rotate(rnd() * 6.28); g.beginPath(); g.ellipse(0, 0, 7, 3.5, 0, 0, 6.28); g.fill(); g.restore(); } break;
    case 'cracks': g.lineWidth = 2.5; for (let i = 0; i < 9; i++) { let x = rnd() * S, y = rnd() * S; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (rnd() - 0.5) * 40; y += (rnd() - 0.5) * 40; g.lineTo(x, y); } g.stroke(); } break;
    case 'stars': for (let i = 0; i < 70; i++) { const r = rnd() * 1.8 + 0.4; g.globalAlpha = 0.4 + rnd() * 0.6; g.beginPath(); g.arc(rnd() * S, rnd() * S, r, 0, 6.28); g.fill(); } break;
  }
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(Math.max(1, m.patternScale / 4), 1); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
/** 스킨 → 무기 재질(본체/포인트). 스킨별 캐시 공유. */
export function skinMaterials(skinId: string | null | undefined): SkinMats {
  const key = skinId && getSkin(skinId) ? skinId : 'default';
  let mats = matCache.get(key);
  if (mats) return mats;
  const s: Pick<SkinDef, 'material' | 'emissive'> = getSkin(skinId) ?? DEFAULT_SKIN, m = s.material, e = s.emissive, tex = patternTexture(m);
  const base = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : m.baseColor, map: tex, metalness: m.metalness, roughness: m.roughness,
    emissive: e.color, emissiveMap: tex && e.mode !== 'none' ? tex : null, emissiveIntensity: e.mode === 'none' ? 0 : e.intensity * 0.35 });
  const accent = new THREE.MeshStandardMaterial({ color: m.accentColor, metalness: Math.min(1, m.metalness + 0.2), roughness: Math.max(0.05, m.roughness - 0.1),
    emissive: e.color, emissiveIntensity: e.mode === 'none' ? 0 : e.intensity });
  if (e.mode === 'pulse' || e.mode === 'flow') animated.push({ mat: accent, mode: e.mode, speed: e.speed ?? 0.5, base: e.intensity }, { mat: base, mode: e.mode, speed: e.speed ?? 0.5, base: e.intensity * 0.35 });
  mats = { base, accent }; matCache.set(key, mats);
  return mats;
}
/** 발광 스킨 애니메이션 (프레임마다 1회) */
export function tickSkinMaterials(timeSec: number): void {
  for (const a of animated) {
    if (a.mode === 'pulse') a.mat.emissiveIntensity = a.base * (0.55 + 0.45 * Math.sin(timeSec * a.speed * Math.PI * 2));
    else { a.mat.emissiveIntensity = a.base * (0.8 + 0.2 * Math.sin(timeSec * 3)); if (a.mat.emissiveMap) a.mat.emissiveMap.offset.x = (timeSec * a.speed * 0.25) % 1; }
  }
}

interface GunShape { len: number; h: number; barrel: number; mag: number; stock: number; scope?: boolean; drum?: boolean }
const GUN_SHAPES: Record<string, GunShape> = {
  classic: { len: 0.2, h: 0.055, barrel: 0.02, mag: 0.1, stock: 0 }, shorty: { len: 0.22, h: 0.07, barrel: 0.1, mag: 0, stock: 0 },
  frenzy: { len: 0.22, h: 0.06, barrel: 0.03, mag: 0.16, stock: 0 }, ghost: { len: 0.21, h: 0.055, barrel: 0.14, mag: 0.1, stock: 0 },
  sheriff: { len: 0.2, h: 0.07, barrel: 0.14, mag: 0, stock: 0, drum: true },
  vandal: { len: 0.5, h: 0.08, barrel: 0.22, mag: 0.2, stock: 0.24 }, phantom: { len: 0.52, h: 0.075, barrel: 0.26, mag: 0.18, stock: 0.22 },
  marshal: { len: 0.6, h: 0.065, barrel: 0.4, mag: 0.08, stock: 0.3, scope: true }, odin: { len: 0.62, h: 0.11, barrel: 0.3, mag: 0.16, stock: 0.22, drum: true },
};
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const part = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => {
  const m = new THREE.Mesh(UNIT_BOX, mat); m.scale.set(w, h, d); m.position.set(x, y, z); return m;
};
/** 프로시저럴 무기 메시 (전방 = -Z). userData.muzzle = 총구 Object3D */
export function createWeaponMesh(weaponId: WeaponId, skinId?: string | null): THREE.Group {
  const g = new THREE.Group(), { base, accent } = skinMaterials(skinId), variant = getSkin(skinId)?.model ?? 'default';
  const muzzle = new THREE.Object3D(); g.add(muzzle); g.userData.muzzle = muzzle; g.userData.weaponId = weaponId;
  const fat = variant === 'heavy' ? 1.2 : variant === 'sleek' ? 0.88 : 1;
  const shape = GUN_SHAPES[weaponId];
  if (shape) {
    const { len, h, barrel, mag, stock } = shape, w = 0.05 * fat;
    g.add(part(base, w, h, len, 0, 0, -len / 2));                                          // 몸통
    g.add(part(accent, w * 0.5, h * 0.45, barrel, 0, h * 0.12, -len - barrel / 2));        // 총열
    g.add(part(accent, w * 1.04, h * 0.18, len * 0.7, 0, h * 0.45, -len * 0.5));           // 상부 레일
    g.add(part(base, w * 0.8, 0.1, 0.045, 0, -h / 2 - 0.045, -0.03).rotateX(0.25));        // 손잡이
    if (mag) g.add(part(accent, w * 0.75, mag, 0.05, 0, -h / 2 - mag / 2, -len * 0.45).rotateX(-0.12));
    if (stock) g.add(part(base, w * 0.8, h * 0.9, stock, 0, -h * 0.1, stock / 2));
    if (shape.drum) g.add(part(accent, w * 1.5, h * 1.1, 0.07, 0, -h * 0.35, -len * 0.5));
    if (shape.scope) { g.add(part(accent, 0.04, 0.04, 0.24, 0, h / 2 + 0.045, -len * 0.4)); g.add(part(base, 0.02, 0.03, 0.03, 0, h / 2 + 0.015, -len * 0.4)); }
    if (variant === 'angular') g.add(part(accent, w * 1.3, h * 0.25, len * 0.3, 0, -h * 0.3, -len * 0.75).rotateX(0.15));
    if (variant === 'ornate') g.add(part(accent, w * 1.15, h * 1.05, 0.02, 0, 0, -len * 0.25), part(accent, w * 1.15, h * 1.05, 0.02, 0, 0, -len * 0.7));
    muzzle.position.set(0, h * 0.12, -len - barrel);
  } else if (weaponId === 'dagger' || weaponId === 'sword') {
    const L = weaponId === 'sword' ? 0.85 : 0.24, bw = weaponId === 'sword' ? 0.07 : 0.045;
    g.add(part(base, 0.035, 0.035, 0.13, 0, 0, 0.05));
    g.add(part(accent, weaponId === 'sword' ? 0.2 : 0.09, 0.025, 0.025, 0, 0, -0.02));
    g.add(part(accent, 0.012 * fat, bw, L, 0, 0, -0.03 - L / 2));
    g.add(part(base, 0.016, bw * 0.4, L * 0.9, 0, 0, -0.03 - L / 2));
    muzzle.position.set(0, 0, -L);
  } else if (weaponId === 'fists') {
    g.add(part(base, 0.09, 0.09, 0.11, 0, 0, -0.05), part(accent, 0.095, 0.03, 0.04, 0, 0.02, -0.09));
    muzzle.position.set(0, 0, -0.12);
  } else {
    const flash = weaponId === 'flash';
    const body = new THREE.Mesh(flash ? new THREE.CylinderGeometry(0.035, 0.035, 0.13, 10) : new THREE.SphereGeometry(0.06, 12, 10),
      new THREE.MeshStandardMaterial({ color: flash ? 0xdfe7ef : 0x3f5a3a, roughness: 0.5, metalness: 0.4, emissive: flash ? 0x88ccff : 0x000000, emissiveIntensity: flash ? 0.4 : 0 }));
    g.add(body, part(accent, 0.03, 0.03, 0.03, 0, flash ? 0.08 : 0.065, 0));
  }
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  return g;
}

// ───────────────────────────── 원격 캐릭터 ─────────────────────────────
const COLOR_ALLY = 0x3b9cff, COLOR_ENEMY = 0xff4655, COLOR_DUMMY = 0xffa23a;
const HEAD_GEO = new THREE.SphereGeometry(0.23, 16, 12);
class RemoteEntity {
  readonly group = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly hand = new THREE.Group();
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private tag: THREE.Sprite | null = null;
  private weapon: THREE.Group | null = null;
  private weaponKey = '';
  readonly buf: Snap[] = [];
  x = 0; y = 0; z = 0; yaw = 0; pitch = 0; flags = 0; hp = 0; slot = 3; alive = false;
  private kick = 0;

  constructor(public info: PlayerInfo, ally: boolean) {
    const color = info.dummy ? COLOR_DUMMY : ally ? COLOR_ALLY : COLOR_ENEMY;
    this.bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, emissive: color, emissiveIntensity: 0.18 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2028, roughness: 0.7, metalness: 0.2 });
    const g = this.group;
    g.add(part(dark, 0.2, 0.72, 0.24, -0.14, 0.36, 0), part(dark, 0.2, 0.72, 0.24, 0.14, 0.36, 0));       // 다리
    g.add(part(this.bodyMat, 0.56, 0.66, 0.32, 0, 1.05, 0));                                               // 몸통
    this.upper.position.set(0, 1.38, 0);
    const head = new THREE.Mesh(HEAD_GEO, this.bodyMat); head.position.set(0, 0.24, 0);
    this.upper.add(head, part(dark, 0.3, 0.1, 0.05, 0, 0.26, -0.21));                                      // 머리 + 바이저
    this.upper.add(part(dark, 0.13, 0.13, 0.5, 0.3, -0.12, -0.2), part(dark, 0.13, 0.13, 0.45, -0.24, -0.14, -0.22).rotateY(-0.5)); // 팔
    this.hand.position.set(0.24, -0.1, -0.42); this.upper.add(this.hand);
    g.add(this.upper);
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.userData.entityId = info.id; } });
    this.setTag(ally);
    g.visible = false;
  }
  private setTag(ally: boolean): void {
    if (this.tag) { this.tag.material.map?.dispose(); this.tag.material.dispose(); this.tag.removeFromParent(); }
    if (this.info.dummy) return;
    this.tag = textSprite(this.info.name, ally ? '#8cc8ff' : '#ff8c96', 0.8); this.tag.position.set(0, 2.15, 0); this.group.add(this.tag);
  }
  setInfo(info: PlayerInfo, ally: boolean): void {
    const renamed = info.name !== this.info.name; this.info = info;
    const color = info.dummy ? COLOR_DUMMY : ally ? COLOR_ALLY : COLOR_ENEMY; this.bodyMat.color.setHex(color); this.bodyMat.emissive.setHex(color);
    if (renamed) this.setTag(ally);
    this.weaponKey = '';
  }
  push(s: Snap): void { this.buf.push(s); if (this.buf.length > 40) this.buf.shift(); }
  onShot(): void { this.kick = 1; }
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    const m = this.weapon?.userData.muzzle as THREE.Object3D | undefined;
    return m && this.group.visible ? m.getWorldPosition(out) : out.set(this.x, this.y + 1.45, this.z);
  }
  /** renderT 시점으로 보간 후 메시 갱신 */
  update(renderT: number, dt: number): void {
    const b = this.buf; if (!b.length) return;
    let i = b.length - 1; while (i > 0 && b[i].t > renderT) i--;
    const a = b[i], n = b[Math.min(i + 1, b.length - 1)], k = n.t > a.t ? Math.min(1.25, Math.max(0, (renderT - a.t) / (n.t - a.t))) : 0;
    const far = Math.abs(n.x - a.x) + Math.abs(n.z - a.z) > 8; // 텔레포트(스폰) → 스냅
    this.x = far ? n.x : a.x + (n.x - a.x) * k; this.y = far ? n.y : a.y + (n.y - a.y) * k; this.z = far ? n.z : a.z + (n.z - a.z) * k;
    this.yaw = a.yaw + shortAngle(n.yaw - a.yaw) * Math.min(1, k); this.pitch = a.pitch + (n.pitch - a.pitch) * Math.min(1, k);
    const s = k >= 0.5 ? n : a; this.flags = s.f; this.hp = s.hp; this.slot = s.slot; this.alive = !!(s.f & F.ALIVE);
    const g = this.group; g.visible = this.alive; if (!this.alive) return;
    g.position.set(this.x, this.y, this.z); g.rotation.y = this.yaw;
    const low = this.flags & (F.CROUCH | F.SLIDE);
    g.scale.y += ((low ? 0.64 : 1) - g.scale.y) * Math.min(1, dt * 14);
    this.kick = Math.max(0, this.kick - dt * 9);
    this.upper.rotation.x = this.pitch + this.kick * 0.06; this.hand.position.z = -0.42 + this.kick * 0.05;
    this.bodyMat.transparent = !!(this.flags & F.PROT); this.bodyMat.opacity = this.flags & F.PROT ? 0.45 : 1;
    this.bodyMat.emissiveIntensity = this.flags & F.DASH ? 0.7 : 0.18;
    if (this.tag) this.tag.scale.y = 0.4 / g.scale.y;
    // 손에 든 무기 + 스킨
    const wid = this.info.loadout[SLOT_KEYS[(this.slot as 1 | 2 | 3 | 4)] ?? 'primary'] as WeaponId, skin = this.info.skins?.[wid] ?? '', key = wid + '|' + skin;
    if (key !== this.weaponKey) {
      this.weaponKey = key; this.weapon?.removeFromParent();
      this.weapon = createWeaponMesh(wid, skin); this.hand.add(this.weapon);
    }
  }
  dispose(): void {
    this.group.removeFromParent(); this.bodyMat.dispose();
    if (this.tag) { this.tag.material.map?.dispose(); this.tag.material.dispose(); }
  }
}
const shortAngle = (d: number): number => { d %= Math.PI * 2; return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d; };

// ───────────────────────────── GameClient ─────────────────────────────
type Handler = (...args: never[]) => void;
interface Fx { obj: THREE.Object3D; life: number; max: number; kind: 'tracer' | 'boom' | 'pop' }

export class GameClient {
  socket: Socket | null = null;
  connected = false;
  hello: HelloInfo | null = null;
  you = 0;
  room: RoomState | null = null;
  arena: ArenaBuild | null = null;
  readonly players = new Map<number, PlayerInfo>();
  readonly entities = new Map<number, RemoteEntity>();
  readonly killfeed: KillFeedItem[] = [];
  ammo: AmmoState = { secondary: 0, primary: 0, charges: 0, reloadUntil: 0, reloadKey: null };
  /** 내 엔티티의 최신 서버 상태 */
  self = { hp: 0, alive: false, flags: 0, slot: 3 };
  rangeMoving = false;
  pingMs = 0;
  particles: 'off' | 'low' | 'high' = 'low';
  private timeOffset = 0;
  private bestRtt = Infinity;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly projs = new Map<number, { mesh: THREE.Mesh; target: THREE.Vector3 }>();
  private readonly fx: Fx[] = [];
  private readonly tmp = new THREE.Vector3();

  constructor(readonly scene: THREE.Scene) {}

  // ── 이벤트
  on<K extends keyof NetEvents>(ev: K, fn: NetEvents[K]): () => void {
    let set = this.handlers.get(ev); if (!set) this.handlers.set(ev, (set = new Set()));
    set.add(fn as Handler); return () => set!.delete(fn as Handler);
  }
  private emit<K extends keyof NetEvents>(ev: K, ...args: Parameters<NetEvents[K]>): void {
    const set = this.handlers.get(ev); if (set) for (const fn of set) (fn as (...a: unknown[]) => void)(...args);
  }

  // ── 접근자
  get world(): World | null { return this.arena?.world ?? null; }
  get phase(): Phase { return this.room?.phase ?? 'lobby'; }
  get mode(): GameMode | null { return this.room?.mode ?? null; }
  get me(): PlayerInfo | null { return this.players.get(this.you) ?? null; }
  get myTeam(): number { return this.me?.team ?? 0; }
  get score(): [number, number] { return this.room?.score ?? [0, 0]; }
  serverNow(): number { return Date.now() + this.timeOffset; }
  /** 화면에 보이는 원격 엔티티의 서버 시각 (지연 보상용 `fire.t`) */
  renderTime(): number { return this.serverNow() - RULES.interpDelayMs; }
  phaseRemainingMs(): number { return this.room && this.room.endsAt ? Math.max(0, this.room.endsAt - this.serverNow()) : 0; }
  isAlly(id: number): boolean { return (this.players.get(id)?.team ?? -1) === this.myTeam; }
  /** 스코어보드용: 팀별 정렬된 플레이어 */
  scoreboard(): { allies: PlayerInfo[]; enemies: PlayerInfo[] } {
    const all = [...this.players.values()].filter((p) => !p.dummy).sort((a, b) => b.k - a.k || a.d - b.d), t = this.myTeam;
    return { allies: all.filter((p) => p.team === t), enemies: all.filter((p) => p.team !== t) };
  }

  // ── 연결
  async connect(): Promise<void> {
    if (this.socket) return;
    const auth = await socketAuthPayload();
    const s = (this.socket = io(SERVER_URL, { auth, transports: ['websocket', 'polling'], reconnectionAttempts: 8, timeout: 8000 }));
    this.bind(s);
    await new Promise<void>((resolve, reject) => {
      s.once('connect', () => resolve());
      s.once('connect_error', (e: Error) => reject(new Error(e.message)));
    });
  }
  disconnect(): void {
    if (this.syncTimer) clearInterval(this.syncTimer); this.syncTimer = null;
    this.socket?.disconnect(); this.socket = null; this.connected = false; this.clearRoom();
  }
  private syncTime(): void {
    this.socket?.emit('time:sync', Date.now(), (r: { c0: number; s: number }) => {
      const now = Date.now(), rtt = now - r.c0; this.pingMs = rtt;
      if (rtt <= this.bestRtt + 15) { this.bestRtt = Math.min(this.bestRtt, rtt); this.timeOffset = r.s + rtt / 2 - now; }
    });
  }
  private req(ev: string, data: object = {}): Promise<Ack> {
    return new Promise((resolve) => {
      if (!this.socket?.connected) return resolve({ ok: false, error: 'NOT_CONNECTED' });
      this.socket.timeout(6000).emit(ev, data, (err: Error | null, ack?: Ack) => resolve(err ? { ok: false, error: 'TIMEOUT' } : ack ?? { ok: true }));
    });
  }

  // ── 방 / 매칭 API
  queueJoin(mode: GameMode, teamSize = 1, map?: 'grid' | 'arena'): Promise<Ack> { return this.req('queue:join', { mode, teamSize, map }); }
  createRoom(o: { mode: 'classic' | 'tdm'; teamSize: number; map: 'grid' | 'arena'; fillBots: boolean; botLevel: number }): Promise<Ack> { return this.req('room:create', o); }
  joinRoom(code: string): Promise<Ack> { return this.req('room:join', { code }); }
  leaveRoom(): Promise<Ack> { const p = this.req('room:leave'); this.clearRoom(); return p; }
  setTeam(team: 0 | 1): Promise<Ack> { return this.req('room:team', { team }); }
  configRoom(o: Partial<{ mode: 'classic' | 'tdm'; map: 'grid' | 'arena'; teamSize: number; fillBots: boolean; botLevel: number }>): Promise<Ack> { return this.req('room:config', o); }
  startRoom(): Promise<Ack> { return this.req('room:start'); }
  setRangeMoving(moving: boolean): void { this.socket?.emit('range:config', { moving }); }
  setLoadout(l: Loadout): Promise<Ack> { return this.req('loadout:set', l); }
  refreshProfile(): void { this.socket?.emit('profile:refresh', {}); }

  // ── 인게임 송신
  sendInput(seq: number, p: THREE.Vector3, yaw: number, pitch: number, flags: number): void {
    this.socket?.volatile.emit('input', { s: seq, p: [r2(p.x), r2(p.y), r2(p.z)], yaw: r3(yaw), pitch: r3(pitch), f: flags });
  }
  fire(o: THREE.Vector3, yaw: number, pitch: number, alt: boolean): void {
    this.socket?.emit('fire', { t: Math.round(this.renderTime()), o: [r2(o.x), r2(o.y), r2(o.z)], yaw, pitch, alt });
  }
  switchWeapon(slot: 1 | 2 | 3 | 4): void { this.socket?.emit('weapon:switch', { slot }); }
  reload(): void { this.socket?.emit('reload', {}); }
  skill(k: 'q' | 'e'): void { this.socket?.emit('skill', { k }); }

  // ── 수신 바인딩
  private bind(s: Socket): void {
    s.on('connect', () => { this.connected = true; this.bestRtt = Infinity; this.syncTime(); if (!this.syncTimer) this.syncTimer = setInterval(() => this.syncTime(), 4000); this.emit('connect'); });
    s.on('disconnect', (reason: string) => { this.connected = false; this.clearRoom(); this.emit('disconnect', reason); });
    s.on('connect_error', (e: Error) => this.emit('error', e.message));
    s.on('kicked', (m: { reason: string }) => this.emit('error', m.reason));
    s.on('server:shutdown', () => this.emit('error', 'SERVER_SHUTDOWN'));
    s.on('hello', (h: HelloInfo) => { this.hello = h; this.timeOffset = h.serverTime - Date.now(); this.emit('hello', h); });

    s.on('room:joined', (m: { you: number; room: RoomState; map: MapData; serverTime: number; spawn: SpawnTuple | null }) => {
      this.clearRoom(); this.you = m.you; this.room = m.room; this.setMap(m.map); this.syncRoster(m.room.players);
      this.emit('joined', m.room); if (m.spawn) this.onSpawn(m.spawn);
    });
    s.on('room:state', (room: RoomState) => { this.room = room; this.syncRoster(room.players); this.emit('state', room); });
    s.on('room:map', (map: MapData) => this.setMap(map));
    s.on('room:closed', (m: { reason: string }) => { this.clearRoom(); this.emit('closed', m.reason); });
    const rosterChange = (m: { out?: number; id?: number; in?: PlayerInfo; host: number; spawn?: SpawnTuple | null }): void => {
      if (!this.room) return;
      const out = m.out || m.id || 0;
      if (out) { this.players.delete(out); this.entities.get(out)?.dispose(); this.entities.delete(out); }
      if (m.in) this.addPlayer(m.in);
      this.room.hostId = m.host; this.room.players = [...this.players.values()];
      if (m.spawn) this.onSpawn(m.spawn);
      this.emit('roster', this.room);
    };
    s.on('roster:add', rosterChange); s.on('roster:swap', rosterChange); s.on('roster:remove', rosterChange);

    s.on('phase', (p: { phase: Phase; endsAt: number; round: number; score: [number, number]; spawns?: SpawnTuple[]; winner?: number }) => {
      if (!this.room) return;
      this.room.phase = p.phase; this.room.endsAt = p.endsAt; this.room.round = p.round; this.room.score = p.score;
      if (p.phase === 'buy') this.clearEffects();
      if (p.spawns) for (const sp of p.spawns) this.onSpawn(sp);
      this.emit('phase', p);
    });
    s.on('spawn', (m: { s: SpawnTuple }) => this.onSpawn(m.s));
    s.on('pos:correct', (m: { p: [number, number, number]; s: number }) => this.emit('correct', m.p[0], m.p[1], m.p[2], m.s));
    s.on('snap', (m: { t: number; e: number[][]; p: number[][]; s: [number, number] }) => this.onSnap(m));
    s.on('ammo', (m: { s: number; p: number; c: number; r: number; rk: 'secondary' | 'primary' | null }) => {
      this.ammo = { secondary: m.s, primary: m.p, charges: m.c, reloadUntil: m.r, reloadKey: m.rk }; this.emit('ammo', this.ammo);
    });
    s.on('loadout', (m: { id: number; l: Loadout }) => { const p = this.players.get(m.id); if (p) { p.loadout = m.l; this.entities.get(m.id)?.setInfo(p, this.isAlly(m.id)); } this.emit('loadout', m.id, m.l); });
    s.on('shot', (m: { id: number; w: WeaponId; o: [number, number, number]; h: number[]; alt: boolean }) => this.onShot(m));
    s.on('melee', (m: { id: number; w: WeaponId; hit: number }) => { this.entities.get(m.id)?.onShot(); this.emit('melee', m); });
    s.on('reload', (m: { id: number }) => this.emit('reload', m.id));
    s.on('hit', (m: { v: number; d: number; z: HitZone; k: boolean }) => this.emit('hit', m));
    s.on('hurt', (m: { a: number; d: number; hp: number; from: [number, number] }) => { this.self.hp = m.hp; this.emit('hurt', m); });
    s.on('flash', (m: { dur: number; by: number; full: boolean }) => this.emit('flash', m));
    s.on('skill', (m: { id: number; k: 'q' | 'e'; cd: number; until: number }) => this.emit('skill', m));
    s.on('kill', (m: { k: number; v: number; w: WeaponId; hs: boolean; a: number[]; s: [number, number] }) => this.onKill(m));
    s.on('proj:spawn', (m: { id: number; type: 'grenade' | 'flash'; p: [number, number, number] }) => {
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(m.type === 'flash' ? 0.07 : 0.09, 10, 8),
        new THREE.MeshStandardMaterial({ color: m.type === 'flash' ? 0xe8f4ff : 0x4f6b45, emissive: m.type === 'flash' ? 0x9fd8ff : 0xff3b1f, emissiveIntensity: 0.8 }));
      mesh.position.set(m.p[0], m.p[1], m.p[2]); this.scene.add(mesh);
      this.projs.set(m.id, { mesh, target: mesh.position.clone() });
    });
    s.on('proj:explode', (m: { id: number; type: 'grenade' | 'flash'; p: [number, number, number] }) => {
      this.removeProj(m.id); this.spawnBlast(m.type, m.p); this.emit('explode', { type: m.type, p: m.p });
    });
    s.on('range:config', (m: { moving: boolean }) => { this.rangeMoving = m.moving; this.emit('rangeConfig', m.moving); });
    s.on('match:end', (m: MatchEnd) => {
      if (this.room) this.room.score = m.score;
      for (const r of m.players) { const p = this.players.get(r.id); if (p) { p.k = r.k; p.d = r.d; p.a = r.a; } }
      this.emit('matchEnd', m);
    });
    s.on('match:reward', (r: MatchReward) => this.emit('reward', r));
  }

  // ── 상태 반영
  private setMap(map: MapData): void {
    this.arena?.dispose();
    this.arena = buildArena(map); this.scene.add(this.arena.group);
    this.scene.background = this.arena.background; this.scene.fog = this.arena.fog;
    if (this.room) this.room.mapId = map.id;
  }
  private addPlayer(info: PlayerInfo): void {
    this.players.set(info.id, info);
    if (info.id === this.you) return;
    const ally = !info.dummy && info.team === this.myTeam, cur = this.entities.get(info.id);
    if (cur) cur.setInfo(info, ally);
    else { const e = new RemoteEntity(info, ally); this.entities.set(info.id, e); this.scene.add(e.group); }
  }
  private syncRoster(list: PlayerInfo[]): void {
    const ids = new Set(list.map((p) => p.id));
    for (const id of [...this.players.keys()]) if (!ids.has(id)) { this.players.delete(id); this.entities.get(id)?.dispose(); this.entities.delete(id); }
    const mine = list.find((p) => p.id === this.you); if (mine) this.players.set(mine.id, mine); // 내 팀 먼저 확정
    for (const p of list) this.addPlayer(p);
  }
  private onSpawn(sp: SpawnTuple): void {
    const [id, x, y, z, yaw, seq] = sp;
    if (id === this.you) { this.self.alive = true; this.self.hp = RULES.hp; this.self.slot = 3; this.emit('spawn', x, y, z, yaw, seq); }
    else { const e = this.entities.get(id); if (e) e.buf.length = 0; }
  }
  private onSnap(m: { t: number; e: number[][]; p: number[][]; s: [number, number] }): void {
    if (!this.room) return;
    this.room.score = m.s;
    for (const a of m.e) {
      const id = a[0];
      if (id === this.you) { this.self.flags = a[6]; this.self.hp = a[7]; this.self.alive = !!(a[6] & F.ALIVE); this.self.slot = a[8]; continue; }
      this.entities.get(id)?.push({ t: m.t, x: a[1], y: a[2], z: a[3], yaw: a[4], pitch: a[5], f: a[6], hp: a[7], slot: a[8] });
    }
    const live = new Set<number>();
    for (const p of m.p) { live.add(p[0]); this.projs.get(p[0])?.target.set(p[1], p[2], p[3]); }
    for (const id of [...this.projs.keys()]) if (!live.has(id) && this.projs.get(id)!.mesh.userData.seen) this.removeProj(id); else if (live.has(id)) this.projs.get(id)!.mesh.userData.seen = true;
  }
  private onKill(m: { k: number; v: number; w: WeaponId; hs: boolean; a: number[]; s: [number, number] }): void {
    const killer = this.players.get(m.k), victim = this.players.get(m.v);
    if (this.room) this.room.score = m.s;
    if (victim) victim.d++;
    if (killer && m.k !== m.v) killer.k++;
    for (const id of m.a) { const p = this.players.get(id); if (p) p.a++; }
    if (m.v === this.you) { this.self.alive = false; this.self.hp = 0; }
    if (victim?.dummy && m.k !== this.you) return;
    const item: KillFeedItem = {
      at: performance.now(), killer: killer?.name ?? '?', victim: victim?.dummy ? '훈련 봇' : victim?.name ?? '?', killerTeam: killer?.team ?? 0, victimTeam: victim?.team ?? 1,
      weapon: m.w, hs: m.hs, assists: m.a.map((id) => this.players.get(id)?.name ?? '?'), mine: m.k === this.you || m.v === this.you || m.a.includes(this.you), suicide: m.k === m.v,
    };
    this.killfeed.push(item); if (this.killfeed.length > 6) this.killfeed.shift();
    this.emit('kill', item, { k: m.k, v: m.v });
  }
  /** 5초 지난 킬로그 제거 후 반환 (HUD 우측 상단) */
  activeKillfeed(ttlMs = 5000): KillFeedItem[] {
    const now = performance.now(); while (this.killfeed.length && now - this.killfeed[0].at > ttlMs) this.killfeed.shift();
    return this.killfeed;
  }

  // ── 이펙트
  private onShot(m: { id: number; w: WeaponId; o: [number, number, number]; h: number[]; alt: boolean }): void {
    const ent = this.entities.get(m.id); ent?.onShot();
    const info = this.players.get(m.id), w = WEAPONS[m.w], skin = getSkin(info?.skins?.[m.w]);
    const color = skin?.vfx.tracerColor ?? (isGun(w) ? w.tracer : 0xffffff);
    if (this.particles !== 'off') {
      const from = ent ? ent.muzzleWorld(this.tmp) : this.tmp.set(m.o[0], m.o[1] - 0.12, m.o[2]);
      const step = this.particles === 'low' && m.h.length > 9 ? 6 : 3;
      for (let i = 0; i < m.h.length; i += step) this.spawnTracer(from, m.h[i], m.h[i + 1], m.h[i + 2], color);
    }
    this.emit('shot', { id: m.id, w: m.w, o: m.o, alt: m.alt });
  }
  private spawnTracer(from: THREE.Vector3, x: number, y: number, z: number, color: number): void {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), new THREE.Vector3(x, y, z)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    this.scene.add(line); this.fx.push({ obj: line, life: 0.09, max: 0.09, kind: 'tracer' });
    if (this.particles === 'high') { // 탄착 스파크
      const sp = new THREE.Mesh(new THREE.SphereGeometry(0.05, 6, 5), new THREE.MeshBasicMaterial({ color, transparent: true }));
      sp.position.set(x, y, z); this.scene.add(sp); this.fx.push({ obj: sp, life: 0.15, max: 0.15, kind: 'pop' });
    }
  }
  private spawnBlast(type: 'grenade' | 'flash', p: [number, number, number]): void {
    const flash = type === 'flash';
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: flash ? 0xffffff : 0xff8a30, transparent: true, opacity: 0.85, depthWrite: false }));
    m.position.set(p[0], p[1], p[2]); m.userData.radius = flash ? 1.6 : (WEAPONS.grenade.type === 'throw' ? WEAPONS.grenade.radius ?? 6.5 : 6.5);
    const light = new THREE.PointLight(flash ? 0xffffff : 0xff7a20, flash ? 6 : 4, flash ? 30 : 18); m.add(light);
    this.scene.add(m); this.fx.push({ obj: m, life: flash ? 0.22 : 0.4, max: flash ? 0.22 : 0.4, kind: 'boom' });
  }
  private removeProj(id: number): void {
    const p = this.projs.get(id); if (!p) return;
    p.mesh.removeFromParent(); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose(); this.projs.delete(id);
  }
  private clearEffects(): void {
    for (const id of [...this.projs.keys()]) this.removeProj(id);
    for (const f of this.fx) disposeFx(f); this.fx.length = 0;
  }
  private clearRoom(): void {
    this.clearEffects();
    for (const e of this.entities.values()) e.dispose();
    this.entities.clear(); this.players.clear(); this.killfeed.length = 0;
    this.arena?.dispose(); this.arena = null; this.room = null; this.you = 0;
    this.self = { hp: 0, alive: false, flags: 0, slot: 3 };
  }

  /** 프레임마다 호출: 원격 엔티티 보간 + 투사체/이펙트 갱신 */
  update(dt: number): void {
    if (!this.room) return;
    const rt = this.renderTime();
    for (const e of this.entities.values()) e.update(rt, dt);
    const k = Math.min(1, dt * 18);
    for (const p of this.projs.values()) { p.mesh.position.lerp(p.target, k); p.mesh.rotation.x += dt * 9; p.mesh.rotation.z += dt * 7; }
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i]; f.life -= dt;
      if (f.life <= 0) { disposeFx(f); this.fx.splice(i, 1); continue; }
      const a = f.life / f.max, mat = (f.obj as THREE.Mesh).material as THREE.Material & { opacity: number };
      mat.opacity = a * (f.kind === 'boom' ? 0.85 : 0.9);
      if (f.kind === 'boom') f.obj.scale.setScalar(0.3 + (1 - a) * (f.obj.userData.radius as number) * 0.8);
    }
    tickSkinMaterials(performance.now() / 1000);
  }
}
function disposeFx(f: Fx): void {
  f.obj.removeFromParent(); const m = f.obj as THREE.Mesh;
  m.geometry?.dispose(); (m.material as THREE.Material)?.dispose();
}
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;