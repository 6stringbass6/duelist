// =====================================================================
// 스킨 데이터(외형/재질/발광)와 랜덤박스 확률표를 분리 설계.
//  - 등급: 셀렉트 < 디럭스 < 프리미엄 < 익스클루시브 < 울트라 (TIERS)
//    구버전 등급/ID 는 normalizeTier / resolveSkinId 가 자동 매핑 (DB·소켓·로컬 어디서 와도 동작)
//  - 신규 스킨: COLLECTIONS 에 컬렉션 추가 or EXTRA_SKINS 에 단품 추가
//  - 확률 수정: LOOTBOXES 만 수정
//  - 수정 후 `npm run gen:skin-seed` → 출력된 SQL 을 Supabase SQL Editor 에서 실행 (가격/확률의 서버 권위 = DB)
// skin_id 규칙: <collection>_<weapon>
// =====================================================================
import type { WeaponId } from './weapons';

/** 5단계 에디션 등급 (낮음 → 높음) */
export type Tier = 'select' | 'deluxe' | 'premium' | 'exclusive' | 'ultra';
export type SkinWeaponId = Exclude<WeaponId, 'fists' | 'grenade' | 'flash'>;
/** 프로시저럴 텍스처 스타일 (game/skinTextures.ts 의 페인터와 1:1) */
export type SkinStyle = 'solid' | 'matte' | 'digicamo' | 'steel' | 'anodized' | 'hex' | 'racing' | 'circuit' | 'glitch' | 'gloss' | 'energy' | 'solar' | 'abyss';
export type ModelVariant = 'default' | 'angular' | 'sleek' | 'heavy' | 'ornate';
/** 등급 전용 부착 파츠: wings = 홀로그램 윙(익스클루시브), rings = 에너지 코어 링(울트라) */
export type SkinAttachment = 'none' | 'wings' | 'rings';

export interface SkinMaterial {
  style: SkinStyle; baseColor: number; accentColor: number; patternColor: number;
  metalness: number; roughness: number; clearcoat?: number; clearcoatRoughness?: number;
}
/** mode: energy = 표면을 따라 흐르는 에너지(셰이더), plasma = 용암/성운 유동(셰이더). ambient = 마스크 밖 표면 전체에 깔리는 유동광 비율 */
export interface SkinEmissive { color: number; color2?: number; intensity: number; mode: 'none' | 'static' | 'pulse' | 'flow' | 'energy' | 'plasma'; speed?: number; ambient?: number }
export interface SkinVfx { tracerColor?: number; muzzleColor?: number; killEffect?: 'none' | 'shatter' | 'burn' | 'freeze' | 'void' | 'gold' | 'nova'; trail?: boolean }
/** 외부 GLB/FBX 모델을 그대로 쓰는 스킨(절차적 재질 대신 내장 PBR 텍스처). 값 의미는 game/weaponModels.ts 참고 */
export interface GlbSpec { file: string; length: number; grip?: number; roll?: number }
export interface SkinDef {
  glb?: GlbSpec;
  id: string; collection: string; weaponId: SkinWeaponId; name: string; tier: Tier; price: number;
  featured: boolean; inDaily: boolean; inBox: boolean; sort: number; blurb: string;
  model: ModelVariant; material: SkinMaterial; emissive: SkinEmissive; vfx: SkinVfx;
}

export type TierEmblem = 'circle' | 'diamond' | 'pentagon' | 'triangle' | 'crown';
export interface TierInfo { name: string; en: string; color: string; price: number; order: number; emblem: TierEmblem; perks: string[] }
/** 가격 기준: 5판 기준 매치 보상(승리 1000 / 패배 500 크레딧)에 비례 */
export const TIERS: Record<Tier, TierInfo> = {
  select: { name: '셀렉트', en: 'SELECT', color: '#5a9fd4', price: 600, order: 0, emblem: 'circle', perks: ['전술 도색', 'PBR 재질'] },
  deluxe: { name: '디럭스', en: 'DELUXE', color: '#00b894', price: 1200, order: 1, emblem: 'diamond', perks: ['메탈릭 마감', '입체 패턴'] },
  premium: { name: '프리미엄', en: 'PREMIUM', color: '#e84393', price: 2200, order: 2, emblem: 'pentagon', perks: ['네온 발광', '클리어코트 유광'] },
  exclusive: { name: '익스클루시브', en: 'EXCLUSIVE', color: '#ff7675', price: 3200, order: 3, emblem: 'triangle', perks: ['흐르는 에너지 텍스처', '홀로그램 윙'] },
  ultra: { name: '울트라', en: 'ULTRA', color: '#fdcb6e', price: 4500, order: 4, emblem: 'crown', perks: ['동적 용암/성운 텍스처', '에너지 코어 링', '사격 시 발광 폭증', '전용 총구 섬광'] },
};
export const TIER_ORDER = (Object.keys(TIERS) as Tier[]).sort((a, b) => TIERS[a].order - TIERS[b].order);

/** 구버전 등급 → 5단계 등급 (DB/로컬에 남아 있는 값 자동 호환) */
const LEGACY_TIER: Record<string, Tier> = { common: 'select', uncommon: 'select', rare: 'deluxe', epic: 'premium', legendary: 'exclusive', mythic: 'ultra' };
export function normalizeTier(t: string | null | undefined): Tier {
  const k = String(t ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(TIERS, k) ? (k as Tier) : LEGACY_TIER[k] ?? 'select';
}
export const tierOf = (t: string | null | undefined): TierInfo => TIERS[normalizeTier(t)];

/** 등급 엠블럼 (인라인 SVG): 원형 / 마름모 / 오각형 / 역삼각형 / 왕관 */
export function tierEmblemSvg(tier: string | null | undefined, size = 18): string {
  const t = tierOf(tier), c = t.color, cut = 'fill="#0b0f18" opacity=".55"';
  const shape: Record<TierEmblem, string> = {
    circle: `<circle cx="12" cy="12" r="9" fill="${c}"/><circle cx="12" cy="12" r="4.2" ${cut}/>`,
    diamond: `<path d="M12 1.8 21.5 12 12 22.2 2.5 12Z" fill="${c}"/><path d="M12 7.2 16.4 12 12 16.8 7.6 12Z" ${cut}/>`,
    pentagon: `<path d="M12 2 22 9.4 18.2 21.2H5.8L2 9.4Z" fill="${c}"/><path d="M12 7.4 16.6 10.8 14.8 16.2H9.2L7.4 10.8Z" ${cut}/>`,
    triangle: `<path d="M2 3.5H22L12 21.8Z" fill="${c}"/><path d="M8 7.2H16L12 14.6Z" ${cut}/>`,
    crown: `<path d="M2.5 7.5 7.4 12 12 3.6 16.6 12 21.5 7.5 19.4 19.4H4.6Z" fill="${c}"/><path d="M5 21.4H19" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="14.2" r="2.1" ${cut}/>`,
  };
  return `<svg class="emb" viewBox="0 0 24 24" width="${size}" height="${size}" role="img" aria-label="${t.name}">${shape[t.emblem]}</svg>`;
}

export const SKIN_WEAPONS: { id: SkinWeaponId; name: string }[] = [
  { id: 'dagger', name: '단검' }, { id: 'sword', name: '장검' },
  { id: 'classic', name: '클래식' }, { id: 'shorty', name: '쇼티' }, { id: 'frenzy', name: '프렌지' }, { id: 'ghost', name: '고스트' }, { id: 'sheriff', name: '셰리프' },
  { id: 'vandal', name: '밴달' }, { id: 'phantom', name: '팬텀' }, { id: 'marshal', name: '마샬' },
];
const ALL_WEAPONS = SKIN_WEAPONS.map((w) => w.id);

// ───────────────────────────── 1) 스킨 컬렉션 (외형/재질/발광) ─────────────────────────────
interface CollectionDef {
  id: string; name: string; tier: Tier; price?: number; featured?: boolean; sort: number;
  weapons?: SkinWeaponId[]; model: ModelVariant; material: SkinMaterial; emissive: SkinEmissive; vfx: SkinVfx;
  blurb: string;
}
const NO_GLOW: SkinEmissive = { color: 0x000000, intensity: 0, mode: 'none' };

export const COLLECTIONS: CollectionDef[] = [
  // ── 셀렉트: 전술 매트 코팅 / 디지털 카모 / 브러시드 스틸
  { id: 'matte', name: '택티컬 매트', tier: 'select', sort: 1, model: 'default', blurb: '반사를 죽인 전술 세라믹 매트 코팅.',
    material: { style: 'matte', baseColor: 0x2c3136, accentColor: 0x474e56, patternColor: 0xc9a227, metalness: 0.2, roughness: 0.86 },
    emissive: NO_GLOW, vfx: {} },
  { id: 'digicamo', name: '디지털 카모', tier: 'select', sort: 2, model: 'default', blurb: '픽셀 단위로 쪼갠 디지털 위장 도색.',
    material: { style: 'digicamo', baseColor: 0x5d6852, accentColor: 0x38412f, patternColor: 0x929b7e, metalness: 0.1, roughness: 0.82 },
    emissive: NO_GLOW, vfx: {} },
  { id: 'steel', name: '브러시드 스틸', tier: 'select', sort: 3, model: 'default', blurb: '헤어라인 가공한 스테인리스 스틸.',
    material: { style: 'steel', baseColor: 0xaeb6bf, accentColor: 0x6a747e, patternColor: 0xe6edf4, metalness: 1.0, roughness: 0.42 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xe8f4ff } },
  // ── 디럭스: 아노다이징 메탈릭 / 헥사곤 아머 / 투톤 레이싱
  { id: 'anodized', name: '아노다이즈', tier: 'deluxe', sort: 4, model: 'sleek', blurb: '코발트에서 바이올렛으로 물드는 아노다이징 메탈.',
    material: { style: 'anodized', baseColor: 0x1668d8, accentColor: 0x7a2be0, patternColor: 0x9fd0ff, metalness: 1.0, roughness: 0.3, clearcoat: 0.35, clearcoatRoughness: 0.2 },
    emissive: NO_GLOW, vfx: { tracerColor: 0x7fb4ff } },
  { id: 'hexarmor', name: '헥사 아머', tier: 'deluxe', sort: 5, model: 'angular', blurb: '벌집 구조의 입체 장갑 플레이트.',
    material: { style: 'hex', baseColor: 0x143a33, accentColor: 0x08191a, patternColor: 0x00d9a6, metalness: 0.75, roughness: 0.42, clearcoat: 0.25 },
    emissive: { color: 0x00d9a6, intensity: 0.7, mode: 'static' }, vfx: { tracerColor: 0x4dffd0 } },
  { id: 'racing', name: '투톤 레이싱', tier: 'deluxe', sort: 6, model: 'sleek', blurb: '서킷 리버리를 두른 투톤 유광 도장.',
    material: { style: 'racing', baseColor: 0xd41f2b, accentColor: 0xf1f1ee, patternColor: 0x111317, metalness: 0.45, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.12 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xff6a6a } },
  // ── 프리미엄: 네온 사이버 회로 / 글리치 / 클리어코트 유광
  { id: 'circuit', name: '네온 서킷', tier: 'premium', sort: 7, model: 'angular', blurb: '회로 패턴을 따라 흐르는 네온 신호.',
    material: { style: 'circuit', baseColor: 0x0a0d1c, accentColor: 0xff2bd0, patternColor: 0x00f0ff, metalness: 0.75, roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.08 },
    emissive: { color: 0xffffff, intensity: 1.15, mode: 'flow', speed: 0.6 }, vfx: { tracerColor: 0x00f0ff, muzzleColor: 0x66f7ff } },
  { id: 'glitch', name: '글리치 버스트', tier: 'premium', sort: 8, model: 'angular', blurb: '깨진 신호가 표면 위에서 튀어 오른다.',
    material: { style: 'glitch', baseColor: 0x14101f, accentColor: 0xff3d9a, patternColor: 0x36f5e0, metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06 },
    emissive: { color: 0xffffff, intensity: 1.4, mode: 'pulse', speed: 0.9 }, vfx: { tracerColor: 0xff5fb0, muzzleColor: 0x36f5e0, killEffect: 'shatter' } },
  { id: 'gloss', name: '캔디 크롬', tier: 'premium', sort: 9, model: 'sleek', blurb: '메탈 플레이크 위에 올린 깊은 클리어코트.',
    material: { style: 'gloss', baseColor: 0xd0145f, accentColor: 0x5a17e6, patternColor: 0xffd0ec, metalness: 0.9, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.03 },
    emissive: { color: 0xff5fb0, intensity: 0.5, mode: 'static' }, vfx: { tracerColor: 0xff8fd0 } },
  // ── 익스클루시브: 흐르는 에너지 텍스처 + 홀로그램 윙
  { id: 'flux', name: '플럭스', tier: 'exclusive', sort: 10, model: 'angular', blurb: '장갑 틈새로 에너지가 흐르고, 홀로그램 윙이 떠오른다.',
    material: { style: 'energy', baseColor: 0x11141d, accentColor: 0x2a2f3d, patternColor: 0xff7a59, metalness: 0.85, roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.1 },
    emissive: { color: 0xff5a36, color2: 0xffd27a, intensity: 2.4, mode: 'energy', speed: 0.55 }, vfx: { tracerColor: 0xff8a5c, muzzleColor: 0xffb070, killEffect: 'burn', trail: true } },
  { id: 'aurora', name: '오로라', tier: 'exclusive', sort: 11, model: 'sleek', blurb: '극광이 표면을 유영하는 홀로그램 윙 에디션.',
    material: { style: 'energy', baseColor: 0x071821, accentColor: 0x12323c, patternColor: 0x31e8c0, metalness: 0.85, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.08 },
    emissive: { color: 0x22ffc8, color2: 0x9d7bff, intensity: 2.2, mode: 'energy', speed: 0.4 }, vfx: { tracerColor: 0x7dffe0, muzzleColor: 0xb9a2ff, killEffect: 'freeze', trail: true } },
  // ── 울트라: 솔라 프라임(화이트/골드) / 어비스 코어(다크 퍼플/크림슨)
  { id: 'solar', name: '솔라 프라임', tier: 'ultra', featured: true, sort: 12, model: 'ornate', blurb: '신규 출시 — 백색 세라믹과 황금 인레이 사이로 태양의 용암이 흐른다.',
    material: { style: 'solar', baseColor: 0xf3efe4, accentColor: 0xd9a520, patternColor: 0xfff2b0, metalness: 0.7, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.05 },
    emissive: { color: 0xff9a14, color2: 0xfff3c0, intensity: 2.0, mode: 'plasma', speed: 0.5, ambient: 0.04 }, vfx: { tracerColor: 0xffd86a, muzzleColor: 0xffc23a, killEffect: 'gold', trail: true } },
  { id: 'abyss', name: '어비스 코어', tier: 'ultra', sort: 13, model: 'angular', blurb: '심연의 성운이 균열 사이에서 맥동하는 흑요석 코어.',
    material: { style: 'abyss', baseColor: 0x0c0616, accentColor: 0x3a0f5c, patternColor: 0xff1f4b, metalness: 0.9, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.06 },
    emissive: { color: 0xff1f4b, color2: 0xa24dff, intensity: 1.7, mode: 'plasma', speed: 0.35, ambient: 0.1 }, vfx: { tracerColor: 0xff4d7a, muzzleColor: 0xff2d5a, killEffect: 'void', trail: true } },
];

/** 컬렉션에 속하지 않는 단품 스킨은 여기에 추가 */
export const KARAMBIT_SKIN_ID = 'karambit_dagger';
export const BUTTERFLY_SKIN_ID = 'butterfly_dagger';
export const EXTRA_SKINS: SkinDef[] = [
  // 카람빗 스페셜 박스 전용(0.1%) — 상점/일일/일반 박스에는 나오지 않는다. 단검(근접 3번 슬롯) 전용, karambit.glb 의 내장 케이스 하드닝 PBR 텍스처 사용
  { id: KARAMBIT_SKIN_ID, collection: 'karambit', weaponId: 'dagger', name: '카람빗 (케이스 하드닝)', tier: 'ultra', price: 4500, featured: false, inDaily: false, inBox: false, sort: 14,
    blurb: '열처리로 푸른 대리석 무늬가 번지는 케이스 하드닝 카람빗. 카람빗 스페셜 박스 0.1% 한정.',
    model: 'default', material: { style: 'solid', baseColor: 0x1d4fb8, accentColor: 0xe0b440, patternColor: 0x9fd0ff, metalness: 0.95, roughness: 0.25 },
    emissive: NO_GLOW, vfx: { tracerColor: 0x9fd0ff }, glb: { file: 'karambit.glb', length: 0.27, grip: 0.3, roll: -0.9 } },
  // 버터플라이 나이프 — 상점 NEW(featured) 상시 판매. 단검(근접 3번 슬롯) 전용, butterfly_knife.glb 내장 PBR 재질(스틸 날 + 블랙/레드 핸들) 사용
  // GLB 규약: 날끝 +X, 등날 +Y(위), 핸들 -X — 원본 .blend 에서 Blender 5.3 으로 변환
  { id: BUTTERFLY_SKIN_ID, collection: 'butterfly', weaponId: 'dagger', name: '버터플라이 나이프', tier: 'ultra', price: 4500, featured: true, inDaily: false, inBox: false, sort: 15,
    blurb: '두 갈래 핸들이 펼쳐지는 발리송. 미러 폴리싱 스틸 블레이드에 블랙·레드 핸들.',
    model: 'default', material: { style: 'solid', baseColor: 0xc7cacd, accentColor: 0xbf0505, patternColor: 0x111214, metalness: 0.95, roughness: 0.22 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xff5a5a }, glb: { file: 'butterfly_knife.glb', length: 0.3, grip: 0.3, roll: 0 } },
];

const weaponName = (id: SkinWeaponId): string => SKIN_WEAPONS.find((w) => w.id === id)!.name;

export const SKINS: SkinDef[] = [
  ...COLLECTIONS.flatMap((c) =>
    (c.weapons ?? ALL_WEAPONS).map<SkinDef>((w) => ({
      id: `${c.id}_${w}`, collection: c.id, weaponId: w, name: `${c.name} ${weaponName(w)}`, tier: c.tier, price: c.price ?? TIERS[c.tier].price,
      featured: !!c.featured, inDaily: !c.featured, inBox: !c.featured, sort: c.sort, blurb: c.blurb,
      model: c.model, material: c.material, emissive: c.emissive, vfx: c.vfx,
    })),
  ),
  ...EXTRA_SKINS,
];

/** 구버전 컬렉션 → 신규 컬렉션 (같은 등급대로 승계). DB/소켓/로컬에 남은 구 skin_id 를 그대로 받아도 동작 */
export const LEGACY_COLLECTIONS: Record<string, string> = {
  carbon: 'matte', tundra: 'digicamo', neon: 'hexarmor', sakura: 'anodized', magma: 'glitch', glacier: 'gloss', void: 'aurora', aurum: 'flux', singularity: 'abyss',
};
const SKIN_MAP = new Map(SKINS.map((s) => [s.id, s]));
/** 구 skin_id → 현행 skin_id (이미 현행이거나 알 수 없으면 그대로) */
export function resolveSkinId(id: string | null | undefined): string {
  if (!id || SKIN_MAP.has(id)) return id ?? '';
  const cut = id.indexOf('_'), next = cut > 0 ? LEGACY_COLLECTIONS[id.slice(0, cut)] : undefined;
  return next ? next + id.slice(cut) : id;
}
export const getSkin = (id: string | null | undefined): SkinDef | null => (id ? SKIN_MAP.get(id) ?? SKIN_MAP.get(resolveSkinId(id)) ?? null : null);
export const skinsForWeapon = (weaponId: string): SkinDef[] => SKINS.filter((s) => s.weaponId === weaponId);
export const featuredSkins = (): SkinDef[] => SKINS.filter((s) => s.featured);
export const getCollection = (id: string): CollectionDef | undefined => COLLECTIONS.find((c) => c.id === (LEGACY_COLLECTIONS[id] ?? id));
export const skinAttachment = (s: Pick<SkinDef, 'tier' | 'glb'> | null | undefined): SkinAttachment => (s?.glb ? 'none' : s?.tier === 'ultra' ? 'rings' : s?.tier === 'exclusive' ? 'wings' : 'none');
/** 상점 메인 Featured 배너 데이터 */
export const FEATURED_BANNER = (() => {
  const c = COLLECTIONS.find((x) => x.featured);
  return c ? { collectionId: c.id, title: c.name, blurb: c.blurb, tier: c.tier, price: c.price ?? TIERS[c.tier].price, accent: c.emissive.mode === 'none' ? c.material.baseColor : c.emissive.color } : null;
})();

/** 스킨 미장착 시 기본 외형 */
export const DEFAULT_SKIN: Pick<SkinDef, 'model' | 'material' | 'emissive' | 'vfx'> = {
  model: 'default',
  material: { style: 'solid', baseColor: 0x2b2f36, accentColor: 0x4b525c, patternColor: 0x2b2f36, metalness: 0.55, roughness: 0.45 },
  emissive: NO_GLOW,
  vfx: {},
};

// ───────────────────────────── 2) 랜덤박스 확률표 (스킨 데이터와 독립) ─────────────────────────────
/** jackpot = 등급과 별개로 특정 스킨 1종을 weight(%)로 뽑는 칸 (DB lootbox_rates 에 rarity='karambit' 행으로 저장). gunOnly = 등급 추첨 풀에서 근접(단검/장검) 제외 */
export interface LootboxJackpot { key: string; skinId: string; weight: number; refund: number; label: string }
export interface LootboxDef { id: string; name: string; price: number; rates: Partial<Record<Tier, number>>; jackpot?: LootboxJackpot; gunOnly?: boolean; desc?: string }
export const LOOTBOXES: Record<string, LootboxDef> = {
  standard: { id: 'standard', name: '스탠다드 박스', price: 1000, rates: { select: 55, deluxe: 28, premium: 12, exclusive: 4.2, ultra: 0.8 } },
  premium: { id: 'premium', name: '프리미엄 박스', price: 2000, rates: { select: 20, deluxe: 40, premium: 27, exclusive: 10, ultra: 3 } },
  karambit: {
    id: 'karambit', name: '카람빗 스페셜 박스', price: 4000, gunOnly: true, desc: '총기 스킨 전용 · 셀렉트 등급 제외 · 0.1% 확률로 단검 카람빗 등장',
    rates: { deluxe: 45, premium: 35, exclusive: 15, ultra: 4.9 },
    jackpot: { key: 'karambit', skinId: KARAMBIT_SKIN_ID, weight: 0.1, refund: 2000, label: '단검: 카람빗' },
  },
};
/** 중복 획득 시 크레딧 환급액 (등급 가격의 25%) */
export const DUP_REFUND: Record<Tier, number> = { select: 150, deluxe: 300, premium: 550, exclusive: 800, ultra: 1125 };

export interface OddsRow { key: string; label: string; color: string; percent: number; tier?: Tier; jackpot?: boolean }
/** 확률표(%)로 정규화 — 상점의 확률 공개 UI용 (잭팟 칸이 있으면 맨 앞, 나머지는 높은 등급부터) */
export function lootboxOdds(boxId: string): OddsRow[] {
  const box = LOOTBOXES[boxId]; if (!box) return [];
  const jp = box.jackpot, total = TIER_ORDER.reduce((a, t) => a + (box.rates[t] ?? 0), 0) + (jp?.weight ?? 0), pct = (w: number): number => Math.round((w / total) * 10000) / 100;
  const rows: OddsRow[] = TIER_ORDER.filter((t) => (box.rates[t] ?? 0) > 0).map((t) => ({ key: t, label: TIERS[t].name, color: TIERS[t].color, percent: pct(box.rates[t]!), tier: t }));
  if (!jp) return rows;
  return [{ key: jp.key, label: jp.label, color: '#ffd23f', percent: pct(jp.weight), jackpot: true }, ...rows.reverse()];
}
/** 가챠 연출용 릴(실제 결과는 서버 open_lootbox 가 결정). 마지막에서 4번째 칸에 결과가 오도록 구성 */
export function buildGachaReel(resultSkinId: string, length = 40, boxId = ''): SkinDef[] {
  const box = LOOTBOXES[boxId], pool = SKINS.filter((s) => s.inBox && !(box?.gunOnly && (s.weaponId === 'dagger' || s.weaponId === 'sword'))), reel: SkinDef[] = [];
  for (let i = 0; i < length; i++) reel.push(pool[Math.floor(Math.random() * pool.length)]);
  const jp = box?.jackpot && getSkin(box.jackpot.skinId); if (jp) for (const k of [5, 13, 22, 31]) reel[k] = jp; // 연출용 카람빗 노출(실제 확률과 무관)
  const result = getSkin(resultSkinId); if (result) reel[length - 4] = result;
  return reel;
}

// ───────────────────────────── 3) DB 시드 생성 (skin_catalog / lootboxes / lootbox_rates) ─────────────────────────────
// 구버전 등급 제약·보유 스킨 ID 이관은 supabase_schema.sql 의 "5단계 등급 마이그레이션" 블록이 담당 (이 시드보다 먼저 1회 실행)
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
export function catalogSeedSql(): string {
  const skins = SKINS.map((s) => `  (${q(s.id)}, ${q(s.weaponId)}, ${q(s.name)}, ${q(s.tier)}, ${s.price}, ${s.featured}, ${s.inDaily}, ${s.inBox}, ${s.sort})`).join(',\n');
  const boxes = Object.values(LOOTBOXES).map((b) => `  (${q(b.id)}, ${q(b.name)}, ${b.price})`).join(',\n');
  const rates = Object.values(LOOTBOXES).flatMap((b) => [...TIER_ORDER.map((r) => `  (${q(b.id)}, ${q(r)}, ${b.rates[r] ?? 0}, ${DUP_REFUND[r]})`), ...(b.jackpot ? [`  (${q(b.id)}, ${q(b.jackpot.key)}, ${b.jackpot.weight}, ${b.jackpot.refund})`] : [])]).join(',\n');
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
    `delete from public.lootbox_rates where rarity not in (${[...TIER_ORDER, 'karambit'].map(q).join(', ')});`,
    'insert into public.lootbox_rates (box_id, rarity, weight, dup_refund) values',
    rates,
    'on conflict (box_id, rarity) do update set weight = excluded.weight, dup_refund = excluded.dup_refund;',
  ].join('\n');
}
