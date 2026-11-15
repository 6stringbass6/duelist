// =====================================================================
// 킬 배너 / 킬 피드 UI 조각: 등급별 엠블럼 SVG · 무기 실루엣 아이콘 · 배너 파편/불꽃 파티클(2D 캔버스)
// DOM 삽입과 타이밍은 main.ts 가 담당하고, 여기서는 마크업과 연출만 만든다.
// =====================================================================
import type { WeaponId } from '../config/weapons';

export interface KillTier { label: string; c: string; c2: string; shake: number }
/** 연속 킬 등급: 1 시안/화이트 → 2 에메랄드 → 3 골드 → 4 퍼플/마젠타 → 5 ACE 레드-골드 네온 */
export const KILL_TIERS: KillTier[] = [
  { label: 'KILL', c: '#5ef0ff', c2: '#ffffff', shake: 4 },
  { label: 'DOUBLE KILL', c: '#22e39a', c2: '#c9ffe9', shake: 6 },
  { label: 'TRIPLE KILL', c: '#ffc928', c2: '#fff3b8', shake: 8 },
  { label: 'QUADRA KILL', c: '#b65cff', c2: '#ff5fe0', shake: 10 },
  { label: 'ACE', c: '#ff3232', c2: '#ffd23f', shake: 14 },
];
export const killTier = (n: number): number => Math.max(1, Math.min(5, Math.floor(n)));
const HS_RED = '#ff2a3f';

/** 등급 엠블럼. 일반 킬 = 다이아몬드 + 등급 숫자, 헤드샷 = 붉은 조준 레티클 + 해골. 등급이 오를수록 좌우 날개 깃이 늘어난다 */
function emblem(k: number, hs: boolean): string {
  const { c, c2 } = KILL_TIERS[k - 1];
  let wings = '';
  for (const dir of [1, -1]) for (let i = 0; i < k; i++) {
    const x = 60 + dir * (33 + i * 8), y = 62 - i * 5;
    wings += `<path d="M${x} ${y} l${dir * 17} ${-10 - i * 3} l${-dir * 5} ${24 + i * 3} z" fill="${i % 2 ? c2 : c}" opacity="${0.95 - i * 0.1}"/>`;
  }
  const frame = `<g class="kb-spin"><circle cx="60" cy="60" r="47" fill="none" stroke="${c}" stroke-width="1.5" stroke-dasharray="5 9" opacity=".7"/></g>`;
  const core = hs
    ? `<circle cx="60" cy="60" r="38" fill="none" stroke="${c}" stroke-width="1.5" opacity=".85"/>
       <circle cx="60" cy="60" r="31" fill="#12060a" stroke="${HS_RED}" stroke-width="4"/>
       <path d="M60 12v16M60 92v16M12 60h16M92 60h16" stroke="${HS_RED}" stroke-width="5" stroke-linecap="square"/>
       <path d="M60 39c-11 0-18.500 7.500-18.500 17.500 0 6.500 3 11 7.500 13.500v7h22v-7c4.500-2.500 7.500-7 7.500-13.500C78.500 46.500 71 39 60 39z" fill="#fff"/>
       <circle cx="52.500" cy="57" r="4.600" fill="${HS_RED}"/><circle cx="67.500" cy="57" r="4.600" fill="${HS_RED}"/>
       <path d="M60 62l-3 6h6zM54 72v5M60 72v5M66 72v5" fill="#12060a" stroke="#12060a" stroke-width="1.6"/>`
    : `<path d="M60 14L94 60 60 106 26 60z" fill="#0a0f18" stroke="${c}" stroke-width="3.500" stroke-linejoin="round"/>
       <path d="M60 25L85 60 60 95 35 60z" fill="none" stroke="${c2}" stroke-width="1.500" opacity=".75"/>
       <path d="M60 14L94 60H26z" fill="${c}" opacity=".16"/>
       <text x="60" y="${k >= 5 ? 74 : 73}" text-anchor="middle" font-family="system-ui,sans-serif" font-weight="900" font-size="${k >= 5 ? 40 : 38}" fill="${c2}" stroke="#000" stroke-width="1" paint-order="stroke">${k >= 5 ? '★' : k}</text>`;
  const crown = k >= 5 ? `<path d="M40 16l9 9 11-15 11 15 9-9-4 19H44z" fill="#ffd23f" stroke="#fff3b8" stroke-width="1.500" stroke-linejoin="round" transform="translate(0 -14)"/>` : '';
  return `<svg viewBox="-20 -14 160 140">${frame}${wings}${core}${crown}</svg>`;
}

/** 킬 배너 마크업. fx=true 면 파편 파티클용 캔버스를 포함한다 */
export function killBannerHtml(n: number, hs: boolean, fx: boolean): string {
  const k = killTier(n), t = KILL_TIERS[k - 1];
  const pips = KILL_TIERS.map((_, i) => `<i class="${i < k ? 'on' : ''}${i === k - 1 ? ' now' : ''}"></i>`).join('');
  return `<div class="kb t${k}${hs ? ' hs' : ''}" style="--kc:${t.c};--kc2:${t.c2};--gl:${hs ? HS_RED : t.c};--sh:${t.shake + (hs ? 3 : 0)}px">
    ${fx ? '<canvas class="kb-fx" width="640" height="380"></canvas>' : ''}
    <div class="kb-in"><div class="kb-ring"></div>${hs ? '<div class="kb-ring r2"></div>' : ''}
      <div class="kb-em">${emblem(k, hs)}</div>
      <div class="kb-plate">${hs ? '<span class="kb-tag">◎ HEADSHOT ◎</span>' : ''}<b class="kb-title">${t.label}</b><div class="kb-pips">${pips}</div></div>
    </div></div>`;
}

/** 배너 파편/불꽃 파티클. 등급이 오를수록 파편 수 증가, ACE 는 아래에서 치솟는 불꽃 추가. 캔버스가 DOM 에서 빠지면 자동 종료 */
export function playBannerParticles(cv: HTMLCanvasElement, n: number, hs: boolean, density: number): void {
  const ctx = cv.getContext('2d'); if (!ctx || density <= 0) return;
  const k = killTier(n), t = KILL_TIERS[k - 1], W = cv.width, H = cv.height, cx = W / 2, cy = H * 0.45;
  interface P { x: number; y: number; vx: number; vy: number; life: number; max: number; size: number; rot: number; vr: number; c: string; g: number; shard: boolean }
  const ps: P[] = [], rnd = (a: number, b: number): number => a + Math.random() * (b - a);
  const colors = k >= 5 ? ['#ff3232', '#ff7a1a', '#ffd23f', '#fff3b8'] : [t.c, t.c2, '#ffffff'];
  const shards = Math.round(([0, 8, 14, 20, 34][k - 1] + (hs ? 8 : 0)) * density);
  for (let i = 0; i < shards; i++) {
    const a = Math.random() * Math.PI * 2, sp = rnd(160, 520 + k * 40), life = rnd(0.5, 1.1);
    ps.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp * 0.75 - 60, life, max: life, size: rnd(4, 9 + k), rot: rnd(0, 6.28), vr: rnd(-12, 12), c: hs && i % 3 === 0 ? HS_RED : colors[(Math.random() * colors.length) | 0], g: 620, shard: true });
  }
  let embers = k >= 5 ? 1 : 0, acc = 0, last = performance.now();
  const t0 = last;
  const step = (now: number): void => {
    if (!cv.isConnected) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (embers && now - t0 < 1700) { // ACE 불꽃: 배너 아래에서 계속 치솟음
      acc += dt * 95 * density;
      while (acc >= 1) { acc--; const life = rnd(0.6, 1.4); ps.push({ x: cx + rnd(-190, 190), y: H * 0.72 + rnd(-10, 20), vx: rnd(-40, 40), vy: rnd(-300, -110), life, max: life, size: rnd(1.5, 4.2), rot: 0, vr: 0, c: colors[(Math.random() * 3) | 0], g: -90, shard: false }); }
    } else embers = 0;
    ctx.clearRect(0, 0, W, H); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i]; p.life -= dt;
      if (p.life <= 0) { ps[i] = ps[ps.length - 1]; ps.pop(); continue; }
      const drag = Math.pow(p.shard ? 0.12 : 0.5, dt); p.vx *= drag; p.vy = p.vy * drag + p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      ctx.globalAlpha = Math.min(1, (p.life / p.max) * 1.7);
      if (p.shard) { // 회전하는 삼각 파편
        const s = p.size, c = Math.cos(p.rot), sn = Math.sin(p.rot);
        ctx.fillStyle = p.c; ctx.beginPath(); ctx.moveTo(p.x + c * s, p.y + sn * s); ctx.lineTo(p.x - sn * s * 0.35, p.y + c * s * 0.35); ctx.lineTo(p.x - c * s * 0.6, p.y - sn * s * 0.6); ctx.closePath(); ctx.fill();
      } else { ctx.strokeStyle = p.c; ctx.lineWidth = p.size; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.04, p.y - p.vy * 0.04 - 0.01); ctx.stroke(); }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    if (ps.length || embers) requestAnimationFrame(step); else ctx.clearRect(0, 0, W, H);
  };
  requestAnimationFrame(step);
}

// ───────────────────────────── 킬 피드 아이콘 ─────────────────────────────
// 48×18 실루엣, 총구가 오른쪽(= 피해자 방향). currentColor 로 칠해 CSS 에서 색을 제어한다.
const PISTOL = 'M10 4h26v5H22v2h-4l-1 6h-6l1-8h-2z';
const WEAPON_ICONS: Record<WeaponId, string> = {
  classic: `<path d="${PISTOL}"/>`,
  ghost: '<path d="M8 4h20v1h14v3H28v1H20v2h-4l-1 6H9l1-8H8z"/>',
  frenzy: '<path d="M10 4h26v5H23v2h-3v7h-6v-9h-4z"/>',
  sheriff: '<path d="M8 5h9V4h8v1h15v3H26c0 2-2 3.500-4.500 3.500H19l-2 5.500h-6l2-8H8z"/>',
  shorty: '<path d="M6 4h36v2.500H6zM6 7.500h36V10H23l-3 2h-6l-2 5H6l3-7H6z"/>',
  vandal: '<path d="M1 7h9l2-2h20V4h3v1h12v2H35v2h-6l-1 7h-4l-1-7h-5l-2 4h-4l1-4H7l-3 3H1z"/>',
  phantom: '<path d="M1 7h9l2-2h17v-.500h18v3.500H33v1h-5l-.500 6h-4l-.500-6h-5l-2 4h-4l1-4H7l-3 3H1z"/>',
  marshal: '<path d="M1 8h10l2-2h13v1h21v2H30v1h-4l-2 5h-4l1-5H9l-4 3H1zM14 2h13v3H14z"/>',
  fists: '<path d="M17 4h4v2h1V4h4v2h1V4h4a3 3 0 0 1 3 3v5a4 4 0 0 1-4 4H19a5 5 0 0 1-5-5V8a2 2 0 0 1 3-1.700z"/>',
  dagger: '<path d="M3 9l22-4.500L28 7h4V5h2.500v8H32v-2h-4l-3 2.500zM35.500 7H45v4h-9.500z"/>',
  sword: '<path d="M1 9l5-2.500h27V3h2.500v12H33v-3.500H6zM36.500 7.500H47v3H36.500z"/>',
  grenade: '<circle cx="23" cy="11" r="6.500"/><path d="M20 1.500h6V5h-6zM26 1.500h6l-1 6h-2l.500-4H26z"/>',
  flash: '<rect x="18" y="5" width="11" height="12" rx="2"/><path d="M20.500 1.500h6V5h-6zM26.500 1.500h6V4h-6z"/>',
};
export function weaponIcon(id: WeaponId, title: string): string {
  return `<svg class="wi" viewBox="0 0 48 18" fill="currentColor" aria-label="${title}"><title>${title}</title>${WEAPON_ICONS[id] ?? `<path d="${PISTOL}"/>`}</svg>`;
}
/** 헤드샷 표식: 조준 레티클 */
export const HS_ICON = '<svg class="kf-hs" viewBox="0 0 16 16" aria-label="헤드샷"><title>헤드샷</title><circle cx="8" cy="8" r="4.700" fill="none" stroke="currentColor" stroke-width="1.700"/><circle cx="8" cy="8" r="1.700" fill="currentColor"/><path d="M8 0v3.500M8 12.500V16M0 8h3.500M12.500 8H16" stroke="currentColor" stroke-width="1.700"/></svg>';
