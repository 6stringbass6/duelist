// =====================================================================
// 프로시저럴 스킨 텍스처 생성기 — 외부 이미지 없이 오프스크린 Canvas(1024x1024)로
// Diffuse(map) / Roughness / Bump / Emissive 4종 맵을 즉석 생성.
//  - 스타일(등급별 3·3·3·1·2종)마다 페인터 1개. 모든 좌표는 논리 해상도 N=1024 기준이며
//    컨텍스트 스케일로 실제 해상도를 바꾼다(상점 스와치는 256px 로 가볍게 생성).
//  - 재질 키(스타일+색) 기준 캐시 → 같은 컬렉션은 무기 종류와 무관하게 텍스처 1세트만 생성/업로드.
// =====================================================================
import * as THREE from 'three';
import type { SkinDef, SkinMaterial, SkinStyle } from '../config/skins';

export interface SkinTextures {
  style: SkinStyle; map: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture; bumpMap: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture | null;
  /** 스타일별 PBR 보정 */
  bumpScale: number; clearcoat: number; clearcoatRoughness: number;
}

const N = 1024;                 // 논리 해상도
export const SKIN_TEX_SIZE = 1024; // 실제 인게임 텍스처 해상도
const TAU = Math.PI * 2;
type G = CanvasRenderingContext2D;
interface Paint { map: G; rough: G; bump: G; emis: G; m: SkinMaterial; rnd: () => number; glow: boolean }
type Painter = (p: Paint) => void;
type Pt = [number, number];

const hex = (n: number): string => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const rgb = (n: number): [number, number, number] => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const rgba = (n: number, a: number): string => { const [r, g, b] = rgb(n); return `rgba(${r},${g},${b},${a})`; };
const mix = (a: number, b: number, t: number): number => {
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b);
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
};
const gray = (v: number): string => { const k = Math.round(Math.max(0, Math.min(1, v)) * 255); return `rgb(${k},${k},${k})`; };
const rngFor = (seed: number) => { let s = (seed >>> 0) || 1; return (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
const mkLayer = (size: number): G => {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d')!; g.scale(size / N, size / N); return g;
};
const fill = (g: G, style: string | CanvasGradient): void => { g.fillStyle = style; g.fillRect(0, 0, N, N); };
/** 타일 이음새가 없도록 주변 9곳에 반복 그리기 */
const wrap = (fn: (ox: number, oy: number) => void): void => { for (let ox = -N; ox <= N; ox += N) for (let oy = -N; oy <= N; oy += N) fn(ox, oy); };
const line = (g: G, pts: Pt[], ox = 0, oy = 0): void => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x + ox, y + oy) : g.moveTo(x + ox, y + oy))); g.stroke(); };

// ── 공용 디테일 ──────────────────────────────────────────────────────
let noiseTile: HTMLCanvasElement | null = null;
/** 미세 입자(오버레이 합성) — 픽셀 루프 없이 256px 노이즈 타일을 패턴으로 깐다 */
function grain(g: G, alpha: number): void {
  if (!noiseTile) {
    noiseTile = document.createElement('canvas'); noiseTile.width = noiseTile.height = 256;
    const ng = noiseTile.getContext('2d')!, img = ng.createImageData(256, 256), d = img.data, r = rngFor(90210);
    for (let i = 0; i < d.length; i += 4) { const v = Math.floor(r() * 256); d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255; }
    ng.putImageData(img, 0, 0);
  }
  g.save(); g.globalCompositeOperation = 'overlay'; g.globalAlpha = alpha; g.fillStyle = g.createPattern(noiseTile, 'repeat')!; g.fillRect(0, 0, N, N); g.restore();
}
/** 타일링되는 값 노이즈 필드 (격자 G×G, 쌍선형 보간) */
function field(Gn: number, rnd: () => number): (x: number, y: number) => number {
  const v = Array.from({ length: Gn * Gn }, () => rnd());
  const at = (x: number, y: number): number => v[((y % Gn) + Gn) % Gn * Gn + ((x % Gn) + Gn) % Gn];
  return (x, y) => {
    const fx = x * Gn, fy = y * Gn, ix = Math.floor(fx), iy = Math.floor(fy); let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    return (at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx) * (1 - ty) + (at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx) * ty;
  };
}
/** 패널 라인(가로 홈 + 세로 컷) + 볼트 — 기계적 입체감 */
function panels(p: Paint, rows: number, strength = 1): void {
  const { map: g, rough: r, bump: b, rnd } = p, ys: number[] = [];
  for (let i = 0; i < rows; i++) ys.push(Math.round(((i + 0.3 + rnd() * 0.4) / rows) * N));
  const groove = (x1: number, y1: number, x2: number, y2: number): void => {
    g.strokeStyle = `rgba(0,0,0,${0.5 * strength})`; g.lineWidth = 3; line(g, [[x1, y1], [x2, y2]]);
    g.strokeStyle = `rgba(255,255,255,${0.13 * strength})`; g.lineWidth = 1; line(g, [[x1 + (y1 === y2 ? 0 : 2), y1 + (y1 === y2 ? 2.5 : 0)], [x2 + (y1 === y2 ? 0 : 2), y2 + (y1 === y2 ? 2.5 : 0)]]);
    b.strokeStyle = gray(0.5 - 0.34 * strength); b.lineWidth = 4; line(b, [[x1, y1], [x2, y2]]);
    r.strokeStyle = gray(0.7); r.lineWidth = 3; line(r, [[x1, y1], [x2, y2]]);
  };
  ys.forEach((y, i) => {
    groove(0, y, N, y);
    const y2 = i + 1 < ys.length ? ys[i + 1] : ys[0] + N, cuts = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < cuts; k++) {
      const x = Math.round(rnd() * N); groove(x, y, x, Math.min(N, y2)); if (y2 > N) groove(x, 0, x, y2 - N);
      const bx = (x + 22) % N, by = y + 22; // 볼트
      if (by < N - 12) {
        g.fillStyle = `rgba(0,0,0,${0.45 * strength})`; g.beginPath(); g.arc(bx, by, 7, 0, TAU); g.fill();
        g.fillStyle = `rgba(255,255,255,${0.16 * strength})`; g.beginPath(); g.arc(bx - 1, by - 1, 4, 0, TAU); g.fill();
        b.fillStyle = gray(0.5 + 0.3 * strength); b.beginPath(); b.arc(bx, by, 7, 0, TAU); b.fill(); b.fillStyle = gray(0.3); b.fillRect(bx - 5, by - 1, 10, 2);
        r.fillStyle = gray(0.3); r.beginPath(); r.arc(bx, by, 7, 0, TAU); r.fill();
      }
    }
  });
}
/** 사용 흔적 스크래치 — 밝은 선 + 매끈한 러프니스 + 얕은 홈 */
function scratches(p: Paint, n: number, light = 0.22): void {
  const { map: g, rough: r, bump: b, rnd } = p;
  for (let i = 0; i < n; i++) {
    const x = rnd() * N, y = rnd() * N, a = (rnd() - 0.5) * 0.9, len = 14 + rnd() * 90, pts: Pt[] = [[x, y], [x + Math.cos(a) * len, y + Math.sin(a) * len]];
    g.strokeStyle = `rgba(255,255,255,${light * (0.4 + rnd() * 0.6)})`; g.lineWidth = 0.8 + rnd(); line(g, pts);
    r.strokeStyle = gray(0.3 + rnd() * 0.15); r.lineWidth = 1.5; line(r, pts);
    b.strokeStyle = gray(0.4); b.lineWidth = 1.2; line(b, pts);
  }
}
/** 발광 맵용 글로우 스트로크 (넓고 옅게 → 좁고 진하게) */
function glowLine(e: G, pts: Pt[], w: number, color = 0xffffff, ox = 0, oy = 0): void {
  e.lineCap = 'round'; e.lineJoin = 'round';
  for (const [k, a] of [[5, 0.12], [2.4, 0.38], [1, 1]] as Pt[]) { e.strokeStyle = rgba(color, a); e.lineWidth = w * k; line(e, pts, ox, oy); }
}
/** 균열 네트워크(랜덤 워크 + 분기) 폴리라인 목록 */
function crackLines(rnd: () => number, n: number, seg: [number, number], step: [number, number], branch = 0.28): Pt[][] {
  const out: Pt[][] = [];
  const walk = (x: number, y: number, a: number, segs: number, depth: number): void => {
    const pts: Pt[] = [[x, y]];
    for (let i = 0; i < segs; i++) {
      a += (rnd() - 0.5) * 1.2; const d = step[0] + rnd() * (step[1] - step[0]); x += Math.cos(a) * d; y += Math.sin(a) * d; pts.push([x, y]);
      if (depth < 2 && rnd() < branch) walk(x, y, a + (rnd() < 0.5 ? 1 : -1) * (0.6 + rnd() * 0.7), Math.max(3, Math.floor(segs * 0.45)), depth + 1);
    }
    out.push(pts);
  };
  for (let i = 0; i < n; i++) walk(rnd() * N, rnd() * N, rnd() * TAU, seg[0] + Math.floor(rnd() * (seg[1] - seg[0])), 0);
  return out;
}
const hexPath = (g: G, cx: number, cy: number, r: number): void => {
  g.beginPath(); for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k + Math.PI / 6; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } g.closePath();
};
const label = (g: G, text: string, x: number, y: number, px: number, style: string, font = 'monospace'): void => {
  g.font = `bold ${px}px ${font}`; g.textBaseline = 'middle'; g.fillStyle = style; g.fillText(text, x, y);
};

// ═════════════════════════ 셀렉트 ═════════════════════════
// 1) 전술 매트 코팅 — 세라믹 코트의 거친 입자 + 스텐실 마킹
const paintMatte: Painter = (p) => {
  const { map: g, rough: r, bump: b, m, rnd } = p;
  fill(g, hex(m.baseColor)); fill(r, gray(0.9)); fill(b, gray(0.5));
  for (let i = 0; i < 40; i++) { // 코팅 두께 편차(큰 얼룩)
    const x = rnd() * N, y = rnd() * N, rad = 80 + rnd() * 170, lt = rnd() < 0.5;
    wrap((ox, oy) => {
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad);
      gr.addColorStop(0, lt ? rgba(m.accentColor, 0.22) : 'rgba(0,0,0,0.16)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2);
    });
  }
  panels(p, 5, 0.8);
  for (let k = 0; k < 4; k++) { // 경고 사선 스텐실
    const x = rnd() * (N - 220), y = 40 + rnd() * (N - 120);
    g.save(); g.beginPath(); g.rect(x, y, 180, 26); g.clip(); g.fillStyle = rgba(m.patternColor, 0.85);
    for (let s = -40; s < 220; s += 28) { g.beginPath(); g.moveTo(x + s, y + 26); g.lineTo(x + s + 14, y + 26); g.lineTo(x + s + 40, y); g.lineTo(x + s + 26, y); g.fill(); }
    g.restore(); r.fillStyle = gray(0.7); r.fillRect(x, y, 180, 26);
  }
  ['TAC-SEL // 07', 'SAFE ▸ SEMI ▸ AUTO', 'MATTE CERAMIC', 'GS-556'].forEach((t, i) => label(g, t, 40 + rnd() * 560, 90 + i * 250 + rnd() * 60, 26 + (i % 2) * 8, rgba(i % 2 ? m.patternColor : 0xd8dde3, 0.7)));
  grain(g, 0.3); grain(b, 0.7); grain(r, 0.25);
  scratches(p, 70, 0.2);
};

// 2) 디지털 카모 — 16px 픽셀 블록, 노이즈 필드로 군집
const paintDigicamo: Painter = (p) => {
  const { map: g, rough: r, bump: b, m, rnd } = p, C = 16, Gn = N / C;
  const f1 = field(6, rnd), f2 = field(14, rnd), f3 = field(30, rnd);
  const cols = [mix(m.accentColor, 0x000000, 0.35), m.accentColor, m.baseColor, mix(m.baseColor, m.patternColor, 0.55), m.patternColor];
  for (let y = 0; y < Gn; y++) for (let x = 0; x < Gn; x++) {
    const u = x / Gn, v = y / Gn, n = f1(u, v) * 0.5 + f2(u, v) * 0.32 + f3(u, v) * 0.18 + (rnd() - 0.5) * 0.07;
    const i = n < 0.36 ? 0 : n < 0.45 ? 1 : n < 0.56 ? 2 : n < 0.65 ? 3 : 4;
    g.fillStyle = hex(cols[i]); g.fillRect(x * C, y * C, C, C);
    b.fillStyle = gray(0.44 + i * 0.03); b.fillRect(x * C, y * C, C, C);
    r.fillStyle = gray(0.84 + (i % 2) * 0.06); r.fillRect(x * C, y * C, C, C);
  }
  panels(p, 4, 0.7);
  label(g, 'DGTL-CAM / M2', 60, 180, 24, 'rgba(0,0,0,0.45)'); label(g, 'UNIT 04', 620, 700, 30, 'rgba(0,0,0,0.4)');
  grain(g, 0.24); grain(b, 0.5); grain(r, 0.2);
  scratches(p, 50, 0.18);
};

// 3) 브러시드 스틸 — 헤어라인 가공 + 레이저 각인
const paintSteel: Painter = (p) => {
  const { map: g, rough: r, bump: b, m, rnd } = p;
  for (let y = 0; y < N; y += 2) { // 세로 방향 완만한 명암 띠(이방성 반사 흉내, 타일링)
    const t = 0.5 + 0.5 * Math.sin((y / N) * TAU * 3 + 1);
    g.fillStyle = hex(mix(m.baseColor, t > 0.5 ? m.patternColor : m.accentColor, Math.abs(t - 0.5) * 0.7)); g.fillRect(0, y, N, 2);
  }
  fill(r, gray(0.5)); fill(b, gray(0.5));
  for (let i = 0; i < 5200; i++) { // 가로 헤어라인
    const y = rnd() * N, x = rnd() * N, len = 80 + rnd() * 520, lt = rnd() < 0.5, a = 0.04 + rnd() * 0.1, rv = gray(0.28 + rnd() * 0.5), bv = gray(0.36 + rnd() * 0.28);
    for (const ox of [0, -N]) {
      g.fillStyle = lt ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.3})`; g.fillRect(x + ox, y, len, 1);
      r.globalAlpha = 0.55; r.fillStyle = rv; r.fillRect(x + ox, y, len, 1.2);
      b.globalAlpha = 0.5; b.fillStyle = bv; b.fillRect(x + ox, y, len, 1.2);
    }
  }
  r.globalAlpha = b.globalAlpha = 1;
  panels(p, 4, 1);
  ['STAINLESS', 'CAL 5.56', 'GRIDSTRIKE ARMS', 'S/N 00-417'].forEach((t, i) => { // 레이저 각인
    const x = 50 + rnd() * 600, y = 120 + i * 240 + rnd() * 40;
    label(g, t, x, y, 30, rgba(mix(m.accentColor, 0x000000, 0.5), 0.75), 'sans-serif'); label(r, t, x, y, 30, gray(0.85), 'sans-serif'); label(b, t, x, y, 30, gray(0.36), 'sans-serif');
  });
  grain(g, 0.1); scratches(p, 40, 0.3);
};

// ═════════════════════════ 디럭스 ═════════════════════════
// 4) 아노다이징 메탈릭 — 주기 그라데이션 + 비드 블라스트 + 널링 밴드
const paintAnodized: Painter = (p) => {
  const { map: g, rough: r, bump: b, m, rnd } = p;
  const gr = g.createLinearGradient(0, 0, N, 0); gr.addColorStop(0, hex(m.baseColor)); gr.addColorStop(0.5, hex(m.accentColor)); gr.addColorStop(1, hex(m.baseColor));
  fill(g, gr); fill(r, gray(0.55)); fill(b, gray(0.5));
  const sh = g.createLinearGradient(0, 0, 0, N); // 세로 광택 띠(주기)
  for (let k = 0; k <= 8; k++) sh.addColorStop(k / 8, k % 2 ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.16)');
  fill(g, sh);
  for (const y0 of [N * 0.3, N * 0.8]) { // 널링(다이아 크로스해치) 밴드
    const h = 96;
    for (const [cg, st, lw] of [[g, 'rgba(0,0,0,0.42)', 2.5], [b, gray(0.2), 4], [r, gray(0.8), 3]] as [G, string, number][]) {
      cg.save(); cg.beginPath(); cg.rect(0, y0, N, h); cg.clip(); cg.strokeStyle = st; cg.lineWidth = lw;
      for (let x = -h; x < N + h; x += 16) { line(cg, [[x, y0], [x + h, y0 + h]]); line(cg, [[x + h, y0], [x, y0 + h]]); }
      cg.restore();
    }
    for (const yy of [y0 - 6, y0 + h + 6]) { // 가공 모따기 라인
      g.strokeStyle = rgba(m.patternColor, 0.75); g.lineWidth = 3; line(g, [[0, yy], [N, yy]]);
      b.strokeStyle = gray(0.78); b.lineWidth = 4; line(b, [[0, yy], [N, yy]]); r.strokeStyle = gray(0.2); r.lineWidth = 4; line(r, [[0, yy], [N, yy]]);
    }
  }
  panels(p, 3, 0.8);
  for (let k = 0; k < 3; k++) label(g, ['ANODIZED 7075-T6', 'DLX', 'TYPE III HARDCOAT'][k], 60 + rnd() * 520, 60 + k * 330 + rnd() * 30, 24, rgba(m.patternColor, 0.6), 'sans-serif');
  grain(g, 0.14); grain(b, 0.4); grain(r, 0.3);
  scratches(p, 24, 0.28);
};

// 5) 헥사곤 아머 — 돌출된 벌집 플레이트 + 엣지 발광
const paintHex: Painter = (p) => {
  const { map: g, rough: r, bump: b, emis: e, m, rnd } = p; p.glow = true;
  fill(g, hex(m.accentColor)); fill(r, gray(0.7)); fill(b, gray(0.18));
  const R = 44, cols = Math.round(N / (Math.sqrt(3) * R)), rows = Math.round(N / (R * 3)) * 2, sx = N / cols, sy = N / rows; // N 에 정확히 맞춰 타일링
  for (let row = 0; row < rows; row++) for (let q = 0; q < cols; q++) {
    const cx = q * sx + (row % 2 ? sx / 2 : 0) + sx / 2, cy = row * sy + sy / 2, rr = (sx / Math.sqrt(3)) * 0.92, tone = rnd(), lit = rnd() < 0.13;
    wrap((ox, oy) => {
      if (Math.abs(ox) + Math.abs(oy) > N) return;
      const x = cx + ox, y = cy + oy;
      hexPath(g, x, y, rr); const gr = g.createLinearGradient(x, y - rr, x, y + rr);
      gr.addColorStop(0, hex(mix(m.baseColor, 0xffffff, 0.14 + tone * 0.1))); gr.addColorStop(0.5, hex(m.baseColor)); gr.addColorStop(1, hex(mix(m.baseColor, 0x000000, 0.35)));
      g.fillStyle = gr; g.fill(); g.lineWidth = 2.5; g.strokeStyle = rgba(m.patternColor, lit ? 0.95 : 0.4); g.stroke();
      hexPath(b, x, y, rr); const bg = b.createRadialGradient(x, y, rr * 0.3, x, y, rr); bg.addColorStop(0, gray(0.78)); bg.addColorStop(0.8, gray(0.7)); bg.addColorStop(1, gray(0.4)); b.fillStyle = bg; b.fill();
      hexPath(r, x, y, rr); r.fillStyle = gray(0.32 + tone * 0.22); r.fill();
      hexPath(e, x, y, rr * 0.98); e.lineWidth = lit ? 5 : 2; e.strokeStyle = `rgba(255,255,255,${lit ? 1 : 0.22})`; e.stroke();
      if (lit) { e.fillStyle = 'rgba(255,255,255,0.16)'; e.fill(); hexPath(g, x, y, rr * 0.5); g.fillStyle = rgba(m.patternColor, 0.35); g.fill(); }
    });
  }
  grain(g, 0.12); grain(b, 0.12); scratches(p, 30, 0.2);
};

// 6) 투톤 레이싱 — 상/하 투톤 + 핀스트라이프 + 체커/넘버 데칼
const paintRacing: Painter = (p) => {
  const { map: g, rough: r, bump: b, m, rnd } = p, H = N / 2;
  fill(g, hex(m.baseColor)); g.fillStyle = hex(m.accentColor); g.fillRect(0, H, N, H); fill(r, gray(0.5)); fill(b, gray(0.5));
  for (const y of [0, H, N]) { // 경계 핀스트라이프(세로 타일링 포함)
    g.fillStyle = hex(m.patternColor); g.fillRect(0, y - 9, N, 18);
    g.fillStyle = hex(y === H ? m.baseColor : m.accentColor); g.fillRect(0, y + (y === H ? 22 : -28), N, 6);
    b.fillStyle = gray(0.62); b.fillRect(0, y - 9, N, 18); r.fillStyle = gray(0.75); r.fillRect(0, y - 9, N, 18);
  }
  for (let k = 0; k < 2; k++) {
    const x0 = k * 512;
    for (let i = 0; i < 3; i++) { // 스피드 슬래시(하단 밴드)
      const x = x0 + 70 + i * 62, w = 34 - i * 6; g.fillStyle = hex(i === 2 ? m.patternColor : m.baseColor);
      g.beginPath(); g.moveTo(x, H + 210); g.lineTo(x + w, H + 210); g.lineTo(x + w + 90, H + 60); g.lineTo(x + 90, H + 60); g.fill();
    }
    for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 9; cx++) { // 체커 스트립(상단 밴드)
      g.fillStyle = (cx + cy) % 2 ? '#f4f4f0' : '#101114'; g.fillRect(x0 + 40 + cx * 22, 300 + cy * 22, 22, 22);
    }
    const nx = x0 + 380, ny = 190; // 넘버 라운델
    g.fillStyle = '#f4f4f0'; g.beginPath(); g.arc(nx, ny, 62, 0, TAU); g.fill(); g.lineWidth = 6; g.strokeStyle = hex(m.patternColor); g.stroke();
    g.textAlign = 'center'; label(g, k ? '07' : '21', nx, ny + 4, 70, hex(m.patternColor), 'sans-serif'); g.textAlign = 'left';
    b.fillStyle = gray(0.58); b.beginPath(); b.arc(nx, ny, 62, 0, TAU); b.fill();
    label(g, 'GRID//STRIKE', x0 + 250, H + 120, 34, hex(m.patternColor), 'sans-serif'); label(g, 'R-SPEC  ▸▸▸', x0 + 250, H + 162, 20, rgba(m.baseColor, 0.95), 'sans-serif');
    label(g, 'RACING DIVISION', x0 + 40, 420, 18, 'rgba(255,255,255,0.75)', 'sans-serif');
  }
  panels(p, 3, 0.5);
  for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(255,255,255,${0.05 + rnd() * 0.14})`; g.fillRect(rnd() * N, rnd() * N, 1.4, 1.4); } // 메탈릭 플레이크
  grain(r, 0.15); scratches(p, 16, 0.25);
};

// ═════════════════════════ 프리미엄 ═════════════════════════
// 7) 네온 사이버 회로 — 90°/45° 트레이스 + 노드 + IC 칩, 트레이스가 발광
const paintCircuit: Painter = (p) => {
  const { map: g, rough: r, bump: b, emis: e, m, rnd } = p; p.glow = true;
  fill(g, hex(m.baseColor)); fill(r, gray(0.42)); fill(b, gray(0.45));
  g.strokeStyle = 'rgba(255,255,255,0.045)'; g.lineWidth = 1; for (let i = 0; i < N; i += 64) { line(g, [[i, 0], [i, N]]); line(g, [[0, i], [N, i]]); }
  for (let i = 0; i < 12; i++) { // IC 칩
    const w = 64 + Math.floor(rnd() * 3) * 32, h = 64, x = Math.floor(rnd() * ((N - w) / 32)) * 32, y = Math.floor(rnd() * ((N - h) / 32)) * 32;
    g.fillStyle = hex(mix(m.baseColor, 0x000000, 0.45)); g.fillRect(x, y, w, h); g.strokeStyle = rgba(m.patternColor, 0.5); g.lineWidth = 2; g.strokeRect(x + 1, y + 1, w - 2, h - 2);
    b.fillStyle = gray(0.72); b.fillRect(x, y, w, h); r.fillStyle = gray(0.2); r.fillRect(x, y, w, h);
    for (let k = 8; k < w; k += 16) { g.fillStyle = hex(m.patternColor); g.fillRect(x + k, y - 6, 5, 6); g.fillRect(x + k, y + h, 5, 6); e.fillStyle = rgba(m.patternColor, 0.8); e.fillRect(x + k, y - 6, 5, 6); e.fillRect(x + k, y + h, 5, 6); }
    label(g, 'GS' + (100 + Math.floor(rnd() * 800)), x + 8, y + h / 2, 16, rgba(m.patternColor, 0.6));
  }
  const GRID = 32, dx = [1, 0, -1, 0, 1, 1, -1, -1], dy = [0, 1, 0, -1, 1, -1, 1, -1];
  for (let i = 0; i < 58; i++) {
    let x = Math.floor(rnd() * (N / GRID)) * GRID, y = Math.floor(rnd() * (N / GRID)) * GRID, dir = Math.floor(rnd() * 4);
    const pts: Pt[] = [[x, y]];
    for (let k = 0; k < 5; k++) {
      const len = (1 + Math.floor(rnd() * 5)) * GRID; x += dx[dir] * len; y += dy[dir] * len; pts.push([x, y]);
      dir = rnd() < 0.5 ? (dir + 1) % 4 : (dir + 3) % 4; if (rnd() < 0.25) dir = 4 + Math.floor(rnd() * 4);
    }
    const lw = rnd() < 0.3 ? 6 : 3, col = rnd() < 0.35 ? m.accentColor : m.patternColor;
    wrap((ox, oy) => {
      g.lineJoin = b.lineJoin = 'round';
      g.strokeStyle = hex(mix(col, 0x000000, 0.25)); g.lineWidth = lw; line(g, pts, ox, oy);
      b.strokeStyle = gray(0.75); b.lineWidth = lw + 2; line(b, pts, ox, oy);
      r.strokeStyle = gray(0.15); r.lineWidth = lw; line(r, pts, ox, oy);
      glowLine(e, pts, lw * 0.8, col, ox, oy);
      for (const [px, py, big] of [[...pts[pts.length - 1], 1], [...pts[0], 0]] as [number, number, number][]) { // 노드
        for (const cg of [g, e]) { cg.fillStyle = hex(col); cg.beginPath(); cg.arc(px + ox, py + oy, big ? 11 : 7, 0, TAU); cg.fill(); }
        g.fillStyle = hex(m.baseColor); g.beginPath(); g.arc(px + ox, py + oy, big ? 5 : 3, 0, TAU); g.fill();
        b.fillStyle = gray(0.85); b.beginPath(); b.arc(px + ox, py + oy, big ? 11 : 7, 0, TAU); b.fill();
      }
    });
  }
  grain(g, 0.1); grain(b, 0.12);
};

// 8) 글리치 버스트 — RGB 분리 슬라이스 + 하프톤 + 픽셀 블록
const paintGlitch: Painter = (p) => {
  const { map: g, rough: r, bump: b, emis: e, m, rnd } = p; p.glow = true;
  const YEL = 0xffe14a, pal = [m.accentColor, m.patternColor, YEL, 0xffffff, mix(m.baseColor, 0x000000, 0.5)];
  fill(g, hex(m.baseColor)); fill(r, gray(0.55)); fill(b, gray(0.5));
  for (let y = 12; y < N; y += 24) for (let x = 12; x < N; x += 24) { // 하프톤 도트(주기적으로 크기 변화)
    const s = 0.5 + 0.5 * Math.sin((x / N) * TAU * 2 + (y / N) * TAU), rad = 1 + s * 8;
    g.fillStyle = rgba(m.accentColor, 0.34); g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
  }
  for (let k = 0; k < 4; k++) { // 큰 외곽선 도형 + 색 분리 복제
    const x = rnd() * N, y = rnd() * N, s = 90 + rnd() * 120, tri = k % 2 === 0;
    const shape = (cg: G, ox: number, oy: number): void => { cg.beginPath(); if (tri) { cg.moveTo(x + ox, y + oy - s); cg.lineTo(x + ox + s, y + oy + s * 0.7); cg.lineTo(x + ox - s, y + oy + s * 0.7); cg.closePath(); } else cg.arc(x + ox, y + oy, s, 0, TAU); cg.stroke(); };
    wrap((ox, oy) => { g.lineWidth = 7; g.strokeStyle = rgba(m.patternColor, 0.8); shape(g, ox - 9, oy); g.strokeStyle = rgba(m.accentColor, 0.8); shape(g, ox + 9, oy); g.strokeStyle = '#ffffff'; shape(g, ox, oy); e.lineWidth = 4; e.strokeStyle = 'rgba(255,255,255,0.55)'; shape(e, ox, oy); });
  }
  for (let i = 0; i < 64; i++) { // 글리치 슬라이스
    const y = rnd() * N, h = 4 + rnd() * rnd() * 46, x = rnd() * N, w = 70 + rnd() * 480, col = pal[Math.floor(rnd() * pal.length)], lit = rnd() < 0.45 && col !== pal[4], sh = 5 + rnd() * 9;
    for (const ox of [0, -N]) {
      g.globalCompositeOperation = 'screen'; g.fillStyle = 'rgba(0,255,255,0.55)'; g.fillRect(x + ox - sh, y, w, h); g.fillStyle = 'rgba(255,0,180,0.55)'; g.fillRect(x + ox + sh, y, w, h);
      g.globalCompositeOperation = 'source-over'; g.fillStyle = hex(col); g.fillRect(x + ox, y, w, h);
      b.fillStyle = gray(0.66); b.fillRect(x + ox, y, w, h); r.fillStyle = gray(0.22); r.fillRect(x + ox, y, w, h);
      if (lit) { e.fillStyle = rgba(col, 0.95); e.fillRect(x + ox, y, w, h); }
    }
  }
  for (let i = 0; i < 46; i++) { // 픽셀 블록 군집
    const cx = rnd() * N, cy = rnd() * N, col = pal[Math.floor(rnd() * 4)], lit = rnd() < 0.5;
    for (let k = 0; k < 7; k++) {
      const x = Math.round((cx + (rnd() - 0.5) * 110) / 14) * 14, y = Math.round((cy + (rnd() - 0.5) * 60) / 14) * 14;
      g.fillStyle = hex(col); g.fillRect(x, y, 14, 14); if (lit) { e.fillStyle = hex(col); e.fillRect(x, y, 14, 14); }
    }
  }
  ['ERR_0x7F', '//SIGNAL LOST', 'GL1TCH', 'NO CARRIER ▚▚'].forEach((t, i) => { const x = 40 + rnd() * 520, y = 110 + i * 250; label(g, t, x - 5, y, 40, rgba(m.patternColor, 0.9)); label(g, t, x + 5, y, 40, rgba(m.accentColor, 0.9)); label(g, t, x, y, 40, '#ffffff'); label(e, t, x, y, 40, 'rgba(255,255,255,0.8)'); });
  g.fillStyle = 'rgba(0,0,0,0.2)'; for (let y = 0; y < N; y += 6) g.fillRect(0, y, N, 1.5); // 스캔라인
  grain(g, 0.12); grain(b, 0.1);
};

// 9) 캔디 크롬 — 캔디 그라데이션 + 메탈 플레이크 + 스우시 라인 (클리어코트 유광 전용)
const paintGloss: Painter = (p) => {
  const { map: g, rough: r, bump: b, emis: e, m, rnd } = p; p.glow = true;
  const gr = g.createLinearGradient(0, 0, N, 0); gr.addColorStop(0, hex(m.baseColor)); gr.addColorStop(0.5, hex(m.accentColor)); gr.addColorStop(1, hex(m.baseColor));
  fill(g, gr); fill(r, gray(0.5)); fill(b, gray(0.5));
  const sh = g.createLinearGradient(0, 0, 0, N); for (let k = 0; k <= 4; k++) sh.addColorStop(k / 4, k % 2 ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.28)'); fill(g, sh);
  const fl = [0xffffff, m.patternColor, mix(m.accentColor, 0xffffff, 0.6), mix(m.baseColor, 0xffffff, 0.5)];
  for (let i = 0; i < 12000; i++) { // 메탈 플레이크
    const x = rnd() * N, y = rnd() * N, s = 0.8 + rnd() * 1.6;
    g.fillStyle = rgba(fl[Math.floor(rnd() * fl.length)], 0.2 + rnd() * 0.7); g.fillRect(x, y, s, s);
    if (i % 3 === 0) { b.fillStyle = gray(0.62); b.fillRect(x, y, s, s); r.fillStyle = gray(0.2); r.fillRect(x, y, s, s); }
    if (i % 40 === 0) { e.fillStyle = 'rgba(255,255,255,0.9)'; e.fillRect(x, y, 2, 2); }
  }
  for (let k = 0; k < 4; k++) { // 스우시 핀스트라이프(가로 주기 → 타일링)
    const y0 = 110 + k * 256, A = 40 + rnd() * 30, ph = rnd() * TAU, pts: Pt[] = [];
    for (let x = 0; x <= N; x += 16) pts.push([x, y0 + A * Math.sin((x / N) * TAU * (1 + (k % 2)) + ph)]);
    g.lineJoin = 'round'; g.strokeStyle = rgba(m.patternColor, 0.85); g.lineWidth = 7; line(g, pts); g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2; line(g, pts);
    g.strokeStyle = rgba(mix(m.baseColor, 0x000000, 0.6), 0.6); g.lineWidth = 3; line(g, pts, 0, 12);
    b.strokeStyle = gray(0.66); b.lineWidth = 8; line(b, pts); glowLine(e, pts, 2.2, 0xffffff);
  }
};

// ═════════════════════════ 익스클루시브 ═════════════════════════
// 10) 에너지 플로우 — 장갑 플레이트 + 에너지 도관(발광 마스크). 흐름 애니메이션은 셰이더가 담당
const paintEnergy: Painter = (p) => {
  const { map: g, rough: r, bump: b, emis: e, m, rnd } = p; p.glow = true;
  fill(g, hex(mix(m.baseColor, 0x000000, 0.5))); fill(r, gray(0.75)); fill(b, gray(0.16));
  const ROWS = 8, rh = N / ROWS;
  for (let row = 0; row < ROWS; row++) { // 장갑 플레이트
    const cuts = [0]; let x = 0; while (x < N - 150) { x += 110 + Math.floor(rnd() * 190); if (x < N - 90) cuts.push(x); } cuts.push(N);
    for (let i = 0; i + 1 < cuts.length; i++) {
      const x0 = cuts[i] + 4, y0 = row * rh + 4, w = cuts[i + 1] - cuts[i] - 8, h = rh - 8, tone = rnd();
      const gr = g.createLinearGradient(0, y0, 0, y0 + h); gr.addColorStop(0, hex(mix(m.baseColor, m.accentColor, 0.5 + tone * 0.5))); gr.addColorStop(1, hex(mix(m.baseColor, m.accentColor, tone * 0.35)));
      g.fillStyle = gr; g.fillRect(x0, y0, w, h); g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(x0, y0, w, 2); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(x0, y0 + h - 3, w, 3);
      b.fillStyle = gray(0.6 + tone * 0.12); b.fillRect(x0, y0, w, h); b.fillStyle = gray(0.74); b.fillRect(x0, y0, w, 3);
      r.fillStyle = gray(0.3 + tone * 0.25); r.fillRect(x0, y0, w, h);
      if (rnd() < 0.3) { e.fillStyle = 'rgba(255,255,255,0.5)'; e.fillRect(cuts[i] - 2, y0, 4, h); g.fillStyle = rgba(m.patternColor, 0.7); g.fillRect(cuts[i] - 2, y0, 4, h); } // 틈새 누광
    }
  }
  for (let k = 0; k < 6; k++) { // 에너지 도관: 가로로 완주하는 사인 채널(정수 주기 → 타일링)
    const y0 = (k + 0.5) * (N / 6) + (rnd() - 0.5) * 50, A = 26 + rnd() * 46, f = 1 + Math.floor(rnd() * 3), ph = rnd() * TAU, pts: Pt[] = [];
    for (let x = -16; x <= N + 16; x += 16) pts.push([x, y0 + A * Math.sin((x / N) * TAU * f + ph) + A * 0.3 * Math.sin((x / N) * TAU * f * 3 + ph * 2)]);
    for (const oy of [0, -N, N]) {
      g.lineJoin = g.lineCap = 'round'; g.strokeStyle = 'rgba(0,0,0,0.85)'; g.lineWidth = 20; line(g, pts, 0, oy); g.strokeStyle = hex(m.patternColor); g.lineWidth = 6; line(g, pts, 0, oy); g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1.5; line(g, pts, 0, oy);
      b.lineJoin = 'round'; b.strokeStyle = gray(0.1); b.lineWidth = 20; line(b, pts, 0, oy); r.strokeStyle = gray(0.15); r.lineWidth = 18; line(r, pts, 0, oy);
      glowLine(e, pts, 6, 0xffffff, 0, oy);
    }
    for (let j = 0; j < 7; j++) { // 분기 맥 + 노드
      const [bx, by] = pts[2 + Math.floor(rnd() * (pts.length - 4))], dir = rnd() < 0.5 ? -1 : 1, l1 = 30 + rnd() * 60, l2 = 30 + rnd() * 80, sx = rnd() < 0.5 ? -1 : 1;
      const br: Pt[] = [[bx, by], [bx + sx * l1 * 0.6, by + dir * l1], [bx + sx * (l1 * 0.6 + l2), by + dir * l1]];
      g.strokeStyle = rgba(m.patternColor, 0.9); g.lineWidth = 3; line(g, br); b.strokeStyle = gray(0.2); b.lineWidth = 6; line(b, br); glowLine(e, br, 2.6);
      const [nx, ny] = br[2]; for (const cg of [g, e]) { cg.fillStyle = cg === g ? hex(m.patternColor) : '#ffffff'; cg.beginPath(); cg.arc(nx, ny, 7, 0, TAU); cg.fill(); }
    }
  }
  grain(g, 0.12); grain(b, 0.14); grain(r, 0.2); scratches(p, 24, 0.18);
};

// ═════════════════════════ 울트라 ═════════════════════════
// 11) 솔라 프라임 — 백색 세라믹 + 황금 인레이(선버스트/필리그리) + 용암 균열(발광 마스크)
const paintSolar: Painter = (p) => {
  const { map: g, rough: r, bump: b, emis: e, m, rnd } = p; p.glow = true;
  const gold = m.accentColor, goldHi = mix(gold, 0xffffff, 0.55), goldLo = mix(gold, 0x3a2400, 0.5);
  fill(g, hex(m.baseColor)); fill(r, gray(0.55)); fill(b, gray(0.5));
  for (let i = 0; i < 36; i++) { // 세라믹 음영
    const x = rnd() * N, y = rnd() * N, rad = 90 + rnd() * 180;
    wrap((ox, oy) => { const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad); gr.addColorStop(0, rgba(rnd() < 0.5 ? 0xffffff : 0xcfc6ae, 0.3)); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2); });
  }
  panels(p, 4, 0.55);
  const goldStroke = (pts: Pt[], w: number, ox = 0, oy = 0): void => {
    g.lineJoin = g.lineCap = 'round'; g.strokeStyle = hex(goldLo); g.lineWidth = w + 3; line(g, pts, ox, oy); g.strokeStyle = hex(gold); g.lineWidth = w; line(g, pts, ox, oy); g.strokeStyle = rgba(goldHi, 0.9); g.lineWidth = Math.max(1, w * 0.3); line(g, pts, ox, oy - w * 0.2);
    b.strokeStyle = gray(0.8); b.lineWidth = w + 2; line(b, pts, ox, oy); r.strokeStyle = gray(0.12); r.lineWidth = w + 2; line(r, pts, ox, oy);
  };
  for (const y of [N * 0.25, N * 0.75]) { // 필리그리 밴드 + 다이아 장식
    goldStroke([[0, y - 16], [N, y - 16]], 5); goldStroke([[0, y + 16], [N, y + 16]], 5);
    for (let x = 32; x < N; x += 64) { goldStroke([[x - 20, y], [x, y - 11], [x + 20, y], [x, y + 11], [x - 20, y]], 3); e.fillStyle = 'rgba(255,255,255,0.75)'; e.beginPath(); e.arc(x, y, 4, 0, TAU); e.fill(); g.fillStyle = hex(m.patternColor); g.beginPath(); g.arc(x, y, 4, 0, TAU); g.fill(); }
  }
  const suns: Pt[] = [[N * 0.22, N * 0.5], [N * 0.72, 0], [N * 0.6, N * 0.52]];
  for (const [sx, sy] of suns) wrap((ox, oy) => { // 선버스트
    const x = sx + ox, y = sy + oy, R0 = 46;
    for (let k = 0; k < 24; k++) {
      const a = (k / 24) * TAU, long = k % 2 === 0, r1 = R0 + 14, r2 = R0 + (long ? 96 : 58), ray: Pt[] = [[x + Math.cos(a) * r1, y + Math.sin(a) * r1], [x + Math.cos(a) * r2, y + Math.sin(a) * r2]];
      goldStroke(ray, long ? 5 : 3); if (long) glowLine(e, ray, 2.4);
    }
    const ring = (rad: number, w: number): void => { const pts: Pt[] = []; for (let k = 0; k <= 48; k++) pts.push([x + Math.cos((k / 48) * TAU) * rad, y + Math.sin((k / 48) * TAU) * rad]); goldStroke(pts, w); };
    ring(R0, 7); ring(R0 * 0.55, 4);
    const core = g.createRadialGradient(x, y, 0, x, y, R0 * 0.5); core.addColorStop(0, '#ffffff'); core.addColorStop(1, hex(m.patternColor)); g.fillStyle = core; g.beginPath(); g.arc(x, y, R0 * 0.42, 0, TAU); g.fill();
    const ec = e.createRadialGradient(x, y, 0, x, y, R0); ec.addColorStop(0, 'rgba(255,255,255,1)'); ec.addColorStop(0.45, 'rgba(255,255,255,0.9)'); ec.addColorStop(1, 'rgba(255,255,255,0)'); e.fillStyle = ec; e.beginPath(); e.arc(x, y, R0, 0, TAU); e.fill();
  });
  for (const pts of crackLines(rnd, 7, [9, 16], [24, 48], 0.2)) wrap((ox, oy) => { // 용암 균열
    g.lineJoin = g.lineCap = 'round'; g.strokeStyle = 'rgba(96,44,0,0.9)'; g.lineWidth = 11; line(g, pts, ox, oy); g.strokeStyle = hex(mix(gold, 0xff6a00, 0.5)); g.lineWidth = 5; line(g, pts, ox, oy); g.strokeStyle = hex(m.patternColor); g.lineWidth = 2; line(g, pts, ox, oy);
    b.lineJoin = 'round'; b.strokeStyle = gray(0.12); b.lineWidth = 11; line(b, pts, ox, oy); r.strokeStyle = gray(0.8); r.lineWidth = 9; line(r, pts, ox, oy);
    glowLine(e, pts, 4.5, 0xffffff, ox, oy);
  });
  grain(g, 0.08); grain(b, 0.12); grain(r, 0.2);
};

// 12) 어비스 코어 — 흑요석 + 성운 + 크림슨 균열(발광 마스크) + 별
const paintAbyss: Painter = (p) => {
  const { map: g, rough: r, bump: b, emis: e, m, rnd } = p; p.glow = true;
  fill(g, hex(m.baseColor)); fill(r, gray(0.5)); fill(b, gray(0.5));
  for (let i = 0; i < 70; i++) { // 성운
    const x = rnd() * N, y = rnd() * N, rad = 70 + rnd() * 200, col = rnd() < 0.72 ? m.accentColor : m.patternColor, a = col === m.accentColor ? 0.42 : 0.14;
    wrap((ox, oy) => { const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, rad); gr.addColorStop(0, rgba(col, a)); gr.addColorStop(1, rgba(col, 0)); g.fillStyle = gr; g.fillRect(x + ox - rad, y + oy - rad, rad * 2, rad * 2); });
  }
  for (let i = 0; i < 26; i++) { // 흑요석 파단면(직선 능선)
    const x = rnd() * N, y = rnd() * N, a = rnd() * TAU, len = 200 + rnd() * 500, pts: Pt[] = [[x, y], [x + Math.cos(a) * len, y + Math.sin(a) * len]];
    wrap((ox, oy) => { g.strokeStyle = 'rgba(200,170,255,0.09)'; g.lineWidth = 2; line(g, pts, ox, oy); b.strokeStyle = gray(0.66); b.lineWidth = 5; line(b, pts, ox, oy); b.strokeStyle = gray(0.38); b.lineWidth = 3; line(b, pts, ox + 4, oy + 4); r.strokeStyle = gray(0.25); r.lineWidth = 4; line(r, pts, ox, oy); });
  }
  for (let i = 0; i < 700; i++) { // 별
    const x = rnd() * N, y = rnd() * N, s = 0.8 + rnd() * rnd() * 3.2, a = 0.3 + rnd() * 0.7;
    g.fillStyle = rgba(rnd() < 0.6 ? 0xffffff : mix(m.accentColor, 0xffffff, 0.6), a); g.beginPath(); g.arc(x, y, s, 0, TAU); g.fill();
    if (i % 5 === 0) { e.fillStyle = `rgba(255,255,255,${a * 0.8})`; e.beginPath(); e.arc(x, y, s * 1.2, 0, TAU); e.fill(); }
  }
  const cracks = crackLines(rnd, 7, [9, 17], [24, 50], 0.2);
  for (const pts of cracks) wrap((ox, oy) => { // 크림슨 균열
    g.lineJoin = g.lineCap = 'round'; g.strokeStyle = 'rgba(0,0,0,0.9)'; g.lineWidth = 13; line(g, pts, ox, oy); g.strokeStyle = hex(m.patternColor); g.lineWidth = 5; line(g, pts, ox, oy); g.strokeStyle = 'rgba(255,220,230,0.85)'; g.lineWidth = 1.5; line(g, pts, ox, oy);
    b.lineJoin = 'round'; b.strokeStyle = gray(0.08); b.lineWidth = 13; line(b, pts, ox, oy); r.strokeStyle = gray(0.85); r.lineWidth = 10; line(r, pts, ox, oy);
    glowLine(e, pts, 5, 0xffffff, ox, oy);
  });
  for (let i = 0; i < Math.min(cracks.length, 12); i += 4) { // 코어의 눈(균열 기점)
    const [x, y] = cracks[i][0];
    wrap((ox, oy) => {
      for (const [rad, w] of [[34, 4], [20, 3]] as Pt[]) { g.strokeStyle = hex(m.patternColor); g.lineWidth = w; g.beginPath(); g.arc(x + ox, y + oy, rad, 0, TAU); g.stroke(); e.strokeStyle = 'rgba(255,255,255,0.9)'; e.lineWidth = w; e.beginPath(); e.arc(x + ox, y + oy, rad, 0, TAU); e.stroke(); b.strokeStyle = gray(0.8); b.lineWidth = w + 2; b.beginPath(); b.arc(x + ox, y + oy, rad, 0, TAU); b.stroke(); }
      const ec = e.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, 14); ec.addColorStop(0, '#ffffff'); ec.addColorStop(1, 'rgba(255,255,255,0)'); e.fillStyle = ec; e.beginPath(); e.arc(x + ox, y + oy, 14, 0, TAU); e.fill();
      g.fillStyle = '#ffe6ee'; g.beginPath(); g.arc(x + ox, y + oy, 6, 0, TAU); g.fill();
    });
  }
  grain(g, 0.1); grain(b, 0.14); grain(r, 0.22);
};

const PAINTERS: Record<Exclude<SkinStyle, 'solid'>, Painter> = {
  matte: paintMatte, digicamo: paintDigicamo, steel: paintSteel, anodized: paintAnodized, hex: paintHex, racing: paintRacing,
  circuit: paintCircuit, glitch: paintGlitch, gloss: paintGloss, energy: paintEnergy, solar: paintSolar, abyss: paintAbyss,
};
/** 스타일별 PBR 보정 (스킨 정의의 clearcoat 값이 있으면 그쪽이 우선) */
const PBR: Record<Exclude<SkinStyle, 'solid'>, { bumpScale: number; clearcoat: number; clearcoatRoughness: number }> = {
  matte: { bumpScale: 1.4, clearcoat: 0, clearcoatRoughness: 0.6 }, digicamo: { bumpScale: 1.0, clearcoat: 0, clearcoatRoughness: 0.6 }, steel: { bumpScale: 0.8, clearcoat: 0.1, clearcoatRoughness: 0.3 },
  anodized: { bumpScale: 1.2, clearcoat: 0.35, clearcoatRoughness: 0.2 }, hex: { bumpScale: 2.4, clearcoat: 0.25, clearcoatRoughness: 0.3 }, racing: { bumpScale: 0.7, clearcoat: 0.7, clearcoatRoughness: 0.12 },
  circuit: { bumpScale: 1.6, clearcoat: 0.9, clearcoatRoughness: 0.08 }, glitch: { bumpScale: 1.0, clearcoat: 1, clearcoatRoughness: 0.06 }, gloss: { bumpScale: 0.5, clearcoat: 1, clearcoatRoughness: 0.03 },
  energy: { bumpScale: 2.4, clearcoat: 0.8, clearcoatRoughness: 0.1 }, solar: { bumpScale: 2.0, clearcoat: 1, clearcoatRoughness: 0.05 }, abyss: { bumpScale: 2.2, clearcoat: 1, clearcoatRoughness: 0.06 },
};

function paint(m: SkinMaterial, size: number): Paint | null {
  if (m.style === 'solid') return null;
  const p: Paint = { map: mkLayer(size), rough: mkLayer(size), bump: mkLayer(size), emis: mkLayer(size), m, rnd: rngFor(m.baseColor ^ (m.patternColor << 1) ^ (m.accentColor >>> 1) ^ (m.style.length * 7919)), glow: false };
  fill(p.emis, '#000');
  PAINTERS[m.style](p);
  return p;
}
const toTex = (g: G, srgb: boolean): THREE.CanvasTexture => {
  const t = new THREE.CanvasTexture(g.canvas); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8; t.repeat.set(2, 2);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};
const matKey = (m: SkinMaterial): string => [m.style, m.baseColor, m.accentColor, m.patternColor].join('|');

const cache = new Map<string, SkinTextures | null>();
/** 스킨 재질 키(스타일+색) 기준 캐시 — 같은 룩은 한 번만 생성 (1024² × 4맵) */
export function getSkinTextures(m: SkinMaterial): SkinTextures | null {
  const key = matKey(m), hit = cache.get(key); if (hit !== undefined) return hit;
  const p = paint(m, SKIN_TEX_SIZE); let t: SkinTextures | null = null;
  if (p && m.style !== 'solid') {
    const pbr = PBR[m.style];
    t = { style: m.style, map: toTex(p.map, true), roughnessMap: toTex(p.rough, false), bumpMap: toTex(p.bump, false), emissiveMap: p.glow ? toTex(p.emis, true) : null,
      bumpScale: pbr.bumpScale, clearcoat: m.clearcoat ?? pbr.clearcoat, clearcoatRoughness: m.clearcoatRoughness ?? pbr.clearcoatRoughness };
  }
  cache.set(key, t); return t;
}

/** 로비 상점/보관함 카드용 data URL (256px 저해상도로 따로 그려 패턴 + 발광 합성, 재질 키별 캐시) */
const swatchCache = new Map<string, string>();
export function skinSwatchUrl(s: Pick<SkinDef, 'material' | 'emissive'>): string {
  const key = matKey(s.material) + '|' + s.emissive.color, hit = swatchCache.get(key); if (hit !== undefined) return hit;
  const p = paint(s.material, 256); let url = '';
  if (p) {
    const c = document.createElement('canvas'); c.width = 240; c.height = 120; const g = c.getContext('2d')!;
    g.drawImage(p.map.canvas, 0, 0, 256, 128, 0, 0, 240, 120);
    if (p.glow && s.emissive.mode !== 'none') {
      const e = p.emis; e.save(); e.globalCompositeOperation = 'multiply'; e.fillStyle = hex(s.emissive.color); e.fillRect(0, 0, N, N); e.restore(); // 발광색 입히기
      g.globalCompositeOperation = 'lighter'; g.globalAlpha = Math.min(1, 0.45 + s.emissive.intensity * 0.25); g.drawImage(e.canvas, 0, 0, 256, 128, 0, 0, 240, 120);
    }
    url = c.toDataURL('image/jpeg', 0.86);
  }
  swatchCache.set(key, url); return url;
}
