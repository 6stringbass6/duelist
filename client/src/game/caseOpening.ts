// =====================================================================
// 컨테이너 개봉 연출 (CS2 방식)
//  열쇠 해금 · 뚜껑 오픈 → 가로 슬롯 룰렛(고속 → 감속 → 중앙 기준선 정지, 칸이 기준선을 지날 때마다 Web Audio 틱)
//  → 당첨 하이라이트. 다중 개봉은 [개별 스킵](현재 상자 결과로 즉시 이동) · [일괄 스킵](3개 이상, 전체 요약으로 이동)
//  결과는 이미 서버/로컬 엔진에서 확정된 값이며, 이 모듈은 보여 주기만 한다.
// =====================================================================
import { CASES, TIERS, caseOdds, getSkin, tierEmblemSvg, tierPool, type CaseKind, type SkinDef, type Tier } from '../config/skins';
import type { CaseResult } from '../services/economy';
import { skinSwatchUrl } from './skinTextures';

export interface CaseOpeningHooks {
  /** 결과 카드용 썸네일 HTML (main.ts skinVis) */
  vis: (s: SkinDef) => string;
  /** innerHTML 이후 썸네일 채우기 */
  hydrate: (root: HTMLElement) => void;
  /** 당첨 공개 순간 — 등급별 사운드/이펙트 (main.ts 의 기존 사운드 사용) */
  onReveal: (r: CaseResult, s: SkinDef | null) => void;
  /** 모달을 닫은 뒤 (보관함/크레딧 새로고침) */
  onClose: () => void;
}

const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (n: number): string => n.toLocaleString('ko-KR');
const hex = (n: number): string => '#' + n.toString(16).padStart(6, '0');
const STAR_SVG = '<svg class="co-star" viewBox="0 0 64 64" aria-hidden="true"><path d="M32 4 L39.6 23.6 L60 24.4 L44 37.4 L49.6 58 L32 46.4 L14.4 58 L20 37.4 L4 24.4 L24.4 23.6 Z"/></svg>';
const REEL_LEN = 52, WIN_AT = 45;
const reduced = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ───────────────────────────── 틱 사운드 (Web Audio, 에셋 없음) ─────────────────────────────
let ac: AudioContext | null = null;
function tick(speed: number): void {
  try {
    ac ??= new AudioContext();
    if (ac.state === 'suspended') void ac.resume();
    const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(520 + Math.min(1, speed) * 1100 + Math.random() * 40, t); // 빠를수록 높은 음, 감속하며 낮아짐
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(ac.destination); o.start(t); o.stop(t + 0.06);
  } catch { /* 오디오 불가 환경 */ }
}

// ───────────────────────────── 릴 구성 ─────────────────────────────
/** 채움 칸 등급: 실제 확률을 완만하게(^0.55) 해 상위 등급이 가끔 스쳐 지나가게 함 (연출용, 결과와 무관) */
function fillerTier(k: CaseKind): Tier {
  const rows = caseOdds(k).map((o) => [o.tier!, Math.pow(o.percent, 0.55)] as const), sum = rows.reduce((a, [, w]) => a + w, 0);
  let v = Math.random() * sum;
  for (const [t, w] of rows) { if ((v -= w) < 0) return t; }
  return rows[rows.length - 1][0];
}
/** 당첨 스킨이 WIN_AT 칸에 오도록 채운 릴 */
function buildReel(k: CaseKind, win: SkinDef): SkinDef[] {
  return Array.from({ length: REEL_LEN }, (_, i) => {
    if (i === WIN_AT) return win;
    const p = tierPool(fillerTier(k));
    return p[Math.floor(Math.random() * p.length)] ?? win;
  });
}

function cellHtml(s: SkinDef): string {
  const t = TIERS[s.tier];
  if (s.tier === 'exrare') return `<div class="co-cell co-rare" style="--tc:${t.color}">${STAR_SVG}<span class="co-cn">${t.name} ★</span></div>`;
  const u = skinSwatchUrl(s), bg = u ? `url(${u}) center/cover` : `linear-gradient(120deg,${hex(s.material.baseColor)},${hex(s.material.accentColor)})`;
  return `<div class="co-cell" style="--tc:${t.color}"><span class="co-sw" style="background:${bg}"></span><span class="co-cn">${esc(s.name)}</span></div>`;
}

// ───────────────────────────── 모달 ─────────────────────────────
type Phase = 'intro' | 'spin' | 'reveal' | 'summary';
export function runCaseOpening(kind: CaseKind, results: CaseResult[], hooks: CaseOpeningHooks): void {
  const n = results.length, def = CASES[kind];
  let root = document.getElementById('m-case');
  if (!root) { root = document.createElement('div'); root.id = 'm-case'; root.className = 'co-modal'; document.body.appendChild(root); }
  root.classList.remove('hidden');
  root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', `${def.name} 개봉`);
  root.innerHTML = `<div class="co-card">
    <div class="co-head"><div><span class="co-title">${esc(def.name)}</span><span class="co-sub" id="co-sub"></span></div><button type="button" class="co-x" id="co-x" aria-label="닫기">✕</button></div>
    <div class="co-stage" id="co-stage"></div>
    <div class="co-result" id="co-result" aria-live="polite"></div>
    <div class="co-foot"><div class="co-dots" id="co-dots">${results.map(() => '<i></i>').join('')}</div>
      <div class="co-acts"><button type="button" class="co-btn" id="co-skip">개별 스킵</button>${n >= 3 ? '<button type="button" class="co-btn co-ghost" id="co-skipall">일괄 스킵</button>' : ''}<button type="button" class="co-btn co-fill hidden" id="co-done">확인</button></div></div>
  </div>`;
  const $ = (id: string): HTMLElement => root!.querySelector<HTMLElement>('#' + id)!;
  const stage = $('co-stage'), result = $('co-result'), dots = [...$('co-dots').children] as HTMLElement[];
  let idx = 0, phase: Phase = 'intro', raf = 0, timer = 0, closed = false, snapToEnd: (() => void) | null = null;
  const fast = reduced();
  const stop = (): void => { cancelAnimationFrame(raf); clearTimeout(timer); };
  const skinOf = (r: CaseResult): SkinDef | null => getSkin(r.skin_id);
  const mark = (i: number): void => { const s = skinOf(results[i]); dots[i].style.background = TIERS[s?.tier ?? results[i].rarity].color; dots[i].classList.add('co-on'); };

  function close(): void {
    if (closed) return; closed = true; stop();
    root!.classList.add('hidden'); root!.innerHTML = ''; document.removeEventListener('keydown', onKey); hooks.onClose();
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); phase === 'summary' ? close() : skipAll(); }
    else if ((e.key === ' ' || e.key === 'Enter') && phase !== 'summary' && document.activeElement?.id !== 'co-skipall') { e.preventDefault(); skipOne(); }
  }
  document.addEventListener('keydown', onKey);

  function setSub(): void { $('co-sub').textContent = n > 1 ? `${Math.min(idx + 1, n)} / ${n}` : ''; }

  /** 1) 열쇠 해금 + 뚜껑 오픈 */
  function intro(): void {
    phase = 'intro'; setSub(); result.innerHTML = '';
    stage.innerHTML = `<div class="co-intro co-${kind}${idx ? ' co-quick' : ''}"><div class="co-lid"></div><div class="co-box"></div>${def.needsKey ? '<div class="co-key"></div>' : ''}<div class="co-flash"></div></div>`;
    timer = window.setTimeout(spin, fast ? 150 : idx ? 450 : 1150);
  }
  /** 2) 가로 룰렛 */
  function spin(): void {
    phase = 'spin';
    const r = results[idx], win = skinOf(r);
    if (!win) { reveal(); return; }
    const reel = buildReel(kind, win);
    stage.innerHTML = `<div class="co-win" id="co-win"><div class="co-strip" id="co-strip">${reel.map(cellHtml).join('')}</div><div class="co-line"></div></div>`;
    const strip = $('co-strip'), winEl = $('co-win'), cell = (strip.firstElementChild as HTMLElement).offsetWidth;
    const W = winEl.clientWidth, jitter = (Math.random() - 0.5) * cell * 0.7;
    const end = -(WIN_AT * cell + cell / 2 - W / 2) - jitter, T = fast ? 900 : 5600;
    const ease = (p: number): number => 1 - Math.pow(1 - p, 4.2); // 초반 고속 → 점진 감속
    const t0 = performance.now();
    snapToEnd = () => { strip.style.transform = `translate3d(${end}px,0,0)`; }; // 스킵 시 당첨 칸을 기준선 아래로
    let lastCell = -1, lastX = 0;
    const frame = (now: number): void => {
      const p = Math.min(1, (now - t0) / T), x = end * ease(p);
      strip.style.transform = `translate3d(${x}px,0,0)`;
      const c = Math.floor((W / 2 - x) / cell); // 기준선 아래 칸
      if (c !== lastCell) { if (lastCell >= 0 && !fast) tick(Math.abs(x - lastX) / 40); lastCell = c; }
      lastX = x;
      if (p < 1) raf = requestAnimationFrame(frame); else timer = window.setTimeout(reveal, 260);
    };
    raf = requestAnimationFrame(frame);
  }
  /** 3) 당첨 하이라이트 */
  function reveal(): void {
    stop(); phase = 'reveal';
    snapToEnd?.(); snapToEnd = null;
    const r = results[idx], s = skinOf(r), t = TIERS[s?.tier ?? r.rarity];
    stage.querySelector('.co-strip')?.classList.add('co-dim');
    stage.querySelectorAll('.co-cell')[WIN_AT]?.classList.add('co-hit');
    result.innerHTML = `<div class="co-reveal" style="--tc:${t.color}"><div class="co-rvis">${s ? hooks.vis(s) : ''}</div><div class="co-rtxt">
      <span class="co-tier">${tierEmblemSvg(s?.tier ?? r.rarity, 16)}${esc(t.name)}${(s?.tier ?? r.rarity) === 'exrare' ? ' ★' : ''}</span>
      <span class="co-name">${esc(s?.name ?? r.skin_id)}</span>
      <span class="co-note">${r.duplicate ? `이미 보유한 스킨 · ◈ ${fmt(r.refund)} 환급` : '새 스킨 획득'}</span></div></div>`;
    hooks.hydrate(result); mark(idx); hooks.onReveal(r, s);
    const last = idx >= n - 1;
    $('co-skip').textContent = last ? (n > 1 ? '결과 요약' : '확인') : '다음 상자';
    $('co-skipall')?.classList.toggle('hidden', last);
    if (!last) timer = window.setTimeout(next, fast ? 900 : 2200);
  }
  function next(): void {
    stop();
    if (idx >= n - 1) { if (n > 1) summary(); else close(); return; }
    idx++; $('co-skip').textContent = '개별 스킵'; intro();
  }
  /** 4) 전체 요약 그리드 */
  function summary(): void {
    stop(); phase = 'summary'; idx = n - 1; setSub();
    results.forEach((_, i) => mark(i));
    const refund = results.reduce((a, r) => a + r.refund, 0), fresh = results.filter((r) => !r.duplicate).length;
    $('co-sub').textContent = `${n}개 개봉 결과`;
    stage.innerHTML = '';
    result.innerHTML = `<div class="co-sum">${results.map((r) => { const s = skinOf(r), t = TIERS[s?.tier ?? r.rarity];
      return `<div class="co-si" style="--tc:${t.color}"><div class="co-svis">${s ? hooks.vis(s) : ''}</div><span class="co-st">${esc(t.name)}</span><span class="co-sn">${esc(s?.name ?? r.skin_id)}</span><span class="co-sd">${r.duplicate ? `중복 · ◈ ${fmt(r.refund)} 환급` : '새 스킨'}</span></div>`; }).join('')}</div>
      <div class="co-total">새 스킨 ${fresh}개${refund ? ` · 중복 환급 ◈ ${fmt(refund)}` : ''}</div>`;
    hooks.hydrate(result);
    $('co-skip').classList.add('hidden'); $('co-skipall')?.classList.add('hidden');
    const done = $('co-done'); done.classList.remove('hidden'); done.focus();
    const best = results.reduce<CaseResult | null>((a, r) => (!a || TIERS[r.rarity].order > TIERS[a.rarity].order ? r : a), null);
    if (best && TIERS[best.rarity].order >= TIERS.covert.order) hooks.onReveal(best, skinOf(best));
  }
  function skipOne(): void { if (phase === 'reveal') next(); else if (phase !== 'summary') reveal(); }
  function skipAll(): void { if (n > 1) summary(); else if (phase !== 'reveal') reveal(); else close(); }

  $('co-skip').onclick = skipOne;
  const sa = root.querySelector<HTMLElement>('#co-skipall'); if (sa) sa.onclick = skipAll;
  $('co-done').onclick = close;
  $('co-x').onclick = () => (phase === 'summary' || (n === 1 && phase === 'reveal') ? close() : skipAll());
  $('co-skip').focus();
  intro();
}
