// =====================================================================
// 프로시저럴 스킨 텍스처 생성기 — 외부 이미지 없이 오프스크린 Canvas(512x512)로
// map / emissiveMap / roughnessMap 을 즉석 생성. 스킨(재질 키)별 캐시로 중복 생성 방지.
// 스타일 5종: carbon / camo / metal(브러시드 그라데이션) / hex / cyber(신화 전용)
// =====================================================================
import * as THREE from 'three';
import type { Rarity, SkinDef, SkinMaterial, SkinPattern } from '../config/skins';

export type SkinStyle = 'carbon' | 'camo' | 'metal' | 'hex' | 'cyber';
export interface SkinTextures {
  style: SkinStyle; map: THREE.CanvasTexture; roughnessMap: THREE.CanvasTexture; emissiveMap: THREE.CanvasTexture | null;
  /** 스타일별 PBR 보정 */
  clearcoat: number; clearcoatRoughness: number; roughnessScale: number; metalnessOverride?: number;
}

const S = 512;
const hex = (n: number): string => '#' + (n & 0xffffff).toString(16).padStart(6, '0');
const rgb = (n: number): [number, number, number] => [(n >> 16) & 255, (n >> 8) & 255, n & 255];
const mix = (a: number, b: number, t: number): number => {
  const [ar, ag, ab] = rgb(a), [br, bg, bb] = rgb(b);
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
};
const rngFor = (seed: number) => { let s = (seed >>> 0) || 1; return (): number => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); };
const mkCanvas = (): [HTMLCanvasElement, CanvasRenderingContext2D] => {
  const c = document.createElement('canvas'); c.width = c.height = S; return [c, c.getContext('2d')!];
};
const toTex = (c: HTMLCanvasElement, srgb: boolean): THREE.CanvasTexture => {
  const t = new THREE.CanvasTexture(c); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
};
/** 타일 이음새가 없도록 (dx,dy) 주변 9곳에 반복 그리기 */
const wrap = (fn: (ox: number, oy: number) => void): void => { for (let ox = -S; ox <= S; ox += S) for (let oy = -S; oy <= S; oy += S) fn(ox, oy); };
const gray = (v: number): string => { const k = Math.round(Math.max(0, Math.min(1, v)) * 255); return `rgb(${k},${k},${k})`; };

/** 등급/패턴 → 스타일 매핑. 사이버 회로는 신화 등급 전용 */
export function styleFor(pattern: SkinPattern, rarity: Rarity | undefined): SkinStyle | null {
  if (rarity === 'mythic') return 'cyber';
  switch (pattern) {
    case 'solid': return null;
    case 'carbon': case 'stars': return 'carbon';
    case 'stripes': case 'cracks': return 'camo';
    case 'gradient': case 'wave': case 'petals': return 'metal';
    case 'hex': case 'circuit': return 'hex';
  }
}

type Painter = (m: SkinMaterial, rnd: () => number) => { map: HTMLCanvasElement; rough: HTMLCanvasElement; emis: HTMLCanvasElement | null };

// 1) 카본 파이버 — 2x2 트윌 직조, 반광택
const paintCarbon: Painter = (m, rnd) => {
  const [c, g] = mkCanvas(), [rc, rg] = mkCanvas(), T = 16, dark = m.baseColor, light = mix(m.baseColor, m.patternColor, 0.9);
  g.fillStyle = hex(dark); g.fillRect(0, 0, S, S); rg.fillStyle = gray(0.7); rg.fillRect(0, 0, S, S);
  for (let y = 0; y < S; y += T) for (let x = 0; x < S; x += T) {
    const horiz = ((x / T) + (y / T)) % 2 === 0;
    const gr = horiz ? g.createLinearGradient(x, y, x, y + T) : g.createLinearGradient(x, y, x + T, y);
    gr.addColorStop(0, hex(mix(dark, light, 0.25))); gr.addColorStop(0.5, hex(light)); gr.addColorStop(1, hex(mix(dark, light, 0.1)));
    g.fillStyle = gr; g.fillRect(x + 1, y + 1, T - 2, T - 2);
    g.fillStyle = 'rgba(0,0,0,0.35)'; // 섬유 결
    for (let k = 3; k < T; k += 4) horiz ? g.fillRect(x + 1, y + k, T - 2, 1) : g.fillRect(x + k, y + 1, 1, T - 2);
    rg.fillStyle = gray(horiz ? 0.38 : 0.5 + rnd() * 0.05); rg.fillRect(x + 1, y + 1, T - 2, T - 2);
  }
  return { map: c, rough: rc, emis: null };
};

// 2) 전술 카모 — 다층 얼룩, 무광
const paintCamo: Painter = (m, rnd) => {
  const [c, g] = mkCanvas(), [rc, rg] = mkCanvas();
  const layers = [m.baseColor, mix(m.baseColor, m.accentColor, 0.7), m.accentColor, m.patternColor];
  g.fillStyle = hex(layers[0]); g.fillRect(0, 0, S, S); rg.fillStyle = gray(0.92); rg.fillRect(0, 0, S, S);
  layers.slice(1).forEach((col, li) => {
    g.fillStyle = hex(col); rg.fillStyle = gray(0.85 + li * 0.04);
    for (let i = 0; i < 26 - li * 4; i++) {
      const cx = rnd() * S, cy = rnd() * S, r = 26 + rnd() * 52 - li * 6, pts = 9, ph = rnd() * 6.28, sq = 0.5 + rnd() * 0.6;
      wrap((ox, oy) => {
        g.beginPath(); rg.beginPath();
        for (let k = 0; k <= pts; k++) {
          const a = (k / pts) * 6.28, rr = r * (0.7 + 0.3 * Math.sin(a * 3 + ph) + 0.15 * Math.sin(a * 5 + ph * 2));
          const px = cx + ox + Math.cos(a) * rr, py = cy + oy + Math.sin(a) * rr * sq;
          k ? (g.lineTo(px, py), rg.lineTo(px, py)) : (g.moveTo(px, py), rg.moveTo(px, py));
        }
        g.closePath(); rg.closePath(); g.fill(); rg.fill();
      });
    }
  });
  const img = g.getImageData(0, 0, S, S), d = img.data; // 미세 그레인
  for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 18; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  g.putImageData(img, 0, 0);
  return { map: c, rough: rc, emis: null };
};

// 3) 브러시드 메탈릭 그라데이션 — 헤어라인 + 투톤
const paintMetal: Painter = (m, rnd) => {
  const [c, g] = mkCanvas(), [rc, rg] = mkCanvas();
  const gr = g.createLinearGradient(0, 0, S, S * 0.6);
  gr.addColorStop(0, hex(m.baseColor)); gr.addColorStop(0.5, hex(mix(m.baseColor, m.accentColor, 0.6))); gr.addColorStop(1, hex(mix(m.accentColor, m.patternColor, 0.5)));
  g.fillStyle = gr; g.fillRect(0, 0, S, S); rg.fillStyle = gray(0.5); rg.fillRect(0, 0, S, S);
  for (let i = 0; i < 1400; i++) { // 가로 헤어라인 (좌우 이음새 없음: 폭 전체)
    const y = rnd() * S, light = rnd() < 0.5, a = 0.03 + rnd() * 0.07;
    g.fillStyle = light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.4})`; g.fillRect(0, y, S, 1);
    rg.fillStyle = gray(0.35 + rnd() * 0.4); rg.globalAlpha = 0.5; rg.fillRect(0, y, S, 1); rg.globalAlpha = 1;
  }
  const sheen = g.createLinearGradient(0, 0, S, 0); // 광택 띠
  sheen.addColorStop(0, 'rgba(255,255,255,0)'); sheen.addColorStop(0.5, 'rgba(255,255,255,0.14)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = sheen; g.fillRect(0, 0, S, S);
  return { map: c, rough: rc, emis: null };
};

const hexPath = (g: CanvasRenderingContext2D, cx: number, cy: number, r: number): void => {
  g.beginPath(); for (let k = 0; k < 6; k++) { const a = (Math.PI / 3) * k + Math.PI / 6; g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); } g.closePath();
};
// 4) 기하학 육각 아머 — 벌집 타일 + 엣지 하이라이트(약한 발광)
const paintHex: Painter = (m, rnd) => {
  const [c, g] = mkCanvas(), [rc, rg] = mkCanvas(), [ec, eg] = mkCanvas();
  g.fillStyle = hex(m.accentColor); g.fillRect(0, 0, S, S); rg.fillStyle = gray(0.6); rg.fillRect(0, 0, S, S); eg.fillStyle = '#000'; eg.fillRect(0, 0, S, S);
  const R = 32, w = Math.sqrt(3) * R, hStep = R * 1.5, cols = Math.round(S / w), rows = Math.round(S / (hStep * 2)) * 2; // S 에 정확히 맞춰 타일링
  const sx = S / cols, sy = S / rows;
  for (let r = 0; r < rows; r++) for (let q = 0; q < cols; q++) {
    const cx = q * sx + (r % 2 ? sx / 2 : 0) + sx / 2, cy = r * sy + sy / 2, rr = sx / Math.sqrt(3) * 0.93, tone = rnd();
    wrap((ox, oy) => {
      if (Math.abs(ox) + Math.abs(oy) > S) return;
      hexPath(g, cx + ox, cy + oy, rr);
      const gr = g.createLinearGradient(cx + ox, cy + oy - rr, cx + ox, cy + oy + rr);
      gr.addColorStop(0, hex(mix(m.baseColor, 0xffffff, 0.12 + tone * 0.08))); gr.addColorStop(1, hex(mix(m.baseColor, 0x000000, 0.25)));
      g.fillStyle = gr; g.fill();
      g.lineWidth = 3; g.strokeStyle = hex(m.patternColor); g.globalAlpha = 0.9; g.stroke(); g.globalAlpha = 1; // 엣지 하이라이트
      hexPath(rg, cx + ox, cy + oy, rr); rg.fillStyle = gray(0.3 + tone * 0.15); rg.fill();
      hexPath(eg, cx + ox, cy + oy, rr); eg.lineWidth = 3; eg.strokeStyle = hex(m.patternColor); eg.stroke();
    });
  }
  return { map: c, rough: rc, emis: ec };
};

// 5) 사이버 회로 — 90°/45° 트레이스 + 노드, emissiveMap 으로 발광
const paintCyber: Painter = (m, rnd) => {
  const [c, g] = mkCanvas(), [rc, rg] = mkCanvas(), [ec, eg] = mkCanvas();
  const bg = g.createLinearGradient(0, 0, S, S); bg.addColorStop(0, hex(m.baseColor)); bg.addColorStop(1, hex(mix(m.baseColor, m.accentColor, 0.35)));
  g.fillStyle = bg; g.fillRect(0, 0, S, S); rg.fillStyle = gray(0.3); rg.fillRect(0, 0, S, S); eg.fillStyle = '#000'; eg.fillRect(0, 0, S, S);
  g.strokeStyle = 'rgba(255,255,255,0.04)'; g.lineWidth = 1; for (let i = 0; i < S; i += 32) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.moveTo(0, i); g.lineTo(S, i); g.stroke(); }
  const GRID = 16, line = m.patternColor, glow = m.accentColor;
  for (let i = 0; i < 46; i++) {
    let x = Math.floor(rnd() * (S / GRID)) * GRID, y = Math.floor(rnd() * (S / GRID)) * GRID, dir = Math.floor(rnd() * 4);
    const pts: [number, number][] = [[x, y]], dx = [1, 0, -1, 0, 1, 1, -1, -1], dy = [0, 1, 0, -1, 1, -1, 1, -1];
    for (let k = 0; k < 5; k++) {
      const len = (2 + Math.floor(rnd() * 5)) * GRID; x += dx[dir] * len; y += dy[dir] * len; pts.push([x, y]);
      dir = rnd() < 0.5 ? (dir + 1) % 4 : (dir + 3) % 4; if (rnd() < 0.25) dir = 4 + Math.floor(rnd() * 4);
    }
    const lw = rnd() < 0.3 ? 4 : 2, bright = rnd() < 0.35 ? glow : line;
    wrap((ox, oy) => {
      for (const [cg, col, w2] of [[g, line, lw], [eg, bright, lw + 1]] as [CanvasRenderingContext2D, number, number][]) {
        cg.strokeStyle = hex(col); cg.lineWidth = w2; cg.lineJoin = 'round'; cg.beginPath();
        pts.forEach(([px, py], k) => (k ? cg.lineTo(px + ox, py + oy) : cg.moveTo(px + ox, py + oy))); cg.stroke();
      }
      const [lx, ly] = pts[pts.length - 1], [fx, fy] = pts[0];
      for (const [px, py, big] of [[lx, ly, true], [fx, fy, false]] as [number, number, boolean][]) { // 노드
        for (const cg of [g, eg]) { cg.fillStyle = hex(bright); cg.beginPath(); cg.arc(px + ox, py + oy, big ? 7 : 4, 0, 6.28); cg.fill(); }
        g.fillStyle = hex(m.baseColor); g.beginPath(); g.arc(px + ox, py + oy, big ? 3 : 1.5, 0, 6.28); g.fill();
        rg.fillStyle = gray(0.12); rg.beginPath(); rg.arc(px + ox, py + oy, 8, 0, 6.28); rg.fill();
      }
    });
  }
  return { map: c, rough: rc, emis: ec };
};

const PAINTERS: Record<SkinStyle, Painter> = { carbon: paintCarbon, camo: paintCamo, metal: paintMetal, hex: paintHex, cyber: paintCyber };
const PBR: Record<SkinStyle, Pick<SkinTextures, 'clearcoat' | 'clearcoatRoughness' | 'roughnessScale' | 'metalnessOverride'>> = {
  carbon: { clearcoat: 0.55, clearcoatRoughness: 0.3, roughnessScale: 1 },       // 반광택
  camo: { clearcoat: 0, clearcoatRoughness: 0.6, roughnessScale: 1 },            // 무광
  metal: { clearcoat: 0.3, clearcoatRoughness: 0.2, roughnessScale: 0.9 },       // 높은 금속성은 스킨 값 사용
  hex: { clearcoat: 0.2, clearcoatRoughness: 0.35, roughnessScale: 1 },
  cyber: { clearcoat: 0.8, clearcoatRoughness: 0.1, roughnessScale: 0.9 },
};

const cache = new Map<string, SkinTextures | null>();
/** 스킨 재질 키(스타일+색+패턴) 기준 캐시 — 같은 룩은 한 번만 생성 */
export function getSkinTextures(m: SkinMaterial, rarity: Rarity | undefined): SkinTextures | null {
  const style = styleFor(m.pattern, rarity); if (!style) return null;
  const key = [style, m.baseColor, m.accentColor, m.patternColor].join('|');
  if (cache.has(key)) return cache.get(key)!;
  const p = PAINTERS[style](m, rngFor(m.baseColor ^ (m.patternColor << 1) ^ m.accentColor));
  const t: SkinTextures = { style, map: toTex(p.map, true), roughnessMap: toTex(p.rough, false), emissiveMap: p.emis ? toTex(p.emis, true) : null, ...PBR[style] };
  for (const tx of [t.map, t.roughnessMap, t.emissiveMap]) tx?.repeat.set(2, 1);
  cache.set(key, t);
  return t;
}

/** 로비 상점/보관함 미리보기용 data URL (패턴 + 발광 합성, 스킨별 캐시) */
const swatchCache = new Map<string, string>();
export function skinSwatchUrl(s: Pick<SkinDef, 'id' | 'material' | 'rarity' | 'emissive'>): string {
  const hit = swatchCache.get(s.id); if (hit) return hit;
  const tex = getSkinTextures(s.material, s.rarity); let url = '';
  if (tex) {
    const [c, g] = mkCanvas(); c.width = 160; c.height = 80;
    g.drawImage(tex.map.image as HTMLCanvasElement, 0, 0, 160, 80);
    if (tex.emissiveMap && s.emissive.mode !== 'none') { g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.9; g.drawImage(tex.emissiveMap.image as HTMLCanvasElement, 0, 0, 160, 80); }
    url = c.toDataURL('image/png');
  }
  swatchCache.set(s.id, url); return url;
}
