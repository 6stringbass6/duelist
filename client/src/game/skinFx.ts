// =====================================================================
// 스킨 재질 + 등급 전용 비주얼 효과.
//  - skinMaterials(): 스킨 → MeshPhysicalMaterial(본체) / 포인트 재질. 스킨 ID 별 캐시(텍스처는 재질 키별 캐시) → 프레임 중 생성 없음
//  - 발광 애니메이션: flow(신호 펄스) / energy(표면을 흐르는 에너지) / plasma(용암·성운 유동) 는
//    emissive 프래그먼트만 교체한 셰이더로 처리(텍스처 재업로드 없음, 공용 시간 유니폼 1개)
//  - attachSkinFx(): 익스클루시브 = 홀로그램 윙, 울트라 = 에너지 코어 링 + 전용 컬러 총구 섬광
//  - fireWeaponFx(): 사격 시 울트라 발광 폭증 + 총구 섬광
// 지오메트리/재질/텍스처는 전부 모듈 단위로 공유·캐시한다.
// =====================================================================
import * as THREE from 'three';
import { DEFAULT_SKIN, getSkin, skinAttachment, type SkinDef } from '../config/skins';
import { getSkinTextures } from './skinTextures';

export interface SkinMats { base: THREE.MeshStandardMaterial; accent: THREE.MeshStandardMaterial }

// ───────────────────────────── 재질 ─────────────────────────────
const TIME = { value: 0 };
interface Anim { mat: THREE.MeshStandardMaterial; mode: SkinDef['emissive']['mode']; speed: number; base: number; key: string; boost: number }
const matCache = new Map<string, SkinMats>();
const animated: Anim[] = [];
/** 스킨 키 → 마지막 사격 시각(초). 발광 폭증 감쇠 계산용 */
const firedAt = new Map<string, number>();

const SHADER_MODE = { flow: 3, energy: 1, plasma: 2 } as const;
const GLSL_PARS = /* glsl */ `
uniform float uSkinTime; uniform float uSkinSpeed; uniform float uSkinAmbient; uniform vec3 uSkinColA; uniform vec3 uSkinColB;
float sHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sNoise(vec2 p){ vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), f.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), f.x), f.y); }
float sFbm(vec2 p){ float a = 0.5, v = 0.0; for (int i = 0; i < 4; i++) { v += a * sNoise(p); p = p * 2.03 + vec2(17.0, 9.0); a *= 0.5; } return v; }
`;
const GLSL_EMISSIVE = /* glsl */ `
#ifdef USE_EMISSIVEMAP
  vec2 sUv = vEmissiveMapUv;
  vec3 sMask = texture2D( emissiveMap, sUv ).rgb;
  float sM = max( sMask.r, max( sMask.g, sMask.b ) );
  float sI = dot( totalEmissiveRadiance, vec3( 1.0 ) ) / max( 1e-4, dot( uSkinColA, vec3( 1.0 ) ) ); // = emissiveIntensity
  float sT = uSkinTime * uSkinSpeed;
  #if SKIN_MODE == 1
    // 에너지 플로우: 총기 길이 방향(u)으로 밴드가 흘러가며 도관 마스크를 밝힌다
    float sW = sFbm( sUv * 3.0 + vec2( 0.0, sT * 0.3 ) );
    float sBand = pow( 0.5 + 0.5 * sin( ( sUv.x * 1.5 - sT + sW * 0.9 ) * 6.2832 ), 3.0 );
    float sSpark = pow( 0.5 + 0.5 * sin( ( sUv.x * 0.5 - sT * 1.9 + sUv.y * 1.3 ) * 6.2832 ), 14.0 );
    vec3 sCol = mix( uSkinColA, uSkinColB, clamp( sBand * 0.8 + sSpark, 0.0, 1.0 ) );
    totalEmissiveRadiance = sI * ( sCol * sM * ( 0.22 + 1.5 * sBand + 2.2 * sSpark ) + uSkinColA * uSkinAmbient * sBand );
  #elif SKIN_MODE == 2
    // 플라즈마: 도메인 워핑 fbm 으로 용암/성운처럼 일렁이는 열 분포
    vec2 sQ = sUv * 2.6;
    float sN1 = sFbm( sQ + vec2( sT * 0.35, -sT * 0.22 ) );
    float sN2 = sFbm( sQ * 1.7 + sN1 * 1.6 - vec2( sT * 0.28, sT * 0.12 ) );
    float sHeat = smoothstep( 0.28, 0.72, sN2 );
    vec3 sCol = mix( uSkinColA, uSkinColB, sHeat );
    totalEmissiveRadiance = sI * ( sCol * sM * ( 0.45 + 1.9 * sHeat ) + mix( uSkinColB, uSkinColA, sN1 ) * uSkinAmbient * pow( sN2, 2.5 ) * 1.6 );
  #else
    // 신호 펄스: 회로 트레이스 색은 유지하고 밝기 파동만 지나간다
    float sBand = pow( 0.5 + 0.5 * sin( ( sUv.x * 1.0 + sUv.y * 0.5 - sT ) * 6.2832 ), 4.0 );
    totalEmissiveRadiance *= sMask * ( 0.4 + 1.7 * sBand );
  #endif
#endif
`;
function installShader(mat: THREE.MeshStandardMaterial, mode: 1 | 2 | 3, colA: number, colB: number, speed: number, ambient: number): void {
  const uniforms = { uSkinTime: TIME, uSkinSpeed: { value: speed }, uSkinAmbient: { value: ambient }, uSkinColA: { value: new THREE.Color(colA) }, uSkinColB: { value: new THREE.Color(colB) } };
  mat.defines = { ...(mat.defines ?? {}), SKIN_MODE: mode };
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + GLSL_PARS).replace('#include <emissivemap_fragment>', GLSL_EMISSIVE);
  };
  mat.customProgramCacheKey = () => 'skinfx' + mode;
}

/** 스킨 → 무기 재질(본체/포인트). 스킨별 캐시 공유 (구버전 스킨 ID 도 같은 캐시 항목으로 수렴) */
export function skinMaterials(skinId: string | null | undefined): SkinMats {
  const def = getSkin(skinId), key = def?.id ?? 'default';
  let mats = matCache.get(key);
  if (mats) return mats;
  const s: Pick<SkinDef, 'material' | 'emissive'> = def ?? DEFAULT_SKIN, m = s.material, e = s.emissive;
  const tex = getSkinTextures(m), glow = e.mode !== 'none', emMap = glow ? tex?.emissiveMap ?? null : null;
  const baseIntensity = !glow ? 0 : emMap ? e.intensity : e.intensity * 0.12;
  const base = new THREE.MeshPhysicalMaterial({
    color: tex ? 0xffffff : m.baseColor, map: tex?.map ?? null, roughnessMap: tex?.roughnessMap ?? null, bumpMap: tex?.bumpMap ?? null, bumpScale: tex?.bumpScale ?? 1,
    metalness: m.metalness, roughness: tex ? Math.min(1, m.roughness * 2) : m.roughness, // roughnessMap 평균이 ~0.5 → ×2 로 스킨 지정값에 맞춤
    emissive: e.color, emissiveMap: emMap, emissiveIntensity: baseIntensity,
    clearcoat: tex?.clearcoat ?? m.clearcoat ?? 0, clearcoatRoughness: tex?.clearcoatRoughness ?? m.clearcoatRoughness ?? 0.3,
  });
  const accentGlow = e.mode === 'energy' || e.mode === 'plasma' ? e.intensity * 0.1 : e.mode === 'flow' || e.mode === 'pulse' ? e.intensity * 0.35 : glow ? e.intensity * 0.25 : 0;
  const accentEm = e.mode === 'flow' || e.mode === 'pulse' ? m.patternColor : e.color;
  const accent = new THREE.MeshStandardMaterial({ color: m.accentColor, metalness: Math.min(1, m.metalness + 0.2), roughness: tex ? Math.min(1, Math.max(0.16, (m.roughness - 0.08) * 2)) : Math.max(0.08, m.roughness - 0.08),
    roughnessMap: tex?.roughnessMap ?? null, bumpMap: tex?.bumpMap ?? null, bumpScale: (tex?.bumpScale ?? 1) * 0.7, emissive: accentEm, emissiveIntensity: accentGlow }); // 포인트 파츠도 러프니스/범프 맵 공유 → 민무늬 방지
  if (emMap && (e.mode === 'flow' || e.mode === 'energy' || e.mode === 'plasma')) installShader(base, SHADER_MODE[e.mode], e.color, e.color2 ?? e.color, e.speed ?? 0.5, e.ambient ?? 0.05);
  if (glow && e.mode !== 'static') {
    const boost = def?.tier === 'ultra' ? 2.6 : 0; // 사격 시 발광 폭증은 울트라 전용
    animated.push({ mat: base, mode: e.mode, speed: e.speed ?? 0.5, base: baseIntensity, key, boost }, { mat: accent, mode: e.mode, speed: e.speed ?? 0.5, base: accentGlow, key, boost: boost * 1.6 });
  }
  mats = { base, accent }; matCache.set(key, mats);
  return mats;
}

// ───────────────────────────── 등급 전용 부착 파츠 ─────────────────────────────
interface WeaponFx { key: string; kind: 'wings' | 'rings'; parts: THREE.Object3D[]; flash: THREE.Object3D | null; flashAt: number; flashScale: number; seed: number; lastT: number }

const texCache = new Map<string, THREE.CanvasTexture>();
function fxTexture(kind: 'holo' | 'flash'): THREE.CanvasTexture {
  let t = texCache.get(kind); if (t) return t;
  const c = document.createElement('canvas'), g = c.getContext('2d')!;
  if (kind === 'holo') { // 윙 블레이드: 길이 방향 그라데이션 + 스캔라인 + 밝은 능선
    c.width = 256; c.height = 64;
    const gr = g.createLinearGradient(0, 0, 256, 0); gr.addColorStop(0, 'rgba(255,255,255,0.95)'); gr.addColorStop(0.55, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0.05)');
    g.fillStyle = gr; g.fillRect(0, 0, 256, 64);
    g.fillStyle = 'rgba(0,0,0,0.5)'; for (let x = 0; x < 256; x += 8) g.fillRect(x, 0, 3, 64);
    g.fillStyle = 'rgba(255,255,255,0.9)'; g.fillRect(0, 28, 256, 5);
  } else { // 총구 섬광: 방사형 코어 + 십자 스파이크
    c.width = c.height = 128;
    const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.75)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    g.globalCompositeOperation = 'lighter'; g.translate(64, 64);
    for (let k = 0; k < 4; k++) { g.rotate(Math.PI / 4); const sp = g.createLinearGradient(-64, 0, 64, 0); sp.addColorStop(0, 'rgba(255,255,255,0)'); sp.addColorStop(0.5, 'rgba(255,255,255,0.9)'); sp.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = sp; g.fillRect(-64, k % 2 ? -2 : -5, 128, k % 2 ? 4 : 10); }
  }
  t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; if (kind === 'holo') t.wrapS = t.wrapT = THREE.RepeatWrapping;
  texCache.set(kind, t); return t;
}
const fxMatCache = new Map<string, THREE.MeshBasicMaterial>();
function fxMaterial(kind: 'holo' | 'flash' | 'ring', color: number, opacity: number): THREE.MeshBasicMaterial {
  const key = kind + '|' + color; let m = fxMatCache.get(key);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color, map: kind === 'ring' ? null : fxTexture(kind), transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    fxMatCache.set(key, m);
  }
  return m;
}
// 공유 지오메트리
let bladeGeo: THREE.BufferGeometry | null = null, ringGeo: THREE.BufferGeometry | null = null, ringGeo2: THREE.BufferGeometry | null = null, beadGeo: THREE.BufferGeometry | null = null, flashGeo: THREE.BufferGeometry | null = null;
function geos(): { blade: THREE.BufferGeometry; ring: THREE.BufferGeometry; ring2: THREE.BufferGeometry; bead: THREE.BufferGeometry; flash: THREE.BufferGeometry } {
  if (!bladeGeo) {
    const sh = new THREE.Shape(); sh.moveTo(0, -0.03); sh.lineTo(0.3, -0.09); sh.lineTo(1, 0.16); sh.lineTo(0.62, 0.06); sh.lineTo(0.2, 0.07); sh.lineTo(0, 0.04); sh.closePath(); // 단위 길이 1 의 후퇴익 블레이드
    bladeGeo = new THREE.ShapeGeometry(sh);
    const uv = bladeGeo.attributes.uv as THREE.BufferAttribute; for (let i = 0; i < uv.count; i++) uv.setY(i, (uv.getY(i) + 0.09) / 0.25); uv.needsUpdate = true;
    ringGeo = new THREE.TorusGeometry(1, 0.07, 6, 40, Math.PI * 1.55);   // 끊긴 링 → 회전이 눈에 보인다
    ringGeo2 = new THREE.TorusGeometry(1, 0.045, 6, 48, Math.PI * 1.85);
    beadGeo = new THREE.OctahedronGeometry(0.16, 0);
    flashGeo = new THREE.PlaneGeometry(1, 1);
  }
  return { blade: bladeGeo, ring: ringGeo!, ring2: ringGeo2!, bead: beadGeo!, flash: flashGeo! };
}

/** 무기 group 에 등급 전용 파츠를 부착. FBX 교체 시에도 유지(userData.keep)되며 총구 위치가 확정되면 다시 배치된다 */
export function attachSkinFx(g: THREE.Group, skinId: string | null | undefined, viewmodel: boolean): void {
  const def = getSkin(skinId), kind = skinAttachment(def);
  if (!def || kind === 'none') return;
  const G = geos(), root = new THREE.Group(); root.userData.keep = true;
  const colA = def.emissive.color, colB = def.emissive.color2 ?? def.material.patternColor, parts: THREE.Object3D[] = [];
  let flash: THREE.Object3D | null = null; const hooks: THREE.Mesh[] = [];
  if (kind === 'wings') {
    for (const side of [-1, 1]) for (let i = 0; i < 3; i++) {
      const pivot = new THREE.Group(), blade = new THREE.Mesh(G.blade, fxMaterial('holo', i === 1 ? colB : colA, 0.6));
      blade.rotation.y = -Math.PI / 2; // 블레이드 길이축(+X) → 후방(+Z): 총열 옆에서 뒤로 뻗는 날개
      pivot.add(blade); pivot.userData = { side, i, y0: 0 }; root.add(pivot); parts.push(pivot); hooks.push(blade);
    }
  } else {
    const a = new THREE.Mesh(G.ring, fxMaterial('ring', colA, 0.95)), b = new THREE.Mesh(G.ring2, fxMaterial('ring', colB, 0.8)), c = new THREE.Mesh(G.ring2, fxMaterial('ring', colA, 0.55));
    const bead1 = new THREE.Mesh(G.bead, fxMaterial('ring', colB, 1)), bead2 = new THREE.Mesh(G.bead, fxMaterial('ring', colA, 1));
    bead1.position.set(1, 0, 0); bead2.position.set(-1, 0, 0); b.add(bead1, bead2);
    root.add(a, b, c); parts.push(a, b, c); hooks.push(a);
    const fl = new THREE.Group(), fm = fxMaterial('flash', def.vfx.muzzleColor ?? colA, 1); // 전용 컬러 총구 섬광(교차 평면 3장)
    const p1 = new THREE.Mesh(G.flash, fm), p2 = new THREE.Mesh(G.flash, fm), p3 = new THREE.Mesh(G.flash, fm);
    p2.rotation.y = Math.PI / 2; p3.rotation.x = Math.PI / 2; p2.scale.set(1.8, 0.7, 1); p3.scale.set(0.7, 1.8, 1);
    fl.add(p1, p2, p3); fl.visible = false; root.add(fl); flash = fl;
  }
  root.traverse((o) => { o.castShadow = false; o.frustumCulled = false; if (viewmodel) (o as THREE.Mesh).renderOrder = 11; });
  g.add(root);
  const fx: WeaponFx = { key: def.id, kind, parts, flash, flashAt: -1, flashScale: 0.2, seed: Math.random() * 10, lastT: -1 };
  for (const h of hooks) h.onBeforeRender = () => animateFx(fx);
  const layout = (): void => {
    const mz = (g.userData.muzzle as THREE.Object3D).position, L = Math.max(0.16, -mz.z); // 그립 원점 ~ 총구 거리
    if (kind === 'wings') {
      const len = Math.min(0.3, Math.max(0.09, L * 0.36));
      for (const pv of parts) { const u = pv.userData as { side: number; i: number; y0: number }; u.y0 = mz.y + 0.012 + u.i * 0.006; pv.position.set(u.side * (0.034 + u.i * 0.008), u.y0, mz.z * 0.5); pv.scale.setScalar(len * (1 - u.i * 0.2)); }
    } else {
      const r = Math.min(0.05, Math.max(0.026, L * 0.07)), z = mz.z * 0.8;
      parts[0].position.set(mz.x, mz.y, z); parts[0].scale.setScalar(r);
      parts[1].position.set(mz.x, mz.y, z + r * 0.9); parts[1].scale.setScalar(r * 1.38);
      parts[2].position.set(mz.x, mz.y, mz.z * 0.55); parts[2].scale.setScalar(r * 0.82);
      flash!.position.copy(mz); flash!.position.z -= 0.02; fx.flashScale = Math.min(0.34, 0.14 + L * 0.2) * (viewmodel ? 0.7 : 1.5);
    }
  };
  layout(); g.userData.onModel = layout; g.userData.fx = fx;
}

/** 사격 순간 호출 — 울트라: 발광 폭증 + 전용 컬러 총구 섬광. 그 외 등급은 아무 일도 하지 않는다 */
export function fireWeaponFx(g: THREE.Group | null | undefined): void {
  const fx = g?.userData.fx as WeaponFx | undefined; if (!g || !fx || fx.kind !== 'rings') return;
  const now = performance.now() / 1000; firedAt.set(fx.key, now); fx.flashAt = now;
  if (fx.flash) fx.flash.rotation.z = Math.random() * Math.PI;
}

// ───────────────────────────── 프레임 갱신 ─────────────────────────────
const FLASH_LIFE = 0.07;
/** 부착 파츠 애니메이션 — 파츠가 실제로 그려질 때만(onBeforeRender) 호출되므로 별도 수명 관리가 필요 없다 */
function animateFx(fx: WeaponFx): void {
  const timeSec = TIME.value; if (fx.lastT === timeSec) return; fx.lastT = timeSec;
  const t = timeSec + fx.seed;
  if (fx.kind === 'wings') {
    for (const pv of fx.parts) {
      const { side, i, y0 } = pv.userData as { side: number; i: number; y0: number }, flap = Math.sin(t * 2.2 + i * 0.9);
      pv.rotation.set(-(0.18 + i * 0.36) - flap * 0.07, side * (0.38 + i * 0.1 + flap * 0.08), side * 0.1 * flap);
      pv.position.y = y0 + Math.sin(t * 1.6 + i) * 0.004;
    }
  } else {
    fx.parts[0].rotation.z = t * 3.4;
    fx.parts[1].rotation.set(0.5 * Math.sin(t * 0.9), 0.5 * Math.cos(t * 0.9), -t * 2.1);
    fx.parts[2].rotation.z = -t * 5.2;
    const f = firedAt.get(fx.key), heat = f !== undefined ? Math.exp(-(timeSec - f) * 7) : 0;
    fx.parts[1].scale.setScalar(fx.parts[0].scale.x * (1.38 + heat * 0.5)); // 사격 순간 외곽 링이 부풀었다 가라앉는다
    if (fx.flash) {
      const age = timeSec - fx.flashAt, on = fx.flashAt >= 0 && age < FLASH_LIFE;
      fx.flash.visible = on; if (on) fx.flash.scale.setScalar(fx.flashScale * (0.7 + 0.6 * (age / FLASH_LIFE)));
    }
  }
}
/** 발광 재질 애니메이션 + 공용 시간 갱신 (프레임마다 1회, 절대 시각 기반이라 여러 루프에서 불러도 안전) */
export function tickSkinMaterials(timeSec: number): void {
  TIME.value = timeSec;
  for (const a of animated) {
    const f = firedAt.get(a.key), heat = a.boost && f !== undefined ? Math.exp(-(timeSec - f) * 7) * a.boost : 0;
    const wave = a.mode === 'pulse' ? 0.6 + 0.4 * Math.sin(timeSec * a.speed * Math.PI * 2) : a.mode === 'plasma' ? 0.88 + 0.12 * Math.sin(timeSec * 1.7) : 0.9 + 0.1 * Math.sin(timeSec * 3);
    a.mat.emissiveIntensity = a.base * (wave + heat);
  }
}
