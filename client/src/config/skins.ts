// =====================================================================
// 스킨 데이터(외형/재질/발광)와 랜덤박스 확률표를 분리 설계.
//  - 등급(CS2 희귀도): 기본 < 평범한 < 쓸만한 < 군용 < 제한된 < 비밀의 < 은밀한 < ★대단히 보기드문 < 밀수품 (TIERS)
//    구버전 등급/ID 는 normalizeTier / resolveSkinId 가 자동 매핑 (DB·소켓·로컬 어디서 와도 동작)
//  - 신규 스킨: COLLECTIONS 에 컬렉션 추가 or EXTRA_SKINS 에 단품 추가
//  - 확률 수정: LOOTBOXES 만 수정
//  - 수정 후 `npm run gen:skin-seed` → 출력된 SQL 을 Supabase SQL Editor 에서 실행 (가격/확률의 서버 권위 = DB)
// skin_id 규칙: <collection>_<weapon>
// =====================================================================
import type { WeaponId } from './weapons';

/** CS2 희귀도 체계 (낮음 → 높음). exrare = 대단히 보기드문 무기(★), contraband = 밀수품(등급 정의만 존재, 배정된 스킨 없음) */
export type Tier = 'default' | 'consumer' | 'industrial' | 'milspec' | 'restricted' | 'classified' | 'covert' | 'exrare' | 'contraband';
export type SkinWeaponId = Exclude<WeaponId, 'fists' | 'grenade' | 'flash'>;
/** 프로시저럴 텍스처 스타일 (game/skinTextures.ts 의 페인터와 1:1) */
export type SkinStyle = 'solid' | 'matte' | 'digicamo' | 'steel' | 'anodized' | 'hex' | 'racing' | 'circuit' | 'glitch' | 'gloss' | 'energy' | 'solar' | 'abyss';
export type ModelVariant = 'default' | 'angular' | 'sleek' | 'heavy' | 'ornate';
/** 스킨별 부착 파츠: wings = 홀로그램 윙, rings = 에너지 코어 링 + 사격 발광 폭증 (등급과 무관하게 스킨 데이터에서 지정) */
export type SkinAttachment = 'none' | 'wings' | 'rings';

export interface SkinMaterial {
  style: SkinStyle; baseColor: number; accentColor: number; patternColor: number;
  metalness: number; roughness: number; clearcoat?: number; clearcoatRoughness?: number;
}
/** mode: energy = 표면을 따라 흐르는 에너지(셰이더), plasma = 용암/성운 유동(셰이더). ambient = 마스크 밖 표면 전체에 깔리는 유동광 비율 */
export interface SkinEmissive { color: number; color2?: number; intensity: number; mode: 'none' | 'static' | 'pulse' | 'flow' | 'energy' | 'plasma'; speed?: number; ambient?: number }
export interface SkinVfx { tracerColor?: number; muzzleColor?: number; killEffect?: 'none' | 'shatter' | 'burn' | 'freeze' | 'void' | 'gold' | 'nova'; trail?: boolean }
/** 외부 GLB/FBX 모델을 그대로 쓰는 스킨(절차적 재질 대신 내장 PBR 텍스처). 값 의미는 game/weaponModels.ts 참고 */
export interface GlbSpec { file: string; length: number; grip?: number; roll?: number; own?: boolean; rot?: [number, number, number]; variant?: string; native?: boolean }
export interface SkinDef {
  glb?: GlbSpec; attach?: SkinAttachment;
  /** CS2 패턴 시드 (표면 경화 등) — 지정 스킨은 획득 시 항상 이 값, UI 에 `패턴 #N` 표기 */
  patternSeed?: number;
  id: string; collection: string; weaponId: SkinWeaponId; name: string; tier: Tier; price: number;
  featured: boolean; inDaily: boolean; inBox: boolean; sort: number; blurb: string;
  model: ModelVariant; material: SkinMaterial; emissive: SkinEmissive; vfx: SkinVfx;
}

export type TierEmblem = 'circle' | 'square' | 'diamond' | 'pentagon' | 'triangle' | 'crown' | 'star' | 'hex';
export interface TierInfo { name: string; en: string; color: string; price: number; order: number; emblem: TierEmblem; perks: string[] }
/** price = 해당 등급의 기준가(컬렉션이 price 를 직접 지정하면 그 값이 우선). 가격 기준: 5판 기준 매치 보상(승리 1000 / 패배 500 크레딧)에 비례 */
export const TIERS: Record<Tier, TierInfo> = {
  default: { name: '기본 무기', en: 'DEFAULT', color: '#8b949e', price: 0, order: 0, emblem: 'circle', perks: ['기본 지급 외형'] },
  consumer: { name: '평범한 무기', en: 'CONSUMER', color: '#b0c3d9', price: 600, order: 1, emblem: 'circle', perks: ['단색 매트 도색'] },
  industrial: { name: '쓸만한 무기', en: 'INDUSTRIAL', color: '#5e98d9', price: 600, order: 2, emblem: 'square', perks: ['기본 패턴 도색'] },
  milspec: { name: '군용 무기', en: 'MIL-SPEC', color: '#4b69ff', price: 900, order: 3, emblem: 'diamond', perks: ['금속 · 유광 마감'] },
  restricted: { name: '제한된 무기', en: 'RESTRICTED', color: '#8847ff', price: 1500, order: 4, emblem: 'pentagon', perks: ['메탈릭 · 입체 패턴', '발광 포인트'] },
  classified: { name: '비밀의 무기', en: 'CLASSIFIED', color: '#d32ce6', price: 2200, order: 5, emblem: 'triangle', perks: ['네온 · 글리치 발광', '클리어코트 유광'] },
  covert: { name: '은밀한 무기', en: 'COVERT', color: '#eb4b4b', price: 3600, order: 6, emblem: 'crown', perks: ['실시간 유동 셰이더', '강한 발광', '특수 3D 파츠'] },
  exrare: { name: '대단히 보기드문 무기', en: 'EXCEEDINGLY RARE ★', color: '#e4ae39', price: 4500, order: 7, emblem: 'star', perks: ['희귀 근접무기 전용'] },
  contraband: { name: '밀수품', en: 'CONTRABAND', color: '#ffae39', price: 5000, order: 8, emblem: 'hex', perks: ['단종 · 한정 (현재 배정 스킨 없음)'] },
};
export const TIER_ORDER = (Object.keys(TIERS) as Tier[]).sort((a, b) => TIERS[a].order - TIERS[b].order);

/** 구버전 등급 키(5단계 select..ultra · 그 이전 common..mythic · 'karambit' 잭팟 칸) → CS2 등급 (DB/로컬에 남아 있는 값 자동 호환) */
const LEGACY_TIER: Record<string, Tier> = {
  common: 'consumer', uncommon: 'industrial', rare: 'milspec', epic: 'classified', legendary: 'covert', mythic: 'covert',
  select: 'consumer', deluxe: 'milspec', premium: 'classified', exclusive: 'covert', ultra: 'covert', karambit: 'exrare',
};
export function normalizeTier(t: string | null | undefined): Tier {
  const k = String(t ?? '').toLowerCase();
  return Object.prototype.hasOwnProperty.call(TIERS, k) ? (k as Tier) : Object.prototype.hasOwnProperty.call(LEGACY_TIER, k) ? LEGACY_TIER[k] : 'consumer';
}
export const tierOf = (t: string | null | undefined): TierInfo => TIERS[normalizeTier(t)];

/** 등급 엠블럼 (인라인 SVG): 원형 / 사각 / 마름모 / 오각형 / 역삼각형 / 왕관 / 별 / 육각 */
export function tierEmblemSvg(tier: string | null | undefined, size = 18): string {
  const t = tierOf(tier), c = t.color, cut = 'fill="#0b0f18" opacity=".55"';
  const shape: Record<TierEmblem, string> = {
    circle: `<circle cx="12" cy="12" r="9" fill="${c}"/><circle cx="12" cy="12" r="4.2" ${cut}/>`,
    square: `<rect x="3.5" y="3.5" width="17" height="17" rx="2.4" fill="${c}"/><rect x="8.4" y="8.4" width="7.2" height="7.2" rx="1" ${cut}/>`,
    star: `<path d="M12 1.8 14.9 8.6 22.2 9.2 16.6 14 18.4 21.2 12 17.4 5.6 21.2 7.4 14 1.8 9.2 9.1 8.6Z" fill="${c}"/><circle cx="12" cy="12.4" r="2.3" ${cut}/>`,
    hex: `<path d="M12 2 20.8 7v10L12 22 3.2 17V7Z" fill="${c}"/><path d="M12 7.2 16.4 9.7v4.6L12 16.8 7.6 14.3V9.7Z" ${cut}/>`,
    diamond: `<path d="M12 1.8 21.5 12 12 22.2 2.5 12Z" fill="${c}"/><path d="M12 7.2 16.4 12 12 16.8 7.6 12Z" ${cut}/>`,
    pentagon: `<path d="M12 2 22 9.4 18.2 21.2H5.8L2 9.4Z" fill="${c}"/><path d="M12 7.4 16.6 10.8 14.8 16.2H9.2L7.4 10.8Z" ${cut}/>`,
    triangle: `<path d="M2 3.5H22L12 21.8Z" fill="${c}"/><path d="M8 7.2H16L12 14.6Z" ${cut}/>`,
    crown: `<path d="M2.5 7.5 7.4 12 12 3.6 16.6 12 21.5 7.5 19.4 19.4H4.6Z" fill="${c}"/><path d="M5 21.4H19" stroke="${c}" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="14.2" r="2.1" ${cut}/>`,
  };
  return `<svg class="emb" viewBox="0 0 24 24" width="${size}" height="${size}" role="img" aria-label="${t.name}">${shape[t.emblem]}</svg>`;
}

export const SKIN_WEAPONS: { id: SkinWeaponId; name: string }[] = [
  { id: 'dagger', name: '단검' }, { id: 'sword', name: '장검' },
  { id: 'classic', name: '클래식' }, { id: 'shorty', name: '쇼티' }, { id: 'frenzy', name: '프렌지' }, { id: 'ghost', name: '고스트' }, { id: 'sheriff', name: '디글' },
  { id: 'vandal', name: 'AK-47' }, { id: 'phantom', name: '팬텀' }, { id: 'marshal', name: '마샬' },
];
const ALL_WEAPONS = SKIN_WEAPONS.map((w) => w.id);

// ───────────────────────────── 1) 스킨 컬렉션 (외형/재질/발광) ─────────────────────────────
interface CollectionDef {
  id: string; name: string; tier: Tier; price?: number; attach?: SkinAttachment; featured?: boolean; sort: number;
  weapons?: SkinWeaponId[]; model: ModelVariant; material: SkinMaterial; emissive: SkinEmissive; vfx: SkinVfx;
  blurb: string;
}
const NO_GLOW: SkinEmissive = { color: 0x000000, intensity: 0, mode: 'none' };

export const COLLECTIONS: CollectionDef[] = [
  // ── 평범한/쓸만한/군용: 전술 매트(Consumer) / 디지털 카모(Industrial) / 브러시드 스틸 · 투톤 레이싱(Mil-Spec)
  { id: 'matte', name: '택티컬 매트', tier: 'consumer', price: 600, sort: 1, model: 'default', blurb: '반사를 죽인 전술 세라믹 매트 코팅.',
    material: { style: 'matte', baseColor: 0x2c3136, accentColor: 0x474e56, patternColor: 0xc9a227, metalness: 0.2, roughness: 0.86 },
    emissive: NO_GLOW, vfx: {} },
  { id: 'digicamo', name: '디지털 카모', tier: 'industrial', price: 600, sort: 2, model: 'default', blurb: '픽셀 단위로 쪼갠 디지털 위장 도색.',
    material: { style: 'digicamo', baseColor: 0x5d6852, accentColor: 0x38412f, patternColor: 0x929b7e, metalness: 0.1, roughness: 0.82 },
    emissive: NO_GLOW, vfx: {} },
  { id: 'steel', name: '브러시드 스틸', tier: 'milspec', price: 600, sort: 3, model: 'default', blurb: '헤어라인 가공한 스테인리스 스틸.',
    material: { style: 'steel', baseColor: 0xaeb6bf, accentColor: 0x6a747e, patternColor: 0xe6edf4, metalness: 1.0, roughness: 0.42 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xe8f4ff } },
  // ── 제한된(Restricted): 아노다이징 · 헥사 아머 · 캔디 크롬 (메탈릭 + 포인트 발광)
  { id: 'anodized', name: '아노다이즈', tier: 'restricted', price: 1200, sort: 4, model: 'sleek', blurb: '코발트에서 바이올렛으로 물드는 아노다이징 메탈.',
    material: { style: 'anodized', baseColor: 0x1668d8, accentColor: 0x7a2be0, patternColor: 0x9fd0ff, metalness: 1.0, roughness: 0.3, clearcoat: 0.35, clearcoatRoughness: 0.2 },
    emissive: NO_GLOW, vfx: { tracerColor: 0x7fb4ff } },
  { id: 'hexarmor', name: '헥사 아머', tier: 'restricted', price: 1200, sort: 5, model: 'angular', blurb: '벌집 구조의 입체 장갑 플레이트.',
    material: { style: 'hex', baseColor: 0x143a33, accentColor: 0x08191a, patternColor: 0x00d9a6, metalness: 0.75, roughness: 0.42, clearcoat: 0.25 },
    emissive: { color: 0x00d9a6, intensity: 0.7, mode: 'static' }, vfx: { tracerColor: 0x4dffd0 } },
  { id: 'racing', name: '투톤 레이싱', tier: 'milspec', price: 1200, sort: 6, model: 'sleek', blurb: '서킷 리버리를 두른 투톤 유광 도장.',
    material: { style: 'racing', baseColor: 0xd41f2b, accentColor: 0xf1f1ee, patternColor: 0x111317, metalness: 0.45, roughness: 0.3, clearcoat: 0.7, clearcoatRoughness: 0.12 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xff6a6a } },
  // ── 비밀의(Classified): 네온 서킷 / 글리치 버스트 (네온 흐름 · 펄스 발광)
  { id: 'circuit', name: '네온 서킷', tier: 'classified', price: 2200, sort: 7, model: 'angular', blurb: '회로 패턴을 따라 흐르는 네온 신호.',
    material: { style: 'circuit', baseColor: 0x0a0d1c, accentColor: 0xff2bd0, patternColor: 0x00f0ff, metalness: 0.75, roughness: 0.3, clearcoat: 0.9, clearcoatRoughness: 0.08 },
    emissive: { color: 0xffffff, intensity: 1.15, mode: 'flow', speed: 0.6 }, vfx: { tracerColor: 0x00f0ff, muzzleColor: 0x66f7ff } },
  { id: 'glitch', name: '글리치 버스트', tier: 'classified', price: 2200, sort: 8, model: 'angular', blurb: '깨진 신호가 표면 위에서 튀어 오른다.',
    material: { style: 'glitch', baseColor: 0x14101f, accentColor: 0xff3d9a, patternColor: 0x36f5e0, metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.06 },
    emissive: { color: 0xffffff, intensity: 1.4, mode: 'pulse', speed: 0.9 }, vfx: { tracerColor: 0xff5fb0, muzzleColor: 0x36f5e0, killEffect: 'shatter' } },
  { id: 'gloss', name: '캔디 크롬', tier: 'restricted', price: 2200, sort: 9, model: 'sleek', blurb: '메탈 플레이크 위에 올린 깊은 클리어코트.',
    material: { style: 'gloss', baseColor: 0xd0145f, accentColor: 0x5a17e6, patternColor: 0xffd0ec, metalness: 0.9, roughness: 0.16, clearcoat: 1, clearcoatRoughness: 0.03 },
    emissive: { color: 0xff5fb0, intensity: 0.5, mode: 'static' }, vfx: { tracerColor: 0xff8fd0 } },
  // ── 은밀한(Covert): 플럭스·오로라 = 에너지 셰이더 + 홀로그램 윙 / 솔라 프라임·어비스 코어 = 플라즈마 셰이더 + 에너지 코어 링
  { id: 'flux', name: '플럭스', tier: 'covert', price: 3200, attach: 'wings', sort: 10, model: 'angular', blurb: '장갑 틈새로 에너지가 흐르고, 홀로그램 윙이 떠오른다.',
    material: { style: 'energy', baseColor: 0x11141d, accentColor: 0x2a2f3d, patternColor: 0xff7a59, metalness: 0.85, roughness: 0.28, clearcoat: 0.8, clearcoatRoughness: 0.1 },
    emissive: { color: 0xff5a36, color2: 0xffd27a, intensity: 2.4, mode: 'energy', speed: 0.55 }, vfx: { tracerColor: 0xff8a5c, muzzleColor: 0xffb070, killEffect: 'burn', trail: true } },
  { id: 'aurora', name: '오로라', tier: 'covert', price: 3200, attach: 'wings', sort: 11, model: 'sleek', blurb: '극광이 표면을 유영하는 홀로그램 윙 에디션.',
    material: { style: 'energy', baseColor: 0x071821, accentColor: 0x12323c, patternColor: 0x31e8c0, metalness: 0.85, roughness: 0.25, clearcoat: 0.9, clearcoatRoughness: 0.08 },
    emissive: { color: 0x22ffc8, color2: 0x9d7bff, intensity: 2.2, mode: 'energy', speed: 0.4 }, vfx: { tracerColor: 0x7dffe0, muzzleColor: 0xb9a2ff, killEffect: 'freeze', trail: true } },
  // (솔라 프라임 / 어비스 코어 — 위 은밀한 등급, 에너지 코어 링)
  { id: 'solar', name: '솔라 프라임', tier: 'covert', price: 4500, attach: 'rings', featured: true, sort: 12, model: 'ornate', blurb: '신규 출시 — 백색 세라믹과 황금 인레이 사이로 태양의 용암이 흐른다.',
    material: { style: 'solar', baseColor: 0xf3efe4, accentColor: 0xd9a520, patternColor: 0xfff2b0, metalness: 0.7, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.05 },
    emissive: { color: 0xff9a14, color2: 0xfff3c0, intensity: 2.0, mode: 'plasma', speed: 0.5, ambient: 0.04 }, vfx: { tracerColor: 0xffd86a, muzzleColor: 0xffc23a, killEffect: 'gold', trail: true } },
  { id: 'abyss', name: '어비스 코어', tier: 'covert', price: 4500, attach: 'rings', sort: 13, model: 'angular', blurb: '심연의 성운이 균열 사이에서 맥동하는 흑요석 코어.',
    material: { style: 'abyss', baseColor: 0x0c0616, accentColor: 0x3a0f5c, patternColor: 0xff1f4b, metalness: 0.9, roughness: 0.18, clearcoat: 1, clearcoatRoughness: 0.06 },
    emissive: { color: 0xff1f4b, color2: 0xa24dff, intensity: 1.7, mode: 'plasma', speed: 0.35, ambient: 0.1 }, vfx: { tracerColor: 0xff4d7a, muzzleColor: 0xff2d5a, killEffect: 'void', trail: true } },
];

/** 컬렉션에 속하지 않는 단품 스킨은 여기에 추가 */
export const KARAMBIT_SKIN_ID = 'karambit_dagger';
export const BUTTERFLY_SKIN_ID = 'butterfly_dagger';
export const SKELETON_SKIN_ID = 'skeleton_dagger';
export const BOWIE_SKIN_ID = 'bowie_dagger';
export const EXTRA_SKINS: SkinDef[] = [
  // 카람빗 스페셜 박스 전용(0.1%) — 상점/일일/일반 박스에는 나오지 않는다. 단검(근접 3번 슬롯) 전용, damascus-karambit.glb(손잡이는 내장 원본 PBR 그대로, 칼날·핑거 링만 BLADE_VARIANTS 재질) 사용
  { id: KARAMBIT_SKIN_ID, collection: 'karambit', weaponId: 'dagger', name: '★ 카람빗 | 표면 경화', patternSeed: 387, tier: 'exrare', price: 4500, featured: false, inDaily: false, inBox: false, sort: 14,
    blurb: '표면 경화 열처리로 칼날 전면이 코발트 블루로 물든 블루젬 카람빗 (패턴 #387). 카람빗 스페셜 박스 0.1% 한정.',
    model: 'default', material: { style: 'solid', baseColor: 0x1d4fb8, accentColor: 0xe0b440, patternColor: 0x9fd0ff, metalness: 0.95, roughness: 0.25 },
    emissive: NO_GLOW, vfx: { tracerColor: 0x9fd0ff }, glb: { file: 'damascus-karambit.glb', length: 0.27, grip: 0.3, roll: 0, rot: [0, 0, Math.PI], variant: 'case_hardened_387' } },
  // 카람빗 도플러(루비) — 표면 경화와 동일 등급 체계, doppler.jpeg 원본 시트의 붉은 연기 구역을 칼날·핑거 링에 매핑
  { id: 'karambit_doppler', collection: 'karambit', weaponId: 'dagger', name: '★ 카람빗 | 도플러 루비', patternSeed: 417, tier: 'exrare', price: 4500, featured: false, inDaily: false, inBox: false, sort: 14.5,
    blurb: '칼날 전체에 루비 레드 연기가 소용돌이치는 도플러 카람빗 (Ruby). 카람빗 스페셜 박스 한정.',
    model: 'default', material: { style: 'solid', baseColor: 0xb3122a, accentColor: 0x5a0a14, patternColor: 0xff4d5e, metalness: 0.78, roughness: 0.2 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xff4d5e }, glb: { file: 'damascus-karambit.glb', length: 0.27, grip: 0.3, roll: 0, rot: [0, 0, Math.PI], variant: 'doppler_ruby' } },
  // 카람빗 도플러(사파이어) — doppler.jpeg 오른쪽 블루 연기 구역
  { id: 'karambit_doppler_sapphire', collection: 'karambit', weaponId: 'dagger', name: '★ 카람빗 | 도플러 사파이어', patternSeed: 418, tier: 'exrare', price: 4500, featured: false, inDaily: false, inBox: false, sort: 14.6,
    blurb: '칼날 전체에 코발트 블루 연기가 감도는 도플러 카람빗 (Sapphire). 카람빗 스페셜 박스 한정.',
    model: 'default', material: { style: 'solid', baseColor: 0x1d4fb8, accentColor: 0x0a1a5a, patternColor: 0x4d8dff, metalness: 0.78, roughness: 0.2 },
    emissive: NO_GLOW, vfx: { tracerColor: 0x4d8dff }, glb: { file: 'damascus-karambit.glb', length: 0.27, grip: 0.3, roll: 0, rot: [0, 0, Math.PI], variant: 'doppler_sapphire' } },
  // 카람빗 감마 도플러(에메랄드) — doppler.jpeg 가운데 그린 연기 구역
  { id: 'karambit_gamma_doppler', collection: 'karambit', weaponId: 'dagger', name: '★ 카람빗 | 도플러 에메랄드', patternSeed: 419, tier: 'exrare', price: 4500, featured: false, inDaily: false, inBox: false, sort: 14.7,
    blurb: '칼날 전체에 에메랄드 그린 연기가 피어오르는 감마 도플러 카람빗 (Emerald). 카람빗 스페셜 박스 한정.',
    model: 'default', material: { style: 'solid', baseColor: 0x0f8f4a, accentColor: 0x06361c, patternColor: 0x4dff9a, metalness: 0.78, roughness: 0.2 },
    emissive: NO_GLOW, vfx: { tracerColor: 0x4dff9a }, glb: { file: 'damascus-karambit.glb', length: 0.27, grip: 0.3, roll: 0, rot: [0, 0, Math.PI], variant: 'doppler_emerald' } },
  // 카람빗 골드 룬 — karambit_csgo_gold_runes.glb 의 원본 머티리얼·텍스처를 그대로 렌더(native: 재질/역할 오버라이드 전면 우회). rot = 원본 축(두께 X · 길이 Y · 높이 Z) → 기본 카람빗 축(길이 X · 높이 Y · 두께 Z)
  { id: 'karambit_gold_runes', collection: 'karambit', weaponId: 'dagger', name: '★ 카람빗 | 골드 룬', patternSeed: 420, tier: 'exrare', price: 4500, featured: false, inDaily: false, inBox: false, sort: 14.8,
    blurb: '금빛 룬 문양이 새겨진 카람빗 (Gold Runes). 카람빗 스페셜 박스 한정.',
    model: 'default', material: { style: 'solid', baseColor: 0xd9a93a, accentColor: 0x5a3c0a, patternColor: 0xffd35a, metalness: 0.9, roughness: 0.25 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xffd35a }, glb: { file: 'karambit_csgo_gold_runes.glb', length: 0.27, grip: 0.3, roll: 0, rot: [-Math.PI / 2, 0, -Math.PI / 2], native: true } },
  // 카람빗 다마스커스 강철 — damascus-karambit.glb 내장 원본 PBR(map/normal/roughness/metalness)과 그립 텍스처를 무손실 그대로 렌더(native)
  { id: 'karambit_damascus_steel', collection: 'karambit', weaponId: 'dagger', name: '★ 카람빗 | 다마스커스 강철', patternSeed: 421, tier: 'exrare', price: 4500, featured: false, inDaily: false, inBox: false, sort: 14.9,
    blurb: '접쳐 두드린 강철 특유의 물결 무늬가 칼날 전체에 살아 있는 다마스커스 카람빗. 카람빗 스페셜 박스 한정.',
    model: 'default', material: { style: 'solid', baseColor: 0x6b7078, accentColor: 0x2a2d33, patternColor: 0xc4c9d0, metalness: 0.9, roughness: 0.3 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xc4c9d0 }, glb: { file: 'damascus-karambit.glb', length: 0.27, grip: 0.3, roll: 0, rot: [0, 0, Math.PI], native: true } },
  // 버터플라이 나이프 — 상점 NEW(featured) 상시 판매. 단검(근접 3번 슬롯) 전용, butterfly_knife.glb 내장 PBR 재질(스틸 날 + 블랙/레드 핸들) 사용
  // GLB 규약: 날끝 +X, 등날 +Y(위), 핸들 -X — 원본 .blend 에서 Blender 5.3 으로 변환
  { id: BUTTERFLY_SKIN_ID, collection: 'butterfly', weaponId: 'dagger', name: '버터플라이 나이프', tier: 'exrare', price: 4500, featured: true, inDaily: false, inBox: false, sort: 15,
    blurb: '두 갈래 핸들이 펼쳐지는 발리송. 미러 폴리싱 스틸 블레이드에 블랙·레드 핸들.',
    model: 'default', material: { style: 'solid', baseColor: 0xc7cacd, accentColor: 0xbf0505, patternColor: 0x111214, metalness: 0.95, roughness: 0.22 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xff5a5a }, glb: { file: 'butterfly_knife.glb', length: 0.3, grip: 0.3, roll: 0 } },
  // 스켈레톤 나이프 — 상점 NEW(featured) 상시 판매. 단검(근접 3번 슬롯) 전용, skeleton_knife.glb (기본 외형 = BLADE_MASKS CS2 바닐라 다크 스틸, 내장 텍스처 미사용)
  { id: SKELETON_SKIN_ID, collection: 'skeleton', weaponId: 'dagger', name: '스켈레톤 나이프', tier: 'exrare', price: 4500, featured: true, inDaily: false, inBox: false, sort: 16,
    blurb: '뼈대만 남긴 경량 스켈레톤 블레이드. 파라코드 핸들 랩.',
    model: 'default', material: { style: 'solid', baseColor: 0xb9bcc0, accentColor: 0x6b5a3c, patternColor: 0x111214, metalness: 0.95, roughness: 0.25 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xd8d8d8 }, glb: { file: 'skeleton_knife.glb', length: 0.3, grip: 0.3, roll: 0 } },
  // 보위 나이프 — 상점 NEW(featured) 상시 판매. 단검(근접 3번 슬롯) 전용, bowie_knife.fbx (단위 ≈ mm×10, 날끝 +X · 등날 +Y, 단일 메시 Blade_LowPoly,
  //  외부 PNG 텍스처 미포함 → BLADE_MASKS 의 CS2 바닐라 재질: 새틴 스틸 날 + 브라스 가드 + 다크 우드 손잡이)
  { id: BOWIE_SKIN_ID, collection: 'bowie', weaponId: 'dagger', name: '보위 나이프', tier: 'exrare', price: 4500, featured: true, inDaily: false, inBox: false, sort: 17,
    blurb: '클립 포인트 대형 블레이드와 브라스 가드의 클래식 보위 나이프.',
    model: 'default', material: { style: 'solid', baseColor: 0xb5b9be, accentColor: 0x8a6a3a, patternColor: 0x111214, metalness: 0.95, roughness: 0.24 },
    emissive: NO_GLOW, vfx: { tracerColor: 0xe8d8b0 }, glb: { file: 'bowie_knife.fbx', length: 0.32, grip: 0.2, roll: 0, own: true } },
];

const weaponName = (id: SkinWeaponId): string => SKIN_WEAPONS.find((w) => w.id === id)!.name;

export const SKINS: SkinDef[] = [
  ...COLLECTIONS.flatMap((c) =>
    (c.weapons ?? ALL_WEAPONS).map<SkinDef>((w) => ({
      id: `${c.id}_${w}`, collection: c.id, weaponId: w, name: `${c.name} ${weaponName(w)}`, tier: c.tier, price: c.price ?? TIERS[c.tier].price,
      featured: !!c.featured, inDaily: !c.featured, inBox: !c.featured, sort: c.sort, blurb: c.blurb,
      model: c.model, material: c.material, emissive: c.emissive, vfx: c.vfx, attach: c.attach,
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
export const skinAttachment = (s: Pick<SkinDef, 'attach' | 'glb'> | null | undefined): SkinAttachment => (s?.glb ? 'none' : s?.attach ?? 'none');
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
/** jackpot = 등급과 별개로 특정 스킨 묶음(skinIds)을 weight(%)로 뽑는 칸 — 당첨 시 묶음 안에서 균등 추첨(서버 open_lootbox 와 동일) (DB lootbox_rates 에 rarity='karambit' 행으로 저장). gunOnly = 등급 추첨 풀에서 근접(단검/장검) 제외 */
export interface LootboxJackpot { key: string; skinIds: string[]; weight: number; refund: number; label: string }
export interface LootboxDef { id: string; name: string; price: number; rates: Partial<Record<Tier, number>>; jackpot?: LootboxJackpot; gunOnly?: boolean; desc?: string }
export const LOOTBOXES: Record<string, LootboxDef> = {
  standard: { id: 'standard', name: '스탠다드 박스', price: 1000, rates: { consumer: 18.33, industrial: 18.33, milspec: 27.67, restricted: 22.67, classified: 8, covert: 5 } },
  premium: { id: 'premium', name: '프리미엄 박스', price: 2000, rates: { consumer: 6.66, industrial: 6.67, milspec: 20, restricted: 35.67, classified: 18, covert: 13 } },
  karambit: {
    id: 'karambit', name: '카람빗 스페셜 박스', price: 4000, gunOnly: true, desc: '총기 스킨 전용 · 평범한·쓸만한 등급 제외 · 0.1% 확률로 단검 카람빗(표면 경화 / 도플러 / 사파이어 / 에메랄드 / 골드 룬) 등장',
    rates: { milspec: 15, restricted: 41.67, classified: 23.33, covert: 19.9 },
    jackpot: { key: 'karambit', skinIds: [KARAMBIT_SKIN_ID, 'karambit_doppler', 'karambit_doppler_sapphire', 'karambit_gamma_doppler', 'karambit_gold_runes', 'karambit_damascus_steel'], weight: 0.1, refund: 2000, label: '단검: 카람빗' },
  },
};
/** 중복 획득 시 크레딧 환급액 (등급 기준가의 25%) */
export const DUP_REFUND: Record<Tier, number> = { default: 0, consumer: 150, industrial: 150, milspec: 225, restricted: 375, classified: 550, covert: 900, exrare: 1125, contraband: 1250 };

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
  const jps = (box?.jackpot?.skinIds ?? []).map(getSkin).filter((x): x is SkinDef => !!x); if (jps.length) [5, 13, 22, 31].forEach((k, j) => { reel[k] = jps[j % jps.length]; }); // 연출용 카람빗 노출(실제 확률과 무관)
  const result = getSkin(resultSkinId); if (result) reel[length - 4] = result;
  return reel;
}

// ───────────────────────────── 2-b) 컨테이너 · 상점 경제 (supabase_shop_overhaul.sql 과 동일 상수) ─────────────────────────────
export type CaseKind = 'drop' | 'store';
export interface CaseDef { id: CaseKind; name: string; en: string; needsKey: boolean; rates: Partial<Record<Tier, number>>; desc: string }
/** CS2 공식 확률. drop = 매치 XP 레벨업 주간 보상(열쇠 필요) / store = 상점 판매(열쇠 동봉) */
export const CASES: Record<CaseKind, CaseDef> = {
  drop: { id: 'drop', name: '드롭 무기 상자', en: 'Weapon Case', needsKey: true, rates: { milspec: 79.92, restricted: 15.98, classified: 3.2, covert: 0.64, exrare: 0.26 }, desc: '매치 완주 보상(사격장 제외) · 무기 상자 열쇠 1개로 개봉' },
  store: { id: 'store', name: '상점 전용 컨테이너', en: 'Store Container', needsKey: false, rates: { milspec: 75, restricted: 20, classified: 5 }, desc: '열쇠 동봉 · 구매 즉시 개봉 가능' },
};
export const SHOP_PRICES = {
  key: 1500,
  storeCase: 2200,
  daily: { milspec: 1100, restricted: 1800, classified: 2800 } as Partial<Record<Tier, number>>,
  permanent: { consumer: 400, industrial: 700 } as Partial<Record<Tier, number>>,
};
export const BUY_QTYS = [1, 3, 5, 10] as const;
/** 구매·개봉 1회 최대 수량 (직접 입력 상한) */
export const MAX_QTY = 999;
export const clampQty = (v: number, max = MAX_QTY): number => Math.min(Math.max(1, max), Math.max(1, Math.floor(v) || 1));
export const DAILY_SLOTS = 4;
/** 매치 XP: 기본 100 + 킬 10 + 승리 100 (이탈 0), 1,000 XP = 1 레벨 */
export const XP_PER_LEVEL = 1000;
export const matchXp = (result: 'win' | 'loss' | 'draw' | 'left', kills: number): number => (result === 'left' ? 0 : 100 + 10 * Math.max(0, kills) + (result === 'win' ? 100 : 0));
/** 확률표(%) — 높은 등급부터 */
export const caseOdds = (k: CaseKind): OddsRow[] => TIER_ORDER.filter((t) => (CASES[k].rates[t] ?? 0) > 0).reverse().map((t) => ({ key: t, label: TIERS[t].name, color: TIERS[t].color, percent: CASES[k].rates[t]!, tier: t }));
/** 등급 추첨 (r ∈ [0,1)) */
export function rollCaseTier(k: CaseKind, r = Math.random()): Tier {
  let v = r * 100;
  const rows = caseOdds(k);
  for (const o of rows) { if (v < o.percent) return o.tier!; v -= o.percent; }
  return rows[rows.length - 1].tier!;
}
export const tierPool = (t: Tier): SkinDef[] => SKINS.filter((s) => s.tier === t);
/** 해당 컨테이너에서 나올 수 있는 스킨 전체(룰렛 릴 채우기용) */
export const casePool = (k: CaseKind): SkinDef[] => SKINS.filter((s) => (CASES[k].rates[s.tier] ?? 0) > 0);

// ───────────────────────────── 3) DB 시드 생성 (skin_catalog / lootboxes / lootbox_rates) ─────────────────────────────
// 구버전 등급 제약·보유 스킨 ID 이관은 supabase_schema.sql 의 "CS2 등급 마이그레이션" 블록이 담당 (이 시드보다 먼저 1회 실행)
const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
/** 스킨이 실제로 배정된 등급만 확률표 행으로 시드 (default / contraband 는 제외) */
const SEED_TIERS = (): Tier[] => TIER_ORDER.filter((t) => SKINS.some((s) => s.tier === t));
export function catalogSeedSql(): string {
  const skins = SKINS.map((s) => `  (${q(s.id)}, ${q(s.weaponId)}, ${q(s.name)}, ${q(s.tier)}, ${s.price}, ${s.featured}, ${s.inDaily}, ${s.inBox}, ${s.sort})`).join(',\n');
  const boxes = Object.values(LOOTBOXES).map((b) => `  (${q(b.id)}, ${q(b.name)}, ${b.price})`).join(',\n');
  const rates = Object.values(LOOTBOXES).flatMap((b) => [...SEED_TIERS().map((r) => `  (${q(b.id)}, ${q(r)}, ${b.rates[r] ?? 0}, ${DUP_REFUND[r]})`), ...(b.jackpot ? [`  (${q(b.id)}, ${q(b.jackpot.key)}, ${b.jackpot.weight}, ${b.jackpot.refund})`] : [])]).join(',\n');
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
