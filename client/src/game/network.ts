// =====================================================================
// Socket.io 클라이언트: 방/매칭 · 스냅샷 보간 · 원격 캐릭터/무기(스킨) 렌더 · 킬로그/점수 동기화
// 이벤트·페이로드는 server/server.js 와 1:1 대응.
// =====================================================================
import * as THREE from 'three';
import { io, type Socket } from 'socket.io-client';
import { F, RULES, SLOT, SLOT_KEYS, WEAPONS, isGun, type GameMode, type HitZone, type Loadout, type MapId, type WeaponId } from '../config/weapons';
import { getSkin } from '../config/skins';
import { attachSkinFx, fireWeaponFx, skinMaterials, tickSkinMaterials } from './skinFx';
import { attachFbxModel } from './weaponModels';
import { SERVER_URL, socketAuthPayload } from '../services/supabase';
import type { SkillId, UltId } from '../config/skills';
import { buildArena, textSprite, type ArenaBuild, type MapData, type World } from './arena';
import { ImpactFx } from './impactFx';

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
/** 매치 종료 시 참가자별 상세 기록. userId 는 방 내 플레이어 ID (GameClient.you 와 동일 체계) */
export interface MatchPlayerResult {
  userId: number; nickname: string; team: number; bot: boolean;
  kills: number; deaths: number; assists: number; damageDealt: number; headshots: number; combatScore: number; earnedCredits: number;
}
export interface MatchEnd {
  winner: number; winnerTeam: 'teamA' | 'teamB' | null; score: [number, number]; teamScore: { teamA: number; teamB: number };
  /** combatScore 내림차순 정렬 */
  players: MatchPlayerResult[]; matchMvpId: number; teamMvpId: [number, number];
}
export interface MatchReward { result: 'win' | 'loss' | 'draw' | 'left'; rp_delta: number; credits: number; saved: boolean; rank_points?: number; credits_earned?: number; unlocked?: string[] }
export interface HelloInfo { serverTime: number; guest: boolean; name: string; rp: number; tier: number; tierLabel: string; loadout: Loadout }
interface Snap { t: number; x: number; y: number; z: number; yaw: number; pitch: number; f: number; hp: number; slot: number }

export interface NetEvents {
  connect: () => void; disconnect: (reason: string) => void; error: (code: string) => void;
  hello: (h: HelloInfo) => void;
  joined: (room: RoomState) => void; state: (room: RoomState) => void; roster: (room: RoomState) => void; closed: (reason: string) => void;
  phase: (p: { phase: Phase; endsAt: number; round: number; score: [number, number]; winner?: number }) => void;
  spawn: (x: number, y: number, z: number, yaw: number, seq: number) => void;   // 내 스폰
  correct: (x: number, y: number, z: number, seq: number, yaw?: number) => void;
  ammo: (a: AmmoState) => void;
  hit: (h: { v: number; d: number; z: HitZone; k: boolean }) => void;
  hurt: (h: { a: number; d: number; hp: number; from: [number, number] }) => void;
  flash: (f: { dur: number; by: number; full: boolean }) => void;
  kill: (k: KillFeedItem, raw: { k: number; v: number }) => void;
  shot: (s: { id: number; w: WeaponId; o: [number, number, number]; alt: boolean }) => void;
  melee: (m: { id: number; w: WeaponId; hit: number }) => void;
  reload: (id: number) => void;
  explode: (e: { type: 'grenade' | 'flash' | 'zero'; p: [number, number, number] }) => void;
  skill: (s: { id: number; k: 'q' | 'e'; s: SkillId; cd: number; until: number; u: number }) => void;
  ult: (u: { id: number; s: UltId; ph: 'cast' | 'cancel' | 'done' | 'start' | 'end' | 'wave'; until?: number; p?: [number, number]; o?: [number, number, number]; d?: [number, number, number]; hit?: number }) => void;
  ultPts: (p: number) => void;
  silence: (until: number) => void;
  shield: (s: { on: boolean; broke?: boolean }) => void;
  duel: (d: { a: number; b: number; until: number }) => void;
  duelEnd: (d: { a: number; b: number; w: number }) => void;
  loadout: (id: number, l: Loadout) => void;
  rangeConfig: (moving: boolean) => void;
  matchEnd: (m: MatchEnd) => void; reward: (r: MatchReward) => void;
}

// ───────────────────────────── 무기 메시 (스킨 재질/등급 효과는 skinFx.ts) ─────────────────────────────
interface GunShape { len: number; h: number; barrel: number; mag: number; stock: number; scope?: boolean; drum?: boolean }
const GUN_SHAPES: Record<string, GunShape> = {
  classic: { len: 0.2, h: 0.055, barrel: 0.02, mag: 0.1, stock: 0 }, shorty: { len: 0.22, h: 0.07, barrel: 0.1, mag: 0, stock: 0 },
  frenzy: { len: 0.22, h: 0.06, barrel: 0.03, mag: 0.16, stock: 0 }, ghost: { len: 0.21, h: 0.055, barrel: 0.14, mag: 0.1, stock: 0 },
  sheriff: { len: 0.2, h: 0.07, barrel: 0.14, mag: 0, stock: 0, drum: true },
  vandal: { len: 0.5, h: 0.08, barrel: 0.22, mag: 0.2, stock: 0.24 }, phantom: { len: 0.52, h: 0.075, barrel: 0.26, mag: 0.18, stock: 0.22 },
  marshal: { len: 0.6, h: 0.065, barrel: 0.4, mag: 0.08, stock: 0.3, scope: true },
};
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const part = (mat: THREE.Material, w: number, h: number, d: number, x: number, y: number, z: number): THREE.Mesh => {
  const m = new THREE.Mesh(UNIT_BOX, mat); m.scale.set(w, h, d); m.position.set(x, y, z); return m;
};
/** 프로시저럴 무기 메시 (전방 = -Z). userData.muzzle = 총구 Object3D */
export function createWeaponMesh(weaponId: WeaponId, skinId?: string | null, viewmodel = false): THREE.Group {
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
  attachSkinFx(g, skinId, viewmodel); // 등급 전용 파츠(홀로그램 윙 / 에너지 코어 링 / 총구 섬광)
  const sk = getSkin(skinId); attachFbxModel(g, weaponId, { base, accent, skinned: !!sk && !sk.glb }, viewmodel, skinId); // FBX 로드 완료 시 박스 모델 교체 (실패 시 폴백 유지)
  return g;
}

// ───────────────────────────── 원격 캐릭터 ─────────────────────────────
const COLOR_ALLY = 0x3b9cff, COLOR_ENEMY = 0xff4655, COLOR_DUMMY = 0xffa23a;
const HEAD_GEO = new THREE.SphereGeometry(0.23, 16, 12);
const FX_GEO = new THREE.SphereGeometry(1, 16, 12);
class RemoteEntity {
  readonly group = new THREE.Group();
  private readonly upper = new THREE.Group();
  private readonly hand = new THREE.Group();
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly neonMat: THREE.MeshStandardMaterial;
  private tag: THREE.Sprite | null = null;
  private readonly aura: THREE.Mesh; private readonly bubble: THREE.Mesh; private readonly fxMat: THREE.MeshBasicMaterial[] = [];
  private ally: boolean;
  private weapon: THREE.Group | null = null;
  private weaponKey = '';
  readonly buf: Snap[] = [];
  x = 0; y = 0; z = 0; yaw = 0; pitch = 0; flags = 0; hp = 0; slot: number = SLOT.primary; alive = false;
  private kick = 0;

  constructor(public info: PlayerInfo, ally: boolean) {
    this.ally = ally;
    const color = info.dummy ? COLOR_DUMMY : ally ? COLOR_ALLY : COLOR_ENEMY;
    this.bodyMat = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.15, emissive: color, emissiveIntensity: 0.18 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2028, roughness: 0.7, metalness: 0.2 });
    const gear = new THREE.MeshStandardMaterial({ color: 0x0c0e12, roughness: 0.45, metalness: 0.6 }); // 관절/장비 — 더 어둡고 금속감
    this.neonMat = new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 1.6, roughness: 0.3, metalness: 0.2 });
    const visorMat = new THREE.MeshStandardMaterial({ color: 0x05070a, roughness: 0.15, metalness: 0.9, emissive: color, emissiveIntensity: 0.25 });
    const g = this.group;
    g.add(part(dark, 0.2, 0.72, 0.24, -0.14, 0.36, 0), part(dark, 0.2, 0.72, 0.24, 0.14, 0.36, 0));       // 다리
    g.add(part(gear, 0.22, 0.16, 0.27, -0.14, 0.08, -0.01), part(gear, 0.22, 0.16, 0.27, 0.14, 0.08, -0.01)); // 부츠
    g.add(part(gear, 0.23, 0.1, 0.27, -0.14, 0.4, 0), part(gear, 0.23, 0.1, 0.27, 0.14, 0.4, 0));        // 무릎 관절
    g.add(part(this.neonMat, 0.03, 0.4, 0.02, -0.25, 0.4, -0.12), part(this.neonMat, 0.03, 0.4, 0.02, 0.25, 0.4, -0.12)); // 다리 네온 라인
    g.add(part(this.bodyMat, 0.56, 0.66, 0.32, 0, 1.05, 0));                                               // 몸통
    g.add(part(gear, 0.5, 0.34, 0.06, 0, 1.12, -0.17), part(gear, 0.6, 0.08, 0.36, 0, 0.74, 0));          // 가슴 플레이트 + 벨트
    g.add(part(this.neonMat, 0.5, 0.025, 0.02, 0, 1.3, -0.205), part(this.neonMat, 0.62, 0.025, 0.37, 0, 0.74, 0)); // 가슴/허리 네온
    this.upper.position.set(0, 1.38, 0);
    const head = new THREE.Mesh(HEAD_GEO, this.bodyMat); head.position.set(0, 0.24, 0);
    this.upper.add(head, part(visorMat, 0.36, 0.11, 0.08, 0, 0.27, -0.19));                                // 머리 + 전술 바이저(고글)
    this.upper.add(part(this.neonMat, 0.34, 0.02, 0.02, 0, 0.27, -0.235));                                 // 바이저 발광 라인
    this.upper.add(part(gear, 0.1, 0.16, 0.1, -0.23, 0.2, 0.02), part(gear, 0.1, 0.16, 0.1, 0.23, 0.2, 0.02)); // 헤드셋
    this.upper.add(part(gear, 0.2, 0.14, 0.2, 0.3, 0.0, 0), part(gear, 0.2, 0.14, 0.2, -0.3, 0.0, 0));     // 어깨 장갑
    this.upper.add(part(dark, 0.13, 0.13, 0.5, 0.3, -0.12, -0.2), part(dark, 0.13, 0.13, 0.45, -0.24, -0.14, -0.22).rotateY(-0.5)); // 팔
    this.upper.add(part(gear, 0.15, 0.15, 0.1, 0.3, -0.12, -0.34), part(this.neonMat, 0.145, 0.02, 0.12, 0.3, -0.04, -0.24)); // 팔뚝 장갑 + 네온 밴드
    this.hand.position.set(0.24, -0.1, -0.42); this.upper.add(this.hand);
    g.add(this.upper);
    g.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.userData.entityId = info.id; } });
    const mkFx = (color: number, r: number): THREE.Mesh => { // 스킬 상태 이펙트 구체 (데미지 증폭 붉은 오라 / 보호막 / 봉인)
      const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.28, depthWrite: false, blending: THREE.AdditiveBlending });
      this.fxMat.push(mat); const m = new THREE.Mesh(FX_GEO, mat); m.scale.setScalar(r); m.position.y = 0.95; m.visible = false; g.add(m); return m;
    };
    this.aura = mkFx(0xff2a2a, 1.05); this.bubble = mkFx(0x5ef0ff, 0.95);
    this.setTag(ally);
    g.visible = false;
  }
  private setTag(ally: boolean): void {
    if (this.tag) { this.tag.material.map?.dispose(); this.tag.material.dispose(); this.tag.removeFromParent(); }
    if (this.info.dummy) return;
    this.tag = textSprite(this.info.name, ally ? '#8cc8ff' : '#ff8c96', 0.8); this.tag.position.set(0, 2.15, 0); this.group.add(this.tag);
  }
  setInfo(info: PlayerInfo, ally: boolean): void {
    const renamed = info.name !== this.info.name; this.info = info; this.ally = ally;
    const color = info.dummy ? COLOR_DUMMY : ally ? COLOR_ALLY : COLOR_ENEMY; this.bodyMat.color.setHex(color); this.bodyMat.emissive.setHex(color); this.neonMat.color.setHex(color); this.neonMat.emissive.setHex(color);
    if (renamed) this.setTag(ally);
    this.weaponKey = '';
  }
  push(s: Snap): void { this.buf.push(s); if (this.buf.length > 40) this.buf.shift(); }
  onShot(): void { this.kick = 1; fireWeaponFx(this.weapon); }
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
    const g = this.group; g.visible = this.alive && !(this.flags & F.INVIS && !this.ally); if (!this.alive) return; // 차원 표류: 적에게는 완전 은신
    g.position.set(this.x, this.y, this.z); g.rotation.y = this.yaw;
    const low = this.flags & (F.CROUCH | F.SLIDE);
    g.scale.y += ((low ? 0.64 : 1) - g.scale.y) * Math.min(1, dt * 14);
    this.kick = Math.max(0, this.kick - dt * 9);
    this.upper.rotation.x = this.pitch + this.kick * 0.06; this.hand.position.z = -0.42 + this.kick * 0.05;
    const ghost = !!(this.flags & F.INVIS), cast = !!(this.flags & F.CAST), t = performance.now() / 1000;
    this.bodyMat.transparent = !!(this.flags & F.PROT) || ghost || cast; this.bodyMat.opacity = ghost ? 0.2 : cast ? 0.45 + 0.25 * Math.sin(t * 20) : this.flags & F.PROT ? 0.45 : 1;
    this.bodyMat.emissiveIntensity = this.flags & (F.DASH | F.HEAL) ? 0.7 : 0.18;
    this.neonMat.transparent = this.bodyMat.transparent; this.neonMat.opacity = this.bodyMat.opacity;
    this.aura.visible = !!(this.flags & F.AMP);
    if (this.aura.visible) this.aura.scale.setScalar(1.05 + 0.08 * Math.sin(t * 9));
    this.fxMat[1].color.setHex(this.flags & F.SILENCED ? 0xb06bff : 0x5ef0ff); this.bubble.visible = !!(this.flags & (F.SHIELD | F.SILENCED));
    if (this.tag) this.tag.scale.y = 0.4 / g.scale.y;
    // 손에 든 무기 + 스킨
    const wid = this.info.loadout[SLOT_KEYS[(this.slot as 1 | 2 | 3 | 4)] ?? 'primary'] as WeaponId, skin = this.info.skins?.[wid] ?? '', key = wid + '|' + skin;
    if (key !== this.weaponKey) {
      this.weaponKey = key; this.weapon?.removeFromParent();
      this.weapon = createWeaponMesh(wid, skin); this.hand.add(this.weapon);
    }
  }
  dispose(): void {
    this.group.removeFromParent(); this.bodyMat.dispose(); this.neonMat.dispose(); for (const m of this.fxMat) m.dispose();
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
  self = { hp: 0, alive: false, flags: 0, slot: SLOT.primary as number };
  rangeMoving = false;
  pingMs = 0;
  particles: 'off' | 'low' | 'high' = 'low';
  private timeOffset = 0;
  private bestRtt = Infinity;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers = new Map<string, Set<Handler>>();
  private readonly projs = new Map<number, { mesh: THREE.Mesh; target: THREE.Vector3 }>();
  private readonly walls = new Map<number, { box: MapData['boxes'][number]; mesh: THREE.Mesh; hp: number; max: number }>();
  private readonly orbs = new Map<number, { mesh: THREE.Mesh; base: THREE.Vector3; mine: boolean }>();
  private readonly fx: Fx[] = [];
  private readonly tmp = new THREE.Vector3();
  /** 풀링된 타격 이펙트 (스파크 / 헤드샷 파편 / 탄흔 / 먼지) */
  readonly impacts: ImpactFx;
  /** 내 최근 사격이 적에게 맞은 지점 — 'hit' 이벤트(헤드샷 파편)의 정확한 위치 계산용. 고정 슬롯 재사용 */
  private readonly ownHits = Array.from({ length: 16 }, () => ({ x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: 0, at: -1e9 }));
  private ownHitCursor = 0;
  private readonly rayO = { x: 0, y: 0, z: 0 };
  private readonly rayD = { x: 0, y: 0, z: 0 };

  constructor(readonly scene: THREE.Scene) { this.impacts = new ImpactFx(scene); }

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
  /** 고객센터/관리자 등 임의 이벤트 요청 (ack 에 추가 필드 포함) */
  call<T extends object = object>(ev: string, data: object = {}): Promise<Ack & Partial<T>> { return this.req(ev, data) as Promise<Ack & Partial<T>>; }
  /** 서버가 크레딧을 갱신했을 때(관리자 지급 등) 호출 */
  onCredits: ((credits: number) => void) | null = null;
  onSkinsUpdate: (() => void) | null = null;
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
  /** 스킬 사용 요청(서버 검증). yaw/pitch 는 투척·장벽 조준용, t 는 오멘 목표 좌표 */
  skill(k: 'q' | 'e' | 'x', aim?: { yaw: number; pitch: number; t?: [number, number] }): Promise<Ack> { return this.req('skill', { k, ...aim }); }

  // ── 수신 바인딩
  private bind(s: Socket): void {
    s.on('connect', () => { this.connected = true; this.bestRtt = Infinity; this.syncTime(); if (!this.syncTimer) this.syncTimer = setInterval(() => this.syncTime(), 4000); this.emit('connect'); });
    s.on('disconnect', (reason: string) => { this.connected = false; this.clearRoom(); this.emit('disconnect', reason); });
    s.on('connect_error', (e: Error) => this.emit('error', e.message));
    s.on('kicked', (m: { reason: string }) => this.emit('error', m.reason));
    s.on('server:shutdown', () => this.emit('error', 'SERVER_SHUTDOWN'));
    s.on('credits:update', (m: { credits: number }) => this.onCredits?.(m.credits));
    s.on('skins:update', () => this.onSkinsUpdate?.()); // 관리자 지급/회수 → 보관함 즉시 갱신
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
    s.on('pos:correct', (m: { p: [number, number, number]; s: number; yaw?: number }) => this.emit('correct', m.p[0], m.p[1], m.p[2], m.s, m.yaw));
    s.on('ult:pts', (m: { p: number }) => this.emit('ultPts', m.p));
    s.on('silence', (m: { until: number }) => this.emit('silence', m.until));
    s.on('shield', (m: { on: boolean; broke?: boolean }) => this.emit('shield', m));
    s.on('duel', (m: { a: number; b: number; until: number }) => this.emit('duel', m));
    s.on('duel:end', (m: { a: number; b: number; w: number }) => this.emit('duelEnd', m));
    s.on('ult', (m: Parameters<NetEvents['ult']>[0]) => { if (m.ph === 'wave' && m.o && m.d) this.spawnWave(m.o, m.d); this.emit('ult', m); });
    s.on('wall:add', (m: { id: number; b: number[]; hp: number; o: number }) => this.addWall(m.id, m.b, m.hp));
    s.on('wall:hp', (m: { id: number; hp: number }) => { const w = this.walls.get(m.id); if (w) { w.hp = m.hp; (w.mesh.material as THREE.MeshStandardMaterial).opacity = 0.35 + 0.5 * (m.hp / w.max); } });
    s.on('wall:del', (m: { id: number }) => this.removeWall(m.id, true));
    s.on('orb:add', (m: { id: number; o: number; p: [number, number, number] }) => this.addOrb(m.id, m.p, m.o === this.you));
    s.on('orb:del', (m: { id: number }) => this.removeOrb(m.id));
    s.on('snap', (m: { t: number; e: number[][]; p: number[][]; s: [number, number] }) => this.onSnap(m));
    s.on('ammo', (m: { s: number; p: number; c: number; r: number; rk: 'secondary' | 'primary' | null }) => {
      this.ammo = { secondary: m.s, primary: m.p, charges: m.c, reloadUntil: m.r, reloadKey: m.rk }; this.emit('ammo', this.ammo);
    });
    s.on('loadout', (m: { id: number; l: Loadout }) => { const p = this.players.get(m.id); if (p) { p.loadout = m.l; this.entities.get(m.id)?.setInfo(p, this.isAlly(m.id)); } this.emit('loadout', m.id, m.l); });
    s.on('shot', (m: { id: number; w: WeaponId; o: [number, number, number]; h: number[]; alt: boolean }) => this.onShot(m));
    s.on('melee', (m: { id: number; w: WeaponId; hit: number }) => { this.entities.get(m.id)?.onShot(); this.emit('melee', m); });
    s.on('reload', (m: { id: number }) => this.emit('reload', m.id));
    s.on('hit', (m: { v: number; d: number; z: HitZone; k: boolean }) => { this.onHitFx(m); this.emit('hit', m); });
    s.on('hurt', (m: { a: number; d: number; hp: number; from: [number, number] }) => { this.self.hp = m.hp; this.emit('hurt', m); });
    s.on('flash', (m: { dur: number; by: number; full: boolean }) => this.emit('flash', m));
    s.on('skill', (m: Parameters<NetEvents['skill']>[0]) => this.emit('skill', m));
    s.on('kill', (m: { k: number; v: number; w: WeaponId; hs: boolean; a: number[]; s: [number, number] }) => this.onKill(m));
    s.on('proj:spawn', (m: { id: number; type: 'grenade' | 'flash' | 'zero'; p: [number, number, number] }) => {
      const zero = m.type === 'zero';
      const mesh = new THREE.Mesh(zero ? new THREE.ConeGeometry(0.07, 0.3, 6) : new THREE.SphereGeometry(m.type === 'flash' ? 0.07 : 0.09, 10, 8),
        new THREE.MeshStandardMaterial({ color: zero ? 0x2a1a4a : m.type === 'flash' ? 0xe8f4ff : 0x4f6b45, emissive: zero ? 0xb06bff : m.type === 'flash' ? 0x9fd8ff : 0xff3b1f, emissiveIntensity: 0.8 }));
      mesh.position.set(m.p[0], m.p[1], m.p[2]); this.scene.add(mesh);
      this.projs.set(m.id, { mesh, target: mesh.position.clone() });
    });
    s.on('proj:explode', (m: { id: number; type: 'grenade' | 'flash' | 'zero'; p: [number, number, number] }) => {
      this.removeProj(m.id); this.spawnBlast(m.type, m.p); this.emit('explode', { type: m.type, p: m.p });
    });
    s.on('range:config', (m: { moving: boolean }) => { this.rangeMoving = m.moving; this.emit('rangeConfig', m.moving); });
    s.on('match:end', (m: MatchEnd) => {
      if (this.room) this.room.score = m.score;
      for (const r of m.players) { const p = this.players.get(r.userId); if (p) { p.k = r.kills; p.d = r.deaths; p.a = r.assists; } }
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
    if (id === this.you) { this.self.alive = true; this.self.hp = RULES.hp; this.self.slot = SLOT.primary; this.emit('spawn', x, y, z, yaw, seq); }
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
      const lite = m.h.length > 9; // 산탄/점사: 탄착당 파티클 수를 줄여 총량 유지
      this.impacts.quality = this.particles;
      for (let i = 0; i + 2 < m.h.length; i += 3) this.spawnImpact(m.id === this.you, m.o, m.h[i], m.h[i + 1], m.h[i + 2], lite);
    }
    this.emit('shot', { id: m.id, w: m.w, o: m.o, alt: m.alt });
  }
  /** 탄착점 분류: 월드 레이캐스트가 같은 거리에서 맞으면 벽/바닥(탄흔+먼지), 그 전에 멈췄으면 캐릭터 피격(스파크) */
  private spawnImpact(mine: boolean, o: [number, number, number], x: number, y: number, z: number, lite: boolean): void {
    const world = this.world; if (!world) return;
    const dx = x - o[0], dy = y - o[1], dz = z - o[2], len = Math.hypot(dx, dy, dz);
    if (len < 0.05 || len > 295) return; // 허공으로 날아간 탄
    const ro = this.rayO, rd = this.rayD; ro.x = o[0]; ro.y = o[1]; ro.z = o[2]; rd.x = dx / len; rd.y = dy / len; rd.z = dz / len;
    const wh = world.raycast(ro, rd, len + 0.15);
    if (wh && wh.t > len - 0.15) {
      const nx = wh.axis === 0 ? wh.sign : 0, ny = wh.axis === 1 ? wh.sign : 0, nz = wh.axis === 2 ? wh.sign : 0;
      this.impacts.wallImpact(x, y, z, nx, ny, nz, !this.inBarrier(x, y, z), lite); return;
    }
    let near = false; // 원격 캐릭터 근처에서 멈춘 탄만 피격으로 처리 (내가 맞은 탄은 화면 앞에서 터지지 않게 제외)
    for (const e of this.entities.values()) if (e.alive && Math.abs(x - e.x) < 0.8 && Math.abs(z - e.z) < 0.8 && y > e.y - 0.2 && y < e.y + 2.1) { near = true; break; }
    if (!near) return;
    this.impacts.hitSpark(x, y, z, -rd.x, -rd.y, -rd.z, lite);
    if (mine) { const h = this.ownHits[this.ownHitCursor]; this.ownHitCursor = (this.ownHitCursor + 1) % this.ownHits.length; h.x = x; h.y = y; h.z = z; h.dx = -rd.x; h.dy = -rd.y; h.dz = -rd.z; h.at = performance.now(); }
  }
  /** 소멸 가능한 장벽 위에는 탄흔을 남기지 않는다 (장벽이 사라지면 허공에 뜨므로) */
  private inBarrier(x: number, y: number, z: number): boolean {
    for (const w of this.walls.values()) { const b = w.box as unknown as number[]; if (x > b[0] - 0.06 && x < b[3] + 0.06 && y > b[1] - 0.06 && y < b[4] + 0.06 && z > b[2] - 0.06 && z < b[5] + 0.06) return true; }
    return false;
  }
  /** 내 공격 적중 통지: 헤드샷이면 황금 파편, 탄착점이 없는 공격(근접 등)이면 스파크 */
  private onHitFx(m: { v: number; d: number; z: HitZone; k: boolean }): void {
    if (this.particles === 'off') return;
    const e = this.entities.get(m.v); if (!e) return;
    const now = performance.now(), head = m.z === 'head', ty = e.y + (head ? 1.62 : m.z === 'leg' ? 0.5 : 1.15) * e.group.scale.y;
    let best: (typeof this.ownHits)[number] | null = null, bd = 1.6;
    for (const h of this.ownHits) { if (now - h.at > 300) continue; const d = Math.hypot(h.x - e.x, (h.y - ty) * 0.6, h.z - e.z); if (d < bd) { bd = d; best = h; } }
    this.impacts.quality = this.particles;
    if (head) { if (best) this.impacts.headShards(best.x, best.y, best.z, best.dx, best.dy, best.dz); else this.impacts.headShards(e.x, ty, e.z, 0, 0.4, 0); }
    else if (!best) this.impacts.hitSpark(e.x, ty, e.z, 0, 0.5, 0);
  }
  private spawnTracer(from: THREE.Vector3, x: number, y: number, z: number, color: number): void {
    const geo = new THREE.BufferGeometry().setFromPoints([from.clone(), new THREE.Vector3(x, y, z)]);
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 }));
    this.scene.add(line); this.fx.push({ obj: line, life: 0.09, max: 0.09, kind: 'tracer' });
  }
  private spawnBlast(type: 'grenade' | 'flash' | 'zero', p: [number, number, number]): void {
    if (type === 'zero') { // 제로/포인트: 반경 12m 감지 파동
      const r = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xb06bff, transparent: true, opacity: 0.5, depthWrite: false, wireframe: true }));
      r.position.set(p[0], p[1], p[2]); r.userData.radius = 12 / 0.8; this.scene.add(r); this.fx.push({ obj: r, life: 0.7, max: 0.7, kind: 'boom' }); return;
    }
    const flash = type === 'flash';
    const m = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12), new THREE.MeshBasicMaterial({ color: flash ? 0xffffff : 0xff8a30, transparent: true, opacity: 0.85, depthWrite: false }));
    m.position.set(p[0], p[1], p[2]); m.userData.radius = flash ? 1.6 : (WEAPONS.grenade.type === 'throw' ? WEAPONS.grenade.radius ?? 6.5 : 6.5);
    const light = new THREE.PointLight(flash ? 0xffffff : 0xff7a20, flash ? 6 : 4, flash ? 30 : 18); m.add(light);
    this.scene.add(m); this.fx.push({ obj: m, life: flash ? 0.22 : 0.4, max: flash ? 0.22 : 0.4, kind: 'boom' });
  }
  private addWall(id: number, b: number[], hp: number): void {
    const world = this.world; if (!world) return;
    const box = [b[0], b[1], b[2], b[3], b[4], b[5], 'barrier', id] as unknown as MapData['boxes'][number];
    world.boxes.push(box); // 클라이언트 충돌 월드에도 즉시 반영 (서버와 동일 AABB)
    const m = new THREE.Mesh(UNIT_BOX, new THREE.MeshStandardMaterial({ color: 0x7fe8ff, emissive: 0x2a9bb8, emissiveIntensity: 0.6, transparent: true, opacity: 0.85, roughness: 0.2, metalness: 0.3 }));
    m.scale.set(b[3] - b[0], b[4] - b[1], b[5] - b[2]); m.position.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2); m.castShadow = true;
    this.scene.add(m); this.walls.set(id, { box, mesh: m, hp, max: hp });
  }
  private removeWall(id: number, fxOn = false): void {
    const w = this.walls.get(id); if (!w) return;
    const i = this.world?.boxes.indexOf(w.box) ?? -1; if (i >= 0) this.world!.boxes.splice(i, 1);
    if (fxOn && this.particles !== 'off') this.spawnBlast('flash', [w.mesh.position.x, w.mesh.position.y, w.mesh.position.z]);
    w.mesh.removeFromParent(); (w.mesh.material as THREE.Material).dispose(); this.walls.delete(id);
  }
  private addOrb(id: number, p: [number, number, number], mine: boolean): void {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 14, 10), new THREE.MeshBasicMaterial({ color: mine ? 0x5ef0ff : 0x9aa7b4, transparent: true, opacity: mine ? 0.95 : 0.45 }));
    m.position.set(p[0], p[1], p[2]); this.scene.add(m); this.orbs.set(id, { mesh: m, base: m.position.clone(), mine });
  }
  private removeOrb(id: number): void {
    const o = this.orbs.get(id); if (!o) return;
    o.mesh.removeFromParent(); o.mesh.geometry.dispose(); (o.mesh.material as THREE.Material).dispose(); this.orbs.delete(id);
  }
  /** 청부 계약: 전방 직선 파동 */
  private spawnWave(o: [number, number, number], d: [number, number, number]): void {
    const len = 40, m = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.8, len, 12, 1, true), new THREE.MeshBasicMaterial({ color: 0xffb347, transparent: true, opacity: 0.55, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    const dir = new THREE.Vector3(d[0], d[1], d[2]); m.position.set(o[0] + d[0] * len / 2, o[1] - 0.2 + d[1] * len / 2, o[2] + d[2] * len / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); this.scene.add(m); this.fx.push({ obj: m, life: 0.5, max: 0.5, kind: 'pop' });
  }
  private removeProj(id: number): void {
    const p = this.projs.get(id); if (!p) return;
    p.mesh.removeFromParent(); p.mesh.geometry.dispose(); (p.mesh.material as THREE.Material).dispose(); this.projs.delete(id);
  }
  private clearEffects(): void {
    for (const id of [...this.projs.keys()]) this.removeProj(id);
    for (const id of [...this.walls.keys()]) this.removeWall(id);
    for (const id of [...this.orbs.keys()]) this.removeOrb(id);
    for (const f of this.fx) disposeFx(f); this.fx.length = 0;
    this.impacts.clear(); for (const h of this.ownHits) h.at = -1e9;
  }
  private clearRoom(): void {
    this.clearEffects();
    for (const e of this.entities.values()) e.dispose();
    this.entities.clear(); this.players.clear(); this.killfeed.length = 0;
    this.arena?.dispose(); this.arena = null; this.room = null; this.you = 0;
    this.self = { hp: 0, alive: false, flags: 0, slot: SLOT.primary };
  }

  /** 프레임마다 호출: 원격 엔티티 보간 + 투사체/이펙트 갱신 */
  update(dt: number): void {
    if (!this.room) return;
    const rt = this.renderTime();
    for (const e of this.entities.values()) e.update(rt, dt);
    const k = Math.min(1, dt * 18);
    for (const p of this.projs.values()) { p.mesh.position.lerp(p.target, k); p.mesh.rotation.x += dt * 9; p.mesh.rotation.z += dt * 7; }
    const ot = performance.now() / 1000; for (const o of this.orbs.values()) o.mesh.position.y = o.base.y + 0.12 * Math.sin(ot * 3 + o.base.x);
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i]; f.life -= dt;
      if (f.life <= 0) { disposeFx(f); this.fx.splice(i, 1); continue; }
      const a = f.life / f.max, mat = (f.obj as THREE.Mesh).material as THREE.Material & { opacity: number };
      mat.opacity = a * (f.kind === 'boom' ? 0.85 : 0.9);
      if (f.kind === 'boom') f.obj.scale.setScalar(0.3 + (1 - a) * (f.obj.userData.radius as number) * 0.8);
    }
    this.impacts.update(dt);
    tickSkinMaterials(performance.now() / 1000);
  }
}
function disposeFx(f: Fx): void {
  f.obj.removeFromParent(); const m = f.obj as THREE.Mesh;
  m.geometry?.dispose(); (m.material as THREE.Material)?.dispose();
}
const r2 = (v: number): number => Math.round(v * 100) / 100;
const r3 = (v: number): number => Math.round(v * 1000) / 1000;