// =====================================================================
// G 홀드 투척 선택 — 화면 중앙 좌/우 2분할 오버레이 (왼쪽 섬광탄 · 오른쪽 수류탄)
//  - 각 칸 썸네일 = skinThumbs 가 실제 FBX 투척 모델을 촬영한 3D 렌더
//  - Pointer Lock 상태의 movementX 를 누적해 좌/우 선택 (데드존 이후 방향 전환), 0개 항목은 선택 불가
//  - 표시/선택만 담당. 투척 실행은 PlayerController 가 hide() 의 반환값으로 처리한다
// =====================================================================
import type { ThrowableId } from '../config/weapons';
import { cachedSkinThumb, requestSkinThumb } from './skinThumbs';

const SIDES: { id: ThrowableId; name: string; side: 'l' | 'r' }[] = [
  { id: 'flash', name: '섬광탄', side: 'l' },
  { id: 'grenade', name: '수류탄', side: 'r' },
];
const DEAD = 14; // px — 이 이상 움직여야 방향 전환
const LIMIT = 90; // 누적 상한 (반대로 돌아오는 거리를 짧게 유지)

export class NadeWheel {
  readonly el: HTMLDivElement;
  private acc = 0; private sel: ThrowableId | null = null; private counts: Record<ThrowableId, number> = { flash: 0, grenade: 0 };
  /** 터치/마우스로 칸을 직접 누른 경우 (Pointer Lock 이 없을 때) */
  onPick: ((t: ThrowableId) => void) | null = null;

  constructor() {
    this.el = document.createElement('div'); this.el.className = 'nw'; this.el.hidden = true;
    this.el.setAttribute('role', 'listbox'); this.el.setAttribute('aria-label', '투척 무기 선택');
    this.el.innerHTML = `<div class="nw-row">${SIDES.map((s) => `<button type="button" class="nw-opt nw-${s.side}" data-t="${s.id}" role="option" aria-selected="false">
        <span class="nw-vis"><img alt="" draggable="false" /></span><span class="nw-name">${s.name}</span><span class="nw-n"></span></button>`).join('<span class="nw-split" aria-hidden="true"></span>')}</div>
      <div class="nw-hint">마우스를 좌우로 움직여 고르고, G를 놓거나 클릭하면 던집니다</div>`;
    this.el.addEventListener('pointerdown', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-t]'); if (!b) return;
      const t = b.dataset.t as ThrowableId; if (this.counts[t] > 0) { e.preventDefault(); this.onPick?.(t); }
    });
  }
  get open(): boolean { return !this.el.hidden; }

  /** 열기 — 기본 선택: 지금 들고 있는/로드아웃 종류(남아 있으면), 아니면 남아 있는 쪽 */
  show(counts: Record<ThrowableId, number>, prefer: ThrowableId): void {
    this.counts = { ...counts }; this.acc = 0;
    this.sel = counts[prefer] > 0 ? prefer : SIDES.find((s) => counts[s.id] > 0)?.id ?? null;
    for (const s of SIDES) {
      const b = this.btn(s.id), img = b.querySelector('img')!, n = counts[s.id];
      b.classList.toggle('nw-off', n <= 0); b.disabled = n <= 0;
      b.querySelector('.nw-n')!.textContent = n > 0 ? `× ${n}` : '없음';
      const url = cachedSkinThumb(s.id, null);
      if (url) img.src = url; else if (url === undefined) void requestSkinThumb(s.id, null).then((u) => { if (u) img.src = u; });
    }
    this.el.hidden = false; this.paint();
  }
  /** Pointer Lock movementX 누적 → 좌/우 선택 */
  move(dx: number): void {
    if (!this.open) return;
    this.acc = Math.max(-LIMIT, Math.min(LIMIT, this.acc + dx));
    const want: ThrowableId | null = this.acc <= -DEAD ? 'flash' : this.acc >= DEAD ? 'grenade' : null;
    if (want && want !== this.sel && this.counts[want] > 0) { this.sel = want; this.paint(); }
  }
  /** 닫기 → 선택된 종류(없으면 null) */
  hide(): ThrowableId | null { if (!this.open) return null; this.el.hidden = true; const t = this.sel; this.sel = null; return t && this.counts[t] > 0 ? t : null; }

  private btn(t: ThrowableId): HTMLButtonElement { return this.el.querySelector<HTMLButtonElement>(`[data-t="${t}"]`)!; }
  private paint(): void { for (const s of SIDES) { const b = this.btn(s.id), on = s.id === this.sel; b.classList.toggle('nw-on', on); b.setAttribute('aria-selected', String(on)); } }
}
