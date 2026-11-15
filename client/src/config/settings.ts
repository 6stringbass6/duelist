// =====================================================================
// 개인 설정: 감도/FOV · 조준선 · 듀얼 키바인딩 · 그래픽 · 모바일
// 로컬(localStorage) 즉시 저장 + 로그인 시 profiles.settings 로 클라우드 동기화(services/supabase.ts)
// =====================================================================

// ───────────────────────────── 감도 & FOV ─────────────────────────────
/** 발로란트 변환식: 마우스 1카운트당 회전각 = Sens × 0.07° */
export const VALORANT_YAW_DEG = 0.07;
export const yawRadPerCount = (sens: number): number => sens * VALORANT_YAW_DEG * (Math.PI / 180);
/** 360° 회전에 필요한 마우스 이동거리(cm) */
export const cmPer360 = (sens: number, dpi: number): number => (360 / (sens * VALORANT_YAW_DEG) / dpi) * 2.54;
/** eDPI */
export const edpi = (sens: number, dpi: number): number => sens * dpi;

/** 발로란트 기준: 16:9 에서 수평 103° */
export const HFOV_DEG = 103;
const REF_ASPECT = 16 / 9;
/** Three.js PerspectiveCamera.fov (수직 FOV, 도). 16:9 기준 수평 FOV 를 고정 수직 FOV 로 환산(Hor+). */
export function verticalFovDeg(hFovDeg: number = HFOV_DEG, zoom = 1): number {
  const v = 2 * Math.atan(Math.tan((hFovDeg * Math.PI) / 360) / REF_ASPECT);
  return (2 * Math.atan(Math.tan(v / 2) / zoom) * 180) / Math.PI;
}
/** 줌 시 화면상 체감 감도를 유지하는 배율 (focal length 비율) × 사용자 ADS 배율 */
export function zoomSensScale(hFovDeg: number, zoom: number, adsMult: number): number {
  if (zoom <= 1) return 1;
  const v0 = (verticalFovDeg(hFovDeg, 1) * Math.PI) / 360, v1 = (verticalFovDeg(hFovDeg, zoom) * Math.PI) / 360;
  return (Math.tan(v1) / Math.tan(v0)) * adsMult;
}
/** 모바일: 드래그 1px 당 회전(rad). mobileSens 1.0 = 0.22°/px */
export const mobileRadPerPx = (mobileSens: number): number => mobileSens * 0.22 * (Math.PI / 180);

// ───────────────────────────── 조준선 ─────────────────────────────
export interface CrosshairLines { enabled: boolean; opacity: number; length: number; thickness: number; offset: number }
export interface CrosshairConfig {
  color: string;
  outline: { enabled: boolean; opacity: number; thickness: number };
  centerDot: { enabled: boolean; opacity: number; thickness: number };
  inner: CrosshairLines;
  outer: CrosshairLines;
}
export type CrosshairPresetId = '1420' | '1322' | 'dot2';
const OFF_LINES: CrosshairLines = { enabled: false, opacity: 0, length: 0, thickness: 0, offset: 0 };
/** 프리셋 이름 = 내부선 [불투명도 / 길이 / 두께 / 오프셋] */
export const CROSSHAIR_PRESETS: Record<CrosshairPresetId, { label: string; config: CrosshairConfig }> = {
  '1420': { label: '1420', config: {
    color: '#00ff00', outline: { enabled: true, opacity: 1, thickness: 1 }, centerDot: { enabled: false, opacity: 1, thickness: 2 },
    inner: { enabled: true, opacity: 1, length: 4, thickness: 2, offset: 0 }, outer: { ...OFF_LINES } } },
  '1322': { label: '1322', config: {
    color: '#00ffff', outline: { enabled: true, opacity: 1, thickness: 1 }, centerDot: { enabled: false, opacity: 1, thickness: 2 },
    inner: { enabled: true, opacity: 1, length: 3, thickness: 2, offset: 2 }, outer: { ...OFF_LINES } } },
  dot2: { label: '점 2', config: {
    color: '#ffffff', outline: { enabled: true, opacity: 1, thickness: 1 }, centerDot: { enabled: true, opacity: 1, thickness: 2 },
    inner: { ...OFF_LINES }, outer: { ...OFF_LINES } } },
};
export const CROSSHAIR_COLORS = ['#ffffff', '#00ff00', '#7fff00', '#dfff00', '#ffff00', '#00ffff', '#ff00ff', '#ff0000'] as const;
export const applyCrosshairPreset = (id: CrosshairPresetId): CrosshairConfig => structuredClone(CROSSHAIR_PRESETS[id].config);

/**
 * 픽셀 단위 조준선 렌더러 (HUD 캔버스 / 설정 미리보기 공용).
 * @param gap 동적 벌어짐(px) — 마샬 노줌 등 탄퍼짐 표시용. 기본 0.
 */
export function drawCrosshair(ctx: CanvasRenderingContext2D, c: CrosshairConfig, cx: number, cy: number, scale = 1, gap = 0): void {
  cx = Math.round(cx); cy = Math.round(cy);
  const px = (v: number): number => Math.max(0, Math.round(v * scale));
  const ol = c.outline.enabled ? px(c.outline.thickness) : 0;
  const rects: { x: number; y: number; w: number; h: number; a: number }[] = [];
  const addLines = (l: CrosshairLines): void => {
    if (!l.enabled || l.length <= 0 || l.thickness <= 0 || l.opacity <= 0) return;
    const len = px(l.length), th = px(l.thickness), off = px(l.offset) + Math.round(gap), h0 = Math.floor(th / 2);
    rects.push({ x: cx + off, y: cy - h0, w: len, h: th, a: l.opacity });          // 우
    rects.push({ x: cx - off - len, y: cy - h0, w: len, h: th, a: l.opacity });    // 좌
    rects.push({ x: cx - h0, y: cy + off, w: th, h: len, a: l.opacity });          // 하
    rects.push({ x: cx - h0, y: cy - off - len, w: th, h: len, a: l.opacity });    // 상
  };
  addLines(c.outer); addLines(c.inner);
  if (c.centerDot.enabled && c.centerDot.thickness > 0) {
    const s = px(c.centerDot.thickness), h0 = Math.floor(s / 2);
    rects.push({ x: cx - h0, y: cy - h0, w: s, h: s, a: c.centerDot.opacity });
  }
  ctx.save();
  if (ol > 0) {
    ctx.fillStyle = '#000';
    for (const r of rects) { ctx.globalAlpha = c.outline.opacity * r.a; ctx.fillRect(r.x - ol, r.y - ol, r.w + ol * 2, r.h + ol * 2); }
  }
  ctx.fillStyle = c.color;
  for (const r of rects) { ctx.globalAlpha = r.a; ctx.fillRect(r.x, r.y, r.w, r.h); }
  ctx.restore();
}

// ───────────────────────────── 듀얼 키바인딩 ─────────────────────────────
export const ACTIONS = [
  'forward', 'back', 'left', 'right', 'jump', 'crouch', 'slide', 'updraft', 'dash',
  'fire', 'alt', 'reload', 'slot1', 'slot2', 'slot3', 'slot4', 'nextWeapon', 'prevWeapon', 'scoreboard', 'loadout', 'menu',
] as const;
export type Action = (typeof ACTIONS)[number];
/** 바인드 코드: KeyboardEvent.code('KeyW') | 'Mouse0'..'Mouse4' | 'WheelUp' | 'WheelDown' */
export type BindCode = string;
export type BindPair = [BindCode | null, BindCode | null]; // [주 키, 보조 키]
export type Keybinds = Record<Action, BindPair>;

export const ACTION_LABELS: Record<Action, string> = {
  forward: '앞으로', back: '뒤로', left: '왼쪽', right: '오른쪽', jump: '점프', crouch: '앉기', slide: '슬라이딩', updraft: '상승기류', dash: '가속',
  fire: '사격', alt: '줌 / 보조 사격', reload: '재장전', slot1: '주무기', slot2: '보조무기', slot3: '근접무기', slot4: '투척류',
  nextWeapon: '다음 무기', prevWeapon: '이전 무기', scoreboard: '스코어보드', loadout: '로드아웃', menu: '메뉴',
};
export const DEFAULT_KEYBINDS: Keybinds = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  jump: ['Space', 'WheelDown'], crouch: ['ControlLeft', null], slide: ['KeyC', null], updraft: ['KeyQ', null], dash: ['KeyE', null],
  fire: ['Mouse0', null], alt: ['Mouse2', null], reload: ['KeyR', null],
  slot1: ['Digit1', null], slot2: ['Digit2', null], slot3: ['Digit3', null], slot4: ['Digit4', null],
  nextWeapon: [null, null], prevWeapon: ['WheelUp', null], scoreboard: ['Tab', null], loadout: ['KeyB', null], menu: ['Escape', null],
};
/** 재할당 불가(브라우저 Pointer Lock 해제 키) */
export const RESERVED_CODES: BindCode[] = ['Escape'];

export function bindFromEvent(e: KeyboardEvent | MouseEvent | WheelEvent): BindCode | null {
  if (typeof WheelEvent !== 'undefined' && e instanceof WheelEvent) return e.deltaY > 0 ? 'WheelDown' : e.deltaY < 0 ? 'WheelUp' : null;
  if (typeof MouseEvent !== 'undefined' && e instanceof MouseEvent) return `Mouse${e.button}`;
  return (e as KeyboardEvent).code || null;
}
const BIND_NAMES: Record<string, string> = {
  Mouse0: '좌클릭', Mouse1: '휠 클릭', Mouse2: '우클릭', Mouse3: '마우스 4', Mouse4: '마우스 5', WheelUp: '휠 위', WheelDown: '휠 아래',
  Space: 'Space', ControlLeft: 'L-Ctrl', ControlRight: 'R-Ctrl', ShiftLeft: 'L-Shift', ShiftRight: 'R-Shift', AltLeft: 'L-Alt', AltRight: 'R-Alt',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', Backquote: '`', CapsLock: 'Caps',
};
export function bindLabel(code: BindCode | null): string {
  if (!code) return '—';
  if (BIND_NAMES[code]) return BIND_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}
/** 키 할당. 같은 키가 다른 동작에 있으면 그쪽을 비워 충돌 제거. 새 객체 반환. */
export function setBinding(binds: Keybinds, action: Action, index: 0 | 1, code: BindCode | null): Keybinds {
  const next = structuredClone(binds);
  if (code && RESERVED_CODES.includes(code) && action !== 'menu') return next;
  if (code) for (const a of ACTIONS) next[a] = next[a].map((c) => (c === code ? null : c)) as BindPair;
  next[action][index] = code;
  return next;
}
/** 입력 처리용 역방향 조회표: code → action */
export function buildBindLookup(binds: Keybinds): Map<BindCode, Action> {
  const m = new Map<BindCode, Action>();
  for (const a of ACTIONS) for (const c of binds[a]) if (c) m.set(c, a);
  return m;
}

// ───────────────────────────── 그래픽 ─────────────────────────────
export type GraphicsPreset = 'low' | 'medium' | 'high' | 'custom';
export type FpsCap = 30 | 60 | 90 | 120 | 'custom';
export interface GraphicsSettings {
  preset: GraphicsPreset;
  resolutionScale: number;               // 0.5 ~ 1.5 (× devicePixelRatio)
  shadows: 'off' | 'low' | 'high';
  antialias: 'off' | 'fxaa' | 'msaa';    // msaa 변경은 렌더러 재생성 필요
  particles: 'off' | 'low' | 'high';
  fpsCap: FpsCap;
  customFps: number;                     // fpsCap === 'custom' 일 때 직접 입력값
  showFps: boolean;
}
export const FPS_CAP_OPTIONS: FpsCap[] = [30, 60, 90, 120, 'custom'];
export const GRAPHICS_PRESETS: Record<Exclude<GraphicsPreset, 'custom'>, Pick<GraphicsSettings, 'resolutionScale' | 'shadows' | 'antialias' | 'particles'>> = {
  low: { resolutionScale: 0.7, shadows: 'off', antialias: 'off', particles: 'low' },
  medium: { resolutionScale: 1.0, shadows: 'low', antialias: 'fxaa', particles: 'low' },
  high: { resolutionScale: 1.0, shadows: 'high', antialias: 'msaa', particles: 'high' },
};
export function applyGraphicsPreset(g: GraphicsSettings, preset: Exclude<GraphicsPreset, 'custom'>): GraphicsSettings {
  return { ...g, ...GRAPHICS_PRESETS[preset], preset };
}
export const effectiveFpsCap = (g: GraphicsSettings): number => (g.fpsCap === 'custom' ? clamp(Math.round(g.customFps), 10, 1000) : g.fpsCap);
export const effectivePixelRatio = (g: GraphicsSettings): number => Math.min(3, (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1) * g.resolutionScale);
/** rAF 기반 프레임 제한기. `if (limiter(now)) render()` */
export function createFrameLimiter(getFps: () => number): (now: number) => boolean {
  let last = 0;
  return (now) => {
    const interval = 1000 / getFps();
    if (now - last < interval - 0.5) return false;
    last = now - ((now - last) % interval < interval ? (now - last) % interval : 0);
    return true;
  };
}

// ───────────────────────────── 전체 설정 ─────────────────────────────
export interface Settings {
  version: number;
  sens: { valorant: number; adsMult: number; mobile: number; mobileAds: number; invertY: boolean };
  hFov: number;
  crosshair: CrosshairConfig;
  keybinds: Keybinds;
  graphics: GraphicsSettings;
  audio: { master: number; sfx: number; ui: number };
  mobile: { autoFire: boolean; joystickSize: number; buttonScale: number; buttonOpacity: number; leftHanded: boolean };
}
export const SETTINGS_VERSION = 1;
export const SETTINGS_LIMITS = { sens: [0.01, 10], adsMult: [0.1, 3], mobile: [0.1, 5], hFov: [80, 120], resolutionScale: [0.5, 1.5], customFps: [10, 1000] } as const;

export const isTouchDevice = (): boolean =>
  typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.matchMedia?.('(pointer: coarse)').matches;

export function defaultSettings(): Settings {
  const touch = isTouchDevice();
  return {
    version: SETTINGS_VERSION,
    sens: { valorant: 0.4, adsMult: 1, mobile: 1, mobileAds: 0.7, invertY: false },
    hFov: HFOV_DEG,
    crosshair: applyCrosshairPreset('1420'),
    keybinds: structuredClone(DEFAULT_KEYBINDS),
    graphics: { preset: touch ? 'low' : 'medium', ...GRAPHICS_PRESETS[touch ? 'low' : 'medium'], fpsCap: 60, customFps: 144, showFps: false },
    audio: { master: 0.8, sfx: 1, ui: 0.7 },
    mobile: { autoFire: true, joystickSize: 120, buttonScale: 1, buttonOpacity: 0.6, leftHanded: false },
  };
}

function clamp(v: number, a: number, b: number): number { return v < a ? a : v > b ? b : v; }
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** 기본값 구조를 기준으로 타입이 맞는 값만 덮어쓰는 깊은 병합 (저장 데이터 오염/구버전 대응) */
function mergeDeep<T>(base: T, src: unknown): T {
  if (!isObj(base) || !isObj(src)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const k of Object.keys(base)) {
    const b = (base as Record<string, unknown>)[k], s = src[k];
    if (s === undefined) continue;
    if (isObj(b)) out[k] = mergeDeep(b, s);
    else if (typeof b === typeof s && !(typeof s === 'number' && !Number.isFinite(s))) out[k] = s;
  }
  return out as T;
}
export function sanitizeSettings(raw: unknown): Settings {
  const d = defaultSettings(), s = mergeDeep(d, raw), L = SETTINGS_LIMITS;
  s.version = SETTINGS_VERSION;
  s.sens.valorant = clamp(s.sens.valorant, L.sens[0], L.sens[1]);
  s.sens.adsMult = clamp(s.sens.adsMult, L.adsMult[0], L.adsMult[1]);
  s.sens.mobile = clamp(s.sens.mobile, L.mobile[0], L.mobile[1]);
  s.sens.mobileAds = clamp(s.sens.mobileAds, L.mobile[0], L.mobile[1]);
  s.hFov = clamp(s.hFov, L.hFov[0], L.hFov[1]);
  if (!/^#[0-9a-fA-F]{6}$/.test(s.crosshair.color)) s.crosshair.color = d.crosshair.color;
  for (const l of [s.crosshair.inner, s.crosshair.outer]) { l.opacity = clamp(l.opacity, 0, 1); l.length = clamp(l.length, 0, 20); l.thickness = clamp(l.thickness, 0, 10); l.offset = clamp(l.offset, 0, 20); }
  s.crosshair.outline.opacity = clamp(s.crosshair.outline.opacity, 0, 1); s.crosshair.outline.thickness = clamp(s.crosshair.outline.thickness, 0, 6);
  s.crosshair.centerDot.opacity = clamp(s.crosshair.centerDot.opacity, 0, 1); s.crosshair.centerDot.thickness = clamp(s.crosshair.centerDot.thickness, 0, 6);
  // keybinds: BindPair 는 배열이라 mergeDeep 이 건너뜀 → 직접 검증
  const rk = isObj(raw) && isObj(raw.keybinds) ? raw.keybinds : {};
  for (const a of ACTIONS) {
    const p = rk[a];
    if (Array.isArray(p) && p.length === 2 && p.every((c) => c === null || typeof c === 'string')) s.keybinds[a] = [p[0], p[1]] as BindPair;
    else s.keybinds[a] = [...d.keybinds[a]] as BindPair;
  }
  if (!s.keybinds.menu.includes('Escape')) s.keybinds.menu[0] = 'Escape';
  const g = s.graphics, rg = isObj(raw) && isObj(raw.graphics) ? raw.graphics : {};
  if (!['low', 'medium', 'high', 'custom'].includes(g.preset)) g.preset = d.graphics.preset;
  if (!['off', 'low', 'high'].includes(g.shadows)) g.shadows = d.graphics.shadows;
  if (!['off', 'fxaa', 'msaa'].includes(g.antialias)) g.antialias = d.graphics.antialias;
  if (!['off', 'low', 'high'].includes(g.particles)) g.particles = d.graphics.particles;
  g.fpsCap = (FPS_CAP_OPTIONS as unknown[]).includes(rg.fpsCap) ? (rg.fpsCap as FpsCap) : d.graphics.fpsCap; // number|'custom' 혼합 타입
  g.resolutionScale = clamp(g.resolutionScale, L.resolutionScale[0], L.resolutionScale[1]);
  g.customFps = clamp(Math.round(g.customFps), L.customFps[0], L.customFps[1]);
  s.audio.master = clamp(s.audio.master, 0, 1); s.audio.sfx = clamp(s.audio.sfx, 0, 1); s.audio.ui = clamp(s.audio.ui, 0, 1);
  s.mobile.joystickSize = clamp(s.mobile.joystickSize, 80, 200); s.mobile.buttonScale = clamp(s.mobile.buttonScale, 0.6, 1.6); s.mobile.buttonOpacity = clamp(s.mobile.buttonOpacity, 0.2, 1);
  return s;
}

// ───────────────────────────── 저장소 (로컬 + 변경 구독) ─────────────────────────────
const LS_KEY = 'gs_settings_v1';
type Listener = (s: Settings) => void;
const listeners = new Set<Listener>();
let current: Settings | null = null;

export function loadLocalSettings(): Settings {
  try { const raw = localStorage.getItem(LS_KEY); return sanitizeSettings(raw ? JSON.parse(raw) : {}); } catch { return defaultSettings(); }
}
export function getSettings(): Settings { return current ?? (current = loadLocalSettings()); }
/** 설정 변경(부분 갱신 함수 전달) → 검증 → 로컬 저장 → 구독자 통지 */
export function updateSettings(mutate: (draft: Settings) => void): Settings {
  const draft = structuredClone(getSettings());
  mutate(draft);
  current = sanitizeSettings(draft);
  try { localStorage.setItem(LS_KEY, JSON.stringify(current)); } catch { /* 저장 불가(사파리 프라이빗 등) */ }
  for (const l of listeners) l(current);
  return current;
}
/** 클라우드에서 받은 설정 적용 (로그인 직후) */
export function replaceSettings(raw: unknown): Settings {
  if (!isObj(raw) || !Object.keys(raw).length) return getSettings();
  return updateSettings((d) => Object.assign(d, sanitizeSettings(raw)));
}
export function resetSettings(section?: keyof Omit<Settings, 'version'>): Settings {
  const d = defaultSettings();
  return updateSettings((s) => { if (section) (s as unknown as Record<string, unknown>)[section] = d[section]; else Object.assign(s, d); });
}
export function onSettingsChange(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); }