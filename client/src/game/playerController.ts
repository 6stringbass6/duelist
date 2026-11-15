// =====================================================================
// 로컬 플레이어: 1인칭 카메라(103° HFOV) · 발로란트 감도 · 듀얼 키바인딩 · 무빙/슬라이딩/Q/E
// 4슬롯 무기 · 사격 예측/반동 · 섬광 실명 · Web Audio 신디사이저
// 모바일 UI 는 setMoveAxis / addLook / setAction 으로 같은 경로에 입력을 주입한다.
// =====================================================================
import * as THREE from 'three';
import {
  bindFromEvent, buildBindLookup, getSettings, mobileRadPerPx, onSettingsChange, verticalFovDeg, yawRadPerCount, zoomSensScale,
  type Action, type BindCode,
} from '../config/settings';
import {
  F, MOVE, RULES, SLOT, SLOT_KEYS, THROW, WEAPONS, fireIntervalMs, isGun, isMelee, isThrow, spreadDeg,
  type GunDef, type WeaponDef, type WeaponId,
} from '../config/weapons';
import { createWeaponMesh, type GameClient } from './network';

type Slot = 1 | 2 | 3 | 4;
export interface HudState {
  alive: boolean; hp: number; maxHp: number; slot: Slot; weaponId: WeaponId; weaponName: string;
  ammo: number; magSize: number; charges: number; reloading: boolean; reloadProgress: number;
  qCooldown: number; eCooldown: number;       // 0 = 준비 완료, 1 = 방금 사용
  dashActive: boolean; sliding: boolean; scoped: boolean; ads: boolean;
  spreadPx: number;                           // 조준선 동적 벌어짐(px) — drawCrosshair 의 gap
  flash: number;                              // 실명 강도 0..1
  speed: number; frozen: boolean;
}

// ───────────────────────────── Web Audio 신디사이저 ─────────────────────────────
const SHOT_PROFILE: Record<string, { dur: number; freq: number; thump: number; gain: number }> = {
  classic: { dur: 0.11, freq: 2200, thump: 150, gain: 0.5 }, shorty: { dur: 0.22, freq: 900, thump: 90, gain: 0.9 },
  frenzy: { dur: 0.08, freq: 2600, thump: 170, gain: 0.45 }, ghost: { dur: 0.07, freq: 3400, thump: 0, gain: 0.25 },
  sheriff: { dur: 0.2, freq: 1300, thump: 110, gain: 0.85 }, vandal: { dur: 0.13, freq: 1500, thump: 120, gain: 0.7 },
  phantom: { dur: 0.08, freq: 3000, thump: 0, gain: 0.35 }, marshal: { dur: 0.32, freq: 1000, thump: 75, gain: 1.0 },
  odin: { dur: 0.11, freq: 1100, thump: 100, gain: 0.75 },
};
export class AudioFX {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.connect(ctx.destination);
    const n = (this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.applyVolume();
    return ctx;
  }
  /** 사용자 제스처(클릭/터치)에서 호출 */
  resume(): void { const c = this.ensure(); if (c && c.state === 'suspended') void c.resume(); }
  applyVolume(): void { const a = getSettings().audio; if (this.master) this.master.gain.value = a.master * a.sfx; }
  private burst(dur: number, freq: number, gain: number, q = 0.8, type: BiquadFilterType = 'bandpass'): void {
    const c = this.ensure(); if (!c || !this.master || !this.noise) return;
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime;
    src.buffer = this.noise; src.loop = true; f.type = type; f.frequency.value = freq; f.Q.value = q;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }
  private tone(type: OscillatorType, f0: number, f1: number, dur: number, gain: number, delay = 0): void {
    const c = this.ensure(); if (!c || !this.master) return;
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + delay;
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g).connect(this.master); o.start(t); o.stop(t + dur + 0.02);
  }
  shot(id: WeaponId, vol = 1): void {
    const p = SHOT_PROFILE[id]; if (!p || vol <= 0.01) return;
    this.burst(p.dur, p.freq, p.gain * vol, 0.7); this.burst(p.dur * 0.4, p.freq * 2.5, p.gain * 0.5 * vol, 0.5, 'highpass');
    if (p.thump) this.tone('sine', p.thump * 1.6, p.thump * 0.4, p.dur * 1.2, p.gain * 0.9 * vol);
  }
  swing(heavy: boolean, vol = 1): void { this.burst(heavy ? 0.25 : 0.12, heavy ? 500 : 1400, 0.35 * vol, 2); }
  hit(head: boolean): void { if (head) { this.tone('triangle', 1900, 2400, 0.09, 0.5); this.tone('sine', 3200, 2800, 0.12, 0.25, 0.02); } else this.tone('square', 900, 600, 0.05, 0.22); }
  kill(): void { this.tone('triangle', 660, 660, 0.09, 0.4); this.tone('triangle', 990, 990, 0.16, 0.4, 0.08); }
  hurt(): void { this.tone('sine', 140, 60, 0.18, 0.7); this.burst(0.08, 400, 0.3, 1); }
  empty(): void { this.tone('square', 1500, 1200, 0.03, 0.15); }
  reload(): void { this.burst(0.04, 3000, 0.3, 3); this.tone('square', 700, 500, 0.04, 0.12, 0.18); this.burst(0.05, 2200, 0.35, 3); }
  equip(): void { this.burst(0.05, 1800, 0.18, 2); }
  throwItem(): void { this.burst(0.14, 700, 0.2, 1.5); }
  explosion(vol = 1): void { this.burst(0.7, 220, 1.2 * vol, 0.4, 'lowpass'); this.tone('sine', 110, 28, 0.6, 1.0 * vol); }
  flashPop(vol = 1): void { this.burst(0.08, 5000, 0.6 * vol, 0.5, 'highpass'); this.tone('sine', 2400, 2400, 0.1, 0.3 * vol); }
  /** 실명 이명 */
  flashRing(durMs: number): void { this.tone('sine', 3100, 2900, Math.max(0.3, durMs / 1000), 0.22); }
  skill(k: 'q' | 'e'): void { if (k === 'q') { this.burst(0.35, 600, 0.4, 0.6); this.tone('sine', 220, 880, 0.3, 0.3); } else { this.burst(0.25, 1600, 0.3, 1); this.tone('sawtooth', 300, 700, 0.2, 0.15); } }
  slide(): void { this.burst(0.3, 350, 0.25, 0.8, 'lowpass'); }
  jump(): void { this.burst(0.05, 300, 0.12, 1, 'lowpass'); }
  dispose(): void { void this.ctx?.close(); this.ctx = null; }
}

// ───────────────────────────── PlayerController ─────────────────────────────
const UP_LIMIT = 1.55;
export class PlayerController {
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();
  yaw = 0; pitch = 0;
  hp: number = RULES.hp;
  alive = false;
  slot: Slot = SLOT.primary;
  readonly audio = new AudioFX();
  /** scoreboard / loadout / menu 등 UI 동작 콜백 */
  onUiAction: ((action: Action, down: boolean) => void) | null = null;
  /** 포인터 락 요청 허용 여부(메뉴가 열려 있으면 false) */
  captureEnabled = true;

  private grounded = false;
  private spawnSeq = 0;
  private eyeH: number = MOVE.eye;
  private readonly held = new Set<Action>();
  private lookup = new Map<BindCode, Action>();
  private readonly moveAxis = { x: 0, y: 0 };     // 모바일 조이스틱 (x=우, y=전)
  private firePressed = false; private altPressed = false; private jumpBufferedAt = -1e9;
  private lastGroundAt = 0;
  // 슬라이딩 / 스킬
  private slideUntil = 0; private slideReadyAt = 0;
  private dashUntil = 0; private qReadyAt = 0; private eReadyAt = 0;   // performance.now 기준
  // 무기
  private nextFireAt = 0; private equipUntil = 0; private nextThrowAt = 0;
  private spray = 0; private heat = 0; private lastShotAt = 0; private adsSince = 0; private adsOn = false;
  private localAmmo = { secondary: 0, primary: 0, charges: 0 };
  private recoilPitch = 0; private recoilYaw = 0; private vmKick = 0;
  private zoom = 1;
  // 뷰모델 / 오버레이
  private readonly vmRoot = new THREE.Group();
  private vm: THREE.Group | null = null; private vmKey = '';
  private bobT = 0; private swingT = 0;
  private readonly overlay: HTMLDivElement; private readonly flashEl: HTMLDivElement; private readonly hurtEl: HTMLDivElement; private readonly scopeEl: HTMLDivElement;
  private flashUntil = 0; private flashDur = 1; private flashPeak = 1; private hurtA = 0;
  private lastInputAt = 0;
  private readonly offs: (() => void)[] = [];
  private readonly eye = new THREE.Vector3();

  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly dom: HTMLElement, private readonly net: GameClient) {
    camera.rotation.order = 'YXZ'; camera.near = 0.05; camera.far = 600;
    camera.fov = verticalFovDeg(getSettings().hFov); camera.updateProjectionMatrix();
    if (!camera.parent) net.scene.add(camera);
    camera.add(this.vmRoot);

    // 오버레이(실명 / 피격 / 스코프)
    const host = dom.parentElement ?? document.body;
    const mk = (css: string): HTMLDivElement => { const d = document.createElement('div'); d.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;' + css; this.overlay.appendChild(d); return d; };
    this.overlay = document.createElement('div'); this.overlay.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:5;';
    this.scopeEl = mk('background:radial-gradient(circle at center, transparent 0, transparent 33vh, #000 33.4vh);');
    this.scopeEl.innerHTML = '<div style="position:absolute;left:50%;top:0;bottom:0;width:1px;background:#000"></div><div style="position:absolute;top:50%;left:0;right:0;height:1px;background:#000"></div>';
    this.hurtEl = mk('background:radial-gradient(ellipse at center, transparent 45%, rgba(255,30,50,0.75) 100%);');
    this.flashEl = mk('background:#fff;');
    host.appendChild(this.overlay);

    this.rebuildBinds();
    this.offs.push(onSettingsChange(() => { this.rebuildBinds(); this.audio.applyVolume(); }));
    this.bindDom(); this.bindNet();
  }

  // ── 설정 / 입력
  private rebuildBinds(): void { this.lookup = buildBindLookup(getSettings().keybinds); }
  private get locked(): boolean { return document.pointerLockElement === this.dom; }
  private bindDom(): void {
    const add = <K extends keyof DocumentEventMap>(t: EventTarget, type: K | string, fn: (e: never) => void, opt?: AddEventListenerOptions): void => {
      t.addEventListener(type, fn as EventListener, opt); this.offs.push(() => t.removeEventListener(type, fn as EventListener, opt));
    };
    const editing = (e: Event): boolean => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable); };
    add(window, 'keydown', (e: KeyboardEvent) => {
      if (editing(e) || e.repeat) { if (e.code === 'Tab' && !editing(e)) e.preventDefault(); return; }
      const a = this.lookup.get(e.code); if (!a) return;
      if (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || (this.locked && e.code !== 'Escape')) e.preventDefault();
      this.setAction(a, true);
    });
    add(window, 'keyup', (e: KeyboardEvent) => { const a = this.lookup.get(e.code); if (a) this.setAction(a, false); });
    add(this.dom, 'mousedown', (e: MouseEvent) => {
      this.audio.resume();
      if (!this.locked) { if (this.captureEnabled && e.pointerType !== 'touch') void this.dom.requestPointerLock?.(); return; }
      e.preventDefault(); const a = this.lookup.get(bindFromEvent(e) ?? ''); if (a) this.setAction(a, true);
    });
    add(window, 'mouseup', (e: MouseEvent) => { const a = this.lookup.get(bindFromEvent(e) ?? ''); if (a) this.setAction(a, false); });
    add(this.dom, 'contextmenu', (e: Event) => e.preventDefault());
    add(this.dom, 'wheel', (e: WheelEvent) => {
      if (!this.locked) return; e.preventDefault();
      const a = this.lookup.get(bindFromEvent(e) ?? ''); if (a) { this.setAction(a, true); this.setAction(a, false); }
    }, { passive: false });
    add(document, 'mousemove', (e: MouseEvent) => {
      if (!this.locked) return;
      const s = getSettings(), k = yawRadPerCount(s.sens.valorant) * zoomSensScale(s.hFov, this.zoom, s.sens.adsMult);
      this.applyLook(e.movementX * k, e.movementY * k * (s.sens.invertY ? -1 : 1));
    });
    add(document, 'pointerlockchange', () => { if (!this.locked) this.releaseAll(); });
    add(window, 'blur', () => this.releaseAll());
  }
  private applyLook(dYaw: number, dPitch: number): void {
    this.yaw -= dYaw; this.pitch = Math.max(-UP_LIMIT, Math.min(UP_LIMIT, this.pitch - dPitch));
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2; else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
  }
  releaseAll(): void { this.held.clear(); this.firePressed = this.altPressed = false; this.moveAxis.x = this.moveAxis.y = 0; }
  requestCapture(): void { this.audio.resume(); if (this.captureEnabled) void this.dom.requestPointerLock?.(); }

  // ── 모바일/외부 입력 주입 API
  /** 조이스틱: x=우(+)/좌(-), y=전(+)/후(-), 크기 0..1 */
  setMoveAxis(x: number, y: number): void { this.moveAxis.x = x; this.moveAxis.y = y; }
  /** 터치 에임 드래그(px) */
  addLook(dxPx: number, dyPx: number): void {
    const s = getSettings(), k = mobileRadPerPx(s.sens.mobile) * (this.zoom > 1 ? s.sens.mobileAds / Math.sqrt(this.zoom) : 1);
    this.applyLook(dxPx * k, dyPx * k * (s.sens.invertY ? -1 : 1));
  }
  /** 키/버튼 상태 변경 (PC 키바인딩과 모바일 버튼 공용 진입점) */
  setAction(a: Action, down: boolean): void {
    if (down) { if (this.held.has(a)) return; this.held.add(a); } else { this.held.delete(a); }
    switch (a) {
      case 'fire': if (down) this.firePressed = true; break;
      case 'alt': if (down) this.altPressed = true; break;
      case 'jump': if (down) this.jumpBufferedAt = performance.now(); break;
      case 'slide': if (down) this.trySlide(); break;
      case 'updraft': if (down) this.trySkill('q'); break;
      case 'dash': if (down) this.trySkill('e'); break;
      case 'reload': if (down) this.tryReload(); break;
      case 'slot1': if (down) this.switchSlot(1); break;
      case 'slot2': if (down) this.switchSlot(2); break;
      case 'slot3': if (down) this.switchSlot(3); break;
      case 'slot4': if (down) this.switchSlot(4); break;
      case 'nextWeapon': if (down) this.switchSlot(((this.slot % 4) + 1) as Slot); break;
      case 'prevWeapon': if (down) this.switchSlot((((this.slot + 2) % 4) + 1) as Slot); break;
      case 'scoreboard': case 'loadout': case 'menu': this.onUiAction?.(a, down); break;
      default: break;
    }
  }
  isHeld(a: Action): boolean { return this.held.has(a); }

  // ── 네트워크 이벤트
  private bindNet(): void {
    const n = this.net;
    this.offs.push(
      n.on('spawn', (x, y, z, yaw, seq) => {
        this.pos.set(x, y, z); this.vel.set(0, 0, 0); this.yaw = yaw; this.pitch = 0; this.spawnSeq = seq;
        this.alive = true; this.hp = RULES.hp; this.slot = SLOT.primary; this.grounded = true;
        this.slideUntil = 0; this.dashUntil = 0; this.spray = this.heat = 0; this.recoilPitch = this.recoilYaw = 0; this.flashUntil = 0;
        this.nextFireAt = this.equipUntil = this.nextThrowAt = 0; this.vmKey = '';
        if (n.phase === 'buy') { this.qReadyAt = this.eReadyAt = 0; }
      }),
      n.on('correct', (x, y, z, seq) => { if (seq === this.spawnSeq) { this.pos.set(x, y, z); this.vel.set(0, 0, 0); } }),
      n.on('ammo', (a) => { this.localAmmo.secondary = a.secondary; this.localAmmo.primary = a.primary; this.localAmmo.charges = a.charges; }),
      n.on('hit', (h) => { this.audio.hit(h.z === 'head'); if (h.k) this.audio.kill(); }),
      n.on('hurt', (h) => { this.hp = h.hp; this.hurtA = Math.min(1, this.hurtA + 0.35 + h.d / 120); this.audio.hurt(); }),
      n.on('flash', (f) => { // 케이오식 섬광: 정면으로 볼수록 길고 강하게
        const now = performance.now(); this.flashDur = f.dur; this.flashUntil = now + f.dur; this.flashPeak = f.full ? 1 : 0.75;
        this.audio.flashRing(f.dur);
      }),
      n.on('skill', (s) => {
        if (s.id !== n.you) return;
        const left = s.cd - n.serverNow(), now = performance.now();
        if (s.k === 'q') this.qReadyAt = now + left; else { this.eReadyAt = now + left; this.dashUntil = now + (s.until - n.serverNow()); }
      }),
      n.on('shot', (s) => { if (s.id !== n.you) this.audio.shot(s.w, this.distVol(s.o[0], s.o[1], s.o[2], 90)); }),
      n.on('melee', (m) => { if (m.id !== n.you) { const e = n.entities.get(m.id); if (e) this.audio.swing(m.w === 'sword', this.distVol(e.x, e.y, e.z, 20)); } }),
      n.on('explode', (e) => { const v = this.distVol(e.p[0], e.p[1], e.p[2], e.type === 'flash' ? 50 : 80); if (e.type === 'flash') this.audio.flashPop(v); else this.audio.explosion(v); }),
      n.on('phase', (p) => { if (p.phase !== 'live') { this.firePressed = this.altPressed = false; } }),
      n.on('loadout', (id) => { if (id === n.you) this.vmKey = ''; }),
    );
  }
  private distVol(x: number, y: number, z: number, range: number): number {
    const d = Math.hypot(x - this.pos.x, y - this.pos.y - this.eyeH, z - this.pos.z);
    return Math.max(0, 1 - d / range) ** 2;
  }

  // ── 무기 헬퍼
  private get weaponId(): WeaponId { const l = this.net.me?.loadout; return (l ? l[SLOT_KEYS[this.slot]] : 'vandal') as WeaponId; }
  private get weapon(): WeaponDef { return WEAPONS[this.weaponId]; }
  private get reloading(): boolean { const a = this.net.ammo; return a.reloadUntil > 0 && a.reloadUntil > this.net.serverNow(); }
  private get frozen(): boolean { return this.net.phase === 'buy' && this.net.mode !== 'range'; }
  private get canAct(): boolean { return this.alive && this.net.phase === 'live'; }
  private magAmmo(): number { return this.slot === SLOT.secondary ? this.localAmmo.secondary : this.slot === SLOT.primary ? this.localAmmo.primary : this.slot === SLOT.throwable ? this.localAmmo.charges : 0; }

  switchSlot(s: Slot): void {
    if (!this.alive || s === this.slot) return;
    this.slot = s; this.net.switchWeapon(s);
    const now = performance.now();
    this.equipUntil = now + this.weapon.equipMs; this.nextFireAt = Math.max(this.nextFireAt, this.equipUntil);
    this.spray = this.heat = 0; this.adsOn = false; this.firePressed = this.altPressed = false; this.audio.equip();
  }
  private tryReload(): void {
    const w = this.weapon;
    if (!this.alive || !isGun(w) || this.reloading || this.magAmmo() >= w.mag) return;
    this.net.reload(); this.audio.reload();
  }
  private trySlide(): void { // C: 횟수 제한 없는 슬라이딩
    const now = performance.now();
    if (!this.alive || this.frozen || !this.grounded || now < this.slideReadyAt) return;
    const d = this.wishDir(); if (!d.lengthSq()) d.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const sp = Math.max(Math.hypot(this.vel.x, this.vel.z), MOVE.slideV * (now < this.dashUntil ? MOVE.dashMult : 1));
    this.vel.x = d.x * sp; this.vel.z = d.z * sp;
    this.slideUntil = now + MOVE.slideMs; this.slideReadyAt = this.slideUntil + MOVE.slideCooldownMs; this.audio.slide();
  }
  private trySkill(k: 'q' | 'e'): void { // Q 상승기류 / E 가속 (쿨타임 7초, 서버 검증)
    const now = performance.now();
    if (!this.canAct) return;
    if (k === 'q') { if (now < this.qReadyAt) return; this.qReadyAt = now + MOVE.skillCdMs; this.vel.y = MOVE.updraftV; this.grounded = false; this.slideUntil = 0; }
    else { if (now < this.eReadyAt) return; this.eReadyAt = now + MOVE.skillCdMs; this.dashUntil = now + MOVE.dashMs; }
    this.net.skill(k); this.audio.skill(k);
  }
  private readonly wish = new THREE.Vector3();
  private wishDir(): THREE.Vector3 {
    let f = this.moveAxis.y, r = this.moveAxis.x;
    if (this.held.has('forward')) f += 1; if (this.held.has('back')) f -= 1;
    if (this.held.has('right')) r += 1; if (this.held.has('left')) r -= 1;
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw), w = this.wish.set(-sy * f + cy * r, 0, -cy * f - sy * r), l = w.length();
    return l > 1 ? w.multiplyScalar(1 / l) : w; // 조이스틱 아날로그 크기 유지
  }

  // ── 물리 (브레이킹 불필요: 이동 중에도 정확도 불이익 없음)
  private physics(dt: number, now: number): void {
    const world = this.net.world; if (!world) return;
    const sliding = now < this.slideUntil, w = this.weapon;
    let low = sliding || this.held.has('crouch');
    if (!low && this.eyeH < MOVE.eye - 0.05 && world.blocked(this.pos, MOVE.height)) low = true; // 머리 위가 막혀 있으면 계속 숙임
    const dashing = now < this.dashUntil;
    const maxSp = MOVE.run * w.move * (low && !sliding ? MOVE.crouchMult : 1) * (this.adsOn ? MOVE.adsMult : 1) * (dashing ? MOVE.dashMult : 1);
    const wish = this.wishDir(), wl = wish.length(), v = this.vel;
    if (sliding) {
      const k = Math.exp(-MOVE.slideFriction * dt); v.x *= k; v.z *= k;
      if (wl > 0) { v.x += wish.x * 6 * dt; v.z += wish.z * 6 * dt; } // 슬라이딩 중 약한 조향
    } else if (this.grounded) {
      const sp = Math.hypot(v.x, v.z);
      if (sp > 1e-4) { const drop = Math.max(sp, 3) * MOVE.friction * dt, k = Math.max(0, sp - drop) / sp; v.x *= k; v.z *= k; }
      if (wl > 0) { const cur = (v.x * wish.x + v.z * wish.z) / wl, add = maxSp * wl - cur; if (add > 0) { const acc = Math.min(MOVE.accelGround * dt, add); v.x += (wish.x / wl) * acc; v.z += (wish.z / wl) * acc; } }
    } else if (wl > 0) { // 공중 스트레이프
      const cur = (v.x * wish.x + v.z * wish.z) / wl, add = maxSp * wl - cur;
      if (add > 0) { const acc = Math.min(MOVE.accelAir * dt, add); v.x += (wish.x / wl) * acc; v.z += (wish.z / wl) * acc; }
    }
    if (this.grounded) this.lastGroundAt = now;
    if (now - this.jumpBufferedAt < 130 && now - this.lastGroundAt < 110 && v.y <= 0.01) { // 점프 버퍼 + 코요테 타임 (슬라이드 점프는 속도 유지)
      v.y = MOVE.jumpV; this.grounded = false; this.jumpBufferedAt = -1e9; this.lastGroundAt = -1e9; this.slideUntil = 0; this.audio.jump();
    }
    v.y -= MOVE.gravity * dt;
    this.grounded = world.moveBody(this.pos, v, dt, low ? MOVE.heightCrouch : MOVE.height, this.grounded);
    this.eyeH += ((low ? MOVE.eyeCrouch : MOVE.eye) - this.eyeH) * Math.min(1, dt * 16);
  }

  // ── 사격 / 근접 / 투척
  private combat(now: number): void {
    const w = this.weapon, fireHeld = this.held.has('fire'), altHeld = this.held.has('alt');
    const fireEdge = this.firePressed, altEdge = this.altPressed; this.firePressed = this.altPressed = false;
    // 줌/견착
    const wantAds = isGun(w) && w.adsZoom > 1 && altHeld && !this.reloading && this.alive && now >= this.equipUntil;
    if (wantAds && !this.adsOn) this.adsSince = now; this.adsOn = wantAds;
    if (!this.canAct || now < this.equipUntil) return;
    if (isGun(w)) {
      const altFire = !!w.alt && (altEdge || (altHeld && now >= this.nextFireAt)), want = (w.auto ? fireHeld : fireEdge) || altFire;
      if (!want || now < this.nextFireAt || this.reloading) return;
      if (this.magAmmo() <= 0) { if (fireEdge || altEdge) { this.audio.empty(); this.tryReload(); } else if (w.auto) this.tryReload(); return; }
      this.shoot(w, altFire && !(w.auto ? fireHeld : fireEdge), now);
    } else if (isMelee(w)) {
      if ((fireHeld || altEdge) && now >= this.nextFireAt) {
        this.nextFireAt = now + w.intervalMs; this.swingT = 1; this.audio.swing(this.weaponId === 'sword');
        this.net.fire(this.eyePos(), this.yaw, this.pitch, false);
      }
    } else if (isThrow(w)) { // 섬광탄: 좌클릭 원거리 / 우클릭 언더핸드
      const alt = altEdge && this.weaponId === 'flash';
      if ((fireEdge || alt) && now >= this.nextThrowAt && this.localAmmo.charges > 0) {
        this.nextThrowAt = now + THROW.cooldownMs; this.localAmmo.charges--; this.swingT = 1; this.audio.throwItem();
        this.net.fire(this.eyePos(), this.yaw, this.pitch, alt);
      }
    }
  }
  private shoot(w: GunDef, alt: boolean, now: number): void {
    if (now - this.lastShotAt > 300) this.heat = 0;
    if (now - this.lastShotAt > w.spread.recoverMs) this.spray = 0;
    this.nextFireAt = now + fireIntervalMs(w, alt, this.heat);
    const shots = alt && w.alt ? Math.min(w.alt.burst, this.magAmmo()) : 1;
    if (this.slot === SLOT.secondary) this.localAmmo.secondary -= shots; else this.localAmmo.primary -= shots;
    // 반동이 반영된 실제 조준 방향으로 발사 (탄퍼짐·판정은 서버)
    this.net.fire(this.eyePos(), this.yaw + this.recoilYaw, Math.max(-UP_LIMIT, Math.min(UP_LIMIT, this.pitch + this.recoilPitch)), alt);
    this.spray += shots; this.heat++; this.lastShotAt = now;
    const r = w.recoil, deg = Math.PI / 180, scopedMul = this.adsOn ? 0.75 : 1;
    this.recoilPitch = Math.min(r.maxPitch * deg, this.recoilPitch + r.pitch * deg * shots * scopedMul);
    this.recoilYaw += (Math.random() - 0.5) * 2 * r.yaw * deg * scopedMul;
    this.vmKick = Math.min(1.5, this.vmKick + 0.6 + r.pitch * 0.15);
    this.audio.shot(this.weaponId);
  }
  private eyePos(): THREE.Vector3 { return this.eye.set(this.pos.x, this.pos.y + this.eyeH, this.pos.z); }
  private isScoped(now: number): boolean { const w = this.weapon; return isGun(w) && !!w.zoom && this.adsOn && now - this.adsSince >= (w.scopeMs ?? 0); }

  // ── 프레임 갱신
  update(dt: number): void {
    const now = performance.now(), n = this.net, s = getSettings();
    dt = Math.min(dt, 0.05);
    // 서버 권위 상태 동기화
    if (this.alive && !n.self.alive && n.phase !== 'buy') { this.alive = false; this.releaseFire(); }
    if (this.alive) this.hp = Math.min(this.hp, n.self.hp || this.hp);
    if (this.alive && !this.frozen && n.room && n.phase !== 'lobby') this.physics(dt, now);
    else if (this.frozen) this.vel.set(0, 0, 0);
    this.combat(now);

    // 반동 회복
    const w = this.weapon, rec = isGun(w) ? w.recoil.recover : 8, k = Math.exp(-rec * dt);
    this.recoilPitch *= k; this.recoilYaw *= k; this.vmKick *= Math.exp(-12 * dt); this.swingT = Math.max(0, this.swingT - dt * 4);

    // 카메라: 103° HFOV(16:9 기준) + 줌
    const targetZoom = this.alive && this.adsOn && isGun(w) ? w.adsZoom : 1;
    this.zoom += (targetZoom - this.zoom) * Math.min(1, dt * 18); if (Math.abs(this.zoom - targetZoom) < 0.005) this.zoom = targetZoom;
    const fov = verticalFovDeg(s.hFov, this.zoom) * (now < this.dashUntil ? 1.04 : 1);
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    const sliding = now < this.slideUntil;
    this.camera.position.set(this.pos.x, this.pos.y + this.eyeH, this.pos.z);
    this.camera.rotation.set(this.pitch + this.recoilPitch, this.yaw + this.recoilYaw, sliding ? -0.05 : 0);

    // 입력 전송 (30Hz)
    if (this.alive && n.room && now - this.lastInputAt >= 1000 / RULES.inputHz) {
      this.lastInputAt = now;
      let f = 0;
      if (this.held.has('crouch') || this.eyeH < MOVE.eye - 0.2) f |= F.CROUCH;
      if (sliding) f |= F.SLIDE; if (this.adsOn) f |= F.ADS; if (!this.grounded) f |= F.AIR;
      n.sendInput(this.spawnSeq, this.pos, this.yaw, this.pitch, f);
    }
    this.updateViewmodel(dt, now); this.updateOverlay(dt, now);
  }
  private releaseFire(): void { this.firePressed = this.altPressed = false; this.adsOn = false; }

  private updateViewmodel(dt: number, now: number): void {
    const skin = this.net.me?.skins?.[this.weaponId] ?? '', key = this.weaponId + '|' + skin;
    if (key !== this.vmKey) {
      this.vmKey = key; this.vm?.removeFromParent();
      this.vm = createWeaponMesh(this.weaponId, skin);
      this.vm.traverse((o) => { o.castShadow = false; o.frustumCulled = false; (o as THREE.Mesh).renderOrder = 10; });
      this.vmRoot.add(this.vm);
    }
    const scoped = this.isScoped(now);
    this.vmRoot.visible = this.alive && !scoped;
    const sp = Math.hypot(this.vel.x, this.vel.z); if (this.grounded) this.bobT += dt * sp * 1.6;
    const equip = Math.max(0, (this.equipUntil - now) / Math.max(1, this.weapon.equipMs)), ads = (this.zoom - 1) / Math.max(0.01, (isGun(this.weapon) ? this.weapon.adsZoom : 1.01) - 1 || 1);
    const a = Math.min(1, Math.max(0, this.adsOn ? ads : 0)), melee = isMelee(this.weapon) || isThrow(this.weapon);
    const bx = Math.sin(this.bobT) * 0.006 * (1 - a), by = Math.abs(Math.cos(this.bobT)) * 0.006 * (1 - a);
    this.vmRoot.position.set(0.2 * (1 - a) + bx, -0.19 + 0.06 * a - by - equip * 0.25 - (this.reloading ? 0.08 : 0), -0.36 + this.vmKick * 0.035 - (melee ? this.swingT * 0.25 : 0));
    this.vmRoot.rotation.set(this.vmKick * 0.07 - equip * 0.8 - (this.reloading ? 0.35 : 0) - (melee ? this.swingT * 0.9 : 0), melee ? this.swingT * 0.6 : 0, now < this.slideUntil ? 0.15 : 0);
  }
  private flashAmount(now: number): number {
    if (now >= this.flashUntil) return 0;
    const left = (this.flashUntil - now) / this.flashDur;                  // 1 → 0
    return this.flashPeak * (left > 0.4 ? 1 : left / 0.4);                 // 60% 완전 실명 후 페이드
  }
  private updateOverlay(dt: number, now: number): void {
    this.flashEl.style.opacity = this.flashAmount(now).toFixed(3);
    this.hurtA = Math.max(0, this.hurtA - dt * 1.6);
    const low = this.alive && this.hp < 45 ? 0.25 + 0.1 * Math.sin(now / 180) : 0;
    this.hurtEl.style.opacity = Math.max(this.hurtA, low).toFixed(3);
    this.scopeEl.style.opacity = this.alive && this.isScoped(now) ? '1' : '0';
  }

  /** HUD(조준선/탄약/쿨타임) 렌더용 상태 */
  getHudState(): HudState {
    const now = performance.now(), w = this.weapon, a = this.net.ammo, scoped = this.isScoped(now);
    let reloadProgress = 0;
    if (this.reloading && isGun(w)) reloadProgress = 1 - Math.max(0, a.reloadUntil - this.net.serverNow()) / w.reloadMs;
    let spreadPx = 0;
    if (isGun(w)) { // 마샬 노줌 → 탄퍼짐 극대화가 조준선에 그대로 보이도록
      const sprayNow = now - this.lastShotAt > w.spread.recoverMs ? 0 : this.spray;
      const deg = spreadDeg(w, { spray: sprayNow, ads: this.adsOn, scoped });
      const halfH = (verticalFovDeg(getSettings().hFov, this.zoom) * Math.PI) / 360;
      spreadPx = (Math.tan((deg * Math.PI) / 180) / Math.tan(halfH)) * (this.dom.clientHeight / 2);
    }
    return {
      alive: this.alive, hp: this.alive ? Math.max(0, this.hp) : 0, maxHp: RULES.hp, slot: this.slot, weaponId: this.weaponId, weaponName: w.name,
      ammo: this.magAmmo(), magSize: isGun(w) ? w.mag : isThrow(w) ? w.charges : 0, charges: this.localAmmo.charges, reloading: this.reloading, reloadProgress,
      qCooldown: Math.max(0, (this.qReadyAt - now) / MOVE.skillCdMs), eCooldown: Math.max(0, (this.eReadyAt - now) / MOVE.skillCdMs),
      dashActive: now < this.dashUntil, sliding: now < this.slideUntil, scoped, ads: this.adsOn, spreadPx, flash: this.flashAmount(now),
      speed: Math.hypot(this.vel.x, this.vel.z), frozen: this.frozen,
    };
  }

  dispose(): void {
    for (const off of this.offs) off(); this.offs.length = 0;
    if (this.locked) document.exitPointerLock();
    this.vmRoot.removeFromParent(); this.overlay.remove(); this.audio.dispose();
  }
}