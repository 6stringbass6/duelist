// =====================================================================
// 상점 · 컨테이너 경제
//  · 로그인 계정: Supabase RPC(supabase_shop_overhaul.sql)가 크레딧·컨테이너·스킨을 결정 (서버 권위)
//  · 게스트: 같은 규칙을 이 브라우저 localStorage 에서 재현 (크레딧·컨테이너는 supabase.ts 게스트 프로필, 스킨은 아래 키)
// 결과는 모두 patchProfile 로 프로필에 반영되고, 계정은 마지막 스냅샷을 localStorage 에도 캐시한다.
// =====================================================================
import { CASES, DAILY_SLOTS, DUP_REFUND, SHOP_PRICES, SKINS, XP_PER_LEVEL, getSkin, matchXp, normalizeTier, rollCaseTier, tierPool, type CaseKind, type SkinDef, type Tier } from '../config/skins';
import { GameError, getProfile, onProfileChange, patchProfile, rpc, type OwnedSkin, type Profile, type ShopItem } from './supabase';

export type StoreItem = 'key' | 'store_case';
export interface CaseResult { skin_id: string; weapon_id: string; rarity: Tier; duplicate: boolean; refund: number }
export interface Inventory { dropCases: number; storeCases: number; keys: number; xp: number }

export const inventoryOf = (p: Profile | null): Inventory => ({ dropCases: p?.lootboxes ?? 0, storeCases: p?.store_cases ?? 0, keys: p?.case_keys ?? 0, xp: p?.xp ?? 0 });
export const levelOf = (xp: number): number => Math.floor(xp / XP_PER_LEVEL) + 1;

/** KST 기준 날짜 / ISO 주차 (DB kst_today · to_char(...,'IYYY-IW') 와 동일) */
const kstDate = (): Date => new Date(Date.now() + 9 * 3600_000);
export const kstToday = (): string => kstDate().toISOString().slice(0, 10);
function kstIsoWeek(): string {
  const d = kstDate(), day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const y = d.getUTCFullYear(), w = Math.ceil(((+d - Date.UTC(y, 0, 1)) / 86400_000 + 1) / 7);
  return `${y}-${String(w).padStart(2, '0')}`;
}

// ───────────────────────────── 판매 목록 ─────────────────────────────
export const DAILY_TIERS = Object.keys(SHOP_PRICES.daily) as Tier[];
export const dailyPrice = (s: SkinDef): number => SHOP_PRICES.daily[s.tier] ?? 0;
/** 상설 판매: 상자에서 나오지 않는 평범한·쓸만한 등급 */
export const permanentStock = (): SkinDef[] => SKINS.filter((s) => SHOP_PRICES.permanent[s.tier] != null).sort((a, b) => a.tier.localeCompare(b.tier) || a.sort - b.sort);
export const permanentPrice = (s: SkinDef): number => SHOP_PRICES.permanent[s.tier] ?? 0;

/** 서버가 준 오늘의 상점을 규칙(4칸 · 최대 비밀의 무기 · 등급 고정가)으로 정리 — 구버전 DB 응답이 섞여도 금지 등급은 노출하지 않는다 */
export function normalizeDaily(items: ShopItem[]): ShopItem[] {
  return items.filter((it) => { const s = getSkin(it.skin_id); return !!s && DAILY_TIERS.includes(s.tier); }).slice(0, DAILY_SLOTS).map((it) => ({ ...it, price: dailyPrice(getSkin(it.skin_id)!) }));
}

// ───────────────────────────── 게스트 로컬 엔진 ─────────────────────────────
const skinsKey = (id: string): string => `gs_econ_skins_v1:${id}`;
const isGuest = (): boolean => !!getProfile()?.isGuest;
function readSkins(): OwnedSkin[] {
  const p = getProfile(); if (!p) return [];
  try { const v = JSON.parse(localStorage.getItem(skinsKey(p.id)) ?? '[]'); return Array.isArray(v) ? v.filter((o) => getSkin(o?.skin_id)) : []; } catch { return []; }
}
function writeSkins(list: OwnedSkin[]): void { const p = getProfile(); if (p) try { localStorage.setItem(skinsKey(p.id), JSON.stringify(list)); } catch { /* noop */ } }
export const guestSkins = (): OwnedSkin[] => (isGuest() ? readSkins() : []);
function grantLocal(s: SkinDef, source: string): boolean {
  const list = readSkins(); if (list.some((o) => o.skin_id === s.id)) return false;
  list.push({ skin_id: s.id, weapon_id: s.weaponId, equipped: false, source, acquired_at: new Date().toISOString() }); writeSkins(list); return true;
}
/** 날짜 시드 PRNG — 같은 날엔 항상 같은 4칸 */
function seeded(seed: string): () => number {
  let h = 2166136261; for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function guestDaily(): ShopItem[] {
  const rnd = seeded(`daily:${kstToday()}`), pool = SKINS.filter((s) => DAILY_TIERS.includes(s.tier)), own = new Set(readSkins().map((o) => o.skin_id)), out: ShopItem[] = [];
  while (out.length < DAILY_SLOTS && pool.length) { const s = pool.splice(Math.floor(rnd() * pool.length), 1)[0]; out.push({ slot: out.length + 1, skin_id: s.id, price: dailyPrice(s), owned: own.has(s.id) }); }
  return out;
}
function spend(cost: number): void {
  const p = getProfile()!; if (p.credits < cost) throw new GameError('NOT_ENOUGH_CREDITS');
  patchProfile({ credits: p.credits - cost });
}
const assertQty = (n: number): void => { if (![1, 3, 5, 10].includes(n)) throw new GameError('INVALID_QTY'); };

// ───────────────────────────── 공개 API ─────────────────────────────
/** 오늘의 상점 또는 상설 판매 스킨 구매 */
export async function buyShopSkin(skinId: string, daily: ShopItem[]): Promise<void> {
  const s = getSkin(skinId); if (!s) throw new GameError('SKIN_NOT_FOUND');
  if (!isGuest()) { const r = await rpc<{ credits: number }>('buy_skin', { p_skin_id: s.id }); patchProfile({ credits: r.credits }); return; }
  const price = daily.some((d) => d.skin_id === s.id) ? dailyPrice(s) : SHOP_PRICES.permanent[s.tier];
  if (!price) throw new GameError('NOT_FOR_SALE');
  if (readSkins().some((o) => o.skin_id === s.id)) throw new GameError('ALREADY_OWNED');
  spend(price); grantLocal(s, daily.some((d) => d.skin_id === s.id) ? 'shop' : 'store');
}
/** 무기 상자 열쇠 / 상점 전용 컨테이너 구매 */
export async function buyStoreItem(item: StoreItem, qty: number): Promise<void> {
  assertQty(qty);
  if (!isGuest()) { const r = await rpc<{ credits: number; lootboxes: number; case_keys: number; store_cases: number }>('buy_store_item', { p_item: item, p_qty: qty }); patchProfile(r); return; }
  spend((item === 'key' ? SHOP_PRICES.key : SHOP_PRICES.storeCase) * qty);
  const p = getProfile()!;
  patchProfile(item === 'key' ? { case_keys: (p.case_keys ?? 0) + qty } : { store_cases: (p.store_cases ?? 0) + qty });
}
/** 컨테이너 개봉 — 결과 배열(개봉 순서). 중복은 등급 기준가 25% 자동 환급 */
export async function openCases(kind: CaseKind, count: number): Promise<CaseResult[]> {
  assertQty(count);
  if (!isGuest()) {
    const r = await rpc<{ results: CaseResult[]; credits: number; lootboxes: number; case_keys: number; store_cases: number }>('open_cases', { p_case: kind, p_count: count });
    patchProfile({ credits: r.credits, lootboxes: r.lootboxes, case_keys: r.case_keys, store_cases: r.store_cases });
    return r.results.map((x) => ({ ...x, rarity: normalizeTier(x.rarity) }));
  }
  const p = getProfile()!, inv = inventoryOf(p);
  if (kind === 'drop') {
    if (inv.dropCases < count) throw new GameError('NO_LOOTBOX');
    if (inv.keys < count) throw new GameError('NO_CASE_KEY');
    patchProfile({ lootboxes: inv.dropCases - count, case_keys: inv.keys - count });
  } else {
    if (inv.storeCases < count) throw new GameError('NO_LOOTBOX');
    patchProfile({ store_cases: inv.storeCases - count });
  }
  const out: CaseResult[] = [];
  let refund = 0;
  for (let i = 0; i < count; i++) {
    const tier = rollCaseTier(kind), pool = tierPool(tier), s = pool[Math.floor(Math.random() * pool.length)];
    const dup = !grantLocal(s, 'box'), r = dup ? DUP_REFUND[tier] : 0;
    refund += r; out.push({ skin_id: s.id, weapon_id: s.weaponId, rarity: tier, duplicate: dup, refund: r });
  }
  if (refund) patchProfile({ credits: getProfile()!.credits + refund });
  return out;
}
/** 게스트 스킨 장착(로컬). 계정은 기존 equip_skin RPC 사용 */
export function equipGuestSkin(weaponId: string, skinId: string | null): void {
  writeSkins(readSkins().map((o) => (o.weapon_id === weaponId ? { ...o, equipped: o.skin_id === skinId } : o)));
}
/** 게스트 매치 XP 적립 + 완주 매치당 드롭 무기 상자 1개 (계정은 DB 트리거가 처리). 지급 여부 반환 */
export function awardGuestMatchXp(result: 'win' | 'loss' | 'draw' | 'left', kills: number): boolean {
  const p = getProfile(); if (!p?.isGuest) return false;
  const drop = result !== 'left';
  patchProfile({ xp: (p.xp ?? 0) + matchXp(result, kills), ...(drop ? { lootboxes: (p.lootboxes ?? 0) + 1 } : {}) });
  return drop;
}
export const CASE_LIST = Object.values(CASES);

// 계정 스냅샷 캐시 (오프라인/재접속 시 마지막 보관함 표시용 · 서버 값이 항상 우선)
onProfileChange((p) => {
  if (!p || p.isGuest) return;
  try { localStorage.setItem(`gs_econ_cache_v1:${p.id}`, JSON.stringify({ credits: p.credits, ...inventoryOf(p), at: Date.now() })); } catch { /* noop */ }
});
