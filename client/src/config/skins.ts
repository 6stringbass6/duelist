// =====================================================================
// 스킨 데이터(외형/재질/발광)와 랜덤박스 확률표를 분리 설계.
//  - 신규 스킨: COLLECTIONS 에 컬렉션 추가 or EXTRA_SKINS 에 단품 추가
//  - 확률 수정: LOOTBOXES 만 수정
//  - 수정 후 `npm run gen:skin-seed` → 출력된 SQL 을 Supabase SQL Editor 에서 실행 (가격/확률의 서버 권위 = DB)
// skin_id 규칙: <collection>_<weapon>
// =====================================================================
import type { WeaponId } from './weapons';

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic';
export type SkinWeaponId = Exclude<WeaponId, 'fists' | 'grenade' | 'flash'>;
export type SkinPattern = 'solid' | 'gradient' | 'stripes' | 'hex' | 'carbon' | 'wave' | 'circuit' | 'petals' | 'cracks' | 'stars';
export type ModelVariant = 'default' | 'angular' | 'sleek' | 'heavy' | 'ornate';

export interface SkinMaterial {
  baseColor: number; accentColor: number; metalness: number; roughness: number;
  pattern: SkinPattern; patternColor: number; patternScale: number; clearcoat?: number;
}
export interface SkinEmissive { color: number; intensity: number; mode: 'none' | 'static' | 'pulse' | 'flow'; speed?: number }
export interface SkinVfx { tracerColor?: number; muzzleColor?: number; killEffect?: 'none' | 'shatter' | 'burn' | 'freeze' | 'void' | 'gold' | 'nova'; trail?: boolean }
export interface SkinDef {
  id: string; collection: string; weaponId: SkinWeaponId; name: string; rarity: Rarity; price: number;
  featured: boolean; inDaily: boolean; inBox: boolean; sort: number;
  model: ModelVariant; material: SkinMaterial; emissive: SkinEmissive; vfx: SkinVfx;
}

export const RARITY: Record<Rarity, { name: string; color: string; order: number }> = {
  common: { name: '일반', color: '#9aa4b1', order: 0 },
  rare: { name: '희귀', color: '#4aa3ff', order: 1 },
  epic: { name: '영웅', color: '#b06bff', order: 2 },
  legendary: { name: '전설', color: '#ffb23e', order: 3 },
  mythic: { name: '신화', color: '#ff4d6d', order: 4 },
};

export const SKIN_WEAPONS: { id: SkinWeaponId; name: string }[] = [
  { id: 'dagger', name: '단검' }, { id: 'sword', name: '장검' },
  { id: 'classic', name: '클래식' }, { id: 'shorty', name: '쇼티' }, { id: 'frenzy', name: '프렌지' }, { id: 'ghost', name: '고스트' }, { id: 'sheriff', name: '셰리프' },
  { id: 'vandal', name: '밴달' }, { id: 'phantom', name: '팬텀' }, { id: 'marshal', name: '마샬' },
];
const ALL_WEAPONS = SKIN_WEAPONS.map((w) => w.id);

// ───────────────────────────── 1) 스킨 컬렉션 (외형/재질/발광) ─────────────────────────────
interface CollectionDef {
  id: string; name: string; rarity: Rarity; price: number; featured?: boolean; sort: number;
  weapons?: SkinWeaponId[]; model: ModelVariant; material: SkinMaterial; emissive: SkinEmissive; vfx: SkinVfx;
  blurb: string;
}

export const COLLECTIONS: CollectionDef[] = [
  { id: 'carbon', name: '카본', rarity: 'common', price: 600, sort: 1, model: 'default', blurb: '무광 카본 파이버 마감.',
    material: { baseColor: 0x1b1d21, accentColor: 0x3a3f47, metalness: 0.35, roughness: 0.55, pattern: 'carbon', patternColor: 0x2a2e35, patternScale: 12 },
    emissive: { color: 0x000000, intensity: 0, mode: 'none' }, vfx: {} },
  { id: 'tundra', name: '툰드라', rarity: 'common', price: 600, sort: 2, model: 'default', blurb: '설원 위장 도색.',
    material: { baseColor: 0xdfe6ec, accentColor: 0x8fa1b3, metalness: 0.1, roughness: 0.8, pattern: 'stripes', patternColor: 0xaab8c5, patternScale: 5 },
    emissive: { color: 0x000000, intensity: 0, mode: 'none' }, vfx: { tracerColor: 0xe8f4ff } },
  { id: 'neon', name: '네온 서킷', rarity: 'rare', price: 1100, sort: 3, model: 'angular', blurb: '회로 패턴을 따라 흐르는 네온.',
    material: { baseColor: 0x0d1020, accentColor: 0x1b2340, metalness: 0.6, roughness: 0.35, pattern: 'circuit', patternColor: 0x00f0ff, patternScale: 8 },
    emissive: { color: 0x00f0ff, intensity: 1.4, mode: 'flow', speed: 0.6 }, vfx: { tracerColor: 0x00f0ff, muzzleColor: 0x66f7ff } },
  { id: 'sakura', name: '사쿠라', rarity: 'rare', price: 1100, sort: 4, model: 'sleek', blurb: '흩날리는 벚꽃잎 자개 마감.',
    material: { baseColor: 0xfff0f5, accentColor: 0xff8fb3, metalness: 0.25, roughness: 0.4, pattern: 'petals', patternColor: 0xff6f9f, patternScale: 6, clearcoat: 0.6 },
    emissive: { color: 0xff9fc0, intensity: 0.5, mode: 'static' }, vfx: { tracerColor: 0xffb7d0, killEffect: 'shatter' } },
  { id: 'magma', name: '마그마', rarity: 'epic', price: 1900, sort: 5, model: 'heavy', blurb: '균열 사이로 용암이 맥동한다.',
    material: { baseColor: 0x17110f, accentColor: 0x3a1c12, metalness: 0.3, roughness: 0.7, pattern: 'cracks', patternColor: 0xff5a1f, patternScale: 7 },
    emissive: { color: 0xff4a10, intensity: 2.0, mode: 'pulse', speed: 0.8 }, vfx: { tracerColor: 0xff7a30, muzzleColor: 0xffa040, killEffect: 'burn' } },
  { id: 'glacier', name: '글래시어', rarity: 'epic', price: 1900, sort: 6, model: 'angular', blurb: '반투명 빙결 크리스털.',
    material: { baseColor: 0xbfe9ff, accentColor: 0x5fb8e8, metalness: 0.15, roughness: 0.12, pattern: 'gradient', patternColor: 0xffffff, patternScale: 3, clearcoat: 1 },
    emissive: { color: 0x7fd8ff, intensity: 1.1, mode: 'static' }, vfx: { tracerColor: 0x9fe4ff, killEffect: 'freeze' } },
  { id: 'void', name: '보이드', rarity: 'legendary', price: 3200, sort: 7, model: 'sleek', blurb: '공허의 별빛이 표면을 유영한다.',
    material: { baseColor: 0x07040f, accentColor: 0x2a0f55, metalness: 0.8, roughness: 0.2, pattern: 'stars', patternColor: 0xb48cff, patternScale: 10, clearcoat: 0.8 },
    emissive: { color: 0x9a5cff, intensity: 2.2, mode: 'flow', speed: 0.35 }, vfx: { tracerColor: 0xa070ff, muzzleColor: 0xc8a8ff, killEffect: 'void', trail: true } },
  { id: 'aurum', name: '아우룸', rarity: 'legendary', price: 3200, sort: 8, model: 'ornate', blurb: '순금 세공과 흑요석 인레이.',
    material: { baseColor: 0xd9a520, accentColor: 0x15120c, metalness: 1.0, roughness: 0.18, pattern: 'hex', patternColor: 0xfff0a8, patternScale: 9, clearcoat: 0.5 },
    emissive: { color: 0xffd45a, intensity: 0.8, mode: 'pulse', speed: 0.4 }, vfx: { tracerColor: 0xffd86a, killEffect: 'gold', trail: true } },
  { id: 'singularity', name: '싱귤래리티', rarity: 'mythic', price: 5500, featured: true, sort: 9, model: 'angular', blurb: '신규 출시 — 사건의 지평선을 두른 무기.',
    material: { baseColor: 0x050508, accentColor: 0xff2d6a, metalness: 0.9, roughness: 0.1, pattern: 'wave', patternColor: 0x3df2ff, patternScale: 4, clearcoat: 1 },
    emissive: { color: 0xff2d6a, intensity: 3.0, mode: 'flow', speed: 1.0 }, vfx: { tracerColor: 0xff4d8a, muzzleColor: 0x3df2ff, killEffect: 'nova', trail: true } },
];

/** 컬렉션에 속하지 않는 단품 스킨은 여기에 추가 */
export const EXTRA_SKINS: SkinDef[] = [];

const weaponName = (id: SkinWeaponId): string => SKIN_WEAPONS.find((w) => w.id === id)!.name;

export const SKINS: SkinDef[] = [
  ...COLLECTIONS.flatMap((c) =>
    (c.weapons ?? ALL_WEAPONS).map<SkinDef>((w) => ({
      id: `${c.id}_${w}`, collection: c.id, weaponId: w, name: `${c.name} ${weaponName(w)}`, rarity: c.rarity, price: c.price,
      featured: !!c.featured, inDaily: !c.featured, inBox: !c.featured, sort: c.sort,
      model: c.model, material: c.material, emissive: c.emissive, vfx: c.vfx,
    })),
  ),
  ...EXTRA_SKINS,
];

const SKIN_MAP = new Map(SKINS.map((s) => [s.id, s]));
export const getSkin = (id: string | null | undefined): SkinDef | null => (id ? SKIN_MAP.get(id) ?? null : null);
export const skinsForWeapon = (weaponId: string): SkinDef[] => SKINS.filter((s) => s.weaponId === weaponId);
export const featuredSkins = (): SkinDef[] => SKINS.filter((s) => s.featured);
export const getCollection = (id: string): CollectionDef | undefined => COLLECTIONS.find((c) => c.id === id);
/** 상점 메인 Featured 배너 데이터 */
export const FEATURED_BANNER = (() => {
  const c = COLLECTIONS.find((x) => x.featured);
  return c ? { collectionId: c.id, title: c.name, blurb: c.blurb, rarity: c.rarity, price: c.price, accent: c.emissive.color } : null;
})();

/** 스킨 미장착 시 기본 외형 */
export const DEFAULT_SKIN: Pick<SkinDef, 'model' | 'material' | 'emissive' | 'vfx'> = {
  model: 'default',
  material: { baseColor: 0x2b2f36, accentColor: 0x4b525c, metalness: 0.55, roughness: 0.45, pattern: 'solid', patternColor: 0x2b2f36, patternScale: 1 },
  emissive: { color: 0x000000, intensity: 0, mode: 'none' },
  vfx: {},
};

// ───────────────────────────── 2) 랜덤박스 확률표 (스킨 데이터와 독립) ─────────────────────────────
export interface LootboxDef { id: string; name: string; price: number; rates: Record<Rarity, number> }
export const LOOTBOXES: Record<string, LootboxDef> = {
  standard: { id: 'standard', name: '스탠다드 박스', price: 800, rates: { common: 55, rare: 28, epic: 12, legendary: 4.2, mythic: 0.8 } },
  premium: { id: 'premium', name: '프리미엄 박스', price: 2000, rates: { common: 20, rare: 40, epic: 27, legendary: 10, mythic: 3 } },
};
/** 중복 획득 시 크레딧 환급액 */
export const DUP_REFUND: Record<Rarity, number> = { common: 150, rare: 300, epic: 600, legendary: 1200, mythic: 2500 };

/** 확률표(%)로 정규화 — 상점의 확률 공개 UI용 */
export function lootboxOdds(boxId: string): { rarity: Rarity; percent: number }[] {
  const box = LOOTBOXES[boxId]; if (!box) return [];
  const total = Object.values(box.rates).reduce((a, b) => a + b, 0);
  return (Object.keys(box.rates) as Rarity[]).map((r) => ({ rarity: r, percent: Math.round((box.rates[r] / total) * 10000) / 100 }));
}
/** 가챠 연출용 릴(실제 결과는 서버 open_lootbox 가 결정). 마지막에서 4번째 칸에 결과가 오도록 구성 */
export function buildGachaReel(resultSkinId: string, length = 40): SkinDef[] {
  const pool = SKINS.filter((s) => s.inBox), reel: SkinDef[] = [];
  for (let i = 0; i < length; i++) reel.push(pool[Math.floor(Math.random() * pool.length)]);
  const result = getSkin(resultSkinId); if (result) reel[length - 4] = result;
  return reel;
}

// ───────────────────────────── 3) DB 시드 생성 (skin_catalog / lootboxes / lootbox_rates) ─────────────────────────────
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
export function catalogSeedSql(): string {
  const skins = SKINS.map((s) => `  (${q(s.id)}, ${q(s.weaponId)}, ${q(s.name)}, ${q(s.rarity)}, ${s.price}, ${s.featured}, ${s.inDaily}, ${s.inBox}, ${s.sort})`).join(',\n');
  const boxes = Object.values(LOOTBOXES).map((b) => `  (${q(b.id)}, ${q(b.name)}, ${b.price})`).join(',\n');
  const rates = Object.values(LOOTBOXES).flatMap((b) => (Object.keys(b.rates) as Rarity[]).map((r) => `  (${q(b.id)}, ${q(r)}, ${b.rates[r]}, ${DUP_REFUND[r]})`)).join(',\n');
  const ids = SKINS.map((s) => q(s.id)).join(', ');
  return [
    'insert into public.skin_catalog (skin_id, weapon_id, name, rarity, price, featured, in_daily, in_box, sort) values',
    skins,
    'on conflict (skin_id) do update set weapon_id = excluded.weapon_id, name = excluded.name, rarity = excluded.rarity, price = excluded.price,',
    '  featured = excluded.featured, in_daily = excluded.in_daily, in_box = excluded.in_box, sort = excluded.sort, active = true;',
    `update public.skin_catalog set active = false where skin_id not in (${ids});`,
    'insert into public.lootboxes (box_id, name, price) values',
    boxes,
    'on conflict (box_id) do update set name = excluded.name, price = excluded.price;',
    'insert into public.lootbox_rates (box_id, rarity, weight, dup_refund) values',
    rates,
    'on conflict (box_id, rarity) do update set weight = excluded.weight, dup_refund = excluded.dup_refund;',
  ].join('\n');
}