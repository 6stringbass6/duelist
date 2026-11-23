// 모바일 터치 조작 HUD — 프리셋(좌표·크기·투명도·표시 여부)에서 버튼을 생성하고 PlayerController 입력 주입 API 에 연결한다.
// PC 에서도 마우스(Pointer Events)로 동일하게 동작한다. 편집기(openHudEditor)는 같은 버튼 DOM 을 편집 모드로 재사용한다.
import {
  HUD_BTN_IDS, HUD_LIMITS, HUD_PRESET_COUNT, HUD_PRESET_NAMES, defaultHudPreset, getSettings, updateSettings,
  type Action, type HudBtnCfg, type HudBtnId, type HudPreset,
} from '../config/settings';
import type { PlayerController } from './playerController';

interface BtnMeta { label: string; name: string; w: number; h: number; act?: Action; aim?: boolean }
/** 기본 크기(px) — 실제 크기는 프리셋 scale 배율 */
const META: Record<HudBtnId, BtnMeta> = {
  joy: { label: '', name: '이동 조이스틱', w: 120, h: 120 },
  fire: { label: '발사', name: '주 발사', w: 64, h: 64, act: 'fire', aim: true },
  fireR: { label: '발사', name: '보조 발사 1', w: 64, h: 64, act: 'fire', aim: true },
  fireR2: { label: '발사', name: '보조 발사 2', w: 56, h: 56, act: 'fire', aim: true },
  ads: { label: '조준', name: '조준 (ADS)', w: 52, h: 52, act: 'alt', aim: true },
  slide: { label: '슬라', name: '슬라이딩', w: 52, h: 52, act: 'slide' },
  jump: { label: '점프', name: '점프', w: 52, h: 52, act: 'jump' },
  crouch: { label: '앉기', name: '앉기', w: 52, h: 52, act: 'crouch' },
  reload: { label: '장전', name: '재장전', w: 48, h: 48, act: 'reload' },
  interact: { label: '사용', name: '상호작용', w: 52, h: 52 },
  slot1: { label: '1', name: '무기 슬롯 1 (주무기)', w: 62, h: 42 },
  slot2: { label: '2', name: '무기 슬롯 2 (보조)', w: 62, h: 42 },
  slot3: { label: '3', name: '무기 슬롯 3 (근접)', w: 62, h: 42 },
  slot4: { label: '4', name: '무기 슬롯 4 (투척)', w: 62, h: 42 },
  inspect: { label: '검사', name: '자세히 보기 (F)', w: 46, h: 46, act: 'inspect' },
  pause: { label: 'ESC', name: '일시정지 / 설정', w: 40, h: 40 },
  skillQ: { label: 'Q', name: '스킬 Q', w: 44, h: 44, act: 'updraft' },
  skillE: { label: 'E', name: '스킬 E', w: 44, h: 44, act: 'dash' },
  skillX: { label: 'X', name: '궁극기 X', w: 44, h: 44, act: 'ult' },
  auto: { label: '', name: 'Auto-Fire 토글', w: 78, h: 34 },
};
const SLOT_TAG = ['', '주무기', '보조', '근접', '투척'];
const slotNo = (id: HudBtnId): number => (id.startsWith('slot') ? +id.slice(4) : 0);

type HudState = ReturnType<PlayerController['getHudState']>;
export interface TouchHost {
  pc: PlayerController;
  primarySlot: number;
  togglePause(): void;
  toggleLoadout(): void;
}

/** 이미 끝난 포인터에 대한 캡처 시도는 무시 */
function capture(el: Element, id: number): void { try { el.setPointerCapture(id); } catch { /* 포인터 종료됨 */ } }

function makeBtn(id: HudBtnId): HTMLElement {
  const m = META[id], el = document.createElement('div');
  el.className = `tbtn t-${id}${id === 'joy' ? ' joy' : ''}${id.startsWith('slot') ? ' slot' : ''}${id === 'fire' || id === 'fireR' || id === 'fireR2' ? ' big' : ''}`;
  el.id = id === 'joy' ? 'joy-base' : `t-${id}`;
  el.dataset.hid = id; el.style.setProperty('--w', `${m.w}px`); el.style.setProperty('--h', `${m.h}px`);
  if (id === 'joy') el.innerHTML = '<div id="joy-knob"></div>';
  else if (id === 'auto') el.textContent = 'Auto-Fire';
  else if (id.startsWith('slot')) el.innerHTML = `<b>${m.label}</b><small>${SLOT_TAG[slotNo(id)]}</small>`;
  else el.textContent = m.label;
  return el;
}
function place(el: HTMLElement, c: HudBtnCfg, mirror = false): void {
  el.style.setProperty('--x', `${mirror ? 100 - c.x : c.x}%`); el.style.setProperty('--y', `${c.y}%`);
  el.style.setProperty('--s', String(c.scale)); el.style.setProperty('--o', String(c.opacity));
}

// ───────────────────────────── 플레이 모드 ─────────────────────────────
export class TouchHud {
  private readonly btns = new Map<HudBtnId, HTMLElement>();
  private readonly firing = new Set<HudBtnId>();
  private readonly slotKey = new Map<HudBtnId, string>();
  private joyId = -1;
  private readonly joyZone = document.createElement('div');
  private readonly aimZone = document.createElement('div');

  constructor(private readonly root: HTMLElement, private readonly host: TouchHost) {
    root.textContent = '';
    this.aimZone.id = 'aim-zone'; this.joyZone.id = 'joy-zone'; root.append(this.aimZone, this.joyZone);
    root.addEventListener('contextmenu', (e) => e.preventDefault());
    for (const id of HUD_BTN_IDS) { const el = makeBtn(id); this.btns.set(id, el); root.appendChild(el); }
    this.bindAim(); this.bindJoystick(); this.bindButtons();
    this.layout();
  }
  /** 수동 발사 버튼이 눌려 있는지 (Auto-Fire 와 충돌 방지용) */
  get manualFire(): boolean { return this.firing.size > 0; }

  /** 활성 프리셋을 DOM 에 반영 (설정이 바뀔 때마다 호출 — 버튼은 재생성하지 않아 누르고 있는 터치를 유지한다) */
  layout(): void {
    const m = getSettings().mobile, p = m.hudPresets[m.hudActive] ?? defaultHudPreset();
    for (const id of HUD_BTN_IDS) {
      const el = this.btns.get(id)!; place(el, p[id], m.leftHanded && id !== 'pause');
      el.classList.toggle('off', !p[id].enabled);
    }
    const auto = this.btns.get('auto')!; auto.textContent = `Auto-Fire ${m.autoFire ? 'ON' : 'OFF'}`; auto.classList.toggle('on', m.autoFire);
    // 조이스틱 터치 영역: 조이스틱이 놓인 쪽 절반 (반대쪽은 시점 회전)
    const jx = m.leftHanded ? 100 - p.joy.x : p.joy.x, left = jx < 50;
    this.joyZone.style.cssText = `left:${left ? 0 : 50}%;width:50%;display:${p.joy.enabled ? 'block' : 'none'}`;
  }

  /** 슬롯 버튼: 장착 중인 무기 이름·탄약 표시 + 활성 강조 */
  update(h: HudState): void {
    for (const id of HUD_BTN_IDS) {
      const n = slotNo(id); if (!n) continue;
      const el = this.btns.get(id)!, on = h.slot === n;
      const sub = on ? `${h.weaponName} ${n === 3 ? '∞' : h.reloading ? '장전중' : `${h.ammo}/${h.magSize}`}` : SLOT_TAG[n];
      const key = `${on}|${sub}`; if (this.slotKey.get(id) === key) continue;
      this.slotKey.set(id, key); el.classList.toggle('on', on);
      el.innerHTML = `<b>${n}</b><small>${sub}</small>`;
    }
  }
  /** 눌림 상태 해제 (화면 전환·모드 변경 시) */
  reset(): void {
    this.joyId = -1; this.firing.clear(); this.joyEnd();
    this.btns.forEach((b) => b.classList.remove('down'));
  }

  private readonly look = new Map<number, { x: number; y: number }>();
  private bindAim(): void {
    const down = (e: PointerEvent): void => { this.look.set(e.pointerId, { x: e.clientX, y: e.clientY }); capture(e.currentTarget as HTMLElement, e.pointerId); };
    const move = (e: PointerEvent): void => { const p = this.look.get(e.pointerId); if (!p) return; this.host.pc.addLook(e.clientX - p.x, e.clientY - p.y); p.x = e.clientX; p.y = e.clientY; };
    const up = (e: PointerEvent): void => { this.look.delete(e.pointerId); };
    const els = [this.aimZone, ...HUD_BTN_IDS.filter((id) => META[id].aim).map((id) => this.btns.get(id)!)];
    for (const el of els) { el.addEventListener('pointerdown', down); el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); }
  }

  private bindJoystick(): void {
    const base = this.btns.get('joy')!, z = this.joyZone;
    let cx = 0, cy = 0;
    const mv = (e: PointerEvent): void => {
      const R = base.getBoundingClientRect().width / 2; let dx = e.clientX - cx, dy = e.clientY - cy; const d = Math.hypot(dx, dy);
      if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
      const k = base.offsetWidth / (R * 2); // 버튼 scale 이 자식 translate 에도 적용되므로 보정
      (base.firstElementChild as HTMLElement).style.transform = `translate(${dx * k}px,${dy * k}px)`;
      this.host.pc.setMoveAxis(dx / R, -dy / R);
      base.classList.toggle('sprint', Math.min(1, d / R) >= 0.92); // 외곽 끝까지 밀면 질주 상태 표시
    };
    z.addEventListener('pointerdown', (e) => {
      if (this.joyId !== -1) return;
      this.joyId = e.pointerId; capture(z, e.pointerId); this.host.pc.audio.resume();
      // 플로팅: 터치한 곳을 조이스틱 중심으로 (손을 떼면 프리셋 위치로 복귀)
      const r = base.getBoundingClientRect(); cx = e.clientX; cy = e.clientY;
      const half = r.width / 2, zr = z.getBoundingClientRect();
      cx = Math.min(zr.right - half, Math.max(zr.left + half, cx)); cy = Math.min(innerHeight - half, Math.max(half, cy));
      base.style.setProperty('--x', `${cx}px`); base.style.setProperty('--y', `${cy}px`); base.classList.add('held');
      mv(e);
    });
    z.addEventListener('pointermove', (e) => { if (e.pointerId === this.joyId) mv(e); });
    const end = (e: PointerEvent): void => { if (e.pointerId === this.joyId) { this.joyId = -1; this.joyEnd(); } };
    z.addEventListener('pointerup', end); z.addEventListener('pointercancel', end);
  }
  private joyEnd(): void {
    const base = this.btns.get('joy')!; (base.firstElementChild as HTMLElement).style.transform = '';
    base.classList.remove('held', 'sprint'); this.host.pc.setMoveAxis(0, 0); this.layout();
  }

  private bindButtons(): void {
    const { pc } = this.host;
    for (const id of HUD_BTN_IDS) {
      const m = META[id], b = this.btns.get(id)!; if (id === 'joy') continue;
      const tap = (fn: () => void): void => { b.addEventListener('pointerdown', (e) => { e.stopPropagation(); b.classList.add('down'); pc.audio.resume(); fn(); }); const up = (): void => b.classList.remove('down'); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); };
      if (id === 'ads') { // 줌은 토글. 주무기 외 슬롯(섬광탄·클래식)은 탭 = 우클릭 1회
        b.addEventListener('pointerdown', () => {
          const on = !pc.isHeld('alt'); pc.setAction('alt', on); b.classList.toggle('down', on);
          if (on && pc.getHudState().slot !== this.host.primarySlot) setTimeout(() => { pc.setAction('alt', false); b.classList.remove('down'); }, 120);
        });
      } else if (m.act === 'fire') { // 주 발사 / 보조 발사 — 여러 버튼 동시 누름 지원
        b.addEventListener('pointerdown', () => { b.classList.add('down'); this.firing.add(id); pc.setAction('fire', true); });
        const up = (): void => { b.classList.remove('down'); this.firing.delete(id); if (!this.firing.size) pc.setAction('fire', false); };
        b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
      } else if (m.act) { // 누르는 동안 유지 (점프·슬라이딩·앉기·재장전·검사·스킬)
        const act = m.act;
        b.addEventListener('pointerdown', () => { b.classList.add('down'); pc.audio.resume(); pc.setAction(act, true); });
        const up = (): void => { b.classList.remove('down'); pc.setAction(act, false); };
        b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
      } else if (slotNo(id)) tap(() => pc.switchSlot(slotNo(id) as 1 | 2 | 3 | 4));
      else if (id === 'interact') tap(() => this.host.toggleLoadout());
      else if (id === 'pause') tap(() => this.host.togglePause());
      else if (id === 'auto') tap(() => updateSettings((s) => { s.mobile.autoFire = !s.mobile.autoFire; }));
    }
  }
}

// ───────────────────────────── HUD 편집기 ─────────────────────────────
let editorOpen = false;
export function isHudEditorOpen(): boolean { return editorOpen; }

/** 인게임과 같은 화면 비율(전체화면)에서 버튼을 드래그해 배치하고 슬라이더로 크기·투명도를 조절한다. */
export function openHudEditor(onClose: () => void): void {
  if (editorOpen) return; editorOpen = true;
  const draft: HudPreset[] = getSettings().mobile.hudPresets.map((p) => structuredClone(p));
  let idx = getSettings().mobile.hudActive, sel: HudBtnId = 'fire';
  const root = document.createElement('div'); root.id = 'hud-editor';
  root.innerHTML = `<div class="hed-grid"></div><div class="hed-cross"></div>
    <div class="hed-panel" id="hed-panel">
      <div class="hed-row" id="hed-drag" title="이 막대를 끌어 패널 이동"><div class="hed-tabs" id="hed-tabs"></div><button type="button" class="hed-fold" id="hed-fold" title="패널 접기/펴기">▾</button></div>
      <div class="hed-body" id="hed-body">
        <div class="hed-sel"><b id="hed-name"></b><label><input type="checkbox" id="hed-en" /> 표시</label></div>
        <label class="hed-sl">크기 <input type="range" id="hed-scale" min="${HUD_LIMITS.scale[0] * 100}" max="${HUD_LIMITS.scale[1] * 100}" step="5" /><output id="hed-scale-v"></output></label>
        <label class="hed-sl">투명도 <input type="range" id="hed-op" min="${HUD_LIMITS.opacity[0] * 100}" max="${HUD_LIMITS.opacity[1] * 100}" step="5" /><output id="hed-op-v"></output></label>
        <div class="hed-act"><button type="button" id="hed-reset">초기화 (기본 4핑거)</button><button type="button" id="hed-cancel">취소</button><button type="button" class="pri" id="hed-save">저장 후 닫기</button></div>
      </div>
    </div>`;
  const q = <T extends HTMLElement>(id: string): T => root.querySelector('#' + id) as T;
  const els = new Map<HudBtnId, HTMLElement>();
  for (const id of HUD_BTN_IDS) {
    const el = makeBtn(id); el.id = ''; el.title = META[id].name; els.set(id, el); root.appendChild(el);
    let off: { x: number; y: number } | null = null, pid = -1;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault(); pid = e.pointerId; capture(el, pid); sel = id;
      const c = draft[idx][id]; off = { x: e.clientX - (c.x / 100) * innerWidth, y: e.clientY - (c.y / 100) * innerHeight }; refresh();
    });
    el.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid || !off) return;
      const c = draft[idx][id]; c.x = Math.round(Math.min(100, Math.max(0, ((e.clientX - off.x) / innerWidth) * 100)) * 10) / 10; c.y = Math.round(Math.min(100, Math.max(0, ((e.clientY - off.y) / innerHeight) * 100)) * 10) / 10; draw();
    });
    const end = (): void => { off = null; pid = -1; };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  }
  function draw(): void {
    for (const id of HUD_BTN_IDS) {
      const el = els.get(id)!, c = draft[idx][id]; place(el, c);
      el.classList.toggle('ghost', !c.enabled); el.classList.toggle('sel', id === sel);
    }
  }
  function refresh(): void {
    q('hed-tabs').innerHTML = HUD_PRESET_NAMES.map((n, i) => `<button type="button" data-i="${i}" class="${i === idx ? 'on' : ''}">${n}</button>`).join('');
    q('hed-tabs').querySelectorAll<HTMLElement>('button').forEach((b) => (b.onclick = () => { idx = +b.dataset.i!; refresh(); }));
    const c = draft[idx][sel];
    q('hed-name').textContent = META[sel].name; (q('hed-en') as HTMLInputElement).checked = c.enabled;
    (q('hed-scale') as HTMLInputElement).value = String(Math.round(c.scale * 100)); q('hed-scale-v').textContent = `${Math.round(c.scale * 100)}%`;
    (q('hed-op') as HTMLInputElement).value = String(Math.round(c.opacity * 100)); q('hed-op-v').textContent = `${Math.round(c.opacity * 100)}%`;
    draw();
  }
  q('hed-scale').oninput = (e) => { draft[idx][sel].scale = +(e.target as HTMLInputElement).value / 100; refresh(); };
  q('hed-op').oninput = (e) => { draft[idx][sel].opacity = +(e.target as HTMLInputElement).value / 100; refresh(); };
  q('hed-en').onchange = (e) => { draft[idx][sel].enabled = (e.target as HTMLInputElement).checked; refresh(); };
  q('hed-reset').onclick = () => { draft[idx] = defaultHudPreset(); refresh(); };
  q('hed-fold').onclick = () => { const f = root.classList.toggle('folded'); q('hed-fold').textContent = f ? '▸' : '▾'; };
  // 패널은 상단 막대를 잡아 끌어 옮길 수 있다 (버튼을 가리지 않도록)
  const panel = q('hed-panel'); let pOff: { x: number; y: number } | null = null;
  q('hed-drag').addEventListener('pointerdown', (e) => { if ((e.target as HTMLElement).closest('button')) return; const r = panel.getBoundingClientRect(); pOff = { x: e.clientX - r.left, y: e.clientY - r.top }; capture(e.currentTarget as HTMLElement, e.pointerId); });
  q('hed-drag').addEventListener('pointermove', (e) => { if (!pOff) return; panel.style.transform = 'none'; panel.style.left = `${Math.max(0, Math.min(innerWidth - 60, e.clientX - pOff.x))}px`; panel.style.top = `${Math.max(0, Math.min(innerHeight - 30, e.clientY - pOff.y))}px`; });
  q('hed-drag').addEventListener('pointerup', () => { pOff = null; });
  const close = (): void => { root.remove(); editorOpen = false; onClose(); };
  q('hed-cancel').onclick = close;
  q('hed-save').onclick = () => { updateSettings((s) => { s.mobile.hudPresets = draft.slice(0, HUD_PRESET_COUNT); s.mobile.hudActive = idx; }); close(); };
  document.body.appendChild(root); refresh();
}
