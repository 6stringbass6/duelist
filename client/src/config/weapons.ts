// =====================================================================
// 무기 · 전투 규칙 · 이동 · 티어 (server/server.js 의 WEAPONS / RULES / MOVE 와 수치 동일 유지)
// 서버가 판정 권위. 이 파일은 예측·연출·UI 용.
// =====================================================================

export type SlotKey = 'primary' | 'secondary' | 'melee' | 'throwable';
export type MeleeId = 'fists' | 'dagger' | 'sword';
export type SecondaryId = 'classic' | 'shorty' | 'frenzy' | 'ghost' | 'sheriff';
export type PrimaryId = 'vandal' | 'phantom' | 'marshal' | 'odin';
export type ThrowableId = 'grenade' | 'flash';
export type GunId = SecondaryId | PrimaryId;
export type WeaponId = MeleeId | GunId | ThrowableId;
export type HitZone = 'head' | 'body' | 'leg';

export interface Loadout { melee: MeleeId; secondary: SecondaryId; primary: PrimaryId; throwable: ThrowableId }

/** 숫자키 슬롯 (FPS 표준): 1 주무기 / 2 보조 / 3 근접 / 4 투척 — server.js SLOT_KEYS 와 동일 */
export const SLOT_KEYS: Record<1 | 2 | 3 | 4, SlotKey> = { 1: 'primary', 2: 'secondary', 3: 'melee', 4: 'throwable' };
export const SLOT: Record<SlotKey, 1 | 2 | 3 | 4> = { primary: 1, secondary: 2, melee: 3, throwable: 4 };
export const DEFAULT_LOADOUT: Loadout = { melee: 'dagger', secondary: 'classic', primary: 'vandal', throwable: 'grenade' };

interface BaseDef { id: WeaponId; slot: 1 | 2 | 3 | 4; name: string; desc: string; move: number; equipMs: number; model: string }

export interface MeleeDef extends BaseDef {
  type: 'melee'; dmg: number; intervalMs: number; range: number; arcDeg: number; backMult: number;
}
/** [최대거리(m), head, body, leg] — 발로란트 원본 수치. 실제 데미지 = round(원본 × scale) */
export type DamageRange = [number, number, number, number];
export interface SpreadDef { base: number; perShot: number; max: number; recoverMs: number; hip?: number }
export interface RecoilDef { pitch: number; yaw: number; recover: number; maxPitch: number }
export interface GunDef extends BaseDef {
  type: 'gun'; auto: boolean; rps: number; rpsMax?: number; rampShots?: number; mag: number; reloadMs: number;
  scale: number; ranges: DamageRange[]; pellets?: number; spread: SpreadDef; adsSpread?: number;
  alt?: { burst: number; rps: number; spread: number };
  zoom?: number; scopeMs?: number; adsZoom: number;
  recoil: RecoilDef; tracer: number;
}
export interface ThrowDef extends BaseDef {
  type: 'throw'; fuseMs: number; altFuseMs?: number; speed: number; altSpeed?: number; lift: number; altLift?: number;
  radius?: number; maxDmg?: number; minDmg?: number; selfMult?: number; maxBlindMs?: number; altMaxBlindMs?: number;
  charges: number; restitution: number;
}
export type WeaponDef = MeleeDef | GunDef | ThrowDef;

const INF = Infinity;

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  // ── 3번: 근접 (장착 시 이동속도 증가)
  fists: { id: 'fists', slot: 3, type: 'melee', name: '주먹', desc: '미장착. 가볍고 빠르다.', dmg: 25, intervalMs: 400, range: 1.9, arcDeg: 70, backMult: 1, move: 1.15, equipMs: 150, model: 'fists' },
  dagger: { id: 'dagger', slot: 3, type: 'melee', name: '단검', desc: '낮은 데미지, 초고속 연타. 백스탭 2배.', dmg: 35, intervalMs: 300, range: 2.1, arcDeg: 70, backMult: 2, move: 1.2, equipMs: 150, model: 'dagger' },
  sword: { id: 'sword', slot: 3, type: 'melee', name: '장검', desc: '높은 데미지, 느린 휘두르기. 백스탭 1.6배.', dmg: 95, intervalMs: 1050, range: 2.7, arcDeg: 90, backMult: 1.6, move: 1.12, equipMs: 250, model: 'sword' },

  // ── 2번: 보조무기
  classic: { id: 'classic', slot: 2, type: 'gun', name: '클래식', desc: '기본 권총. 우클릭 3점사.', auto: false, rps: 6.75, mag: 12, reloadMs: 1750, scale: 1,
    ranges: [[30, 52, 22, 19], [INF, 46, 20, 17]], spread: { base: 0.25, perShot: 0.35, max: 2.2, recoverMs: 350 },
    alt: { burst: 3, rps: 2.22, spread: 1.8 }, adsZoom: 1, move: 1.06, equipMs: 300, model: 'classic',
    recoil: { pitch: 0.9, yaw: 0.25, recover: 9, maxPitch: 5 }, tracer: 0xfff2c0 },
  shorty: { id: 'shorty', slot: 2, type: 'gun', name: '쇼티', desc: '2연발 소드오프 산탄총.', auto: false, rps: 3.33, mag: 2, reloadMs: 1750, scale: 1, pellets: 12,
    ranges: [[7, 36, 12, 10], [15, 24, 8, 6], [INF, 9, 3, 2]], spread: { base: 4.2, perShot: 0, max: 4.2, recoverMs: 300 },
    adsZoom: 1, move: 1.06, equipMs: 300, model: 'shorty', recoil: { pitch: 3.2, yaw: 0.6, recover: 7, maxPitch: 7 }, tracer: 0xffd9a0 },
  frenzy: { id: 'frenzy', slot: 2, type: 'gun', name: '프렌지', desc: '완전 자동 기관권총.', auto: true, rps: 10, mag: 13, reloadMs: 1500, scale: 1,
    ranges: [[20, 44, 20, 17], [INF, 40, 18, 15]], spread: { base: 0.45, perShot: 0.22, max: 2.6, recoverMs: 400 },
    adsZoom: 1, move: 1.06, equipMs: 300, model: 'frenzy', recoil: { pitch: 0.75, yaw: 0.35, recover: 8, maxPitch: 7 }, tracer: 0xfff2c0 },
  ghost: { id: 'ghost', slot: 2, type: 'gun', name: '고스트', desc: '소음기 장착 정밀 권총.', auto: false, rps: 6.75, mag: 15, reloadMs: 1500, scale: 1,
    ranges: [[30, 56, 25, 21], [INF, 52, 23, 19]], spread: { base: 0.2, perShot: 0.3, max: 1.9, recoverMs: 350 },
    adsZoom: 1, move: 1.06, equipMs: 300, model: 'ghost', recoil: { pitch: 0.8, yaw: 0.2, recover: 9, maxPitch: 5 }, tracer: 0xd8e8ff },
  sheriff: { id: 'sheriff', slot: 2, type: 'gun', name: '셰리프', desc: '고위력 리볼버.', auto: false, rps: 4, mag: 6, reloadMs: 2250, scale: 1,
    ranges: [[30, 80, 38, 32], [INF, 76, 36, 30]], spread: { base: 0.15, perShot: 0.9, max: 2.5, recoverMs: 500 },
    adsZoom: 1, move: 1.06, equipMs: 350, model: 'sheriff', recoil: { pitch: 2.6, yaw: 0.4, recover: 6, maxPitch: 8 }, tracer: 0xffe0a0 },

  // ── 1번: 주무기 (밴달/팬텀/오딘 = 발로란트 데미지 50% 반올림)
  vandal: { id: 'vandal', slot: 1, type: 'gun', name: '밴달', desc: '거리 감쇠 없는 돌격소총.', auto: true, rps: 9.75, mag: 25, reloadMs: 2500, scale: 1,
    ranges: [[INF, 62, 28, 24]], spread: { base: 0.12, perShot: 0.14, max: 1.7, recoverMs: 380 }, adsSpread: 0.85,
    adsZoom: 1.25, move: 1, equipMs: 400, model: 'vandal', recoil: { pitch: 0.62, yaw: 0.3, recover: 7, maxPitch: 9 }, tracer: 0xffc070 },
  phantom: { id: 'phantom', slot: 1, type: 'gun', name: '팬텀', desc: '빠른 연사, 안정적인 소음 소총.', auto: true, rps: 11, mag: 30, reloadMs: 2500, scale: 1,
    ranges: [[15, 51, 24, 20], [30, 48, 23, 19], [INF, 45, 22, 18]], spread: { base: 0.1, perShot: 0.11, max: 1.4, recoverMs: 350 }, adsSpread: 0.85,
    adsZoom: 1.25, move: 1, equipMs: 400, model: 'phantom', recoil: { pitch: 0.5, yaw: 0.24, recover: 7.5, maxPitch: 8 }, tracer: 0xc0d8ff },
  marshal: { id: 'marshal', slot: 1, type: 'gun', name: '마샬', desc: '고배율 저격소총. 노줌 지향사격은 탄퍼짐 극대화.', auto: false, rps: 1.5, mag: 5, reloadMs: 2500, scale: 1,
    ranges: [[INF, 202, 101, 85]], spread: { base: 0, perShot: 0, max: 0, recoverMs: 300, hip: 6.5 }, zoom: 3.5, scopeMs: 150,
    adsZoom: 3.5, move: 1, equipMs: 450, model: 'marshal', recoil: { pitch: 3.5, yaw: 0.3, recover: 5, maxPitch: 6 }, tracer: 0xffffff },
  odin: { id: 'odin', slot: 1, type: 'gun', name: '오딘', desc: '100발 경기관총. 쏠수록 연사 가속.', auto: true, rps: 12, rpsMax: 15.6, rampShots: 10, mag: 100, reloadMs: 5000, scale: 0.5,
    ranges: [[30, 95, 38, 32], [INF, 77, 31, 26]], spread: { base: 0.5, perShot: 0.07, max: 2.4, recoverMs: 450 }, adsSpread: 0.7,
    adsZoom: 1.15, move: 0.88, equipMs: 550, model: 'odin', recoil: { pitch: 0.42, yaw: 0.36, recover: 6, maxPitch: 10 }, tracer: 0xffb060 },

  // ── 4번: 투척류
  grenade: { id: 'grenade', slot: 4, type: 'throw', name: '수류탄', desc: '바운드 후 범위 폭발.', fuseMs: 2000, speed: 21, lift: 3, radius: 6.5, maxDmg: 130, minDmg: 15, selfMult: 0.5,
    charges: 2, restitution: 0.45, move: 1.06, equipMs: 300, model: 'grenade' },
  flash: { id: 'flash', slot: 4, type: 'throw', name: '섬광탄', desc: '좌클릭 원거리 투척 / 우클릭 언더핸드. 시야 내 적 실명.', fuseMs: 1600, altFuseMs: 1000, speed: 24, altSpeed: 10, lift: 2, altLift: 3.5,
    maxBlindMs: 2250, altMaxBlindMs: 1500, charges: 2, restitution: 0.5, move: 1.06, equipMs: 300, model: 'flash' },
};

export const WEAPONS_BY_SLOT: Record<SlotKey, WeaponId[]> = { // 키 순서 = 로드아웃 UI 표시 순서
  primary: ['vandal', 'phantom', 'marshal', 'odin'],
  secondary: ['classic', 'shorty', 'frenzy', 'ghost', 'sheriff'],
  melee: ['fists', 'dagger', 'sword'],
  throwable: ['grenade', 'flash'],
};

export const isGun = (w: WeaponDef): w is GunDef => w.type === 'gun';
export const isMelee = (w: WeaponDef): w is MeleeDef => w.type === 'melee';
export const isThrow = (w: WeaponDef): w is ThrowDef => w.type === 'throw';
export const getWeapon = (id: WeaponId): WeaponDef => WEAPONS[id];

/** 거리·부위별 실제 데미지 (scale 적용 + 반올림) */
export function damageAt(w: GunDef, dist: number, zone: HitZone): number {
  const r = w.ranges.find((x) => dist <= x[0]) ?? w.ranges[w.ranges.length - 1];
  return Math.round((zone === 'head' ? r[1] : zone === 'body' ? r[2] : r[3]) * w.scale);
}
/** 상점/사격장 UI용 데미지 표 */
export function damageTable(w: GunDef): { maxDist: number; head: number; body: number; leg: number }[] {
  return w.ranges.map(([d, h, b, l]) => ({ maxDist: d, head: Math.round(h * w.scale), body: Math.round(b * w.scale), leg: Math.round(l * w.scale) }));
}
/** 현재 발사 간격(ms). 오딘은 heat(연속 발사 수)에 따라 가속 */
export function fireIntervalMs(w: GunDef, alt = false, heat = 0): number {
  if (alt && w.alt) return 1000 / w.alt.rps;
  if (w.rpsMax && w.rampShots) return 1000 / (w.rps + (w.rpsMax - w.rps) * Math.min(1, Math.max(0, heat / w.rampShots)));
  return 1000 / w.rps;
}
/**
 * 현재 탄퍼짐(반각, 도). 이동/점프로 인한 증가 없음.
 * 예외: 마샬 노줌(hip) → 탄퍼짐 극대화.
 */
export function spreadDeg(w: GunDef, o: { spray: number; ads: boolean; scoped: boolean; alt?: boolean }): number {
  if (w.spread.hip !== undefined && !o.scoped) return w.spread.hip;
  if (o.alt && w.alt) return w.alt.spread;
  return Math.min(w.spread.max, w.spread.base + w.spread.perShot * o.spray) * (o.ads && w.adsSpread ? w.adsSpread : 1);
}

// ───────────────────────────── 게임 규칙 (server RULES / MOVE 미러) ─────────────────────────────
export const RULES = {
  hp: 150, tickHz: 30, snapMs: 50, interpDelayMs: 100,
  roundsToWin: 5, buyMs: 8000, roundMs: 100000, roundEndMs: 4500, endMs: 12000,
  tdmWarmupMs: 5000, tdmTimeMs: 600000, tdmKillsPerPlayer: 10, tdmRespawnMs: 250, spawnProtectMs: 1500,
  loadoutWindowMs: 5000, rangeRespawnMs: 1500, inputHz: 30,
} as const;

export const MOVE = {
  run: 6.6, accelGround: 70, accelAir: 22, friction: 9, gravity: 22, jumpV: 7.6,
  crouchMult: 0.55, adsMult: 0.78,
  slideV: 12.5, slideMs: 750, slideFriction: 1.6, slideCooldownMs: 150,   // C: 횟수 제한 없는 슬라이딩
  updraftV: 17,                                                            // Q: 수직 상승
  dashMult: 1.6, dashMs: 3000,                                             // E: 3초 가속
  skillCdMs: 7000,
  eye: 1.6, eyeCrouch: 1.0, radius: 0.4, height: 1.8, heightCrouch: 1.15, stepHeight: 0.35,
} as const;

export const THROW = { gravity: 20, radius: 0.12, cooldownMs: 900 } as const;

/** 스냅샷 플래그 비트 */
export const F = { CROUCH: 1, SLIDE: 2, ADS: 4, AIR: 8, DASH: 16, ALIVE: 32, PROT: 64, RELOAD: 128, FLASHED: 256 } as const;

export type GameMode = 'classic' | 'ranked' | 'tdm' | 'range';
export type MapId = 'grid' | 'arena' | 'range';
export const MODES: Record<GameMode, { name: string; desc: string; teamSizes: number[]; badge?: string }> = {
  classic: { name: '클래식', desc: '라운드제 팀 데스매치 · 5선승 · 랭크 변동 없음 · 방 코드 내전', teamSizes: [1, 2, 3, 4, 5, 6] },
  ranked: { name: '경쟁전', desc: '최대 3v3 · 티어 포인트 변동 · 티어별 AI 봇 매칭', teamSizes: [1, 2, 3], badge: 'BETA' },
  tdm: { name: '팀 데스매치', desc: '즉시 부활 · 목표 킬 선취 승리', teamSizes: [1, 2, 3, 4, 5, 6] },
  range: { name: '사격장', desc: '솔로 연습 · 5m~150m 거리 표시 · 전 무기 테스트', teamSizes: [1] },
};
export const tdmTargetKills = (teamSize: number): number => teamSize * RULES.tdmKillsPerPlayer; // 1v1=10 … 6v6=60
export const RANGE_MARKS = [5, 10, 20, 30, 50, 70, 100, 150] as const;

// ───────────────────────────── 티어 (level 0..17 = Bronze I..Onyx III, 18 Nemesis, 19 Archnemesis) ─────────────────────────────
export const TIER_NAMES = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Onyx'] as const;
export const TIER_NAMES_KO = ['브론즈', '실버', '골드', '플래티넘', '다이아몬드', '오닉스'] as const;
export const TIER_COLORS = ['#b0733c', '#b9c4cf', '#f0c040', '#3fd0c0', '#7fb2ff', '#8a5cff', '#ff3d5e', '#ffffff'] as const;
export const NEMESIS_RP = 3600;
export const ARCHNEMESIS_TOP = 200;

export function tierLevel(rp: number, leaderboardPos?: number | null): number {
  if (rp >= NEMESIS_RP) return leaderboardPos && leaderboardPos <= ARCHNEMESIS_TOP ? 19 : 18;
  return Math.floor(Math.max(0, rp) / 200);
}
export function tierInfo(level: number): { level: number; label: string; labelKo: string; color: string; major: number; division: number } {
  if (level >= 19) return { level, label: 'Archnemesis', labelKo: '아크네메시스', color: TIER_COLORS[7], major: 7, division: 0 };
  if (level === 18) return { level, label: 'Nemesis', labelKo: '네메시스', color: TIER_COLORS[6], major: 6, division: 0 };
  const major = Math.floor(level / 3), division = (level % 3) + 1, roman = 'I'.repeat(division);
  return { level, label: `${TIER_NAMES[major]} ${roman}`, labelKo: `${TIER_NAMES_KO[major]} ${roman}`, color: TIER_COLORS[major], major, division };
}
/** 현재 디비전 내 진행도 0..1 과 다음 승급까지 남은 RP */
export function tierProgress(rp: number): { progress: number; toNext: number } {
  if (rp >= NEMESIS_RP) return { progress: 1, toNext: 0 };
  const into = Math.max(0, rp) % 200;
  return { progress: into / 200, toNext: 200 - into };
}

/** forward 벡터 (yaw=0 → -Z) — 서버와 동일 규약 */
export function dirFromAngles(yaw: number, pitch: number): { x: number; y: number; z: number } {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}