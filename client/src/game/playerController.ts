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
  type GunDef, type ThrowableId, type WeaponDef, type WeaponId,
} from '../config/weapons';
import { NadeWheel } from './nadeWheel';
import { DEFAULT_SKILLS, SKILLS, ULTS, ULT_COST, type SkillId, type UltId } from '../config/skills';
import { createWeaponMesh, pullPin, type GameClient } from './network';
import { CharacterRig, loadCharacterAssets } from './character';
import { agentFor, type AgentId } from '../config/agents';
import { fireWeaponFx } from './skinFx';

type Slot = 1 | 2 | 3 | 4;
const ULTS_AFTER_MS = 700; // server ULTS.yoru.afterMs
export interface SkillHud { id: SkillId; name: string; icon: string; cd: number; left: number; max: number; active: boolean }
export interface HudState {
  alive: boolean; hp: number; maxHp: number; slot: Slot; weaponId: WeaponId; weaponName: string;
  ammo: number; magSize: number; charges: number; reloading: boolean; reloadProgress: number;
  qCooldown: number; eCooldown: number;       // 0 = 준비 완료, 1 = 방금 사용
  q: SkillHud; e: SkillHud;                   // Q/E 슬롯에 장착된 스킬 상태
  ult: { id: UltId; name: string; icon: string; pts: number; ready: boolean; casting: boolean; castLeft: number };
  silenced: boolean; silenceLeft: number; ampLeft: number; healLeft: number; shieldBuffLeft: number; shieldOn: boolean; driftLeft: number;
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
};
export class AudioFX {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private reverb: ConvolverNode | null = null;
  private ensure(): AudioContext | null {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain(); this.master.connect(ctx.destination);
    const n = (this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate)), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    // 스테레오 리버브: 좌우 비상관 노이즈에 지수 감쇠를 입힌 합성 임펄스 응답 (외부 IR 파일 없음)
    const len = Math.floor(ctx.sampleRate * 2.4), ir = ctx.createBuffer(2, len, ctx.sampleRate), pre = Math.floor(ctx.sampleRate * 0.012);
    for (let ch = 0; ch < 2; ch++) { const b = ir.getChannelData(ch); for (let i = pre; i < len; i++) b[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2); }
    const hp = ctx.createBiquadFilter(), wet = ctx.createGain(); hp.type = 'highpass'; hp.frequency.value = 420; wet.gain.value = 0.55;
    this.reverb = ctx.createConvolver(); this.reverb.buffer = ir; this.reverb.connect(hp).connect(wet).connect(this.master);
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
  /** 0.1% 잭팟(카람빗): 저음 폭발 → 상승 아르페지오 → 반짝이는 고음 샤워 */
  jackpot(): void {
    this.tone('sine', 140, 38, 0.9, 0.9); this.burst(0.9, 900, 0.5, 0.6, 'lowpass');
    [523.25, 659.25, 783.99, 1046.5, 1318.5, 1568, 2093].forEach((f, i) => { this.tone('triangle', f, f, 0.5, 0.34, 0.12 + i * 0.09); this.tone('sine', f * 2, f * 2, 0.6, 0.14, 0.12 + i * 0.09); });
    for (let i = 0; i < 14; i++) this.tone('sine', 2400 + Math.random() * 2600, 3000 + Math.random() * 2000, 0.25, 0.1, 0.9 + i * 0.07);
  }
  kill(): void { this.tone('triangle', 660, 660, 0.09, 0.4); this.tone('triangle', 990, 990, 0.16, 0.4, 0.08); }
  /** 신스 보이스: 빠른 어택 + 지수 감쇠. pan(스테레오 위치)·send(리버브 센드 양) 지정 가능 */
  private voice(type: OscillatorType, f0: number, at: number, dur: number, gain: number, o: { pan?: number; send?: number; f1?: number; attack?: number; detune?: number } = {}): void {
    const c = this.ensure(); if (!c || !this.master) return;
    const osc = c.createOscillator(), g = c.createGain(), t = c.currentTime + at, a = o.attack ?? 0.004;
    osc.type = type; osc.frequency.setValueAtTime(f0, t); if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + dur);
    if (o.detune) osc.detune.value = o.detune;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let out: AudioNode = osc.connect(g);
    if (o.pan && typeof c.createStereoPanner === 'function') { const p = c.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, o.pan)); out = out.connect(p); }
    out.connect(this.master);
    if (o.send && this.reverb) { const s = c.createGain(); s.gain.value = o.send; out.connect(s).connect(this.reverb); }
    osc.start(t); osc.stop(t + dur + 0.05);
  }
  /** 크리스탈 차임 1음: 기음 + 비정수배 배음(2.0/2.76/5.4, 유리 종 음색) + 좌우로 벌린 디튠 쌍 */
  private chime(f: number, at: number, dur: number, gain: number, pan: number, send = 0.6): void {
    this.voice('sine', f, at, dur, gain, { pan, send });
    this.voice('sine', f, at, dur * 0.9, gain * 0.5, { pan: -pan, send, detune: 7 });
    this.voice('sine', f * 2, at, dur * 0.6, gain * 0.32, { pan: pan * 0.5, send });
    this.voice('sine', f * 2.76, at, dur * 0.42, gain * 0.16, { pan: -pan * 0.7, send });
    this.voice('sine', f * 5.4, at, dur * 0.22, gain * 0.07, { pan, send: send * 0.5 });
  }
  /**
   * 킬 사운드 (전부 Web Audio 합성). 3개 레이어:
   *  ① 서브 베이스 타격 — 피치가 급강하하는 사인 킥 + 어택 클릭 + 저역 노이즈 바디
   *  ② 크리스탈 차임 — C 메이저 펜타토닉(C·D·E·G·A)으로 킬마다 근음이 올라가고, 장화음 구성음이 한 층씩 쌓인다
   *  ③ 스테레오 리버브 잔향 — 차임/핑을 컨볼버로 보내 넓게 퍼뜨린다
   * 헤드샷은 날카로운 금속성 크리티컬 핑을 추가로 겹친다. 5킬(ACE)은 서브 드롭 + 패드 + 상승 글리터.
   */
  killStreak(n: number, head: boolean): void {
    if (!this.ensure()) return;
    const k = Math.max(1, Math.min(5, Math.floor(n)));
    const root = 523.25 * Math.pow(2, [0, 2, 4, 7, 9][k - 1] / 12);                       // C5 → D5 → E5 → G5 → A5
    const stack = [[0, 12], [0, 7, 12], [0, 4, 7, 12], [0, 4, 7, 12, 16], [0, 4, 7, 12, 16, 19, 24]][k - 1];
    // ① 서브 베이스 타격
    this.tone('sine', 165, 40, 0.3, 0.85 + k * 0.03); this.tone('triangle', 320, 70, 0.07, 0.4);
    this.burst(0.022, 2600, 0.28, 0.7); this.burst(0.1, 130, 0.5, 0.6, 'lowpass');
    if (k >= 3) this.voice('sine', root / 8, 0.02, 0.55, 0.5, { attack: 0.01 });           // 근음 서브 (화음을 받쳐 줌)
    // ② 차임 스트럼 (아래에서 위로)
    const step = k >= 5 ? 0.05 : 0.028, dur = 0.95 + k * 0.16, g = 0.3 / Math.sqrt(stack.length);
    stack.forEach((semi, i) => this.chime(root * Math.pow(2, semi / 12), 0.012 + i * step, dur, g, (i % 2 ? 1 : -1) * Math.min(0.8, 0.22 + i * 0.1)));
    if (k >= 5) { // ACE: 두 번째 타격 + 서브 드롭 + 브라스 패드 + 펜타토닉 글리터 + 심벌 쉬머
      this.tone('sine', 150, 34, 0.5, 0.95, 0.3); this.voice('sine', 110, 0.3, 1.3, 0.6, { f1: 30, attack: 0.006 });
      for (const m of [0.5, 0.625, 0.75, 1]) { this.note('sawtooth', root * m, 0.04, 1.6, 0.06, { cutoff: 1900, attack: 0.05 }); this.note('sawtooth', root * m, 0.04, 1.6, 0.045, { cutoff: 1900, attack: 0.05, detune: 11 }); }
      for (let i = 0; i < 9; i++) this.chime(root * 2 * Math.pow(2, ([0, 2, 4, 7, 9][i % 5] + 12 * Math.floor(i / 5)) / 12), 0.38 + i * 0.055, 0.5, 0.055, i % 2 ? 0.75 : -0.75, 0.8);
      this.noiseAt(0, 1.5, 7000, 0.14, 'highpass'); this.noiseAt(0.3, 0.9, 9000, 0.1, 'highpass');
    }
    if (head) { // 크리티컬 핑: 비정수배 금속 배음 + 초고역 클릭 + 좌우로 튀는 에코
      this.voice('sine', 3520, 0, 0.6, 0.24, { send: 0.7 }); this.voice('sine', 3520 * 1.503, 0, 0.36, 0.11, { send: 0.6, pan: 0.3 });
      this.voice('sine', 3520 * 2.41, 0, 0.2, 0.06, { pan: -0.3 }); this.voice('triangle', 7040, 0, 0.08, 0.1, { f1: 6400 });
      this.burst(0.016, 9500, 0.32, 0.8, 'highpass');
      this.voice('sine', 4186, 0.09, 0.34, 0.09, { pan: 0.6, send: 0.8 }); this.voice('sine', 4186, 0.17, 0.28, 0.05, { pan: -0.6, send: 0.8 });
    }
  }
  /** 라운드 시작 카운트다운 비프. final = MATCH START (화음 + 타격) */
  countBeep(final: boolean): void {
    if (!this.ensure()) return;
    if (!final) { this.voice('sine', 880, 0, 0.16, 0.34, { send: 0.25 }); this.voice('triangle', 1760, 0, 0.09, 0.1); this.tone('sine', 130, 60, 0.07, 0.35); return; }
    for (const [f, p] of [[880, 0], [1318.5, -0.5], [1760, 0.5]]) { this.voice('sine', f, 0, 0.8, 0.22, { pan: p, send: 0.6 }); this.voice('triangle', f * 2, 0, 0.3, 0.05, { pan: -p, send: 0.4 }); }
    this.tone('sine', 170, 42, 0.35, 0.8); this.burst(0.03, 2400, 0.25, 0.7); this.noiseAt(0, 0.6, 6500, 0.13, 'highpass');
  }
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
  /** 어택/릴리즈 엔벨로프를 가진 지속음 (팡파르·패배 스팅용). cutoff 지정 시 로우패스 통과 */
  private note(type: OscillatorType, f0: number, at: number, dur: number, gain: number, o: { f1?: number; attack?: number; cutoff?: number; detune?: number } = {}): void {
    const c = this.ensure(); if (!c || !this.master) return;
    const osc = c.createOscillator(), g = c.createGain(), t = c.currentTime + at, a = Math.min(o.attack ?? 0.02, dur * 0.5);
    osc.type = type; osc.frequency.setValueAtTime(f0, t); if (o.f1) osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.f1), t + dur);
    if (o.detune) osc.detune.value = o.detune;
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(gain, t + a);
    g.gain.setValueAtTime(gain, t + dur * 0.6); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let tail: AudioNode = osc;
    if (o.cutoff) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = o.cutoff; f.Q.value = 0.7; tail = osc.connect(f); }
    tail.connect(g).connect(this.master); osc.start(t); osc.stop(t + dur + 0.05);
  }
  private noiseAt(at: number, dur: number, freq: number, gain: number, type: BiquadFilterType): void {
    const c = this.ensure(); if (!c || !this.master || !this.noise) return;
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime + at;
    src.buffer = this.noise; src.loop = true; f.type = type; f.frequency.value = freq; f.Q.value = 0.5;
    g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master); src.start(t, Math.random() * 0.5); src.stop(t + dur + 0.02);
  }
  /** 승리 팡파르: 브라스풍 상승 아르페지오(G4-C5-E5-G5) → C 메이저 화음 지속 + 팀파니/심벌 */
  victory(): void {
    if (!this.ensure()) return;
    const brass = (f: number, at: number, dur: number, g: number): void => {
      this.note('sawtooth', f, at, dur, g, { cutoff: 2600, attack: 0.03 }); this.note('sawtooth', f, at, dur, g * 0.7, { cutoff: 2600, attack: 0.03, detune: 9 });
      this.note('triangle', f * 2, at, dur, g * 0.35, { attack: 0.03 });
    };
    brass(392, 0, 0.16, 0.2); brass(523.25, 0.16, 0.16, 0.2); brass(659.25, 0.32, 0.16, 0.22); brass(783.99, 0.48, 0.3, 0.24);
    for (const f of [523.25, 659.25, 783.99, 1046.5]) brass(f, 0.82, 1.9, 0.15); // 최종 화음
    this.note('sine', 65.41, 0.82, 2.0, 0.55, { attack: 0.01 }); this.note('sine', 130.81, 0.82, 1.8, 0.3, { attack: 0.01 });
    for (const at of [0, 0.82]) { this.note('sine', 110, at, 0.45, 0.7, { f1: 55, attack: 0.005 }); this.noiseAt(at, 0.12, 180, 0.4, 'lowpass'); } // 팀파니
    this.noiseAt(0.82, 1.6, 6000, 0.22, 'highpass'); // 심벌
    for (const [f, at] of [[2093, 1.0], [2637, 1.12], [3136, 1.24]]) this.note('sine', f, at, 0.6, 0.07, { attack: 0.005 }); // 반짝임
  }
  /** 패배 스팅: 낮고 무거운 하강 단조(D-C-Bb-A) + 서브 베이스 드롭 + 럼블 */
  defeat(): void {
    if (!this.ensure()) return;
    const low = (f: number, at: number, dur: number, g: number): void => {
      this.note('sawtooth', f, at, dur, g, { cutoff: 520, attack: 0.06 }); this.note('sawtooth', f / 2, at, dur, g, { cutoff: 380, attack: 0.06, detune: -8 });
    };
    low(146.83, 0, 0.5, 0.3); low(130.81, 0.45, 0.5, 0.3); low(116.54, 0.9, 0.5, 0.3); low(110, 1.35, 1.7, 0.34);
    this.note('sawtooth', 130.81, 1.35, 1.7, 0.14, { cutoff: 600, attack: 0.1 }); this.note('sawtooth', 164.81, 1.35, 1.7, 0.1, { cutoff: 600, attack: 0.1, f1: 155.56 }); // A 단조로 꺼지는 화음
    this.note('sine', 90, 0, 1.4, 0.8, { f1: 28, attack: 0.005 }); this.noiseAt(0, 1.2, 120, 0.7, 'lowpass');
    this.note('sine', 55, 1.35, 1.9, 0.5, { f1: 36, attack: 0.02 }); this.noiseAt(1.35, 1.5, 90, 0.4, 'lowpass');
  }
  slide(): void { this.burst(0.3, 350, 0.25, 0.8, 'lowpass'); }
  jump(): void { this.burst(0.05, 300, 0.12, 1, 'lowpass'); }
  dispose(): void { void this.ctx?.close(); this.ctx = null; this.master = null; this.reverb = null; }
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
  // 스킬 상태 (서버 'skill'/'ult'/'silence'/'shield' 이벤트로 동기화)
  private used: Partial<Record<SkillId, number>> = {};
  private ultPts = 0; private silencedUntil = 0; private ampUntil = 0; private healUntil = 0; private shieldBuffUntil = 0; private shieldOn = false;
  private driftUntil = 0; private driftLockUntil = 0; private castUntil = 0;
  /** 오멘: 전술 맵 열기 요청 (main.ts 가 UI 를 띄우고 pc.castOmen(x,z) 호출) */
  onOmenPrompt: (() => void) | null = null;
  onSkillDenied: ((msg: string) => void) | null = null;
  // 무기
  private nextFireAt = 0; private equipUntil = 0; private nextThrowAt = 0;
  private spray = 0; private heat = 0; private lastShotAt = 0; private adsSince = 0; private adsOn = false;
  private localAmmo = { secondary: 0, primary: 0, nades: { grenade: 0, flash: 0 } as Record<ThrowableId, number> };
  // G 홀드 투척 선택 → 퀵 투척: 4번 슬롯 장착 완료 즉시 자동 투척, 던진 뒤 back 슬롯으로 복귀
  private readonly wheel = new NadeWheel();
  private quickNade: { t: ThrowableId; back: Slot } | null = null; private returnAt = 0; private returnSlot: Slot = SLOT.primary;
  private recoilPitch = 0; private recoilYaw = 0; private vmKick = 0;
  private zoom = 1;
  // 뷰모델 / 오버레이
  private readonly vmRoot = new THREE.Group();
  private vm: THREE.Group | null = null; private vmKey = '';
  private bobT = 0; private swingT = 0;
  /** 트루 1인칭 전신: 본인 진영의 장착 요원 리그 (라이플 장착 시에만 표시, 머리/목 숨김 → 팔·장갑·소매는 요원 메쉬 그대로) */
  private rig: CharacterRig | null = null; private rigAgent: AgentId | null = null; private rigDisposed = false; private rigFireT = 0; private yawRate = 0; private prevYaw = NaN;
  private static readonly FP_BACK = 0.14; // 리그를 카메라 뒤로 밀어 몸통 내부 폴리곤이 시야에 끼지 않게 함(m)
  private readonly overlay: HTMLDivElement; private readonly flashEl: HTMLDivElement; private readonly hurtEl: HTMLDivElement; private readonly scopeEl: HTMLDivElement; private readonly skillFxEl: HTMLDivElement;
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
    this.skillFxEl = mk('transition:opacity .15s;');
    this.flashEl = mk('background:#fff;');
    host.appendChild(this.overlay);
    document.body.appendChild(this.wheel.el); this.wheel.onPick = (t) => { this.wheel.hide(); this.quickThrow(t); };

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
      if (!this.locked) { if (this.captureEnabled && (e as PointerEvent).pointerType !== 'touch') void this.dom.requestPointerLock?.(); return; }
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
      if (this.wheel.open) { this.wheel.move(e.movementX); return; } // 휠이 열려 있는 동안 시점 고정 · 좌우 이동 = 선택
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
  releaseAll(): void { this.wheel.hide(); this.held.clear(); this.firePressed = this.altPressed = false; this.moveAxis.x = this.moveAxis.y = 0; }
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
      case 'fire': if (down) { if (this.wheel.open) { this.held.delete('fire'); this.commitWheel(); } else this.firePressed = true; } break;
      case 'nadeWheel': if (down) this.openWheel(); else this.commitWheel(); break;
      case 'alt': if (down) this.altPressed = true; break;
      case 'jump': if (down) this.jumpBufferedAt = performance.now(); break;
      case 'slide': if (down) this.trySlide(); break;
      case 'updraft': if (down) this.trySkill('q'); break;
      case 'dash': if (down) this.trySkill('e'); break;
      case 'ult': if (down) this.tryUlt(); break;
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
        this.nextFireAt = this.equipUntil = this.nextThrowAt = 0; this.vmKey = ''; this.quickNade = null; this.returnAt = 0; this.wheel.hide();
        this.qReadyAt = this.eReadyAt = 0; this.used = {}; this.silencedUntil = this.ampUntil = this.healUntil = this.shieldBuffUntil = this.driftUntil = this.driftLockUntil = this.castUntil = 0; this.shieldOn = false;
      }),
      n.on('correct', (x, y, z, seq, yaw) => { if (seq === this.spawnSeq) { this.pos.set(x, y, z); this.vel.set(0, 0, 0); if (yaw !== undefined) { this.yaw = yaw; this.pitch = 0; } } }),
      n.on('ammo', (a) => { this.localAmmo.secondary = a.secondary; this.localAmmo.primary = a.primary; this.localAmmo.nades = { ...a.nades }; }),
      n.on('hit', (h) => { this.audio.hit(h.z === 'head'); }),
      n.on('hurt', (h) => { this.hp = h.hp; this.hurtA = Math.min(1, this.hurtA + 0.35 + h.d / 120); this.audio.hurt(); }),
      n.on('flash', (f) => { // 케이오식 섬광: 정면으로 볼수록 길고 강하게
        const now = performance.now(); this.flashDur = f.dur; this.flashUntil = now + f.dur; this.flashPeak = f.full ? 1 : 0.75;
        this.audio.flashRing(f.dur);
      }),
      n.on('skill', (s) => {
        if (s.id !== n.you) return;
        const left = s.cd - n.serverNow(), now = performance.now(), end = now + (s.until - n.serverNow());
        if (s.k === 'q') this.qReadyAt = now + left; else this.eReadyAt = now + left;
        this.used[s.s] = SKILLS[s.s].uses - s.u;
        if (s.s === 'haste') this.dashUntil = end; else if (s.s === 'amp') this.ampUntil = end; else if (s.s === 'heal') this.healUntil = end; else if (s.s === 'shield') this.shieldBuffUntil = end;
      }),
      n.on('ultPts', (p) => { this.ultPts = p; }),
      n.on('silence', (until) => { this.silencedUntil = performance.now() + (until - n.serverNow()); this.castUntil = 0; this.onSkillDenied?.('침묵 — 스킬이 봉인되었습니다'); }),
      n.on('shield', (sh) => { this.shieldOn = sh.on; if (!sh.on && sh.broke) this.audio.hit(true); }),
      n.on('ult', (u) => {
        if (u.id !== n.you) return;
        const now = performance.now(), end = now + ((u.until ?? 0) - n.serverNow());
        if (u.s === 'omen') this.castUntil = u.ph === 'cast' ? end : 0;
        else if (u.s === 'yoru') { if (u.ph === 'start') this.driftUntil = end; else if (u.ph === 'end') { this.driftUntil = 0; this.driftLockUntil = now + ULTS_AFTER_MS; } }
      }),
      n.on('duel', () => { this.driftUntil = 0; this.castUntil = 0; this.slideUntil = 0; }),
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
  private magAmmo(): number { return this.slot === SLOT.secondary ? this.localAmmo.secondary : this.slot === SLOT.primary ? this.localAmmo.primary : this.slot === SLOT.throwable ? this.nadesOf(this.weaponId) : 0; }
  private nadesOf(id: WeaponId): number { return this.localAmmo.nades[id as ThrowableId] ?? 0; }

  switchSlot(s: Slot): void {
    if (!this.alive || s === this.slot) return;
    if (s !== SLOT.throwable) this.quickNade = null;
    this.returnAt = 0; this.slot = s; this.net.switchWeapon(s);
    const now = performance.now();
    this.equipUntil = now + this.weapon.equipMs; this.nextFireAt = Math.max(this.nextFireAt, this.equipUntil);
    this.spray = this.heat = 0; this.adsOn = false; this.firePressed = this.altPressed = false; this.audio.equip();
  }
  // ── G 투척 선택 (홀드 → 좌/우 선택 → 놓기/클릭 = 장착 후 즉시 투척)
  private openWheel(): void {
    const n = this.localAmmo.nades;
    if (!this.alive || n.flash + n.grenade <= 0) return;
    this.firePressed = false;
    this.wheel.show(n, (this.net.me?.loadout.throwable ?? 'grenade') as ThrowableId);
  }
  private commitWheel(): void { const t = this.wheel.hide(); if (t) this.quickThrow(t); }
  private quickThrow(t: ThrowableId): void {
    if (!this.alive || this.nadesOf(t) <= 0) return;
    const back: Slot = this.slot === SLOT.throwable ? this.quickNade?.back ?? SLOT.primary : this.slot;
    const changed = this.weaponId !== t;
    this.net.pickNade(t);
    if (this.slot !== SLOT.throwable) this.switchSlot(SLOT.throwable);
    else if (changed) { const now = performance.now(); this.equipUntil = now + this.weapon.equipMs; this.audio.equip(); } // 4번 슬롯에서 종류만 교체 → 재장착 시간
    this.quickNade = { t, back };
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
  private skillIdOf(k: 'q' | 'e'): SkillId { const l = this.net.me?.loadout, id = k === 'q' ? l?.q : l?.e; return id && id in SKILLS ? id : k === 'q' ? 'updraft' : 'haste'; }
  private ultIdOf(): UltId { const x = this.net.me?.loadout?.x; return x && x in ULTS ? x : DEFAULT_SKILLS.x; }
  private usesLeft(id: SkillId): number { return SKILLS[id].uses - (this.used[id] ?? 0); }
  private get skillLocked(): boolean { const now = performance.now(); return now < this.driftUntil || now < this.castUntil; }
  private trySkill(k: 'q' | 'e'): void { // Q/E: 장착 스킬 사용 (쿨타임·라운드당 횟수, 서버 검증)
    const now = performance.now();
    if (!this.canAct || this.skillLocked) return;
    const id = this.skillIdOf(k), def = SKILLS[id], ready = k === 'q' ? this.qReadyAt : this.eReadyAt;
    if (now < this.silencedUntil) { this.onSkillDenied?.('침묵 상태 — 스킬 사용 불가'); return; }
    if (now < ready) return;
    if (this.usesLeft(id) <= 0) { this.onSkillDenied?.(`${def.name} — 이번 라운드 사용 횟수 소진`); return; }
    const readyAt = now + def.cdMs; if (k === 'q') this.qReadyAt = readyAt; else this.eReadyAt = readyAt;
    this.used[id] = (this.used[id] ?? 0) + 1;
    if (id === 'updraft') { this.vel.y = MOVE.updraftV; this.grounded = false; this.slideUntil = 0; }
    else if (id === 'haste') this.dashUntil = now + (def.durMs ?? 5000);
    this.audio.skill(k);
    void this.net.skill(k, { yaw: this.yaw, pitch: this.pitch }).then((ack) => { // 서버 거절 시 쿨타임/횟수 롤백
      if (ack.ok) return;
      this.used[id] = Math.max(0, (this.used[id] ?? 1) - 1); if (k === 'q') this.qReadyAt = 0; else this.eReadyAt = 0;
      if (id === 'haste') this.dashUntil = 0;
      if (id === 'barrier') this.onSkillDenied?.('장벽을 설치할 수 없는 위치입니다');
    });
  }
  private tryUlt(): void { // X: 궁극기 (6포인트 충전 시)
    const now = performance.now();
    if (!this.canAct || this.skillLocked) return;
    if (now < this.silencedUntil) { this.onSkillDenied?.('침묵 상태 — 궁극기 사용 불가'); return; }
    if (this.ultPts < ULT_COST) { this.onSkillDenied?.(`궁극기 포인트 부족 (${this.ultPts}/${ULT_COST})`); return; }
    const id = this.ultIdOf();
    if (id === 'omen') { this.onOmenPrompt?.(); return; }
    this.audio.skill('q');
    void this.net.skill('x', { yaw: this.yaw, pitch: this.pitch }).then((ack) => { if (!ack.ok) this.onSkillDenied?.(id === 'iso' ? '파동에 적중한 적이 없습니다' : '궁극기를 사용할 수 없습니다'); });
  }
  /** 오멘: 전술 맵에서 고른 좌표로 시전 요청 */
  castOmen(x: number, z: number): void {
    this.audio.skill('e');
    void this.net.skill('x', { yaw: this.yaw, pitch: this.pitch, t: [Math.round(x * 10) / 10, Math.round(z * 10) / 10] }).then((ack) => { if (!ack.ok) this.onSkillDenied?.('해당 위치로는 이동할 수 없습니다'); });
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
    const dashing = now < this.dashUntil || now < this.driftUntil;
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
    if (!this.canAct || now < this.equipUntil || now < this.driftUntil || now < this.driftLockUntil || now < this.castUntil) return; // 표류 중/후딜/시전 중 공격 불가
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
    } else if (isThrow(w)) { // 섬광탄: 좌클릭 원거리 / 우클릭 언더핸드 · G 퀵 투척은 장착 완료 즉시 원거리 투척
      const id = this.weaponId as ThrowableId, alt = altEdge && id === 'flash', quick = this.quickNade?.t === id;
      if ((fireEdge || alt || quick) && now >= this.nextThrowAt && this.nadesOf(id) > 0) {
        this.nextThrowAt = now + THROW.cooldownMs; this.localAmmo.nades[id]--; this.swingT = 1; this.audio.throwItem();
        if (this.vm) pullPin(this.vm); // 핀을 뽑고 던짐
        this.net.fire(this.eyePos(), this.yaw, this.pitch, alt, id);
        if (quick) { this.returnSlot = this.quickNade!.back; this.returnAt = now + 420; this.quickNade = null; }
        else if (this.nadesOf(id) <= 0) { this.returnSlot = SLOT.primary; this.returnAt = now + 420; }
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
    this.audio.shot(this.weaponId); fireWeaponFx(this.vm); this.rigFireT = 0.3; // 울트라 스킨: 발광 폭증 + 전용 총구 섬광
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
    if (this.returnAt && now >= this.returnAt) { this.returnAt = 0; if (this.alive && this.slot === SLOT.throwable) this.switchSlot(this.returnSlot); } // 투척 후 이전 무기로 복귀
    this.updateViewmodel(dt, now); this.updateOverlay(dt, now);
  }
  private releaseFire(): void { this.firePressed = this.altPressed = false; this.adsOn = false; }

  private updateViewmodel(dt: number, now: number): void {
    const skin = this.net.me?.skins?.[this.weaponId] ?? '', key = this.weaponId + '|' + skin;
    if (key !== this.vmKey) {
      this.vmKey = key; this.vm?.removeFromParent();
      this.vm = createWeaponMesh(this.weaponId, skin, true);
      this.vm.traverse((o) => { o.castShadow = false; o.frustumCulled = false; (o as THREE.Mesh).renderOrder = Math.max(10, (o as THREE.Mesh).renderOrder); });
      this.vmRoot.add(this.vm);
    }
    const scoped = this.isScoped(now), fpRifle = this.updateRig(dt, now, scoped);
    this.vmRoot.visible = this.alive && !scoped && !fpRifle;
    const sp = Math.hypot(this.vel.x, this.vel.z); if (this.grounded) this.bobT += dt * sp * 1.6;
    const equip = Math.max(0, (this.equipUntil - now) / Math.max(1, this.weapon.equipMs)), ads = (this.zoom - 1) / Math.max(0.01, (isGun(this.weapon) ? this.weapon.adsZoom : 1.01) - 1 || 1);
    const a = Math.min(1, Math.max(0, this.adsOn ? ads : 0)), melee = isMelee(this.weapon) || isThrow(this.weapon);
    const bx = Math.sin(this.bobT) * 0.006 * (1 - a), by = Math.abs(Math.cos(this.bobT)) * 0.006 * (1 - a);
    this.vmRoot.position.set(0.2 * (1 - a) + bx, -0.19 + 0.06 * a - by - equip * 0.25 - (this.reloading ? 0.08 : 0), -0.36 + this.vmKick * 0.035 - (melee ? this.swingT * 0.25 : 0));
    this.vmRoot.rotation.set(this.vmKick * 0.07 - equip * 0.8 - (this.reloading ? 0.35 : 0) - (melee ? this.swingT * 0.9 : 0), melee ? this.swingT * 0.6 : 0, now < this.slideUntil ? 0.15 : 0);
  }
  /** 진영(CT/T) 또는 장착 요원이 바뀌면 1인칭 전신 리그를 해당 요원 모델로 교체 */
  private syncRigAgent(): void {
    const me = this.net.me; if (!me) return;
    const id = agentFor(me.team, me.loadout); if (id === this.rigAgent) return;
    this.rigAgent = id;
    void loadCharacterAssets(id).then((a) => {
      if (!a || this.rigDisposed || this.rigAgent !== id) return;
      if (this.vm && this.rig && this.vm.parent === this.rig.socket) this.vmRoot.add(this.vm);
      this.rig?.dispose();
      this.rig = new CharacterRig(a, 0x3b9cff, 0); this.rig.setFirstPerson(true); this.rig.root.visible = false; this.net.scene.add(this.rig.root);
    });
  }
  /** 트루 1인칭: 라이플(AK-47/팬텀)이면 요원 전신 리그를 갱신하고 무기를 오른손 소켓으로 옮긴다. 반환값 = 리그가 총을 들고 보이는 중 */
  private updateRig(dt: number, now: number, scoped: boolean): boolean {
    this.syncRigAgent();
    const rig = this.rig; if (!rig) return false;
    const rifle = this.weaponId === 'vandal' || this.weaponId === 'phantom', show = this.alive && rifle && !scoped;
    rig.root.visible = show;
    const want = rifle ? rig.socket : this.vmRoot;
    if (this.vm && this.vm.parent !== want) { want.add(this.vm); if (!rifle) this.vm.position.set(0, 0, 0), this.vm.rotation.set(0, 0, 0); }
    if (!show) { this.prevYaw = NaN; return false; }
    const yaw = this.yaw, sin = Math.sin(yaw), cos = Math.cos(yaw), k = Math.min(1, dt * 10);
    if (Number.isNaN(this.prevYaw) || dt <= 0) this.prevYaw = yaw;
    this.yawRate += (Math.atan2(Math.sin(yaw - this.prevYaw), Math.cos(yaw - this.prevYaw)) / Math.max(dt, 1e-3) - this.yawRate) * k; this.prevYaw = yaw;
    this.rigFireT = Math.max(0, this.rigFireT - dt);
    const B = PlayerController.FP_BACK + Math.max(0, -this.pitch) * 0.3; // 아래를 볼수록 몸을 더 뒤로 빼 상체가 렌즈를 덮지 않게
    rig.root.position.set(this.pos.x + sin * B, this.pos.y, this.pos.z + cos * B); rig.root.rotation.y = yaw; // 전방 = (-sin, -cos)
    const vx = this.vel.x, vz = this.vel.z;
    rig.update(dt, {
      rifle: true, firing: this.rigFireT > 0, reloading: this.reloading, crouch: this.eyeH < MOVE.eye - 0.2 || now < this.slideUntil, air: !this.grounded,
      fwd: -vx * sin - vz * cos, side: vx * cos - vz * sin, turning: Math.abs(this.yawRate) > 1.5, pitch: this.pitch,
    });
    return true;
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
    // 스킬 상태 테두리: 데미지 증폭=붉은 오라 / 치유=녹색 / 침묵=보라 / 표류=어두운 청색 / 시전=흰색
    const fx = !this.alive ? '' : now < this.driftUntil ? '0 0 140px 30px rgba(20,30,80,.85)' : now < this.castUntil ? '0 0 120px 30px rgba(255,255,255,.55)'
      : now < this.silencedUntil ? '0 0 120px 24px rgba(176,107,255,.6)' : now < this.ampUntil ? '0 0 120px 26px rgba(255,40,40,.55)' : now < this.healUntil ? '0 0 110px 20px rgba(60,255,140,.4)' : '';
    this.skillFxEl.style.boxShadow = fx ? `inset ${fx}` : 'none'; this.skillFxEl.style.opacity = fx ? '1' : '0';
  }

  private skillHud(k: 'q' | 'e', now: number): SkillHud {
    const id = this.skillIdOf(k), def = SKILLS[id], ready = k === 'q' ? this.qReadyAt : this.eReadyAt;
    const active = (id === 'haste' && now < this.dashUntil) || (id === 'amp' && now < this.ampUntil) || (id === 'heal' && now < this.healUntil) || (id === 'shield' && now < this.shieldBuffUntil);
    return { id, name: def.name, icon: def.icon, cd: Math.max(0, (ready - now) / def.cdMs), left: this.usesLeft(id), max: def.uses, active };
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
      ammo: this.magAmmo(), magSize: isGun(w) ? w.mag : isThrow(w) ? w.charges : 0, charges: this.localAmmo.nades.flash + this.localAmmo.nades.grenade, reloading: this.reloading, reloadProgress,
      qCooldown: Math.max(0, (this.qReadyAt - now) / SKILLS[this.skillIdOf('q')].cdMs), eCooldown: Math.max(0, (this.eReadyAt - now) / SKILLS[this.skillIdOf('e')].cdMs),
      q: this.skillHud('q', now), e: this.skillHud('e', now),
      ult: { id: this.ultIdOf(), name: ULTS[this.ultIdOf()].name, icon: ULTS[this.ultIdOf()].icon, pts: this.ultPts, ready: this.ultPts >= ULT_COST, casting: now < this.castUntil, castLeft: Math.max(0, this.castUntil - now) },
      silenced: now < this.silencedUntil, silenceLeft: Math.max(0, this.silencedUntil - now), ampLeft: Math.max(0, this.ampUntil - now), healLeft: Math.max(0, this.healUntil - now),
      shieldBuffLeft: Math.max(0, this.shieldBuffUntil - now), shieldOn: this.shieldOn, driftLeft: Math.max(0, this.driftUntil - now),
      dashActive: now < this.dashUntil, sliding: now < this.slideUntil, scoped, ads: this.adsOn, spreadPx, flash: this.flashAmount(now),
      speed: Math.hypot(this.vel.x, this.vel.z), frozen: this.frozen,
    };
  }

  dispose(): void {
    for (const off of this.offs) off(); this.offs.length = 0;
    if (this.locked) document.exitPointerLock();
    this.rigDisposed = true; this.rig?.dispose(); this.rig = null;
    this.vmRoot.removeFromParent(); this.overlay.remove(); this.wheel.el.remove(); this.audio.dispose();
  }
}