// =====================================================================
// GRIDSTRIKE — 애플리케이션 진입점: 계정 · 로비/상점/미션/업적 · 설정 · 인게임 HUD · 터치 컨트롤 · 렌더 루프
// =====================================================================
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  ACTIONS, ACTION_LABELS, CROSSHAIR_COLORS, CROSSHAIR_PRESETS, FPS_CAP_OPTIONS, HFOV_DEG, RESERVED_CODES, SETTINGS_LIMITS, VALORANT_YAW_DEG,
  applyCrosshairPreset, applyGraphicsPreset, bindFromEvent, bindLabel, cmPer360, createFrameLimiter, drawCrosshair, effectiveFpsCap, effectivePixelRatio,
  getSettings, isTouchDevice, onSettingsChange, resetSettings, setBinding, updateSettings,
  type Action, type CrosshairLines, type CrosshairPresetId, type FpsCap, type Settings,
} from './config/settings';
import {
  MODES, RULES, SLOT, SLOT_KEYS, WEAPONS, WEAPONS_BY_SLOT, damageTable, isGun, tdmTargetKills, tierInfo, tierLevel, tierProgress,
  type GameMode, type Loadout, type SlotKey, type WeaponId,
} from './config/weapons';
import { preloadWeaponModels } from './game/weaponModels';
import { skinSwatchUrl } from './game/skinTextures';
import { FEATURED_BANNER, LOOTBOXES, RARITY, SKIN_WEAPONS, buildGachaReel, featuredSkins, getSkin, lootboxOdds, skinsForWeapon, type SkinDef } from './config/skins';
import {
  GameError, buySkin, changeNickname, claimDailyLogin, claimMission, equipSkin, equipTitle, fetchBundle, fetchMatchHistory, getNicknameChangeCost, getProfile,
  initAuth, isSupabaseConfigured, onProfileChange, openLootbox, patchProfile, refreshProfile, saveLoadout, setGuestNickname, signInWithGoogle, signInWithId, signOut, signUpWithId, startGuest,
  type AccountBundle, type DailyLoginResult, type MatchRow,
} from './services/supabase';
import { SKILLS, SKILL_IDS, ULTS, ULT_IDS, ULT_COST, type SkillId, type UltId } from './config/skills';
import { GameClient, type MatchEnd, type MatchReward, type PlayerInfo, type RoomState } from './game/network';
import { PlayerController } from './game/playerController';

// ───────────────────────────── DOM 헬퍼 ─────────────────────────────
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const show = (id: string, on = true): void => { $(id).classList.toggle('hidden', !on); };
const visible = (id: string): boolean => !$(id).classList.contains('hidden');
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');
const fmt = (n: number): string => n.toLocaleString('ko-KR');
function toast(msg: string, kind: '' | 'good' | 'bad' = ''): void {
  const d = document.createElement('div'); d.className = 'toast ' + kind; d.textContent = msg; $('toasts').appendChild(d);
  setTimeout(() => d.remove(), 2600);
}
const errMsg = (e: unknown): string => (e instanceof GameError ? e.message : (e as Error)?.message ?? String(e));
async function guard<T>(fn: () => Promise<T>): Promise<T | null> { try { return await fn(); } catch (e) { toast(errMsg(e), 'bad'); return null; } }
const TOUCH = isTouchDevice();

// ───────────────────────────── 3D 코어 ─────────────────────────────
const stage = $('stage'), xhair = $<HTMLCanvasElement>('xhair'), xctx = xhair.getContext('2d')!;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x0b0f18);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.05, 600);
preloadWeaponModels();
const net = new GameClient(scene);
const pc = new PlayerController(camera, stage, net);
let renderer!: THREE.WebGLRenderer, rendererAA = false;

function makeRenderer(): void {
  const g = getSettings().graphics;
  if (renderer) { renderer.dispose(); renderer.domElement.remove(); }
  rendererAA = g.antialias !== 'off';
  renderer = new THREE.WebGLRenderer({ antialias: rendererAA, powerPreference: 'high-performance' });
  renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.prepend(renderer.domElement);
  { const pm = new THREE.PMREMGenerator(renderer); scene.environment?.dispose(); scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environmentIntensity = 0.35; pm.dispose(); } // 금속/클리어코트 반사용 약한 IBL
  applyGraphics();
}
function applyGraphics(): void {
  const g = getSettings().graphics;
  if ((g.antialias !== 'off') !== rendererAA) { makeRenderer(); return; } // AA 는 컨텍스트 재생성 필요
  renderer.setPixelRatio(effectivePixelRatio(g)); renderer.setSize(innerWidth, innerHeight, false);
  renderer.shadowMap.enabled = g.shadows !== 'off'; net.arena?.setShadows(g.shadows); net.particles = g.particles;
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  const dpr = Math.min(2, devicePixelRatio || 1); xhair.width = Math.round(innerWidth * dpr); xhair.height = Math.round(innerHeight * dpr);
  show('hud-fps', g.showFps);
  document.body.classList.toggle('left', getSettings().mobile.leftHanded);
  const m = getSettings().mobile; $('touch').style.setProperty('--ts', String(m.buttonScale)); $('touch').style.setProperty('--to', String(m.buttonOpacity));
  $('joy-base').style.width = $('joy-base').style.height = m.joystickSize + 'px';
  $('t-auto').textContent = `Auto-Fire ${m.autoFire ? 'ON' : 'OFF'}`; $('t-auto').classList.toggle('on', m.autoFire);
}
makeRenderer();
addEventListener('resize', applyGraphics);
onSettingsChange(applyGraphics);

// ───────────────────────────── 화면 상태 ─────────────────────────────
type View = 'auth' | 'lobby' | 'room' | 'game';
let view: View = 'auth';
let bundle: AccountBundle | null = null;
let lobbyTab: 'home' | 'shop' | 'inventory' | 'missions' | 'achievements' | 'stats' = 'home';
let history: MatchRow[] = [];
let pendingReward: MatchReward | null = null;

function setView(v: View): void {
  view = v;
  show('auth', v === 'auth'); show('lobby', v === 'lobby'); show('room', v === 'room');
  show('hud', v === 'game'); show('touch', v === 'game' && TOUCH);
  document.body.classList.toggle('ingame', v === 'game');
  if (v !== 'game') { show('scoreboard', false); show('loadout', false); show('m-pause', false); if (document.pointerLockElement) document.exitPointerLock(); pc.releaseAll(); xctx.clearRect(0, 0, xhair.width, xhair.height); }
  pc.captureEnabled = v === 'game';
}
const anyPanelOpen = (): boolean => visible('tacmap') || visible('loadout') || visible('m-pause') || visible('m-settings') || visible('m-result');
function closeModal(id: string): void { show(id, false); if (id === 'm-support') endDevMode(); if (id === 'm-settings' && view === 'game' && !visible('m-pause')) resumeGame(); }
document.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => b.addEventListener('click', () => closeModal(b.closest('.modal')!.id)));

// ───────────────────────────── 인증 ─────────────────────────────
let signupMode = false;
function setAuthMode(up: boolean): void {
  signupMode = up; $('auth-tab-in').classList.toggle('on', !up); $('auth-tab-up').classList.toggle('on', up);
  show('auth-nick', up); $('auth-submit').textContent = up ? '회원가입' : '로그인'; $('auth-err').textContent = '';
}
$('auth-tab-in').onclick = () => setAuthMode(false);
$('auth-tab-up').onclick = () => setAuthMode(true);
$('auth-submit').onclick = async () => {
  const id = $<HTMLInputElement>('auth-id').value, pw = $<HTMLInputElement>('auth-pw').value, nick = $<HTMLInputElement>('auth-nick').value;
  const btn = $<HTMLButtonElement>('auth-submit'); btn.disabled = true; $('auth-err').textContent = '';
  try { if (signupMode) await signUpWithId(id, pw, nick); else await signInWithId(id, pw); net.disconnect(); await enterLobby(); }
  catch (e) { $('auth-err').textContent = errMsg(e); }
  btn.disabled = false;
};
$('auth-pw').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') $('auth-submit').click(); });
$('auth-google').onclick = () => { void guard(signInWithGoogle); };
$('auth-guest').onclick = () => { startGuest(); net.disconnect(); void enterLobby(); };
$('btn-logout').onclick = async () => { net.disconnect(); await signOut(); bundle = null; setView('auth'); };
if (!isSupabaseConfigured) { $('auth-err').textContent = '서버 미설정: 게스트 모드만 이용할 수 있습니다.'; }

// ───────────────────────────── 로비 ─────────────────────────────
async function loadBundle(): Promise<void> {
  const b = await guard(fetchBundle); if (b) bundle = b;
  renderLobby();
}
async function enterLobby(): Promise<void> {
  setView('lobby'); renderTop(); await loadBundle();
  const p = getProfile();
  if (p && !p.isGuest) { // 연속 로그인 보상 (하루 1회)
    const r = await guard(claimDailyLogin);
    if (r?.claimed) { showLoginReward(r); if (bundle) bundle.profile = getProfile()!; renderLobby(); }
  }
}
onProfileChange(() => { if (view === 'lobby') renderTop(); });

function renderTop(): void {
  const p = getProfile(); if (!p) return;
  const t = tierInfo(tierLevel(p.rank_points));
  $('lb-nick').innerHTML = `${esc(p.nickname)} <a style="cursor:pointer;color:var(--acc2)" id="lb-nick-edit">✎</a>`;
  $('lb-nick-edit').onclick = openNickModal;
  const title = bundle?.achievements.find((a) => a.achievement_id === p.equipped_title)?.title;
  $('lb-title').textContent = title ? `「${title}」` : p.isGuest ? '게스트' : '칭호 없음';
  $('lb-tier').innerHTML = `<b style="color:${t.color}">${t.labelKo}</b> ${fmt(p.rank_points)} RP`;
  $('lb-credits').textContent = `◈ ${fmt(p.credits)}`; $('lb-boxes').textContent = `🎁 ${p.lootboxes}`;
  $('btn-logout').textContent = p.isGuest ? '로그인' : '로그아웃';
}
const NAV: [typeof lobbyTab, string][] = [['home', '홈'], ['shop', '상점'], ['inventory', '보관함'], ['missions', '미션·출석'], ['achievements', '업적·칭호'], ['stats', '전적']];
function renderLobby(): void {
  if (view !== 'lobby') return;
  renderTop();
  $('lobby-nav').innerHTML = NAV.map(([k, n]) => `<button data-tab="${k}" class="${k === lobbyTab ? 'on' : ''}">${n}</button>`).join('');
  $('lobby-nav').querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => { lobbyTab = b.dataset.tab as typeof lobbyTab; if (lobbyTab === 'stats') void loadHistory(); renderLobby(); }));
  const body = $('lobby-body'), p = getProfile();
  if (!p) return;
  if (p.isGuest && lobbyTab !== 'home') { body.innerHTML = `<div class="card" style="margin-top:20px">게스트는 전적·상점·미션이 저장되지 않습니다. 로그인하면 클라우드에 모두 저장됩니다.</div>`; return; }
  body.innerHTML = { home: htmlHome, shop: htmlShop, inventory: htmlInventory, missions: htmlMissions, achievements: htmlAchievements, stats: htmlStats }[lobbyTab]();
  bindLobbyBody();
}
const swatch = (s: SkinDef): string => { const u = skinSwatchUrl(s); return u ? `background:url(${u}) center/cover` : `background:linear-gradient(120deg,${hex(s.material.baseColor)} 0%,${hex(s.material.accentColor)} 55%,${hex(s.emissive.mode === 'none' ? s.material.patternColor : s.emissive.color)} 100%)`; };
function skinCard(s: SkinDef, foot: string): string {
  const r = RARITY[s.rarity];
  return `<div class="skin"><div class="sw" style="${swatch(s)}"></div><div class="inf"><span class="rar" style="color:${r.color}">${r.name}</span><span class="nm">${esc(s.name)}</span>${foot}</div></div>`;
}
const owned = (id: string): boolean => !!bundle?.skins.some((s) => s.skin_id === id);

function htmlHome(): string {
  const p = getProfile()!, st = bundle?.stats, tp = tierProgress(p.rank_points), t = tierInfo(tierLevel(p.rank_points));
  const fb = FEATURED_BANNER;
  return `
  ${fb ? `<div class="banner" style="margin-top:14px;background:linear-gradient(110deg,#07070c,${hex(fb.accent)}55 70%,${hex(fb.accent)}aa)"><div class="tag">NEW · FEATURED</div><h3>${esc(fb.title)} 컬렉션</h3><div class="mut">${esc(fb.blurb)}</div><button class="pri" style="margin-top:12px" data-goto="shop">상점에서 보기</button></div>` : ''}
  <h2>내 랭크</h2>
  <div class="card"><div class="row"><b style="font-size:22px;color:${t.color}">${t.labelKo}</b><span class="mut">${fmt(p.rank_points)} RP</span><span class="right mut">${tp.toNext ? `다음 승급까지 ${tp.toNext} RP` : '최상위 티어'}</span></div><div class="bar" style="margin-top:10px"><i style="width:${tp.progress * 100}%"></i></div></div>
  <h2>요약</h2>
  <div class="grid"><div class="stat"><span class="mut">K/D</span><b>${st?.kd ?? 0}</b></div><div class="stat"><span class="mut">헤드샷 비율</span><b>${st?.hs_pct ?? 0}%</b></div><div class="stat"><span class="mut">승률</span><b>${st?.win_rate ?? 0}%</b></div><div class="stat"><span class="mut">매치</span><b>${st?.matches ?? 0}</b></div></div>
  <h2>바로 시작</h2>
  <div class="row" style="flex-wrap:wrap"><button class="pri" data-quick="range">사격장</button><button data-quick="tdm">팀 데스매치 3v3</button><button data-quick="classic">클래식 1v1</button><button data-quick="ranked">경쟁전 1v1</button></div>`;
}
function htmlShop(): string {
  const fb = FEATURED_BANNER, p = getProfile()!;
  const feat = featuredSkins().map((s) => skinCard(s, owned(s.id) ? `<span class="mut">보유 중</span>` : `<button class="sm pri" data-buy="${s.id}">◈ ${fmt(s.price)}</button>`)).join('');
  const daily = (bundle?.shop ?? []).map((it) => { const s = getSkin(it.skin_id); return s ? skinCard(s, it.owned || owned(s.id) ? `<span class="mut">보유 중</span>` : `<button class="sm pri" data-buy="${s.id}">◈ ${fmt(it.price)}</button>`) : ''; }).join('');
  const boxes = Object.values(LOOTBOXES).map((b) => `<div class="card col"><h3>🎁 ${esc(b.name)}</h3><div class="mut" style="font-size:12px">${lootboxOdds(b.id).map((o) => `<span style="color:${RARITY[o.rarity].color}">${RARITY[o.rarity].name} ${o.percent}%</span>`).join(' · ')}</div><div class="mut" style="font-size:12px">중복 획득 시 크레딧으로 환급됩니다.</div><div class="row"><button class="pri" data-box="${b.id}">◈ ${fmt(b.price)} 개봉</button>${b.id === 'standard' ? `<button data-box="${b.id}" data-owned="1" ${p.lootboxes < 1 ? 'disabled' : ''}>보유 박스 사용 (${p.lootboxes})</button>` : ''}</div></div>`).join('');
  return `
  ${fb ? `<div class="banner" style="margin-top:14px;background:linear-gradient(110deg,#07070c,${hex(fb.accent)}55 70%,${hex(fb.accent)}aa)"><div class="tag">NEW · FEATURED</div><h3>${esc(fb.title)}</h3><div class="mut">${esc(fb.blurb)}</div></div><h2>신규 스킨</h2><div class="grid">${feat}</div>` : ''}
  <h2>일일 상점 <small class="mut">매일 자정(KST) 갱신</small></h2><div class="grid">${daily || '<div class="mut">상점 정보를 불러오지 못했습니다.</div>'}</div>
  <h2>랜덤 박스</h2><div class="grid wide">${boxes}</div>`;
}
let invWeapon = 'vandal';
let skillSlot: 'q' | 'e' | 'x' = 'q';
function htmlSkillLoadout(): string {
  const l = getProfile()!.loadout, cur = { q: l.q, e: l.e, x: l.x };
  const slot = (k: 'q' | 'e' | 'x'): string => {
    const d = k === 'x' ? ULTS[cur.x] : SKILLS[cur[k as 'q' | 'e']];
    return `<div class="eqslot ${skillSlot === k ? 'sel' : ''}" data-skslot="${k}"><small>${k === 'x' ? 'X 궁극기' : k.toUpperCase() + ' 스킬'}</small><b>${d.icon} ${esc(d.name)}</b><small>${k === 'x' ? `궁극기 포인트 ${ULT_COST} 필요` : `쿨타임 ${SKILLS[cur[k as 'q' | 'e']].cdMs / 1000}초 · 라운드당 ${SKILLS[cur[k as 'q' | 'e']].uses}회`}</small></div>`;
  };
  const list = skillSlot === 'x'
    ? ULT_IDS.map((id) => `<div class="skcard ${cur.x === id ? 'on' : ''}"><span class="ic">${ULTS[id].icon}</span><b>${esc(ULTS[id].name)}</b><span class="mut" style="font-size:12px">${esc(ULTS[id].desc)}</span>${cur.x === id ? '<span style="color:var(--ok)">장착 중</span>' : `<button class="sm" data-skpick="${id}">X 에 장착</button>`}</div>`).join('')
    : SKILL_IDS.map((id) => { const d = SKILLS[id], other = skillSlot === 'q' ? cur.e : cur.q, mine = cur[skillSlot] === id;
      return `<div class="skcard ${mine ? 'on' : ''}"><span class="ic">${d.icon}</span><b>${esc(d.name)}</b><span class="mut" style="font-size:12px">${esc(d.desc)}</span><span class="mut" style="font-size:11px">쿨타임 ${d.cdMs / 1000}초 · 라운드당 ${d.uses}회</span>${mine ? '<span style="color:var(--ok)">장착 중</span>' : other === id ? `<button class="sm" data-skpick="${id}">${skillSlot.toUpperCase()} 와 교체</button>` : `<button class="sm" data-skpick="${id}">${skillSlot.toUpperCase()} 에 장착</button>`}</div>`; }).join('');
  return `<h2>스킬 로드아웃 <small class="mut">Q / E / X 슬롯을 선택한 뒤 아래 목록에서 장착 — 다음 매치부터 적용</small></h2><div class="slotrow">${slot('q')}${slot('e')}${slot('x')}</div><div class="grid" style="margin:12px 0 18px">${list}</div>`;
}
function htmlInventory(): string {
  const chips = SKIN_WEAPONS.map((w) => `<button class="sm ${w.id === invWeapon ? 'on' : ''}" data-invw="${w.id}">${w.name}</button>`).join('');
  const mine = (bundle?.skins ?? []).filter((s) => s.weapon_id === invWeapon), equipped = mine.find((s) => s.equipped)?.skin_id ?? null;
  const cards = [`<div class="skin"><div class="sw" style="background:linear-gradient(120deg,#2b2f36,#4b525c)"></div><div class="inf"><span class="rar mut">기본</span><span class="nm">기본 외형</span>${equipped ? `<button class="sm" data-equip="">장착</button>` : `<span style="color:var(--ok)">장착 중</span>`}</div></div>`,
    ...mine.map((o) => { const s = getSkin(o.skin_id); return s ? skinCard(s, o.equipped ? `<span style="color:var(--ok)">장착 중</span>` : `<button class="sm" data-equip="${s.id}">장착</button>`) : ''; })].join('');
  return `${htmlSkillLoadout()}<h2>보관함</h2><div class="row" style="flex-wrap:wrap">${chips}</div><div class="grid" style="margin-top:12px">${cards}</div><div class="mut" style="margin-top:10px">전체 스킨 ${skinsForWeapon(invWeapon).length}종 중 ${mine.length}종 보유</div>`;
}
function htmlMissions(): string {
  const p = getProfile()!, today = ((Math.max(1, p.login_streak) - 1) % 7) + 1;
  const days = (bundle?.loginRewards ?? []).map((r) => `<div class="day ${r.day < today ? 'done' : r.day === today ? 'today' : ''}"><b>${r.day}일차</b><br />${r.reward_type === 'credits' ? `◈ ${r.reward_amount}` : `🎁 ×${r.reward_amount}`}</div>`).join('');
  const ms = (bundle?.missions ?? []).map((m) => `<div class="card col"><div class="row"><b>${esc(m.description)}</b><span class="right">${m.reward_type === 'credits' ? `◈ ${m.reward_amount}` : `🎁 랜덤박스 ×${m.reward_amount}`}</span></div><div class="bar"><i style="width:${Math.min(100, (m.progress / m.target) * 100)}%"></i></div><div class="row"><span class="mut">${m.progress} / ${m.target}</span><button class="sm right ${m.progress >= m.target && !m.claimed ? 'pri' : ''}" data-claim="${m.slot}" ${m.claimed || m.progress < m.target ? 'disabled' : ''}>${m.claimed ? '수령 완료' : '보상 받기'}</button></div></div>`).join('');
  return `<h2>7일 연속 로그인 <small class="mut">현재 ${p.login_streak}일 연속</small></h2><div class="days">${days}</div><h2>일일 미션</h2><div class="grid wide">${ms || '<div class="mut">미션이 없습니다.</div>'}</div>`;
}
function achValue(key: string): number {
  const s = bundle?.stats, p = getProfile()!;
  return ({ kills: s?.kills, wins: s?.wins, matches: s?.matches, headshot_kills: s?.headshot_kills, assists: s?.assists, peak_rp: p.peak_rank_points, login_streak: p.best_login_streak, skins_owned: bundle?.skins.length } as Record<string, number | undefined>)[key] ?? 0;
}
function htmlAchievements(): string {
  const p = getProfile()!;
  const rows = (bundle?.achievements ?? []).map((a) => {
    const v = Math.min(achValue(a.stat_key), a.threshold), eq = p.equipped_title === a.achievement_id;
    return `<div class="card col" style="${a.unlocked ? '' : 'opacity:.7'}"><div class="row"><b>${a.unlocked ? '🏆' : '🔒'} ${esc(a.name)}</b><span class="right mut">◈ ${a.credit_reward}</span></div><div class="mut">${esc(a.description)}</div><div class="bar"><i style="width:${a.unlocked ? 100 : (v / a.threshold) * 100}%"></i></div><div class="row"><span class="mut">${a.title ? `칭호 「${esc(a.title)}」` : ''}</span>${a.title && a.unlocked ? `<button class="sm right ${eq ? 'on' : ''}" data-title="${eq ? '' : a.achievement_id}">${eq ? '장착 해제' : '칭호 장착'}</button>` : ''}</div></div>`;
  }).join('');
  return `<h2>업적 · 칭호</h2><div class="grid wide">${rows}</div>`;
}
async function loadHistory(): Promise<void> { history = (await guard(() => fetchMatchHistory(20))) ?? []; if (lobbyTab === 'stats') renderLobby(); }
function htmlStats(): string {
  const s = bundle?.stats;
  const rows = history.map((m) => `<tr><td>${MODES[m.mode as GameMode]?.name ?? m.mode}</td><td>${m.map.toUpperCase()} ${m.team_size}v${m.team_size}</td><td style="color:${m.result === 'win' ? 'var(--ok)' : m.result === 'draw' ? 'var(--mut)' : 'var(--acc)'}">${{ win: '승리', loss: '패배', draw: '무승부', left: '이탈' }[m.result]}</td><td>${m.kills}/${m.deaths}/${m.assists}</td><td>${m.rp_delta ? (m.rp_delta > 0 ? '+' : '') + m.rp_delta : '-'}</td><td>◈ ${m.credits_earned}</td></tr>`).join('');
  return `<h2>통산 전적</h2><div class="grid"><div class="stat"><span class="mut">K / D / A</span><b>${s?.kills ?? 0} / ${s?.deaths ?? 0} / ${s?.assists ?? 0}</b></div><div class="stat"><span class="mut">K/D</span><b>${s?.kd ?? 0}</b></div><div class="stat"><span class="mut">HS%</span><b>${s?.hs_pct ?? 0}%</b></div><div class="stat"><span class="mut">승률</span><b>${s?.win_rate ?? 0}%</b><span class="mut">${s?.wins ?? 0}승 ${s?.losses ?? 0}패</span></div></div>
  <h2>최근 경기</h2><div class="card"><table><tr><th>모드</th><th>맵</th><th>결과</th><th>K/D/A</th><th>RP</th><th>크레딧</th></tr>${rows || '<tr><td colspan="6" class="mut">기록이 없습니다.</td></tr>'}</table></div>`;
}
function bindLobbyBody(): void {
  const body = $('lobby-body'), each = (sel: string, fn: (el: HTMLElement) => void): void => body.querySelectorAll<HTMLElement>(sel).forEach(fn);
  each('[data-goto]', (b) => (b.onclick = () => { lobbyTab = b.dataset.goto as typeof lobbyTab; renderLobby(); }));
  each('[data-quick]', (b) => (b.onclick = () => { const m = b.dataset.quick as GameMode; void startQueue(m, m === 'tdm' ? 3 : 1); }));
  each('[data-buy]', (b) => (b.onclick = async () => {
    const s = getSkin(b.dataset.buy); if (!s || !confirm(`${s.name} 을(를) 구매할까요?`)) return;
    if (await guard(() => buySkin(s.id))) { toast('구매 완료!', 'good'); await loadBundle(); }
  }));
  each('[data-box]', (b) => (b.onclick = () => void runGacha(b.dataset.box!, !!b.dataset.owned)));
  each('[data-invw]', (b) => (b.onclick = () => { invWeapon = b.dataset.invw!; renderLobby(); }));
  each('[data-skslot]', (b) => (b.onclick = () => { skillSlot = b.dataset.skslot as 'q' | 'e' | 'x'; renderLobby(); }));
  each('[data-skpick]', (b) => (b.onclick = () => { // 장착: 일반 스킬은 Q/E 중복 불가(자동 교체), 즉시 저장 + 다음 매치 진입 시 서버로 전달
    const id = b.dataset.skpick!, l = { ...getProfile()!.loadout };
    if (skillSlot === 'x') l.x = id as UltId;
    else { const other = skillSlot === 'q' ? 'e' : 'q'; if (l[other] === id) l[other] = l[skillSlot]; l[skillSlot] = id as SkillId; }
    needReconnect = true; void saveLoadout(l).then(() => renderLobby());
  }));
  each('[data-equip]', (b) => (b.onclick = async () => {
    const id = b.dataset.equip || null;
    try { await equipSkin(invWeapon, id); bundle?.skins.forEach((s) => { if (s.weapon_id === invWeapon) s.equipped = s.skin_id === id; }); net.refreshProfile(); needReconnect = true; renderLobby(); } catch (e) { toast(errMsg(e), 'bad'); }
  }));
  each('[data-claim]', (b) => (b.onclick = async () => { const r = await guard(() => claimMission(+b.dataset.claim!)); if (r) { toast(r.reward_type === 'credits' ? `◈ ${r.reward_amount} 획득` : '랜덤박스 획득', 'good'); await loadBundle(); } }));
  each('[data-title]', (b) => (b.onclick = async () => { try { await equipTitle(b.dataset.title || null); needReconnect = true; renderLobby(); } catch (e) { toast(errMsg(e), 'bad'); } }));
}
/** 스킨/칭호/닉네임 변경 후에는 다음 매치 전에 소켓을 다시 맺어 서버 프로필을 갱신 */
let needReconnect = false;

// ── 랜덤박스 가챠 연출
async function runGacha(boxId: string, useOwned: boolean): Promise<void> {
  const res = await guard(() => openLootbox(boxId, useOwned)); if (!res) return;
  const reel = buildGachaReel(res.skin_id, 40), strip = $('gacha-strip'), CELL = 120, target = reel.length - 4;
  $('gacha-title').textContent = LOOTBOXES[boxId]?.name ?? '랜덤 박스'; $('gacha-result').innerHTML = '<span class="mut">개봉 중…</span>';
  strip.innerHTML = reel.map((s) => `<div style="${swatch(s)};border-bottom:4px solid ${RARITY[s.rarity].color}">${esc(s.name)}</div>`).join('');
  show('m-gacha'); strip.style.transition = 'none'; strip.style.transform = 'translateX(0)';
  const winW = $('gacha-win').clientWidth, end = -(target * CELL + CELL / 2 - winW / 2) + (Math.random() - 0.5) * 70;
  requestAnimationFrame(() => requestAnimationFrame(() => { strip.style.transition = 'transform 4.2s cubic-bezier(.08,.72,.12,1)'; strip.style.transform = `translateX(${end}px)`; }));
  pc.audio.resume();
  setTimeout(() => {
    const s = getSkin(res.skin_id), r = RARITY[(s?.rarity ?? 'common')];
    $('gacha-result').innerHTML = `<div class="pop"><div class="rar" style="color:${r.color};font-size:14px">${r.name}</div><div style="font-size:22px;font-weight:800">${esc(s?.name ?? res.skin_id)}</div>${res.duplicate ? `<div class="mut">이미 보유한 스킨 — ◈ ${fmt(res.refund)} 환급</div>` : `<div style="color:var(--ok)">새 스킨 획득!</div>`}</div>`;
    pc.audio.kill(); void loadBundle();
  }, 4400);
}
function showLoginReward(r: DailyLoginResult): void {
  const days = (bundle?.loginRewards ?? []).map((d) => `<div class="day ${d.day < r.day ? 'done' : d.day === r.day ? 'today' : ''}"><b>${d.day}</b><br />${d.reward_type === 'credits' ? `◈${d.reward_amount}` : '🎁'}</div>`).join('');
  $('login-body').innerHTML = `<div class="days">${days}</div><div style="text-align:center;margin-top:14px;font-size:18px"><b>${r.streak}일 연속 접속!</b><br />${r.reward_type === 'credits' ? `◈ ${r.reward_amount} 크레딧` : `🎁 랜덤박스 ×${r.reward_amount}`} 지급</div>`;
  show('m-login');
}
// ── 닉네임 변경 (크레딧 소모)
async function openNickModal(): Promise<void> {
  const p = getProfile(); if (!p) return;
  $<HTMLInputElement>('nick-input').value = p.nickname; $('nick-err').textContent = '';
  $('nick-cost').textContent = p.isGuest ? '게스트는 무료로 변경할 수 있습니다.' : '비용 확인 중…'; show('m-nick');
  if (!p.isGuest) { const c = await guard(getNicknameChangeCost); $('nick-cost').textContent = `변경 비용: ◈ ${fmt(c ?? 500)} (보유 ◈ ${fmt(p.credits)})`; }
}
$('nick-ok').onclick = async () => {
  const v = $<HTMLInputElement>('nick-input').value, p = getProfile(); if (!p) return;
  try { if (p.isGuest) setGuestNickname(v); else await changeNickname(v); needReconnect = true; show('m-nick', false); toast('닉네임이 변경되었습니다.', 'good'); renderLobby(); }
  catch (e) { $('nick-err').textContent = errMsg(e); }
};

// ───────────────────────────── 플레이 모달 / 매칭 / 사설 방 ─────────────────────────────
const play = { mode: 'classic' as GameMode, size: 1, map: '' as '' | 'grid' | 'arena', fillBots: true, botLevel: 6 };
$('btn-play').onclick = () => { renderPlay(); show('m-play'); };
function renderPlay(): void {
  const m = MODES[play.mode]; if (!m.teamSizes.includes(play.size)) play.size = m.teamSizes[0];
  const modes = (Object.keys(MODES) as GameMode[]).map((k) => `<div class="mode ${k === play.mode ? 'on' : ''}" data-mode="${k}"><b>${MODES[k].name}</b>${MODES[k].badge ? `<span class="badge">${MODES[k].badge}</span>` : ''}<small>${MODES[k].desc}</small></div>`).join('');
  const sizes = m.teamSizes.map((n) => `<button class="sm ${n === play.size ? 'on' : ''}" data-size="${n}">${n}v${n}${play.mode === 'tdm' ? ` · ${tdmTargetKills(n)}킬` : ''}</button>`).join('');
  const maps = ([['', '자동'], ['grid', 'GRID'], ['arena', 'ARENA']] as const).map(([k, n]) => `<button class="sm ${k === play.map ? 'on' : ''}" data-map="${k}">${n}</button>`).join('');
  const priv = play.mode === 'classic' || play.mode === 'tdm';
  $('play-body').innerHTML = `<div class="modes">${modes}</div>
  ${play.mode === 'range' ? '' : `<div class="col" style="margin-top:14px"><div class="row" style="flex-wrap:wrap"><span class="mut" style="width:60px">인원</span>${sizes}</div><div class="row"><span class="mut" style="width:60px">맵</span>${maps}</div></div>`}
  <div class="row" style="margin-top:16px;flex-wrap:wrap"><button class="pri" id="play-go">${play.mode === 'range' ? '사격장 입장' : '매칭 시작'}</button><span class="mut" style="font-size:12px">빈 자리는 AI 봇이 채우며, 유저가 들어오면 실시간 교체됩니다.</span></div>
  ${priv ? `<h2>사설 내전 (4자리 방 코드)</h2><div class="row" style="flex-wrap:wrap"><button id="play-create">방 만들기</button><label class="row"><input type="checkbox" id="play-fill" ${play.fillBots ? 'checked' : ''}/> 봇 채우기</label><span class="grow"></span><input id="play-code" inputmode="numeric" maxlength="4" placeholder="방 코드" style="width:110px" /><button id="play-join">코드로 입장</button></div>` : ''}`;
  const body = $('play-body');
  body.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => (b.onclick = () => { play.mode = b.dataset.mode as GameMode; renderPlay(); }));
  body.querySelectorAll<HTMLElement>('[data-size]').forEach((b) => (b.onclick = () => { play.size = +b.dataset.size!; renderPlay(); }));
  body.querySelectorAll<HTMLElement>('[data-map]').forEach((b) => (b.onclick = () => { play.map = b.dataset.map as typeof play.map; renderPlay(); }));
  $('play-go').onclick = () => void startQueue(play.mode, play.size, play.map || undefined);
  if (priv) {
    $<HTMLInputElement>('play-fill').onchange = (e) => { play.fillBots = (e.target as HTMLInputElement).checked; };
    $('play-create').onclick = async () => {
      if (!(await ensureConnected())) return;
      const r = await net.createRoom({ mode: play.mode as 'classic' | 'tdm', teamSize: play.size, map: play.map || 'arena', fillBots: play.fillBots, botLevel: tierLevel(getProfile()?.rank_points ?? 0) });
      if (!r.ok) toast(ackMsg(r.error), 'bad'); else show('m-play', false);
    };
    $('play-join').onclick = async () => {
      if (!(await ensureConnected())) return;
      const r = await net.joinRoom($<HTMLInputElement>('play-code').value.trim());
      if (!r.ok) toast(ackMsg(r.error), 'bad'); else show('m-play', false);
    };
  }
}
const ACK_KO: Record<string, string> = { LOGIN_REQUIRED: '경쟁전은 로그인이 필요합니다.', ROOM_FULL: '방이 가득 찼습니다.', ROOM_NOT_FOUND: '방을 찾을 수 없습니다.', ROOM_CLOSING: '종료 중인 방입니다.', NOT_CONNECTED: '서버에 연결되지 않았습니다.', TIMEOUT: '서버 응답이 없습니다.', TEAM_FULL: '해당 팀이 가득 찼습니다.', TEAM_EMPTY: '양 팀에 최소 1명이 필요합니다.', NOT_HOST: '방장만 할 수 있습니다.', NOT_ALLOWED: '지금은 할 수 없습니다.' };
const ackMsg = (code?: string): string => ACK_KO[code ?? ''] ?? code ?? '요청 실패';
async function ensureConnected(): Promise<boolean> {
  pc.audio.resume();
  if (needReconnect) { net.disconnect(); needReconnect = false; }
  if (net.connected) return true;
  try { net.disconnect(); await net.connect(); return true; } catch (e) { toast('서버 연결 실패: ' + errMsg(e), 'bad'); return false; }
}
async function startQueue(mode: GameMode, size: number, map?: 'grid' | 'arena'): Promise<void> {
  if (!(await ensureConnected())) return;
  const r = await net.queueJoin(mode, size, map);
  if (!r.ok) { toast(ackMsg(r.error), 'bad'); return; }
  show('m-play', false);
}

function renderRoom(): void {
  const room = net.room; if (!room || view !== 'room') return;
  const host = room.hostId === net.you, me = net.me;
  const col = (t: number): string => { const list = room.players.filter((p) => p.team === t); return `<div class="card grow"><h3 style="color:${t === 0 ? 'var(--ally)' : 'var(--enemy)'}">${t === 0 ? 'A 팀' : 'B 팀'} (${list.length}/${room.teamSize})</h3>${list.map((p) => `<div class="row" style="padding:4px 0">${p.id === room.hostId ? '👑' : ''}<b>${esc(p.name)}</b><span class="mut">${tierInfo(p.tier).labelKo}</span></div>`).join('') || '<div class="mut">비어 있음</div>'}${me && me.team !== t ? `<button class="sm" style="margin-top:8px" data-team="${t}">이 팀으로</button>` : ''}</div>`; };
  $('room-body').innerHTML = `<div class="card col"><div class="row"><h3 style="font-size:20px">사설 방</h3><span class="chip" style="font-size:18px;letter-spacing:4px">코드 ${esc(room.code)}</span><button class="right ghost" id="room-leave">나가기</button></div>
    <div class="row" style="flex-wrap:wrap"><span class="chip">${MODES[room.mode].name}</span><span class="chip">${room.teamSize}v${room.teamSize}</span><span class="chip">${room.mapId.toUpperCase()}</span><span class="chip">봇 채우기 ${room.fillBots ? 'ON' : 'OFF'}</span><span class="chip">봇 난이도 ${tierInfo(room.botLevel).labelKo}</span></div>
    ${host ? `<div class="row" style="flex-wrap:wrap"><select id="rc-mode"><option value="classic">클래식</option><option value="tdm">팀 데스매치</option></select><select id="rc-map"><option value="arena">ARENA</option><option value="grid">GRID</option></select><select id="rc-size">${[1, 2, 3, 4, 5, 6].map((n) => `<option value="${n}">${n}v${n}</option>`).join('')}</select><select id="rc-bot">${Array.from({ length: 20 }, (_, i) => `<option value="${i}">${tierInfo(i).labelKo}</option>`).join('')}</select><label class="row"><input type="checkbox" id="rc-fill" ${room.fillBots ? 'checked' : ''}/> 봇 채우기</label></div>` : '<div class="mut">방장이 게임을 시작하기를 기다리는 중…</div>'}
    <div class="row" style="align-items:stretch">${col(0)}${col(1)}</div>${host ? '<button class="pri" id="room-start">게임 시작</button>' : ''}</div>`;
  $('room-leave').onclick = () => { void net.leaveRoom(); void enterLobby(); };
  $('room-body').querySelectorAll<HTMLElement>('[data-team]').forEach((b) => (b.onclick = async () => { const r = await net.setTeam(+b.dataset.team! as 0 | 1); if (!r.ok) toast(ackMsg(r.error), 'bad'); }));
  if (host) {
    const sel = (id: string, v: string | number): HTMLSelectElement => { const e = $<HTMLSelectElement>(id); e.value = String(v); return e; };
    sel('rc-mode', room.mode).onchange = (e) => void net.configRoom({ mode: (e.target as HTMLSelectElement).value as 'classic' | 'tdm' });
    sel('rc-map', room.mapId).onchange = (e) => void net.configRoom({ map: (e.target as HTMLSelectElement).value as 'grid' | 'arena' });
    sel('rc-size', room.teamSize).onchange = (e) => void net.configRoom({ teamSize: +(e.target as HTMLSelectElement).value });
    sel('rc-bot', room.botLevel).onchange = (e) => void net.configRoom({ botLevel: +(e.target as HTMLSelectElement).value });
    $<HTMLInputElement>('rc-fill').onchange = (e) => void net.configRoom({ fillBots: (e.target as HTMLInputElement).checked });
    $('room-start').onclick = async () => { const r = await net.startRoom(); if (!r.ok) toast(ackMsg(r.error), 'bad'); };
  }
}

// ───────────────────────────── 인게임 전환 ─────────────────────────────
function enterGame(): void {
  setView('game'); applyGraphics(); pendingReward = null; show('m-result', false);
  show('range-panel', net.mode === 'range'); show('hud-top', net.mode !== 'range'); show('hud-skills', true);
  setBanner('', ''); if (!TOUCH) pc.requestCapture();
  if (net.mode === 'range') toggleLoadout(true);
}
function resumeGame(): void { show('m-pause', false); show('loadout', false); if (view === 'game' && !TOUCH) pc.requestCapture(); }
async function leaveGame(): Promise<void> {
  await net.leaveRoom(); await refreshProfile(); await enterLobby();
}
function onRoomState(room: RoomState): void {
  if (room.phase === 'lobby') { if (view !== 'room') setView('room'); renderRoom(); }
  else if (view !== 'game') enterGame();
}
net.on('joined', onRoomState); net.on('state', onRoomState);
net.on('roster', () => { if (view === 'room') renderRoom(); if (visible('scoreboard')) renderScoreboard(); });
net.on('closed', () => { if (view === 'game' && !visible('m-result')) void leaveAfterClose(); });
net.on('disconnect', () => { if (view === 'game' || view === 'room') { toast('서버와의 연결이 끊어졌습니다.', 'bad'); void enterLobby(); } });
net.on('error', (code) => toast(ackMsg(code), 'bad'));
async function leaveAfterClose(): Promise<void> { await refreshProfile(); await enterLobby(); }

let bannerUntil = 0;
function setBanner(title: string, sub: string, ms = 0): void { $('hud-banner').innerHTML = title ? `${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ''}` : ''; bannerUntil = ms ? performance.now() + ms : 0; }
net.on('phase', (p) => {
  if (net.room && view !== 'game' && p.phase !== 'lobby') enterGame();
  if (view !== 'game' || !net.room) return;
  const round = net.mode === 'classic' || net.mode === 'ranked';
  if (p.phase === 'buy') { setBanner(round ? `ROUND ${p.round}` : '준비', '무기를 선택하세요 — 4개 슬롯 자유 선택 (B)'); if (TOUCH) toggleLoadout(true); }
  else if (p.phase === 'live') { setBanner(round ? '전투 개시' : 'FIGHT', '', 1500); if (visible('loadout') && net.mode !== 'range') toggleLoadout(false); }
  else if (p.phase === 'roundEnd') setBanner(p.winner === undefined || p.winner < 0 ? '무승부' : p.winner === net.myTeam ? '라운드 승리' : '라운드 패배', `${p.score[net.myTeam]} : ${p.score[1 - net.myTeam]}`);
});
net.on('matchEnd', (m) => showResult(m));
net.on('reward', (r) => { pendingReward = r; if (visible('m-result')) fillReward(); });
function showResult(m: MatchEnd): void {
  if (document.pointerLockElement) document.exitPointerLock();
  show('loadout', false); show('m-pause', false); show('scoreboard', false);
  const mine = m.players.find((p) => p.id === net.you), win = m.winner === net.myTeam;
  $('res-title').textContent = m.winner < 0 ? '무승부' : win ? '승리' : '패배';
  $('res-title').style.color = m.winner < 0 ? '' : win ? 'var(--ok)' : 'var(--acc)';
  $('res-body').innerHTML = `<div style="font-size:30px;font-weight:800;text-align:center">${m.score[net.myTeam]} : ${m.score[1 - net.myTeam]}</div><div class="mut" style="text-align:center">K/D/A ${mine?.k ?? 0} / ${mine?.d ?? 0} / ${mine?.a ?? 0} · 헤드샷 킬 ${mine?.hs ?? 0} · 피해 ${fmt(mine?.dmg ?? 0)}</div><div id="res-reward" class="mut" style="text-align:center;margin-top:10px">보상 정산 중…</div>`;
  show('m-result'); fillReward();
}
function fillReward(): void {
  const r = pendingReward, el = document.getElementById('res-reward'); if (!r || !el) return;
  el.innerHTML = `${r.rp_delta ? `<b style="color:${r.rp_delta > 0 ? 'var(--ok)' : 'var(--acc)'}">${r.rp_delta > 0 ? '+' : ''}${r.rp_delta} RP</b> · ` : ''}◈ +${r.credits_earned ?? r.credits}${r.saved ? '' : ' <span class="mut">(저장되지 않는 경기)</span>'}${r.unlocked?.length ? `<br />🏆 업적 ${r.unlocked.length}개 달성!` : ''}`;
}
$('res-ok').onclick = () => { show('m-result', false); void leaveGame(); };

// ── 일시 메뉴 / 포인터 락
document.addEventListener('pointerlockchange', () => { if (view === 'game' && !document.pointerLockElement && !anyPanelOpen() && !TOUCH && net.phase !== 'ended') show('m-pause'); });
$('pause-resume').onclick = resumeGame;
$('pause-load').onclick = () => { show('m-pause', false); toggleLoadout(true); };
$('pause-settings').onclick = () => openSettings();
$('pause-leave').onclick = () => void leaveGame();
$('t-menu').onclick = () => show('m-pause', !visible('m-pause'));
$('t-load').onclick = () => toggleLoadout(!visible('loadout'));
$('range-exit').onclick = () => void leaveGame();
$('range-load').onclick = () => toggleLoadout(true);
$('range-move').onclick = () => net.setRangeMoving(!net.rangeMoving);
net.on('rangeConfig', (moving) => { $('range-move').textContent = `봇 이동: ${moving ? 'ON' : 'OFF'}`; });

pc.onUiAction = (a, down) => {
  if (view !== 'game') return;
  if (a === 'scoreboard') { show('scoreboard', down); if (down) renderScoreboard(); }
  else if (a === 'loadout' && down) toggleLoadout(!visible('loadout'));
  else if (a === 'menu' && down && TOUCH) show('m-pause', !visible('m-pause'));
};
// 모바일: 상단 점수판 터치로 스코어보드
$('hud-top').addEventListener('pointerdown', () => { show('scoreboard', true); renderScoreboard(); });
addEventListener('pointerup', () => { if (TOUCH && visible('scoreboard')) show('scoreboard', false); });

// ───────────────────────────── 로드아웃 (4슬롯 자유 선택) ─────────────────────────────
const SLOT_LABEL: Record<SlotKey, string> = { primary: '1 · 주무기', secondary: '2 · 보조', melee: '3 · 근접', throwable: '4 · 투척' };
function currentLoadout(): Loadout { return { ...(net.me?.loadout ?? getProfile()!.loadout) }; }
let loadoutDraft: Loadout | null = null;
function toggleLoadout(on: boolean): void {
  if (view !== 'game') return;
  if (on) { loadoutDraft = currentLoadout(); renderLoadout(); show('loadout'); if (document.pointerLockElement) document.exitPointerLock(); pc.releaseAll(); }
  else { show('loadout', false); if (!TOUCH && !visible('m-pause')) pc.requestCapture(); }
}
function weaponBlurb(id: WeaponId): string {
  const w = WEAPONS[id];
  if (isGun(w)) { const t = damageTable(w)[0]; return `머리 ${t.head} · 몸 ${t.body}${w.pellets ? ` ×${w.pellets}` : ''} · ${w.mag}발`; }
  if (w.type === 'melee') return `피해 ${w.dmg} · ${(1000 / w.intervalMs).toFixed(1)}회/초 · 이속 ×${w.move}`;
  return id === 'grenade' ? `범위 폭발 ${w.maxDmg} · ${w.charges}개` : `좌: 원거리 / 우: 언더핸드 · ${w.charges}개`;
}
function renderLoadout(): void {
  const l = loadoutDraft ?? currentLoadout();
  const rows = (Object.keys(WEAPONS_BY_SLOT) as SlotKey[]).map((k) => `<div class="ld-row"><b>${SLOT_LABEL[k]}</b><div class="ld-opts">${WEAPONS_BY_SLOT[k].map((id) => `<button class="${l[k] === id ? 'on' : ''}" data-slotkey="${k}" data-wid="${id}">${WEAPONS[id].name}<small>${weaponBlurb(id)}</small></button>`).join('')}</div></div>`).join('');
  $('loadout').innerHTML = `<div class="mh"><h3>로드아웃</h3><span class="mut" style="margin-left:10px;font-size:12px">${net.mode === 'range' ? '사격장: 모든 무기를 즉시 교체해 테스트' : '구매 시간·스폰 직후엔 즉시, 그 외엔 다음 스폰에 적용'}</span><button class="x" id="ld-close">✕</button></div>${rows}<div class="row" style="margin-top:10px"><button class="pri right" id="ld-ok">확인</button></div>`;
  $('ld-close').onclick = $('ld-ok').onclick = () => toggleLoadout(false);
  $('loadout').querySelectorAll<HTMLElement>('[data-wid]').forEach((b) => (b.onclick = async () => {
    const next = { ...l, [b.dataset.slotkey as SlotKey]: b.dataset.wid } as Loadout;
    loadoutDraft = next; renderLoadout(); void saveLoadout(next);
    const r = await net.setLoadout(next);
    if (r.ok && r.applied === false) toast('다음 스폰부터 적용됩니다.');
  }));
}

// ───────────────────────────── 스코어보드 (트래커 스타일) ─────────────────────────────
function renderScoreboard(): void {
  const room = net.room; if (!room) return;
  const { allies, enemies } = net.scoreboard();
  const tbl = (list: PlayerInfo[]): string => `<table><tr><th>플레이어</th><th>티어</th><th>K</th><th>D</th><th>A</th><th>통산 K/D</th><th>HS%</th><th>승률</th></tr>${list.map((p) => { const t = tierInfo(p.tier); return `<tr class="${p.id === net.you ? 'me' : ''}"><td>${esc(p.name)}${p.bot ? ' <span class="mut">[BOT]</span>' : ''}${p.title ? ` <span class="mut">「${esc(p.title)}」</span>` : ''}</td><td style="color:${t.color}">${t.labelKo}</td><td><b>${p.k}</b></td><td>${p.d}</td><td>${p.a}</td><td>${p.bot ? '-' : p.career.kd}</td><td>${p.bot ? '-' : p.career.hs + '%'}</td><td>${p.bot ? '-' : p.career.wr + '%'}</td></tr>`; }).join('')}</table>`;
  const me = net.me;
  $('sb-body').innerHTML = `<div class="row"><h3 style="font-size:18px">${MODES[room.mode].name} · ${room.mapId.toUpperCase()} · ${room.teamSize}v${room.teamSize}</h3><span class="right" style="font-size:22px;font-weight:800"><span style="color:var(--ally)">${room.score[net.myTeam]}</span> : <span style="color:var(--enemy)">${room.score[1 - net.myTeam]}</span></span></div>
  ${me ? `<div class="row mut" style="margin:6px 0 10px;font-size:13px">내 전적 — K/D <b style="color:#fff">${me.career.kd}</b> · HS% <b style="color:#fff">${me.career.hs}%</b> · 승률 <b style="color:#fff">${me.career.wr}%</b></div>` : ''}
  <h3 class="a">아군</h3>${tbl(allies)}<h3 class="e" style="margin-top:14px">적군</h3>${tbl(enemies)}`;
}

// ───────────────────────────── HUD ─────────────────────────────
let hitUntil = 0, kfSig = '', fpsFrames = 0, fpsAt = performance.now();
net.on('hit', (h) => { hitUntil = performance.now() + (h.k ? 320 : 160); $('hitmarker').classList.toggle('hs', h.z === 'head' || h.k); });
net.on('kill', () => { if (visible('scoreboard')) renderScoreboard(); });
// ── 스킬 알림 / 오멘 전술 맵 / 청부 계약 연출
let lastDenyAt = 0;
pc.onSkillDenied = (msg) => { const t = performance.now(); if (t - lastDenyAt > 700) { lastDenyAt = t; toast(msg, 'bad'); } };
net.on('duel', (d) => { if (d.a === net.you || d.b === net.you) setBanner('청부 계약', '15초 1:1 결투 — 승자만 원래 위치로 복귀', 3000); });
net.on('duelEnd', (d) => { if (d.a === net.you || d.b === net.you) toast(d.w === net.you ? '결투 승리! 원래 위치로 복귀' : '결투 패배', d.w === net.you ? 'good' : 'bad'); });
net.on('ult', (u) => { if (u.id === net.you && u.ph === 'cancel') toast('피격으로 그림자 습격이 취소되었습니다', 'bad'); });
let tacHover: { x: number; z: number } | null = null;
function tacGeom(): { sc: number; ox: number; oz: number; w: number; h: number } | null {
  const world = net.world, cv = $<HTMLCanvasElement>('tac-canvas'); if (!world) return null;
  const b = world.bounds, ww = b.x1 - b.x0, hh = b.z1 - b.z0, sc = Math.min((cv.width - 20) / ww, (cv.height - 20) / hh);
  return { sc, ox: (cv.width - ww * sc) / 2 - b.x0 * sc, oz: (cv.height - hh * sc) / 2 - b.z0 * sc, w: ww, h: hh };
}
function drawTacMap(): void {
  const cv = $<HTMLCanvasElement>('tac-canvas'), c = cv.getContext('2d'), world = net.world, g = tacGeom(); if (!c || !world || !g) return;
  c.clearRect(0, 0, cv.width, cv.height); const b = world.bounds;
  c.fillStyle = '#121a26'; c.fillRect(g.ox + b.x0 * g.sc, g.oz + b.z0 * g.sc, g.w * g.sc, g.h * g.sc);
  for (const bx of world.boxes) {
    if (bx[6] === 'bound' || bx[6] === 'duel' || bx[6] === 'duelfloor' || bx[4] - bx[1] < 0.5) continue;
    c.fillStyle = bx[6] === 'barrier' ? '#5ef0ff' : bx[4] > 3 ? '#4a5568' : '#2f3a4a'; c.fillRect(g.ox + bx[0] * g.sc, g.oz + bx[2] * g.sc, (bx[3] - bx[0]) * g.sc, (bx[5] - bx[2]) * g.sc);
  }
  const me = pc.pos; c.fillStyle = '#fff'; c.beginPath(); c.arc(g.ox + me.x * g.sc, g.oz + me.z * g.sc, 5, 0, 7); c.fill();
  if (tacHover) {
    const x = g.ox + tacHover.x * g.sc, z = g.oz + tacHover.z * g.sc, bad = world.blocked({ x: tacHover.x, y: 0, z: tacHover.z }, 1.8);
    c.strokeStyle = bad ? '#ff4655' : '#b06bff'; c.lineWidth = 2; c.beginPath(); c.arc(x, z, 9, 0, 7); c.moveTo(x - 14, z); c.lineTo(x + 14, z); c.moveTo(x, z - 14); c.lineTo(x, z + 14); c.stroke();
  }
}
function tacPoint(e: MouseEvent): { x: number; z: number } | null {
  const cv = $<HTMLCanvasElement>('tac-canvas'), r = cv.getBoundingClientRect(), g = tacGeom(); if (!g) return null;
  return { x: ((e.clientX - r.left) * (cv.width / r.width) - g.ox) / g.sc, z: ((e.clientY - r.top) * (cv.height / r.height) - g.oz) / g.sc };
}
function closeTacMap(): void { show('tacmap', false); if (view === 'game' && !TOUCH && !visible('m-pause')) pc.requestCapture(); }
pc.onOmenPrompt = () => { tacHover = null; show('tacmap'); if (document.pointerLockElement) document.exitPointerLock(); pc.releaseAll(); drawTacMap(); };
$('tac-close').onclick = closeTacMap;
$('tac-canvas').addEventListener('mousemove', (e) => { tacHover = tacPoint(e); drawTacMap(); });
$('tac-canvas').addEventListener('click', (e) => {
  const p = tacPoint(e), world = net.world; if (!p || !world) return;
  if (world.blocked({ x: p.x, y: 0, z: p.z }, 1.8)) { toast('해당 위치로는 이동할 수 없습니다', 'bad'); return; }
  pc.castOmen(p.x, p.z); closeTacMap();
});
addEventListener('keydown', (e) => { if (e.code === 'Escape' && visible('tacmap')) closeTacMap(); });
// ── 킬 배너 / 연속 킬 (라운드 내 누적, 라운드 시작·사망 시 초기화)
let killStreak = 0, kbTimer = 0;
function killBannerSvg(n: number, hs: boolean): string {
  const col = n >= 5 ? '#ffd34d' : n >= 3 ? '#ff9f3b' : n === 2 ? '#fff' : '#5ef0ff', acc = hs ? '#ff3b4a' : col;
  const wing = (dir: number) => {
    let d = '';
    for (let i = 0; i < Math.min(n, 5); i++) d += `<path d="M${95 + dir * (22 + i * 13)} ${39 - 6 - i * 2} l${dir * 10} ${-3 - i} l${-dir * 4} ${9 + i * 2} z" fill="${col}" opacity="${0.55 + i * 0.1}"/>`;
    return d;
  };
  const core = `<path d="M95 8 L122 39 L95 70 L68 39 Z" fill="#0b0f16" stroke="${acc}" stroke-width="3"/><path d="M95 18 L113 39 L95 60 L77 39 Z" fill="none" stroke="${col}" stroke-width="1.5" opacity=".8"/>`;
  const mid = hs
    ? `<circle cx="95" cy="39" r="11" fill="none" stroke="#ff3b4a" stroke-width="2.5"/><circle cx="95" cy="39" r="5" fill="#ff3b4a"/><path d="M95 22v10M95 46v10M78 39h10M102 39h10" stroke="#ff3b4a" stroke-width="2.5"/>`
    : `<text x="95" y="48" text-anchor="middle" font-family="sans-serif" font-weight="900" font-size="26" fill="${col}">${n >= 5 ? '★' : n}</text>`;
  const crown = n >= 5 ? `<path d="M80 6 l8 -8 l7 8 l7 -8 l8 8" fill="none" stroke="#ffd34d" stroke-width="3"/>` : '';
  return `<svg viewBox="0 0 190 78">${wing(1)}${wing(-1)}${core}${mid}${crown}</svg>`;
}
function showKillBanner(n: number, hs: boolean): void {
  const el = $('killbanner'), label = n >= 5 ? 'ACE' : `${n} KILL`;
  el.innerHTML = `<div class="kb ${hs ? 'hs' : ''} ${n >= 5 ? 'ace' : ''}" style="--kc:${n >= 5 ? '#ffd34d' : n >= 3 ? '#ff9f3b' : n === 2 ? '#fff' : '#5ef0ff'}">${killBannerSvg(n, hs)}<b>${hs ? 'HEADSHOT · ' : ''}${label}</b></div>`;
  clearTimeout(kbTimer); kbTimer = window.setTimeout(() => { el.innerHTML = ''; }, 2550);
}
net.on('kill', (k, raw) => {
  if (raw.v === net.you) { killStreak = 0; return; }
  if (raw.k !== net.you || k.suicide) return;
  killStreak++;
  showKillBanner(killStreak, k.hs); pc.audio.killStreak(killStreak, k.hs);
});
net.on('phase', (p) => { if (p.phase === 'buy' || p.phase === 'live') { killStreak = 0; $('killbanner').innerHTML = ''; } });

$('hud-slots').querySelectorAll<HTMLElement>('[data-slot]').forEach((d) => d.addEventListener('pointerdown', () => pc.switchSlot(+d.dataset.slot! as 1 | 2 | 3 | 4)));

function updateHud(now: number): void {
  const h = pc.getHudState(), room = net.room, s = getSettings();
  // 조준선 (픽셀 캔버스)
  xctx.clearRect(0, 0, xhair.width, xhair.height);
  const dpr = xhair.width / innerWidth;
  if (h.alive && !h.scoped && h.flash < 0.9 && !anyPanelOpen()) drawCrosshair(xctx, s.crosshair, xhair.width / 2, xhair.height / 2, Math.max(1, Math.round(dpr)), h.spreadPx > 14 ? h.spreadPx * dpr : 0);
  // 체력 / 탄약 / 슬롯
  $('hud-hp').textContent = String(h.hp); ($('hud-hpbar').firstElementChild as HTMLElement).style.width = `${(h.hp / h.maxHp) * 100}%`;
  $('hud-hp').style.color = h.hp < 45 ? 'var(--acc)' : '';
  $('hud-ammo').innerHTML = h.slot === SLOT.melee ? '∞' : h.reloading ? `<small>재장전 ${Math.round(h.reloadProgress * 100)}%</small>` : `${h.ammo}<small> / ${h.magSize}</small>`;
  $('hud-weapon').textContent = h.weaponName;
  $('hud-slots').querySelectorAll<HTMLElement>('[data-slot]').forEach((d) => d.classList.toggle('on', +d.dataset.slot! === h.slot));
  const sk = (id: string, cd: number, act: boolean): void => { const e = $(id); (e.lastElementChild as HTMLElement).style.height = `${cd * 100}%`; e.classList.toggle('act', act); };
  const skFill = (id: string, d: { icon: string; name: string }, uses: string, cd: number, act: boolean, off: boolean): void => {
    const e = $(id); sk(id, cd, act); e.classList.toggle('off', off);
    (e.children[1] as HTMLElement).textContent = d.icon; (e.children[2] as HTMLElement).textContent = `${d.name} ${uses}`;
  };
  skFill('sk-q', h.q, `${h.q.left}/${h.q.max}`, h.qCooldown, h.q.active, h.silenced || h.q.left <= 0);
  skFill('sk-e', h.e, `${h.e.left}/${h.e.max}`, h.eCooldown, h.e.active, h.silenced || h.e.left <= 0);
  skFill('sk-x', h.ult, h.ult.ready ? 'READY' : `${h.ult.pts}/${ULT_COST}`, 1 - h.ult.pts / ULT_COST, h.ult.casting || h.driftLeft > 0, h.silenced);
  $('sk-x').classList.toggle('rdy', h.ult.ready && !h.silenced);
  $('ult-pips').innerHTML = Array.from({ length: ULT_COST }, (_, i) => `<i class="${i < h.ult.pts ? 'on' : ''}"></i>`).join('');
  $('ult-name').textContent = h.ult.ready ? `[X] ${h.ult.name} 준비 완료` : `궁극기 ${h.ult.pts}/${ULT_COST} · 킬/데스/라운드 +1`; $('ult-name').classList.toggle('rdy', h.ult.ready);
  const sec = (ms: number): string => (ms / 1000).toFixed(1);
  $('hud-status').innerHTML = [
    h.silenced ? `<span class="sil">침묵 ${sec(h.silenceLeft)}s</span>` : '', h.ampLeft ? `<span class="amp">증폭 ${sec(h.ampLeft)}s</span>` : '', h.healLeft ? `<span class="heal">치유 ${sec(h.healLeft)}s</span>` : '',
    h.shieldBuffLeft ? `<span class="shd">구슬 생성 ${sec(h.shieldBuffLeft)}s</span>` : '', h.shieldOn ? `<span class="shd">보호막 ◈</span>` : '', h.driftLeft ? `<span class="drift">차원 표류 ${sec(h.driftLeft)}s</span>` : '',
  ].join('');
  show('hud-cast', h.ult.casting); if (h.ult.casting) { $('cast-label').textContent = '그림자 습격 시전 중…'; ($('cast-bar').firstElementChild as HTMLElement).style.width = `${(1 - h.ult.castLeft / 1500) * 100}%`; }
  // 점수 / 타이머
  if (room && room.mode !== 'range') {
    const ms = net.phaseRemainingMs(), sec = Math.ceil(ms / 1000);
    $('hud-timer').textContent = `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    $('hud-sa').textContent = String(room.score[net.myTeam]); $('hud-sb').textContent = String(room.score[1 - net.myTeam]);
    $('hud-goal').textContent = room.mode === 'tdm' ? `목표 ${room.target}킬` : `ROUND ${room.round} · ${RULES.roundsToWin}선승`;
  }
  // 킬로그
  const kf = net.activeKillfeed(), sig = kf.map((k) => k.at).join(',');
  if (sig !== kfSig) {
    kfSig = sig; const t = net.myTeam;
    $('killfeed').innerHTML = kf.map((k) => `<div class="kf ${k.mine ? 'mine' : ''}"><span class="${k.killerTeam === t ? 'a' : 'e'}">${k.suicide ? '' : esc(k.killer)}</span>${k.assists.length ? `<span class="mut"> + ${k.assists.map(esc).join(', ')}</span>` : ''}<span class="w">${k.suicide ? '☠' : `[${esc(WEAPONS[k.weapon]?.name ?? k.weapon)}]`}${k.hs ? ' <span class="hs">◎</span>' : ''}</span><span class="${k.victimTeam === t ? 'a' : 'e'}">${esc(k.victim)}</span></div>`).join('');
  }
  $('hitmarker').style.opacity = now < hitUntil ? '1' : '0';
  if (bannerUntil && now > bannerUntil) setBanner('', '');
  show('hud-dead', !h.alive && net.phase === 'live' && net.mode !== 'range');
  const hint = !TOUCH && !document.pointerLockElement && !anyPanelOpen() ? '화면을 클릭하면 조작이 시작됩니다' : h.frozen && !TOUCH ? 'B 키로 무기를 변경하세요' : '';
  show('hud-hint', !!hint); if (hint) $('hud-hint').textContent = hint;
  // FPS
  fpsFrames++; if (now - fpsAt >= 500) { if (s.graphics.showFps) $('hud-fps').textContent = `${Math.round((fpsFrames * 1000) / (now - fpsAt))} FPS · ${net.pingMs}ms`; fpsFrames = 0; fpsAt = now; }
}

// ───────────────────────────── 모바일 듀얼 터치 컨트롤 ─────────────────────────────
function bindTouch(): void {
  const base = $('joy-base'), knob = $('joy-knob'), jz = $('joy-zone'), az = $('aim-zone');
  let joyId = -1, jx = 0, jy = 0;
  const joyMove = (e: PointerEvent): void => {
    const R = base.clientWidth / 2; let dx = e.clientX - jx, dy = e.clientY - jy; const d = Math.hypot(dx, dy);
    if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
    knob.style.transform = `translate(${dx}px,${dy}px)`; pc.setMoveAxis(dx / R, -dy / R);
  };
  jz.addEventListener('pointerdown', (e) => { if (joyId !== -1) return; joyId = e.pointerId; jz.setPointerCapture(e.pointerId); const r = base.getBoundingClientRect(); jx = r.left + r.width / 2; jy = r.top + r.height / 2; pc.audio.resume(); joyMove(e); });
  jz.addEventListener('pointermove', (e) => { if (e.pointerId === joyId) joyMove(e); });
  const joyEnd = (e: PointerEvent): void => { if (e.pointerId !== joyId) return; joyId = -1; knob.style.transform = ''; pc.setMoveAxis(0, 0); };
  jz.addEventListener('pointerup', joyEnd); jz.addEventListener('pointercancel', joyEnd);
  // 우측 에임 드래그 (사격/줌 버튼 위에서 드래그해도 조준 가능)
  const look = new Map<number, { x: number; y: number }>();
  const aimDown = (e: PointerEvent): void => { look.set(e.pointerId, { x: e.clientX, y: e.clientY }); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); };
  const aimMove = (e: PointerEvent): void => { const p = look.get(e.pointerId); if (!p) return; pc.addLook(e.clientX - p.x, e.clientY - p.y); p.x = e.clientX; p.y = e.clientY; };
  const aimUp = (e: PointerEvent): void => { look.delete(e.pointerId); };
  for (const el of [az, $('t-fire'), $('t-ads')]) { el.addEventListener('pointerdown', aimDown); el.addEventListener('pointermove', aimMove); el.addEventListener('pointerup', aimUp); el.addEventListener('pointercancel', aimUp); }
  // 버튼: 사격 / 줌(토글) / 점프 / 슬라이딩 / Q / E / 재장전
  document.querySelectorAll<HTMLElement>('.tbtn[data-act]').forEach((b) => {
    const act = b.dataset.act as Action;
    if (act === 'alt') { // 줌은 토글. 섬광탄/클래식은 탭 = 우클릭 1회
      b.addEventListener('pointerdown', () => { const on = !pc.isHeld('alt'); pc.setAction('alt', on); b.classList.toggle('down', on); if (on && pc.getHudState().slot !== SLOT.primary) setTimeout(() => { pc.setAction('alt', false); b.classList.remove('down'); }, 120); });
      return;
    }
    b.addEventListener('pointerdown', () => { b.classList.add('down'); if (act === 'fire') manualFire = true; pc.setAction(act, true); });
    const up = (): void => { b.classList.remove('down'); if (act === 'fire') manualFire = false; pc.setAction(act, false); };
    b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
  });
  $('t-auto').addEventListener('pointerdown', () => updateSettings((s) => { s.mobile.autoFire = !s.mobile.autoFire; }));
}
bindTouch();

// ── Auto-Fire: 조준선이 적에게 닿으면 자동 사격
const rc = new THREE.Raycaster(), CENTER = new THREE.Vector2(0, 0);
let manualFire = false, autoOn = false;
function autoFireTick(): void {
  let on = false;
  if (TOUCH && getSettings().mobile.autoFire && pc.alive && net.phase === 'live' && !anyPanelOpen()) {
    rc.setFromCamera(CENTER, camera);
    const wh = net.world?.raycast(rc.ray.origin, rc.ray.direction, 200), maxT = wh ? wh.t : 200;
    for (const e of net.entities.values()) {
      if (!e.alive || (!e.info.dummy && e.info.team === net.myTeam)) continue;
      const hit = rc.intersectObject(e.group, true).find((x) => (x.object as THREE.Mesh).isMesh);
      if (hit && hit.distance < maxT) { on = true; break; }
    }
  }
  if (on !== autoOn) { autoOn = on; if (!manualFire) pc.setAction('fire', on); }
}

// ───────────────────────────── 설정창 ─────────────────────────────
type SetTab = 'sens' | 'xhair' | 'keys' | 'gfx' | 'etc';
let setTab: SetTab = 'sens', waitingBind: { action: Action; index: 0 | 1 } | null = null;
$('btn-settings').onclick = () => openSettings();

// ───────────────────────────── 고객센터 / 개발자 모드 ─────────────────────────────
interface Ticket { id: number; message: string; status: 'open' | 'done'; created_at: string; user_id?: string; nickname?: string }
interface AdminUser { id: string; nickname: string; username?: string | null; credits: number }
const SUP_ERR: Record<string, string> = { LOGIN_REQUIRED: '로그인 후 이용할 수 있습니다.', RATE_LIMIT: '잠시 후 다시 시도해 주세요.', TICKET_LIMIT: '문의 전송 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.',
  TOO_LONG: '500자 이내로 작성해 주세요.', EMPTY: '내용을 입력해 주세요.', FORBIDDEN: '권한이 없습니다.', USER_NOT_FOUND: '해당 유저를 찾을 수 없습니다.', BAD_REQUEST: '잘못된 요청입니다.', NO_DB: '서버 DB가 연결되지 않았습니다.' };
const supMsg = (c?: string): string => SUP_ERR[c ?? ''] ?? ackMsg(c);
const fmtTime = (iso: string): string => new Date(iso).toLocaleString('ko-KR', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
let devMode = false, devTab: 'inbox' | 'credits' = 'inbox', adminSel: AdminUser | null = null, adminResults: AdminUser[] = [];
net.onCredits = (c) => patchProfile({ credits: c });
function endDevMode(): void { if (devMode) { devMode = false; adminSel = null; adminResults = []; void net.call('admin:exit'); } }

async function openSupport(): Promise<void> {
  if (getProfile()?.isGuest) { toast('고객센터는 로그인 후 이용할 수 있습니다.', 'bad'); return; }
  if (!(await ensureConnected())) return;
  devMode = false; show('m-support', true); await renderSupport();
}
async function renderSupport(): Promise<void> { if (devMode) renderDev(); else await renderChat(); }
async function renderChat(): Promise<void> {
  $('sup-title').textContent = '고객센터'; show('sup-foot', true);
  const r = await net.call<{ items: Ticket[] }>('support:list');
  if (!r.ok) { $('sup-body').innerHTML = `<div class="mut">${esc(supMsg(r.error))}</div>`; return; }
  $('sup-body').innerHTML = `<div class="sup-msg sys">안녕하세요, DUELIST 고객센터입니다.<br>불편 사항이나 건의 내용을 남겨 주시면 확인 후 반영하겠습니다.</div>`
    + (r.items ?? []).map((t) => `<div class="sup-msg me"><div>${esc(t.message)}</div><small>${fmtTime(t.created_at)} · ${t.status === 'done' ? '처리 완료' : '접수됨'}</small></div>`).join('');
  $('sup-body').scrollTop = $('sup-body').scrollHeight;
}
async function sendSupport(): Promise<void> {
  const inp = $<HTMLInputElement>('sup-input'), msg = inp.value.trim(); if (!msg) return;
  inp.value = '';
  const r = await net.call<{ dev: boolean }>('support:send', { message: msg });
  if (!r.ok) { toast(supMsg(r.error), 'bad'); return; }
  if (r.dev) { devMode = true; devTab = 'inbox'; toast('개발자 모드', 'good'); await renderSupport(); return; }
  await renderChat();
}
$('btn-support').onclick = () => void openSupport();
$('sup-send').onclick = () => void sendSupport();
$('sup-input').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && !(e as KeyboardEvent).isComposing) void sendSupport(); });

function renderDev(): void {
  $('sup-title').textContent = '개발자 모드'; show('sup-foot', false);
  $('sup-body').innerHTML = `<div class="tabs"><button data-dt="inbox" class="${devTab === 'inbox' ? 'on' : ''}">전체 문의함</button><button data-dt="credits" class="${devTab === 'credits' ? 'on' : ''}">크레딧 관리</button><button class="sm ghost" id="dev-exit" style="margin-left:auto">개발자 모드 종료</button></div><div id="dev-pane" style="margin-top:12px"></div>`;
  $('sup-body').querySelectorAll<HTMLElement>('[data-dt]').forEach((b) => (b.onclick = () => { devTab = b.dataset.dt as typeof devTab; renderDev(); }));
  $('dev-exit').onclick = () => { endDevMode(); void renderSupport(); };
  if (devTab === 'inbox') void renderInbox(); else renderCredits();
}
async function renderInbox(): Promise<void> {
  const pane = $('dev-pane'); pane.innerHTML = '<div class="mut">불러오는 중…</div>';
  const r = await net.call<{ items: Ticket[] }>('admin:tickets');
  if (!r.ok) { pane.innerHTML = `<div class="mut">${esc(supMsg(r.error))}</div>`; return; }
  const items = r.items ?? [];
  pane.innerHTML = (items.length ? `<div class="mut" style="margin-bottom:8px">총 ${items.length}건 (최신순)</div>` : '<div class="mut">접수된 문의가 없습니다.</div>')
    + items.map((t) => `<div class="tk ${t.status === 'done' ? 'done' : ''}"><div class="row"><b>${esc(t.nickname)}</b><span class="mut" style="font-size:11px;margin-left:8px">${esc(t.user_id)}</span><span class="right mut" style="font-size:12px">${fmtTime(t.created_at)}${t.status === 'done' ? ' · 완료' : ''}</span></div>
      <div class="tm">${esc(t.message)}</div><div class="tb"><button class="sm" data-tid="${t.id}" data-act="${t.status === 'done' ? 'open' : 'done'}">${t.status === 'done' ? '되돌리기' : '완료 처리'}</button><button class="sm ghost" data-tid="${t.id}" data-act="delete">삭제</button></div></div>`).join('');
  pane.querySelectorAll<HTMLElement>('[data-tid]').forEach((b) => (b.onclick = async () => {
    if (b.dataset.act === 'delete' && !confirm('이 문의를 삭제할까요?')) return;
    const a = await net.call('admin:ticket', { id: +b.dataset.tid!, action: b.dataset.act });
    if (!a.ok) toast(supMsg(a.error), 'bad'); else void renderInbox();
  }));
}
function renderCredits(): void {
  const pane = $('dev-pane');
  pane.innerHTML = `<div class="row" style="gap:8px"><input id="adm-q" placeholder="닉네임 또는 계정 ID(UUID)" style="flex:1" autocomplete="off" /><button class="pri" id="adm-search">검색</button></div>
    <div id="adm-results" style="margin-top:10px"></div><div id="adm-sel" style="margin-top:10px"></div>`;
  const drawResults = (): void => {
    $('adm-results').innerHTML = adminResults.map((u) => `<div class="tk row" style="gap:8px"><b>${esc(u.nickname)}</b><span class="mut" style="font-size:11px">${esc(u.id)}</span><span class="right">◈ ${fmt(u.credits)}</span><button class="sm" data-uid="${esc(u.id)}">선택</button></div>`).join('');
    $('adm-results').querySelectorAll<HTMLElement>('[data-uid]').forEach((b) => (b.onclick = () => { adminSel = adminResults.find((u) => u.id === b.dataset.uid) ?? null; drawSel(); }));
  };
  const drawSel = (): void => {
    const u = adminSel, box = $('adm-sel');
    if (!u) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="tk"><div class="row"><b>${esc(u.nickname)}</b><span class="mut" style="font-size:11px;margin-left:8px">${esc(u.id)}</span></div>
      <div style="margin:8px 0;font-size:18px">현재 크레딧 ◈ <b>${fmt(u.credits)}</b></div>
      <div class="row" style="gap:8px"><input id="adm-amt" type="number" min="1" max="1000000000" placeholder="수량" style="flex:1" /><button class="pri" id="adm-add">+ 지급</button><button id="adm-sub">− 차감</button></div></div>`;
    const apply = async (sign: 1 | -1): Promise<void> => {
      const n = Math.floor(Number($<HTMLInputElement>('adm-amt').value));
      if (!Number.isFinite(n) || n <= 0) { toast('1 이상의 수량을 입력하세요.', 'bad'); return; }
      const r = await net.call<{ before: number; after: number }>('admin:credits', { id: u.id, delta: sign * n });
      if (!r.ok) { toast(supMsg(r.error), 'bad'); return; }
      u.credits = r.after ?? u.credits; toast(`${u.nickname}: ◈ ${fmt(r.before ?? 0)} → ${fmt(r.after ?? 0)}`, 'good'); drawResults(); drawSel();
    };
    $('adm-add').onclick = () => void apply(1); $('adm-sub').onclick = () => void apply(-1);
  };
  const search = async (): Promise<void> => {
    const r = await net.call<{ items: AdminUser[] }>('admin:search', { q: $<HTMLInputElement>('adm-q').value });
    if (!r.ok) { toast(supMsg(r.error), 'bad'); return; }
    adminResults = r.items ?? []; adminSel = null; drawSel(); drawResults();
    if (!adminResults.length) $('adm-results').innerHTML = '<div class="mut">검색 결과가 없습니다.</div>';
  };
  $('adm-search').onclick = () => void search();
  $('adm-q').addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter' && !(e as KeyboardEvent).isComposing) void search(); });
  drawResults(); drawSel();
}
function openSettings(): void { show('m-pause', false); if (document.pointerLockElement) document.exitPointerLock(); renderSettings(); show('m-settings'); }
const SET_TABS: [SetTab, string][] = [['sens', '감도 · FOV'], ['xhair', '조준선'], ['keys', '키 설정'], ['gfx', '그래픽'], ['etc', '모바일 · 사운드']];

function sliderRow(label: string, min: number, max: number, step: number, get: (s: Settings) => number, set: (s: Settings, v: number) => void, unit = ''): HTMLElement {
  const row = document.createElement('div'); row.className = 'set-row';
  const v = get(getSettings());
  row.innerHTML = `<span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${v}" /><input type="number" min="${min}" max="${max}" step="${step}" value="${v}" style="width:70px;padding:4px" />`;
  const [r, n] = [row.children[1] as HTMLInputElement, row.children[2] as HTMLInputElement];
  const apply = (val: number, from: HTMLInputElement): void => { if (!Number.isFinite(val)) return; updateSettings((s) => set(s, val)); const nv = get(getSettings()); if (from !== r) r.value = String(nv); if (from !== n) n.value = String(nv); afterSettingChange(); };
  r.oninput = () => apply(+r.value, r); n.onchange = () => apply(+n.value, n);
  if (unit) n.title = unit;
  return row;
}
function checkRow(label: string, get: (s: Settings) => boolean, set: (s: Settings, v: boolean) => void): HTMLElement {
  const row = document.createElement('div'); row.className = 'set-row';
  row.innerHTML = `<span>${label}</span><label><input type="checkbox" ${get(getSettings()) ? 'checked' : ''}/></label><span></span>`;
  (row.querySelector('input') as HTMLInputElement).onchange = (e) => { updateSettings((s) => set(s, (e.target as HTMLInputElement).checked)); afterSettingChange(); };
  return row;
}
function choiceRow<T extends string | number>(label: string, opts: [T, string][], get: (s: Settings) => T, set: (s: Settings, v: T) => void): HTMLElement {
  const row = document.createElement('div'); row.className = 'set-row'; row.style.gridTemplateColumns = '170px 1fr';
  const draw = (): void => {
    row.innerHTML = `<span>${label}</span><div class="row" style="flex-wrap:wrap">${opts.map(([v, n], i) => `<button class="sm ${get(getSettings()) === v ? 'on' : ''}" data-i="${i}">${n}</button>`).join('')}</div>`;
    row.querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => { updateSettings((s) => set(s, opts[+b.dataset.i!][0])); renderSettings(); }));
  };
  draw(); return row;
}
let xhPreviewDraw: (() => void) | null = null, sensInfo: HTMLElement | null = null;
function afterSettingChange(): void {
  xhPreviewDraw?.();
  if (sensInfo) { const s = getSettings().sens.valorant; sensInfo.innerHTML = `Yaw = Sens × ${VALORANT_YAW_DEG}° → 1카운트당 <b>${(s * VALORANT_YAW_DEG).toFixed(4)}°</b> · 800 DPI 기준 <b>${cmPer360(s, 800).toFixed(1)} cm/360°</b> (eDPI ${Math.round(s * 800)})`; }
}
function renderSettings(): void {
  $('set-tabs').innerHTML = SET_TABS.map(([k, n]) => `<button class="${k === setTab ? 'on' : ''}" data-st="${k}">${n}</button>`).join('');
  $('set-tabs').querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => { setTab = b.dataset.st as SetTab; waitingBind = null; renderSettings(); }));
  const body = $('set-body'); body.innerHTML = ''; xhPreviewDraw = null; sensInfo = null;
  const L = SETTINGS_LIMITS, add = (...els: HTMLElement[]): void => { for (const e of els) body.appendChild(e); };
  const note = (html: string): HTMLElement => { const d = document.createElement('div'); d.className = 'mut'; d.style.cssText = 'font-size:13px;margin:6px 0 10px'; d.innerHTML = html; return d; };
  const head = (t: string): HTMLElement => { const d = document.createElement('h3'); d.style.marginTop = '14px'; d.textContent = t; return d; };
  const resetBtn = (section: keyof Omit<Settings, 'version'>): HTMLElement => { const b = document.createElement('button'); b.className = 'sm ghost'; b.style.marginTop = '12px'; b.textContent = '이 탭 초기화'; b.onclick = () => { resetSettings(section); renderSettings(); }; return b; };

  if (setTab === 'sens') {
    sensInfo = note('');
    add(sliderRow('감도 (발로란트 수치)', L.sens[0], 5, 0.001, (s) => s.sens.valorant, (s, v) => { s.sens.valorant = v; }), sensInfo,
      sliderRow('줌 감도 배율', L.adsMult[0], L.adsMult[1], 0.01, (s) => s.sens.adsMult, (s, v) => { s.sens.adsMult = v; }),
      sliderRow('모바일 감도', L.mobile[0], L.mobile[1], 0.05, (s) => s.sens.mobile, (s, v) => { s.sens.mobile = v; }),
      sliderRow('모바일 줌 감도', L.mobile[0], L.mobile[1], 0.05, (s) => s.sens.mobileAds, (s, v) => { s.sens.mobileAds = v; }),
      checkRow('상하 반전', (s) => s.sens.invertY, (s, v) => { s.sens.invertY = v; }),
      sliderRow('수평 FOV (16:9 기준)', L.hFov[0], L.hFov[1], 1, (s) => s.hFov, (s, v) => { s.hFov = v; }),
      note(`발로란트 기본값은 <b>${HFOV_DEG}°</b> Horizontal FOV 입니다.`), resetBtn('sens'));
    afterSettingChange();
  } else if (setTab === 'xhair') {
    const cv = document.createElement('canvas'); cv.id = 'xh-preview'; cv.width = 480; cv.height = 120;
    xhPreviewDraw = () => { const g = cv.getContext('2d')!; g.clearRect(0, 0, cv.width, cv.height); drawCrosshair(g, getSettings().crosshair, cv.width / 2, cv.height / 2, 1); drawCrosshair(g, getSettings().crosshair, cv.width / 2 + 130, cv.height / 2, 3); };
    const presets = document.createElement('div'); presets.className = 'row'; presets.style.margin = '10px 0';
    presets.innerHTML = `<span class="mut">원클릭 프리셋</span>` + (Object.keys(CROSSHAIR_PRESETS) as CrosshairPresetId[]).map((k) => `<button class="sm" data-pre="${k}">${CROSSHAIR_PRESETS[k].label}</button>`).join('');
    presets.querySelectorAll<HTMLElement>('[data-pre]').forEach((b) => (b.onclick = () => { updateSettings((s) => { s.crosshair = applyCrosshairPreset(b.dataset.pre as CrosshairPresetId); }); renderSettings(); }));
    const colors = document.createElement('div'); colors.className = 'set-row'; colors.style.gridTemplateColumns = '170px 1fr';
    const cur = getSettings().crosshair.color.toLowerCase();
    colors.innerHTML = `<span>색상</span><div class="row" style="flex-wrap:wrap">${CROSSHAIR_COLORS.map((c) => `<button class="swatch ${c === cur ? 'on' : ''}" style="background:${c}" data-c="${c}"></button>`).join('')}<input type="color" value="${cur}" /></div>`;
    colors.querySelectorAll<HTMLElement>('[data-c]').forEach((b) => (b.onclick = () => { updateSettings((s) => { s.crosshair.color = b.dataset.c!; }); renderSettings(); }));
    (colors.querySelector('input') as HTMLInputElement).oninput = (e) => { updateSettings((s) => { s.crosshair.color = (e.target as HTMLInputElement).value; }); afterSettingChange(); };
    const lines = (title: string, pick: (s: Settings) => CrosshairLines): HTMLElement[] => [head(title),
      checkRow('표시', (s) => pick(s).enabled, (s, v) => { pick(s).enabled = v; if (v && !pick(s).opacity) pick(s).opacity = 1; }),
      sliderRow('불투명도', 0, 1, 0.05, (s) => pick(s).opacity, (s, v) => { pick(s).opacity = v; }),
      sliderRow('길이 (px)', 0, 20, 1, (s) => pick(s).length, (s, v) => { pick(s).length = v; }),
      sliderRow('두께 (px)', 0, 10, 1, (s) => pick(s).thickness, (s, v) => { pick(s).thickness = v; }),
      sliderRow('오프셋 (px)', 0, 20, 1, (s) => pick(s).offset, (s, v) => { pick(s).offset = v; })];
    add(cv, presets, colors, head('윤곽선'),
      checkRow('표시', (s) => s.crosshair.outline.enabled, (s, v) => { s.crosshair.outline.enabled = v; }),
      sliderRow('불투명도', 0, 1, 0.05, (s) => s.crosshair.outline.opacity, (s, v) => { s.crosshair.outline.opacity = v; }),
      sliderRow('두께 (px)', 0, 6, 1, (s) => s.crosshair.outline.thickness, (s, v) => { s.crosshair.outline.thickness = v; }),
      head('중앙점'),
      checkRow('표시', (s) => s.crosshair.centerDot.enabled, (s, v) => { s.crosshair.centerDot.enabled = v; }),
      sliderRow('불투명도', 0, 1, 0.05, (s) => s.crosshair.centerDot.opacity, (s, v) => { s.crosshair.centerDot.opacity = v; }),
      sliderRow('두께 (px)', 0, 6, 1, (s) => s.crosshair.centerDot.thickness, (s, v) => { s.crosshair.centerDot.thickness = v; }),
      ...lines('내부선', (s) => s.crosshair.inner), ...lines('외부선', (s) => s.crosshair.outer), resetBtn('crosshair'));
    xhPreviewDraw();
  } else if (setTab === 'keys') {
    add(note('칸을 클릭한 뒤 키·마우스 버튼·휠을 입력하세요. 모든 동작에 <b>주 키 + 보조 키</b> 2개까지 지정됩니다. (우클릭 = 해제)'));
    const hd = document.createElement('div'); hd.className = 'kb mut'; hd.innerHTML = '<span>동작</span><span>주 키</span><span>보조 키</span>'; add(hd);
    for (const a of ACTIONS) {
      const row = document.createElement('div'); row.className = 'kb'; const pair = getSettings().keybinds[a];
      row.innerHTML = `<span>${ACTION_LABELS[a]}</span>` + [0, 1].map((i) => { const w = waitingBind?.action === a && waitingBind.index === i; return `<button class="sm ${w ? 'wait' : ''}" data-i="${i}">${w ? '입력 대기…' : bindLabel(pair[i])}</button>`; }).join('');
      row.querySelectorAll<HTMLElement>('button').forEach((b) => {
        const idx = +b.dataset.i! as 0 | 1;
        b.onclick = (e) => { e.stopPropagation(); if (a === 'menu' && idx === 0) return; waitingBind = { action: a, index: idx }; renderSettings(); };
        b.oncontextmenu = (e) => { e.preventDefault(); if (a === 'menu' && idx === 0) return; updateSettings((s) => { s.keybinds = setBinding(s.keybinds, a, idx, null); }); waitingBind = null; renderSettings(); };
      });
      add(row);
    }
    add(resetBtn('keybinds'));
  } else if (setTab === 'gfx') {
    const custom = (s: Settings): void => { s.graphics.preset = 'custom'; };
    add(choiceRow('프리셋', [['low', '낮음'], ['medium', '중간'], ['high', '높음'], ['custom', '사용자 지정']], (s) => s.graphics.preset, (s, v) => { if (v === 'custom') s.graphics.preset = 'custom'; else s.graphics = applyGraphicsPreset(s.graphics, v); }),
      sliderRow('해상도 배율', L.resolutionScale[0], L.resolutionScale[1], 0.05, (s) => s.graphics.resolutionScale, (s, v) => { s.graphics.resolutionScale = v; custom(s); }),
      choiceRow('그림자', [['off', '끔'], ['low', '낮음'], ['high', '높음']], (s) => s.graphics.shadows, (s, v) => { s.graphics.shadows = v; custom(s); }),
      choiceRow('안티에일리어싱', [['off', '끔'], ['fxaa', 'FXAA'], ['msaa', 'MSAA']], (s) => s.graphics.antialias, (s, v) => { s.graphics.antialias = v; custom(s); }),
      choiceRow('파티클', [['off', '끔'], ['low', '낮음'], ['high', '높음']], (s) => s.graphics.particles, (s, v) => { s.graphics.particles = v; custom(s); }),
      choiceRow<FpsCap>('최대 프레임 제한', FPS_CAP_OPTIONS.map((f) => [f, f === 'custom' ? '사용자 지정' : String(f)] as [FpsCap, string]), (s) => s.graphics.fpsCap, (s, v) => { s.graphics.fpsCap = v; }));
    if (getSettings().graphics.fpsCap === 'custom') add(sliderRow('사용자 지정 FPS', L.customFps[0], 360, 1, (s) => s.graphics.customFps, (s, v) => { s.graphics.customFps = v; }));
    add(note(`현재 제한: <b>${effectiveFpsCap(getSettings().graphics)} FPS</b> (모니터 주사율을 넘을 수 없습니다)`), checkRow('FPS · 핑 표시', (s) => s.graphics.showFps, (s, v) => { s.graphics.showFps = v; }), resetBtn('graphics'));
  } else {
    add(head('모바일'),
      checkRow('Auto-Fire (조준 시 자동 사격)', (s) => s.mobile.autoFire, (s, v) => { s.mobile.autoFire = v; }),
      checkRow('왼손 모드', (s) => s.mobile.leftHanded, (s, v) => { s.mobile.leftHanded = v; }),
      sliderRow('조이스틱 크기', 80, 200, 5, (s) => s.mobile.joystickSize, (s, v) => { s.mobile.joystickSize = v; }),
      sliderRow('버튼 크기', 0.6, 1.6, 0.05, (s) => s.mobile.buttonScale, (s, v) => { s.mobile.buttonScale = v; }),
      sliderRow('버튼 불투명도', 0.2, 1, 0.05, (s) => s.mobile.buttonOpacity, (s, v) => { s.mobile.buttonOpacity = v; }),
      head('사운드'),
      sliderRow('마스터 볼륨', 0, 1, 0.05, (s) => s.audio.master, (s, v) => { s.audio.master = v; }),
      sliderRow('효과음', 0, 1, 0.05, (s) => s.audio.sfx, (s, v) => { s.audio.sfx = v; }),
      sliderRow('UI', 0, 1, 0.05, (s) => s.audio.ui, (s, v) => { s.audio.ui = v; }));
  }
}
// 키 바인딩 입력 캡처 (키보드 / 마우스 버튼 / 휠)
function captureBind(e: KeyboardEvent | MouseEvent | WheelEvent): void {
  if (!waitingBind || !visible('m-settings')) return;
  e.preventDefault(); e.stopPropagation();
  const code = bindFromEvent(e), w = waitingBind; if (!code) return;
  waitingBind = null;
  if (code === 'Escape' || RESERVED_CODES.includes(code)) { renderSettings(); return; } // Esc = 취소
  updateSettings((s) => { s.keybinds = setBinding(s.keybinds, w.action, w.index, code); });
  renderSettings();
}
addEventListener('keydown', captureBind, true); addEventListener('mousedown', captureBind, true);
addEventListener('wheel', captureBind, { capture: true, passive: false });

// ───────────────────────────── 메인 루프 (프레임 제한: 30/60/90/120/사용자 지정) ─────────────────────────────
const limiter = createFrameLimiter(() => effectiveFpsCap(getSettings().graphics));
let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!limiter(now)) return;
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (view === 'game' && net.room) { autoFireTick(); pc.update(dt); net.update(dt); updateHud(now); }
  if (view === 'game') renderer.render(scene, camera);
}
requestAnimationFrame(frame);
document.addEventListener('visibilitychange', () => { if (document.hidden) pc.releaseAll(); });
addEventListener('contextmenu', (e) => { if (view === 'game') e.preventDefault(); });
// 모바일: 가로 고정 시도 (지원 브라우저 한정)
addEventListener('pointerdown', () => { if (TOUCH) void (screen.orientation as unknown as { lock?: (o: string) => Promise<void> }).lock?.('landscape').catch(() => {}); }, { once: true });

// ───────────────────────────── 부트 ─────────────────────────────
(async () => {
  setView('auth');
  const p = await initAuth();   // 세션 복원 (Google 리다이렉트 복귀 포함) + 설정 클라우드 동기화 시작
  if (p) await enterLobby();
})();