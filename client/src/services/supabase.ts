// =====================================================================
// Supabase 서비스: 인증(아이디/구글/게스트) · 프로필 · 상점 · 미션 · 업적 · 설정 클라우드 동기화
// env: VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SERVER_URL
// 쓰기는 전부 RPC(SECURITY DEFINER) — 클라이언트가 직접 고칠 수 있는 건 settings / loadout 뿐.
// =====================================================================
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { DEFAULT_LOADOUT, WEAPONS, SLOT_KEYS, type Loadout } from '../config/weapons';
import { SKILLS, SKILL_IDS, ULTS } from '../config/skills';
import { getSettings, onSettingsChange, replaceSettings, type Settings } from '../config/settings';

const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
const URL_ = env.VITE_SUPABASE_URL ?? '';
const ANON = env.VITE_SUPABASE_ANON_KEY ?? '';
export const SERVER_URL = env.VITE_SERVER_URL ?? 'http://localhost:3001';
export const isSupabaseConfigured = !!URL_ && !!ANON;

export const supabase: SupabaseClient | null = isSupabaseConfigured
  ? createClient(URL_, ANON, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;

// ───────────────────────────── 타입 ─────────────────────────────
export interface Profile {
  id: string; username: string | null; nickname: string; credits: number; lootboxes: number;
  rank_points: number; peak_rank_points: number; equipped_title: string | null;
  login_streak: number; best_login_streak: number; last_login_date: string | null;
  settings: Partial<Settings>; loadout: Loadout; isGuest: boolean;
}
export interface CareerStats { matches: number; wins: number; losses: number; kills: number; deaths: number; assists: number; headshot_kills: number; kd: number; hs_pct: number; win_rate: number }
export interface OwnedSkin { skin_id: string; weapon_id: string; equipped: boolean; source: string; acquired_at: string }
export interface Achievement { achievement_id: string; name: string; description: string; stat_key: string; threshold: number; title: string | null; credit_reward: number; sort: number; unlocked: boolean; unlocked_at: string | null }
export interface DailyMission { slot: number; mission_id: string; description: string; stat_key: string; target: number; progress: number; reward_type: 'credits' | 'lootbox'; reward_amount: number; claimed: boolean }
export interface ShopItem { slot: number; skin_id: string; price: number; owned: boolean }
export interface LoginReward { day: number; reward_type: 'credits' | 'lootbox'; reward_amount: number }
export interface MatchRow { id: number; mode: string; map: string; team_size: number; result: 'win' | 'loss' | 'draw' | 'left'; kills: number; deaths: number; assists: number; headshot_kills: number; damage: number; rp_delta: number; credits_earned: number; played_at: string }
export interface LootboxResult { skin_id: string; weapon_id: string; rarity: string; duplicate: boolean; refund: number; credits: number; lootboxes: number; unlocked: string[] }
export interface DailyLoginResult { claimed: boolean; streak: number; day: number; reward_type?: 'credits' | 'lootbox'; reward_amount?: number; credits: number; lootboxes: number; unlocked?: string[] }
export interface AccountBundle {
  profile: Profile; stats: CareerStats; skins: OwnedSkin[]; achievements: Achievement[]; missions: DailyMission[]; shop: ShopItem[]; loginRewards: LoginReward[];
}
export const EMPTY_STATS: CareerStats = { matches: 0, wins: 0, losses: 0, kills: 0, deaths: 0, assists: 0, headshot_kills: 0, kd: 0, hs_pct: 0, win_rate: 0 };

// ───────────────────────────── 오류 메시지 ─────────────────────────────
const ERROR_KO: Record<string, string> = {
  NOT_CONFIGURED: '서버 설정이 완료되지 않았습니다. 게스트로 플레이해 주세요.',
  NOT_AUTHENTICATED: '로그인이 필요합니다.', GUEST_NOT_ALLOWED: '게스트는 이용할 수 없습니다. 로그인해 주세요.',
  INVALID_ID: '아이디는 영문 소문자·숫자·밑줄 4~16자입니다.', INVALID_PASSWORD: '비밀번호는 6자 이상이어야 합니다.',
  INVALID_NICKNAME: '닉네임은 한글·영문·숫자·밑줄 2~16자입니다.', NICKNAME_TAKEN: '이미 사용 중인 닉네임입니다.', SAME_NICKNAME: '현재 닉네임과 같습니다.',
  NOT_ENOUGH_CREDITS: '크레딧이 부족합니다.', ALREADY_OWNED: '이미 보유한 스킨입니다.', NOT_FOR_SALE: '현재 판매 중인 스킨이 아닙니다.',
  SKIN_NOT_FOUND: '존재하지 않는 스킨입니다.', SKIN_NOT_OWNED: '보유하지 않은 스킨입니다.', NO_LOOTBOX: '보유한 랜덤박스가 없습니다.',
  BOX_NOT_FOUND: '존재하지 않는 박스입니다.', TITLE_LOCKED: '아직 해금되지 않은 칭호입니다.',
  MISSION_INCOMPLETE: '미션이 아직 완료되지 않았습니다.', ALREADY_CLAIMED: '이미 보상을 받았습니다.', MISSION_NOT_FOUND: '미션을 찾을 수 없습니다.',
  'Invalid login credentials': '아이디 또는 비밀번호가 올바르지 않습니다.', 'User already registered': '이미 사용 중인 아이디입니다.',
};
export class GameError extends Error {
  code: string;
  constructor(code: string) { super(ERROR_KO[code] ?? code); this.code = code; this.name = 'GameError'; }
}
function toError(e: unknown): GameError {
  if (e instanceof GameError) return e;
  const msg = (e as { message?: string })?.message ?? String(e);
  const key = Object.keys(ERROR_KO).find((k) => msg.includes(k));
  return new GameError(key ?? msg);
}
function client(): SupabaseClient { if (!supabase) throw new GameError('NOT_CONFIGURED'); return supabase; }
async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  if (currentProfile?.isGuest) throw new GameError('GUEST_NOT_ALLOWED');
  const { data, error } = await client().rpc(fn, args);
  if (error) throw toError(error);
  return data as T;
}

// ───────────────────────────── 검증 ─────────────────────────────
export const AUTH_EMAIL_DOMAIN = 'game.local';
export const idToEmail = (id: string): string => `${id.trim().toLowerCase()}@${AUTH_EMAIL_DOMAIN}`;
export const isValidId = (id: string): boolean => /^[a-z0-9_]{4,16}$/.test(id.trim().toLowerCase());
export const isValidPassword = (pw: string): boolean => pw.length >= 6 && pw.length <= 72;
export const isValidNickname = (n: string): boolean => /^[A-Za-z0-9가-힣_]{2,16}$/.test(n.trim());
export function sanitizeLoadout(l: unknown): Loadout {
  const out: Record<string, string> = { ...DEFAULT_LOADOUT };
  if (l && typeof l === 'object') for (const slot of [1, 2, 3, 4] as const) {
    const key = SLOT_KEYS[slot], id = (l as Record<string, unknown>)[key];
    if (typeof id === 'string' && id in WEAPONS && WEAPONS[id as keyof typeof WEAPONS].slot === slot) out[key] = id;
  }
  if (l && typeof l === 'object') {
    const r = l as Record<string, unknown>;
    if (typeof r.q === 'string' && r.q in SKILLS) out.q = r.q;
    if (typeof r.e === 'string' && r.e in SKILLS) out.e = r.e;
    if (typeof r.x === 'string' && r.x in ULTS) out.x = r.x;
  }
  if (out.q === out.e) out.e = SKILL_IDS.find((k) => k !== out.q)!; // 같은 스킬 중복 장착 불가
  return out as unknown as Loadout;
}

// ───────────────────────────── 세션 상태 ─────────────────────────────
let currentProfile: Profile | null = null;
type ProfileListener = (p: Profile | null) => void;
const profileListeners = new Set<ProfileListener>();
const notify = (): void => { for (const l of profileListeners) l(currentProfile); };
export const getProfile = (): Profile | null => currentProfile;
export function onProfileChange(fn: ProfileListener): () => void { profileListeners.add(fn); return () => profileListeners.delete(fn); }
/** RPC 결과(credits/lootboxes/nickname 등)를 로컬 프로필에 반영 */
export function patchProfile(patch: Partial<Profile>): void { if (currentProfile) { currentProfile = { ...currentProfile, ...patch }; if (currentProfile.isGuest) saveGuest(currentProfile); notify(); } }

// ───────────────────────────── 게스트 (로컬 전용) ─────────────────────────────
const GUEST_KEY = 'gs_guest_v1';
function saveGuest(p: Profile): void { try { localStorage.setItem(GUEST_KEY, JSON.stringify({ id: p.id, nickname: p.nickname, loadout: p.loadout })); } catch { /* noop */ } }
/** 로그인 없이 즉시 체험. 전적·크레딧·스킨은 저장되지 않음(설정은 로컬 저장). */
export function startGuest(nickname?: string): Profile {
  let saved: { id?: string; nickname?: string; loadout?: unknown } = {};
  try { saved = JSON.parse(localStorage.getItem(GUEST_KEY) ?? '{}'); } catch { /* noop */ }
  const nick = nickname && isValidNickname(nickname) ? nickname.trim() : saved.nickname ?? `Guest${Math.floor(1000 + Math.random() * 9000)}`;
  currentProfile = {
    id: saved.id ?? `guest-${crypto.randomUUID()}`, username: null, nickname: nick, credits: 0, lootboxes: 0, rank_points: 0, peak_rank_points: 0,
    equipped_title: null, login_streak: 0, best_login_streak: 0, last_login_date: null, settings: {}, loadout: sanitizeLoadout(saved.loadout), isGuest: true,
  };
  saveGuest(currentProfile); notify();
  return currentProfile;
}
export function setGuestNickname(nickname: string): void {
  if (!currentProfile?.isGuest) return;
  if (!isValidNickname(nickname)) throw new GameError('INVALID_NICKNAME');
  patchProfile({ nickname: nickname.trim() });
}

// ───────────────────────────── 인증 ─────────────────────────────
/** 이메일 없는 간편 회원가입: 아이디 → id@game.local */
export async function signUpWithId(id: string, password: string, nickname: string): Promise<Profile> {
  if (!isValidId(id)) throw new GameError('INVALID_ID');
  if (!isValidPassword(password)) throw new GameError('INVALID_PASSWORD');
  if (!isValidNickname(nickname)) throw new GameError('INVALID_NICKNAME');
  const c = client();
  const { data: taken } = await c.from('public_profiles').select('id').ilike('nickname', nickname.trim()).maybeSingle();
  if (taken) throw new GameError('NICKNAME_TAKEN');
  const { data, error } = await c.auth.signUp({ email: idToEmail(id), password, options: { data: { nickname: nickname.trim() } } });
  if (error) throw toError(error);
  if (!data.session) { const r = await c.auth.signInWithPassword({ email: idToEmail(id), password }); if (r.error) throw toError(r.error); }
  return loadProfile();
}
export async function signInWithId(id: string, password: string): Promise<Profile> {
  if (!isValidId(id)) throw new GameError('INVALID_ID');
  const { error } = await client().auth.signInWithPassword({ email: idToEmail(id), password });
  if (error) throw toError(error);
  return loadProfile();
}
/** Continue with Google (리다이렉트 → 복귀 후 initAuth 가 세션 복원) */
export async function signInWithGoogle(): Promise<void> {
  const { error } = await client().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin, queryParams: { prompt: 'select_account' } } });
  if (error) throw toError(error);
}
export async function signOut(): Promise<void> {
  if (supabase && !currentProfile?.isGuest) await supabase.auth.signOut();
  currentProfile = null; notify();
}
export async function getSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}
export async function getAccessToken(): Promise<string | null> { return (await getSession())?.access_token ?? null; }

/** 앱 시작 시 1회 호출: 세션 복원 + 인증 상태 구독 + 설정 자동 클라우드 저장 */
export async function initAuth(): Promise<Profile | null> {
  onSettingsChange((s) => queueSettingsSave(s));
  if (!supabase) return null;
  supabase.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { if (!currentProfile?.isGuest) { currentProfile = null; notify(); } }
    else if (event === 'SIGNED_IN' && session && currentProfile?.id !== session.user.id) setTimeout(() => { loadProfile().catch(() => {}); }, 0);
  });
  const session = await getSession();
  if (!session) return null;
  try { return await loadProfile(); } catch { return null; }
}

/** Socket.io handshake `auth` 페이로드 (server.js io.use 와 대응) */
export async function socketAuthPayload(): Promise<{ token?: string; nickname: string; loadout: Loadout }> {
  const p = currentProfile ?? startGuest();
  const token = p.isGuest ? null : await getAccessToken();
  return { ...(token ? { token } : {}), nickname: p.nickname, loadout: p.loadout };
}

// ───────────────────────────── 프로필 / 번들 ─────────────────────────────
export async function loadProfile(): Promise<Profile> {
  const c = client(), session = await getSession();
  if (!session) throw new GameError('NOT_AUTHENTICATED');
  let row: Record<string, unknown> | null = null;
  for (let i = 0; i < 3 && !row; i++) {
    const { data, error } = await c.from('profiles').select('*').eq('id', session.user.id).maybeSingle();
    if (error) throw toError(error);
    row = data;
    if (!row) { // 프로필 행 누락 → 기본값으로 자동 생성 후 재조회
      const { error: e2 } = await c.rpc('ensure_my_profile');
      if (e2 && i === 2) throw toError(e2);
    }
  }
  if (!row) throw new GameError('PROFILE_NOT_FOUND');
  currentProfile = { ...(row as unknown as Profile), loadout: sanitizeLoadout(row.loadout), settings: (row.settings as Partial<Settings>) ?? {}, isGuest: false };
  replaceSettings(currentProfile.settings); // 클라우드 설정 → 로컬 적용
  notify();
  return currentProfile;
}
export async function fetchStats(userId: string): Promise<CareerStats> {
  const { data } = await client().from('player_stats_total').select('*').eq('user_id', userId).maybeSingle();
  return data ? { ...EMPTY_STATS, ...data, kd: +data.kd, hs_pct: +data.hs_pct, win_rate: +data.win_rate } : { ...EMPTY_STATS };
}
export async function fetchStatsByMode(userId: string): Promise<Record<string, Record<string, number>>> {
  const { data } = await client().from('player_stats').select('*').eq('user_id', userId);
  return Object.fromEntries((data ?? []).map((r: Record<string, unknown>) => [r.mode as string, r as Record<string, number>]));
}
export async function fetchOwnedSkins(): Promise<OwnedSkin[]> {
  if (!currentProfile || currentProfile.isGuest) return [];
  const { data, error } = await client().from('user_skins').select('skin_id,weapon_id,equipped,source,acquired_at').eq('user_id', currentProfile.id);
  if (error) throw toError(error);
  return (data ?? []) as OwnedSkin[];
}
export async function fetchAchievements(): Promise<Achievement[]> {
  const c = client();
  const [all, mine] = await Promise.all([
    c.from('achievements').select('*').order('sort'),
    currentProfile && !currentProfile.isGuest ? c.from('user_achievements').select('achievement_id,unlocked_at').eq('user_id', currentProfile.id) : Promise.resolve({ data: [] as { achievement_id: string; unlocked_at: string }[] }),
  ]);
  const got = new Map((mine.data ?? []).map((r) => [r.achievement_id, r.unlocked_at]));
  return ((all.data ?? []) as Omit<Achievement, 'unlocked' | 'unlocked_at'>[]).map((a) => ({ ...a, unlocked: got.has(a.achievement_id), unlocked_at: got.get(a.achievement_id) ?? null }));
}
export async function fetchLoginRewards(): Promise<LoginReward[]> {
  const { data } = await client().from('login_rewards').select('*').order('day');
  return (data ?? []) as LoginReward[];
}
export async function fetchMatchHistory(limit = 20): Promise<MatchRow[]> {
  if (!currentProfile || currentProfile.isGuest) return [];
  const { data } = await client().from('match_history').select('*').eq('user_id', currentProfile.id).order('played_at', { ascending: false }).limit(limit);
  return (data ?? []) as MatchRow[];
}
export async function fetchLeaderboard(): Promise<{ id: string; nickname: string; rank_points: number; position: number }[]> {
  const { data } = await client().from('leaderboard').select('*');
  return data ?? [];
}
/** 로비 진입 시 한 번에 로드 */
export async function fetchBundle(): Promise<AccountBundle> {
  const profile = currentProfile;
  if (!profile) throw new GameError('NOT_AUTHENTICATED');
  if (profile.isGuest || !supabase) return { profile, stats: { ...EMPTY_STATS }, skins: [], achievements: [], missions: [], shop: [], loginRewards: [] };
  const [stats, skins, achievements, missions, shop, loginRewards] = await Promise.all([
    fetchStats(profile.id), fetchOwnedSkins(), fetchAchievements(), getDailyMissions(), getDailyShop(), fetchLoginRewards(),
  ]);
  return { profile, stats, skins, achievements, missions, shop, loginRewards };
}

// ───────────────────────────── 설정 / 로드아웃 동기화 ─────────────────────────────
let settingsTimer: ReturnType<typeof setTimeout> | null = null;
function queueSettingsSave(s: Settings): void {
  if (!supabase || !currentProfile || currentProfile.isGuest) return;
  if (settingsTimer) clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => { void saveSettingsNow(s); }, 1500); // 슬라이더 드래그 중 과도한 쓰기 방지
}
export async function saveSettingsNow(s: Settings = getSettings()): Promise<void> {
  if (!supabase || !currentProfile || currentProfile.isGuest) return;
  if (settingsTimer) { clearTimeout(settingsTimer); settingsTimer = null; }
  const { error } = await supabase.from('profiles').update({ settings: s }).eq('id', currentProfile.id);
  if (!error) currentProfile.settings = s;
}
export async function saveLoadout(loadout: Loadout): Promise<void> {
  const l = sanitizeLoadout(loadout);
  if (!currentProfile) return;
  patchProfile({ loadout: l });
  if (supabase && !currentProfile.isGuest) await supabase.from('profiles').update({ loadout: l }).eq('id', currentProfile.id);
}

// ───────────────────────────── 닉네임 / 출석 / 상점 / 박스 / 장착 / 미션 ─────────────────────────────
export async function getNicknameChangeCost(): Promise<number> {
  const { data } = await client().from('game_config').select('value').eq('key', 'nickname_change_cost').maybeSingle();
  return Number(data?.value ?? 500);
}
/** 크레딧을 소모해 닉네임 변경 */
export async function changeNickname(nickname: string): Promise<{ nickname: string; credits: number; cost: number }> {
  if (!isValidNickname(nickname)) throw new GameError('INVALID_NICKNAME');
  const r = await rpc<{ nickname: string; credits: number; cost: number }>('change_nickname', { p_nickname: nickname.trim() });
  patchProfile({ nickname: r.nickname, credits: r.credits });
  return r;
}
/** 7일 연속 로그인 보상 (하루 1회, KST 기준) */
export async function claimDailyLogin(): Promise<DailyLoginResult> {
  const r = await rpc<DailyLoginResult>('claim_daily_login');
  patchProfile({ credits: r.credits, lootboxes: r.lootboxes, login_streak: r.streak });
  return r;
}
/** 일일 상점 4종 (매일 KST 자정 갱신) */
export async function getDailyShop(): Promise<ShopItem[]> { return (await rpc<ShopItem[]>('get_daily_shop')) ?? []; }
/** 일일 상점 또는 Featured 스킨 구매 */
export async function buySkin(skinId: string): Promise<{ skin_id: string; credits: number; unlocked: string[] }> {
  const r = await rpc<{ skin_id: string; credits: number; unlocked: string[] }>('buy_skin', { p_skin_id: skinId });
  patchProfile({ credits: r.credits });
  return r;
}
/** 랜덤박스 개봉. useOwned=true 면 보유 박스 소모, 아니면 크레딧 결제. 중복 시 자동 환급. */
export async function openLootbox(boxId = 'standard', useOwned = false): Promise<LootboxResult> {
  const r = await rpc<LootboxResult>('open_lootbox', { p_box_id: boxId, p_use_owned: useOwned });
  patchProfile({ credits: r.credits, lootboxes: r.lootboxes });
  return r;
}
/** 스킨 장착 (skinId=null → 기본 외형) */
export async function equipSkin(weaponId: string, skinId: string | null): Promise<void> { await rpc<void>('equip_skin', { p_weapon_id: weaponId, p_skin_id: skinId }); }
/** 칭호 장착 (null → 해제) */
export async function equipTitle(achievementId: string | null): Promise<void> {
  await rpc<void>('equip_title', { p_achievement_id: achievementId });
  patchProfile({ equipped_title: achievementId });
}
export async function getDailyMissions(): Promise<DailyMission[]> { return (await rpc<DailyMission[]>('get_daily_missions')) ?? []; }
export async function claimMission(slot: number): Promise<{ reward_type: 'credits' | 'lootbox'; reward_amount: number; credits: number; lootboxes: number }> {
  const r = await rpc<{ reward_type: 'credits' | 'lootbox'; reward_amount: number; credits: number; lootboxes: number }>('claim_mission', { p_slot: slot });
  patchProfile({ credits: r.credits, lootboxes: r.lootboxes });
  return r;
}
/** 매치 종료(match:reward) 후 크레딧/RP 재동기화 */
export async function refreshProfile(): Promise<Profile | null> {
  if (!currentProfile || currentProfile.isGuest || !supabase) return currentProfile;
  const { data } = await supabase.from('profiles').select('credits,lootboxes,rank_points,peak_rank_points,nickname,equipped_title,login_streak').eq('id', currentProfile.id).maybeSingle();
  if (data) patchProfile(data as Partial<Profile>);
  return currentProfile;
}